import { describe, expect, it } from "vitest";
import { createRemoteSync } from "../../application/remote-sync.js";
import type { RemoteSyncPorts } from "../../ports/remote-services.js";
import type { RemoteObservedSync, RemoteSyncBinding, RemoteSyncHandle, RemoteSyncInventory } from "../../domain/remote-services.js";

const evidence = Symbol("opaque sync diagnostic");
const binding: RemoteSyncBinding = { localPath: "/resolved/project", user: "user", host: "host", projectId: "project-id", containerId: "exact-id" };
const identifier = "sync_" + "a".repeat(43), name = "scoped-sync";
const handle: RemoteSyncHandle = { identifier, name, binding };
function observed(facts: Partial<RemoteObservedSync<symbol>> = {}): RemoteObservedSync<symbol> {
    return { kind: "observed", identifier, name, binding, paused: false, watching: true, failed: false, evidence, ...facts };
}
function known(sessions: RemoteObservedSync<symbol>[] = [observed()]): RemoteSyncInventory<symbol> { return { kind: "known", sessions, evidence }; }
function fixture() {
    const trace: unknown[][] = []; let clock = 0, inventory = known();
    const ports: RemoteSyncPorts<symbol> = {
        getMutagenSessionName: () => "legacy-sync", getProjectHash: () => "project-hash",
        getScopedMutagenSessionName: authority => { trace.push(["scope", authority]); return name; },
        startSyncDaemon: () => { trace.push(["daemon"]); },
        observeSyncInventory: remainingMs => { trace.push(["observe", remainingMs]); return inventory; },
        terminateSync: id => { trace.push(["terminate", id]); inventory = known([]); return { ok: true }; },
        resumeSync: id => { trace.push(["resume", id]); return { ok: true }; },
        withLifecycleLockAsync: async (_prefix, operation) => operation(),
        createSync: request => { trace.push(["create", request]); inventory = known([observed()]); return { ok: true }; },
        report: event => { trace.push(["report", event]); },
        fail: (kind, original) => { trace.push(["fail", kind, original]); throw Error(kind); },
        now: () => clock, sleep: async milliseconds => { trace.push(["sleep", milliseconds]); clock += milliseconds; },
    };
    return { ports, trace, setInventory: (value: RemoteSyncInventory<symbol>) => { inventory = value; }, setClock: (value: number) => { clock = value; }, sync: () => createRemoteSync(ports) };
}
function effects(trace: unknown[][]) { return trace.filter(row => ["create", "terminate", "resume", "pause"].includes(String(row[0]))); }

