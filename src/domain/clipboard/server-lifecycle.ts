export interface ClipboardPortRecord { port: number; token: string }
export interface ClipboardHealthResult { alive: boolean; version?: string }
export const HEALTH_CHECK_TIMEOUT_MS = 2000;
export const STARTUP_POLL_INTERVAL_MS = 100;
export const STARTUP_POLL_TIMEOUT_MS = 5000;
export const SHUTDOWN_TIMEOUT_MS = 2000;
export const UPGRADE_SHUTDOWN_GRACE_MS = 3500;
export const STARTUP_LOCK_TIMEOUT_MS = HEALTH_CHECK_TIMEOUT_MS + SHUTDOWN_TIMEOUT_MS
    + UPGRADE_SHUTDOWN_GRACE_MS + STARTUP_POLL_TIMEOUT_MS + 1000;
