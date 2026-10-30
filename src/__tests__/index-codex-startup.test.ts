import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const f = vi.hoisted(() => ({
    home: "",
    finalId: "f".repeat(64), oldId: "e".repeat(64), setupId: "d".repeat(64),
    events: [] as string[], running: false, exists: true, profile: undefined as string | undefined,
    handoffStarted: undefined as boolean | undefined,
    realCleanup: false, devices: vi.fn(), envCreationFailure: false,
    forwarded: [] as Array<[string, string]>, envEntries: [] as Array<[string, string]>,
    locked: false, failPostExitLock: false, failTool: false, failState: false, launchFailure: false,
    probeRunning: vi.fn(), spawn: vi.fn(), start: vi.fn(), prepare: vi.fn(), restore: vi.fn(), state: vi.fn(), harness: vi.fn(), claude: vi.fn(), confirm: vi.fn(), command: vi.fn(), clipboard: vi.fn(), socket: vi.fn(),
}));
vi.mock("os", async original => ({ ...await original<typeof import("os")>(), homedir: () => f.home }));
vi.mock("child_process", async original => ({ ...await original<typeof import("child_process")>(), spawnSync: (...args: unknown[]) => f.spawn(...logicalNativeCall(args)) }));

function logicalNativeCall(call: unknown[]): unknown[] {
    const [program, args, options] = call;
    if (program !== "/fixture/runtime/docker") return call;
    const prefix = ["--config", "/fixture/config", "--host", "unix:///fixture/engine.sock", "--tls=false", "--tlscacert=", "--tlscert=", "--tlskey="];
    expect((args as string[]).slice(0, prefix.length)).toEqual(prefix);
    const {env, shell, ...logicalOptions} = options as import("child_process").SpawnSyncOptions;
    expect(shell).toBe(false);
    expect(env?.DOCKER_CONTEXT).toBeUndefined();
    return ["docker", (args as string[]).slice(prefix.length), logicalOptions];
}
vi.mock("../utils.js", async original => ({
    ...await original<typeof import("../utils.js")>(),
    get DATA_DIR() { return join(f.home, ".ccc"); },
    collectForwardedEnv: () => ({ forwarded: f.forwarded, skippedDueToLimit: [], totalBytes: 0 }),
    writeOwnedEnvFile: (entries: Array<[string, string]>) => { if (f.envCreationFailure) throw new Error("environment creation denied"); f.envEntries = entries; return { path: "/fixture/exec.env", dispose: () => f.events.push("unlink") }; },
}));
vi.mock("../container-command.js", () => ({ runContainerCommand: f.command }));
vi.mock("../docker.js", async original => ({
    withProjectContainerStateLockAsync: (await original<typeof import("../docker.js")>()).withProjectContainerStateLockAsync,
    ensureDockerRunning: vi.fn(), ensureCredentialHostDir: vi.fn(),
    inspectSessionContainerOwnership: () => ({ known: true, containerId: f.exists ? f.oldId : null }),
    isDockerDesktop: () => false,
    getContainerName: () => "ccc-fixture", getContainerStatus: () => ({ exists: f.exists, running: f.running, imageId: "sha256:old", containerId: f.oldId }),
    startProjectContainer: f.start, isContainerRunning: f.probeRunning,
    prepareProjectContainerStartup: () => ({ start: f.start, initialize: () => {} }),
    restoreCodexConfigHostOwnership: f.restore, prepareCodexConfigForContainer: f.prepare,
    syncClipboardShims: f.clipboard, ensureContainerManagerSocketAccess: f.socket,
}));
vi.mock("../container-runtime.js", async original => {
    const actual = await original<typeof import("../container-runtime.js")>();
    const { NATIVE_RUNTIME_SELECTOR_KEYS } = await import("../ports/container-runtime-invocation.js");
    const invocation = actual.validateNativeRuntimeInvocation({
        version: 1, runtime: "docker", executable: "/fixture/runtime/docker",
        transport: { kind: "docker", host: "unix:///fixture/engine.sock", configDirectory: "/fixture/config",
            tls: { enabled: false, verify: false, caFile: null, certFile: null, keyFile: null } },
        selectors: Object.fromEntries(NATIVE_RUNTIME_SELECTOR_KEYS.map(key => [key, null])),
    });
    const runner = () => { const capturedCli = "docker"; return { invocation,
        spawnSync: (args: readonly string[], options?: import("child_process").SpawnSyncOptions) => f.spawn(capturedCli, args, options),
    }; };
    return { ...actual, runtimeCli: () => "docker", deviceBrokerBindHostForContainer: () => "127.0.0.1",
        getRuntimeInvocation: () => invocation, bindNativeRuntimeInvocation: runner,
        runtimeSpawnSync: (args: readonly string[], options?: import("child_process").SpawnSyncOptions) => runner().spawnSync(args, options),
        runWithNativeRuntimeInvocation: <T>(_invocation: unknown, operation: () => T): T => operation() };
});
vi.mock("../worktree.js", async original => ({ ...await original<typeof import("../worktree.js")>(), detectWorktreeWorkspaceBranch: () => null, getWorktreeGitMounts: () => [] }));
vi.mock("../profile.js", async original => ({ ...await original<typeof import("../profile.js")>(), profileExists: () => true }));
vi.mock("../clipboard-server.js", () => ({ ensureClipboardSelection: async () => null, validateClipboardSelection: async (selection: null, guard: import("../ports/runtime-bind-authority.js").RuntimeBindGuard) => { expect(guard.root).toBe(join(f.home, ".ccc")); return selection; }, hasAnyActiveSessionsExcept: () => false, retireClipboardServerFromPortFile: vi.fn() }));
vi.mock("../home-layout.js", async original => ({ ...await original<typeof import("../home-layout.js")>(), ensureDefaultProfileDir: vi.fn(), migrateHomeLayout: () => f.events.push("layout") }));
vi.mock("../home-layout-container-guard.js", () => ({ hasLegacyHomeLayoutContainerMounts: () => false }));
vi.mock("@ccc/device-lab/device-lab-broker.js", () => ({ DEVICE_BROKER_DEFAULT_HOST: "127.0.0.1", ensureHostDeviceBroker: async () => ({ ok: true }) }));
vi.mock("../device-lab-admin.js", () => ({ cleanupOwnerDevices: f.devices }));
vi.mock("../device-lab-cleanup.js", () => ({ cleanupOwnerDevices: f.devices }));
vi.mock("../session.js", async original => {
    const actual = await original<typeof import("../session.js")>();
    const { locksDir } = await import("../home-layout.js");
    const { getProjectId } = await import("../utils.js");
    const { encodeSessionClaim, sessionClaimName, sessionClaimPrefix } = await import("../domain/session-claims.js");
    const { currentSessionClaimAuthority } = await import("../domain/session-claim-observation.js");
    const { createNativeSessionClaimObservationStore } = await import("../adapters/session-claim-observation.js");
    const { captureNativeSessionOwnership } = await import("../adapters/session-ownership.js");
    const { getRuntimeInvocation } = await import("../container-runtime.js");
    const { processStartToken } = await import("../session-lock-liveness.js");
    const observations = createNativeSessionClaimObservationStore();
    let snapshot: import("../ports/session-claim-observation.js").SessionClaimObservationSnapshot | null = null;
    let generation = 0, sequence = 0, containerId: string | null = null;
    const current = () => {
        if (!snapshot) throw new Error("Fixture session has no captured guardian observation");
        observations.assertCurrent(snapshot);
        return snapshot;
    };
    const write = (observation: import("../domain/session-claim-observation.js").SessionClaimObservation) => {
        snapshot = observations.update(current(), observation);
    };
    const stageUpdate = (id: string | null, cleanupEnabled: boolean) => {
        const previous = current().observation;
        const nextGeneration = String(++generation);
        write({ ...previous, generation: nextGeneration,
            pending: { kind: "update", generation: nextGeneration, sequence: ++sequence, containerId: id, cleanupEnabled },
            ownStarted: cleanupEnabled && previous.ownStarted?.containerId === id && id !== null
                ? { generation: nextGeneration, containerId: id } : null });
    };
    return { ...actual,
    acquireHostSessionOwnership: async (request: import("../ports/session-acquisition.js").SessionAcquisitionRequest) => {
        const directory = locksDir();
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const prefix = sessionClaimPrefix(getProjectId(request.projectPath), request.profile);
        return actual.withContainerLifecycleLock(prefix, () => {
            const lockFile = join(directory, sessionClaimName(prefix, "fixture"));
            const startToken = processStartToken(process.pid);
            writeFileSync(lockFile, encodeSessionClaim(process.pid, startToken, "monitored"), { mode: 0o600, flag: "wx" });
            actual.setSession(lockFile, request.projectPath, request.profile, request.toolName);
            actual.setSessionCleanupEnabled(false);
            generation = 0; sequence = 0; containerId = null;
            snapshot = observations.begin({ receipt: captureNativeSessionOwnership(lockFile),
                binding: { lockFile, projectPath: request.projectPath, profile: request.profile, toolName: request.toolName, prefix },
                runtimeInvocation: getRuntimeInvocation(), guardian: { pid: process.pid, startToken }, generation: "0" });
            write({ ...snapshot.observation, registration: "ready" });
            return { lockFile, existingId: f.running ? f.oldId : null };
        });
    },
    // READY/ACK transport is controlled here. Main/runtime/guardian files,
    // receipt qualification, authority decoding and final cleanup stay native.
    beginSessionStartupInHeldLifecycleLock: () => {
        const previous = current().observation;
        const nextGeneration = String(++generation);
        write({ ...previous, generation: nextGeneration,
            pending: { kind: "startup", generation: nextGeneration, sequence, containerId: null, cleanupEnabled: false }, ownStarted: null });
        actual.setSessionCleanupEnabled(false);
    },
    recordSessionOwnStartInHeldLifecycleLock: (id: string) => {
        const previous = current().observation;
        const nextGeneration = String(++generation);
        write({ ...previous, generation: nextGeneration,
            pending: { kind: "startup", generation: nextGeneration, sequence, containerId: id, cleanupEnabled: true },
            ownStarted: { generation: nextGeneration, containerId: id } });
        expect(currentSessionClaimAuthority(current().observation)).toEqual({ containerId: id, source: "own-start" });
        containerId = id; actual.setSessionContainerId(id); actual.setSessionCleanupEnabled(true);
    },
    publishSessionReadyInHeldLifecycleLock: (id: string, handoff: { startedByInvocation: boolean }) => {
        stageUpdate(id, handoff.startedByInvocation);
        containerId = id; actual.setSessionContainerId(id); actual.setSessionCleanupEnabled(handoff.startedByInvocation);
    },
    setSessionCleanupEnabled: (enabled: boolean) => {
        actual.withContainerLifecycleLock(current().observation.binding.prefix, () => stageUpdate(containerId, enabled));
        actual.setSessionCleanupEnabled(enabled);
    },
    confirmSessionOwnership: async () => {
        await f.confirm();
        actual.withContainerLifecycleLock(current().observation.binding.prefix, () => {
            const previous = current().observation, pending = previous.pending;
            if (pending?.kind !== "update") return;
            write({ ...previous, pending: null, lastAcknowledged: {
                generation: pending.generation, sequence: pending.sequence, containerId: pending.containerId, cleanupEnabled: pending.cleanupEnabled,
            } });
            expect(currentSessionClaimAuthority(current().observation)?.containerId ?? null).toBe(pending.cleanupEnabled ? pending.containerId : null);
        });
    },
    setupSignalHandlers: vi.fn(),
    getActiveSessionsForContainer: () => [], cleanupSession: () => {
        f.events.push("cleanup");
        if (f.realCleanup) {
            const claim = actual.getCurrentSession().lockFile;
            if (claim) expect(current().receipt.path).toBe(claim);
            actual.cleanupSession();
            if (claim) expect([claim, `${claim}.guardian.json`, `${claim}.runtime.json`].some(existsSync)).toBe(false);
            snapshot = null;
        }
    },
    withContainerLifecycleLock: (_key: string, operation: () => unknown) => operation(),
    withContainerSetupLockAsync: async (_key: string, operation: () => unknown) => operation(),
}; });
vi.mock("../container-setup.js", () => ({
    CLAUDE_BIN_PATH: "/home/ccc/.local/bin/claude", ensureUvAvailable: () => f.events.push("uv"),
    ensureClaudeInContainer: f.claude,
    ensureTools: (id: string, tool: {name: string}) => { expect(id).toBe(f.finalId); f.events.push(`tool:${tool.name}`); if (f.failTool) throw new Error("tool unavailable"); },
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
vi.mock("../codex-launch.js", async original => ({ ...await original<typeof import("../codex-launch.js")>(), prepareCodexLaunchSemantic: (_runtime: string, args: string[], command: string[]) => {
    expect(args).toContain(f.finalId); f.events.push("launch-preparation");
    return f.launchFailure ? { ok: false, status: 9, reason: "engine-unavailable" } : { ok: true, command };
} }));
import { clearSession, getCurrentSession } from "../session.js";
import { main, runCli } from "../index.js";
import { createNativeContainerExecPorts } from "../composition/container-exec.js";
import { createContainerExec } from "../application/container-exec.js";
class Exit extends Error { constructor(readonly status: number) { super(`exit ${status}`); } }
const originalArgv = process.argv;
beforeEach(() => {
    f.home = mkdtempSync(join(tmpdir(), "ccc-index-codex-startup-"));
    mkdirSync(join(f.home, ".ccc"), { mode: 0o700 });
    clearSession(); f.realCleanup = false; f.envCreationFailure = false; f.handoffStarted = undefined;
    vi.clearAllMocks(); vi.stubEnv("CCC_PROFILE", ""); vi.stubEnv("DEBUG", ""); vi.stubEnv("container", "");
    process.argv = [process.execPath, "ccc", "codex", "resume", "--last"];
    f.events = []; f.forwarded = []; f.envEntries = []; f.running = false; f.exists = true; f.profile = undefined; f.locked = false; f.failPostExitLock = false; f.failTool = false; f.failState = false; f.launchFailure = false;
    vi.spyOn(process, "exit").mockImplementation(code => { throw new Exit(Number(code)); });
    vi.spyOn(process.stderr, "write").mockReturnValue(true); vi.spyOn(console, "error").mockImplementation(() => {});
    f.probeRunning.mockReturnValue(true);
    f.clipboard.mockImplementation(() => { f.events.push("clipboard"); });
    f.socket.mockImplementation(() => { f.events.push("socket"); });
    f.confirm.mockImplementation(async () => { f.events.push("confirm"); });
    f.command.mockImplementation(async (_runtime: string, args: string[]) => {
        expect(args).toContain(f.finalId);
        expect(f.events.at(-1)).toBe("confirm");
        f.events.push("command"); return 0;
    });
    f.start.mockImplementation((...args: unknown[]) => { f.events.push("start");
        expect(args[10]).toMatchObject({ root: join(f.home, ".ccc") });
        const started = f.handoffStarted ?? !f.running;
        if (started) (args[9] as (id: string) => void)(f.finalId);
        (args[7] as (id: string, handoff: { startedByInvocation: boolean }) => void)(f.finalId, { startedByInvocation: started }); return "ccc-fixture"; });
    f.restore.mockImplementation((id, profile) => { expect(id).toBe(f.finalId); expect(profile).toBe(f.profile); expect(f.locked).toBe(true); f.events.push("restore"); });
    f.prepare.mockImplementation((id, profile) => { expect(id).toBe(f.finalId); expect(profile).toBe(f.profile); expect(f.locked).toBe(true); f.events.push("prepare"); });
    f.state.mockImplementation((id, profile) => { expect(id).toBe(f.finalId); expect(profile).toBe(f.profile); f.events.push("state"); if (f.failState) throw new Error("state inaccessible"); });
    f.claude.mockImplementation((id: string) => { expect(id).toBe(f.finalId); f.events.push("claude"); });
    f.harness.mockImplementation((id, profile) => { expect(id).toBe(f.finalId); expect(profile).toBe(f.profile); f.events.push("harness"); });
    f.spawn.mockImplementation((runtime: string, args: string[]) => {
        if (args.includes("codex")) f.events.push("command");
        const stdout = runtime === "docker" && JSON.stringify(args) === JSON.stringify(["ps", "-aq", "--no-trunc", "-f", `id=${f.finalId}`])
            ? `${f.finalId}\n` : "";
        return { status: 0, stdout, stderr: "" };
    });
});
afterEach(() => { rmSync(f.home, { recursive: true, force: true }); process.argv = originalArgv; vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it.each([false, true])("preserves final-ID Codex setup and resume ordering when initially running=%s", async running => {
    f.running = running; f.profile = "work"; vi.stubEnv("CCC_PROFILE", "work");
    await expect(main()).rejects.toMatchObject({ status: 0 });
    const ordered = ["start", "mcp", "tool:codex", "prepare", "state", "harness", "clipboard", "launch-preparation", "command"];
    for (let i=1;i<ordered.length;i++) expect(f.events.indexOf(ordered[i])).toBeGreaterThan(f.events.indexOf(ordered[i-1]));
    expect(f.events.includes("uv")).toBe(!running);
    expect(f.events.slice(-4)).toEqual(["command", "restore", "unlink", "cleanup"]);
    expect(f.spawn.mock.calls.some(([, args]) => args[0] === "rm" || args[0] === "rmi")).toBe(false);
    expect(f.start).toHaveBeenCalledOnce();
    expect(f.claude).not.toHaveBeenCalled();
    const command = f.command.mock.calls[0][1];
    expect(command).toContain("resume"); expect(command).toContain("--last");
    expect(f.clipboard).toHaveBeenCalledWith(f.finalId, expect.any(String));
    expect(f.socket).toHaveBeenCalledWith(f.finalId);
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

it("public dispatch uses the replacement ID for clipboard, socket access and the requested command", async () => {
    let first = true;
    f.probeRunning.mockReturnValueOnce(false).mockReturnValue(true);
    f.restore.mockImplementation(() => { f.events.push("restore"); });
    f.start.mockImplementation((...args: unknown[]) => {
        const id = first ? f.setupId : f.finalId; first = false;
        (args[9] as (id: string) => void)(id);
        (args[7] as (id: string, handoff: { startedByInvocation: boolean }) => void)(id, { startedByInvocation: true });
        return "ccc-fixture";
    });
    await expect(main()).rejects.toMatchObject({ status: 0 });
    expect(f.clipboard).toHaveBeenCalledWith(f.finalId, expect.any(String));
    expect(f.socket).toHaveBeenCalledWith(f.finalId);
    expect(f.command.mock.calls[0][1]).toContain(f.finalId);
    expect(f.command.mock.calls[0][1]).not.toContain(f.setupId);
});

it("public command failure disposes its owned environment artifact and cleans the session", async () => {
    const failure = new Error("container command failed");
    f.command.mockRejectedValue(failure);
    await expect(main()).rejects.toBe(failure);
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
    expect(f.prepare).toHaveBeenCalledWith(f.finalId, undefined);
    expect(f.state).toHaveBeenCalledWith(f.finalId, undefined);
    expect(f.harness).toHaveBeenCalledWith(f.finalId, undefined);
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
    expect(f.spawn).toHaveBeenCalledWith("docker", ["stop", f.finalId], { stdio: "ignore", timeout: 30_000, killSignal: "SIGKILL" });
    expect(getCurrentSession().lockFile).toBeNull();
});
it("a successfully launched session retains normal final container/device cleanup", async () => {
    f.realCleanup = true; f.running = true;
    await expect(main()).rejects.toMatchObject({ status: 0 });
    expect(f.events).toContain("command");
    expect(f.devices).toHaveBeenCalledOnce();
    expect(f.spawn).toHaveBeenCalledWith("docker", ["stop", f.finalId], { stdio: "ignore", timeout: 30_000, killSignal: "SIGKILL" });
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
        (args[7] as (id: string, handoff: { startedByInvocation: boolean }) => void)(f.finalId, {
            startedByInvocation: f.start.mock.calls.length === 1,
        });
        return "ccc-fixture";
    });
    await expect(runCli()).rejects.toMatchObject({ status: 1 });
    expect(f.start).toHaveBeenCalledTimes(2);
    expect(f.devices).toHaveBeenCalledOnce();
    expect(f.spawn).toHaveBeenCalledWith("docker", ["stop", f.finalId], { stdio: "ignore", timeout: 30_000, killSignal: "SIGKILL" });
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
        (args[9] as (id: string) => void)(f.finalId);
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
    expect(f.spawn).toHaveBeenCalledWith("docker", ["stop", f.finalId], { stdio: "ignore", timeout: 30_000, killSignal: "SIGKILL" });
});


it("public Claude startup verifies the final container and runs without Codex Harness", async () => {
    const argumentsToClaude = ["hello with spaces", "$(never executed)", "quote'\";`literal`", "--permission-mode", "plan"];
    process.argv = [process.execPath, "ccc", "claude", ...argumentsToClaude];
    await expect(main()).rejects.toMatchObject({ status: 0 });
    expect(f.claude).toHaveBeenCalledWith(f.finalId);
    expect(f.command).toHaveBeenCalledOnce();
    expect(f.command.mock.calls[0][1]).toContain(f.finalId);
    const args = f.command.mock.calls[0][1] as string[];
    expect(args.slice(args.indexOf(f.finalId) + 1)).toEqual(["/home/ccc/.local/bin/claude", ...argumentsToClaude]);
    expect(f.harness).not.toHaveBeenCalled();
    expect(f.events.indexOf("command")).toBeGreaterThan(f.events.indexOf("claude"));
});

it.each([false, true])("native prepared command preserves literal arguments and adds TTY flags only when terminal=%s", async terminal => {
    vi.stubEnv("TERM", "xterm-256color");
    vi.stubEnv("COLORTERM", "truecolor");
    vi.stubEnv("TERM_PROGRAM", "vscode");
    vi.stubEnv("TERM_PROGRAM_VERSION", "fixture-version");
    vi.stubEnv("COLORFGBG", "15;0");
    const ports = createNativeContainerExecPorts({ ensureDirectories: () => {}, ensureProjectTools: async () => {}, assetDirectory: "/fixture/assets", trustedCliPath: "/fixture/ccc" });
    const argumentsToCommand = ["printf", "argument with spaces", "$(never executed)", "a'\";`literal`"];
    const environment: Array<[string, string]> = [["DUPLICATE", "first"], ["DUPLICATE", "last"]];
    const prepared = ports.prepareCommand({ runtime: "podman", target: f.finalId, workdir: "/project/repo-id", environment, command: { kind: "command", arguments: argumentsToCommand } });
    f.command.mockImplementation(async () => 17);
    try {
        expect(await ports.launchCommand(prepared, { interactive: true, terminal, codexRecovery: false })).toBe(17);
        expect(f.envEntries).toEqual(environment);
        expect(f.command).toHaveBeenCalledExactlyOnceWith("podman", ["exec", "-w", "/project/repo-id", "--env-file", "/fixture/exec.env", ...(terminal ? ["-it", "-e", "TERM=xterm-256color", "-e", "COLORTERM=truecolor", "-e", "TERM_PROGRAM=vscode", "-e", "TERM_PROGRAM_VERSION=fixture-version", "-e", "COLORFGBG=15;0"] : []), f.finalId, ...argumentsToCommand], true, expect.objectContaining({invocation: expect.objectContaining({version: 1}), spawnSync: expect.any(Function)}));
        expect(f.events).not.toContain("unlink");
    } finally { ports.disposeCommand(prepared); }
    expect(f.events).toEqual(["unlink"]);
});

it("actual application and native preparation preserve environment duplicates and apply session overrides last", async () => {
    const ports = createNativeContainerExecPorts({ ensureDirectories: () => {}, ensureProjectTools: async () => {}, assetDirectory: "/fixture/assets", trustedCliPath: "/fixture/ccc" });
    vi.stubEnv("LANG", "host-lang"); vi.stubEnv("TZ", "Host/Zone");
    f.forwarded = [["LANG", "host-lang"], ["TZ", "Host/Zone"], ["MISE_NODE_VERSION", "host-node"]];
    await createContainerExec({...ports, projectId: () => "repo-id", clipboardConnection: () => ({url: "http://127.0.0.1:4321", token: "token:with:colon"})}).exec("/fixture", ["claude"], {env: { LANG: "session-lang", TZ: "Session/Zone", MISE_NODE_VERSION: "23" }});
    expect(f.envEntries).toEqual([
        ["container", "docker"], ...f.forwarded, ["MISE_TRUSTED_CONFIG_PATHS", "/project/repo-id"], ["TZ", "Host/Zone"],
        ["CCC_CLIPBOARD_URL", "http://127.0.0.1:4321"], ["CCC_CLIPBOARD_TOKEN", "token:with:colon"],
        ["MISE_NODE_VERSION", "22"], ["BASH_ENV", "/home/ccc/.bashrc_hooks"],
        ["CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS", "1"],
        ["LANG", "session-lang"], ["TZ", "Session/Zone"], ["MISE_NODE_VERSION", "23"],
    ]);
});

it("native environment observation supplies host facts without injecting guest defaults", () => {
    const ports = createNativeContainerExecPorts({ ensureDirectories: () => {}, ensureProjectTools: async () => {}, assetDirectory: "/fixture/assets", trustedCliPath: "/fixture/ccc" });
    vi.stubEnv("LANG", ""); vi.stubEnv("TZ", "Fallback/Zone");
    expect(ports.observeCommandEnvironment()).toMatchObject({forwarded: [], skippedKeys: [], containerMarker: ["container", "docker"], hostLangPresent: false, hostTimezone: "Fallback/Zone"});
});

it("outer CLI cleanup settles its started container when environment preparation creation fails", async () => {
    f.realCleanup = true; f.envCreationFailure = true;
    await expect(runCli()).rejects.toMatchObject({status: 1});
    expect(f.command).not.toHaveBeenCalled();
    expect(f.events).not.toContain("launch-preparation"); expect(f.events).not.toContain("unlink");
    // Startup restores access before MCP setup; application and CLI cleanup restore it again.
    expect(f.events.filter(event => event === "restore")).toHaveLength(3);
    expect(f.devices).toHaveBeenCalledOnce();
    expect(f.spawn).toHaveBeenCalledWith("docker", ["stop", f.finalId], {stdio: "ignore", timeout: 30_000, killSignal: "SIGKILL"});
    expect(getCurrentSession().lockFile).toBeNull();
});

it("native project setup and clipboard bridge keep their existing argv and stream policies", () => {
    const ports = createNativeContainerExecPorts({ ensureDirectories: () => {}, ensureProjectTools: async () => {}, assetDirectory: "/fixture/assets", trustedCliPath: "/fixture/ccc" });
    f.spawn.mockReturnValueOnce({status: 9, stdout: "", stderr: "fixture"})
        .mockReturnValue({status: 0, stdout: "", stderr: ""});
    expect(() => ports.installProjectTools(f.finalId, "/project/path with spaces")).not.toThrow();
    ports.startClipboardBridge(f.finalId, {url: "http://127.0.0.1:4321", token: "literal:token $(not shell)"});
    expect(f.spawn).toHaveBeenNthCalledWith(1, "docker", ["exec", "-w", "/project/path with spaces", f.finalId, "sh", "-c", "mise trust -a >/dev/null 2>&1 || true; mise install -y || true"], {stdio: "inherit"});
    expect(f.spawn).toHaveBeenNthCalledWith(2, "docker", ["exec", "-d", "-e", "CCC_CLIPBOARD_URL=http://127.0.0.1:4321", "-e", "CCC_CLIPBOARD_TOKEN=literal:token $(not shell)", f.finalId, "/usr/local/bin/ccc-x11-bridge"], {stdio: "ignore", timeout: 15000});
    expect(f.spawn).toHaveBeenNthCalledWith(3, "docker", ["exec", "-e", "CCC_CLIPBOARD_URL=http://127.0.0.1:4321", "-e", "CCC_CLIPBOARD_TOKEN=literal:token $(not shell)", f.finalId, "/usr/local/bin/ccc-x11-bridge", "--wait-ready"], {stdio: "ignore", timeout: 15000});
});

it("native post-exit conversation report retains the pinned target and piped UTF-8 recipe", () => {
    const ports = createNativeContainerExecPorts({ ensureDirectories: () => {}, ensureProjectTools: async () => {}, assetDirectory: "/fixture/assets", trustedCliPath: "/fixture/ccc" });
    f.spawn.mockReturnValue({status: 0, stdout: " 3\ndir:/home/ccc/.claude/projects/-project-repo-id\n", stderr: ""});
    ports.reportConversationFiles(f.finalId, "repo-id");
    expect(f.spawn).toHaveBeenCalledExactlyOnceWith("docker", ["exec", f.finalId, "sh", "-c", 'ls -1 "/home/ccc/.claude/projects/-project-repo-id"/*.jsonl 2>/dev/null | wc -l; echo "dir:/home/ccc/.claude/projects/-project-repo-id"'], {encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"]});
    expect(console.error).toHaveBeenCalledWith("[ccc:debug] post-exit conversation check: 3\ndir:/home/ccc/.claude/projects/-project-repo-id");
});
