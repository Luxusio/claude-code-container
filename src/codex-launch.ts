import { spawnSync } from "child_process";

import { interactiveCommand, type CodexLaunchPreparation, type CodexLaunchSemanticPreparation } from "./domain/tool-session/codex-launch.js";
import { createCodexLaunchPreparation } from "./application/tool-session/codex-launch.js";
import { containerEngineFailureHint } from "./container-runtime.js";
import type { CodexDaemonInitializationObservation, CodexInitializationFailure } from "./ports/tool-session/codex-launch.js";

export function isInteractiveCodexCommand(command: readonly string[]): boolean {
    return interactiveCommand(command) !== null;
}

const DAEMON_EXECUTABLE_PROBE = `
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.CODEX_HOME || path.join(require('node:os').homedir(), '.codex');
try {
    fs.accessSync(path.join(home, 'packages', 'app-server-daemon', 'current', 'bin', 'codex'), fs.constants.X_OK);
} catch (error) {
    if (error.code === 'ENOENT') process.stdout.write('ccc-codex-daemon-missing\\n');
    process.exitCode = error.code === 'ENOENT' ? 1 : 2;
}
`;

export type { CodexLaunchPreparation, CodexLaunchSemanticPreparation } from "./domain/tool-session/codex-launch.js";

interface NativeDaemonObservation {
    error?: { message?: string };
    signal: string | null;
    status: number | null;
    stdout: unknown;
    stderr: unknown;
}

function initializationFailure(result: NativeDaemonObservation): CodexInitializationFailure {
    const status = result.signal === "SIGINT" ? 130 : result.signal === "SIGTERM" ? 143 : result.signal === "SIGHUP" ? 129
        : typeof result.status === "number" && result.status > 0 ? result.status : 1;
    const cause = result.error?.message || (result.signal ? `signal ${result.signal}` : String(result.stderr || result.stdout).trim() || `exit ${result.status}`);
    return { status, cause: cause.slice(0, 1000) };
}

function observeInitialization(result: NativeDaemonObservation): CodexDaemonInitializationObservation {
    if (!result.error && !result.signal && result.status === 0) return { kind: "success" };
    const incomplete = !result.error && !result.signal && result.status !== 0
        && /Error: daemon executable not found at [^\r\n]+[\/]packages[\/]app-server-daemon[\/]current[\/]bin[\/]codex;/.test(String(result.stderr));
    return { kind: incomplete ? "installation-incomplete" : "failure", ...initializationFailure(result) };
}

export function presentCodexLaunchPreparation(result: CodexLaunchSemanticPreparation): CodexLaunchPreparation {
    const command = [...result.command];
    if (result.ok) {
        if (result.reason === "installation-incomplete-fallback") {
            return {
                ok: true,
                command: [command[0], "--no-daemon", ...command.slice(1)],
                notice: "Codex daemon installation is incomplete; running this session without the background server. Session history is preserved.",
            };
        }
        return { ok: true, command };
    }
    const error = result.reason === "profile-unsupported"
        ? "Codex daemon is missing; automatic initialization does not support --profile. Start the daemon with the intended configuration before resuming."
        : result.reason === "engine-unavailable" ? String(result.cause)
            : `Codex daemon initialization failed: ${String(result.cause).slice(0, 1000)}`;
    return { ok: false, command, status: result.status, error };
}

/** Initialize a positively missing daemon without changing or replaying the user command. */
export function prepareCodexLaunch(
    runtime: string,
    execPrefix: readonly string[],
    command: readonly string[],
    runner: typeof spawnSync = spawnSync,
): CodexLaunchPreparation {
    return presentCodexLaunchPreparation(prepareCodexLaunchSemantic(runtime, execPrefix, command, runner));
}

export function prepareCodexLaunchSemantic(
    runtime: string,
    execPrefix: readonly string[],
    command: readonly string[],
    runner: typeof spawnSync = spawnSync,
): CodexLaunchSemanticPreparation {
    const probeOptions = { encoding: "utf8" as const, timeout: 5000, maxBuffer: 64 * 1024, stdio: "pipe" as const };
    const preparation = createCodexLaunchPreparation({
        probeDaemonExecutable: () => {
            const result = runner(runtime, [...execPrefix, "node", "-e", DAEMON_EXECUTABLE_PROBE], probeOptions);
            const engineFailure = result.status !== 0 ? containerEngineFailureHint(result.stderr) : undefined;
            if (engineFailure) return { kind: "engine-unavailable", cause: engineFailure };
            const missing = !result.error && !result.signal && result.status === 1
                && result.stdout === "ccc-codex-daemon-missing\n" && result.stderr === "";
            return { kind: missing ? "missing" : "available-or-inconclusive" };
        },
        prepareStart: () => [...execPrefix, command[0], "app-server", "daemon", "start"],
        probeDaemonStartHelp: start => {
            const result = runner(runtime, [...start, "--help"], probeOptions);
            const engineFailure = result.status !== 0 ? containerEngineFailureHint(result.stderr) : undefined;
            if (engineFailure) return { kind: "engine-unavailable", cause: engineFailure };
            const supported = !result.error && !result.signal && result.status === 0
                && /Usage:\s+\S+\s+app-server\s+daemon\s+start\b/.test(String(result.stdout));
            return { kind: supported ? "supported" : "unsupported-or-inconclusive" };
        },
        initializeDaemon: (start, configuration) => observeInitialization(runner(runtime, [...start, ...configuration], { ...probeOptions, timeout: 60000 })),
        probeDaemonFallbackHelp: () => {
            const result = runner(runtime, [...execPrefix, command[0], "--help"], probeOptions);
            const supported = !result.error && !result.signal && result.status === 0
                && /^\s+--no-daemon\s*$/m.test(String(result.stdout));
            return { kind: supported ? "supported" : "unsupported" };
        },
        describeInitializationFailure: error => ({ status: 1, cause: (error instanceof Error ? error.message : String(error)).slice(0, 1000) }),
    });
    return preparation.prepare(command);
}
