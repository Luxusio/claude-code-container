import { describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareCodexLaunch } from "../codex-launch.js";
import { createContainerExec } from "../application/container-exec.js";
import { createDefaultToolCatalog } from "../domain/tool-registry.js";
import type { ContainerExecPorts } from "../ports/container-exec.js";
import type { RuntimeBindGuard } from "../ports/runtime-bind-authority.js";

const prefix = ["exec", "-w", "/project/with spaces", "--env-file", "/tmp/private-env", "ccc-fixture"];
const bypass = "--dangerously-bypass-approvals-and-sandbox";
function probe(status: number | null, stdout = "", extra = {}) {
    return { status, stdout, stderr: "", signal: null, ...extra };
}
function missingDaemon() { return probe(1, "ccc-codex-daemon-missing\n"); }
const startHelp = "Usage: codex app-server daemon start [OPTIONS]\n";
const ready = (command: string[]) => ({ ok: true, command });
function execFixture() {
    const catalog = createDefaultToolCatalog(), handle = Symbol("prepared"), events: string[] = [];
    // Opaque application capability; native lock qualification is tested separately.
    const bindGuard = Object.freeze({ root: "/fixture" }) as RuntimeBindGuard;
    let stateHeld = false, lifecycleHeld = false, cleanupEnabled = false;
    let readyId: string | null = null;
    const ports: ContainerExecPorts<symbol> = {
        ensureRuntime: vi.fn(), resolveProject: () => "/fixture/project", ensureDirectories: vi.fn(), ensureProjectTools: async () => {},
        projectId: () => "fixture", debugEnabled: () => false, terminalReady: vi.fn(() => false), runtime: () => "docker",
        tool: name => catalog.find(tool => tool.name === name), defaultTool: () => catalog[0],
        isWorktreeWorkspace: () => false, assertWorkspace: vi.fn(),
        async familyLock<T>(_id: string, operation: () => Promise<T> | T) { return operation(); },
        acquireOwnership: async () => ({ lockFile: "/fixture/session.lock", existingId: "final-id" }),
        inspectSessionContainer: () => ({ known: true, containerId: "final-id" }),
        verifyStoppedSessionContainerForReplacement: vi.fn(() => false),
        ensureClipboard: async () => null,
        validateClipboard: vi.fn<ContainerExecPorts<symbol>["validateClipboard"]>(async (selection, guard) => {
            expect(stateHeld).toBe(true); expect(guard).toBe(bindGuard); return selection;
        }),
        clipboardPortFile: () => "/fixture/clipboard.port", clipboardConnection: () => ({}),
        worktreeMounts: () => [], containerName: () => "fixture-container",
        containerStatus: () => ({ exists: true, running: true, containerId: "final-id", imageId: "image" }),
        sessionClaims: () => ["session.lock"], lockName: () => "session.lock", prepareDeviceBroker: async () => {},
        async lifecycleLock<T>(_id: string, operation: () => Promise<T> | T): Promise<T> {
            expect(stateHeld).toBe(true); expect(lifecycleHeld).toBe(false); lifecycleHeld = true;
            try { return await operation(); } finally { lifecycleHeld = false; }
        },
        async setupLock<T>(_id: string, operation: () => Promise<T> | T) { return operation(); },
        async stateLock<T>(operation: (guard: RuntimeBindGuard) => Promise<T> | T): Promise<T> {
            expect(stateHeld).toBe(false); stateHeld = true;
            try { return await operation(bindGuard); } finally { stateHeld = false; }
        },
        prepareContainer: () => ({ start: ports.startContainer, initialize: id => {
            expect(stateHeld).toBe(false); expect(lifecycleHeld).toBe(false);
            expect(id).toBe(readyId); expect(cleanupEnabled).toBe(false);
        } }),
        startContainer: (_path, _directories, _mounts, _port, _profile, _recreate, _replacement, onReady, expectedId, _onStarted, guard) => {
            expect(stateHeld).toBe(true); expect(lifecycleHeld).toBe(true); expect(guard).toBe(bindGuard);
            expect(expectedId).toBe("final-id");
            expect(ports.beginSessionStartupInHeldLifecycleLock).not.toHaveBeenCalled();
            onReady("final-id", { startedByInvocation: false }); return "fixture-container";
        },
        beginSessionStartupInHeldLifecycleLock: vi.fn(() => {
            expect(stateHeld).toBe(true); expect(lifecycleHeld).toBe(true); readyId = null; cleanupEnabled = false;
        }),
        recordSessionOwnStartInHeldLifecycleLock: vi.fn(() => { throw new Error("Reused fixture container must not publish an own start"); }),
        publishSessionReadyInHeldLifecycleLock: vi.fn<ContainerExecPorts<symbol>["publishSessionReadyInHeldLifecycleLock"]>((id, handoff) => {
            expect(stateHeld).toBe(true); expect(lifecycleHeld).toBe(true);
            expect(id).toBe("final-id"); expect(handoff).toEqual({ startedByInvocation: false });
            readyId = id; cleanupEnabled = handoff.startedByInvocation;
        }),
        setCleanupEnabled: vi.fn<ContainerExecPorts<symbol>["setCleanupEnabled"]>(enabled => { cleanupEnabled = enabled; }), confirmOwnership: vi.fn(async () => { events.push("confirm"); }),
        configLock<T>(operation: () => T) { return operation(); },
        restoreConfig: vi.fn(() => { events.push("restore"); }), ensureUv: vi.fn(), buildMcpConfig: async () => [],
        setupProxy: vi.fn(), containerRunning: () => true, installTools: vi.fn(), ensureClaude: vi.fn(),
        prepareCodexConfig: vi.fn(), assertCodexState: vi.fn(), ensureCodexHarness: vi.fn(), syncClipboard: vi.fn(), ensureSocketAccess: vi.fn(),
        isRestartRequired: () => false, attachClipboardImage: async (_path, args) => { events.push("attach"); return { args }; },
        installProjectTools: vi.fn(), startClipboardBridge: () => { events.push("bridge"); },
        observeCommandEnvironment: () => ({
            forwarded: [["FIXTURE", "nonsecret"]], skippedKeys: [], containerMarker: ["container", "ccc"],
            hostLangPresent: false, observedTimezone: "UTC",
        }),
        prepareCommand: vi.fn(() => { events.push("prepare"); return handle; }),
        prepareCodexCommand: vi.fn<ContainerExecPorts<symbol>["prepareCodexCommand"]>(() => { events.push("codex"); return { ok: true }; }),
        launchCommand: vi.fn(async () => { events.push("launch"); return 23; }),
        disposeCommand: vi.fn(() => { events.push("dispose"); }), reportConversationFiles: vi.fn(),
        setupFailure: cause => new Error("setup failed", { cause }),
        setupToolFailure: cause => new Error("tool setup failed", { cause }),
        handoffFailure: () => new Error("container handoff failed"),
        invalidRuntimeFailure: () => new Error("invalid container runtime"),
        cleanupSession: vi.fn(() => { events.push("cleanup"); }), report: vi.fn(),
    };
    return { ports, handle, events, bindGuard, exec: createContainerExec(ports).exec };
}
function runner(...results: ReturnType<typeof probe>[]) {
    const mock = vi.fn();
    for (const result of results) mock.mockReturnValueOnce(result);
    return mock;
}
function prepare(command: string[], mock: ReturnType<typeof runner>) {
    return prepareCodexLaunch("docker", prefix, command, mock as unknown as typeof spawnSync);
}

