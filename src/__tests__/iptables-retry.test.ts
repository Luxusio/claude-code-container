import { describe, it, expect, vi } from 'vitest';
import { runIptablesWithBoundedRetry } from '../iptables-retry.js';

const ok = () => ({ status: 0, stderr: '' });
const lockBusy = () => ({ status: 4, stderr: 'Another app is currently holding the xtables lock' });
const hardError = (stderr = 'iptables: No chain/target/match by that name.') => ({ status: 1, stderr });

describe('runIptablesWithBoundedRetry', () => {
    it('returns ok=true on first-attempt success', () => {
        const spawnImpl = vi.fn().mockReturnValue(ok());
        const sleepImpl = vi.fn();

        const result = runIptablesWithBoundedRetry(['-t', 'nat', '-A', 'OUTPUT'], {
            spawnImpl,
            sleepImpl,
        });

        expect(result.ok).toBe(true);
        expect(result.attempts).toBe(1);
        expect(result.lastExitCode).toBe(0);
        expect(spawnImpl).toHaveBeenCalledTimes(1);
        expect(sleepImpl).not.toHaveBeenCalled();
    });

    it('retries on lock-busy (exit 4) and succeeds on the 3rd attempt', () => {
        const spawnImpl = vi.fn()
            .mockReturnValueOnce(lockBusy())
            .mockReturnValueOnce(lockBusy())
            .mockReturnValueOnce(ok());
        const sleepImpl = vi.fn();

        const result = runIptablesWithBoundedRetry(['-t', 'nat', '-A', 'OUTPUT'], {
            spawnImpl,
            sleepImpl,
        });

        expect(result.ok).toBe(true);
        expect(result.attempts).toBe(3);
        expect(spawnImpl).toHaveBeenCalledTimes(3);
        // sleep between attempts only — no trailing sleep after the final success.
        expect(sleepImpl).toHaveBeenCalledTimes(2);
    });

    it('gives up after maxAttempts lock-busy responses', () => {
        const spawnImpl = vi.fn().mockReturnValue(lockBusy());
        const sleepImpl = vi.fn();

        const result = runIptablesWithBoundedRetry(['-t', 'nat', '-A', 'OUTPUT'], {
            spawnImpl,
            sleepImpl,
            maxAttempts: 3,
        });

        expect(result.ok).toBe(false);
        expect(result.attempts).toBe(3);
        expect(result.lastExitCode).toBe(4);
        expect(result.lastStderr).toContain('xtables lock');
        // No sleep after the final attempt — only between attempts.
        expect(sleepImpl).toHaveBeenCalledTimes(2);
    });

    it('does not retry on hard errors (exit 1)', () => {
        const spawnImpl = vi.fn().mockReturnValue(hardError('iptables v1.8.7: unknown option'));
        const sleepImpl = vi.fn();

        const result = runIptablesWithBoundedRetry(['-t', 'nat', '-A', 'OUTPUT'], {
            spawnImpl,
            sleepImpl,
        });

        expect(result.ok).toBe(false);
        expect(result.attempts).toBe(1);
        expect(result.lastExitCode).toBe(1);
        expect(result.lastStderr).toContain('unknown option');
        expect(sleepImpl).not.toHaveBeenCalled();
    });

    it('treats null status (signal/timeout) as retryable', () => {
        const spawnImpl = vi.fn()
            .mockReturnValueOnce({ status: null, stderr: '' })
            .mockReturnValueOnce(ok());
        const sleepImpl = vi.fn();

        const result = runIptablesWithBoundedRetry(['-t', 'nat', '-A', 'OUTPUT'], {
            spawnImpl,
            sleepImpl,
        });

        expect(result.ok).toBe(true);
        expect(result.attempts).toBe(2);
        expect(sleepImpl).toHaveBeenCalledTimes(1);
    });

    it('uses exponential backoff (200ms, 400ms, ...)', () => {
        const spawnImpl = vi.fn().mockReturnValue(lockBusy());
        const sleepImpl = vi.fn();

        runIptablesWithBoundedRetry(['-t', 'nat', '-A', 'OUTPUT'], {
            spawnImpl,
            sleepImpl,
            initialBackoffMs: 200,
            maxAttempts: 3,
        });

        expect(sleepImpl).toHaveBeenNthCalledWith(1, 200);
        expect(sleepImpl).toHaveBeenNthCalledWith(2, 400);
    });

    it('prepends -w <lockWaitSec> to the iptables args', () => {
        const spawnImpl = vi.fn().mockReturnValue(ok());

        runIptablesWithBoundedRetry(['-t', 'nat', '-A', 'OUTPUT'], {
            spawnImpl,
            sleepImpl: () => {},
            lockWaitSec: 5,
        });

        const [bin, args] = spawnImpl.mock.calls[0];
        expect(bin).toBe('iptables');
        expect(args[0]).toBe('-w');
        expect(args[1]).toBe('5');
        expect(args.slice(2)).toEqual(['-t', 'nat', '-A', 'OUTPUT']);
    });

    it('honors a custom iptablesBin path', () => {
        const spawnImpl = vi.fn().mockReturnValue(ok());

        runIptablesWithBoundedRetry(['-A', 'OUTPUT'], {
            spawnImpl,
            sleepImpl: () => {},
            iptablesBin: '/usr/sbin/iptables-nft',
        });

        expect(spawnImpl.mock.calls[0][0]).toBe('/usr/sbin/iptables-nft');
    });

    it('reports totalMs based on the injected clock and includes sleep time', () => {
        let t = 1000;
        const nowImpl = () => t;
        const spawnImpl = vi.fn().mockImplementation(() => {
            t += 50;
            return lockBusy();
        });
        const sleepImpl = vi.fn().mockImplementation((ms: number) => { t += ms; });

        const result = runIptablesWithBoundedRetry(['-A', 'OUTPUT'], {
            spawnImpl,
            sleepImpl,
            nowImpl,
            initialBackoffMs: 100,
            maxAttempts: 3,
        });

        // 3 spawns × 50ms = 150ms, 2 sleeps (100ms + 200ms) = 300ms → 450ms total.
        expect(result.totalMs).toBe(450);
        expect(result.ok).toBe(false);
        expect(result.attempts).toBe(3);
    });
});
