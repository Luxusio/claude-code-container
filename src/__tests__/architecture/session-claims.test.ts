import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSessionClaims } from "../../application/session-claims.js";
import {
    encodeSessionClaim, sessionClaimName, sessionClaimPrefix,
    sessionLockClaimsForContainer, sessionLockClaimsForProjectFamily,
} from "../../domain/session-claims.js";
import type { SessionClaimObservation } from "../../domain/session-claim-observation.js";
import type { ProcessStartObservation, SessionLockLiveness } from "../../domain/session-lock.js";
import { sessionLockOwner } from "../../domain/session-lock.js";
import { NATIVE_RUNTIME_SELECTOR_KEYS, type NativeRuntimeInvocation, type NativeRuntimeSelectors } from "../../ports/container-runtime-invocation.js";
import type { SessionClaimObservationSnapshot } from "../../ports/session-claim-observation.js";
import type { SessionClaimRecoveryScope, SessionClaimsPorts } from "../../ports/session-claims.js";
import type { SessionOwnershipReceipt } from "../../ports/session-ownership.js";

const current = "project--current.lock";
const old = "project--old.lock";
const other = "project--other.lock";
const fullId = "a".repeat(64);
const differentId = "b".repeat(64);
const generation = "generation-1";
const versioned = (pid = 42, token = "opaque") => JSON.stringify({ version: 2, pid, startToken: token });
const direct = (pid = 42) => encodeSessionClaim(pid, "owner-start", "direct");
const monitored = (pid = 42) => encodeSessionClaim(pid, "owner-start", "monitored");
const digest = (bytes: string) => createHash("sha256").update(bytes).digest("hex");

function invocation(host = "unix:///captured-a.sock"): NativeRuntimeInvocation {
    return {
        version: 1, runtime: "docker", executable: "/captured/bin/docker",
        transport: { kind: "docker", host, configDirectory: "/captured/config",
            tls: { enabled: false, verify: false, caFile: null, certFile: null, keyFile: null } },
        selectors: Object.fromEntries(NATIVE_RUNTIME_SELECTOR_KEYS.map(key => [key, null])) as NativeRuntimeSelectors,
    };
}

/** In-memory core ports: these tests prove policy/effect ordering, not native file or IPC qualification. */
function fixture(entries: string[] = [], contents: Record<string, string> = {}) {
    const trace: string[] = [];
    const names = [...entries];
    const records = { ...contents };
    const receipts = new Map<string, SessionOwnershipReceipt>();
    const snapshots = new Map<string, SessionClaimObservationSnapshot>();
    const writes: Array<[string, string]> = [];
    const removals: string[] = [];
    const cleanups: SessionClaimObservationSnapshot[] = [];
    const batches: Array<readonly number[]> = [];
    const observations = new Map<number, ProcessStartObservation>();
    let nextIdentity = 1;
    let held = false;
    let app: ReturnType<typeof createSessionClaims>;
    const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
    const sameReceipt = (left: SessionOwnershipReceipt, right: SessionOwnershipReceipt | undefined) =>
        right !== undefined && left.path === right.path && left.bytes === right.bytes && left.device === right.device
        && left.inode === right.inode && left.birthtime === right.birthtime && left.ownerPid === right.ownerPid;
    const matchesClaim = (receipt: SessionOwnershipReceipt) => sameReceipt(receipt, receipts.get(nameOf(receipt.path)));
    const install = (name: string, content: string) => {
        records[name] = content;
        if (!names.includes(name)) names.push(name);
        const receipt: SessionOwnershipReceipt = { path: `/claims/${name}`, bytes: Buffer.from(content).toString("base64"), device: "1",
            inode: String(nextIdentity++), birthtime: "1", ownerPid: sessionLockOwner(content)?.pid ?? 1 };
        receipts.set(name, receipt);
        return receipt;
    };
    for (const [name, content] of Object.entries(contents)) install(name, content);
    const ports: SessionClaimsPorts = {
        ensureDirectory() { return undefined; },
        listEntries() { trace.push("list"); return [...names]; },
        claimPath(name) { return `/claims/${name}`; },
        claimName: nameOf,
        readClaim(name) { trace.push(`read:${name}`); if (!(name in records)) throw new Error("unreadable"); return records[name]; },
        writeClaim(path, content) { expect(held).toBe(true); trace.push(`write:${path}`); writes.push([path, content]); install(nameOf(path), content); return undefined; },
        removeClaim(path) { throw new Error(`Unqualified removal must not be used: ${path}`); },
        createId() { return "abcdef"; },
        currentPid() { return 42; },
        startToken() { return "owner-start"; },
        observeOwners(pids) { batches.push([...pids]); return observations; },
        classify(content, observed): SessionLockLiveness {
            const owner = sessionLockOwner(content);
            if (!owner) return "unknown";
            const state = observed.get(owner.pid);
            if (state?.status === "missing") return "stale";
            if (state?.status === "found") return owner.startToken && owner.startToken !== state.token ? "stale" : "active";
            return state?.status === "present" && !owner.startToken ? "active" : "unknown";
        },
        withLifecycleLock<T>(prefix: string, operation: () => T): T {
            expect(held).toBe(false);
            trace.push(`lock:${prefix}`);
            held = true;
            try { return operation(); } finally { held = false; trace.push(`unlock:${prefix}`); }
        },
        responsibility: {
            captureClaim(name) {
                trace.push(`capture:${name}`);
                const receipt = receipts.get(name);
                if (!receipt) throw new Error("unreadable claim");
                return { receipt, content: records[name] };
            },
            matchesClaim,
            retireClaim(receipt) {
                expect(held).toBe(true);
                if (!matchesClaim(receipt)) throw new Error("claim replaced");
                trace.push(`retire:${receipt.path}`);
                removals.push(receipt.path);
                const name = nameOf(receipt.path);
                names.splice(names.indexOf(name), 1);
                receipts.delete(name);
                delete records[name];
                return undefined;
            },
            observationStore: {
                begin() { throw new Error("Registration is owned by the parent, not this core fixture"); },
                read(receipt, binding) {
                    const snapshot = snapshots.get(nameOf(receipt.path));
                    return snapshot && matchesClaim(receipt) && sameReceipt(snapshot.receipt, receipt)
                        && snapshot.observation.binding.prefix === binding.prefix ? snapshot : null;
                },
                matches(snapshot) { return snapshots.get(nameOf(snapshot.receipt.path)) === snapshot && matchesClaim(snapshot.receipt); },
                assertCurrent(snapshot) {
                    if (snapshots.get(nameOf(snapshot.receipt.path)) !== snapshot || !matchesClaim(snapshot.receipt)) throw new Error("evidence replaced");
                },
                update(snapshot, observation) {
                    expect(held).toBe(true);
                    this.assertCurrent(snapshot);
                    const next = { ...snapshot, observation, observationReceipt: { ...snapshot.observationReceipt,
                        bytes: Buffer.from(JSON.stringify(observation)).toString("base64"), inode: String(nextIdentity++) } };
                    snapshots.set(nameOf(snapshot.receipt.path), next);
                    return next;
                },
                retire(snapshot) {
                    expect(held).toBe(true);
                    if (snapshots.get(nameOf(snapshot.receipt.path)) !== snapshot) throw new Error("evidence replaced");
                    snapshots.delete(nameOf(snapshot.receipt.path));
                },
            },
            projectId() { return "project"; },
            cleanup(snapshot) {
                expect(held).toBe(true);
                cleanups.push(snapshot);
                trace.push(`stop:${snapshot.receipt.path}`);
                app.retireOwnedClaimInHeldLifecycleLock(snapshot.receipt, snapshot.observation.binding, snapshot.runtimeInvocation,
                    { containerId: snapshot.observation.ownStarted?.containerId ?? snapshot.observation.lastAcknowledged?.containerId ?? null,
                        cleanupEnabled: true, containerStopped: true, responsibilityTransferred: false });
            },
        },
    };
    const attach = (name: string, change: Partial<SessionClaimObservation> = {}, runtimeInvocation = invocation()) => {
        const receipt = receipts.get(name)!;
        const runtimeBytes = JSON.stringify(runtimeInvocation);
        const runtimeReceipt = { path: `${receipt.path}.runtime.json`, bytes: Buffer.from(runtimeBytes).toString("base64"), device: "1", inode: String(nextIdentity++), birthtime: "1" };
        const observation: SessionClaimObservation = {
            version: 1, claim: { path: receipt.path, device: receipt.device, inode: receipt.inode,
                birthtime: receipt.birthtime, digest: digest(records[name]), ownerPid: receipt.ownerPid },
            binding: { lockFile: receipt.path, projectPath: "/project", prefix: "project" },
            runtime: { path: runtimeReceipt.path, device: runtimeReceipt.device, inode: runtimeReceipt.inode,
                birthtime: runtimeReceipt.birthtime, digest: digest(runtimeBytes) },
            guardian: { pid: receipt.ownerPid + 100, startToken: "guardian-start" }, registration: "ready", generation,
            pending: null, lastAcknowledged: { generation, sequence: 1, containerId: fullId, cleanupEnabled: true },
            ownStarted: null, recovery: { status: "active", diagnostic: null }, ...change,
        };
        const snapshot: SessionClaimObservationSnapshot = { observation, receipt, runtimeInvocation, runtimeReceipt,
            observationReceipt: { path: `${receipt.path}.guardian.json`, bytes: Buffer.from(JSON.stringify(observation)).toString("base64"),
                device: "1", inode: String(nextIdentity++), birthtime: "1" } };
        snapshots.set(name, snapshot);
        return snapshot;
    };
    app = createSessionClaims(ports);
    const inGuard = <T>(operation: () => T) => ports.withLifecycleLock("project", operation);
    const recover = (scope?: SessionClaimRecoveryScope) => inGuard(() => app.recoverPredecessorsInHeldLifecycleLock("project", undefined, scope));
    const dead = (pid: number) => observations.set(pid, { status: "missing" });
    const alive = (pid: number, token: string) => observations.set(pid, { status: "found", token });
    return { app, ports, trace, names, records, receipts, snapshots, writes, removals, cleanups, batches,
        observations, attach, install, inGuard, recover, dead, alive, isHeld: () => held };
}

