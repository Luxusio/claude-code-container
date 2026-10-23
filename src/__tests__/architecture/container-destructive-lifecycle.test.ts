import { describe, expect, it } from "vitest";
import { createContainerDestructiveLifecycle } from "../../application/container-destructive-lifecycle.js";
import type {
    ContainerDestructiveLifecycleOptions,
    ContainerDestructiveLifecyclePorts,
    ContainerDeviceCleanupObservation,
    ContainerDestructiveCommandObservation,
    DestructiveContainerIdentity,
} from "../../ports/container-destructive-lifecycle.js";

const clean = { kind: "observed", stopped: 0, skipped: 0, failed: 0 } as const;
const acknowledged = { kind: "completed" } as const;

function fixture() {
    const trace: string[] = [];
    const state = {
        claims: [] as string[],
        identity: { containerId: "pinned-id", running: true } as DestructiveContainerIdentity | null,
        cleanup: clean as ContainerDeviceCleanupObservation,
        cleanupError: undefined as unknown,
        stop: acknowledged as ContainerDestructiveCommandObservation,
        removal: acknowledged as ContainerDestructiveCommandObservation,
    };
    let resolutions = 0;
    const effect = (event: string): undefined => { trace.push(event); return undefined; };
    const ports: ContainerDestructiveLifecyclePorts = {
        resolvePath: path => { trace.push(`resolve:${path}`); return `/full/${++resolutions}`; },
        projectId: path => { trace.push(`project:${path}`); return "project-id"; },
        containerName: (path, profile) => { trace.push(`name:${path}:${String(profile)}`); return "container-name"; },
        withLifecycleLock: (prefix, operation) => {
            effect(`lock:${prefix}`);
            try { return operation(); } finally { effect("unlock"); }
        },
        sessionClaims: prefix => { trace.push(`claims:${prefix}`); return state.claims; },
        ensureRuntime: () => effect("runtime"),
        managedIdentity: (name, path) => { trace.push(`identity:${name}:${path}`); return state.identity; },
        cleanupDevices: (path, timeout, profile) => {
            effect(`cleanup:${path}:${timeout}:${String(profile)}`);
            if (state.cleanupError !== undefined) throw state.cleanupError;
            return state.cleanup;
        },
        stop: id => { effect(`stop:${id}`); return state.stop; },
        remove: id => { effect(`remove:${id}`); return state.removal; },
        reportNotFound: () => effect("not-found"),
        reportStopping: (name, path) => effect(`stopping:${name}:${path}`),
        reportStopped: () => effect("stopped"),
        reportRemoving: (name, path) => effect(`removing:${name}:${path}`),
        reportRemoved: () => effect("removed"),
        reportDeviceCleanupFailure: observation => effect(`cleanup-warning:${JSON.stringify(observation)}`),
        throwSessionClaims: (count, path) => { effect(`refuse:${count}:${path}`); throw new Error(`claimed:${count}`); },
    };
    return { trace, state, ports, app: createContainerDestructiveLifecycle(ports) };
}

const proof = ["resolve:input", "project:/full/1", "lock:project-id", "claims:project-id", "runtime",
    "name:/full/1:undefined", "identity:container-name:/full/1"];
const stopRunning = [...proof, "cleanup:/full/1:5000:undefined", "stopping:container-name:/full/1", "stop:pinned-id", "stopped", "unlock"];
const removeRunning = [...stopRunning.slice(0, -1), "removing:container-name:/full/1", "remove:pinned-id", "removed", "unlock"];
const target = { containerId: "pinned-id", running: true };

describe("required destructive lifecycle capabilities", () => {
    it("constructs without effects and rejects missing or noncallable capabilities", () => {
        const f = fixture();
        for (const name of Object.keys(f.ports)) {
            const absent: Record<string, unknown> = { ...f.ports };
            delete absent[name];
            expect(() => createContainerDestructiveLifecycle(absent as unknown as ContainerDestructiveLifecyclePorts)).toThrow(`callable ${name}`);
            expect(() => createContainerDestructiveLifecycle({ ...f.ports, [name]: false } as unknown as ContainerDestructiveLifecyclePorts)).toThrow(`callable ${name}`);
        }
        expect(f.trace).toEqual([]);
    });
});

