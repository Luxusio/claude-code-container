// src/iptables-retry.ts — bounded-retry helper for iptables calls.
//
// iptables exit codes (from iptables/include/iptables.h and historic practice):
//   0 — success
//   1 — generic error (bad rule, missing chain, permission, etc.)
//   2 — invalid command-line arguments
//   4 — RESOURCE_PROBLEM / could not acquire xtables lock
//   3 — version mismatch
// Only exit code 4 (lock busy) and null (signal/timeout — the spawn wrapper
// killed the process) are retryable. Anything else is a configuration error
// that retrying will not fix.
//
// This helper is pure: it accepts `spawnImpl`, `sleepImpl`, and `nowImpl`
// injections so it can be exercised without touching the real binary.

export interface SpawnResult {
    status: number | null;
    stderr: string;
}

export interface RetryResult {
    ok: boolean;
    attempts: number;
    totalMs: number;
    lastExitCode?: number;
    lastStderr?: string;
}

export interface RetryOptions {
    spawnImpl: (cmd: string, args: string[]) => SpawnResult;
    sleepImpl?: (ms: number) => void;
    nowImpl?: () => number;
    maxAttempts?: number;
    initialBackoffMs?: number;
    iptablesBin?: string;
    lockWaitSec?: number;
}

const LOCK_BUSY_EXIT = 4;

export function runIptablesWithBoundedRetry(args: string[], opts: RetryOptions): RetryResult {
    const spawnImpl = opts.spawnImpl;
    const sleepImpl = opts.sleepImpl ?? defaultSleep;
    const nowImpl = opts.nowImpl ?? Date.now;
    const maxAttempts = opts.maxAttempts ?? 3;
    const initialBackoffMs = opts.initialBackoffMs ?? 200;
    const iptablesBin = opts.iptablesBin ?? "iptables";
    const lockWaitSec = opts.lockWaitSec ?? 2;

    const start = nowImpl();
    const fullArgs = ["-w", String(lockWaitSec), ...args];

    let attempts = 0;
    let lastStatus: number | null = null;
    let lastStderr = "";
    let backoff = initialBackoffMs;

    while (attempts < maxAttempts) {
        attempts++;
        const result = spawnImpl(iptablesBin, fullArgs);
        lastStatus = result.status;
        lastStderr = result.stderr ?? "";

        if (result.status === 0) {
            return {
                ok: true,
                attempts,
                totalMs: nowImpl() - start,
                lastExitCode: 0,
                lastStderr,
            };
        }

        const retryable = result.status === LOCK_BUSY_EXIT || result.status === null;
        if (!retryable) {
            return {
                ok: false,
                attempts,
                totalMs: nowImpl() - start,
                lastExitCode: result.status ?? undefined,
                lastStderr,
            };
        }

        if (attempts < maxAttempts) {
            sleepImpl(backoff);
            backoff *= 2;
        }
    }

    return {
        ok: false,
        attempts,
        totalMs: nowImpl() - start,
        lastExitCode: lastStatus ?? undefined,
        lastStderr,
    };
}

// Synchronous sleep via Atomics.wait so this helper can be used inside the
// existing spawnSync-based setup flow without forcing callers to go async.
function defaultSleep(ms: number): void {
    if (ms <= 0) return;
    const sab = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(sab, 0, 0, ms);
}
