import { describe, expect, it } from "vitest";
import { createSessionAcquisition } from "../../application/session-acquisition.js";
import type { SessionAcquisitionPorts, SessionAcquisitionRequest } from "../../ports/session-acquisition.js";

const own = "/claims/project--p--work--new.lock";
const predecessor = "/claims/project--p--work--old.lock";
const request: SessionAcquisitionRequest = {
    projectId: "project", projectPath: "/workspace/project", profile: "work", toolName: "claude",
};

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

function fixture() {
    const trace: string[] = [];
    const claims = new Set([predecessor]);
    let held = false;
    const inGuard = (event: string) => { expect(held).toBe(true); trace.push(event); };
    const ports: SessionAcquisitionPorts = {
        async withLifecycleLock(prefix, operation) {
            expect(held).toBe(false);
            trace.push(`lock:${prefix}`);
            held = true;
            try { return await operation(); }
            finally { held = false; trace.push(`unlock:${prefix}`); }
        },
        recoverPredecessors(prefix) {
            inGuard("recover");
            expect(prefix).toBe("project--p--work");
            expect(claims.has(own)).toBe(false);
        },
        reserve(projectId, profile) {
            inGuard("reserve");
            expect([projectId, profile]).toEqual([request.projectId, request.profile]);
            expect(claims.has(predecessor)).toBe(true);
            claims.add(own);
            return own;
        },
        initializeCapture(binding, path) {
            inGuard("capture");
            expect(binding).toBe(request);
            expect(path).toBe(own);
            expect(claims.has(predecessor)).toBe(true);
        },
        inspectExisting(binding) {
            inGuard("inspect");
            expect(binding).toBe(request);
            expect(claims.has(predecessor)).toBe(true);
            return { known: true, containerId: "captured-container-id", runtime: "podman" };
        },
        async arm() { inGuard("ready"); expect(claims.has(predecessor)).toBe(true); },
        async acknowledge(id, runtime) {
            inGuard("ack");
            expect([id, runtime]).toEqual(["captured-container-id", "podman"]);
            expect(claims.has(predecessor)).toBe(true);
        },
        reconcileForeign(prefix, path) {
            inGuard("reconcile");
            expect([prefix, path]).toEqual(["project--p--work", own]);
            claims.delete(predecessor);
            return false;
        },
        rollback(path) {
            inGuard("rollback");
            expect(path).toBe(own);
            expect(claims.has(predecessor)).toBe(true);
            claims.delete(path);
        },
    };
    return { ports, trace, claims, inGuard, isHeld: () => held };
}

const portNames = ["withLifecycleLock", "recoverPredecessors", "reserve", "initializeCapture", "inspectExisting", "arm",
    "acknowledge", "reconcileForeign", "rollback"] as const;

describe("explicit session acquisition construction", () => {
    it.each([null, undefined])("rejects absent ports %s", ports => {
        expect(() => createSessionAcquisition(ports as unknown as SessionAcquisitionPorts)).toThrow(TypeError);
    });
    for (const name of portNames) {
        it(`requires callable ${name} without any port effects`, () => {
            for (const invalid of [undefined, null, false, 0, "callback", {}]) {
                const f = fixture();
                expect(() => createSessionAcquisition({ ...f.ports, [name]: invalid } as unknown as SessionAcquisitionPorts)).toThrow(TypeError);
                expect(f.trace).toEqual([]);
                expect([...f.claims]).toEqual([predecessor]);
            }
        });
    }
    it("constructs using only supplied ports and observes callback replacement lazily", async () => {
        const f = fixture();
        const app = createSessionAcquisition(f.ports);
        expect(f.trace).toEqual([]);
        f.ports.inspectExisting = () => { f.inGuard("inspect-absent"); return { known: true, containerId: null, runtime: "docker" }; };
        await expect(app.run(request)).resolves.toEqual({ lockFile: own, existingId: null });
        expect(f.trace).toContain("inspect-absent");
        expect(f.trace).not.toContain("ack");
    });
});