describe("destructive claim authorization", () => {
    it.each(["stop", "remove"] as const)("%s reads force only after nonempty raw claims", operation => {
        const f = fixture();
        const options = { get force(): boolean { throw new Error("force-read"); } };
        expect(f.app[operation]("input", undefined, options).kind).toBe("completed");
        f.trace.length = 0; f.state.claims = ["raw-stale-claim", "raw-live-claim"];
        expect(() => f.app[operation]("input", undefined, options)).toThrow("force-read");
        expect(f.trace).toEqual(["resolve:input", "project:/full/2", "lock:project-id", "claims:project-id", "unlock"]);
    });

    it.each(["stop", "remove"] as const)("%s accepts only exact force true and refuses before cleanup", operation => {
        for (const force of [undefined, false, 0, 1, "true", {}, true]) {
            const f = fixture(); f.state.claims = ["claim", "claim-2"];
            const run = () => f.app[operation]("input", undefined, { force } as ContainerDestructiveLifecycleOptions);
            if (force === true) {
                expect(run().kind).toBe("completed");
                expect(f.trace).toEqual(operation === "stop" ? stopRunning : removeRunning);
            } else {
                expect(run).toThrow("claimed:2");
                expect(f.trace).toEqual(["resolve:input", "project:/full/1", "lock:project-id", "claims:project-id", "refuse:2:/full/1", "unlock"]);
            }
        }
    });

    it.each(["stop", "remove"] as const)("%s reconciles under the profile guard and counts the returned fresh remainder", operation => {
        const f = fixture(); f.state.claims = ["dead-legacy", "failed-cleanup"];
        f.ports.sessionClaims = (prefix, path, profile) => {
            expect(prefix).toBe("project-id--p--work"); expect(path).toBe("/full/1"); expect(profile).toBe("work");
            expect(f.trace.at(-1)).toBe("lock:project-id--p--work");
            f.trace.push("recover:dead-legacy");
            f.state.claims = ["replacement-still-present"];
            return [...f.state.claims];
        };
        expect(() => f.app[operation]("input", "work")).toThrow("claimed:1");
        expect(f.trace).toContain("refuse:1:/full/1");
        expect(f.trace).not.toContain("runtime");
        expect(f.trace.some(event => /^(cleanup:|stop:|remove:)/.test(event))).toBe(false);
    });

    it.each(["stop", "remove"] as const)("%s proceeds without force when automatic recovery leaves no claims", operation => {
        const f = fixture(); f.state.claims = ["dead-legacy"];
        f.ports.sessionClaims = () => { f.trace.push("recover-and-recount"); f.state.claims = []; return [...f.state.claims]; };
        expect(f.app[operation]("input").kind).toBe("completed");
        expect(f.trace.indexOf("recover-and-recount")).toBeLessThan(f.trace.indexOf("runtime"));
        expect(f.trace).toContain("stop:pinned-id");
    });

    it("explicit force still attempts reconciliation before bypassing its remaining-file veto", () => {
        const f = fixture();
        f.ports.sessionClaims = () => { f.trace.push("recovery-incomplete-fresh-remainder"); return ["uncertain-record"]; };
        expect(f.app.remove("input", undefined, { force: true }).kind).toBe("completed");
        expect(f.trace.indexOf("recovery-incomplete-fresh-remainder")).toBeLessThan(f.trace.indexOf("runtime"));
        expect(f.trace).toContain("remove:pinned-id");
    });

    it.each(["stop", "remove"] as const)("%s keeps one captured path for profile, proof, cleanup and presentation", operation => {
        for (const profile of [undefined, "", "dev"]) {
            const f = fixture(); f.app[operation]("input", profile);
            const prefix = profile ? "project-id--p--dev" : "project-id";
            expect(f.trace.filter(event => event.startsWith("resolve:"))).toEqual(["resolve:input"]);
            expect(f.trace.slice(0, 5)).toEqual(["resolve:input", "project:/full/1", `lock:${prefix}`, `claims:${prefix}`, "runtime"]);
            expect(f.trace).toContain(`name:/full/1:${String(profile)}`);
            expect(f.trace).toContain("identity:container-name:/full/1");
            expect(f.trace).toContain(`cleanup:/full/1:5000:${String(profile)}`);
            expect(f.trace).toContain("stopping:container-name:/full/1");
        }
    });
});

