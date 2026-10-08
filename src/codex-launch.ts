import { spawnSync } from "child_process";
import { containerEngineFailureHint } from "./domain/container-runtime.js";

import { interactiveCommand, type CodexLaunchPreparation } from "./domain/tool-session/codex-launch.js";
import { createCodexLaunchPreparation } from "./application/tool-session/codex-launch.js";

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

export type { CodexLaunchPreparation } from "./domain/tool-session/codex-launch.js";

/** Initialize a positively missing daemon without changing or replaying the user command. */
export function prepareCodexLaunch(
    runtime: string,
    execPrefix: readonly string[],
    command: readonly string[],
    runner: typeof spawnSync = spawnSync,
): CodexLaunchPreparation {
    const original = [...command];
    const unchanged = { ok: true as const, command: original };
    const interactive = interactiveCommand(command);
    if (!interactive) return unchanged;
    const failure = (error: string, status = 1): CodexLaunchPreparation => ({ ok: false, command: original, status, error });
    const probeOptions = { encoding: "utf8" as const, timeout: 5000, maxBuffer: 64 * 1024, stdio: "pipe" as const };
    try {
        const executable = runner(runtime, [...execPrefix, "node", "-e", DAEMON_EXECUTABLE_PROBE], probeOptions);
        const engineFailure = executable.status !== 0 ? containerEngineFailureHint(executable.stderr) : undefined;
        if (engineFailure) return failure(engineFailure);
        if (executable.error || executable.signal || executable.status !== 1
            || executable.stdout !== "ccc-codex-daemon-missing\n" || executable.stderr !== "") return unchanged;
    } catch {
        return unchanged;
    }
    const startArgs = [...execPrefix, command[0], "app-server", "daemon", "start"];
    let help;
    try {
        help = runner(runtime, [...startArgs, "--help"], probeOptions);
        const engineFailure = help.status !== 0 ? containerEngineFailureHint(help.stderr) : undefined;
        if (engineFailure) return failure(engineFailure);
    } catch {
        return unchanged;
    }
    if (help.error || help.signal || help.status !== 0
        || !/Usage:\s+\S+\s+app-server\s+daemon\s+start\b/.test(String(help.stdout))) return unchanged;
    if (interactive.profile) return failure("Codex daemon is missing; automatic initialization does not support --profile. Start the daemon with the intended configuration before resuming.");
    try {
        const start = runner(runtime, [...startArgs, ...interactive.daemonArgs], { ...probeOptions, timeout: 60000 });
        if (!start.error && !start.signal && start.status !== 0
            && /Error: daemon executable not found at [^\r\n]+[\/]packages[\/]app-server-daemon[\/]current[\/]bin[\/]codex;/.test(String(start.stderr))) {
            const help = runner(runtime, [...execPrefix, command[0], "--help"], probeOptions);
            if (!help.error && !help.signal && help.status === 0
                && /^\s+--no-daemon\s*$/m.test(String(help.stdout))) {
                return {
                    ok: true,
                    command: [original[0], "--no-daemon", ...original.slice(1)],
                    notice: "Codex daemon installation is incomplete; running this session without the background server. Session history is preserved.",
                };
            }
        }
        if (start.error || start.signal || start.status !== 0) {
            const status = start.signal === "SIGINT" ? 130 : start.signal === "SIGTERM" ? 143 : start.signal === "SIGHUP" ? 129
                : typeof start.status === "number" && start.status > 0 ? start.status : 1;
            const cause = start.error?.message || (start.signal ? `signal ${start.signal}` : String(start.stderr || start.stdout).trim() || `exit ${start.status}`);
            return failure(`Codex daemon initialization failed: ${cause.slice(0, 1000)}`, status);
        }
        return unchanged;
    } catch (error) {
        return failure(`Codex daemon initialization failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 1000)}`);
    }
}