describe("atomic session acquisition", () => {
    it("awaits predecessor recovery under the same guard before reserving a new monitored owner", async () => {
        const f = fixture();
        const entered = deferred();
        const recovered = deferred();
        f.ports.recoverPredecessors = async prefix => {
            f.inGuard("recovery-pending");
            expect(prefix).toBe("project--p--work");
            entered.resolve();
            await recovered.promise;
            f.inGuard("recovery-complete");
        };
        const acquisition = createSessionAcquisition(f.ports).run(request);
        await entered.promise;
        expect(f.trace).toEqual(["lock:project--p--work", "recovery-pending"]);
        expect([...f.claims]).toEqual([predecessor]);
        expect(f.isHeld()).toBe(true);
        recovered.resolve();
        await expect(acquisition).resolves.toEqual({ lockFile: own, existingId: "captured-container-id" });
        expect(f.trace).toEqual(["lock:project--p--work", "recovery-pending", "recovery-complete", "reserve", "capture", "inspect", "ready", "ack", "reconcile", "unlock:project--p--work"]);
    });

    it("a predecessor recovery failure neither reserves nor rolls back a successor claim", async () => {
        const f = fixture();
        const failure = new Error("predecessor cleanup remains incomplete");
        f.ports.recoverPredecessors = async () => {
            f.inGuard("recovery-failed");
            await Promise.resolve();
            throw failure;
        };
        await expect(createSessionAcquisition(f.ports).run(request)).rejects.toBe(failure);
        expect(f.trace).toEqual(["lock:project--p--work", "recovery-failed", "unlock:project--p--work"]);
        expect([...f.claims]).toEqual([predecessor]);
        expect(f.isHeld()).toBe(false);
    });

    it("holds one guard through pending READY and existing-ID ACK before pruning predecessors", async () => {
        const f = fixture();
        const readyEntered = deferred();
        const ready = deferred();
        const ackEntered = deferred();
        const ack = deferred();
        f.ports.arm = async () => { f.inGuard("ready-pending"); readyEntered.resolve(); await ready.promise; f.inGuard("ready-complete"); };
        f.ports.acknowledge = async (id, runtime) => {
            f.inGuard("ack-pending");
            expect([id, runtime]).toEqual(["captured-container-id", "podman"]);
            ackEntered.resolve();
            await ack.promise;
            f.inGuard("ack-complete");
        };
        const acquisition = createSessionAcquisition(f.ports).run(request);
        await readyEntered.promise;
        expect(f.isHeld()).toBe(true);
        expect([...f.claims]).toEqual([predecessor, own]);
        expect(f.trace).toEqual(["lock:project--p--work", "recover", "reserve", "capture", "inspect", "ready-pending"]);
        ready.resolve();
        await ackEntered.promise;
        expect(f.isHeld()).toBe(true);
        expect([...f.claims]).toEqual([predecessor, own]);
        expect(f.trace).toEqual(["lock:project--p--work", "recover", "reserve", "capture", "inspect", "ready-pending", "ready-complete", "ack-pending"]);
        ack.resolve();
        await expect(acquisition).resolves.toEqual({ lockFile: own, existingId: "captured-container-id" });
        expect(f.trace.slice(-3)).toEqual(["ack-complete", "reconcile", "unlock:project--p--work"]);
        expect([...f.claims]).toEqual([own]);
        expect(f.isHeld()).toBe(false);
    });

    it.each(["capture", "inspect", "launch", "ready", "ack"] as const)("a %s failure rolls back only its own reservation and preserves the original error", async stage => {
        const f = fixture();
        const failure = { stage };
        const fail = () => { f.inGuard(`fail:${stage}`); throw failure; };
        if (stage === "capture") f.ports.initializeCapture = fail;
        if (stage === "inspect") f.ports.inspectExisting = fail;
        if (stage === "launch") f.ports.arm = fail;
        if (stage === "ready") f.ports.arm = async () => { f.inGuard("ready-pending"); await Promise.resolve(); fail(); };
        if (stage === "ack") f.ports.acknowledge = async () => { fail(); };
        await expect(createSessionAcquisition(f.ports).run(request)).rejects.toBe(failure);
        expect([...f.claims]).toEqual([predecessor]);
        expect(f.trace).not.toContain("reconcile");
        expect(f.trace.slice(-2)).toEqual(["rollback", "unlock:project--p--work"]);
        expect(f.isHeld()).toBe(false);
        if (["capture", "inspect"].includes(stage)) expect(f.trace).not.toContain("ready");
        if (stage !== "ack") expect(f.trace).not.toContain("ack");
    });

    it("retains static legacy admission while ACK remains before predecessor reconciliation", async () => {
        const f = fixture();
        f.ports.inspectExisting = () => {
            f.inGuard("inspect-stopped-legacy");
            return {known: true, containerId: "captured-container-id", runtime: "podman", requiresLiveVerification: true};
        };
        await expect(createSessionAcquisition(f.ports).run(request)).resolves.toEqual({
            lockFile: own, existingId: "captured-container-id", requiresLiveVerification: true,
        });
        expect(f.trace).toEqual(["lock:project--p--work", "recover", "reserve", "capture", "inspect-stopped-legacy", "ready", "ack", "reconcile", "unlock:project--p--work"]);
        expect([...f.claims]).toEqual([own]);
    });

    it("reports the selected runtime and bounded inspection cause without pruning a predecessor", async () => {
        const f = fixture();
        f.ports.inspectExisting = () => {
            f.inGuard("inspect-unknown");
            return {known: false, containerId: null, runtime: "podman", reason: "container-list-timeout"};
        };
        await expect(createSessionAcquisition(f.ports).run(request)).rejects.toThrow(
            "Existing session container ownership could not be inspected (container-list-timeout; runtime: podman). The existing container was preserved.",
        );
        expect([...f.claims]).toEqual([predecessor]);
        expect(f.trace).toEqual(["lock:project--p--work", "recover", "reserve", "capture", "inspect-unknown", "rollback", "unlock:project--p--work"]);
    });

    it("unknown inspection cannot stand for proven absence or prune the predecessor", async () => {
        const f = fixture();
        f.ports.inspectExisting = () => { f.inGuard("inspect-unknown"); return { known: false, containerId: null, runtime: "docker" }; };
        await expect(createSessionAcquisition(f.ports).run(request)).rejects.toThrow();
        expect([...f.claims]).toEqual([predecessor]);
        expect(f.trace).toEqual(["lock:project--p--work", "recover", "reserve", "capture", "inspect-unknown", "rollback", "unlock:project--p--work"]);
    });

    it("proven absence commits after READY without sending a fabricated existing-ID acknowledgement", async () => {
        const f = fixture();
        f.ports.inspectExisting = () => { f.inGuard("inspect-absent"); return { known: true, containerId: null, runtime: "docker" }; };
        await expect(createSessionAcquisition(f.ports).run(request)).resolves.toEqual({ lockFile: own, existingId: null });
        expect(f.trace).toEqual(["lock:project--p--work", "recover", "reserve", "capture", "inspect-absent", "ready", "reconcile", "unlock:project--p--work"]);
        expect([...f.claims]).toEqual([own]);
    });

    it("retained live foreign claims do not reject a successfully protected reservation", async () => {
        const f = fixture();
        f.ports.reconcileForeign = (prefix, path) => {
            f.inGuard("reconcile-live");
            expect([prefix, path]).toEqual(["project--p--work", own]);
            return true;
        };
        await expect(createSessionAcquisition(f.ports).run(request)).resolves.toEqual({ lockFile: own, existingId: "captured-container-id" });
        expect([...f.claims]).toEqual([predecessor, own]);
        expect(f.trace).not.toContain("rollback");
    });

    it("keeps the acknowledged owner when reconciliation prunes a predecessor and then fails", async () => {
        const f = fixture();
        const failure = new Error("fresh enumeration failed after stale unlink");
        let acknowledged: { id: string; runtime: string } | undefined;
        f.ports.acknowledge = async (id, runtime) => {
            f.inGuard("ack-complete");
            acknowledged = { id, runtime };
        };
        f.ports.reconcileForeign = (prefix, path) => {
            f.inGuard("reconcile-partial");
            expect([prefix, path]).toEqual(["project--p--work", own]);
            expect(acknowledged).toEqual({ id: "captured-container-id", runtime: "podman" });
            f.claims.delete(predecessor);
            throw failure;
        };
        f.ports.rollback = path => { f.inGuard("rollback"); f.claims.delete(path); };
        await expect(createSessionAcquisition(f.ports).run(request)).rejects.toBe(failure);
        expect([...f.claims]).toEqual([own]);
        expect(f.trace).toEqual(["lock:project--p--work", "recover", "reserve", "capture", "inspect", "ready", "ack-complete", "reconcile-partial", "unlock:project--p--work"]);
        expect(f.isHeld()).toBe(false);
    });

    it("rolls back a reservation after reconciliation failure when inspection proved no existing container", async () => {
        const f = fixture();
        const failure = new Error("reconciliation failed without an existing obligation");
        f.ports.inspectExisting = () => { f.inGuard("inspect-absent"); return { known: true, containerId: null, runtime: "docker" }; };
        f.ports.reconcileForeign = () => { f.inGuard("reconcile-failed"); throw failure; };
        await expect(createSessionAcquisition(f.ports).run(request)).rejects.toBe(failure);
        expect([...f.claims]).toEqual([predecessor]);
        expect(f.trace).toEqual(["lock:project--p--work", "recover", "reserve", "capture", "inspect-absent", "ready", "reconcile-failed", "rollback", "unlock:project--p--work"]);
        expect(f.isHeld()).toBe(false);
    });

    it("a failed owned rollback preserves both files, exposes its error and performs no foreign effects", async () => {
        const f = fixture();
        const readyFailure = new Error("ready failed");
        const rollbackFailure = new Error("owned unlink failed");
        f.ports.arm = async () => { f.inGuard("ready-failed"); throw readyFailure; };
        f.ports.rollback = path => { f.inGuard("rollback-failed"); expect(path).toBe(own); throw rollbackFailure; };
        const rejected = await createSessionAcquisition(f.ports).run(request).catch(error => error);
        expect(rejected).toBeInstanceOf(AggregateError);
        expect(rejected.errors).toEqual([readyFailure, rollbackFailure]);
        expect(rejected.cause).toBe(readyFailure);
        expect([...f.claims]).toEqual([predecessor, own]);
        expect(f.trace).toEqual(["lock:project--p--work", "recover", "reserve", "capture", "inspect", "ready-failed", "rollback-failed", "unlock:project--p--work"]);
        expect(f.isHeld()).toBe(false);
    });

    it.each(["guard", "reserve"] as const)("a %s failure cannot roll back an uncreated reservation", async stage => {
        const f = fixture();
        const failure = { stage };
        if (stage === "guard") f.ports.withLifecycleLock = async () => { throw failure; };
        else f.ports.reserve = () => { f.inGuard("reserve-failed"); throw failure; };
        await expect(createSessionAcquisition(f.ports).run(request)).rejects.toBe(failure);
        expect([...f.claims]).toEqual([predecessor]);
        expect(f.trace).not.toContain("rollback");
        expect(f.trace).not.toContain("capture");
        expect(f.trace).not.toContain("reconcile");
        expect(f.isHeld()).toBe(false);
    });
});