describe("captured destructive target and finite results", () => {
    it.each(["stop", "remove"] as const)("%s returns the synchronous lock callback's closed outcome", operation => {
        const f = fixture();
        let callbackResult: unknown;
        f.ports.withLifecycleLock = (_prefix, callback) => { const result = callback(); callbackResult = result; return result; };
        const result = f.app[operation]("input");
        expect(result).toBe(callbackResult);
        expect(result).toEqual({ kind: "completed", value: { target, cleanup: clean, stop: "completed", removal: operation === "remove" ? "completed" : "not-run" } });
    });

    it.each(["stop", "remove"] as const)("%s represents confirmed absence without cleanup or command acknowledgements", operation => {
        const f = fixture(); f.state.identity = null;
        expect(f.app[operation]("input")).toEqual({ kind: "completed", value: { target: null, cleanup: { kind: "not-run" }, stop: "not-run", removal: "not-run" } });
        expect(f.trace).toEqual([...proof, "not-found", "unlock"]);
    });

    it.each(["stop", "remove"] as const)("%s preserves foreign/unknown identity refusal even with force", operation => {
        const f = fixture(); const refusal = new Error("ownership could not be verified"); f.state.claims = ["claim"];
        f.ports.managedIdentity = () => { throw refusal; };
        expect(() => f.app[operation]("input", undefined, { force: true })).toThrow(refusal);
        expect(f.trace.some(event => /^(cleanup:|stop:|remove:|not-found)/.test(event))).toBe(false);
        expect(f.trace.at(-1)).toBe("unlock");
    });

    it.each(["stop", "remove"] as const)("%s distinguishes an initially stopped target from a stop command acknowledgement", operation => {
        const f = fixture(); f.state.identity!.running = false;
        expect(f.app[operation]("input")).toEqual({ kind: "completed", value: {
            target: { containerId: "pinned-id", running: false }, cleanup: clean, stop: "not-run", removal: operation === "remove" ? "completed" : "not-run",
        } });
        expect(f.trace).not.toContain("stop:pinned-id");
        expect(f.trace.includes("stopped")).toBe(operation === "stop");
    });

    // These existing constructor/callback inputs expose redirected effects before
    // any assertion depends on the new semantic outcome shape.
    it.each(["stop", "remove"] as const)("regression: %s cannot redirect the proven ID through a cleanup mutation", operation => {
        const f = fixture(); const mutableIdentity = f.state.identity!;
        f.ports.cleanupDevices = () => { mutableIdentity.containerId = "foreign-id"; return clean; };
        f.app[operation]("input");
        expect(f.trace.filter(event => event.startsWith("stop:") || event.startsWith("remove:")))
            .toEqual(operation === "stop" ? ["stop:pinned-id"] : ["stop:pinned-id", "remove:pinned-id"]);
    });

    it.each(["stop", "remove"] as const)("regression: %s cannot skip a required stop through a cleanup mutation", operation => {
        const f = fixture(); const mutableIdentity = f.state.identity!;
        f.ports.cleanupDevices = () => { mutableIdentity.running = false; return clean; };
        f.app[operation]("input");
        expect(f.trace.filter(event => event.startsWith("stop:") || event.startsWith("remove:")))
            .toEqual(operation === "stop" ? ["stop:pinned-id"] : ["stop:pinned-id", "remove:pinned-id"]);
    });

    it("captures initial identity scalars before cleanup and reporting callbacks", () => {
        const f = fixture(); const mutableIdentity = f.state.identity!;
        f.ports.cleanupDevices = () => { mutableIdentity.containerId = "cleanup-id"; mutableIdentity.running = false; return clean; };
        f.ports.reportStopping = () => { mutableIdentity.containerId = "report-id"; return undefined; };
        const result = f.app.remove("input");
        expect(result).toEqual({ kind: "completed", value: { target, cleanup: clean, stop: "completed", removal: "completed" } });
        if (result.kind === "completed") expect(result.value.target).not.toBe(mutableIdentity);
        expect(f.trace.filter(event => event.startsWith("stop:") || event.startsWith("remove:"))).toEqual(["stop:pinned-id", "remove:pinned-id"]);
    });
});

