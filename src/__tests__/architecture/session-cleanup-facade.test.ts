import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionOwnershipHandle, SessionOwnershipReceipt } from "../../ports/session-ownership.js";

const effects = vi.hoisted(() => ({
    mkdir: vi.fn(), stat: vi.fn(), chmod: vi.fn(), list: vi.fn(), read: vi.fn(), write: vi.fn(),
    exists: vi.fn(), unlink: vi.fn(), identity: vi.fn(), lock: vi.fn(),
    runtime: vi.fn(), devices: vi.fn(), spawn: vi.fn(), fork: vi.fn(), spawnAsync: vi.fn(),
    token: vi.fn(), observe: vi.fn(), classify: vi.fn(),
    arm: vi.fn(), authorize: vi.fn(), validate: vi.fn(), capture: vi.fn(), matches: vi.fn(), rollback: vi.fn(),
}));
vi.mock("fs", async original => ({ ...await original<typeof import("node:fs")>(),
    mkdirSync: effects.mkdir, lstatSync: effects.stat, chmodSync: effects.chmod,
    readdirSync: effects.list, readFileSync: effects.read, writeFileSync: effects.write,
    existsSync: effects.exists, unlinkSync: effects.unlink,
}));
vi.mock("child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawnSync: effects.spawn, fork: effects.fork, spawn: effects.spawnAsync }));
vi.mock("../../home-layout.js", () => ({ locksDir: () => "/fixture/locks" }));
vi.mock("../../utils.js", () => ({ getProjectId: effects.identity }));
vi.mock("../../container-runtime.js", () => ({ runtimeCli: effects.runtime }));
vi.mock("../../device-lab-admin.js", () => ({ cleanupOwnerDevices: effects.devices }));
vi.mock("../../session-lock-liveness.js", async original => ({
    ...await original<typeof import("../../session-lock-liveness.js")>(),
    processStartToken: effects.token, observeProcessStarts: effects.observe, sessionLockLiveness: effects.classify,
}));
vi.mock("@ccc/device-lab/device-lab-shared-state.js", () => ({
    withSharedMutationLock: effects.lock, withSharedMutationLockAsync: effects.lock,
}));
vi.mock("../../composition/session-ownership.js", () => ({
    armNativeSessionOwnership: effects.arm,
    assertNativeSessionOwnership: effects.authorize,
    validateNativeSessionOwnership: effects.validate,
}));
vi.mock("../../adapters/session-ownership.js", () => ({
    captureNativeSessionOwnership: effects.capture,
    nativeSessionOwnershipMatches: effects.matches,
    removeCapturedNativeSessionOwnership: effects.rollback,
}));

let session = await import("../../session.js");
const own = "/fixture/locks/project--current.lock";
const project = "/fixture/project";
const stopOptions = { stdio: "ignore", timeout: 30_000, killSignal: "SIGKILL" };
const emptyContext = { lockFile: null, projectPath: null, profile: undefined, toolName: null };
let previousExitCode: typeof process.exitCode;

function start(profile?: string): void {
    session.setSession(own, project, profile);
    session.setSessionContainerId("captured-id");
}

describe("native session cleanup through the public facade", () => {
    beforeEach(() => {
        previousExitCode = process.exitCode;
        vi.resetAllMocks();
        session.clearSession();
        effects.stat.mockReturnValue({ isDirectory: () => true, isSymbolicLink: () => false });
        effects.identity.mockReturnValue("project");
        effects.list.mockReturnValue([]);
        effects.exists.mockReturnValue(true);
        effects.runtime.mockReturnValue("fixture-runtime");
        effects.lock.mockImplementation((_path, operation) => operation());
        effects.spawn.mockReturnValue({ status: 0 });
    });
    afterEach(() => { session.clearSession(); process.exitCode = previousExitCode; vi.restoreAllMocks(); });

    it("constructs the facade and its composition without invoking native effects", async () => {
        const once = vi.spyOn(process, "once").mockImplementation(() => process);
        vi.resetModules();
        session = await import("../../session.js");
        expect(session.getCurrentSession()).toEqual(emptyContext);
        for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
        expect(once).not.toHaveBeenCalled();
    });

    it("preserves legacy exports and adds only explicit guardian arming and confirmation", () => {
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
    });

    it("keeps legacy facade usage synchronous and launches no guardian without explicit arming", async () => {
        start();
        await expect(session.confirmSessionOwnership()).resolves.toBeUndefined();
        session.cleanupSession();
        session.clearSession();
        expect(effects.fork).not.toHaveBeenCalled();
        expect(effects.spawnAsync).not.toHaveBeenCalled();
        expect(effects.spawn).toHaveBeenCalledExactlyOnceWith("fixture-runtime", ["stop", "captured-id"], stopOptions);
    });

    it.each([
        [undefined, undefined, "claude"], ["", "", ""], ["work", "codex", "codex"],
    ])("shares one context and returns fresh snapshots for profile %s and tool %s", async (profile, tool, expectedTool) => {
        session.setSession(own, project, profile, tool);
        session.setSessionContainerId("hidden-id");
        const again = await import("../../session.js");
        const snapshot = again.getCurrentSession();
        expect(snapshot).toEqual({ lockFile: own, projectPath: project, profile, toolName: expectedTool });
        expect(snapshot).not.toBe(session.getCurrentSession());
        snapshot.lockFile = "changed-by-consumer";
        expect(session.getCurrentSession().lockFile).toBe(own);
        session.clearSession();
        expect(again.getCurrentSession()).toEqual(emptyContext);
        expect(effects.spawn).not.toHaveBeenCalled();
    });

    it("keeps cleaned-up state through setSession and resets it through clearSession", () => {
        start(); session.cleanupSession();
        expect(session.getCurrentSession()).toEqual({ ...emptyContext, toolName: "claude" });
        session.setSession(own, project, "work", "codex");
        session.setSessionContainerId("next-id");
        session.cleanupSession();
        expect(effects.devices).toHaveBeenCalledTimes(1);
        expect(session.getCurrentSession().lockFile).toBe(own);
        session.clearSession(); start(); session.cleanupSession();
        expect(effects.devices).toHaveBeenCalledTimes(2);
    });

    it("setSession clears the previously captured container ID", () => {
        start(); session.setSession(own, project); session.cleanupSession();
        expect(effects.devices).toHaveBeenCalledExactlyOnceWith(project, 5000, undefined);
        expect(effects.runtime).not.toHaveBeenCalled(); expect(effects.spawn).not.toHaveBeenCalled();
    });

    it.each(["absent", "unlink error", "present"])("keeps public removal best effort while cleanup observes unlink failures: %s", mode => {
        const failure = Object.assign(new Error("unlink denied"), { code: mode === "absent" ? "ENOENT" : "EACCES" });
        if (mode === "absent" || mode === "unlink error") effects.unlink.mockImplementation(() => { throw failure; });
        expect(() => session.removeSessionLock(own)).not.toThrow();
        start();
        if (mode === "unlink error") expect(() => session.cleanupSession()).toThrow(failure);
        else expect(() => session.cleanupSession()).not.toThrow();
        expect(effects.unlink.mock.calls).toEqual([[own], [own]]);
        expect(effects.devices).toHaveBeenCalledExactlyOnceWith(project, 5000, undefined);
        expect(effects.spawn).toHaveBeenCalledExactlyOnceWith("fixture-runtime", ["stop", "captured-id"], stopOptions);
        expect(session.getCurrentSession().lockFile).toBe(mode === "unlink error" ? own : null);
    });

    it.each([undefined, "", "work"])("holds raw query, removal, devices and exact-ID stop in the lifecycle lock for profile %s", profile => {
        const order: string[] = [];
        effects.identity.mockImplementation(path => { expect(path).toBe(project); order.push("identity"); return "project"; });
        effects.lock.mockImplementation((_path, operation) => { order.push("enter"); const result = operation(); order.push("return"); return result; });
        effects.list.mockImplementation(() => { order.push("claims"); return []; });
        effects.unlink.mockImplementation(() => { order.push("remove"); });
        effects.devices.mockImplementation(() => { order.push("devices"); });
        effects.runtime.mockImplementation(() => { order.push("runtime"); return "podman-fixture"; });
        effects.spawn.mockImplementation(() => { order.push("stop"); return { status: 0 }; });
        start(profile); session.cleanupSession();
        expect(order).toEqual(["identity", "enter", "claims", "claims", "devices", "runtime", "stop", "remove", "return"]);
        const prefix = profile ? `project--p--${profile}` : "project";
        expect(effects.lock).toHaveBeenCalledExactlyOnceWith(join("/fixture/locks", `${prefix}.container-lifecycle.guard`), expect.any(Function), { waitMs: 180000 });
        expect(effects.devices).toHaveBeenCalledExactlyOnceWith(project, 5000, profile);
        expect(effects.spawn).toHaveBeenCalledExactlyOnceWith("podman-fixture", ["stop", "captured-id"], stopOptions);
    });

    it.each(["malformed", "unreadable", "unknown"])("preserves foreign %s claims through reconciliation and fresh raw veto", record => {
        effects.list.mockReturnValue(["project--current.lock", "project--foreign.lock"]);
        if (record === "unreadable") effects.read.mockImplementation(() => { throw new Error("unreadable"); });
        else effects.read.mockReturnValue(record === "malformed" ? "broken" : "123");
        effects.classify.mockReturnValue("unknown");
        const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw new Error("no PID probe"); });
        start(); session.cleanupSession();
        expect(effects.unlink).toHaveBeenCalledExactlyOnceWith(own);
        expect(effects.read).toHaveBeenCalledWith("/fixture/locks/project--foreign.lock", "utf-8");
        for (const effect of [effects.devices, effects.runtime, effects.spawn, kill]) expect(effect).not.toHaveBeenCalled();
        expect(session.getCurrentSession()).toEqual({ ...emptyContext, toolName: "claude" });
    });

    it("reconciles proven stale foreign ownership then stops the exact captured ID after a fresh empty veto", () => {
        const foreign = "/fixture/locks/project--foreign.lock";
        const names = ["project--current.lock", "project--foreign.lock"];
        effects.list.mockImplementation(() => [...names]);
        effects.read.mockReturnValue("123");
        effects.classify.mockReturnValue("stale");
        effects.unlink.mockImplementation(path => { names.splice(names.indexOf(path.split("/").at(-1)), 1); });
        start(); session.cleanupSession();
        expect(effects.unlink.mock.calls).toEqual([[foreign], [own]]);
        expect(effects.spawn).toHaveBeenCalledExactlyOnceWith("fixture-runtime", ["stop", "captured-id"], stopOptions);
        expect(effects.list).toHaveBeenCalledTimes(2);
        expect(effects.spawn.mock.invocationCallOrder[0]).toBeLessThan(effects.unlink.mock.invocationCallOrder[1]!);
    });

    it("keeps failed stale foreign unlink as a fresh raw veto", () => {
        const foreign = "/fixture/locks/project--foreign.lock";
        effects.list.mockReturnValue(["project--current.lock", "project--foreign.lock"]);
        effects.read.mockReturnValue("123"); effects.classify.mockReturnValue("stale");
        effects.unlink.mockImplementation(path => { if (path === foreign) throw new Error("denied"); });
        start(); session.cleanupSession();
        expect(effects.unlink.mock.calls).toEqual([[foreign], [own]]);
        expect(effects.list).toHaveBeenCalledTimes(2);
        expect(effects.devices).not.toHaveBeenCalled(); expect(effects.spawn).not.toHaveBeenCalled();
    });

    it.each(["replacement-id", null, ""])("reads the container ID after runtime selection mutates it to %s", nextId => {
        effects.runtime.mockImplementation(() => { session.setSessionContainerId(nextId); return "changed-runtime"; });
        start(); session.cleanupSession();
        expect(effects.spawn).toHaveBeenCalledExactlyOnceWith("changed-runtime", ["stop", nextId], stopOptions);
    });

    it("uses device callback mutations before choosing whether and which captured ID to stop", () => {
        effects.devices.mockImplementation(() => { session.setSessionContainerId("device-updated-id"); });
        start(); session.cleanupSession();
        expect(effects.spawn).toHaveBeenCalledWith("fixture-runtime", ["stop", "device-updated-id"], stopOptions);
        session.clearSession(); start();
        effects.devices.mockImplementation(() => { session.setSessionContainerId(null); });
        session.cleanupSession();
        expect(effects.spawn).toHaveBeenCalledTimes(1); expect(effects.runtime).toHaveBeenCalledTimes(1);
    });

    it("keeps mutable facade reads across native identity, lock, raw query and removal callbacks", () => {
        effects.identity.mockImplementation(() => { session.setSession(own, project, "identity-profile"); return "project"; });
        const lockPath = "/fixture/locks/project--p--identity-profile--lock.lock";
        const queriedPath = "/fixture/locks/project--p--identity-profile--query.lock";
        effects.lock.mockImplementation((_path, operation) => { session.setSession(lockPath, "/lock/project", "lock-profile"); return operation(); });
        effects.list.mockImplementation(() => { session.setSession(queriedPath, "/query/project", "query-profile"); return ["project--p--identity-profile--lock.lock"]; });
        effects.unlink.mockImplementation(() => { session.setSession("/removed.lock", "/removal/project", "removal-profile", "updated-tool"); session.setSessionContainerId("removal-id"); });
        start(); session.cleanupSession();
        expect(effects.lock).toHaveBeenCalledWith(join("/fixture/locks", "project--p--identity-profile.container-lifecycle.guard"), expect.any(Function), { waitMs: 180000 });
        expect(effects.unlink).toHaveBeenCalledExactlyOnceWith(queriedPath);
        expect(effects.devices).toHaveBeenCalledExactlyOnceWith("/query/project", 5000, "query-profile");
        expect(effects.spawn).not.toHaveBeenCalled();
        expect(session.getCurrentSession()).toEqual({ ...emptyContext, toolName: "updated-tool" });
    });

    it.each([new Error("device failure"), "non-Error failure"])("reports device failure exactly and continues using reporter mutations: %s", failure => {
        const report = vi.spyOn(console, "error").mockImplementation(() => { session.setSessionContainerId("reported-id"); });
        effects.devices.mockImplementation(() => { throw failure; });
        start(); session.cleanupSession();
        expect(report).toHaveBeenCalledExactlyOnceWith(`[ccc] device cleanup failed during session cleanup: ${failure instanceof Error ? failure.message : String(failure)}`);
        expect(effects.spawn).toHaveBeenCalledExactlyOnceWith("fixture-runtime", ["stop", "reported-id"], stopOptions);
    });

    it("propagates reporter failure without stop or finalization and retries", () => {
        const failure = new Error("report failed");
        const report = vi.spyOn(console, "error").mockImplementationOnce(() => { throw failure; }).mockImplementation(() => {});
        effects.devices.mockImplementation(() => { throw new Error("device failure"); });
        start(); expect(() => session.cleanupSession()).toThrow(failure);
        expect(session.getCurrentSession().lockFile).toBe(own); expect(effects.spawn).not.toHaveBeenCalled();
        session.cleanupSession();
        expect(report).toHaveBeenCalledTimes(2); expect(effects.devices).toHaveBeenCalledTimes(2);
        expect(effects.spawn).toHaveBeenCalledTimes(1); expect(session.getCurrentSession().lockFile).toBeNull();
    });

    it.each(["runtime", "spawn"] as const)("propagates native %s exceptions and retries rather than finalizing", stage => {
        const failure = new Error(`${stage} failed`);
        effects[stage].mockImplementationOnce(() => { throw failure; });
        start(); expect(() => session.cleanupSession()).toThrow(failure);
        expect(session.getCurrentSession().lockFile).toBe(own);
        session.cleanupSession();
        expect(effects.devices).toHaveBeenCalledTimes(2); expect(effects.unlink).toHaveBeenCalledTimes(1);
        expect(effects.runtime).toHaveBeenCalledTimes(2);
        expect(effects.spawn).toHaveBeenCalledTimes(stage === "runtime" ? 1 : 2);
        expect(session.getCurrentSession().lockFile).toBeNull();
    });

    it("finalizes only after a successful native stop", () => {
        effects.spawn.mockReturnValue({ status: 0 });
        start(); session.cleanupSession(); session.cleanupSession();
        expect(effects.spawn).toHaveBeenCalledTimes(1); expect(session.getCurrentSession().lockFile).toBeNull();
    });

    it.each([
        { status: 9 }, { status: null }, { status: undefined },
        { status: null, error: Object.assign(new Error("PRIVATE_RUNTIME_DETAIL"), { code: "ENOENT" }) },
        { status: null, error: Object.assign(new Error("PRIVATE_RUNTIME_DETAIL"), { code: "ETIMEDOUT" }) },
        { status: 0, error: new Error("PRIVATE_RUNTIME_DETAIL") },
        { status: null, signal: "SIGKILL" }, { status: 0, signal: "SIGTERM" },
    ])("keeps native stop failure retryable instead of recording cleanup success: %j", result => {
        effects.spawn.mockReturnValueOnce(result).mockReturnValue({ status: 0 });
        start();
        let message = "";
        try { session.cleanupSession(); } catch (error) { message = (error as Error).message; }
        expect(message).toContain("Container shutdown failed");
        expect(message).not.toContain("PRIVATE_RUNTIME_DETAIL");
        expect(message.length).toBeLessThan(250);
        expect(session.getCurrentSession().lockFile).toBe(own);
        expect(effects.unlink).not.toHaveBeenCalled();
        expect(effects.spawn).toHaveBeenCalledExactlyOnceWith("fixture-runtime", ["stop", "captured-id"], stopOptions);
        session.cleanupSession();
        expect(effects.spawn).toHaveBeenCalledTimes(2);
        expect(session.getCurrentSession().lockFile).toBeNull();
    });

    it("rechecks foreign ownership before retrying a failed stop", () => {
        effects.spawn.mockReturnValue({ status: 9 });
        start();
        expect(() => session.cleanupSession()).toThrow("Container shutdown failed");
        effects.list.mockReturnValue(["project--current.lock", "project--foreign.lock"]);
        session.cleanupSession();
        expect(effects.spawn).toHaveBeenCalledTimes(1);
        expect(effects.devices).toHaveBeenCalledTimes(1);
        expect(effects.read).toHaveBeenCalled();
        expect(session.getCurrentSession().lockFile).toBeNull();
    });

    it("resolves changed native effect implementations on later cleanup calls", () => {
        start(); session.cleanupSession(); session.clearSession();
        const report = vi.spyOn(console, "error").mockImplementation(() => {});
        effects.runtime.mockReturnValue("later-runtime");
        effects.devices.mockImplementation(() => { throw "later-failure"; });
        start("work"); session.cleanupSession();
        expect(effects.devices).toHaveBeenLastCalledWith(project, 5000, "work");
        expect(report).toHaveBeenCalledExactlyOnceWith("[ccc] device cleanup failed during session cleanup: later-failure");
        expect(effects.spawn).toHaveBeenLastCalledWith("later-runtime", ["stop", "captured-id"], stopOptions);
    });

    it("registers exactly three once callbacks on every setup without changing real listeners", () => {
        const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
        const before = signals.map(signal => process.listeners(signal));
        const once = vi.spyOn(process, "once").mockImplementation(() => process);
        session.setupSignalHandlers(); session.setupSignalHandlers();
        expect(once.mock.calls.map(([signal]) => signal)).toEqual(["SIGINT", "SIGTERM", "SIGHUP", "SIGINT", "SIGTERM", "SIGHUP"]);
        for (const [, callback] of once.mock.calls) expect(callback).toEqual(expect.any(Function));
        expect(signals.map(signal => process.listeners(signal))).toEqual(before);
    });

    it.each(["SIGINT", "SIGTERM", "SIGHUP"])("runs cleanup before exit(0) for intercepted %s", signal => {
        const previousExitCode = process.exitCode;
        process.exitCode = undefined;
        const once = vi.spyOn(process, "once").mockImplementation(() => process);
        const order: string[] = [];
        const exit = vi.spyOn(process, "exit").mockImplementation((() => { order.push("exit"); }) as () => never);
        effects.devices.mockImplementation(() => { order.push("cleanup"); });
        start(); session.setupSignalHandlers();
        const callback = once.mock.calls.find(([registered]) => registered === signal)![1];
        callback();
        expect(order).toEqual(["cleanup", "exit"]);
        expect(exit).toHaveBeenCalledExactlyOnceWith(0);
        expect(effects.spawn).toHaveBeenCalledTimes(1); expect(session.getCurrentSession().lockFile).toBeNull();
        process.exitCode = previousExitCode;
    });

    it.each(["SIGINT", "SIGTERM", "SIGHUP"])("retains explicit failure exitCode after %s cleanup", signal => {
        const previousExitCode = process.exitCode;
        const once = vi.spyOn(process, "once").mockImplementation(() => process);
        const exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as () => never);
        try {
            process.exitCode = 1;
            start(); session.setupSignalHandlers();
            once.mock.calls.find(([registered]) => registered === signal)![1]();
            expect(exit).toHaveBeenCalledExactlyOnceWith(1);
            expect(session.getCurrentSession().lockFile).toBeNull();
        } finally { process.exitCode = previousExitCode; }
    });

    it.each(["SIGINT", "SIGTERM", "SIGHUP"])("does not exit when intercepted %s cleanup throws", signal => {
        const once = vi.spyOn(process, "once").mockImplementation(() => process);
        const exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as () => never);
        const failure = new Error("signal cleanup failed");
        effects.runtime.mockImplementation(() => { throw failure; });
        start(); session.setupSignalHandlers();
        const callback = once.mock.calls.find(([registered]) => registered === signal)![1];
        expect(() => callback()).toThrow(failure);
        expect(exit).not.toHaveBeenCalled(); expect(session.getCurrentSession().lockFile).toBe(own);
    });
});