describe("session claim domain compatibility", () => {
    it.each(["direct", "monitored"] as const)("records explicit %s responsibility without falling back to an unmarked PID", ownershipKind => {
        for (const startToken of ["opaque", null]) {
            const encoded = encodeSessionClaim(42, startToken, ownershipKind);
            const record = JSON.parse(encoded) as { version: number; pid: number; startToken?: string | null; ownershipKind: string };
            expect(record).toEqual(expect.objectContaining({ version: 3, pid: 42, ownershipKind }));
            expect(record.startToken ?? null).toBe(startToken);
            expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(4096);
            expect(sessionLockOwner(encoded)).toEqual({ pid: 42, ...(startToken ? { startToken } : {}), ownershipKind });
        }
    });
    it("keeps v2 and decimal records unmarked instead of inventing guardian responsibility", () => {
        expect(sessionLockOwner(encodeSessionClaim(42, "opaque"))).toEqual({ pid: 42, startToken: "opaque" });
        expect(sessionLockOwner(encodeSessionClaim(42, null))).toEqual({ pid: 42 });
        expect(sessionLockOwner(" 42\r\n")).toEqual({ pid: 42 });
    });
    it.each([null, undefined, "", 42, "x".repeat(257)])("does not loosen malformed v2 token validation for %j", startToken => {
        expect(sessionLockOwner(JSON.stringify({ version: 2, pid: 42, startToken, ownershipKind: "monitored" }))).toBeNull();
    });
    it.each([undefined, null, "", "guardian", 1])("refuses an invalid v3 ownership kind %j", ownershipKind => {
        expect(sessionLockOwner(JSON.stringify({ version: 3, pid: 42, startToken: "opaque", ownershipKind }))).toBeNull();
    });
    it.each(["direct", "monitored"] as const)("accepts an absent or null v3 process token for %s claims", ownershipKind => {
        for (const tokenFields of [{}, { startToken: null }]) {
            expect(sessionLockOwner(JSON.stringify({ version: 3, pid: 42, ownershipKind, ...tokenFields }))).toEqual({ pid: 42, ownershipKind });
        }
        for (const startToken of ["", 42, "x".repeat(257)]) {
            expect(sessionLockOwner(JSON.stringify({ version: 3, pid: 42, ownershipKind, startToken }))).toBeNull();
        }
    });
    it("preserves prefix and exact record bytes, including legacy fallback without a newline", () => {
        expect(sessionClaimPrefix("project")).toBe("project");
        expect(sessionClaimPrefix("project", "")).toBe("project");
        expect(sessionClaimPrefix("project", "work--extra")).toBe("project--p--work--extra");
        expect(sessionClaimName("project--p--work", "abcdef")).toBe("project--p--work--abcdef.lock");
        expect(encodeSessionClaim(42, "opaque")).toBe('{"version":2,"pid":42,"startToken":"opaque"}');
        expect(encodeSessionClaim(42, null)).toBe("42");
        expect(encodeSessionClaim(42, "")).toBe("42");
    });
    const names = ["other--a.lock", "project--b.lock", "project-a.lock", "project--p--work--c.lock",
        "project--p--work--extra--d.lock", "project--p--work--.lock", "project--.lock", "project-.lock",
        "project--b.lock.tmp", "project.container-lifecycle.guard", "project--p--work-a.lock", "project--p--work--e.lock"];
    it("preserves nonprofile legacy selection, permissive empty segments, and enumeration order", () => {
        expect(sessionLockClaimsForContainer(names, "project")).toEqual(["project--b.lock", "project-a.lock", "project--.lock", "project-.lock"]);
        expect(names).toHaveLength(12);
    });
    it("selects exactly one nonempty session segment after a profile prefix", () => {
        expect(sessionLockClaimsForContainer(names, "project--p--work")).toEqual(["project--p--work--c.lock", "project--p--work--e.lock"]);
        expect(sessionLockClaimsForContainer(names, "project--p--work--extra")).toEqual(["project--p--work--extra--d.lock"]);
    });
    it("family queries retain double-dash claims only, including profiles and empty segments", () => {
        expect(sessionLockClaimsForProjectFamily(names, "project")).toEqual(["project--b.lock", "project--p--work--c.lock", "project--p--work--extra--d.lock",
            "project--p--work--.lock", "project--.lock", "project--p--work-a.lock", "project--p--work--e.lock"]);
    });
});

