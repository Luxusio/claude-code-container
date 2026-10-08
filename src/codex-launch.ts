import { spawnSync } from "child_process";

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
    const probeOptions = { encoding: "utf8" as const, timeout: 5000, maxBuffer: 64 * 1024, stdio: "pipe" as const };
    const preparation = createCodexLaunchPreparation({
        probeDaemonExecutable: () => runner(runtime, [...execPrefix, "node", "-e", DAEMON_EXECUTABLE_PROBE], probeOptions),
        prepareStart: () => [...execPrefix, command[0], "app-server", "daemon", "start"],
        probeDaemonStartHelp: start => runner(runtime, [...start, "--help"], probeOptions),
        initializeDaemon: (start, configuration) => runner(runtime, [...start, ...configuration], { ...probeOptions, timeout: 60000 }),
        probeDaemonFallbackHelp: () => runner(runtime, [...execPrefix, command[0], "--help"], probeOptions),
    });
    return preparation.prepare(command);
}
