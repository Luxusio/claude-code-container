import type { CodexHarnessObservation } from "../domain/codex-harness.js";

export interface CodexHarnessPorts {
    readonly withConfigLock: <T>(operation: () => T, profile?: string) => T;
    readonly prepareConfig: (container: string, profile?: string) => void;
    readonly executeBootstrap: (container: string) => CodexHarnessObservation;
    readonly restoreAccess: (container: string, profile?: string) => void;
    readonly publishBootstrapOutput: (message: string) => undefined;
    readonly publishUnavailable: (error: unknown) => undefined;
}