describe("explicit session reservation and observation", () => {
    it("marks standalone creation direct and held reservation monitored without reacquiring the guard", () => {
        const standalone = fixture();
        expect(standalone.app.createSessionLock("project")).toBe("/claims/project--abcdef.lock");
        expect(standalone.writes).toEqual([["/claims/project--abcdef.lock", direct()]]);
        const guarded = fixture();
        expect(guarded.inGuard(() => guarded.app.reserveSessionLockInHeldLifecycleLock("project"))).toBe("/claims/project--abcdef.lock");
        expect(guarded.writes).toEqual([["/claims/project--abcdef.lock", monitored()]]);
        expect(guarded.trace.filter(item => item.startsWith("lock:"))).toEqual(["lock:project"]);
    });
    it("raw queries select exact container and family prefixes without reading or retiring claims", () => {
        const profiled = "project--p--work--a.lock";
        const f = fixture([current, old, profiled, "project-a.lock", "other--a.lock"]);
        expect(f.app.getSessionLockClaimsForContainer("project")).toEqual([current, old, "project-a.lock"]);
        expect(f.app.getSessionLockClaimsForProjectFamily("project")).toEqual([current, old, profiled]);
        expect(f.app.hasOtherSessionClaims("project", `/claims/${current}`)).toBe(true);
        expect(f.app.hasOtherReconciledSessionClaims("project", `/claims/${current}`)).toBe(true);
        expect(f.trace.every(item => item === "list")).toBe(true);
        expect(f.removals).toEqual([]);
    });
    it("all active queries omit a proven-dead marked direct owner without deleting its receipt", () => {
        const f = fixture([old], { [old]: direct(7) });
        f.dead(7);
        expect(f.app.getActiveSessionsForContainer("project")).toEqual([]);
        expect(f.app.observeActiveSessionsForContainer("project")).toEqual([]);
        expect(f.app.getActiveSessionsForProjectFamily("project")).toEqual([]);
        expect(f.app.hasOtherActiveSessions("project", `/claims/${current}`)).toBe(false);
        expect(f.app.getSessionLockClaimsForContainer("project")).toEqual([old]);
        expect(f.removals).toEqual([]);
        expect(f.cleanups).toEqual([]);
    });
    it.each(["7", versioned(7), monitored(7)])("dead-parent observation alone retains legacy or monitored receipt %s", content => {
        const f = fixture([old], { [old]: content });
        f.dead(7);
        if (sessionLockOwner(content)?.ownershipKind === "monitored") {
            const captured = f.attach(old);
            f.alive(captured.observation.guardian.pid, "guardian-start");
        }
        expect(f.app.getActiveSessionsForContainer("project")).toEqual([old]);
        expect(f.app.observeActiveSessionsForContainer("project")).toEqual([old]);
        expect(f.app.getActiveSessionsForProjectFamily("project")).toEqual([old]);
        expect(f.app.hasOtherActiveSessions("project", `/claims/${current}`)).toBe(true);
        expect(f.removals).toEqual([]);
        expect(f.cleanups).toEqual([]);
    });
    it("a same-PID current hint does not supersede an unmarked predecessor", () => {
        const f = fixture([current, old], { [current]: monitored(), [old]: "42" });
        f.alive(42, "owner-start");
        expect(f.app.getActiveSessionsForContainer("project", `/claims/${current}`)).toEqual([current, old]);
        expect(f.app.observeActiveSessionsForContainer("project", `/claims/${current}`)).toEqual([current, old]);
        expect(f.removals).toEqual([]);
    });
    it("unreadable claims and uncertain process observations remain visible without effects", () => {
        const f = fixture([old, other], { [old]: direct(7) });
        f.observations.set(7, { status: "unknown" });
        expect(f.app.getActiveSessionsForContainer("project")).toEqual([old, other]);
        expect(f.removals).toEqual([]);
        expect(f.cleanups).toEqual([]);
    });
    it("observation failure propagates instead of granting absence", () => {
        const f = fixture([old], { [old]: direct(7) });
        const failure = new Error("observation unavailable");
        f.ports.observeOwners = () => { throw failure; };
        expect(() => f.app.getActiveSessionsForContainer("project")).toThrow(failure);
        expect(f.removals).toEqual([]);
    });
});