describe("host ownership acquisition through the facade", () => {
    const request = { projectId: "project", projectPath: project, toolName: "codex" };
    const receiptFor = (path: string): SessionOwnershipReceipt => ({
        path, bytes: Buffer.from(String(process.pid)).toString("base64"),
        device: "1", inode: "2", birthtime: "3", ownerPid: process.pid,
    });
    const update = vi.fn<SessionOwnershipHandle["updateContainer"]>();
    const release = vi.fn<SessionOwnershipHandle["release"]>();
    const handle: SessionOwnershipHandle = { pid: 321, updateContainer: update, release, assertOwnership: () => effects.authorize() };

    beforeEach(() => {
        session.clearSession(); vi.resetAllMocks();
        effects.stat.mockReturnValue({ isDirectory: () => true, isSymbolicLink: () => false });
        effects.identity.mockReturnValue("project"); effects.list.mockReturnValue([]);
        effects.runtime.mockReturnValue("docker"); effects.spawn.mockReturnValue({ status: 0 });
        effects.lock.mockImplementation((_path, operation) => operation());
        effects.capture.mockImplementation(receiptFor); effects.matches.mockReturnValue(true);
        update.mockResolvedValue(undefined); release.mockResolvedValue(undefined);
        effects.arm.mockResolvedValue(handle);
        vi.spyOn(process, "once").mockImplementation(() => process);
    });
    afterEach(() => {
        effects.authorize.mockImplementation(() => undefined);
        session.clearSession(); vi.restoreAllMocks();
    });

    it("blocks generic cleanup while capture is pending and after capture fails without unlinking a replacement", async () => {
        let rejectArm!: (error: Error) => void;
        effects.arm.mockImplementation(() => new Promise((_resolve, reject) => { rejectArm = reject; }));
        start();
        const arming = session.armSessionOwnership();
        void arming.catch(() => undefined);
        expect(() => session.setSession("/successor.lock", project)).toThrow();
        expect(() => session.clearSession()).toThrow();
        expect(() => session.cleanupSession()).toThrow("ownership was not established");
        expect(effects.unlink).not.toHaveBeenCalled(); expect(effects.devices).not.toHaveBeenCalled(); expect(effects.spawn).not.toHaveBeenCalled();
        const failure = new Error("capture failed"); rejectArm(failure);
        await expect(arming).rejects.toBe(failure);
        expect(() => session.cleanupSession()).toThrow("ownership was not established");
        expect(effects.unlink).not.toHaveBeenCalled(); expect(effects.spawn).not.toHaveBeenCalled();
    });

    it("blocks generic cleanup during pending inspection and preserves a successor on rollback", async () => {
        let inspected!: (value: { known: boolean; containerId: null; runtime: "docker" }) => void;
        const inspect = vi.fn(() => new Promise<{ known: boolean; containerId: null; runtime: "docker" }>(resolve => { inspected = resolve; }));
        const acquisition = session.acquireHostSessionOwnership(request, inspect);
        void acquisition.catch(() => undefined);
        await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(1));
        effects.authorize.mockImplementation(() => { throw new Error("receipt replaced"); });
        effects.matches.mockReturnValue(false);
        expect(() => session.cleanupSession()).toThrow("during acquisition");
        expect(effects.unlink).not.toHaveBeenCalled(); expect(effects.devices).not.toHaveBeenCalled();
        expect(() => session.setSession("/successor.lock", project)).toThrow();
        expect(() => session.setSessionContainerId("unauthorized-id")).toThrow();
        inspected({ known: false, containerId: null, runtime: "docker" });
        await expect(acquisition).rejects.toThrow("could not be inspected");
        expect(effects.rollback).not.toHaveBeenCalled(); expect(effects.spawn).not.toHaveBeenCalled();
    });

    it("checks captured receipt authorization inside the lifecycle guard before generic cleanup can touch a successor", async () => {
        const captured = receiptFor(own);
        effects.arm.mockImplementation(async (_binding, _failure, options) => { options.onCaptured(captured); return handle; });
        start(); await expect(session.armSessionOwnership()).resolves.toBe(321);
        effects.authorize.mockImplementation(receipt => { expect(receipt).toEqual(captured); throw new Error("receipt replaced"); });
        expect(() => session.setSession("/successor.lock", project)).toThrow();
        expect(() => session.cleanupSession()).toThrow("receipt replaced");
        expect(effects.lock).toHaveBeenCalledWith(join("/fixture/locks", "project.container-lifecycle.guard"), expect.any(Function), { waitMs: 180000 });
        expect(effects.unlink).not.toHaveBeenCalled(); expect(effects.list).not.toHaveBeenCalled();
        expect(effects.devices).not.toHaveBeenCalled(); expect(effects.spawn).not.toHaveBeenCalled();
        expect(session.getCurrentSession().lockFile).toBe(own); expect(release).not.toHaveBeenCalled();
    });

    it("rolls back only the captured new reservation on unknown inspection without arming or pruning foreign claims", async () => {
        const inspect = vi.fn(() => ({ known: false, containerId: null, runtime: "docker" as const }));
        await expect(session.acquireHostSessionOwnership(request, inspect)).rejects.toThrow("could not be inspected");
        expect(effects.write).toHaveBeenCalledExactlyOnceWith(
            effects.capture.mock.calls[0][0], String(process.pid), { mode: 0o600, flag: "wx" },
        );
        expect(effects.rollback).toHaveBeenCalledExactlyOnceWith(effects.capture.mock.results[0].value);
        expect(effects.arm).not.toHaveBeenCalled(); expect(effects.list).not.toHaveBeenCalled();
        expect(effects.unlink).not.toHaveBeenCalled(); expect(effects.devices).not.toHaveBeenCalled(); expect(effects.spawn).not.toHaveBeenCalled();
        expect(session.getCurrentSession()).toEqual(emptyContext);
    });

    it("acknowledges an existing exact ID before pruning, and blocks session replacement while the ACK is pending", async () => {
        let ack!: () => void;
        update.mockImplementation(() => new Promise<void>(resolve => { ack = resolve; }));
        effects.list.mockReturnValue(["project--foreign.lock"]); effects.read.mockReturnValue("123"); effects.classify.mockReturnValue("stale");
        const acquisition = session.acquireHostSessionOwnership(request, () => ({ known: true, containerId: "existing-exact-id", runtime: "podman" }));
        void acquisition.catch(() => undefined);
        await vi.waitFor(() => expect(update).toHaveBeenCalledExactlyOnceWith("existing-exact-id", "podman", false));
        expect(effects.list).not.toHaveBeenCalled(); expect(effects.unlink).not.toHaveBeenCalled();
        expect(() => session.setSession("/other.lock", project)).toThrow(); expect(() => session.clearSession()).toThrow();
        ack();
        const result = await acquisition;
        expect(result.existingId).toBe("existing-exact-id");
        expect(effects.unlink).toHaveBeenCalledWith("/fixture/locks/project--foreign.lock");
        expect(() => session.setSession("/other.lock", project)).toThrow();
        expect(effects.devices).not.toHaveBeenCalled(); expect(effects.spawn).not.toHaveBeenCalled();
        effects.list.mockReturnValue([]);
        update.mockResolvedValue(undefined);
        session.setSessionCleanupEnabled(true);
        await session.confirmSessionOwnership();
        session.cleanupSession();
        expect(effects.spawn).toHaveBeenCalledExactlyOnceWith("docker", ["stop", "existing-exact-id"], stopOptions);
        expect(release).toHaveBeenCalledTimes(1);
    });

    it("failed existing-ID ACK rolls back and releases the monitor without foreign pruning or shared effects", async () => {
        const failure = new Error("ACK failed"); update.mockRejectedValue(failure);
        await expect(session.acquireHostSessionOwnership(request, () => ({ known: true, containerId: "existing-exact-id", runtime: "docker" }))).rejects.toBe(failure);
        expect(effects.rollback).toHaveBeenCalledExactlyOnceWith(effects.capture.mock.results[0].value);
        expect(release).toHaveBeenCalledTimes(1);
        expect(effects.list).not.toHaveBeenCalled(); expect(effects.unlink).not.toHaveBeenCalled();
        expect(effects.devices).not.toHaveBeenCalled(); expect(effects.spawn).not.toHaveBeenCalled();
    });

    it("failed setup after joining an existing ID removes only its authorized claim", async () => {
        await session.acquireHostSessionOwnership(request, () => ({ known: true, containerId: "existing-exact-id", runtime: "docker" }));
        session.cleanupSession();
        expect(effects.spawn).not.toHaveBeenCalled();
        expect(effects.devices).not.toHaveBeenCalled();
        expect(effects.unlink).toHaveBeenCalledExactlyOnceWith(effects.capture.mock.results[0].value.path);
        expect(release).toHaveBeenCalledTimes(1);
    });

    it("confirmation waits for queued permission grants and revocations in order", async () => {
        await session.acquireHostSessionOwnership(request, () => ({ known: true, containerId: "existing-exact-id", runtime: "docker" }));
        let acknowledge!: () => void;
        update.mockImplementationOnce(() => new Promise<void>(resolve => { acknowledge = resolve; }));
        session.setSessionCleanupEnabled(true);
        await vi.waitFor(() => expect(update).toHaveBeenLastCalledWith("existing-exact-id", "docker", true));
        session.setSessionCleanupEnabled(false);
        let confirmed = false;
        const confirmation = session.confirmSessionOwnership().then(() => { confirmed = true; });
        await Promise.resolve();
        expect(confirmed).toBe(false);
        expect(update).toHaveBeenCalledTimes(2);
        acknowledge();
        await confirmation;
        expect(update.mock.calls.map(call => call[2])).toEqual([false, true, false]);
        session.cleanupSession();
        expect(effects.spawn).not.toHaveBeenCalled();
        expect(effects.devices).not.toHaveBeenCalled();
        expect(effects.unlink).toHaveBeenCalledTimes(1);
    });

    it("preserves acknowledged cleanup ownership when the monitor fails before the ACK await continuation", async () => {
        const failure = new Error("monitor lost immediately after ACK");
        let monitorFailed!: (error: Error) => void;
        effects.arm.mockImplementation(async (_binding, onFailure) => { monitorFailed = onFailure; return handle; });
        update.mockImplementation(() => new Promise<void>(resolve => {
            resolve();
            monitorFailed(failure);
        }));
        await expect(session.acquireHostSessionOwnership(request, () => ({
            known: true, containerId: "acknowledged-exact-id", runtime: "docker",
        }))).rejects.toBe(failure);
        expect(update).toHaveBeenCalledExactlyOnceWith("acknowledged-exact-id", "docker", false);
        const captured = effects.capture.mock.results[0].value as SessionOwnershipReceipt;
        expect(session.getCurrentSession()).toEqual({
            lockFile: captured.path, projectPath: project, profile: undefined, toolName: "codex",
        });
        expect(effects.rollback).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled();
        expect(effects.list).not.toHaveBeenCalled(); expect(effects.unlink).not.toHaveBeenCalled();
        expect(effects.devices).not.toHaveBeenCalled(); expect(effects.spawn).not.toHaveBeenCalled();
        expect(() => session.setSession("/replacement.lock", project)).toThrow();
        session.cleanupSession();
        expect(effects.authorize).toHaveBeenCalledWith(captured);
        expect(effects.spawn).not.toHaveBeenCalled();
        expect(effects.devices).not.toHaveBeenCalled();
        expect(effects.unlink).toHaveBeenCalledExactlyOnceWith(captured.path);
        expect(release).toHaveBeenCalledTimes(1);
        expect(session.getCurrentSession().lockFile).toBeNull();
    });

    it("a different captured ID first hands off false and needs its own acknowledged grant", async () => {
        await session.acquireHostSessionOwnership(request, () => ({ known: true, containerId: "first-exact-id", runtime: "docker" }));
        session.setSessionCleanupEnabled(true);
        await session.confirmSessionOwnership();
        update.mockClear();
        session.setSessionContainerId("replacement-exact-id");
        await session.confirmSessionOwnership();
        expect(update).toHaveBeenCalledExactlyOnceWith("replacement-exact-id", "docker", false);
        session.setSessionCleanupEnabled(true);
        await session.confirmSessionOwnership();
        expect(update.mock.calls).toEqual([
            ["replacement-exact-id", "docker", false], ["replacement-exact-id", "docker", true],
        ]);
        session.cleanupSession();
        expect(effects.spawn).toHaveBeenCalledExactlyOnceWith("docker", ["stop", "replacement-exact-id"], stopOptions);
    });

    it("rejected replacement-ID ACK cannot retain the previous ID's local stop authorization", async () => {
        await session.acquireHostSessionOwnership(request, () => ({ known: true, containerId: "first-exact-id", runtime: "docker" }));
        session.setSessionCleanupEnabled(true);
        await session.confirmSessionOwnership();
        const failure = new Error("fixture replacement ACK lost");
        let rejectAck!: (error: Error) => void;
        update.mockClear();
        update.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectAck = reject; }));
        session.setSessionContainerId("replacement-exact-id");
        const confirmation = session.confirmSessionOwnership();
        const rejected = expect(confirmation).rejects.toBe(failure);
        await vi.waitFor(() => expect(update).toHaveBeenCalledExactlyOnceWith("replacement-exact-id", "docker", false));
        expect(effects.devices).not.toHaveBeenCalled();
        expect(effects.spawn).not.toHaveBeenCalled();
        rejectAck(failure);
        await rejected;
        session.cleanupSession();
        expect(effects.devices).not.toHaveBeenCalled();
        expect(effects.spawn).not.toHaveBeenCalled();
        expect(effects.unlink).toHaveBeenCalledTimes(1);
    });

    it("capturing the same acknowledged ID retains its own shutdown authorization", async () => {
        await session.acquireHostSessionOwnership(request, () => ({ known: true, containerId: "first-exact-id", runtime: "docker" }));
        session.setSessionCleanupEnabled(true);
        await session.confirmSessionOwnership();
        update.mockClear();
        session.setSessionContainerId("first-exact-id");
        await session.confirmSessionOwnership();
        expect(update).toHaveBeenCalledExactlyOnceWith("first-exact-id", "docker", true);
        session.cleanupSession();
        expect(effects.spawn).toHaveBeenCalledExactlyOnceWith("docker", ["stop", "first-exact-id"], stopOptions);
    });

    it("reports monitor loss during asynchronous acquisition guard release while retaining the acknowledged cleanup ID", async () => {
        const failure = new Error("monitor lost during guard release");
        let monitorFailed!: (error: Error) => void;
        effects.arm.mockImplementation(async (_binding, onFailure) => { monitorFailed = onFailure; return handle; });
        effects.lock.mockImplementation(async (_path, operation) => {
            const result = await operation();
            monitorFailed(failure);
            return result;
        });
        await expect(session.acquireHostSessionOwnership(request, () => ({
            known: true, containerId: "acknowledged-exact-id", runtime: "docker",
        }))).rejects.toBe(failure);
        const captured = effects.capture.mock.results[0].value as SessionOwnershipReceipt;
        expect(session.getCurrentSession().lockFile).toBe(captured.path);
        expect(effects.rollback).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled();
        expect(effects.unlink).not.toHaveBeenCalled(); expect(effects.spawn).not.toHaveBeenCalled();
        effects.lock.mockImplementation((_path, operation) => operation());
        session.cleanupSession();
        expect(effects.spawn).not.toHaveBeenCalled();
        expect(effects.devices).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledTimes(1);
    });
});
