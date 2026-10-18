export interface AndroidAvdIdentityCommandResult {
    status?: number | null;
    stdout?: string;
    stderr?: string;
    error?: unknown;
}

export function readAndroidAvdIdentity(
    serial: string,
    runAdb: (args: string[]) => AndroidAvdIdentityCommandResult,
): { ok: true; name: string } | { ok: false; detail: string };

export function readAndroidAvdIdentityAsync(
    serial: string,
    runAdb: (args: string[]) => AndroidAvdIdentityCommandResult | PromiseLike<AndroidAvdIdentityCommandResult>,
): Promise<{ ok: true; name: string } | { ok: false; detail: string }>;