describe("acquisition cancellation checkpoints", () => {
    it("cancellation before reservation has no claim effects", async () => {
        const f = fixture();
        const cancelled = new Error("cancelled before reserve");
        await expect(createSessionAcquisition(f.ports).run(request, () => { throw cancelled; })).rejects.toBe(cancelled);
        expect([...f.claims]).toEqual([predecessor]);
        expect(f.trace).not.toContain("reserve");
        expect(f.trace).not.toContain("recover");
        expect(f.trace).not.toContain("rollback");
        expect(f.isHeld()).toBe(false);
    });

    it("cancellation while recovery is pending waits for settlement, then creates no new reservation", async () => {
        const f = fixture();
        const entered = deferred();
        const recovered = deferred();
        const cancellation = new Error("cancelled during predecessor recovery");
        let cancelled = false;
        f.ports.recoverPredecessors = async () => {
            f.inGuard("recovery-pending");
            entered.resolve();
            await recovered.promise;
            f.inGuard("recovery-complete");
        };
        const acquisition = createSessionAcquisition(f.ports).run(request, () => { if (cancelled) throw cancellation; });
        const rejected = expect(acquisition).rejects.toBe(cancellation);
        await entered.promise;
        cancelled = true;
        expect(f.isHeld()).toBe(true);
        expect([...f.claims]).toEqual([predecessor]);
        recovered.resolve();
        await rejected;
        expect(f.trace).toEqual(["lock:project--p--work", "recovery-pending", "recovery-complete", "unlock:project--p--work"]);
        expect([...f.claims]).toEqual([predecessor]);
        expect(f.isHeld()).toBe(false);
    });

    it.each(["inspection", "READY", "ACK-rejection", "ACK-success"] as const)("settles pending %s before receipt-qualified cancellation", async stage => {
        const f = fixture();
        const entered = deferred();
        const pending = deferred();
        const cancelled = new Error("signal cancellation");
        const ackFailure = new Error("ACK rejected");
        let cancellation = false;
        const wait = async (event: string) => { f.inGuard(event); entered.resolve(); await pending.promise; f.inGuard(`${event}-settled`); };
        if (stage === "inspection") f.ports.inspectExisting = async () => { await wait("inspection-pending"); return { known: true, containerId: "captured-container-id", runtime: "podman" }; };
        if (stage === "READY") f.ports.arm = () => wait("ready-pending");
        if (stage.startsWith("ACK")) f.ports.acknowledge = async () => { await wait("ack-pending"); if (stage === "ACK-rejection") throw ackFailure; };
        const acquisition = createSessionAcquisition(f.ports).run(request, () => { if (cancellation) throw cancelled; });
        const rejected = expect(acquisition).rejects.toBe(stage === "ACK-rejection" ? ackFailure : cancelled);
        await entered.promise;
        cancellation = true;
        await Promise.resolve();
        expect(f.isHeld()).toBe(true);
        expect(f.trace).not.toContain("rollback");
        pending.resolve();
        await rejected;
        expect(f.isHeld()).toBe(false);
        expect(f.trace).not.toContain("reconcile");
        expect([...f.claims]).toEqual(stage === "ACK-success" ? [predecessor, own] : [predecessor]);
        expect(f.trace.includes("rollback")).toBe(stage !== "ACK-success");
        if (["inspection", "READY"].includes(stage)) expect(f.trace).not.toContain("ack");
    });

    it("proven absence cancelled during READY rolls back without acknowledging a fabricated ID", async () => {
        const f = fixture();
        let cancelled = false;
        f.ports.inspectExisting = () => ({ known: true, containerId: null, runtime: "docker" });
        f.ports.arm = async () => { f.inGuard("ready"); cancelled = true; };
        await expect(createSessionAcquisition(f.ports).run(request, () => { if (cancelled) throw new Error("cancelled"); })).rejects.toThrow("cancelled");
        expect([...f.claims]).toEqual([predecessor]);
        expect(f.trace).not.toContain("ack");
        expect(f.trace).not.toContain("reconcile");
    });
});