describe("guarded predecessor responsibility recovery", () => {
    it("retires only positively dead marked direct claims, never the own claim or sibling profile", () => {
        const sibling = "project--p--work--a.lock";
        const f = fixture([current, old, sibling], { [current]: direct(), [old]: direct(7), [sibling]: direct(8) });
        f.dead(42); f.dead(7); f.dead(8);
        expect(f.inGuard(() => f.app.reconcileForeignClaimsInHeldLifecycleLock("project", `/claims/${current}`))).toBe(false);
        expect(f.removals).toEqual([`/claims/${old}`]);
        expect(f.names).toEqual([current, sibling]);
        expect(f.cleanups).toEqual([]);
    });
    it("failed qualified retirement remains incomplete and cannot permit replacement", () => {
        const f = fixture([old], { [old]: direct(7) });
        f.dead(7);
        f.ports.responsibility!.retireClaim = () => { throw new Error("sharing violation"); };
        expect(() => f.inGuard(() => f.app.reconcileForeignClaimsInHeldLifecycleLock("project", `/claims/${current}`))).toThrow(/session-cleanup-responsibility-incomplete/);
        expect(() => f.app.recreateContainerWithoutInterruptingSessions("project", `/claims/${current}`, () => { throw new Error("must not recreate"); })).toThrow(/session-cleanup-responsibility-incomplete/);
        expect(f.names).toEqual([old]);
    });
    it.each(["guardian-live", "guardian-unknown", "owner-live"] as const)("protects a monitored predecessor when %s", participant => {
        const f = fixture([old], { [old]: monitored(7) });
        const captured = f.attach(old);
        f.dead(7); f.dead(captured.observation.guardian.pid);
        if (participant === "guardian-live") f.alive(captured.observation.guardian.pid, "guardian-start");
        if (participant === "guardian-unknown") f.observations.set(captured.observation.guardian.pid, { status: "unknown" });
        if (participant === "owner-live") f.alive(7, "owner-start");
        f.recover();
        expect(f.names).toEqual([old]);
        expect(f.removals).toEqual([]);
        expect(f.cleanups).toEqual([]);
    });
    it.each(["7", versioned(7), monitored(7)])("dead unqualified predecessor %s remains concretely incomplete", content => {
        const f = fixture([old], { [old]: content });
        f.dead(7);
        expect(f.recover).toThrow(/session-cleanup-responsibility-incomplete/);
        expect(f.names).toEqual([old]);
        expect(f.cleanups).toEqual([]);
        expect(f.removals).toEqual([]);
    });
    it("uses the positively dead guardian's captured runtime and exact ACK target before qualified retirement", () => {
        const f = fixture([old], { [old]: monitored(7) });
        const captured = f.attach(old);
        f.dead(7); f.dead(captured.observation.guardian.pid);
        f.recover();
        expect(f.cleanups).toHaveLength(1);
        expect(f.cleanups[0].runtimeInvocation).toEqual(invocation());
        expect(f.cleanups[0].observation.lastAcknowledged?.containerId).toBe(fullId);
        expect(f.trace.indexOf(`stop:/claims/${old}`)).toBeLessThan(f.trace.indexOf(`retire:/claims/${old}`));
        expect(f.names).toEqual([]);
        expect(f.snapshots.size).toBe(0);
        expect(f.batches.some(pids => pids.includes(7) && pids.includes(captured.observation.guardian.pid))).toBe(true);
    });
    it("recorded parent and guardian token reuse permits qualified recovery without trusting those current PIDs", () => {
        const f = fixture([old], { [old]: monitored(7) });
        const captured = f.attach(old);
        f.alive(7, "new-owner-process");
        f.alive(captured.observation.guardian.pid, "new-guardian-process");
        f.recover();
        expect(f.cleanups).toHaveLength(1);
        expect(f.names).toEqual([]);
    });
    it("three failed cleanup attempts retain a concrete recovery record that a later admission can retry", () => {
        const f = fixture([old], { [old]: monitored(7) });
        const captured = f.attach(old);
        f.dead(7); f.dead(captured.observation.guardian.pid);
        const complete = f.ports.responsibility!.cleanup;
        f.ports.responsibility!.cleanup = () => { throw new Error("inert stop refused"); };
        for (let attempt = 0; attempt < 3; attempt++) {
            expect(f.recover).toThrow(/session-cleanup-responsibility-incomplete/);
            expect(f.names).toEqual([old]);
            expect(f.snapshots.get(old)?.observation.recovery).toEqual({ status: "recovery-needed", diagnostic: "session-cleanup-failed" });
        }
        f.ports.responsibility!.cleanup = complete;
        f.recover();
        expect(f.cleanups).toHaveLength(1);
        expect(f.names).toEqual([]);
    });
    it.each(["update", "startup"] as const)("a pending %s grant without current ACK or own-start is not stop authority", kind => {
        const f = fixture([old], { [old]: monitored(7) });
        const captured = f.attach(old, { lastAcknowledged: null,
            pending: { kind, generation, sequence: 2, containerId: fullId, cleanupEnabled: true } });
        f.dead(7); f.dead(captured.observation.guardian.pid);
        expect(f.recover).toThrow(/session-cleanup-responsibility-incomplete/);
        expect(f.cleanups).toEqual([]);
        expect(f.names).toEqual([old]);
    });
    it("a positive current own-start survives an earlier unacknowledged enable and supplies compensation authority", () => {
        const f = fixture([old], { [old]: monitored(7) });
        const captured = f.attach(old, { registration: "pending", lastAcknowledged: null,
            pending: { kind: "startup", generation, sequence: 2, containerId: fullId, cleanupEnabled: true },
            ownStarted: { generation, containerId: fullId } });
        f.dead(7); f.dead(captured.observation.guardian.pid);
        f.recover();
        expect(f.cleanups).toHaveLength(1);
        expect(f.cleanups[0].observation.ownStarted?.containerId).toBe(fullId);
        expect(f.names).toEqual([]);
    });
    it.each(["stale-ack", "stale-own-start", "pending-revoke"] as const)("%s cannot resurrect shutdown authority", scenario => {
        const f = fixture([old], { [old]: monitored(7) });
        const captured = f.attach(old, scenario === "stale-ack" ? { generation: "new-generation" }
            : scenario === "stale-own-start" ? { lastAcknowledged: null, ownStarted: { generation: "old-generation", containerId: fullId } }
                : { pending: { kind: "update", generation, sequence: 2, containerId: fullId, cleanupEnabled: false } });
        f.dead(7); f.dead(captured.observation.guardian.pid);
        expect(f.recover).toThrow(/session-cleanup-responsibility-incomplete/);
        expect(f.cleanups).toEqual([]);
        expect(f.names).toEqual([old]);
    });
    it("definite current cleanup-disabled ACK retires no-obligation rollback without a native stop", () => {
        const f = fixture([old], { [old]: monitored(7) });
        const captured = f.attach(old, { lastAcknowledged: { generation, sequence: 1, containerId: fullId, cleanupEnabled: false } });
        f.inGuard(() => f.app.settleCapturedResponsibilityInHeldLifecycleLock(captured.observation.binding, captured.receipt, captured.runtimeInvocation));
        expect(f.names).toEqual([]);
        expect(f.cleanups).toEqual([]);
        expect(f.removals).toEqual([`/claims/${old}`]);
    });
    it.each(["pending", "ready"] as const)("initial %s registration without a startup request rolls back only its own no-obligation receipt", registration => {
        const f = fixture([old, other], { [old]: monitored(7), [other]: monitored(8) });
        const captured = f.attach(old, { registration, lastAcknowledged: null });
        const peer = f.attach(other);
        f.inGuard(() => f.app.settleCapturedResponsibilityInHeldLifecycleLock(captured.observation.binding, captured.receipt, captured.runtimeInvocation));
        expect(f.names).toEqual([other]);
        expect(f.snapshots.get(other)).toBe(peer);
        expect(f.cleanups).toEqual([]);
    });
    it("a generic pending startup cannot be erased through captured rollback", () => {
        const f = fixture([old], { [old]: monitored(7) });
        const captured = f.attach(old, { lastAcknowledged: null,
            pending: { kind: "startup", generation, sequence: 2, containerId: null, cleanupEnabled: true } });
        expect(() => f.inGuard(() => f.app.settleCapturedResponsibilityInHeldLifecycleLock(captured.observation.binding, captured.receipt, captured.runtimeInvocation)))
            .toThrow(/session-cleanup-responsibility-incomplete/);
        expect(f.names).toEqual([old]);
        expect(f.cleanups).toEqual([]);
        expect(f.removals).toEqual([]);
    });
    it("an older cleanup-disabled ACK cannot declare a newer generation free of responsibility", () => {
        const f = fixture([old], { [old]: monitored(7) });
        const captured = f.attach(old, { generation: "new-generation",
            lastAcknowledged: { generation, sequence: 1, containerId: fullId, cleanupEnabled: false } });
        expect(() => f.inGuard(() => f.app.settleCapturedResponsibilityInHeldLifecycleLock(captured.observation.binding, captured.receipt, captured.runtimeInvocation)))
            .toThrow(/session-cleanup-responsibility-incomplete/);
        expect(f.names).toEqual([old]);
        expect(f.cleanups).toEqual([]);
        expect(f.removals).toEqual([]);
    });
    it("a same-byte replacement between qualification and effect survives without a stop or unlink", () => {
        const f = fixture([old], { [old]: monitored(7) });
        const captured = f.attach(old);
        f.dead(7); f.dead(captured.observation.guardian.pid);
        const observe = f.ports.observeOwners;
        const content = f.records[old];
        f.ports.observeOwners = pids => { const result = observe(pids); f.install(old, content); return result; };
        expect(f.recover).toThrow(/session-cleanup-responsibility-incomplete/);
        expect(f.receipts.get(old)?.inode).not.toBe(captured.receipt.inode);
        expect(f.records[old]).toBe(content);
        expect(f.cleanups).toEqual([]);
        expect(f.removals).toEqual([]);
    });
});


