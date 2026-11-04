import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSessionClaims } from "../../application/session-claims.js";
import { createSessionCleanup } from "../../application/session-cleanup.js";
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

function windowsInvocation(path: string): NativeRuntimeInvocation {
    return {
        ...invocation("npipe:////./pipe/dockerDesktopLinuxEngine"),
        executable: "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
        transport: { kind: "docker", host: "npipe:////./pipe/dockerDesktopLinuxEngine", configDirectory: "C:\\Users\\owner\\.docker",
            tls: { enabled: false, verify: false, caFile: null, certFile: null, keyFile: null } },
        selectors: { ...invocation().selectors, PATH: path },
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

/** Exercise the real peer-veto and settlement policy while keeping native effects explicit. */
function policyCleanup(f: ReturnType<typeof fixture>, stopFailure?: Error) {
    const effects: string[] = [];
    f.ports.responsibility!.cleanup = snapshot => {
        effects.push("cleanup");
        const cleanup = createSessionCleanup({
            projectId: () => "project", withLifecycleLock: f.ports.withLifecycleLock,
            peerVetoes: (prefix, ownPath, id) => f.app.peerVetoesInHeldLifecycleLock(prefix, ownPath, id, snapshot.runtimeInvocation),
            removeClaim: (_path, settlement) => {
                f.app.retireOwnedClaimInHeldLifecycleLock(snapshot.receipt, snapshot.observation.binding, snapshot.runtimeInvocation, settlement);
                return undefined;
            },
            cleanupDevices: () => { effects.push("devices"); return { stopped: 0, skipped: 0, failed: 0 }; },
            reportDeviceCleanupFailure: () => { throw new Error("unexpected device cleanup failure"); },
            stopContainer: readId => {
                expect(readId()).toBe(fullId); effects.push("stop");
                if (stopFailure) throw stopFailure;
                return undefined;
            },
        });
        cleanup.setSession(snapshot.receipt.path, "/project");
        cleanup.setSessionContainerId(snapshot.observation.ownStarted?.containerId ?? snapshot.observation.lastAcknowledged?.containerId ?? null);
        cleanup.cleanupSessionInHeldLifecycleLock();
    };
    return effects;
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
    it.each(["7", versioned(7), monitored(7)])("active queries exclude dead legacy or monitored owners without deleting %s", content => {
        const f = fixture([old], { [old]: content });
        f.dead(7);
        if (sessionLockOwner(content)?.ownershipKind === "monitored") {
            const captured = f.attach(old);
            f.alive(captured.observation.guardian.pid, "guardian-start");
        }
        expect(f.app.getActiveSessionsForContainer("project")).toEqual([]);
        expect(f.app.observeActiveSessionsForContainer("project")).toEqual([]);
        expect(f.app.getActiveSessionsForProjectFamily("project")).toEqual([]);
        expect(f.app.hasOtherActiveSessions("project", `/claims/${current}`)).toBe(false);
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

describe("guarded stale session reset", () => {
    it.each(["7", versioned(7), direct(7), monitored(7)])("removes a positively dead %s parent without container effects", content => {
        const f = fixture([old], { [old]: content });
        f.dead(7);
        const scope: SessionClaimRecoveryScope = {
            runtimeInvocation: invocation("unix:///ambient-b.sock"),
            inspectContainer() { throw new Error("stale reset must not inspect or select a container"); },
            stopContainer() { throw new Error("stale reset must never stop a container"); },
        };
        expect(f.recover(scope)).toEqual([]);
        expect(f.removals).toEqual([`/claims/${old}`]);
        expect(f.cleanups).toEqual([]);
        expect(f.trace.at(-2)).toBe("list");
    });

    it.each(["missing", "unreadable", "device-changed", "runtime-changed", "pending", "own-start", "cleanup-disabled", "guardian-live", "guardian-unknown"] as const)(
        "resets a dead parent's record despite %s guardian history", history => {
        const f = fixture([old], { [old]: monitored(7) });
        f.dead(7);
        if (history !== "missing") {
            const snapshot = f.attach(old, history === "pending" ? { pending: { kind: "startup", generation, sequence: 2, containerId: null, cleanupEnabled: true } }
                : history === "own-start" ? { ownStarted: { generation, containerId: fullId } }
                : history === "cleanup-disabled" ? { lastAcknowledged: { generation, sequence: 1, containerId: fullId, cleanupEnabled: false } } : {});
            if (history === "guardian-live") f.alive(snapshot.observation.guardian.pid, "guardian-start");
            else if (history === "guardian-unknown") f.observations.set(snapshot.observation.guardian.pid, { status: "unknown" });
            else f.dead(snapshot.observation.guardian.pid);
        }
        let historicalReads = 0;
        f.ports.responsibility!.observationStore.read = () => { historicalReads++; throw new Error(`historical ${history}`); };
        expect(f.recover()).toEqual([]);
        expect(f.removals).toEqual([`/claims/${old}`]);
        expect(f.cleanups).toEqual([]);
        expect(historicalReads).toBe(0);
    });

    it.each(["active", "unknown", "present-without-token-proof", "malformed"] as const)("keeps a %s main record protective", state => {
        const f = fixture([old], { [old]: state === "malformed" ? '{"pid":7,"version":99}' : monitored(7) });
        if (state === "active") f.alive(7, "owner-start");
        if (state === "unknown") f.observations.set(7, { status: "unknown" });
        if (state === "present-without-token-proof") f.observations.set(7, { status: "present" });
        if (state === "malformed") f.dead(7);
        f.ports.responsibility!.observationStore.read = () => { throw new Error("old sidecar cannot prove process death"); };
        expect(f.recover()).toEqual([old]);
        expect(f.app.getActiveSessionsForContainer("project")).toEqual([old]);
        expect(f.removals).toEqual([]);
        expect(f.cleanups).toEqual([]);
    });

    it("never removes its own record or another profile while pruning dead peers", () => {
        const sibling = "project--p--work--a.lock";
        const f = fixture([current, old, sibling], { [current]: monitored(), [old]: monitored(7), [sibling]: monitored(8) });
        f.dead(42); f.dead(7); f.dead(8);
        expect(f.inGuard(() => f.app.reconcileForeignClaimsInHeldLifecycleLock("project", `/claims/${current}`))).toBe(false);
        expect(f.names).toEqual([current, sibling]);
        expect(f.removals).toEqual([`/claims/${old}`]);
        expect(f.cleanups).toEqual([]);
    });

    it("uses a reused PID's start token to retire the old generation without touching that process", () => {
        const f = fixture([old], { [old]: monitored(7) });
        f.alive(7, "new-process-generation");
        expect(f.recover()).toEqual([]);
        expect(f.removals).toEqual([`/claims/${old}`]);
        expect(f.cleanups).toEqual([]);
    });

    it.each(["recapture", "process-probe", "receipt-check"] as const)("preserves a same-byte replacement during %s", phase => {
        const f = fixture([old], { [old]: monitored(7) });
        f.dead(7);
        const before = f.receipts.get(old)!;
        const native = f.ports.responsibility!;
        if (phase === "recapture") {
            const capture = native.captureClaim; let count = 0;
            native.captureClaim = name => { if (++count === 2) f.install(old, monitored(7)); return capture(name); };
        } else if (phase === "process-probe") {
            const observe = f.ports.observeOwners; let count = 0;
            f.ports.observeOwners = pids => { if (++count === 2) f.install(old, monitored(7)); return observe(pids); };
        } else {
            const matches = native.matchesClaim;
            native.matchesClaim = receipt => { f.install(old, monitored(7)); return matches(receipt); };
        }
        expect(f.recover()).toEqual([old]);
        expect(f.receipts.get(old)?.inode).not.toBe(before.inode);
        expect(f.removals).toEqual([]);
        expect(f.cleanups).toEqual([]);
    });

    it.each(["active", "unknown"] as const)("rechecks parent liveness immediately before removal and preserves a newly %s owner", state => {
        const f = fixture([old], { [old]: monitored(7) });
        f.dead(7);
        const observe = f.ports.observeOwners; let count = 0;
        f.ports.observeOwners = pids => {
            if (++count === 2) {
                if (state === "active") f.alive(7, "owner-start");
                else f.observations.set(7, { status: "unknown" });
            }
            return observe(pids);
        };
        expect(f.recover()).toEqual([old]);
        expect(f.removals).toEqual([]);
    });

    it("uses the native stale-retirement hook with the fresh unchanged receipt", () => {
        const f = fixture([old], { [old]: monitored(7) });
        f.dead(7);
        const captured = f.receipts.get(old)!;
        const native = f.ports.responsibility!; const calls: SessionOwnershipReceipt[] = [];
        native.retireStaleClaim = receipt => {
            expect(f.isHeld()).toBe(true); expect(receipt).toBe(captured);
            calls.push(receipt); return native.retireClaim(receipt);
        };
        expect(f.recover()).toEqual([]);
        expect(calls).toEqual([captured]);
    });

    it("reports a real removal failure, rescans, and succeeds on a later retry without running old cleanup", () => {
        const f = fixture([old], { [old]: monitored(7) });
        f.dead(7);
        const native = f.ports.responsibility!; const retire = native.retireClaim;
        native.retireClaim = () => { throw new Error("sharing violation"); };
        const report = f.inGuard(() => f.app.reconcileSessionClaimsInHeldLifecycleLock("project"));
        expect(report.error?.message).toContain("stale session record removal failed");
        expect(report.claims).toEqual([old]);
        expect(() => f.app.recreateContainerWithoutInterruptingSessions("project", `/claims/${current}`, () => { throw new Error("must not recreate"); }))
            .toThrow(/session-cleanup-responsibility-incomplete/);
        native.retireClaim = retire;
        expect(f.recover()).toEqual([]);
        expect(f.cleanups).toEqual([]);
    });

    it("rescans current names after retirement instead of returning cached absence", () => {
        const f = fixture([old], { [old]: monitored(7) });
        f.dead(7);
        const native = f.ports.responsibility!; const retire = native.retireClaim;
        native.retireClaim = receipt => { retire(receipt); f.install(other, monitored(8)); f.alive(8, "owner-start"); return undefined; };
        expect(f.recover()).toEqual([other]);
        expect(f.names).toEqual([other]);
        expect(f.cleanups).toEqual([]);
    });

    it("accepts an already-removed exact record without converting it into a recovery failure", () => {
        const f = fixture([old], { [old]: monitored(7) });
        f.dead(7);
        const native = f.ports.responsibility!; const retire = native.retireClaim;
        native.retireClaim = receipt => { retire(receipt); throw new Error("already gone after removal"); };
        expect(f.recover()).toEqual([]);
        expect(f.cleanups).toEqual([]);
    });

    it("removes dead other-session vetoes before the current session's strict cleanup", () => {
        const f = fixture([current, old], { [current]: monitored(), [old]: monitored(7) });
        const own = f.attach(current);
        f.dead(7);
        const effects = policyCleanup(f);
        f.inGuard(() => f.ports.responsibility!.cleanup(own));
        expect(effects).toEqual(["cleanup", "devices", "stop"]);
        expect(f.removals).toEqual([`/claims/${old}`, `/claims/${current}`]);
        expect(f.names).toEqual([]);
    });

    it("does not treat stale guardian history as permission to alter the current live session's strict evidence", () => {
        const f = fixture([current, old], { [current]: monitored(), [old]: monitored(7) });
        const own = f.attach(current);
        f.alive(42, "owner-start"); f.dead(7);
        f.ports.responsibility!.observationStore.matches = () => false;
        const veto = f.inGuard(() => f.app.peerVetoesInHeldLifecycleLock("project", own.receipt.path, fullId, own.runtimeInvocation));
        expect(veto).toEqual({ sharedDeviceCleanupBlocked: true, exactContainerStopBlocked: true, responsibilityTransferred: false });
        expect(f.names).toEqual([current]);
        expect(f.removals).toEqual([`/claims/${old}`]);
    });
});

describe("current session responsibility remains strict", () => {
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
});

describe("obligation transfer retains a responsible successor", () => {
    it("transfers a local Docker obligation across PATH differences to the live true successor without changing either record", () => {
        const f = fixture([old, other], { [old]: monitored(7), [other]: monitored(8) });
        const source = f.attach(old, {}, windowsInvocation("C:\\first"));
        const target = f.attach(other, {}, windowsInvocation("C:\\second"));
        const before = JSON.stringify([source, target]);
        f.alive(8, "owner-start"); f.alive(target.observation.guardian.pid, "guardian-start");
        const effects = policyCleanup(f);
        f.inGuard(() => f.ports.responsibility!.cleanup(source));
        expect(effects).toEqual(["cleanup"]); expect(f.names).toEqual([other]);
        expect(f.snapshots.get(other)).toBe(target); expect(JSON.stringify([source, target])).toBe(before);
    });

    it("a local Docker authority match cannot transfer to a successor whose captured evidence no longer matches", () => {
        const f = fixture([old, other], { [old]: monitored(7), [other]: monitored(8) });
        const source = f.attach(old, {}, windowsInvocation("C:\\first"));
        const target = f.attach(other, {}, windowsInvocation("C:\\second"));
        f.alive(8, "owner-start"); f.alive(target.observation.guardian.pid, "guardian-start");
        const store = f.ports.responsibility!.observationStore, matches = store.matches;
        store.matches = snapshot => snapshot !== target && matches(snapshot);
        const veto = f.inGuard(() => f.app.peerVetoesInHeldLifecycleLock("project", source.receipt.path, fullId, source.runtimeInvocation));
        expect(veto).toEqual({sharedDeviceCleanupBlocked: true, exactContainerStopBlocked: true, responsibilityTransferred: false});
        expect(f.names).toEqual([old, other]); expect(f.removals).toEqual([]);
    });

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
    it.each(["endpoint", "executable", "tls", "config", "tcp-PATH", "tcp-proxy", "ssh-PATH", "ssh-helper", "podman-local-PATH", "podman-remote-PATH"] as const)(
        "live same-ID obligations with different %s authority cannot transfer cleanup", difference => {
        const f = fixture([old, other], { [old]: monitored(7), [other]: monitored(8) });
        let native = invocation();
        if (difference.startsWith("tcp-")) native = invocation("tcp://captured-engine:2376");
        if (difference.startsWith("ssh-")) native = invocation("ssh://engine.example");
        if (difference === "podman-local-PATH") native = { ...native, runtime: "podman", executable: "/captured/bin/podman",
            transport: { kind: "podman-local", graphRoot: "/captured/graph", runRoot: "/captured/run", storageDriver: "overlay", storageOptions: [], transientStore: false } };
        if (difference === "podman-remote-PATH") native = { ...native, runtime: "podman", executable: "/captured/bin/podman",
            transport: { kind: "podman-remote", url: "unix:///podman.sock", identityFile: null, machine: false,
                tls: { caFile: null, certFile: null, keyFile: null } } };
        let changed: NativeRuntimeInvocation = { ...native, selectors: { ...native.selectors, PATH: "/different/bin" } };
        if (difference === "endpoint") changed = invocation("unix:///different-authority.sock");
        if (difference === "executable") changed = { ...native, executable: "/different/bin/docker" };
        if (difference === "tls" && native.transport.kind === "docker") changed = { ...native,
            transport: { ...native.transport, tls: { ...native.transport.tls, enabled: true, verify: true, caFile: "/captured/ca.pem" } } };
        if (difference === "config" && native.transport.kind === "docker") changed = { ...native,
            transport: { ...native.transport, configDirectory: "/different/config" } };
        if (difference === "tcp-proxy") changed = { ...native, selectors: { ...native.selectors, HTTP_PROXY: "http://other-proxy:8080" } };
        if (difference === "ssh-helper") changed = { ...native, selectors: { ...native.selectors, DOCKER_SSH_COMMAND: "/different/ssh" } };
        const first = f.attach(old, {}, native), second = f.attach(other, {}, changed);
        for (const snapshot of [first, second]) { f.alive(snapshot.receipt.ownerPid, "owner-start"); f.alive(snapshot.observation.guardian.pid, "guardian-start"); }
        const veto = f.inGuard(() => f.app.peerVetoesInHeldLifecycleLock("project", first.receipt.path, fullId, first.runtimeInvocation));
        expect(veto).toEqual({ sharedDeviceCleanupBlocked: true, exactContainerStopBlocked: true, responsibilityTransferred: false });
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
});
