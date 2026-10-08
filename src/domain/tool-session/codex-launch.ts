const VALUE_FLAGS = new Set([
    "-c", "--config", "--enable", "--disable", "-i", "--image", "-m", "--model",
    "--local-provider", "-p", "--profile", "-s", "--sandbox", "-C", "--cd",
    "--add-dir", "-a", "--ask-for-approval",
]);
const BOOLEAN_FLAGS = new Set([
    "--oss", "--strict-config", "--approve-for-me", "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust", "--worktree", "--search", "--no-alt-screen",
    "--last", "--all", "--include-non-interactive",
]);

export interface InteractiveCommand {
    daemonArgs: string[];
    profile: boolean;
}

export function interactiveCommand(command: readonly string[]): InteractiveCommand | null {
    if (command[0] !== "codex") return null;
    let subcommandIndex = 0;
    const result: InteractiveCommand = { daemonArgs: [], profile: false };
    let positional = false;
    for (let index = 1; index < command.length; index += 1) {
        const argument = command[index];
        if (argument === "--") return result;
        if (argument.startsWith("-")) {
            const [flag] = argument.split("=", 1);
            if (VALUE_FLAGS.has(flag)) {
                const args = [argument];
                if (!argument.includes("=")) {
                    if (++index >= command.length) return null;
                    args.push(command[index]);
                }
                if (["-c", "--config", "--enable", "--disable"].includes(flag)) result.daemonArgs.push(...args);
                if (flag === "-p" || flag === "--profile") result.profile = true;
                continue;
            }
            // Accept attached short option values such as -cmodel="...".
            if (!argument.startsWith("--") && argument.length > 2 && VALUE_FLAGS.has(argument.slice(0, 2))) {
                if (argument.startsWith("-c")) result.daemonArgs.push(argument);
                if (argument.startsWith("-p")) result.profile = true;
                continue;
            }
            if (!BOOLEAN_FLAGS.has(argument)) return null;
            continue;
        }
        if (!positional && subcommandIndex === 0) {
            if (argument === "resume" || argument === "fork") subcommandIndex = index;
            // An unrecognized bare word might be a new administrative command.
            else if (!/\s/.test(argument)) return null;
        }
        positional = true;
    }
    return result;
}

export type CodexLaunchPreparation =
    | { ok: true; command: string[]; notice?: string }
    | { ok: false; command: string[]; status: number; error: string };
