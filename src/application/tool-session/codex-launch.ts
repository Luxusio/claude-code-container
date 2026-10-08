import { interactiveCommand, type CodexLaunchPreparation } from "../../domain/tool-session/codex-launch.js";
import { containerEngineFailureHint } from "../../domain/container-runtime.js";
import type { CodexLaunchPorts } from "../../ports/tool-session/codex-launch.js";

export function createCodexLaunchPreparation<Start>(ports: CodexLaunchPorts<Start>) {
    function prepare(command: readonly string[]): CodexLaunchPreparation {
        const original = [...command];
        const unchanged = { ok: true as const, command: original };
        const interactive = interactiveCommand(command);
        if (!interactive) return unchanged;
        const failure = (error: string, status = 1): CodexLaunchPreparation => ({ ok: false, command: original, status, error });
        try {
            const executable = ports.probeDaemonExecutable();
            const engineFailure = executable.status !== 0 ? containerEngineFailureHint(executable.stderr) : undefined;
            if (engineFailure) return failure(engineFailure);
            if (executable.error || executable.signal || executable.status !== 1
                || executable.stdout !== "ccc-codex-daemon-missing\n" || executable.stderr !== "") return unchanged;
        } catch {
            return unchanged;
        }
        const start = ports.prepareStart();
        let help;
        try {
            help = ports.probeDaemonStartHelp(start);
            const engineFailure = help.status !== 0 ? containerEngineFailureHint(help.stderr) : undefined;
            if (engineFailure) return failure(engineFailure);
        } catch {
            return unchanged;
        }
        if (help.error || help.signal || help.status !== 0
            || !/Usage:\s+\S+\s+app-server\s+daemon\s+start\b/.test(String(help.stdout))) return unchanged;
        if (interactive.profile) return failure("Codex daemon is missing; automatic initialization does not support --profile. Start the daemon with the intended configuration before resuming.");
        try {
            const initialized = ports.initializeDaemon(start, interactive.daemonArgs);
            if (!initialized.error && !initialized.signal && initialized.status !== 0
                && /Error: daemon executable not found at [^\r\n]+[\/]packages[\/]app-server-daemon[\/]current[\/]bin[\/]codex;/.test(String(initialized.stderr))) {
                const help = ports.probeDaemonFallbackHelp();
                if (!help.error && !help.signal && help.status === 0
                    && /^\s+--no-daemon\s*$/m.test(String(help.stdout))) {
                    return {
                        ok: true,
                        command: [original[0], "--no-daemon", ...original.slice(1)],
                        notice: "Codex daemon installation is incomplete; running this session without the background server. Session history is preserved.",
                    };
                }
            }
            if (initialized.error || initialized.signal || initialized.status !== 0) {
                const status = initialized.signal === "SIGINT" ? 130 : initialized.signal === "SIGTERM" ? 143 : initialized.signal === "SIGHUP" ? 129
                    : typeof initialized.status === "number" && initialized.status > 0 ? initialized.status : 1;
                const cause = initialized.error?.message || (initialized.signal ? `signal ${initialized.signal}` : String(initialized.stderr || initialized.stdout).trim() || `exit ${initialized.status}`);
                return failure(`Codex daemon initialization failed: ${cause.slice(0, 1000)}`, status);
            }
            return unchanged;
        } catch (error) {
            return failure(`Codex daemon initialization failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 1000)}`);
        }
    }

    return { prepare };
}
