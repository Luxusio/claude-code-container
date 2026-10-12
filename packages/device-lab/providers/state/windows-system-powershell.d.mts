export function canonicalWindowsSystemExecutablePath(relativePath: string, testSystemRoot?: string): string | null;
export function canonicalWindowsPowerShellPath(testSystemRoot?: string): string | null;
export function hiddenWindowsPowerShellArgs(args: readonly string[]): string[];
export function windowsHandleBoundTerminationScript(): string;
export function terminateWindowsProcessByStartToken(
    pid: number,
    expectedStartToken: string,
    timeoutMs?: number,
    powershellPath?: string | null,
): {
    ok: boolean;
    pid: number;
    status?: number | null;
    method?: "process-handle";
    reason?: "windows-process-identity-unavailable" | "process-start-token-mismatch" | "process-termination-timeout";
    error?: string;
};
