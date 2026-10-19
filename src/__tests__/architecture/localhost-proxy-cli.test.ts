import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { normalizeNativeRuntimeCall, preloadNativeRuntimeFixture } from "../helpers/native-runtime-fixture.js";
const f = vi.hoisted(() => ({
    home: "", reach: vi.fn(),
    events: [] as string[], running: false, exists: true, profile: undefined as string | undefined,
    handoffStarted: undefined as boolean | undefined,
    realCleanup: false, devices: vi.fn(),
    locked: false, failPostExitLock: false, failTool: false, failState: false, launchFailure: false,
    probeRunning: vi.fn(), spawn: vi.fn(), start: vi.fn(), prepare: vi.fn(), restore: vi.fn(), state: vi.fn(), harness: vi.fn(), confirm: vi.fn(), command: vi.fn(),
}));
vi.mock("os", async original => ({ ...await original<typeof import("os")>(), homedir: () => f.home }));
vi.mock("child_process", async original => ({ ...await original<typeof import("child_process")>(), spawnSync: (...args: unknown[]) => f.spawn(...normalizeNativeRuntimeCall(args)) }));
vi.mock("../../utils.js", async original => ({
    ...await original<typeof import("../../utils.js")>(),
    get DATA_DIR() { return join(f.home, ".ccc"); },
    collectForwardedEnv: () => ({ forwarded: [], skippedDueToLimit: [], totalBytes: 0 }),
    writeOwnedEnvFile: () => ({ path: "/fixture/exec.env", dispose: () => f.events.push("unlink") }),
}));
vi.mock("../../container-command.js", () => ({ runContainerCommand: f.command }));
vi.mock("../../docker.js", async original => ({
    ...await original<typeof import("../../docker.js")>(),
    ensureDockerRunning: vi.fn(), ensureCredentialHostDir: vi.fn(),
    inspectSessionContainerOwnership: () => ({ known: true, containerId: f.running ? "old-id" : null }),
    isDockerDesktop: () => false,
    getContainerName: () => "ccc-fixture", getContainerStatus: () => ({ exists: f.exists, running: f.running, imageId: "sha256:old", containerId: "old-id" }),
    startProjectContainer: f.start, isContainerRunning: f.probeRunning,
    prepareProjectContainerStartup: () => ({ start: f.start, initialize: () => {} }),
    restoreCodexConfigHostOwnership: f.restore, prepareCodexConfigForContainer: f.prepare,
    syncClipboardShims: () => f.events.push("clipboard"), ensureContainerManagerSocketAccess: vi.fn(),
}));
vi.mock("../../container-runtime.js", async original => ({ ...await original<typeof import("../../container-runtime.js")>(),
    // Runtime facts are explicit here; emitted integration owns native scope lifetime.
    runWithNativeRuntimeInvocation: <T>(_invocation: unknown, operation: () => T): T => operation(),
    runtimeCli: () => "podman", isContainerHostRemote: () => true, deviceBrokerBindHostForContainer: () => "127.0.0.1" }));
