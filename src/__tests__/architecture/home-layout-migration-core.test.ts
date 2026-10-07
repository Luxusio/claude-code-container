import { describe, expect, it, vi } from "vitest";
import { createHomeLayoutMigration } from "../../application/home-layout-migration.js";
import type { ClipboardStartupSlot, HomeLayoutMigrationNotice, HomeLayoutMigrationPorts, ManagedHomeEntry } from "../../ports/home-layout-migration.js";

const entries: ManagedHomeEntry[] = ["clipboard.port", "claude", "claude.json", "codex", "locks", "clipboard-files", "bin"];
const slots: ClipboardStartupSlot[] = ["legacy", "run"].flatMap(namespace =>
    ["clipboard.starting", "clipboard.starting.v2"].map(name => ({ namespace, name }) as ClipboardStartupSlot));
const slotKey = (slot: ClipboardStartupSlot) => `${slot.namespace}/${slot.name}`;
type FixturePorts = { -readonly [K in keyof HomeLayoutMigrationPorts<unknown>]: HomeLayoutMigrationPorts<unknown>[K] };
function caught(run: () => unknown): unknown {
    try { run(); } catch (error) { return error; }
    throw new Error("Expected exception");
}

// This fixture supplies every observation and effect explicitly; the core never
// discovers a native home, filesystem, clock, or process through it.
function fixture(legacy: ManagedHomeEntry[] = ["codex"]) {
    const calls: string[] = [];
    const notices: HomeLayoutMigrationNotice[] = [];
    const reported = new Set<string>();
    const legacyEntries = new Set(legacy);
    const targets = new Set<ManagedHomeEntry>();
    const receipts: unknown[] = [];
    const config: Record<string, unknown> = {};
    const remote = new Map<string, string>();
    let receiptIndex = 0;
    const ports: FixturePorts = {
        homeExists: () => true,
        readReportedConflicts: () => reported,
        defaultProfileExists: () => false,
        defaultProfileMarkerExists: () => false,
        profileNameExists: () => false,
        legacyEntryExists: entry => legacyEntries.has(entry),
        targetEntryExists: entry => targets.has(entry),
        startupSlotExists: () => false,
        clipboardPortIsRegular: () => true,
        listLegacyRemoteNames: () => [...remote.keys()],
        legacyRemoteDirectoryIsEmpty: () => false,
        remoteEntryKey: name => `native-remote/${name}`,
        readLegacyRemoteText: name => remote.get(name)!,
        acquireMigrationLock: () => true,
        releaseMigrationLock: () => undefined,
        ensureRuntimeDirectory: () => undefined,
        claimStartupSlot: () => receipts[receiptIndex++],
        releaseStartupReceipt: () => undefined,
        renameDefaultProfile: () => undefined,
        ensureDefaultProfileDirectory: () => undefined,
        moveEntry: entry => { legacyEntries.delete(entry); targets.add(entry); return undefined; },
        updateConfig: mutate => { expect(mutate(config)).toBeUndefined(); return undefined; },
        removeLegacyRemoteFile: name => { remote.delete(name); return undefined; },
        removeEmptyLegacyRemoteDirectory: () => undefined,
        recordReportedConflicts: () => undefined,
        hasLiveSessions: () => false,
        hasContainerMounts: () => false,
        currentTime: () => 1234,
        report: notice => { notices.push(notice); return undefined; },
    };
    for (const key of Object.keys(ports) as (keyof typeof ports)[]) {
        const original = ports[key] as (...args: unknown[]) => unknown;
        Object.defineProperty(ports, key, { configurable: true, writable: true, value: vi.fn((...args: unknown[]) => {
            const arg = args[0];
            calls.push(`${key}${typeof arg === "string" || typeof arg === "number" ? `:${arg}` : key === "startupSlotExists" || key === "claimStartupSlot" ? `:${slotKey(arg as ClipboardStartupSlot)}` : ""}`);
            return original(...args);
        }) });
    }
    return { ports, calls, notices, reported, legacyEntries, targets, receipts, config, remote,
        run: () => createHomeLayoutMigration(ports)() };
}

