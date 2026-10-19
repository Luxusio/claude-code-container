export interface ClipboardPortRecord { port: number; token: string; readonly retired?: true }
export interface ClipboardSelection extends ClipboardPortRecord { readonly portFile: string }
export interface ClipboardHealthResult { alive: boolean; version?: string; retirement?: "writer-settlement-v1" }
export const CLIPBOARD_SERVER_ORPHAN_GRACE_MS = 15000;
export const HEALTH_CHECK_TIMEOUT_MS = 2000;
export const STARTUP_POLL_INTERVAL_MS = 100;
export const STARTUP_POLL_TIMEOUT_MS = 5000;
export const SHUTDOWN_TIMEOUT_MS = 2000;
export const UPGRADE_SHUTDOWN_GRACE_MS = 3500;
export const STARTUP_LOCK_TIMEOUT_MS = HEALTH_CHECK_TIMEOUT_MS + SHUTDOWN_TIMEOUT_MS
    + UPGRADE_SHUTDOWN_GRACE_MS + STARTUP_POLL_TIMEOUT_MS + 1000;

export function clipboardServerOrphanWatchdogState(
    now: number,
    noActiveSessionsSince: number | null,
    hasActiveSessions: boolean,
): { noActiveSessionsSince: number | null; shouldShutdown: boolean } {
    if (hasActiveSessions) return { noActiveSessionsSince: null, shouldShutdown: false };
    const since = noActiveSessionsSince ?? now;
    return {
        noActiveSessionsSince: since,
        shouldShutdown: now - since >= CLIPBOARD_SERVER_ORPHAN_GRACE_MS,
    };
}
