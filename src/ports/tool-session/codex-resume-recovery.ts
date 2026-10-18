import type {
    CodexResumeFailureStage, CodexResumeInvocation, CodexResumeMetadataResult,
    CodexResumeRollout,
} from "../../domain/tool-session/codex-resume.js";

export interface CodexResumeRecoveryPorts<Runner, Home, Reporter, Observation = unknown> {
    readonly probeTerminal: (invocation: CodexResumeInvocation<Runner, Home, Reporter>) => Promise<Observation>;
    readonly terminalSupported: (observation: Observation) => boolean;
    readonly launchOriginal: (invocation: CodexResumeInvocation<Runner, Home, Reporter>, command: readonly string[], direct: boolean) => Promise<Observation>;
    readonly recoverableOriginal: (observation: Observation) => boolean;
    readonly qualifyRollout: (invocation: CodexResumeInvocation<Runner, Home, Reporter>, first: Observation, selector?: string) => CodexResumeRollout | null;
    readonly probeMigration: (invocation: CodexResumeInvocation<Runner, Home, Reporter>, command: readonly string[]) => Promise<Observation>;
    readonly supportsMigration: (help: Observation) => boolean;
    readonly migrateThread: (invocation: CodexResumeInvocation<Runner, Home, Reporter>, command: readonly string[], config: readonly string[], id: string) => Promise<Observation>;
    readonly missingMetadata: (migration: Observation, id: string) => boolean;
    readonly restoreMetadata: (invocation: CodexResumeInvocation<Runner, Home, Reporter>, command: readonly string[], config: readonly string[], rollout: CodexResumeRollout) => Promise<CodexResumeMetadataResult>;
    readonly migrationSucceeded: (observation: Observation) => boolean;
    readonly repairedThread: (migration: Observation, id: string) => boolean;
    readonly retryResume: (invocation: CodexResumeInvocation<Runner, Home, Reporter>, retry: readonly string[], id: string) => Promise<Observation>;
    readonly exitCode: (observation: Observation) => number;
    readonly interruption: (invocation: CodexResumeInvocation<Runner, Home, Reporter>) => number;
    readonly reportRecovery: (invocation: CodexResumeInvocation<Runner, Home, Reporter>) => void;
    readonly reportFailure: (invocation: CodexResumeInvocation<Runner, Home, Reporter>, stage: CodexResumeFailureStage) => void;
    readonly dispose: (invocation: CodexResumeInvocation<Runner, Home, Reporter>) => void;
}