describe("best effort cleanup and native uncertainty", () => {
    it.each(["stop", "remove"] as const)("%s retains mixed cleanup counts, warns before dispatch and completes the authorized action", operation => {
        const f = fixture(); f.state.cleanup = { kind: "observed", stopped: 2, skipped: 1, failed: 1 };
        expect(f.app[operation]("input")).toEqual({ kind: "failed", reason: "device-cleanup-incomplete", evidence: {
            target, cleanup: f.state.cleanup, stop: "completed", removal: operation === "remove" ? "completed" : "not-run",
        } });
        expect(f.trace.indexOf(`cleanup-warning:${JSON.stringify(f.state.cleanup)}`)).toBeLessThan(f.trace.indexOf("stop:pinned-id"));
        expect(f.trace).toContain(operation === "stop" ? "stopped" : "removed");
    });

    it.each(["stop", "remove"] as const)("%s treats a thrown cleanup as unavailable and keeps best effort dispatch", operation => {
        const f = fixture(); const failure = { privateCommand: "secret", toString: () => { throw new Error("must not stringify"); } };
        f.state.cleanupError = failure;
        expect(f.app[operation]("input")).toEqual({ kind: "failed", reason: "device-cleanup-incomplete", evidence: {
            target, cleanup: { kind: "unavailable" }, stop: "completed", removal: operation === "remove" ? "completed" : "not-run",
        } });
        expect(f.trace).toContain('cleanup-warning:{"kind":"unavailable"}');
        expect(f.trace).toContain(operation === "stop" ? "stop:pinned-id" : "remove:pinned-id");
    });

    it("unconfirmed stop prevents removal and success messages while retaining incomplete cleanup", () => {
        const f = fixture(); f.state.cleanup = { kind: "observed", stopped: 1, skipped: 0, failed: 2 }; f.state.stop = { kind: "unconfirmed" };
        expect(f.app.remove("input")).toEqual({ kind: "indeterminate", reason: "container-stop-unconfirmed", evidence: {
            target, cleanup: f.state.cleanup, stop: "unconfirmed", removal: "not-run",
        } });
        expect(f.trace.filter(event => event.startsWith("stop:") || event.startsWith("remove:"))).toEqual(["stop:pinned-id"]);
        expect(f.trace).not.toContain("stopped"); expect(f.trace).not.toContain("removed");
    });

    it("unconfirmed removal retains acknowledged stop and cleanup without automatic replay", () => {
        const f = fixture(); f.state.removal = { kind: "unconfirmed" }; f.state.cleanup = { kind: "unavailable" };
        expect(f.app.remove("input")).toEqual({ kind: "indeterminate", reason: "container-remove-unconfirmed", evidence: {
            target, cleanup: { kind: "unavailable" }, stop: "completed", removal: "unconfirmed",
        } });
        expect(f.trace).toContain("stopped"); expect(f.trace).not.toContain("removed");
        expect(f.trace.filter(event => event.startsWith("stop:") || event.startsWith("remove:"))).toEqual(["stop:pinned-id", "remove:pinned-id"]);
        f.trace.length = 0; f.state.removal = acknowledged; f.state.cleanup = clean; f.state.identity = { containerId: "retry-id", running: false };
        expect(f.app.remove("input")).toEqual({ kind: "completed", value: {
            target: { containerId: "retry-id", running: false }, cleanup: clean, stop: "not-run", removal: "completed",
        } });
        expect(f.trace.filter(event => event.startsWith("stop:") || event.startsWith("remove:"))).toEqual(["remove:retry-id"]);
        expect(f.trace).toContain("project:/full/2");
    });

    it.each(["stop", "remove"] as const)("%s emits no warning for a clean returned summary", operation => {
        const f = fixture(); f.state.cleanup = { kind: "observed", stopped: 1, skipped: 2, failed: 0 };
        expect(f.app[operation]("input").kind).toBe("completed");
        expect(f.trace.some(event => event.startsWith("cleanup-warning:"))).toBe(false);
    });
});

describe("unexpected exception propagation", () => {
    it.each(["managedIdentity", "stop", "remove", "reportStopping", "reportStopped", "reportRemoving", "reportRemoved"] as const)("propagates %s exceptions unchanged and stops later effects", capability => {
        const f = fixture(); const failure = { capability };
        Object.assign(f.ports, { [capability]: () => { throw failure; } });
        let caught: unknown; try { f.app.remove("input"); } catch (error) { caught = error; }
        expect(caught).toBe(failure); expect(f.trace.at(-1)).toBe("unlock");
        if (capability !== "reportRemoved") expect(f.trace).not.toContain("removed");
        if (["managedIdentity", "reportStopping", "stop", "reportStopped"].includes(capability)) expect(f.trace).not.toContain("remove:pinned-id");
    });

    it("propagates a warning exception before native dispatch", () => {
        const f = fixture(); const failure = new Error("reporter-failed"); f.state.cleanup = { kind: "unavailable" };
        f.ports.reportDeviceCleanupFailure = observation => { expect(observation).toEqual({ kind: "unavailable" }); throw failure; };
        expect(() => f.app.remove("input")).toThrow(failure);
        expect(f.trace).not.toContain("stop:pinned-id"); expect(f.trace).not.toContain("remove:pinned-id");
    });

    it("propagates a lock release exception after an accepted effect", () => {
        const f = fixture(); const failure = new Error("unlock-failed");
        f.ports.withLifecycleLock = (_prefix, callback) => { callback(); throw failure; };
        expect(() => f.app.stop("input")).toThrow(failure);
        expect(f.trace).toContain("stop:pinned-id"); expect(f.trace).toContain("stopped");
    });
});