describe("project-scoped automatic legacy reconciliation", () => {
    function recovery(f: ReturnType<typeof fixture>, initial: ReturnType<SessionClaimRecoveryScope["inspectContainer"]>) {
        const state = { target: initial, stopped: [] as string[], inspections: 0 };
        const scope: SessionClaimRecoveryScope = {
            runtimeInvocation: invocation(),
            inspectContainer() { expect(f.isHeld()).toBe(true); state.inspections++; return state.target; },
            stopContainer(readId) {
                expect(f.isHeld()).toBe(true);
                const id = readId();
                if (!id) throw new Error("target changed");
                state.stopped.push(id); f.trace.push(`legacy-stop:${id}`);
                state.target = { known: true, containerId: id, running: false };
                return undefined;
            },
        };
        return { scope, state };
    }
    it.each(["7", versioned(7)])("retires stale sidecar-less %s only after confirmed absence and returns a fresh listing", content => {
        const f = fixture([old], { [old]: content }); f.dead(7);
        const r = recovery(f, { known: true, containerId: null });
        expect(f.recover(r.scope)).toEqual([]);
        expect(r.state.inspections).toBeGreaterThan(0); expect(r.state.stopped).toEqual([]);
        expect(f.removals).toEqual([`/claims/${old}`]); expect(f.cleanups).toEqual([]);
        expect(f.trace.at(-2)).toBe("list");
    });
    it("retires two dead legacy records against an already stopped target without dispatching stop", () => {
        const f = fixture([old, other], { [old]: "7", [other]: versioned(8) }); f.dead(7); f.dead(8);
        const r = recovery(f, { known: true, containerId: fullId, running: false });
        expect(f.recover(r.scope)).toEqual([]);
        expect(r.state.stopped).toEqual([]); expect(f.removals).toEqual([`/claims/${old}`, `/claims/${other}`]);
    });
    it("stops the exact managed running orphan before retiring dead legacy records", () => {
        const f = fixture([old, other], { [old]: "7", [other]: versioned(8) }); f.dead(7); f.dead(8);
        const r = recovery(f, { known: true, containerId: fullId, running: true });
        expect(f.recover(r.scope)).toEqual([]);
        expect(r.state.stopped).toEqual([fullId]);
        expect(f.trace.indexOf(`legacy-stop:${fullId}`)).toBeLessThan(f.trace.indexOf(`retire:/claims/${old}`));
        expect(f.removals).toEqual([`/claims/${old}`, `/claims/${other}`]);
    });
    it("uses the recorded start token to reclaim a reused legacy PID without touching the new process", () => {
        const f = fixture([old], { [old]: versioned(7, "previous-start") }); f.alive(7, "different-start");
        const r = recovery(f, { known: true, containerId: null });
        expect(f.recover(r.scope)).toEqual([]); expect(f.removals).toEqual([`/claims/${old}`]);
    });
    it.each(["live", "unknown"] as const)("preserves a %s legacy owner without assuming file presence is process liveness", state => {
        const f = fixture([old], { [old]: versioned(7) });
        if (state === "live") f.alive(7, "opaque"); else f.observations.set(7, { status: "unknown" });
        const r = recovery(f, { known: true, containerId: fullId, running: true });
        expect(f.recover(r.scope)).toEqual([old]); expect(r.state.stopped).toEqual([]); expect(f.removals).toEqual([]);
    });
    it.each([
        { known: false, containerId: null, reason: "runtime-list-failed" },
        { known: true, containerId: fullId },
        { known: true, containerId: "short-id", running: true },
        { known: true, containerId: fullId, running: true, requiresLiveVerification: true as const },
    ])("preserves dead legacy responsibility when target proof is incomplete: %j", target => {
        const f = fixture([old], { [old]: "7" }); f.dead(7);
        const r = recovery(f, target);
        expect(() => f.recover(r.scope)).toThrow(/session-cleanup-responsibility-incomplete/);
        expect(f.names).toEqual([old]); expect(r.state.stopped).toEqual([]); expect(f.removals).toEqual([]);
    });
    it.each(["live", "unknown", "monitored"] as const)("does not stop a legacy orphan protected by a %s peer", state => {
        const f = fixture([old, other], { [old]: "7", [other]: state === "monitored" ? monitored(8) : versioned(8) }); f.dead(7);
        if (state === "live") f.alive(8, "opaque");
        else if (state === "unknown") f.observations.set(8, { status: "unknown" });
        else { f.dead(8); const peer = f.attach(other); f.alive(peer.observation.guardian.pid, "guardian-start"); }
        const r = recovery(f, { known: true, containerId: fullId, running: true });
        expect(() => f.recover(r.scope)).toThrow(/session-cleanup-responsibility-incomplete/);
        expect(r.state.stopped).toEqual([]); expect(f.names).toEqual([old, other]); expect(f.removals).toEqual([]);
    });
    it("cannot promote missing monitored evidence to legacy migration authority", () => {
        const f = fixture([old], { [old]: monitored(7) }); f.dead(7);
        const r = recovery(f, { known: true, containerId: null });
        expect(() => f.recover(r.scope)).toThrow(/session-cleanup-responsibility-incomplete/);
        expect(f.names).toEqual([old]); expect(r.state.stopped).toEqual([]); expect(f.removals).toEqual([]);
    });
    it("preserves partial legacy sidecars instead of treating an observation read failure as absence", () => {
        const f = fixture([old], { [old]: "7" }); f.dead(7);
        f.ports.responsibility!.observationStore.read = () => { throw new Error("partial sidecars"); };
        const r = recovery(f, { known: true, containerId: null });
        expect(() => f.recover(r.scope)).toThrow(/session-cleanup-responsibility-incomplete/);
        expect(f.names).toEqual([old]); expect(f.removals).toEqual([]);
    });
    it("rechecks sidecar absence after observing the target and before stopping or retiring", () => {
        const f = fixture([old], { [old]: "7" }); f.dead(7);
        let sidecarAppeared = false;
        f.ports.responsibility!.observationStore.read = () => {
            if (sidecarAppeared) throw new Error("sidecar appeared");
            return null;
        };
        const r = recovery(f, { known: true, containerId: fullId, running: true });
        r.scope.inspectContainer = () => { sidecarAppeared = true; return r.state.target; };
        expect(() => f.recover(r.scope)).toThrow(/session-cleanup-responsibility-incomplete/);
        expect(r.state.stopped).toEqual([]); expect(f.names).toEqual([old]); expect(f.removals).toEqual([]);
    });
    it("preserves a same-byte replacement made while inspecting a stale legacy target", () => {
        const f = fixture([old], { [old]: "7" }); f.dead(7);
        const original = f.receipts.get(old)!;
        const r = recovery(f, { known: true, containerId: fullId, running: true });
        r.scope.inspectContainer = () => { f.install(old, "7"); return r.state.target; };
        expect(() => f.recover(r.scope)).toThrow(/session-cleanup-responsibility-incomplete/);
        expect(f.receipts.get(old)!.inode).not.toBe(original.inode);
        expect(r.state.stopped).toEqual([]); expect(f.names).toEqual([old]); expect(f.removals).toEqual([]);
    });
    it("reobserves peers before stopping so an owner that becomes observable as live remains protective", () => {
        const f = fixture([old, other], { [old]: "7", [other]: versioned(8) }); f.dead(7); f.dead(8);
        const r = recovery(f, { known: true, containerId: fullId, running: true });
        r.scope.inspectContainer = () => { f.alive(8, "opaque"); return r.state.target; };
        expect(() => f.recover(r.scope)).toThrow(/session-cleanup-responsibility-incomplete/);
        expect(r.state.stopped).toEqual([]); expect(f.names).toEqual([old, other]); expect(f.removals).toEqual([]);
    });
    it("never redirects an orphan stop when a later managed-target observation changes ID", () => {
        const f = fixture([old], { [old]: "7" }); f.dead(7);
        const r = recovery(f, { known: true, containerId: fullId, running: true });
        let count = 0;
        r.scope.inspectContainer = () => ({ known: true, containerId: ++count === 1 ? fullId : differentId, running: true });
        expect(() => f.recover(r.scope)).toThrow(/session-cleanup-responsibility-incomplete/);
        expect(r.state.stopped).toEqual([]); expect(f.names).toEqual([old]);
    });
    it("reports the freshly remaining files even when qualified retirement fails", () => {
        const f = fixture([old], { [old]: "7" }); f.dead(7);
        const r = recovery(f, { known: true, containerId: null });
        f.ports.responsibility!.retireClaim = () => { f.install(other, versioned(9)); throw new Error("sharing violation"); };
        const result = f.inGuard(() => f.app.reconcileSessionClaimsInHeldLifecycleLock("project", undefined, r.scope));
        expect(result.claims).toEqual([old, other]); expect(result.error).toBeInstanceOf(Error);
        expect(result.error!.message).toMatch(/session-cleanup-responsibility-incomplete/);
        expect(f.trace.at(-2)).toBe("list"); expect(f.removals).toEqual([]);
    });
    it("retires a dead legacy veto before settling a qualified dead monitored obligation on the same runtime and exact ID", () => {
        const f = fixture([old, other], { [old]: "7", [other]: monitored(8) });
        const monitoredClaim = f.attach(other); f.dead(7); f.dead(8); f.dead(monitoredClaim.observation.guardian.pid);
        const r = recovery(f, { known: true, containerId: fullId, running: true });
        expect(f.recover(r.scope)).toEqual([]);
        expect(r.state.stopped).toEqual([]); expect(f.cleanups).toEqual([monitoredClaim]);
        expect(f.trace.indexOf(`retire:/claims/${old}`)).toBeLessThan(f.trace.indexOf(`stop:/claims/${other}`));
        expect(f.removals).toEqual([`/claims/${old}`, `/claims/${other}`]);
    });
    it.each(["other-runtime", "pending", "live-guardian"] as const)("does not transfer a dead legacy veto to a monitored %s participant", state => {
        const f = fixture([old, other], { [old]: "7", [other]: monitored(8) });
        const monitoredClaim = f.attach(other, state === "pending" ? { lastAcknowledged: null,
            pending: { kind: "startup", generation, sequence: 2, containerId: fullId, cleanupEnabled: true } } : {},
            state === "other-runtime" ? invocation("unix:///other-engine.sock") : invocation());
        f.dead(7); f.dead(8); f.dead(monitoredClaim.observation.guardian.pid);
        if (state === "live-guardian") f.alive(monitoredClaim.observation.guardian.pid, "guardian-start");
        const r = recovery(f, { known: true, containerId: fullId, running: true });
        expect(() => f.recover(r.scope)).toThrow(/session-cleanup-responsibility-incomplete/);
        expect(r.state.stopped).toEqual([]); expect(f.removals).not.toContain(`/claims/${old}`);
        expect(f.names).toContain(old);
    });

    it("keeps a failed orphan stop retryable and retires only after a later confirmed-absent attempt", () => {
        const f = fixture([old], { [old]: "7" }); f.dead(7);
        const r = recovery(f, { known: true, containerId: fullId, running: true });
        r.scope.stopContainer = () => { throw new Error("daemon disconnected"); };
        expect(() => f.recover(r.scope)).toThrow(/session-cleanup-responsibility-incomplete/);
        expect(f.names).toEqual([old]); expect(f.removals).toEqual([]);
        r.state.target = { known: true, containerId: null };
        expect(f.recover(r.scope)).toEqual([]); expect(f.removals).toEqual([`/claims/${old}`]);
    });
});

