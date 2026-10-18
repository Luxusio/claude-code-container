import type { CodexResumeRecoveryPlan } from "../../domain/tool-session/codex-resume.js";
import type { CodexResumeRecoveryPorts } from "../../ports/tool-session/codex-resume-recovery.js";

/** One original launch, qualified native repair, optional metadata fallback and one retry. */
export function createCodexResumeRecovery<Runner, Home, Reporter, Observation = unknown>(
    ports: CodexResumeRecoveryPorts<Runner, Home, Reporter, Observation>,
) {
    // Keep the public async boundary, name and arity without an adopting facade.
    return async function runCodexResumeRecovery(
        plan: CodexResumeRecoveryPlan,
        runner: Runner,
        home: Home,
        report: Reporter,
    ): Promise<number> {
        const { command, retry, config, selector } = plan;
        const invocation = { runner, home, report };
        try {
            const script = await ports.probeTerminal(invocation);
            if (ports.interruption(invocation)) return ports.interruption(invocation);
            if (!ports.terminalSupported(script)) {
                const direct = await ports.launchOriginal(invocation, command, true);
                return ports.exitCode(direct);
            }
            const first = await ports.launchOriginal(invocation, command, false);
            if (ports.interruption(invocation)) return ports.interruption(invocation);
            if (!ports.recoverableOriginal(first)) return ports.exitCode(first);
            const rollout = ports.qualifyRollout(invocation, first, selector);
            if (!rollout) return ports.exitCode(first);
            const { id } = rollout;
            const help = await ports.probeMigration(invocation, command);
            if (ports.interruption(invocation)) return ports.interruption(invocation);
            if (!ports.supportsMigration(help)) return ports.exitCode(first);
            ports.reportRecovery(invocation);
            let migrationStage: "migration" | "migration-after-metadata" = "migration";
            let migration = await ports.migrateThread(invocation, command, config, id);
            if (ports.interruption(invocation)) return ports.interruption(invocation);
            if (ports.missingMetadata(migration, id)) {
                const restored = await ports.restoreMetadata(invocation, command, config, rollout);
                if (ports.interruption(invocation)) return ports.interruption(invocation);
                if (!restored.ok) {
                    ports.reportFailure(invocation, restored.stage);
                    return ports.exitCode(first);
                }
                migrationStage = "migration-after-metadata";
                migration = await ports.migrateThread(invocation, command, config, id);
                if (ports.interruption(invocation)) return ports.interruption(invocation);
            }
            const repaired = ports.migrationSucceeded(migration)
                && ports.repairedThread(migration, id);
            if (!repaired) {
                ports.reportFailure(invocation, migrationStage);
                return ports.exitCode(first);
            }
            const resumed = await ports.retryResume(invocation, retry, id);
            return ports.exitCode(resumed);
        } finally {
            ports.dispose(invocation);
        }
    };
}
