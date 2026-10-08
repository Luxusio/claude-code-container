import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({
    home: "", claude: "", codex: "", restorePositions: [] as boolean[],
    events: [] as string[], running: false, exists: true, profile: undefined as string | undefined,
    handoffStarted: undefined as boolean | undefined,
    realCleanup: false, devices: vi.fn(),
    locked: false, failPostExitLock: false, failTool: false, failState: false, launchFailure: false,
    probeRunning: vi.fn(), spawn: vi.fn(), start: vi.fn(), prepare: vi.fn(), restore: vi.fn(), state: vi.fn(), harness: vi.fn(), confirm: vi.fn(), command: vi.fn(),
}));
vi.mock("os", async original => ({ ...await original<typeof import("os")>(), homedir: () => f.home }));
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
vi.mock("../../utils.js", async original => ({
    ...await original<typeof import("../../utils.js")>(),
    get DATA_DIR() { return join(f.home, ".ccc"); },
    collectForwardedEnv: () => ({ forwarded: [], skippedDueToLimit: [], totalBytes: 0 }),
    writeOwnedEnvFile: () => ({ path: "/fixture/exec.env", dispose: () => f.events.push("unlink") }),
}));
vi.mock("../../container-command.js", () => ({ runContainerCommand: f.command }));
vi.mock("../../docker.js", () => ({
    ensureDockerRunning: vi.fn(), ensureCredentialHostDir: vi.fn(),
    getContainerName: () => "ccc-fixture", getContainerStatus: () => ({ exists: f.exists, running: f.running, imageId: "sha256:old", containerId: "old-id" }),
    startProjectContainer: f.start, isContainerRunning: f.probeRunning,
    restoreCodexConfigHostOwnership: f.restore, prepareCodexConfigForContainer: f.prepare,
    syncClipboardShims: () => f.events.push("clipboard"), ensureContainerManagerSocketAccess: vi.fn(),
}));
vi.mock("../../container-runtime.js", async original => ({ ...await original<typeof import("../../container-runtime.js")>(), runtimeCli: () => "docker", deviceBrokerBindHostForContainer: () => "127.0.0.1" }));
vi.mock("../../worktree.js", async original => ({ ...await original<typeof import("../../worktree.js")>(), detectWorktreeWorkspaceBranch: () => null, getWorktreeGitMounts: () => [] }));
vi.mock("../../profile.js", async original => ({ ...await original<typeof import("../../profile.js")>(), profileExists: () => true }));
vi.mock("../../clipboard-server.js", () => ({ ensureClipboardServer: async () => null, hasAnyActiveSessionsExcept: () => false, retireClipboardServerFromPortFile: vi.fn() }));
vi.mock("../../home-layout.js", async original => ({ ...await original<typeof import("../../home-layout.js")>(), ensureDefaultProfileDir: vi.fn(), migrateHomeLayout: () => f.events.push("layout") }));
vi.mock("../../home-layout-container-guard.js", () => ({ hasLegacyHomeLayoutContainerMounts: () => false }));
vi.mock("@ccc/device-lab/device-lab-broker.js", () => ({ DEVICE_BROKER_DEFAULT_HOST: "127.0.0.1", ensureHostDeviceBroker: async () => ({ ok: true }) }));
vi.mock("../../device-lab-admin.js", () => ({ cleanupOwnerDevices: f.devices }));
vi.mock("../../session.js", async original => {
    const actual = await original<typeof import("../../session.js")>();
    return { ...actual,
    acquireHostSessionOwnership: async (request: import("../../ports/session-acquisition.js").SessionAcquisitionRequest) => {
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
vi.mock("../../container-setup.js", () => ({
    CLAUDE_BIN_PATH: "/home/ccc/.local/bin/claude", ensureUvAvailable: () => f.events.push("uv"),
    ensureClaudeInContainer: (id: string) => { expect(id).toBe("final-id"); f.events.push("claude-ready"); },
    ensureTools: (id: string, tool: {name: string}) => { expect(id).toBe("final-id"); expect(readFileSync(f.codex, "utf8")).toContain('url = "http://host.docker.internal:8181/sse"'); expect(JSON.parse(readFileSync(f.claude, "utf8")).mcpServers.forwarded.url).toBe("http://host.docker.internal:8181/sse"); expect(f.restorePositions).toEqual([false, false]); f.events.push(`tool:${tool.name}`); if (f.failTool) throw new Error("tool unavailable"); },
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
vi.mock("../../localhost-proxy-setup.js", () => ({ setupLocalhostProxy: () => f.events.push("proxy") }));
vi.mock("../../codex-clipboard-image.js", () => ({ maybeAttachCodexClipboardImage: async (_path: string, args: string[]) => ({ args }) }));
vi.mock("../../codex-launch.js", () => ({ prepareCodexLaunch: (_runtime: string, args: string[], command: string[]) => {
    expect(args).toContain("final-id"); f.events.push("launch-preparation");
    return f.launchFailure ? { ok: false, status: 9, error: "daemon unavailable" } : { ok: true, command };
} }));
import { clearSession } from "../../session.js";
import { main } from "../../index.js";
class Exit extends Error { constructor(readonly status: number) { super(`exit ${status}`); } }
const originalArgv = process.argv;
beforeEach(() => {
    f.home = mkdtempSync(join(tmpdir(), "ccc-mcp-cli-")); f.restorePositions = [];
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
    f.restore.mockImplementation((id, profile) => { expect(id).toBe("final-id"); expect(profile).toBe(f.profile); expect(f.locked).toBe(true); f.restorePositions.push(existsSync(f.codex)); f.events.push("restore"); });
    f.prepare.mockImplementation((id, profile) => { expect(id).toBe("final-id"); expect(profile).toBe(f.profile); expect(f.locked).toBe(true); f.events.push("prepare"); });
    f.state.mockImplementation((id, profile) => { expect(id).toBe("final-id"); expect(profile).toBe(f.profile); f.events.push("state"); if (f.failState) throw new Error("state inaccessible"); });
    f.harness.mockImplementation((id, profile) => { expect(id).toBe("final-id"); expect(profile).toBe(f.profile); f.events.push("harness"); });
    f.spawn.mockImplementation((_runtime, args: string[]) => { if (args.includes("codex")) f.events.push("command"); return { status: 0, stdout: "", stderr: "" }; });
});
afterEach(() => { rmSync(f.home, { recursive: true, force: true }); process.argv = originalArgv; vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const cases = [false, true].flatMap(running => ["codex", "claude"].flatMap(tool => [undefined, "work"].map(profile => ({ running, tool, profile }))));
it.each(cases)("actual CLI regeneration: running=$running tool=$tool profile=$profile", async ({ running, tool, profile }) => {
    f.running = running; f.profile = profile; vi.stubEnv("CCC_PROFILE", profile ?? "");
    process.argv = [process.execPath, "ccc", tool];
    const { getClaudeJsonFile, getCodexConfigFile } = await import("../../utils.js");
    f.claude = getClaudeJsonFile(profile); f.codex = getCodexConfigFile(profile);
    mkdirSync(dirname(f.claude), { recursive: true });
    writeFileSync(join(f.home, ".claude.json"), '{"mcpServers":{"forwarded":{"url":"http://localhost:8181/sse"}}}');
    await expect(main()).rejects.toMatchObject({ status: 0 });
    expect(readFileSync(f.codex, "utf8")).toContain("[mcp_servers.device-lab]");
    expect(JSON.parse(readFileSync(f.claude, "utf8")).mcpServers["device-lab"].args).toContain("/opt/ccc/dist/device-lab-mcp/server.mjs");
    expect(f.events.includes("uv")).toBe(!running);
    expect(f.events).toContain(`tool:${tool}`);
    expect(f.restorePositions.slice(0, 2)).toEqual([false, false]);
    expect(f.events.slice(0, f.events.indexOf(`tool:${tool}`)).filter(value => value === "restore")).toHaveLength(2);
    expect(f.restorePositions.slice(2).every(value => value)).toBe(true);
    expect(f.events.indexOf("command")).toBeGreaterThan(f.events.indexOf(`tool:${tool}`));
});