describe("obligation transfer retains a responsible successor", () => {
    it("a missing own ledger never borrows permission from an otherwise independent peer", () => {
        const f = fixture([old, other], { [old]: monitored(7), [other]: monitored(8) });
        f.attach(other, { lastAcknowledged: { generation, sequence: 1, containerId: differentId, cleanupEnabled: true } });
        const veto = f.inGuard(() => f.app.peerVetoesInHeldLifecycleLock("project", `/claims/${old}`, fullId, invocation()));
        expect(veto).toEqual({ sharedDeviceCleanupBlocked: true, exactContainerStopBlocked: true, responsibilityTransferred: false });
        expect(f.removals).toEqual([]);
    });
    it("a same-ID cleanup-disabled peer cannot inherit a predecessor's true obligation", () => {
        const f = fixture([old, other], { [old]: monitored(7), [other]: monitored(8) });
        const source = f.attach(old);
        const peer = f.attach(other, { lastAcknowledged: { generation, sequence: 1, containerId: fullId, cleanupEnabled: false } });
        f.alive(8, "owner-start"); f.alive(peer.observation.guardian.pid, "guardian-start");
        const veto = f.inGuard(() => f.app.peerVetoesInHeldLifecycleLock("project", source.receipt.path, fullId, source.runtimeInvocation));
        expect(veto).toEqual({ sharedDeviceCleanupBlocked: true, exactContainerStopBlocked: true, responsibilityTransferred: false });
        expect(() => f.inGuard(() => f.app.retireOwnedClaimInHeldLifecycleLock(source.receipt, source.observation.binding, source.runtimeInvocation,
            { containerId: fullId, cleanupEnabled: true, containerStopped: false, responsibilityTransferred: false }))).toThrow(/session-cleanup-responsibility-incomplete/);
        expect(f.names).toEqual([old, other]);
        expect(f.cleanups).toEqual([]);
    });
    it("qualified current true same-authority peer carries the obligation while its predecessor retires", () => {
        const f = fixture([old, other], { [old]: monitored(7), [other]: monitored(8) });
        const source = f.attach(old);
        const target = f.attach(other);
        f.alive(8, "owner-start"); f.alive(target.observation.guardian.pid, "guardian-start");
        const veto = f.inGuard(() => f.app.peerVetoesInHeldLifecycleLock("project", source.receipt.path, fullId, source.runtimeInvocation));
        expect(veto).toEqual({ sharedDeviceCleanupBlocked: true, exactContainerStopBlocked: true, responsibilityTransferred: true });
        f.inGuard(() => f.app.retireOwnedClaimInHeldLifecycleLock(source.receipt, source.observation.binding, source.runtimeInvocation,
            { containerId: fullId, cleanupEnabled: true, containerStopped: false, responsibilityTransferred: true }));
        expect(f.names).toEqual([other]);
        expect(f.snapshots.get(other)).toBe(target);
        expect(f.cleanups).toEqual([]);
    });
    it("equal opaque ID on a different captured authority remains ambiguous", () => {
        const f = fixture([old, other], { [old]: monitored(7), [other]: monitored(8) });
        const source = f.attach(old);
        f.attach(other, {}, invocation("unix:///different-authority.sock"));
        const veto = f.inGuard(() => f.app.peerVetoesInHeldLifecycleLock("project", source.receipt.path, fullId, source.runtimeInvocation));
        expect(veto).toEqual({ sharedDeviceCleanupBlocked: true, exactContainerStopBlocked: true, responsibilityTransferred: false });
        expect(f.names).toEqual([old, other]);
    });
    it("same-ID obligations with different captured authorities cannot discard either all-dead receipt", () => {
        const f = fixture([old, other], { [old]: monitored(7), [other]: monitored(8) });
        const first = f.attach(old);
        const second = f.attach(other, {}, invocation("unix:///different-authority.sock"));
        for (const snapshot of [first, second]) { f.dead(snapshot.receipt.ownerPid); f.dead(snapshot.observation.guardian.pid); }
        expect(f.recover).toThrow(/session-cleanup-responsibility-incomplete/);
        expect(f.names).toEqual([old, other]);
        expect(f.removals).toEqual([]);
        expect(f.cleanups).toEqual([]);
    });
    it("matching endpoint and ID cannot transfer responsibility across different captured executables", () => {
        const f = fixture([old, other], { [old]: monitored(7), [other]: monitored(8) });
        const source = f.attach(old);
        const peer = f.attach(other, {}, { ...invocation(), executable: "/different/bin/docker" });
        f.alive(8, "owner-start"); f.alive(peer.observation.guardian.pid, "guardian-start");
        const veto = f.inGuard(() => f.app.peerVetoesInHeldLifecycleLock("project", source.receipt.path, fullId, source.runtimeInvocation));
        expect(veto).toEqual({ sharedDeviceCleanupBlocked: true, exactContainerStopBlocked: true, responsibilityTransferred: false });
        expect(f.names).toEqual([old, other]);
    });
    it("an acknowledged different full ID protects shared devices while allowing the predecessor's exact stop", () => {
        const f = fixture([old, other], { [old]: monitored(7), [other]: monitored(8) });
        const source = f.attach(old);
        f.attach(other, { lastAcknowledged: { generation, sequence: 1, containerId: differentId, cleanupEnabled: true } });
        const veto = f.inGuard(() => f.app.peerVetoesInHeldLifecycleLock("project", source.receipt.path, fullId, source.runtimeInvocation));
        expect(veto).toEqual({ sharedDeviceCleanupBlocked: true, exactContainerStopBlocked: false, responsibilityTransferred: false });
        expect(f.removals).toEqual([]);
    });
    it("an interrupted all-dead cohort leaves the deterministic final obligation for a later recovery", () => {
        const first = "project--a.lock";
        const second = "project--z.lock";
        const f = fixture([second, first], { [second]: monitored(8), [first]: monitored(7) });
        const survivor = f.attach(first);
        const redundant = f.attach(second);
        for (const snapshot of [survivor, redundant]) { f.dead(snapshot.receipt.ownerPid); f.dead(snapshot.observation.guardian.pid); }
        const complete = f.ports.responsibility!.cleanup;
        f.ports.responsibility!.cleanup = () => { throw new Error("interrupted before final stop"); };
        expect(f.recover).toThrow(/session-cleanup-responsibility-incomplete/);
        expect(f.names).toEqual([first]);
        expect(f.removals).toEqual([`/claims/${second}`]);
        f.ports.responsibility!.cleanup = complete;
        f.recover();
        expect(f.cleanups.map(snapshot => snapshot.receipt.path)).toEqual([`/claims/${first}`]);
        expect(f.names).toEqual([]);
        expect(f.removals).toEqual([`/claims/${second}`, `/claims/${first}`]);
    });
});