vi.mock("../../worktree.js", async original => ({ ...await original<typeof import("../../worktree.js")>(), detectWorktreeWorkspaceBranch: () => null, getWorktreeGitMounts: () => [] }));
vi.mock("../../profile.js", async original => ({ ...await original<typeof import("../../profile.js")>(), profileExists: () => true }));
vi.mock("../../clipboard-server.js", () => ({ ensureClipboardSelection: async () => null, validateClipboardSelection: async (selection: null, guard: import("../../ports/runtime-bind-authority.js").RuntimeBindGuard) => { expect(guard.root).toBe(join(f.home, ".ccc")); return selection; }, hasAnyActiveSessionsExcept: () => false, retireClipboardServerFromPortFile: vi.fn() }));
vi.mock("../../home-layout.js", async original => ({ ...await original<typeof import("../../home-layout.js")>(), ensureDefaultProfileDir: vi.fn(), migrateHomeLayout: () => f.events.push("layout") }));
vi.mock("../../home-layout-container-guard.js", () => ({ hasLegacyHomeLayoutContainerMounts: () => false }));
vi.mock("@ccc/device-lab/device-lab-broker.js", () => ({ DEVICE_BROKER_DEFAULT_HOST: "127.0.0.1", ensureHostDeviceBroker: async () => ({ ok: true }) }));
vi.mock("../../device-lab-admin.js", () => ({ cleanupOwnerDevices: f.devices }));
vi.mock("../../session.js", async original => {
    const actual = await original<typeof import("../../session.js")>();
    const { locksDir } = await import("../../home-layout.js");
    const { getProjectId } = await import("../../utils.js");
    const { encodeSessionClaim, sessionClaimName, sessionClaimPrefix } = await import("../../domain/session-claims.js");
    return { ...actual,
    acquireHostSessionOwnership: async (request: import("../../ports/session-acquisition.js").SessionAcquisitionRequest) => {
        const directory = locksDir();
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const lockFile = join(directory, sessionClaimName(sessionClaimPrefix(getProjectId(request.projectPath), request.profile), "fixture"));
        writeFileSync(lockFile, encodeSessionClaim(process.pid, null, "direct"), { mode: 0o600, flag: "wx" });
        actual.setSession(lockFile, request.projectPath, request.profile, request.toolName);
        actual.setSessionCleanupEnabled(false);
        return { lockFile, existingId: f.running ? "old-id" : null };
    },
    beginSessionStartupInHeldLifecycleLock: () => actual.setSessionCleanupEnabled(false),
    recordSessionOwnStartInHeldLifecycleLock: (id: string) => { actual.setSessionContainerId(id); actual.setSessionCleanupEnabled(true); },
    publishSessionReadyInHeldLifecycleLock: (id: string, handoff: { startedByInvocation: boolean }) => { actual.setSessionContainerId(id); actual.setSessionCleanupEnabled(handoff.startedByInvocation); },
    confirmSessionOwnership: f.confirm,
    setupSignalHandlers: vi.fn(),
    getActiveSessionsForContainer: () => [], cleanupSession: () => { f.events.push("cleanup"); if (f.realCleanup) actual.cleanupSession(); },
    withContainerLifecycleLock: (_key: string, operation: () => unknown) => operation(),
    withContainerSetupLockAsync: async (_key: string, operation: () => unknown) => operation(),
}; });
vi.mock("../../container-setup.js", () => ({
    CLAUDE_BIN_PATH: "/home/ccc/.local/bin/claude", ensureUvAvailable: () => f.events.push("uv"),
    ensureClaudeInContainer: (id: string) => { expect(id).toBe("final-id"); f.events.push("claude-ready"); },
    ensureTools: (_id: string, tool: {name: string}) => f.events.push(`tool:${tool.name}`),
}));
vi.mock("../../codex-config-lock.js", async original => {
    const actual = await original<typeof import("../../codex-config-lock.js")>();
    return { withCodexConfigLock: <T>(operation: () => T, profile?: string): T => {
        expect(profile).toBe(f.profile); expect(f.locked).toBe(false);
        return actual.withCodexConfigLock(() => {
            f.locked = true; f.events.push("lock");
            try { return operation(); } finally { f.locked = false; f.events.push("unlock"); }
        }, profile);
    } };
});
vi.mock("../../codex-state-ownership.js", () => ({ assertCodexStateAccessible: f.state }));
vi.mock("../../codex-harness.js", () => ({ ensureCodexHarness: f.harness }));
vi.mock("../../network-reach.js", () => ({ detectHostNetworkReach: f.reach }));
vi.mock("../../mcp-forward.js", () => ({ buildMcpConfig: () => [] }));
vi.mock("../../codex-clipboard-image.js", () => ({ maybeAttachCodexClipboardImage: async (_path: string, args: string[]) => ({ args }) }));
vi.mock("../../codex-launch.js", async original => ({ ...await original<typeof import("../../codex-launch.js")>(), prepareCodexLaunchSemantic: (_runtime: string, args: string[], command: string[]) => {
    expect(args).toContain("final-id"); f.events.push("launch-preparation");
    return f.launchFailure ? { ok: false, status: 9, reason: "engine-unavailable", cause: "daemon unavailable", command } : { ok: true, command };
} }));
import { clearSession } from "../../session.js";
import * as runtime from "../../container-runtime.js";
import { main } from "../../index.js";
class Exit extends Error { constructor(readonly status: number) { super(`exit ${status}`); } }
const originalArgv = process.argv;
beforeEach(() => {
    f.home = mkdtempSync(join(tmpdir(), "ccc-proxy-cli-"));
    clearSession(); f.realCleanup = false; f.handoffStarted = undefined;
    vi.clearAllMocks(); vi.stubEnv("CCC_PROFILE", ""); vi.stubEnv("DEBUG", ""); vi.stubEnv("container", "");
    preloadNativeRuntimeFixture(runtime, { runtime: "podman", flavor: "podman-machine", remote: true });
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
        expect(args[10]).toMatchObject({ root: join(f.home, ".ccc") });
        const started = f.handoffStarted ?? !f.running;
        if (started) (args[9] as (id: string) => void)("final-id");
        (args[7] as (id: string, handoff: { startedByInvocation: boolean }) => void)("final-id", { startedByInvocation: started }); return "ccc-fixture"; });
    f.restore.mockImplementation((id, profile) => { expect(id).toBe("final-id"); expect(profile).toBe(f.profile); expect(f.locked).toBe(true); f.events.push("restore"); });
    f.prepare.mockImplementation((id, profile) => { expect(id).toBe("final-id"); expect(profile).toBe(f.profile); expect(f.locked).toBe(true); f.events.push("prepare"); });
    f.state.mockImplementation((id, profile) => { expect(id).toBe("final-id"); expect(profile).toBe(f.profile); f.events.push("state"); if (f.failState) throw new Error("state inaccessible"); });
    f.harness.mockImplementation((id, profile) => { expect(id).toBe("final-id"); expect(profile).toBe(f.profile); f.events.push("harness"); });
    f.spawn.mockImplementation((_runtime, args: string[]) => { if (args.includes("codex")) f.events.push("command"); return { status: 0, stdout: "", stderr: "" }; });
});
afterEach(() => { runtime._resetRuntimeCacheForTest(); rmSync(f.home, { recursive: true, force: true }); process.argv = originalArgv; vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const cases = [false, true].flatMap(running => ["codex", "claude"].map(tool => ({ running, tool })));
it.each(cases)("actual CLI verifier: running=$running tool=$tool", async ({ running, tool }) => {
    f.running = running; process.argv = [process.execPath, "ccc", tool];
    f.reach.mockImplementation((container: string, options: unknown) => {
        f.events.push("actual-proxy-reach"); expect(container).toBe("final-id"); expect(options).toEqual({timeoutMs:1500});
        return {reachable:false};
    });
    f.spawn.mockImplementation((runtime: string, args: string[]) => {
        if (args[0] === "exec" && args[2] === "bash" && args[3] === "-c" && args[4].includes("/proc/net/tcp")) {
            expect(runtime).toBe("podman"); f.events.push("actual-proxy-listener");
            expect(args[4]).toContain("0100007F:4E1F"); return {status:0,stdout:"",stderr:""};
        }
        return {status:0,stdout:"",stderr:""};
    });
    await expect(main()).rejects.toMatchObject({status:0});
    expect(f.reach.mock.calls).toHaveLength(running ? 0 : 1);
    expect(f.events.filter(event => event === "actual-proxy-listener")).toHaveLength(running ? 0 : 1);
    if (!running) {
        expect(f.events.indexOf("actual-proxy-listener")).toBeGreaterThan(f.events.indexOf("actual-proxy-reach"));
        expect(f.events.indexOf("actual-proxy-listener")).toBeLessThan(f.events.indexOf(`tool:${tool}`));
    }
    expect(f.events).toContain("command");
});

