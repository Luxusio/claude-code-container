import { describe, it, expect, vi } from 'vitest';
import type { SpawnSyncReturns } from 'child_process';
import { detectHostNetworkReach } from '../network-reach.js';

function spawnResult(overrides: Partial<SpawnSyncReturns<string>> = {}): SpawnSyncReturns<string> {
    return {
        pid: 1,
        output: [],
        stdout: '',
        stderr: '',
        status: null,
        signal: null,
        ...overrides,
    };
}

describe('detectHostNetworkReach', () => {
    it('returns reachable=true when probe exits 0', () => {
        const spawnImpl = vi.fn().mockReturnValue(spawnResult({ status: 0 }));
        let t = 1000;
        const nowImpl = vi.fn().mockImplementation(() => {
            const cur = t;
            t += 7;
            return cur;
        });

        const out = detectHostNetworkReach('test-container', {
            spawnImpl: spawnImpl as unknown as typeof import('child_process').spawnSync,
            nowImpl,
        });

        expect(out.reachable).toBe(true);
        expect(out.reason).toBeUndefined();
        expect(out.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('returns reason=unreachable when probe exits non-zero (connection refused)', () => {
        const spawnImpl = vi.fn().mockReturnValue(spawnResult({ status: 1, stderr: 'Connection refused' }));

        const out = detectHostNetworkReach('test-container', {
            spawnImpl: spawnImpl as unknown as typeof import('child_process').spawnSync,
        });

        expect(out.reachable).toBe(false);
        expect(out.reason).toBe('unreachable');
    });

    it('returns reason=timeout when spawn signals SIGTERM', () => {
        const spawnImpl = vi.fn().mockReturnValue(spawnResult({ status: null, signal: 'SIGTERM' }));

        const out = detectHostNetworkReach('test-container', {
            spawnImpl: spawnImpl as unknown as typeof import('child_process').spawnSync,
        });

        expect(out.reachable).toBe(false);
        expect(out.reason).toBe('timeout');
    });

    it('returns reason=timeout when status is null without signal (spawn timeout)', () => {
        const spawnImpl = vi.fn().mockReturnValue(spawnResult({ status: null, signal: null }));

        const out = detectHostNetworkReach('test-container', {
            spawnImpl: spawnImpl as unknown as typeof import('child_process').spawnSync,
        });

        expect(out.reachable).toBe(false);
        expect(out.reason).toBe('timeout');
    });

    it('returns reason=no-probe when shell reports no probe available (exit 127)', () => {
        const spawnImpl = vi.fn().mockReturnValue(spawnResult({ status: 127, stderr: 'nc: not found' }));

        const out = detectHostNetworkReach('test-container', {
            spawnImpl: spawnImpl as unknown as typeof import('child_process').spawnSync,
        });

        expect(out.reachable).toBe(false);
        expect(out.reason).toBe('no-probe');
    });

    it('uses docker exec with the given container name', () => {
        const spawnImpl = vi.fn().mockReturnValue(spawnResult({ status: 0 }));

        detectHostNetworkReach('my-container', {
            spawnImpl: spawnImpl as unknown as typeof import('child_process').spawnSync,
            runtimeCli: () => 'docker',
        });

        const [bin, args] = spawnImpl.mock.calls[0];
        expect(bin).toBe('docker');
        expect((args as string[])[0]).toBe('exec');
        expect(args).toContain('my-container');
    });

    it('honors custom probeHost / probePort', () => {
        const spawnImpl = vi.fn().mockReturnValue(spawnResult({ status: 0 }));

        detectHostNetworkReach('test', {
            spawnImpl: spawnImpl as unknown as typeof import('child_process').spawnSync,
            probeHost: '10.0.0.1',
            probePort: 8080,
        });

        const argsArr = spawnImpl.mock.calls[0][1] as string[];
        const script = argsArr[argsArr.length - 1];
        expect(script).toContain('10.0.0.1');
        expect(script).toContain('8080');
    });

    it('passes timeout to spawnSync options', () => {
        const spawnImpl = vi.fn().mockReturnValue(spawnResult({ status: 0 }));

        detectHostNetworkReach('test', {
            spawnImpl: spawnImpl as unknown as typeof import('child_process').spawnSync,
            timeoutMs: 1500,
        });

        const opts = spawnImpl.mock.calls[0][2] as { timeout?: number };
        expect(opts.timeout).toBe(1500);
    });

    it('measures latency from injected clock', () => {
        const calls = [10_000, 10_042];
        const nowImpl = vi.fn().mockImplementation(() => calls.shift()!);
        const spawnImpl = vi.fn().mockReturnValue(spawnResult({ status: 0 }));

        const out = detectHostNetworkReach('test', {
            spawnImpl: spawnImpl as unknown as typeof import('child_process').spawnSync,
            nowImpl,
        });

        expect(out.latencyMs).toBe(42);
    });
});