describe("retained pending-only recovery classification", () => {
    function pendingPair() {
        const f = fixture([old, other], {[old]: monitored(7), [other]: monitored(8)});
        const snapshots = [old, other].map((name, index) => f.attach(name, {
            generation: `pending-${index}`, lastAcknowledged: null,
            pending: {kind: "startup", generation: `pending-${index}`, sequence: 2, containerId: null, cleanupEnabled: true},
        }));
        for (const snapshot of snapshots) { f.dead(snapshot.receipt.ownerPid); f.dead(snapshot.observation.guardian.pid); }
        const scope: SessionClaimRecoveryScope = {runtimeInvocation: invocation(),
            inspectContainer: () => ({known: true, containerId: fullId, running: true}),
            stopContainer: () => { throw new Error("pending evidence cannot authorize stop"); }};
        return {f, snapshots, scope};
    }
    it("reports two qualified same-runtime pending predecessors without changing either obligation", () => {
        const {f, snapshots, scope} = pendingPair();
        const before = JSON.stringify(snapshots);
        const result = f.inGuard(() => f.app.reconcileSessionClaimsInHeldLifecycleLock("project", undefined, scope));
        expect(result.claims).toEqual([old, other]); expect(result.error).toBeInstanceOf(Error);
        expect(result.retainedPendingOnly).toBe(true);
        expect(JSON.stringify([f.snapshots.get(old), f.snapshots.get(other)])).toBe(before);
        expect(f.cleanups).toEqual([]); expect(f.removals).toEqual([]); expect(f.writes).toEqual([]);
        expect(() => f.recover(scope)).toThrow(/session-cleanup-responsibility-incomplete/);
        expect(JSON.stringify([f.snapshots.get(old), f.snapshots.get(other)])).toBe(before);
    });
    it.each(["runtime-mismatch", "missing-runtime", "unknown-guardian", "missing-evidence", "replaced-receipt", "mixed-cleanup-failure"] as const)("does not classify %s as the restricted pending-only class", fault => {
        const {f, snapshots, scope} = pendingPair();
        const selectedScope: SessionClaimRecoveryScope = fault === "runtime-mismatch" ? {...scope, runtimeInvocation: invocation("unix:///another-engine.sock")}
            : fault === "missing-runtime" ? {inspectContainer: scope.inspectContainer, stopContainer: scope.stopContainer} : scope;
        if (fault === "unknown-guardian") f.observations.set(snapshots[1].observation.guardian.pid, {status: "unknown"});
        if (fault === "missing-evidence") f.snapshots.delete(other);
        if (fault === "replaced-receipt") {
            const observe = f.ports.observeOwners;
            f.ports.observeOwners = pids => { const result = observe(pids); f.install(other, f.records[other]); return result; };
        }
        if (fault === "mixed-cleanup-failure") {
            f.attach(other);
            f.ports.responsibility!.cleanup = () => { throw new Error("qualified stop failed"); };
        }
        const result = f.inGuard(() => f.app.reconcileSessionClaimsInHeldLifecycleLock("project", undefined, selectedScope));
        expect(result.retainedPendingOnly).not.toBe(true);
        if (fault !== "unknown-guardian") expect(result.error).toBeInstanceOf(Error);
        expect(result.claims).toEqual([old, other]); expect(f.removals).toEqual([]);
    });
});