describe("existing-target acquisition with retained predecessors", () => {
    const id = "a".repeat(64), warning = "Predecessor startup requests remain pending.";
    function restricted() {
        const f = fixture();
        f.ports.recoverPredecessors = () => { f.inGuard("recover-pending-only"); return {containerId: id, runtime: "podman", diagnostic: warning}; };
        f.ports.inspectExisting = () => { f.inGuard("inspect-running"); return {known: true, containerId: id, runtime: "podman", running: true}; };
        f.ports.acknowledge = async (containerId, runtime) => { f.inGuard("ack"); expect([containerId, runtime]).toEqual([id, "podman"]); };
        f.ports.reconcileForeign = () => { f.inGuard("reconcile-retained"); return true; };
        return f;
    }
    it.each([false, true])("keeps the restriction after second reconciliation (later recovery succeeds=%s)", recovered => {
        const f = restricted();
        f.ports.reconcileForeign = () => { f.inGuard("reconcile-retained"); return !recovered; };
        return expect(createSessionAcquisition(f.ports).run(request)).resolves.toEqual({
            lockFile: own, existingId: id, existingOnly: true, recoveryWarning: warning,
        }).then(() => {
            expect(f.trace.filter(event => event === "inspect-running")).toHaveLength(3);
            expect(f.trace.indexOf("inspect-running")).toBeLessThan(f.trace.indexOf("ready"));
            expect(f.trace.lastIndexOf("inspect-running")).toBeGreaterThan(f.trace.indexOf("reconcile-retained"));
            expect([...f.claims]).toEqual([predecessor, own]); expect(f.trace).not.toContain("rollback");
        });
    });
    it.each([false, true])("admits the same stopped target without losing its live-verification requirement (provisional=%s)", async provisional => {
        const f = restricted();
        f.ports.inspectExisting = () => {
            f.inGuard("inspect-stopped");
            return {known: true, containerId: id, runtime: "podman", running: false,
                ...(provisional ? {requiresLiveVerification: true as const} : {})};
        };
        await expect(createSessionAcquisition(f.ports).run(request)).resolves.toEqual({
            lockFile: own, existingId: id, existingOnly: true, recoveryWarning: warning,
            ...(provisional ? {requiresLiveVerification: true} : {}),
        });
        expect(f.trace.filter(event => event === "inspect-stopped")).toHaveLength(3);
        expect(f.trace.indexOf("ack")).toBeLessThan(f.trace.indexOf("reconcile-retained"));
        expect([...f.claims]).toEqual([predecessor, own]); expect(f.trace).not.toContain("rollback");
    });
    it("keeps provisional stopped proof latched when a later static inspection omits that requirement", async () => {
        const f = restricted(); let reads = 0;
        f.ports.inspectExisting = () => ({known: true, containerId: id, runtime: "podman", running: false,
            ...(++reads === 1 ? {requiresLiveVerification: true as const} : {})});
        await expect(createSessionAcquisition(f.ports).run(request)).resolves.toMatchObject({existingOnly: true, existingId: id, requiresLiveVerification: true});
        expect(reads).toBe(3); expect([...f.claims]).toEqual([predecessor, own]);
    });
    it.each(["unknown", "absent", "state-unknown", "changed", "runtime", "provisional-running", "short-id"] as const)("refuses %s proof before guardian arm and acknowledgement", fault => {
        const f = restricted();
        f.ports.inspectExisting = () => ({known: fault !== "unknown", containerId: fault === "absent" ? null : fault === "changed" ? "b".repeat(64) : fault === "short-id" ? "short" : id,
            runtime: fault === "runtime" ? "docker" : "podman", ...(fault === "state-unknown" ? {} : {running: true}),
            ...(fault === "provisional-running" ? {requiresLiveVerification: true as const} : {})});
        return expect(createSessionAcquisition(f.ports).run(request)).rejects.toBeInstanceOf(Error).then(() => {
            expect(f.trace).not.toContain("ready"); expect(f.trace).not.toContain("ack");
            expect(f.trace).toContain("rollback"); expect([...f.claims]).toEqual([predecessor]);
        });
    });
    it.each(["state-unknown", "changed", "runtime", "unknown"] as const)("retires only its cleanup-disabled claim when %s target changes after reconciliation", fault => {
        const f = restricted(); let reads = 0;
        f.ports.inspectExisting = () => ({known: ++reads < 3 || fault !== "unknown", containerId: reads === 3 && fault === "changed" ? "b".repeat(64) : id,
            runtime: reads === 3 && fault === "runtime" ? "docker" : "podman", ...(reads === 3 && fault === "state-unknown" ? {} : {running: true})});
        return expect(createSessionAcquisition(f.ports).run(request)).rejects.toBeInstanceOf(Error).then(() => {
            expect(reads).toBe(3); expect(f.trace).toContain("ack"); expect(f.trace).toContain("rollback");
            expect([...f.claims]).toEqual([predecessor]);
        });
    });
    it("rechecks the running target after guardian arm before acknowledging an ID that changed during READY", async () => {
        const f = restricted(); let armed = false;
        f.ports.arm = async () => { f.inGuard("ready"); armed = true; };
        f.ports.inspectExisting = () => ({known: true, containerId: armed ? "b".repeat(64) : id, runtime: "podman", running: true});
        await expect(createSessionAcquisition(f.ports).run(request)).rejects.toBeInstanceOf(Error);
        expect(f.trace).toContain("ready"); expect(f.trace).not.toContain("ack");
        expect(f.trace).toContain("rollback"); expect([...f.claims]).toEqual([predecessor]);
    });
    it("a new unrelated second-reconciliation failure retires only its cleanup-disabled reservation", async () => {
        const f = restricted(), failure = new Error("new unreadable predecessor");
        f.ports.reconcileForeign = () => { f.inGuard("reconcile-failed"); throw failure; };
        await expect(createSessionAcquisition(f.ports).run(request)).rejects.toBe(failure);
        expect([...f.claims]).toEqual([predecessor]); expect(f.trace).toContain("rollback");
    });
    it("retires only its stopped-target reservation when the cleanup-disabled acknowledgement fails", async () => {
        const f = restricted(), failure = new Error("disabled acknowledgement failed");
        f.ports.inspectExisting = () => ({known: true, containerId: id, runtime: "podman", running: false, requiresLiveVerification: true});
        f.ports.acknowledge = async () => { f.inGuard("ack-failed"); throw failure; };
        await expect(createSessionAcquisition(f.ports).run(request)).rejects.toBe(failure);
        expect(f.trace).not.toContain("reconcile-retained"); expect(f.trace).toContain("rollback");
        expect([...f.claims]).toEqual([predecessor]);
    });
});