describe("non-destructive Codex launch", () => {
    it("refuses a Docker Desktop exec-inspect 500 without another daemon or user exec", () => {
        const mock = runner(probe(1, "", { stderr: "request returned 500 Internal Server Error for API route and version http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.56/exec/123/json, check if the server supports the requested api version" }));
        const result = prepare(["codex", bypass], mock);
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("runtime failure must stop launch");
        expect(result.error).toContain("Container engine is unavailable");
        expect(result.command).toEqual(["codex", bypass]);
        expect(mock).toHaveBeenCalledTimes(1);
    });

    it("stops after a known engine failure while checking daemon help", () => {
        const mock = runner(missingDaemon(), probe(1, "", { stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" }));
        expect(prepare(["codex", bypass], mock).ok).toBe(false);
        expect(mock).toHaveBeenCalledTimes(2);
    });
    it.each([
        ["codex"],
        ["codex", bypass],
        ["codex", "resume", bypass, "session-id", "continue this work"],
        ["codex", "fork", bypass, "--last", "make another variant"],
        ["codex", "-m", "model-a", "resume", "session-id"],
        ["codex", bypass, "--", "exec"],
        ["codex", bypass, "-c", 'profile="exec"', "--image", "/tmp/image with spaces.png", "explain the image"],
    ])("starts a missing daemon once without altering original arguments: %j", (...args) => {
        const command = args as string[];
        const mock = runner(missingDaemon(), probe(0, startHelp), probe(0));
        const actual = prepare(command, mock);
        expect(actual).toEqual(ready(command));
        expect(mock).toHaveBeenCalledTimes(3);
        for (const call of mock.mock.calls) {
            expect(call[0]).toBe("docker");
            expect(call[1].slice(0, prefix.length)).toEqual(prefix);
            expect(call[2].timeout).toBeGreaterThan(0);
            expect(call[2].timeout).toBeLessThanOrEqual(120000);
        }
        expect(mock.mock.calls[2][1].slice(prefix.length, prefix.length + 4)).toEqual(["codex", "app-server", "daemon", "start"]);
    });

    it.each([
        ["codex", "exec", "perform action"], ["codex", "review"], ["codex", "login"],
        ["codex", "app-server", "daemon", "start"], ["codex", bypass, "unknown-command"],
        ["codex", "doctor", "--summary"],
        ["codex", "migrate-rollouts", "--apply", "--thread", "session-id", "--json"],
        ["codex", bypass, "doctor"], ["codex", "resume", "--remote", "unix:///socket"],
        ["codex", "fork", "--remote=wss://example.invalid"], ["codex", bypass, "--no-daemon"],
        ["codex", "--help"], ["codex", "resume", "-h"], ["codex", "--version"],
    ])("does not probe or modify excluded invocations: %j", (...args) => {
        const command = args as string[];
        const mock = runner();
        expect(prepare(command, mock)).toEqual(ready(command));
        expect(mock).not.toHaveBeenCalled();
    });

    it.each([probe(0), probe(1), probe(1, "runtime unavailable"), probe(1, "ccc-codex-daemon-missing"), probe(1, "ccc-codex-daemon-missing\nextra"), probe(1, "ccc-codex-daemon-missing\n", { stderr: "container failed" }), probe(2), probe(126), probe(null, "", { signal: "SIGTERM" }), probe(null, "", { error: new Error("timeout") })])(
        "keeps invocation unchanged unless absence is positively confirmed: %j", result => {
            const command = ["codex", "resume", "session-id"];
            const mock = runner(result);
            expect(prepare(command, mock)).toEqual(ready(command));
            expect(mock).toHaveBeenCalledTimes(1);
        },
    );

    it.each([probe(0, "Usage: old codex"), probe(1, startHelp), probe(null, startHelp, { signal: "SIGTERM" })])(
        "does not start a daemon without a successful supported-command probe: %j", help => {
            const command = ["codex", "fork", "--last"];
            const mock = runner(missingDaemon(), help);
            const result = prepare(command, mock);
            expect(result.command).toEqual(command);
            expect(result).toEqual(ready(command));
            expect(mock).toHaveBeenCalledTimes(2);
        },
    );

    it("does not confuse flag values with command names or remote options", () => {
        const command = ["codex", "-m", "exec", "-c", 'x="--remote"', "resume", "session-id"];
        const mock = runner(missingDaemon(), probe(0, startHelp), probe(0));
        const result = prepare(command, mock);
        expect(result).toEqual(ready(command));
        expect(mock.mock.calls[2][1].slice(prefix.length)).toEqual(["codex", "app-server", "daemon", "start", "-c", 'x="--remote"']);
    });

    it("forwards only supported configuration arguments with exact order and quoting boundaries", () => {
        const overrides = ["--config", 'note="$(touch /tmp/not-run)"', "-cmodel=\"a b\"", "--enable=feature_a", "--disable", "feature_b"];
        const command = ["codex", ...overrides, "resume", "session-id", "-i", "/tmp/image.png", "continue now"];
        const mock = runner(missingDaemon(), probe(0, startHelp), probe(0));
        expect(prepare(command, mock)).toEqual(ready(command));
        expect(mock.mock.calls[2][1]).toEqual([...prefix, "codex", "app-server", "daemon", "start", ...overrides]);
    });

    it("accepts idempotent already-running startup without restarting or changing mode", () => {
        const command = ["codex", "fork", "--last"];
        const mock = runner(missingDaemon(), probe(0, startHelp), probe(0, '{"status":"alreadyRunning"}'));
        expect(prepare(command, mock)).toEqual(ready(command));
        expect(mock).toHaveBeenCalledTimes(3);
        expect(mock.mock.calls[2][1]).not.toContain("restart");
        expect(mock.mock.calls[2][1]).not.toContain("--no-daemon");
    });

    it.each([
        [probe(7, "", { stderr: "daemon failed" }), 7],
        [probe(null, "", { error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) }), 1],
        [probe(null, "", { signal: "SIGINT" }), 130],
        [probe(null, "", { signal: "SIGTERM" }), 143],
    ] as const)("returns explicit failure for unsuccessful startup: %j", (started, expectedStatus) => {
        const command = ["codex", "resume", "session-id"];
        const mock = runner(missingDaemon(), probe(0, startHelp), started);
        const result = prepare(command, mock);
        expect(result).toEqual(expect.objectContaining({ ok: false, command, status: expectedStatus, error: expect.any(String) }));
        expect(mock).toHaveBeenCalledTimes(3);
    });

    it.each([["-p", "custom"], ["--profile=custom"]])("does not initialize a daemon under a silently different profile: %j", (...profile) => {
        const command = ["codex", ...profile, "resume", "session-id"];
        const mock = runner(missingDaemon(), probe(0, startHelp));
        expect(prepare(command, mock)).toEqual(expect.objectContaining({ ok: false, command, status: 1, error: expect.stringMatching(/profile/i) }));
        expect(mock).toHaveBeenCalledTimes(2);
    });

    it("does not block profiles on older CLIs without daemon start support", () => {
        const command = ["codex", "--profile", "custom", "resume", "session-id"];
        const mock = runner(missingDaemon(), probe(1, "", { stderr: "unknown command daemon" }));
        expect(prepare(command, mock)).toEqual(ready(command));
        expect(mock).toHaveBeenCalledTimes(2);
    });

    it("executes the read-only probe against the selected CODEX_HOME and preserves its session state", () => {
        const home = mkdtempSync(join(tmpdir(), "ccc-codex-probe-"));
        const selectedHome = join(home, "custom codex home");
        mkdirSync(selectedHome);
        const session = join(selectedHome, "session.jsonl");
        writeFileSync(session, "existing-session-history\n");
        const executable = join(selectedHome, "packages", "app-server-daemon", "current", "bin", "codex");
        const command = ["codex", "resume", "session-id"];
        const mock = vi.fn((_runtime: string, args: string[]) => {
            const scriptIndex = args.indexOf("-e");
            if (scriptIndex >= 0) {
                return spawnSync(process.execPath, ["-e", args[scriptIndex + 1]], {
                    encoding: "utf8", timeout: 5000,
                    env: { ...process.env, HOME: home, CODEX_HOME: selectedHome },
                });
            }
            return probe(0, args.includes("--help") ? startHelp : "");
        });
        try {
            expect(prepare(command, mock)).toEqual(ready(command));
            expect(mock).toHaveBeenCalledTimes(3);
            mkdirSync(join(selectedHome, "packages", "app-server-daemon", "current", "bin"), { recursive: true });
            writeFileSync(executable, "#!/bin/sh\nexit 0\n");
            chmodSync(executable, 0o755);
            mock.mockClear();
            expect(prepare(command, mock)).toEqual(ready(command));
            expect(mock).toHaveBeenCalledTimes(1);
            expect(readFileSync(session, "utf8")).toBe("existing-session-history\n");
            expect(readFileSync(executable, "utf8")).toBe("#!/bin/sh\nexit 0\n");
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });

    it("leaves command untouched if a probe runner throws", () => {
        const command = ["codex", "resume", "session-id"];
        const mock = vi.fn(() => { throw new Error("runtime unavailable"); });
        expect(prepare(command, mock)).toEqual(ready(command));
    });

});


const missingStart = () => probe(1, "", { stderr: "Error: daemon executable not found at /home/user/.codex/packages/app-server-daemon/current/bin/codex; run daemon update" });
describe("actual application Codex preparation lifetime", () => {
    it.each([false, true])("prepares before terminal observation and recovers only with a terminal (TTY=%s)", async tty => {
        const f = execFixture();
        vi.mocked(f.ports.terminalReady).mockImplementation(() => { f.events.push("terminal"); return tty; });
        expect(await f.exec("/fixture", ["codex", "resume", "session-id"], {}, "work")).toBe(23);
        expect(f.events.indexOf("attach")).toBeLessThan(f.events.indexOf("bridge"));
        expect(f.events.indexOf("bridge")).toBeLessThan(f.events.indexOf("prepare"));
        expect(f.events.indexOf("codex")).toBeLessThan(f.events.indexOf("terminal"));
        expect(f.ports.prepareCodexCommand).toHaveBeenCalledExactlyOnceWith(f.handle);
        expect(f.ports.validateClipboard).toHaveBeenCalledExactlyOnceWith(null, f.bindGuard);
        expect(f.ports.beginSessionStartupInHeldLifecycleLock).not.toHaveBeenCalled();
        expect(f.ports.publishSessionReadyInHeldLifecycleLock).toHaveBeenCalledExactlyOnceWith("final-id", { startedByInvocation: false });
        expect(f.ports.recordSessionOwnStartInHeldLifecycleLock).not.toHaveBeenCalled();
        expect(f.ports.launchCommand).toHaveBeenCalledExactlyOnceWith(f.handle, { interactive: true, terminal: tty, codexRecovery: tty });
        expect(f.events.slice(-3)).toEqual(["restore", "dispose", "cleanup"]);
        expect(f.ports.restoreConfig).toHaveBeenLastCalledWith("final-id", "work");
    });
    it("bypasses daemon preparation and terminal observation for a noninteractive request", async () => {
        const f = execFixture(); await f.exec("/fixture", ["codex"], { interactive: false });
        expect(f.ports.prepareCodexCommand).not.toHaveBeenCalled(); expect(f.ports.terminalReady).not.toHaveBeenCalled();
        expect(f.ports.launchCommand).toHaveBeenCalledExactlyOnceWith(f.handle, { interactive: false, terminal: false, codexRecovery: false });
    });
    it("confirms refused preparation ownership, returns its status and disposes without launching", async () => {
        const f = execFixture();
        vi.mocked(f.ports.prepareCodexCommand).mockImplementation(() => { f.events.push("codex"); return { ok: false, status: 7, reason: "initialization-failed" }; });
        expect(await f.exec("/fixture", ["codex"])).toBe(7);
        expect(f.events.slice(f.events.indexOf("codex")).filter(event => event !== "terminal")).toEqual(["codex", "confirm", "restore", "dispose", "cleanup"]);
        expect(f.ports.launchCommand).not.toHaveBeenCalled();
        expect(f.ports.setCleanupEnabled).not.toHaveBeenCalledWith(true);
    });
    it.each(["resolve", "reject"] as const)("awaits final ownership confirmation before launch (%s)", async outcome => {
        const f = execFixture(), cause = new Error("ownership refused");
        let release!: () => void, reject!: (cause: Error) => void, reached!: () => void;
        const atConfirmation = new Promise<void>(resolve => { reached = resolve; });
        const confirmation = new Promise<void>((resolve, fail) => { release = resolve; reject = fail; });
        vi.mocked(f.ports.prepareCommand).mockImplementation(() => {
            vi.mocked(f.ports.confirmOwnership).mockImplementation(() => { reached(); return confirmation; });
            return f.handle;
        });
        const pending = f.exec("/fixture", ["codex"]);
        await atConfirmation;
        expect(f.ports.launchCommand).not.toHaveBeenCalled(); expect(f.ports.disposeCommand).not.toHaveBeenCalled();
        if (outcome === "reject") {
            const rejected = expect(pending).rejects.toBe(cause); reject(cause); await rejected;
            expect(f.ports.launchCommand).not.toHaveBeenCalled();
        } else { release(); expect(await pending).toBe(23); }
        expect(f.events.slice(-3)).toEqual(["restore", "dispose", "cleanup"]);
    });
    it.each(["codex", "terminal", "launch"] as const)("preserves a prepared operation failure across cleanup (%s)", async stage => {
        const f = execFixture(), cause = new Error(stage), fail = () => { throw cause; };
        if (stage === "codex") vi.mocked(f.ports.prepareCodexCommand).mockImplementation(fail);
        else if (stage === "terminal") vi.mocked(f.ports.terminalReady).mockImplementation(fail);
        else vi.mocked(f.ports.launchCommand).mockRejectedValue(cause);
        await expect(f.exec("/fixture", ["codex"])).rejects.toBe(cause);
        expect(f.ports.disposeCommand).toHaveBeenCalledExactlyOnceWith(f.handle);
        expect(f.events.slice(-3)).toEqual(["restore", "dispose", "cleanup"]);
    });
    it("launches a qualified fallback exactly once and reports its finite notice", async () => {
        const f = execFixture();
        vi.mocked(f.ports.prepareCodexCommand).mockReturnValue({ ok: true, reason: "installation-incomplete-fallback" });
        expect(await f.exec("/fixture", ["codex", "resume", "old"])).toBe(23);
        expect(f.ports.report).toHaveBeenCalledWith({ kind: "codex-preparation", result: { ok: true, reason: "installation-incomplete-fallback" } });
        expect(f.ports.launchCommand).toHaveBeenCalledTimes(1); expect(f.ports.disposeCommand).toHaveBeenCalledTimes(1);
    });
    it.each([false, true])("disposes when preparation presentation throws (refused=%s)", async refused => {
        const f = execFixture(), cause = new Error("presentation failed");
        vi.mocked(f.ports.prepareCodexCommand).mockReturnValue(refused
            ? { ok: false, status: 7, reason: "initialization-failed" }
            : { ok: true, reason: "installation-incomplete-fallback" });
        vi.mocked(f.ports.report).mockImplementation(report => { if (report.kind === "codex-preparation") throw cause; });
        await expect(f.exec("/fixture", ["codex"])).rejects.toBe(cause);
        expect(f.ports.launchCommand).not.toHaveBeenCalled();
        expect(f.events.slice(-3)).toEqual(["restore", "dispose", "cleanup"]);
    });
});
const fallbackHelp = "Usage: codex [OPTIONS]\n      --no-daemon\n          Run an in-process server\n";

describe("one-session fallback for a positively broken daemon installation", () => {
    it.each([
        ["codex", "resume", "session-id", "continue now"],
        ["codex", "fork", "--last", "make another variant"],
        ["codex", "-c", 'literal="$(touch /tmp/not-run)"', "resume", "session-id", "--image", "/tmp/image with spaces.png"],
    ])("uses the supported global flag without dropping original arguments: %j", (...args) => {
        const command = args as string[];
        const mock = runner(missingDaemon(), probe(0, startHelp), missingStart(), probe(0, fallbackHelp));
        const result = prepare(command, mock);
        expect(result).toEqual({ ok: true, command: ["codex", "--no-daemon", ...command.slice(1)], notice: expect.stringContaining("without the background server") });
        expect(command).not.toContain("--no-daemon");
        expect(mock).toHaveBeenCalledTimes(4);
        expect(mock.mock.calls[3][1]).toEqual([...prefix, "codex", "--help"]);
        expect(mock.mock.calls[3][2]).toMatchObject({ timeout: 5000, maxBuffer: 64 * 1024 });
        expect(mock.mock.calls.flatMap((call) => call[1])).not.toContain("update");
        expect(mock.mock.calls.filter((call) => call[1].includes("start") && !call[1].includes("--help"))).toHaveLength(1);
    });
    it.each([
        probe(1, "", { stderr: "Socket permission denied" }),
        probe(1, missingStart().stderr),
        probe(null, "", { stderr: missingStart().stderr, signal: "SIGINT" }),
        probe(null, "", { stderr: missingStart().stderr, error: new Error("timeout") }),
    ])("never falls back for unrelated, interrupted or timed-out startup: %j", (failure) => {
        const mock = runner(missingDaemon(), probe(0, startHelp), failure);
        expect(prepare(["codex"], mock).ok).toBe(false);
        expect(mock).toHaveBeenCalledTimes(3);
    });
    it.each([
        probe(0, "Usage: codex --no-daemon-is-not-a-flag"),
        probe(0, "Documentation mentions --no-daemon but does not advertise it"),
        probe(1, fallbackHelp),
        probe(null, fallbackHelp, { signal: "SIGTERM" }),
        probe(null, fallbackHelp, { error: new Error("help timeout") }),
    ])("requires positively advertised fallback support: %j", (help) => {
        const command = ["codex", "resume", "session-id"];
        const mock = runner(missingDaemon(), probe(0, startHelp), missingStart(), help);
        expect(prepare(command, mock)).toMatchObject({ ok: false, command });
        expect(mock).toHaveBeenCalledTimes(4);
    });
    it("leaves partial daemon files, control endpoint and history unchanged", () => {
        const home = mkdtempSync(join(tmpdir(), "ccc-codex-fallback-"));
        const current = join(home, "packages", "app-server-daemon", "current");
        mkdirSync(current, { recursive: true });
        mkdirSync(join(home, "app-server-control"));
        const files = [join(home, "history.jsonl"), join(current, "preserve-package-data"), join(home, "app-server-control", "app-server-control.sock")];
        for (const file of files) writeFileSync(file, "retain original bytes\n");
        const mock = vi.fn((_runtime: string, args: string[]) => {
            if (args[prefix.length] === "node") return spawnSync(process.execPath, args.slice(prefix.length + 1), { encoding: "utf8", timeout: 5000, env: { ...process.env, CODEX_HOME: home } });
            if (args.includes("start")) return args.includes("--help") ? probe(0, startHelp) : missingStart();
            return probe(0, fallbackHelp);
        });
        try {
            expect(prepare(["codex", "resume", "session-id"], mock)).toMatchObject({ ok: true, command: ["codex", "--no-daemon", "resume", "session-id"] });
            expect(mock).toHaveBeenCalledTimes(4);
            for (const file of files) expect(readFileSync(file, "utf8")).toBe("retain original bytes\n");
        } finally { rmSync(home, { recursive: true, force: true }); }
    });
});
