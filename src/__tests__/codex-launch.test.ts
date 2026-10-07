import { describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { transpileModule, ScriptTarget } from "typescript";
import { prepareCodexLaunch } from "../codex-launch.js";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const prefix = ["exec", "-w", "/project/with spaces", "--env-file", "/tmp/private-env", "ccc-fixture"];
const bypass = "--dangerously-bypass-approvals-and-sandbox";
function probe(status: number | null, stdout = "", extra = {}) {
    return { status, stdout, stderr: "", signal: null, ...extra };
}
function missingDaemon() { return probe(1, "ccc-codex-daemon-missing\n"); }
const startHelp = "Usage: codex app-server daemon start [OPTIONS]\n";
const ready = (command: string[]) => ({ ok: true, command });
const envEntries = [["CCC_TEST_MARKER", "generated-nonsecret-fixture"]];
const launchPrefix = prefix.slice(0, 3);
function indexLaunchSlice() {
    const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const start = source.indexOf("let preparationStatus:");
    const end = source.indexOf("if (process.env.DEBUG)", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const block = source.slice(start, end);
    const creation = block.indexOf("const envFile = writeOwnedEnvFile(envEntries);");
    const protectedStart = block.indexOf("try {");
    expect(creation).toBeGreaterThan(0);
    expect(protectedStart).toBeGreaterThan(creation);
    const js = transpileModule(block + "\nreturn resultStatus;", {
        compilerOptions: { target: ScriptTarget.ES2022 },
    }).outputText;
    const execute = new AsyncFunction("commandTool", "options", "prepareCodexLaunch", "runtimeCli", "execArgs", "containerName", "resolvedCmd", "process", "console", "CLAUDE_BIN_PATH", "cmd", "runContainerCommand", "restoreCodexConfigHostOwnership", "writeOwnedEnvFile", "envEntries", "buildCodexResumeRecoveryCommand", "confirmSessionOwnership", "setSessionCleanupEnabled", "withCodexConfigLock", "profile", "cleanupSession", js);
    return (...args: unknown[]) => {
        const output = args[8] as { warn?: (...messages: unknown[]) => void };
        output.warn ??= vi.fn();
        return execute(...args, vi.fn(), (operation: () => void, profile: string) => {
            expect(profile).toBe("work");
            return operation();
        }, "work", vi.fn());
    };
}
function ownedFixture(dispose: () => void) {
    return vi.fn((entries: string[][]) => {
        expect(entries).toBe(envEntries);
        return { path: "/tmp/private-env", dispose };
    });
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

    it.each([probe(0), probe(1), probe(1, "runtime unavailable"), probe(1, "ccc-codex-daemon-missing\n", { stderr: "container failed" }), probe(2), probe(126), probe(null, "", { signal: "SIGTERM" }), probe(null, "", { error: new Error("timeout") })])(
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

    it("removes the destructive recovery ladder from the real launch entry point", () => {
        const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
        for (const obsolete of ["offerCodexStateWipe", "CODEX_STATE_WIPE_COMMAND", "forceUpdateCodexInContainer", "isCodexLikelyFailure", "Wipe everything in ~/.codex"]) {
            expect(source).not.toContain(obsolete);
        }
        expect(source).toContain("prepareCodexLaunch");
    });

    it.each([true, false])("runs common cleanup and launches TUI only after successful preparation (failed=%s)", async failed => {
        const events: string[] = [];
        const command = ["codex", "resume", "session-id"];
        const launch = vi.fn(async () => { events.push("launch"); return 23; });
        const runtime = vi.fn(() => "docker");
        const confirm = vi.fn(async () => { events.push("confirmation"); });
        const execute = indexLaunchSlice();
        const status = await execute(
            { name: "codex" }, { interactive: true },
            () => failed ? { ok: false, command, status: 7, error: "initialization failed" } : ready(command),
            runtime, [...launchPrefix], "ccc-fixture", command,
            { stdin: { isTTY: false }, stdout: { isTTY: false } }, { error: vi.fn() }, "unused", command,
            launch, () => events.push("ownership-cleanup"), ownedFixture(() => events.push("env-cleanup")), envEntries, (args: string[]) => args, confirm,
        );
        expect(status).toBe(failed ? 7 : 23);
        expect(events).toEqual(failed ? ["confirmation", "ownership-cleanup", "env-cleanup"] : ["confirmation", "confirmation", "launch", "ownership-cleanup", "env-cleanup"]);
        expect(confirm).toHaveBeenCalledTimes(failed ? 1 : 2);
        expect(launch).toHaveBeenCalledTimes(failed ? 0 : 1);
        expect(runtime).toHaveBeenCalledTimes(failed ? 1 : 2);
        if (!failed) expect(launch.mock.calls[0]).toEqual(["docker", [...prefix, ...command], true]);
    });
    it.each([true, false])("wraps the prepared resume only with an interactive terminal (TTY=%s)", async tty => {
        const command = ["codex", "resume", "session-id"];
        const prepared = ["codex", "--no-daemon", "resume", "session-id"];
        const wrapped = ["node", "-e", "fixture-supervisor"];
        const wrapper = vi.fn(() => wrapped);
        const events: string[] = [];
        const confirm = vi.fn(async () => { events.push("confirmation"); });
        const launch = vi.fn(async () => { events.push("launch"); return 19; });
        const execute = indexLaunchSlice();
        const status = await execute({ name: "codex" }, { interactive: true }, () => ready(prepared), () => "docker", ["exec"], "ccc-fixture", command,
            { stdin: { isTTY: tty }, stdout: { isTTY: tty } }, { error: vi.fn() }, "unused", command, launch, vi.fn(), ownedFixture(vi.fn()), envEntries, wrapper, confirm);
        expect(status).toBe(19);
        expect(confirm).toHaveBeenCalledTimes(2);
        expect(events).toEqual(["confirmation", "confirmation", "launch"]);
        expect(wrapper).toHaveBeenCalledTimes(tty ? 1 : 0);
        if (tty) expect(wrapper).toHaveBeenCalledWith(prepared);
        expect(launch).toHaveBeenCalledExactlyOnceWith("docker", ["exec", "--env-file", "/tmp/private-env", ...(tty ? ["-it"] : []), "ccc-fixture", ...(tty ? wrapped : prepared)], true);
    });

    it.each(["resolve", "reject"] as const)("awaits session ownership confirmation before launch (%s)", async outcome => {
        let resolveConfirmation!: () => void;
        let rejectConfirmation!: (error: Error) => void;
        const confirmation = new Promise<void>((resolve, reject) => {
            resolveConfirmation = resolve;
            rejectConfirmation = reject;
        });
        const events: string[] = [];
        const confirm = vi.fn(() => { events.push("confirmation"); return confirmation; });
        const launch = vi.fn(async () => { events.push("launch"); return 23; });
        const cleanupOwnership = vi.fn(() => events.push("ownership-cleanup"));
        const cleanupEnv = vi.fn(() => events.push("env-cleanup"));
        const command = ["codex", "resume", "session-id"];
        const execute = indexLaunchSlice();
        const createEnv = ownedFixture(cleanupEnv);
        const pending = execute({ name: "codex" }, { interactive: true }, () => ready(command), () => "docker", [...launchPrefix], "ccc-fixture", command,
            { stdin: { isTTY: false }, stdout: { isTTY: false } }, { error: vi.fn() }, "unused", command, launch,
            cleanupOwnership, createEnv, envEntries, (args: string[]) => args, confirm);
        await Promise.resolve();
        expect(confirm).toHaveBeenCalledExactlyOnceWith();
        expect(createEnv).toHaveBeenCalledExactlyOnceWith(envEntries);
        expect(events).toEqual(["confirmation"]);
        expect(launch).not.toHaveBeenCalled();
        expect(cleanupOwnership).not.toHaveBeenCalled();
        expect(cleanupEnv).not.toHaveBeenCalled();

        if (outcome === "reject") {
            const error = new Error("session ownership confirmation rejected");
            const rejection = expect(pending).rejects.toBe(error);
            rejectConfirmation(error);
            await rejection;
            expect(launch).not.toHaveBeenCalled();
            expect(cleanupOwnership).toHaveBeenCalledExactlyOnceWith("ccc-fixture", "work");
            expect(cleanupEnv).toHaveBeenCalledExactlyOnceWith();
            expect(events).toEqual(["confirmation", "ownership-cleanup", "env-cleanup"]);
        } else {
            resolveConfirmation();
            expect(await pending).toBe(23);
            expect(launch).toHaveBeenCalledExactlyOnceWith("docker", [...prefix, ...command], true);
            expect(events).toEqual(["confirmation", "confirmation", "launch", "ownership-cleanup", "env-cleanup"]);
        }
    });

    it.each([
        "env-arguments", "preparation-runtime", "preparation", "preparation-error",
        "preparation-notice", "tty-probe", "tty-arguments", "resume-command",
        "container-arguments", "command-arguments", "confirmation", "launch-runtime",
        "command", "restoration",
    ])("disposes the resource and preserves command failure or status across %s", async stage => {
        const failure = { stage, marker: "generated-nonsecret-failure" };
        const events: string[] = [];
        const fail = () => { throw failure; };
        const command = ["codex", "resume", "session-id"];
        const execArgs = [...launchPrefix];
        const tty = stage === "tty-arguments" || stage === "resume-command";
        const failedPush = stage === "env-arguments" ? "--env-file"
            : stage === "tty-arguments" ? "-it"
                : stage === "container-arguments" ? "ccc-fixture"
                    : stage === "command-arguments" ? "codex" : undefined;
        const push = vi.spyOn(execArgs, "push").mockImplementation((...args: string[]) => {
            events.push(`args:${args[0]}`);
            if (args[0] === failedPush) fail();
            return Array.prototype.push.apply(execArgs, args);
        });
        let runtimeCalls = 0;
        const runtime = vi.fn(() => {
            runtimeCalls += 1;
            events.push("runtime");
            if (stage === "preparation-runtime" || (stage === "launch-runtime" && runtimeCalls === 2)) fail();
            return "docker";
        });
        const preparation = vi.fn(() => {
            events.push("preparation");
            if (stage === "preparation") fail();
            if (stage === "preparation-error") return { ok: false, command, status: 7, error: "fixture preparation failed" };
            return { ...ready(command), ...(stage === "preparation-notice" ? { notice: "fixture notice" } : {}) };
        });
        const confirm = vi.fn(async () => {
            events.push("confirmation");
            if (stage === "confirmation") fail();
        });
        const launch = vi.fn(async () => {
            events.push("launch");
            if (stage === "command") fail();
            return 23;
        });
        const restore = vi.fn(() => {
            events.push("ownership-cleanup");
            if (stage === "restoration") fail();
        });
        const dispose = vi.fn(() => { events.push("env-cleanup"); });
        const create = ownedFixture(dispose);
        create.mockImplementation(entries => {
            expect(entries).toBe(envEntries);
            expect(events).toEqual([]);
            events.push("create");
            return { path: "/tmp/private-env", dispose };
        });
        const stdin = { get isTTY() { if (stage === "tty-probe") fail(); return tty; } };
        try {
            const pending = indexLaunchSlice()(
                { name: "codex" }, { interactive: true }, preparation, runtime, execArgs,
                "ccc-fixture", command, { stdin, stdout: { isTTY: tty } },
                { error: fail }, "unused", command, launch, restore, create, envEntries,
                stage === "resume-command" ? fail : (args: string[]) => args, confirm,
            );
            if (stage === "restoration") await expect(pending).resolves.toBe(23);
            else await expect(pending).rejects.toBe(failure);
            expect(create).toHaveBeenCalledExactlyOnceWith(envEntries);
            expect(dispose).toHaveBeenCalledExactlyOnceWith();
            expect(events[0]).toBe("create");
            expect(events.at(-1)).toBe("env-cleanup");
            expect(launch).toHaveBeenCalledTimes(stage === "command" || stage === "restoration" ? 1 : 0);
            expect(restore).toHaveBeenCalledTimes(1);
            expect(confirm).toHaveBeenCalledTimes(stage === "confirmation" ? 1 : ["launch-runtime", "command", "restoration"].includes(stage) ? 2 : 0);
        } finally {
            push.mockRestore();
        }
    });

    it("preserves a creation failure before any protected launch effect", async () => {
        const failure = { marker: "generated-nonsecret-creation-failure" };
        const effect = vi.fn();
        const create = vi.fn(() => { throw failure; });
        const args = [...launchPrefix];
        const command = ["codex", "resume", "session-id"];
        await expect(indexLaunchSlice()(
            { name: "codex" }, { interactive: true }, effect, effect, args, "ccc-fixture", command,
            { stdin: { isTTY: true }, stdout: { isTTY: true } }, { error: effect }, "unused", command,
            effect, effect, create, envEntries, effect, effect,
        )).rejects.toBe(failure);
        expect(create).toHaveBeenCalledExactlyOnceWith(envEntries);
        expect(args).toEqual(launchPrefix);
        expect(effect).not.toHaveBeenCalled();
    });

    it("disposes if Claude argument construction throws before confirmation", async () => {
        const failure = { marker: "generated-nonsecret-argument-failure" };
        const command = ["claude", "fixture prompt"];
        const commandArgs = { slice: vi.fn(() => { throw failure; }) };
        const dispose = vi.fn();
        const create = ownedFixture(dispose);
        const preparation = vi.fn();
        const launch = vi.fn();
        const restore = vi.fn();
        const confirm = vi.fn();
        await expect(indexLaunchSlice()(
            { name: "claude" }, { interactive: true }, preparation, () => "docker", [...launchPrefix],
            "ccc-fixture", command, { stdin: { isTTY: false }, stdout: { isTTY: false } },
            { error: vi.fn() }, "/fixture/claude", commandArgs, launch, restore, create, envEntries,
            (args: string[]) => args, confirm,
        )).rejects.toBe(failure);
        expect(create).toHaveBeenCalledExactlyOnceWith(envEntries);
        expect(commandArgs.slice).toHaveBeenCalledExactlyOnceWith(1);
        expect(dispose).toHaveBeenCalledExactlyOnceWith();
        expect(preparation).not.toHaveBeenCalled();
        expect(confirm).not.toHaveBeenCalled();
        expect(launch).not.toHaveBeenCalled();
        expect(restore).toHaveBeenCalledExactlyOnceWith("ccc-fixture", "work");
    });

});


const missingStart = () => probe(1, "", { stderr: "Error: daemon executable not found at /home/user/.codex/packages/app-server-daemon/current/bin/codex; run daemon update" });
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
    it("launches the returned fallback command once, prints the notice, and still cleans up", async () => {
        const events: string[] = [];
        const command = ["codex", "resume", "session-id"];
        const fallback = ["codex", "--no-daemon", "resume", "session-id"];
        const launch = vi.fn(async () => { events.push("launch"); return 0; });
        const confirm = vi.fn(async () => { events.push("confirmation"); });
        const execute = indexLaunchSlice();
        const result = await execute({ name: "codex" }, { interactive: true }, () => ({ ok: true, command: fallback, notice: "daemon fallback" }), () => "docker", [...launchPrefix], "ccc-fixture", command,
            { stdin: { isTTY: false }, stdout: { isTTY: false } }, { error: (message: string) => events.push(message) }, "unused", command, launch,
            () => events.push("ownership-cleanup"), ownedFixture(() => events.push("env-cleanup")), envEntries, (args: string[]) => args, confirm);
        expect(result).toBe(0);
        expect(confirm).toHaveBeenCalledTimes(2);
        expect(launch).toHaveBeenCalledExactlyOnceWith("docker", [...prefix, ...fallback], true);
        expect(events).toEqual(["[ccc] daemon fallback", "confirmation", "confirmation", "launch", "ownership-cleanup", "env-cleanup"]);
    });
});
