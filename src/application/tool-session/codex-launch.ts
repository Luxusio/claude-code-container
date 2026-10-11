import { interactiveCommand, type CodexLaunchSemanticPreparation } from "../../domain/tool-session/codex-launch.js";
import type { CodexLaunchPorts } from "../../ports/tool-session/codex-launch.js";

export function createCodexLaunchPreparation<Start>(ports: CodexLaunchPorts<Start>) {
    function prepare(command: readonly string[]): CodexLaunchSemanticPreparation {
        const original = [...command];
        const unchanged = { ok: true as const, command: original };
        const interactive = interactiveCommand(command);
        if (!interactive) return unchanged;
        const failure = (reason: "engine-unavailable" | "profile-unsupported" | "initialization-failed", status = 1, cause?: unknown): CodexLaunchSemanticPreparation => ({ ok: false, command: original, status, reason, cause });
        try {
            const executable = ports.probeDaemonExecutable();
            if (executable.kind === "engine-unavailable") return failure("engine-unavailable", 1, executable.cause);
            if (executable.kind !== "missing") return unchanged;
        } catch {
            return unchanged;
        }
        // Preparing the native start remains outside the inconclusive-probe catches.
        const start = ports.prepareStart();
        try {
            const help = ports.probeDaemonStartHelp(start);
            if (help.kind === "engine-unavailable") return failure("engine-unavailable", 1, help.cause);
            if (help.kind !== "supported") return unchanged;
        } catch {
            return unchanged;
        }
        if (interactive.profile) return failure("profile-unsupported");
        try {
            const initialized = ports.initializeDaemon(start, interactive.daemonArgs);
            if (initialized.kind === "success") return unchanged;
            if (initialized.kind === "installation-incomplete" && ports.probeDaemonFallbackHelp().kind === "supported") {
                return { ok: true, command: original, reason: "installation-incomplete-fallback" };
            }
            return failure("initialization-failed", initialized.status, initialized.cause);
        } catch (error) {
            const observed = ports.describeInitializationFailure(error);
            return failure("initialization-failed", observed.status, observed.cause);
        }
    }

    return { prepare };
}
