import { failedResumeRollout, missingResumeMetadata, migrationRepairedThread, supportsRolloutMigration } from "./codex-resume-diagnostics.js";
import { restoreResumeMetadata, type ResumeMetadataFailureStage } from "./codex-resume-metadata.js";
import { terminalResumeCommand, type ResumeProcessRunner } from "./codex-resume-process.js";
import type { ResumeProcessResult } from "./codex-resume-process.js";
import { createCodexResumeRecovery } from "./application/tool-session/codex-resume-recovery.js";

export interface CodexResumeRecoveryPlan {
    command: string[];
    retry: string[];
    config: string[];
    selector?: string;
}

type ResumeFailureStage = ResumeMetadataFailureStage | "migration" | "migration-after-metadata";

const FAILURE_EXPLANATIONS: Record<ResumeFailureStage, string> = {
    "metadata-support": "Codex metadata recovery is unavailable",
    "metadata-home": "Could not verify the Codex data directory",
    "metadata-initialize": "Could not verify the metadata server",
    "metadata-read": "Could not restore this session's metadata",
    "metadata-close": "The metadata server did not finish cleanly",
    "migration": "Session migration failed",
    "migration-after-metadata": "Session migration failed after metadata recovery",
};

function failureMessage(stage: ResumeFailureStage): string {
    return `[ccc] ${FAILURE_EXPLANATIONS[stage]} (${stage}).\n`;
}

/** Native bindings keep process/protocol authority and the original callee lookup order. */
export const runCodexResumeRecovery: (
    plan: CodexResumeRecoveryPlan,
    runner: ResumeProcessRunner,
    home: string,
    report: (message: string) => void,
) => Promise<number> = createCodexResumeRecovery<ResumeProcessRunner, string, (message: string) => void, ResumeProcessResult>({
    probeTerminal: ({ runner }) => runner.run(["/usr/bin/script", "--version"], { timeoutMs: 5000 }),
    terminalSupported: script => script.code === 0 && script.output.includes("util-linux"),
    launchOriginal: ({ runner }, command, direct) => direct
        ? runner.run(command, { direct: true })
        : runner.run(terminalResumeCommand(command), { terminal: true }),
    recoverableOriginal: first => first.code === 1 && !first.signal,
    qualifyRollout: ({ home }, first, selector) => failedResumeRollout(first.output, home, selector),
    probeMigration: ({ runner }, command) => runner.run([command[0], "migrate-rollouts", "--help"], { timeoutMs: 5000 }),
    supportsMigration: help => supportsRolloutMigration(help),
    migrateThread: ({ runner }, command, config, id) => runner.run(
        [command[0], "migrate-rollouts", ...config, "--apply", "--thread", id, "--json"],
        { timeoutMs: 60000 },
    ),
    missingMetadata: (migration, id) => missingResumeMetadata(migration, id),
    restoreMetadata: ({ runner, home }, command, config, rollout) => restoreResumeMetadata(command[0], config, rollout, home, runner),
    migrationSucceeded: migration => migration.code === 0 && !migration.signal && !migration.overflow,
    repairedThread: (migration, id) => migrationRepairedThread(migration.output, id),
    retryResume: ({ runner }, retry, id) => runner.run(terminalResumeCommand([...retry, id]), { terminal: true }),
    exitCode: observation => observation.code,
    interruption: ({ runner }) => runner.interrupted,
    reportRecovery: ({ report }) => { report("[ccc] Repairing this session's history index and resuming once.\n"); },
    reportFailure: ({ report }, stage) => { report(failureMessage(stage)); },
    dispose: ({ runner }) => { runner.dispose(); },
});