describe("home layout migration explicit application ports", () => {
    it("validates every exact callable capability without invoking effects", () => {
        const f = fixture();
        expect(Object.keys(f.ports)).toHaveLength(29);
        expect(typeof createHomeLayoutMigration(f.ports)).toBe("function");
        expect(f.calls).toEqual([]);
        for (const key of Object.keys(f.ports)) for (const invalid of [undefined, false, {}]) {
            expect(() => createHomeLayoutMigration({ ...f.ports, [key]: invalid } as unknown as HomeLayoutMigrationPorts<unknown>)).toThrow();
        }
        expect(f.calls).toEqual([]);
    });
    it("short circuits home absence and fully reported pending conflicts without clock or callbacks", () => {
        const missing = fixture(); missing.ports.homeExists = () => false;
        expect(missing.run()).toEqual({ status: "not-needed" });
        expect(missing.calls).toEqual([]);
        const f = fixture(["codex"]); f.targets.add("codex"); f.reported.add("codex");
        f.remote.set("bad.json", "invalid"); f.reported.add("native-remote/bad.json");
        expect(f.run()).toEqual({ status: "not-needed" });
        expect(f.calls).not.toContain("currentTime");
        expect(f.calls).not.toContain("hasLiveSessions");
        expect(f.calls).toContain("legacyRemoteDirectoryIsEmpty");
    });
    it.each(["empty-directory", "legacy-startup", "json"])("recognizes pending %s independently of moved entries", reason => {
        const f = fixture([]);
        if (reason === "empty-directory") f.ports.legacyRemoteDirectoryIsEmpty = () => true;
        if (reason === "legacy-startup") f.ports.startupSlotExists = slot => slot.namespace === "legacy";
        if (reason === "json") f.remote.set("only.json", "null");
        expect(f.run().status).toBe(reason === "legacy-startup" ? "busy" : "migrated");
        expect(f.calls).toContain("currentTime");
    });
    it("filters .json itself in both pending and merge listing", () => {
        const f = fixture([]); f.remote.set("ignored.JSON", "not json"); f.remote.set("ignored.txt", "not json");
        expect(f.run()).toEqual({ status: "not-needed" });
        expect(f.ports.readLegacyRemoteText).not.toHaveBeenCalled();
        f.remote.set("kept.json", "42");
        expect(f.run()).toEqual({ status: "migrated", moved: ["native-remote/kept.json"], failed: [] });
        expect(f.ports.readLegacyRemoteText).toHaveBeenCalledExactlyOnceWith("kept.json");
        expect([...f.remote.keys()]).toEqual(["ignored.JSON", "ignored.txt"]);
    });
    it("orders claim, preflight, profile, clipboard-first moves, remote and acquisition-order finally", () => {
        const f = fixture(entries); f.receipts.push(0, false, null, undefined); f.remote.set("a.json", "{} ");
        expect(f.run()).toEqual({ status: "migrated", moved: [...entries, "native-remote/a.json"], failed: [] });
        const effectCalls = f.calls.filter(call => /^(currentTime|acquireMigrationLock|hasLiveSessions|hasContainerMounts|ensureRuntimeDirectory|claimStartupSlot|ensureDefaultProfileDirectory|moveEntry|updateConfig|removeLegacyRemoteFile|removeEmptyLegacyRemoteDirectory|releaseStartupReceipt|releaseMigrationLock)/.test(call));
        expect(effectCalls).toEqual(["currentTime", "acquireMigrationLock:1234", "hasLiveSessions", "hasContainerMounts", "ensureRuntimeDirectory",
            ...slots.map(slot => `claimStartupSlot:${slotKey(slot)}`), "ensureDefaultProfileDirectory",
            ...entries.map(entry => `moveEntry:${entry}`), "updateConfig", "removeLegacyRemoteFile:a.json", "removeEmptyLegacyRemoteDirectory",
            "releaseStartupReceipt:0", "releaseStartupReceipt", "releaseStartupReceipt", "releaseStartupReceipt", "releaseMigrationLock"]);
        expect(vi.mocked(f.ports.releaseStartupReceipt).mock.calls).toEqual([[0], [false], [null], [undefined]]);
        expect(vi.mocked(f.ports.startupSlotExists).mock.calls).toEqual(slots.map(slot => [slot]));
        expect(f.ports.clipboardPortIsRegular).toHaveBeenCalledExactlyOnceWith("legacy");
        const mkdir = f.calls.indexOf("ensureRuntimeDirectory");
        expect(f.calls.indexOf("clipboardPortIsRegular:legacy")).toBeLessThan(mkdir);
    });
    it("checks an unmarked default again after claim and advances colliding reserved suffixes", () => {
        const f = fixture(["claude"]); f.ports.defaultProfileExists = vi.fn(() => true);
        f.ports.defaultProfileMarkerExists = vi.fn(() => false);
        f.ports.profileNameExists = vi.fn(name => name === "default-pre-layout" || name === "default-pre-layout-2");
        expect(f.run()).toEqual({ status: "migrated", moved: ["claude"], failed: [] });
        expect(f.ports.defaultProfileExists).toHaveBeenCalledTimes(2);
        expect(f.ports.defaultProfileMarkerExists).toHaveBeenCalledTimes(2);
        expect(vi.mocked(f.ports.profileNameExists).mock.calls).toEqual([["default-pre-layout"], ["default-pre-layout-2"], ["default-pre-layout-3"]]);
        expect(f.ports.renameDefaultProfile).toHaveBeenCalledExactlyOnceWith("default-pre-layout-3");
        expect(f.notices).toEqual([{ kind: "default-profile-renamed", name: "default-pre-layout-3" }]);
    });
    it.each(["marked", "no-credentials"])("does not rename a default with %s", reason => {
        const f = fixture(reason === "marked" ? ["codex"] : ["locks"]);
        f.ports.defaultProfileExists = () => true; f.ports.defaultProfileMarkerExists = () => reason === "marked";
        f.run(); expect(f.ports.renameDefaultProfile).not.toHaveBeenCalled();
    });
    it.each(["lock", "sessions", "mounts", "slot", "conflict", "unsafe-legacy", "unsafe-run"])("stops at %s without acquiring startup receipts", reason => {
        const f = fixture(["clipboard.port", "codex"]);
        if (reason === "lock") f.ports.acquireMigrationLock = () => false;
        if (reason === "sessions") f.ports.hasLiveSessions = () => true;
        if (reason === "mounts") f.ports.hasContainerMounts = () => true;
        if (reason === "slot") f.ports.startupSlotExists = slot => slot.namespace === "run" && slot.name === "clipboard.starting";
        if (reason === "conflict") f.targets.add("clipboard.port");
        if (reason === "unsafe-legacy") f.ports.clipboardPortIsRegular = () => false;
        if (reason === "unsafe-run") { f.legacyEntries.delete("clipboard.port"); f.targets.add("clipboard.port"); f.ports.clipboardPortIsRegular = () => false; }
        expect(f.run()).toEqual({ status: reason === "sessions" ? "sessions-active" : reason === "mounts" ? "mounts-active" : "busy" });
        expect(f.ports.claimStartupSlot).not.toHaveBeenCalled(); expect(f.ports.moveEntry).not.toHaveBeenCalled();
        expect(f.ports.releaseMigrationLock).toHaveBeenCalledTimes(reason === "lock" ? 0 : 1);
    });
    it.each([0, 1, 2, 3])("releases only earlier opaque receipts after startup claim %s throws", phase => {
        const f = fixture(); const tokens = [Symbol("first"), { opaque: true }, false, "receipt"];
        f.ports.claimStartupSlot = vi.fn(() => { const i = vi.mocked(f.ports.claimStartupSlot).mock.calls.length - 1; if (i === phase) throw { claim: phase }; return tokens[i]; });
        expect(f.run()).toEqual({ status: "busy" });
        expect(vi.mocked(f.ports.releaseStartupReceipt).mock.calls).toEqual(tokens.slice(0, phase).map(token => [token]));
        expect(f.ports.ensureDefaultProfileDirectory).not.toHaveBeenCalled(); expect(f.ports.releaseMigrationLock).toHaveBeenCalledOnce();
    });
    it("aborts after clipboard move failure but continues other move failures with original unknown diagnostics", () => {
        const clipboard = fixture(entries); clipboard.ports.moveEntry = vi.fn(() => { throw null; });
        expect(clipboard.run()).toEqual({ status: "migrated", moved: [], failed: ["clipboard.port"] });
        expect(clipboard.notices).toEqual([{ kind: "clipboard-move-failed" }]);
        expect(clipboard.ports.moveEntry).toHaveBeenCalledOnce(); expect(clipboard.ports.updateConfig).not.toHaveBeenCalled();
        const f = fixture(["claude", "codex", "bin"]); const failure = Symbol("rename");
        f.ports.moveEntry = vi.fn(entry => { if (entry === "codex") throw failure; return undefined; });
        expect(f.run()).toEqual({ status: "migrated", moved: ["claude", "bin"], failed: ["codex"] });
        expect(f.notices).toEqual([{ kind: "entry-move-failed", entry: "codex", error: failure }]);
    });
    it("keeps destinations and adds conflict keys only after a successful report, persisting once in finally", () => {
        const f = fixture(["codex", "bin"]); f.targets.add("codex"); f.targets.add("bin"); f.reported.add("bin");
        expect(f.run()).toEqual({ status: "migrated", moved: [], failed: [] });
        expect(f.notices).toEqual([{ kind: "entry-conflict", entry: "codex" }]);
        expect(f.ports.moveEntry).not.toHaveBeenCalled(); expect(f.reported).toEqual(new Set(["bin", "codex"]));
        expect(f.calls.slice(-6)).toEqual(["releaseStartupReceipt", "releaseStartupReceipt", "releaseStartupReceipt", "releaseStartupReceipt", "recordReportedConflicts", "releaseMigrationLock"]);
        const thrown = fixture(["codex"]); thrown.targets.add("codex"); const failure = { warn: true };
        thrown.ports.report = () => { throw failure; };
        expect(caught(thrown.run)).toBe(failure); expect(thrown.reported.size).toBe(0);
        expect(thrown.ports.recordReportedConflicts).not.toHaveBeenCalled(); expect(thrown.ports.releaseMigrationLock).toHaveBeenCalledOnce();
    });
    it("accepts primitive and array JSON while preserving existing and inherited remote keys", () => {
        const f = fixture([]);
        for (const [name, text] of [["a", "null"], ["b", "false"], ["c", "3"], ["d", '"text"'], ["e", "[1,2]"], ["existing", "99"], ["inherited", "99"], ["toString", "99"], ["__proto__", '{"hidden":true}']]) f.remote.set(`${name}.json`, text);
        const remote = Object.assign(Object.create({ inherited: "prototype" }) as Record<string, unknown>, { existing: "current" });
        f.config.remote = remote;
        const result = f.run();
        expect(result).toEqual({ status: "migrated", moved: [...["a", "b", "c", "d", "e", "existing", "inherited", "toString", "__proto__"].map(name => `native-remote/${name}.json`)], failed: [] });
        expect(f.config.remote).toBe(remote);
        expect(Object.entries(remote)).toEqual([["existing", "current"], ["a", null], ["b", false], ["c", 3], ["d", "text"], ["e", [1, 2]]]);
        expect(remote.inherited).toBe("prototype"); expect(Object.hasOwn(remote, "toString")).toBe(false); expect(Object.hasOwn(remote, "hidden")).toBe(false);
    });
    it("retains repeated config.remote getter reads and their original mutation selection", () => {
        const f = fixture([]); f.remote.set("a.json", "1");
        const reads: string[] = []; const remote = {};
        Object.defineProperty(f.config, "remote", { configurable: true,
            get: () => { reads.push("get"); return remote; }, set: value => { reads.push("set"); expect(value).toBe(remote); } });
        expect(f.run().status).toBe("migrated"); expect(reads).toEqual(["get", "get", "get", "get", "set"]); expect(remote).toEqual({ a: 1 });
    });
    it("publishes once before ordered unlink; later unlink failure keeps earlier deletions without partial remote moved names", () => {
        const f = fixture([]); f.remote.set("first.json", "1"); f.remote.set("later.json", "2"); const failure = { unlink: true };
        f.ports.removeLegacyRemoteFile = vi.fn(name => { expect(f.config.remote).toEqual({ first: 1, later: 2 }); if (name === "later.json") throw failure; f.remote.delete(name); return undefined; });
        expect(f.run()).toEqual({ status: "migrated", moved: [], failed: ["remote"] });
        expect([...f.remote.keys()]).toEqual(["later.json"]);
        expect(vi.mocked(f.ports.removeLegacyRemoteFile).mock.calls).toEqual([["first.json"], ["later.json"]]);
        expect(f.notices).toEqual([{ kind: "remote-merge-failed", error: failure }]); expect(f.ports.removeEmptyLegacyRemoteDirectory).not.toHaveBeenCalled();
    });
    it("keeps all parsed sources when publishing fails and reports invalid JSON only once", () => {
        const f = fixture([]); f.remote.set("bad.json", "{"); f.remote.set("good.json", "1"); const failure = { publish: true };
        f.ports.updateConfig = () => { throw failure; };
        expect(f.run()).toEqual({ status: "migrated", moved: [], failed: ["remote"] });
        expect(f.notices).toEqual([{ kind: "invalid-remote", name: "bad.json" }, { kind: "remote-merge-failed", error: failure }]);
        expect(f.ports.removeLegacyRemoteFile).not.toHaveBeenCalled(); expect([...f.remote.keys()]).toEqual(["bad.json", "good.json"]);
        f.run(); expect(f.notices.filter(notice => notice.kind === "invalid-remote")).toHaveLength(1);
    });
    it.each(["hasLiveSessions", "hasContainerMounts", "ensureRuntimeDirectory"] as const)("preserves thrown value from %s and always releases the migration lock", key => {
        for (const failure of [null, Symbol(key), { phase: key }]) { const f = fixture(); f.ports[key] = () => { throw failure; };
            expect(caught(f.run)).toBe(failure); expect(f.ports.releaseMigrationLock).toHaveBeenCalledOnce(); expect(f.ports.claimStartupSlot).not.toHaveBeenCalled(); }
    });
    it("routes rename notice failure through profile preparation catch and allows its second warning to escape", () => {
        const f = fixture(["claude"]); f.ports.defaultProfileExists = () => true;
        const first = { first: true }; const second = Symbol("second"); const observed: HomeLayoutMigrationNotice[] = [];
        f.ports.report = notice => { observed.push(notice); if (notice.kind === "default-profile-renamed") throw first; throw second; };
        expect(caught(f.run)).toBe(second);
        expect(observed).toEqual([{ kind: "default-profile-renamed", name: "default-pre-layout" }, { kind: "profile-prepare-failed", error: first }]);
        expect(f.ports.ensureDefaultProfileDirectory).not.toHaveBeenCalled(); expect(f.ports.moveEntry).not.toHaveBeenCalled(); expect(f.ports.releaseStartupReceipt).toHaveBeenCalledTimes(4);
    });
    it("routes invalid-file warning failure to outer remote catch before any conflict key is added", () => {
        const f = fixture([]); f.remote.set("bad.json", "{"); const first = { invalid: true }; const second = { remote: true }; const notices: HomeLayoutMigrationNotice[] = [];
        f.ports.report = notice => { notices.push(notice); throw notice.kind === "invalid-remote" ? first : second; };
        expect(caught(f.run)).toBe(second); expect(notices).toEqual([{ kind: "invalid-remote", name: "bad.json" }, { kind: "remote-merge-failed", error: first }]);
        expect(f.reported.size).toBe(0); expect(f.ports.recordReportedConflicts).not.toHaveBeenCalled(); expect(f.ports.releaseMigrationLock).toHaveBeenCalledOnce();
    });
    it("does not read diagnostic error operands in the application", () => {
        const f = fixture(["codex"]); const failure = {};
        Object.defineProperties(failure, { code: { get() { throw new Error("application read code"); } }, message: { get() { throw new Error("application read message"); } } });
        f.ports.moveEntry = () => { throw failure; }; f.remote.set("a.json", "1"); f.ports.updateConfig = () => { throw failure; };
        expect(f.run()).toEqual({ status: "migrated", moved: [], failed: ["codex", "remote"] });
        expect(f.notices).toEqual([{ kind: "entry-move-failed", entry: "codex", error: failure }, { kind: "remote-merge-failed", error: failure }]);
    });
    it("relays opaque receipt objects without inspecting native identity or then fields", () => {
        const f = fixture(); const receipt = {};
        for (const name of ["dev", "ino", "path", "then"]) Object.defineProperty(receipt, name, { get() { throw new Error(`Unexpected receipt inspection: ${name}`); } });
        f.receipts.push(receipt, receipt, receipt, receipt);
        expect(f.run().status).toBe("migrated");
        for (const [released] of vi.mocked(f.ports.releaseStartupReceipt).mock.calls) expect(released).toBe(receipt);
    });
    it.each(["homeExists", "readReportedConflicts", "defaultProfileExists", "legacyEntryExists", "currentTime", "acquireMigrationLock"] as const)("keeps pre-acquisition %s exceptions outside finally", key => {
        const f = fixture(); const failure = { key }; f.ports[key] = () => { throw failure; };
        expect(caught(f.run)).toBe(failure); expect(f.ports.releaseMigrationLock).not.toHaveBeenCalled(); expect(f.ports.claimStartupSlot).not.toHaveBeenCalled();
    });
    it.each(["clipboard.port", "codex"] as const)("allows %s move warning exceptions to escape after all receipts release", entry => {
        const f = fixture([entry]); const failure = { warning: entry }; f.ports.moveEntry = () => { throw { move: true }; };
        f.ports.report = () => { throw failure; };
        expect(caught(f.run)).toBe(failure); expect(f.ports.releaseStartupReceipt).toHaveBeenCalledTimes(4); expect(f.ports.releaseMigrationLock).toHaveBeenCalledOnce();
        expect(f.ports.removeEmptyLegacyRemoteDirectory).not.toHaveBeenCalled();
    });
    it("catches remote config getter failures in the outer remote catch while preserving their unknown identity", () => {
        const f = fixture([]); f.remote.set("a.json", "1"); const failure = Symbol("getter");
        Object.defineProperty(f.config, "remote", { get() { throw failure; } });
        expect(f.run()).toEqual({ status: "migrated", moved: [], failed: ["remote"] });
        expect(f.notices).toEqual([{ kind: "remote-merge-failed", error: failure }]); expect(f.ports.removeLegacyRemoteFile).not.toHaveBeenCalled();
    });
    it("contains per-file read failures in the parse catch and still publishes other files", () => {
        const f = fixture([]); f.remote.set("bad.json", "1"); f.remote.set("good.json", "2");
        f.ports.readLegacyRemoteText = name => { if (name === "bad.json") throw null; return f.remote.get(name)!; };
        expect(f.run()).toEqual({ status: "migrated", moved: ["native-remote/good.json"], failed: [] });
        expect(f.notices).toEqual([{ kind: "invalid-remote", name: "bad.json" }]); expect(f.config.remote).toEqual({ good: 2 });
        expect([...f.remote.keys()]).toEqual(["bad.json"]);
    });
});
