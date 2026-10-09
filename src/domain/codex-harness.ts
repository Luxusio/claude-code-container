export interface CodexHarnessObservation {
    readonly stdout?: string;
    readonly stderr?: string;
    readonly status: number | null;
    readonly error?: Error;
}

export function codexHarnessExecutionFailure(result: CodexHarnessObservation): Error {
    return new Error(result.error?.message ?? (result.stderr?.trim() || `bootstrap exited ${result.status}`));
}

export function codexHarnessUnavailableMessage(error: unknown): string {
    return `[ccc] Harness is unavailable: ${error instanceof Error ? error.message : String(error)}. Codex will continue. Check the container's ~/.codex/config.toml and Harness installation, then retry ccc codex.`;
}
