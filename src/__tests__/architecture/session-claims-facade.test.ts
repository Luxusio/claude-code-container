import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const effects = vi.hoisted(() => ({
    directory: "", mkdir: vi.fn(), stat: vi.fn(), chmod: vi.fn(), list: vi.fn(),
    read: vi.fn(), write: vi.fn(), unlink: vi.fn(), exists: vi.fn(), random: vi.fn(),
    token: vi.fn(), observe: vi.fn(), classify: vi.fn(), lock: vi.fn(), cleanup: vi.fn(), spawn: vi.fn(),
}));
vi.mock("fs", async original => ({ ...await original<typeof import("node:fs")>(),
    mkdirSync: effects.mkdir, lstatSync: effects.stat, chmodSync: effects.chmod,
    readdirSync: effects.list, readFileSync: effects.read, writeFileSync: effects.write,
    unlinkSync: effects.unlink, existsSync: effects.exists,
}));
vi.mock("crypto", async original => ({ ...await original<typeof import("node:crypto")>(), randomBytes: effects.random }));
vi.mock("child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawnSync: effects.spawn }));
vi.mock("../../home-layout.js", () => ({ locksDir: () => effects.directory }));
vi.mock("../../utils.js", () => ({ getProjectId: () => "project" }));
vi.mock("../../container-runtime.js", () => ({ runtimeCli: () => "fixture-runtime" }));
vi.mock("../../device-lab-admin.js", () => ({ cleanupOwnerDevices: effects.cleanup }));
vi.mock("../../session-lock-liveness.js", async original => ({
    ...await original<typeof import("../../session-lock-liveness.js")>(),
    processStartToken: effects.token, observeProcessStarts: effects.observe, sessionLockLiveness: effects.classify,
}));
vi.mock("@ccc/device-lab/device-lab-shared-state.js", () => ({
    withSharedMutationLock: effects.lock, withSharedMutationLockAsync: effects.lock,
}));
const session = await import("../../session.js");
const { createSessionClaimsStore } = await import("../../adapters/session-claims-store.js");
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const id = "a".repeat(32);
const realDirectory = { isDirectory: () => true, isSymbolicLink: () => false };

describe("session claims compatibility facade", () => {
    beforeEach(() => {
        vi.resetAllMocks(); session.clearSession();
        Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
        effects.directory = join("fixture-home", "locks");
        effects.stat.mockReturnValue(realDirectory); effects.list.mockReturnValue([]);
        effects.random.mockReturnValue(Buffer.from(id, "hex")); effects.token.mockReturnValue("opaque-start");
        effects.observe.mockReturnValue(new Map()); effects.classify.mockReturnValue("active");
        effects.lock.mockImplementation((_path, operation) => operation());
    });
    afterEach(() => { session.clearSession(); Object.defineProperty(process, "platform", platform); vi.restoreAllMocks(); });

    it("preserves public exports and the deprecated container query alias", () => {
        expect(Object.keys(session).sort()).toEqual([
            "acquireHostSessionOwnership", "armSessionOwnership", "confirmSessionOwnership",
            "cleanupSession", "clearSession", "createSessionLock", "getActiveSessionsForContainer",
            "getActiveSessionsForProject", "getActiveSessionsForProjectFamily", "getCurrentSession",
            "observeActiveSessionsForContainer",
            "getSessionLockClaimsForContainer", "getSessionLockClaimsForProjectFamily", "hasOtherActiveSessions",
            "hasOtherSessionClaims", "recreateContainerWithoutInterruptingSessions", "removeSessionLock",
            "setSession", "setSessionContainerId", "setSessionCleanupEnabled", "setupSignalHandlers", "withContainerLifecycleLock",
            "withContainerLifecycleLockAsync", "withContainerSetupLockAsync", "withProjectFamilyLifecycleLock",
            "withProjectFamilyLifecycleLockAsync",
        ].sort());
        effects.list.mockReturnValue(["project-legacy.lock", "project--current.lock", "project--p--work--other.lock"]);
        effects.read.mockReturnValue("123");
        expect(session.getActiveSessionsForProject("project")).toEqual(session.getActiveSessionsForContainer("project"));
    });

    it.each(["opaque-start", null])("writes exact reservation bytes and exclusive permissions for token %s", token => {
        effects.token.mockReturnValue(token);
        const expected = join(effects.directory, `project--p--work--${id}.lock`);
        expect(session.createSessionLock("project", "work")).toBe(expected);
        expect(effects.random).toHaveBeenCalledExactlyOnceWith(16);
        expect(effects.lock).toHaveBeenCalledExactlyOnceWith(join(effects.directory, "project--p--work.container-lifecycle.guard"), expect.any(Function), { waitMs: 180000 });
        expect(effects.token).toHaveBeenCalledExactlyOnceWith(process.pid);
        expect(effects.write).toHaveBeenCalledExactlyOnceWith(expected,
            token ? `{"version":2,"pid":${process.pid},"startToken":"opaque-start"}` : String(process.pid),
            { mode: 0o600, flag: "wx" });
        expect(effects.mkdir).toHaveBeenCalledTimes(3);
        expect(effects.random.mock.invocationCallOrder[0]).toBeLessThan(effects.lock.mock.invocationCallOrder[0]!);
    });

    it("resolves changed directory, platform and start observations at invocation; captures the reservation path before locking", () => {
        effects.directory = join("second-home", "locks");
        Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
        effects.token.mockReturnValue("changed");
        const captured = join(effects.directory, `project--${id}.lock`);
        effects.lock.mockImplementation((_path, operation) => { effects.directory = join("third-home", "locks"); return operation(); });
        expect(session.createSessionLock("project")).toBe(captured);
        expect(effects.write).toHaveBeenCalledWith(captured, JSON.stringify({ version: 2, pid: process.pid, startToken: "changed" }), { mode: 0o600, flag: "wx" });
        expect(effects.chmod).not.toHaveBeenCalled();
        expect(session.getSessionLockClaimsForContainer("project")).toEqual([]);
        expect(effects.list).toHaveBeenLastCalledWith(join("third-home", "locks"));
    });

    it("reconciles foreign ownership but keeps unreadable claims as a fresh raw cleanup veto", () => {
        const current = join(effects.directory, "project--current.lock");
        session.setSession(current, "/fixture/project"); session.setSessionContainerId("captured-container");
        effects.list.mockReturnValue(["project--current.lock", "project--foreign.lock"]);
        effects.exists.mockReturnValue(true);
        effects.read.mockImplementation(() => { throw new Error("unreadable foreign record"); });
        session.cleanupSession();
        expect(effects.unlink).toHaveBeenCalledExactlyOnceWith(current);
        expect(effects.read).toHaveBeenCalledWith(join(effects.directory, "project--foreign.lock"), "utf-8");
        expect(effects.classify).not.toHaveBeenCalled(); expect(effects.cleanup).not.toHaveBeenCalled();
        expect(effects.spawn).not.toHaveBeenCalled();
        expect(session.getCurrentSession()).toEqual({ lockFile: null, projectPath: null, profile: undefined, toolName: "claude" });
    });

    it("keeps public raw claims and raw veto queries free of liveness inference", () => {
        effects.list.mockReturnValue(["project--current.lock", "project--foreign.lock"]);
        const current = join(effects.directory, "project--current.lock");
        expect(session.hasOtherSessionClaims("project", current)).toBe(true);
        expect(session.getSessionLockClaimsForContainer("project")).toEqual(["project--current.lock", "project--foreign.lock"]);
        expect(session.getSessionLockClaimsForProjectFamily("project")).toEqual(["project--current.lock", "project--foreign.lock"]);
        for (const effect of [effects.read, effects.observe, effects.classify, effects.unlink]) expect(effect).not.toHaveBeenCalled();
    });

    it.each(["live", "unknown", "unreadable"])("preserves %s prestart reservations before exclusive new reservation", mode => {
        const foreign = join(effects.directory, "project--foreign.lock");
        effects.list.mockReturnValue(["project--foreign.lock", "project--p--other--stale.lock"]);
        effects.classify.mockReturnValue(mode === "live" ? "active" : "unknown");
        effects.read.mockImplementation(() => { if (mode === "unreadable") throw new Error("denied"); return "123"; });
        expect(session.createSessionLock("project")).toBe(join(effects.directory, `project--${id}.lock`));
        expect(effects.read).toHaveBeenCalledWith(foreign, "utf-8");
        expect(effects.read).not.toHaveBeenCalledWith(join(effects.directory, "project--p--other--stale.lock"), "utf-8");
        expect(effects.unlink).not.toHaveBeenCalled(); expect(effects.write).toHaveBeenCalledTimes(1);
        expect(effects.spawn).not.toHaveBeenCalled();
    });

    it("uses the path captured before classification even when home resolution changes", () => {
        const before = effects.directory;
        effects.list.mockReturnValue(["project--stale.lock"]); effects.read.mockReturnValue("123");
        effects.classify.mockImplementation(() => { effects.directory = join("other-home", "locks"); return "stale"; });
        expect(session.getActiveSessionsForContainer("project")).toEqual([]);
        expect(effects.unlink).toHaveBeenCalledExactlyOnceWith(join(before, "project--stale.lock"));
    });

    it("propagates exclusive-write collision and failed enumeration rather than authorizing replacement", () => {
        const collision = Object.assign(new Error("collision"), { code: "EEXIST" });
        effects.write.mockImplementation(() => { throw collision; });
        expect(() => session.createSessionLock("project")).toThrow(collision);
        const missing = Object.assign(new Error("concurrent removal"), { code: "ENOENT" });
        effects.list.mockImplementation(() => { throw missing; });
        const recreate = vi.fn();
        expect(() => session.recreateContainerWithoutInterruptingSessions("project", "current.lock", recreate)).toThrow(missing);
        expect(recreate).not.toHaveBeenCalled();
    });
});

describe("session claim filesystem adapter boundaries", () => {
    beforeEach(() => { vi.resetAllMocks(); effects.stat.mockReturnValue(realDirectory); });
    it.each([
        { isDirectory: () => false, isSymbolicLink: () => false },
        { isDirectory: () => true, isSymbolicLink: () => true },
    ])("refuses non-directory or linked claim roots before listing or writing %#", observed => {
        effects.stat.mockReturnValue(observed);
        const store = createSessionClaimsStore({ directory: () => "/fixture/locks", platform: () => "linux" });
        expect(() => store.ensureDirectory()).toThrow("CCC session lock path must be a real directory");
        expect(effects.mkdir).toHaveBeenCalledExactlyOnceWith("/fixture/locks", { recursive: true, mode: 0o700 });
        expect(effects.chmod).not.toHaveBeenCalled(); expect(effects.list).not.toHaveBeenCalled(); expect(effects.write).not.toHaveBeenCalled();
    });
    it("uses lazy directory and platform callbacks and preserves POSIX root mode", () => {
        let directory = "/first", host = "linux";
        const store = createSessionClaimsStore({ directory: () => directory, platform: () => host });
        expect(effects.mkdir).not.toHaveBeenCalled();
        store.ensureDirectory(); expect(effects.chmod).toHaveBeenCalledExactlyOnceWith("/first", 0o700);
        directory = "/second"; host = "win32"; store.ensureDirectory();
        expect(effects.mkdir).toHaveBeenLastCalledWith("/second", { recursive: true, mode: 0o700 });
        expect(effects.chmod).toHaveBeenCalledTimes(1);
        effects.read.mockReturnValue(" 123\n");
        expect(store.readClaim("claim.lock")).toBe(" 123\n");
        expect(effects.read).toHaveBeenCalledExactlyOnceWith(join("/second", "claim.lock"), "utf-8");
    });
});