describe("remote sync authority policy", () => {
    it("creates only after known absence and returns uniquely observed exact authority", async () => {
        const f = fixture(); f.setInventory(known([]));
        expect(await f.sync().ensureSync(binding, "display-name")).toEqual(handle);
        expect(f.trace).toContainEqual(["create", { name, localPath: binding.localPath, config: { user: "user", host: "host", remotePath: "" }, containerId: "exact-id", projectId: "project-id" }]);
        expect(f.trace.filter(row => row[0] === "observe")).toHaveLength(2);
        expect(f.trace).toContainEqual(["report", { kind: "sync-creating", localPath: binding.localPath, containerDisplayName: "display-name", projectId: "project-id", host: "host" }]);
        expect(f.trace.findIndex(row => row[0] === "daemon")).toBeLessThan(f.trace.findIndex(row => row[0] === "create"));
    });
    it("reuses an exact binding and resumes only its identifier with paused priority", async () => {
        const f = fixture(); expect(await f.sync().ensureSync(binding)).toEqual(handle); expect(effects(f.trace)).toEqual([]);
        f.trace.length = 0; f.setInventory(known([observed({ paused: true, failed: true })]));
        expect(await f.sync().ensureSync(binding)).toEqual(handle); expect(effects(f.trace)).toEqual([["resume", identifier]]);
        f.trace.length = 0; const failed = observed({ watching: false, failed: true }); f.setInventory(known([failed]));
        expect(await f.sync().ensureSync(binding)).toEqual(handle); expect(f.trace).toContainEqual(["report", { kind: "sync-existing", observation: failed }]); expect(effects(f.trace)).toEqual([]);
    });
    it.each([
        ["unknown inventory", { kind: "unknown", evidence } as RemoteSyncInventory<symbol>, "sync-unknown"],
        ["legacy name", known([observed({ name: "legacy-sync" })]), "sync-conflict"],
        ["duplicate scoped names", known([observed(), observed({ identifier: "sync_" + "b".repeat(43) })]), "sync-conflict"],
        ["unqualified binding", known([observed({ binding: null })]), "sync-conflict"],
        ...["localPath", "user", "host", "projectId"].map(field => ["wrong " + field, known([observed({ binding: { ...binding, [field]: "other" } })]), "sync-conflict"] as const),
        ["same authority under another name", known([observed({ name: "another-writer" })]), "sync-conflict"],
    ] as const)("refuses %s without sync effects", async (_label, inventory, failure) => {
        const f = fixture(); f.setInventory(inventory);
        await expect(f.sync().ensureSync(binding)).rejects.toThrow(failure); expect(effects(f.trace)).toEqual([]); expect(f.trace).toContainEqual(["fail", failure, evidence]);
    });
    it("allows another host's qualified scoped session to coexist", async () => {
        const f = fixture(); f.setInventory(known([observed({ name: "another-host-scope", binding: { ...binding, host: "other" } })]));
        expect(await f.sync().ensureSync(binding)).toEqual(handle); expect(effects(f.trace).map(row => row[0])).toEqual(["create"]);
    });
    it("replaces only a changed container and reproves absence before create", async () => {
        const f = fixture(), oldId = "sync_" + "b".repeat(43);
        f.setInventory(known([observed({ identifier: oldId, binding: { ...binding, containerId: "old-container" }, paused: true })]));
        expect(await f.sync().ensureSync(binding)).toEqual(handle);
        expect(effects(f.trace).map(row => row[0])).toEqual(["terminate", "create"]); expect(f.trace).toContainEqual(["terminate", oldId]);
        expect(f.trace.slice(f.trace.findIndex(row => row[0] === "terminate") + 1, f.trace.findIndex(row => row[0] === "create")).some(row => row[0] === "observe")).toBe(true);
    });
    it.each(["failed", "unknown", "successor"] as const)("refuses creation when replacement leaves %s authority", async outcome => {
        const f = fixture(); f.setInventory(known([observed({ binding: { ...binding, containerId: "old-container" } })]));
        f.ports.terminateSync = id => { f.trace.push(["terminate", id]); f.setInventory(outcome === "unknown" ? { kind: "unknown", evidence } : known([observed({ identifier: "sync_" + "c".repeat(43) })])); return outcome === "failed" ? { ok: false, evidence } : { ok: true }; };
        await expect(f.sync().ensureSync(binding)).rejects.toThrow(outcome === "failed" ? "sync-terminate-failed" : outcome === "unknown" ? "sync-unknown" : "sync-conflict");
        expect(effects(f.trace)).toEqual([["terminate", identifier]]);
    });
    it.each([
        [known([]), "sync-missing"], [{ kind: "unknown", evidence } as RemoteSyncInventory<symbol>, "sync-unknown"],
        [known([observed({ binding: { ...binding, containerId: "other" } })]), "sync-conflict"],
        [known([observed(), observed({ identifier: "sync_" + "b".repeat(43) })]), "sync-conflict"],
    ] as const)("requires unique exact post-create proof without guessed compensation", async (postCreate, failure) => {
        const f = fixture(); f.setInventory(known([])); f.ports.createSync = request => { f.trace.push(["create", request]); f.setInventory(postCreate); return { ok: true }; };
        await expect(f.sync().ensureSync(binding)).rejects.toThrow(failure); expect(effects(f.trace).map(row => row[0])).toEqual(["create"]);
    });
    it("forwards checked resume/create failures with opaque evidence", async () => {
        const f = fixture(); f.setInventory(known([observed({ paused: true })])); f.ports.resumeSync = () => ({ ok: false, evidence });
        await expect(f.sync().ensureSync(binding)).rejects.toThrow("sync-resume-failed"); expect(f.trace).toContainEqual(["fail", "sync-resume-failed", evidence]);
        f.trace.length = 0; f.setInventory(known([])); f.ports.createSync = () => ({ ok: false, evidence });
        await expect(f.sync().ensureSync(binding)).rejects.toThrow("sync-create-failed"); expect(f.trace).toContainEqual(["fail", "sync-create-failed", evidence]);
    });
    it("preserves void daemon startup and exact thrown faults", async () => {
        const f = fixture(), fault = Error("daemon"); f.ports.startSyncDaemon = () => { throw fault; };
        await expect(f.sync().ensureSync(binding)).rejects.toBe(fault); expect(effects(f.trace)).toEqual([]);
    });
    it("distinguishes missing/unknown/conflict and never follows a captured identifier's successor", () => {
        const f = fixture(), sync = f.sync(); expect(sync.inspectSync(binding)).toEqual(observed());
        f.setInventory(known([])); expect(sync.inspectSync(binding)).toEqual({ kind: "missing" });
        f.setInventory({ kind: "unknown", evidence }); expect(sync.inspectSync(binding)).toEqual({ kind: "unknown", evidence });
        f.setInventory(known([observed({ binding: null })])); expect(sync.inspectSync(binding)).toEqual({ kind: "conflict", evidence });
        f.setInventory(known([observed({ identifier: "sync_" + "z".repeat(43) })])); expect(sync.observeCapturedSync(handle)).toEqual({ kind: "missing" });
        f.setInventory(known([observed({ binding: { ...binding, containerId: "changed" } })])); expect(sync.observeCapturedSync(handle)).toEqual({ kind: "conflict", evidence }); expect(effects(f.trace)).toEqual([]);
    });
    it("wait retains watching priority and opaque failure evidence", async () => {
        const f = fixture(); f.setInventory(known([observed({ paused: true, failed: true })])); await f.sync().waitForSync(handle);
        expect(f.trace).toContainEqual(["report", { kind: "sync-completed" }]); expect(f.trace.some(row => row[0] === "sleep" || row[0] === "fail")).toBe(false);
        f.trace.length = 0; f.setInventory(known([observed({ watching: false, failed: true })])); await expect(f.sync().waitForSync(handle)).rejects.toThrow("sync-failed"); expect(f.trace).toContainEqual(["fail", "sync-failed", evidence]);
    });
    it.each([
        [known([]), "sync-missing"], [{ kind: "unknown", evidence } as RemoteSyncInventory<symbol>, "sync-unknown"],
        [known([observed({ binding: null })]), "sync-conflict"], [known([observed({ identifier: "sync_" + "z".repeat(43) })]), "sync-missing"],
    ] as const)("wait refuses unavailable captured authority", async (inventory, failure) => {
        const f = fixture(); f.setInventory(inventory); await expect(f.sync().waitForSync(handle)).rejects.toThrow(failure);
        expect(f.trace).not.toContainEqual(["report", { kind: "sync-completed" }]); expect(effects(f.trace)).toEqual([]);
    });
    it("sleeps one second for progress and retains the default monotonic timeout", async () => {
        const f = fixture(); let count = 0; f.ports.observeSyncInventory = () => known([observed({ watching: ++count > 1 })]);
        await f.sync().waitForSync(handle); expect(f.trace.filter(row => row[0] === "sleep")).toEqual([["sleep", 1000]]);
        f.trace.length = 0; f.ports.observeSyncInventory = () => known([observed({ watching: false })]); let clock = 0;
        f.ports.now = () => clock; f.ports.sleep = async milliseconds => { f.trace.push(["sleep", milliseconds]); clock += 60_001; };
        await expect(f.sync().waitForSync(handle)).rejects.toThrow("sync-timeout"); expect(f.trace.filter(row => row[0] === "sleep")).toHaveLength(2);
    });
    it.each([0, -1, 0.5])("never queries with unusable %s ms budget", async timeout => {
        const f = fixture(); await expect(f.sync().waitForSync(handle, timeout)).rejects.toThrow("sync-timeout");
        expect(f.trace).toEqual([["report", { kind: "sync-waiting" }], ["report", { kind: "sync-timeout" }], ["fail", "sync-timeout", undefined]]);
    });
    it("passes remaining budget, clips final sleep, and never probes after expiry", async () => {
        const f = fixture(); let clock = 100, count = 0; f.setClock(clock);
        f.ports.observeSyncInventory = remaining => { f.trace.push(["observe", remaining]); clock += ++count === 3 ? 80 : 200; f.setClock(clock); return known([observed({ watching: false })]); };
        f.ports.sleep = async milliseconds => { f.trace.push(["sleep", milliseconds]); clock += milliseconds; f.setClock(clock); };
        await expect(f.sync().waitForSync(handle, 2500)).rejects.toThrow("sync-timeout");
        expect(f.trace.filter(row => row[0] === "observe")).toEqual([["observe", 2500], ["observe", 1300], ["observe", 100]]);
        expect(f.trace.filter(row => row[0] === "sleep")).toEqual([["sleep", 1000], ["sleep", 1000], ["sleep", 20]]); expect(clock).toBe(2600);
    });
    it("retains fractional admission and avoids a sub-millisecond query", async () => {
        const f = fixture(); f.ports.observeSyncInventory = remaining => { f.trace.push(["observe", remaining]); f.setClock(1); return known([observed({ watching: false })]); };
        await expect(f.sync().waitForSync(handle, 1.5)).rejects.toThrow("sync-timeout"); expect(f.trace.filter(row => row[0] === "observe")).toEqual([["observe", 1.5]]);
        expect(f.trace.filter(row => row[0] === "sleep").reduce((total, row) => total + Number(row[1]), 0)).toBeLessThanOrEqual(0.5);
    });
    it("does not sleep after progress reporting consumes the deadline", async () => {
        const f = fixture(); f.setInventory(known([observed({ watching: false })])); f.ports.report = event => { f.trace.push(["report", event]); if (event.kind === "sync-poll") f.setClock(200); };
        await expect(f.sync().waitForSync(handle, 200)).rejects.toThrow("sync-timeout"); expect(f.trace.some(row => row[0] === "sleep")).toBe(false);
    });
    it.each([200, 201])("rejects watching arriving at %s ms against a 200 ms deadline", async finishedAt => {
        const f = fixture(); f.ports.observeSyncInventory = () => { f.setClock(finishedAt); return known(); };
        await expect(f.sync().waitForSync(handle, 200)).rejects.toThrow("sync-timeout"); expect(f.trace).not.toContainEqual(["report", { kind: "sync-completed" }]);
    });
    it("accepts watching just before expiry with mixed failed facts", async () => {
        const f = fixture(); f.ports.observeSyncInventory = () => { f.setClock(199); return known([observed({ paused: true, failed: true })]); };
        await f.sync().waitForSync(handle, 200); expect(f.trace).toContainEqual(["report", { kind: "sync-completed" }]);
    });
    it.each([false, true])("retains late failure evidence when watching=%s", async watching => {
        const f = fixture(); f.ports.observeSyncInventory = () => { f.setClock(201); return known([observed({ watching, failed: true })]); };
        await expect(f.sync().waitForSync(handle, 200)).rejects.toThrow("sync-failed"); expect(f.trace).toContainEqual(["fail", "sync-failed", evidence]); expect(f.trace).not.toContainEqual(["report", { kind: "sync-timeout" }]);
    });
    it("retains late absence and thrown observation fault identities", async () => {
        const f = fixture(); f.ports.observeSyncInventory = () => { f.setClock(201); return known([]); };
        await expect(f.sync().waitForSync(handle, 200)).rejects.toThrow("sync-missing");
        f.setClock(0); f.trace.length = 0; const fault = Error("native observation failed"); f.ports.observeSyncInventory = () => { throw fault; };
        await expect(f.sync().waitForSync(handle, 200)).rejects.toBe(fault); expect(f.trace).toEqual([["report", { kind: "sync-waiting" }]]);
    });
});
