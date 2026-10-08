export interface RemoteConfig {
    host: string;
    user: string;
    remotePath: string;
}

export function parseMutagenSyncStatus(output: string): string {
    const statusMatch = output.match(/Status:\s*(.+)/);
    return statusMatch ? statusMatch[1].trim() : "Unknown";
}

export function isValidHostOrUser(value: string): boolean {
    return /^[a-zA-Z0-9._-]+$/.test(value) && value.length > 0 && value.length <= 253;
}


/**
 * Escape a single argument for safe interpolation inside a shell command.
 * Wraps the value in single quotes and escapes any embedded single quotes.
 */
export function shellEscapeArg(arg: string): string {
    return "'" + arg.replace(/'/g, "'\\''") + "'";
}

export type RemoteSignal = "SIGINT" | "SIGTERM";
export interface RemoteCommandResult {
    readonly status: number | null;
    readonly stdout?: string | null;
    readonly stderr?: string | null;
    readonly error?: { readonly message?: string } | null;
}
export interface RemoteHeartbeat { unref(): undefined; cancel(): undefined; }
export interface RemoteSshChannel {
    onClose(callback: (code: number | null) => void): undefined;
    onError(callback: (error: { message: string }) => void): undefined;
    kill(signal: RemoteSignal): boolean;
}
export interface RemoteForwardedEnvPlan {
    forwarded: Array<[string, string]>;
    skippedDueToLimit: string[];
    totalBytes: number;
}

/** Inherited-stdio effects expose only fields actually interpreted by policy. */
export interface RemoteActionResult { readonly status: number | null; readonly error?: { readonly message?: string } | null; }
