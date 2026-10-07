import { afterEach, beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({
    events: [] as string[], running: false, exists: true, profile: undefined as string | undefined,
    handoffStarted: undefined as boolean | undefined,
    realCleanup: false, devices: vi.fn(),
    locked: false, failPostExitLock: false, failTool: false, failState: false, launchFailure: false,
    probeRunning: vi.fn(), spawn: vi.fn(), start: vi.fn(), prepare: vi.fn(), restore: vi.fn(), state: vi.fn(), harness: vi.fn(), confirm: vi.fn(), command: vi.fn(),
}));
vi.mock("child_process", async original => ({ ...await original<typeof import("child_process")>(), spawnSync: f.spawn }));
// Native filesystem metadata stays real. Only the exact synthetic claim is removed
// by a fixture; the isolated verification HOME contains all config directories.
vi.mock("fs", async original => {
    const actual = await original<typeof import("fs")>();
    return { ...actual, unlinkSync: (path: import("fs").PathLike) => {
        if (path === "/fixture/session.lock") return;
        return actual.unlinkSync(path);
    } };
});
vi.mock("../utils.js", async original => ({
    ...await original<typeof import("../utils.js")>(),
    collectForwardedEnv: () => ({ forwarded: [], skippedDueToLimit: [], totalBytes: 0 }),
    writeOwnedEnvFile: () => ({ path: "/fixture/exec.env", dispose: () => f.events.push("unlink") }),
}));
vi.mock("../container-command.js", () => ({ runContainerCommand: f.command }));
vi.mock("../docker.js", () => ({
    ensureDockerRunning: vi.fn(), ensureCredentialHostDir: vi.fn(),
    getContainerName: () => "ccc-fixture", getContainerStatus: () => ({ exists: f.exists, running: f.running, imageId: "sha256:old", containerId: "old-id" }),
    startProjectContainer: f.start, isContainerRunning: f.probeRunning,
    restoreCodexConfigHostOwnership: f.restore, prepareCodexConfigForContainer: f.prepare,
    syncClipboardShims: () => f.events.push("clipboard"), ensureContainerManagerSocketAccess: vi.fn(),
}));
vi.mock("../container-runtime.js", async original => ({ ...await original<typeof import("../container-runtime.js")>(), runtimeCli: () => "docker", deviceBrokerBindHostForContainer: () => "127.0.0.1" }));
vi.mock("../worktree.js", async original => ({ ...await original<typeof import("../worktree.js")>(), detectWorktreeWorkspaceBranch: () => null, getWorktreeGitMounts: () => [] }));
vi.mock("../profile.js", async original => ({ ...await original<typeof import("../profile.js")>(), profileExists: () => true }));
vi.mock("../clipboard-server.js", () => ({ ensureClipboardServer: async () => null, hasAnyActiveSessionsExcept: () => false, retireClipboardServerFromPortFile: vi.fn() }));
vi.mock("../home-layout.js", async original => ({ ...await original<typeof import("../home-layout.js")>(), ensureDefaultProfileDir: vi.fn(), migrateHomeLayout: () => f.events.push("layout") }));
vi.mock("../home-layout-container-guard.js", () => ({ hasLegacyHomeLayoutContainerMounts: () => false }));
vi.mock("@ccc/device-lab/device-lab-shared-state.js", async original => ({ ...await original<typeof import("@ccc/device-lab/device-lab-shared-state.js")>(), withSharedMutationLock: (_key: string, operation: () => unknown) => operation() }));
vi.mock("@ccc/device-lab/device-lab-broker.js", () => ({ DEVICE_BROKER_DEFAULT_HOST: "127.0.0.1", ensureHostDeviceBroker: async () => ({ ok: true }) }));
vi.mock("../device-lab-admin.js", () => ({ cleanupOwnerDevices: f.devices }));
vi.mock("../session.js", async original => {
    const actual = await original<typeof import("../session.js")>();
    return { ...actual,
    acquireHostSessionOwnership: async (request: import("../ports/session-acquisition.js").SessionAcquisitionRequest) => {
        actual.setSession("/fixture/session.lock", request.projectPath, request.profile, request.toolName);
        actual.setSessionCleanupEnabled(false);
        return { lockFile: "/fixture/session.lock", existingId: f.running ? "old-id" : null };
    },
    confirmSessionOwnership: f.confirm,
    createSessionLock: () => "/fixture/session.lock", setupSignalHandlers: vi.fn(),
    getActiveSessionsForContainer: () => [], cleanupSession: () => { f.events.push("cleanup"); if (f.realCleanup) actual.cleanupSession(); },
    withContainerLifecycleLock: (_key: string, operation: () => unknown) => operation(),
    withContainerSetupLockAsync: async (_key: string, operation: () => unknown) => operation(),
}; });
vi.mock("../container-setup.js", () => ({
    CLAUDE_BIN_PATH: "/home/ccc/.local/bin/claude", ensureUvAvailable: () => f.events.push("uv"),
    ensureTools: (id: string, tool: {name: string}) => { expect(id).toBe("final-id"); f.events.push(`tool:${tool.name}`); if (f.failTool) throw new Error("tool unavailable"); },
}));
vi.mock("../codex-config-lock.js", () => ({ withCodexConfigLock: (operation: () => unknown, profile?: string) => {
    if (f.failPostExitLock && f.events.includes("command")) throw new Error("post-exit lock unavailable");
    expect(profile).toBe(f.profile); expect(f.locked).toBe(false); f.locked = true;
    try { return operation(); } finally { f.locked = false; }
} }));
vi.mock("../mcp-forward.js", () => ({ buildMcpConfig: (profile?: string, restore?: () => void) => {
    expect(profile).toBe(f.profile); f.locked = true; try { restore?.(); } finally { f.locked = false; }
    f.events.push("mcp"); return [];
} }));
vi.mock("../codex-state-ownership.js", () => ({ assertCodexStateAccessible: f.state }));
vi.mock("../codex-harness.js", () => ({ ensureCodexHarness: f.harness }));
vi.mock("../localhost-proxy-setup.js", () => ({ setupLocalhostProxy: () => f.events.push("proxy") }));
vi.mock("../codex-clipboard-image.js", () => ({ maybeAttachCodexClipboardImage: async (_path: string, args: string[]) => ({ args }) }));
vi.mock("../codex-launch.js", () => ({ prepareCodexLaunch: (_runtime: string, args: string[], command: string[]) => {
    expect(args).toContain("final-id"); f.events.push("launch-preparation");
    return f.launchFailure ? { ok: false, status: 9, error: "daemon unavailable" } : { ok: true, command };
} }));
import { clearSession, getCurrentSession } from "../session.js";
import { main, runCli } from "../index.js";
class Exit extends Error { constructor(readonly status: number) { super(`exit ${status}`); } }
const originalArgv = process.argv;
beforeEach(() => {
    clearSession(); f.realCleanup = false; f.handoffStarted = undefined;
    vi.clearAllMocks(); vi.stubEnv("CCC_PROFILE", ""); vi.stubEnv("DEBUG", ""); vi.stubEnv("container", "");
    process.argv = [process.execPath, "ccc", "codex", "resume", "--last"];
    f.events = []; f.running = false; f.exists = true; f.profile = undefined; f.locked = false; f.failPostExitLock = false; f.failTool = false; f.failState = false; f.launchFailure = false;
    vi.spyOn(process, "exit").mockImplementation(code => { throw new Exit(Number(code)); });
    vi.spyOn(process.stderr, "write").mockReturnValue(true); vi.spyOn(console, "error").mockImplementation(() => {});
    f.probeRunning.mockReturnValue(true);
    f.confirm.mockImplementation(async () => { f.events.push("confirm"); });
    f.command.mockImplementation(async (_runtime: string, args: string[]) => {
        expect(args).toContain("final-id");
        expect(f.events.at(-1)).toBe("confirm");
        f.events.push("command"); return 0;
    });
    f.start.mockImplementation((...args: unknown[]) => { f.events.push("start");
        const started = f.handoffStarted ?? !f.running;
        if (started) (args[9] as (id: string) => void)("final-id");
        (args[7] as (id: string, handoff: { startedByInvocation: boolean }) => void)("final-id", { startedByInvocation: started }); return "ccc-fixture"; });
    f.restore.mockImplementation((id, profile) => { expect(id).toBe("final-id"); expect(profile).toBe(f.profile); expect(f.locked).toBe(true); f.events.push("restore"); });
    f.prepare.mockImplementation((id, profile) => { expect(id).toBe("final-id"); expect(profile).toBe(f.profile); expect(f.locked).toBe(true); f.events.push("prepare"); });
    f.state.mockImplementation((id, profile) => { expect(id).toBe("final-id"); expect(profile).toBe(f.profile); f.events.push("state"); if (f.failState) throw new Error("state inaccessible"); });
    f.harness.mockImplementation((id, profile) => { expect(id).toBe("final-id"); expect(profile).toBe(f.profile); f.events.push("harness"); });
    f.spawn.mockImplementation((_runtime, args: string[]) => { if (args.includes("codex")) f.events.push("command"); return { status: 0, stdout: "", stderr: "" }; });
});
afterEach(() => { process.argv = originalArgv; vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it.each([false, true])("preserves final-ID Codex setup and resume ordering when initially running=%s", async running => {
    f.running = running; f.profile = "work"; vi.stubEnv("CCC_PROFILE", "work");
    await expect(main()).rejects.toMatchObject({ status: 0 });
    const ordered = ["start", "mcp", "tool:codex", "prepare", "state", "harness", "clipboard", "launch-preparation", "command"];
    for (let i=1;i<ordered.length;i++) expect(f.events.indexOf(ordered[i])).toBeGreaterThan(f.events.indexOf(ordered[i-1]));
    expect(f.events.includes("uv")).toBe(!running);
    expect(f.events.slice(-4)).toEqual(["command", "restore", "unlink", "cleanup"]);
    expect(f.spawn.mock.calls.some(([, args]) => args[0] === "rm" || args[0] === "rmi")).toBe(false);
    expect(f.start).toHaveBeenCalledOnce();
    const command = f.command.mock.calls[0][1];
    expect(command).toContain("resume"); expect(command).toContain("--last");
});
it.each(["tool", "state"])("stops before launch after %s setup failure without retrying a live container", async failure => {
    f.running = true; f.failTool = failure === "tool"; f.failState = failure === "state";
    await expect(main()).rejects.toThrow(failure === "tool" ? "tool unavailable" : "state inaccessible");
    expect(f.events).not.toContain("command"); expect(f.events).not.toContain("harness"); expect(f.start).toHaveBeenCalledOnce();
});
it("preserves upstream daemon-preparation failure status and cleans invocation state without launching", async () => {
    f.launchFailure = true;
    await expect(main()).rejects.toMatchObject({ status: 9 });
    expect(f.events).not.toContain("command");
    expect(f.events.slice(-3)).toEqual(["restore", "unlink", "cleanup"]);
});

it("cleans the environment file and session after post-command config lock failure", async () => {
    f.failPostExitLock = true;
    await expect(main()).rejects.toMatchObject({ status: 0 });
    expect(f.events).toContain("command");
    expect(f.events).toContain("unlink");
    expect(f.events).toContain("cleanup");
});

it("normalizes CCC_PROFILE=default before selecting config/state/Harness", async () => {
    vi.stubEnv("CCC_PROFILE", "default");
    await expect(main()).rejects.toMatchObject({ status: 0 });
    expect(f.prepare).toHaveBeenCalledWith("final-id", undefined);
    expect(f.state).toHaveBeenCalledWith("final-id", undefined);
    expect(f.harness).toHaveBeenCalledWith("final-id", undefined);
});

// Exercise exported main/runCli and the real cleanup policy. Acquisition and ACK
// are controlled ports here; native guardian authentication/EOF has separate tests.
it.each(["tool", "state", "config", "restore", "daemon"])("CLI error cleanup preserves existing running work after %s startup failure", async failure => {
    f.realCleanup = true; f.running = true;
    f.failTool = failure === "tool"; f.failState = failure === "state"; f.launchFailure = failure === "daemon";
    if (failure === "restore") f.restore.mockImplementation(() => { throw new Error("restore denied"); });
    if (failure === "config") f.prepare.mockImplementation(() => { throw new Error("config denied"); });
    await expect(runCli()).rejects.toMatchObject({ status: 1 });
    expect(f.events).not.toContain("command");
    expect(f.events.includes("unlink")).toBe(failure === "daemon");
    expect(getCurrentSession().lockFile).toBeNull();
    expect(f.devices).not.toHaveBeenCalled();
    expect(f.spawn.mock.calls.some(([, args]) => args[0] === "stop")).toBe(false);
});
it("CLI startup failure still cleans a container started by this invocation", async () => {
    f.realCleanup = true; f.failState = true;
    await expect(runCli()).rejects.toMatchObject({ status: 1 });
    expect(f.devices).toHaveBeenCalledOnce();
    expect(f.spawn).toHaveBeenCalledWith("docker", ["stop", "final-id"], { stdio: "ignore", timeout: 30_000, killSignal: "SIGKILL" });
    expect(getCurrentSession().lockFile).toBeNull();
});
it("a successfully launched session retains normal final container/device cleanup", async () => {
    f.realCleanup = true; f.running = true;
    await expect(main()).rejects.toMatchObject({ status: 0 });
    expect(f.events).toContain("command");
    expect(f.devices).toHaveBeenCalledOnce();
    expect(f.spawn).toHaveBeenCalledWith("docker", ["stop", "final-id"], { stdio: "ignore", timeout: 30_000, killSignal: "SIGKILL" });
});

it.each([false, true])("preserves another caller's running container after initial exists=%s", async exists => {
    f.realCleanup = true; f.running = false; f.exists = exists; f.handoffStarted = false; f.failState = true;
    await expect(runCli()).rejects.toMatchObject({ status: 1 });
    expect(f.start).toHaveBeenCalledOnce();
    expect(getCurrentSession().lockFile).toBeNull();
    expect(f.events).not.toContain("unlink");
    expect(f.devices).not.toHaveBeenCalled();
    expect(f.spawn.mock.calls.some(([, args]) => args[0] === "stop")).toBe(false);
});

it("retains this invocation's start authority across a later same-ID readiness handoff", async () => {
    f.realCleanup = true; f.failState = true;
    f.probeRunning.mockReturnValueOnce(false).mockReturnValue(true);
    f.start.mockImplementation((...args: unknown[]) => {
        (args[7] as (id: string, handoff: { startedByInvocation: boolean }) => void)("final-id", {
            startedByInvocation: f.start.mock.calls.length === 1,
        });
        return "ccc-fixture";
    });
    await expect(runCli()).rejects.toMatchObject({ status: 1 });
    expect(f.start).toHaveBeenCalledTimes(2);
    expect(f.devices).toHaveBeenCalledOnce();
    expect(f.spawn).toHaveBeenCalledWith("docker", ["stop", "final-id"], { stdio: "ignore", timeout: 30_000, killSignal: "SIGKILL" });
});

it("awaits the captured start acknowledgement before CLI cleanup after a helper failure", async () => {
    f.realCleanup = true;
    const cause = new Error("post-start helper failed");
    let acknowledge!: () => void;
    const acknowledgement = new Promise<void>(resolve => { acknowledge = resolve; });
    let reached!: () => void;
    const confirming = new Promise<void>(resolve => { reached = resolve; });
    f.confirm.mockImplementation(() => { f.events.push("confirm"); reached(); return acknowledgement; });
    f.start.mockImplementation((...args: unknown[]) => {
        (args[9] as (id: string) => void)("final-id");
        throw cause;
    });
    const launch = main();
    const rejected = expect(launch).rejects.toMatchObject({ cause });
    await confirming;
    expect(f.devices).not.toHaveBeenCalled();
    expect(f.events).not.toContain("cleanup");
    acknowledge();
    await rejected;
    // main preserves the setup cause; the real CLI error boundary owns cleanup.
    const { cleanupSession } = await import("../session.js");
    cleanupSession();
    expect(f.devices).toHaveBeenCalledOnce();
    expect(f.spawn).toHaveBeenCalledWith("docker", ["stop", "final-id"], { stdio: "ignore", timeout: 30_000, killSignal: "SIGKILL" });
});
