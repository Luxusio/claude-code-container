import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { SpawnSyncReturns } from 'child_process';
import { detectHostNetworkReach } from '../network-reach.js';

const native = vi.hoisted(() => ({ spawn: vi.fn(), capture: vi.fn(), cached: vi.fn() }));
vi.mock('child_process', async original => ({
    ...await original<typeof import('child_process')>(), spawnSync: native.spawn,
}));
vi.mock('../container-runtime.js', async original => {
    const actual = await original<typeof import('../container-runtime.js')>();
    const { nativeRuntimeInvocationFixture } = await import('./helpers/native-runtime-fixture.js');
    native.capture.mockImplementation((runtime: 'docker' | 'podman') => actual.validateNativeRuntimeInvocation(nativeRuntimeInvocationFixture(runtime)));
    native.cached.mockImplementation(() => actual.validateNativeRuntimeInvocation(nativeRuntimeInvocationFixture('docker')));
    return {...actual, runtimeCli: () => 'docker', currentNativeRuntimeInvocation: () => undefined,
        getRuntimeInvocation: native.cached, captureNativeRuntimeInvocation: native.capture};
});

beforeEach(() => {
    native.spawn.mockReset();
    native.capture.mockClear();
    native.cached.mockClear();
});

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
    it.each(['docker', 'podman'] as const)('honors an option-only %s selector instead of the cached default runtime', runtime => {
        native.spawn.mockReturnValue(spawnResult({status: 0}));
        const select = vi.fn(() => runtime);
        expect(detectHostNetworkReach('same-id', {runtimeCli: select, timeoutMs: 1234}).reachable).toBe(true);
        expect(select).toHaveBeenCalledOnce();
        expect(native.capture).toHaveBeenCalledExactlyOnceWith(runtime);
        expect(native.cached).not.toHaveBeenCalled();
        expect(native.spawn).toHaveBeenCalledOnce();
        const [program, args, options] = native.spawn.mock.calls[0];
        expect(program).toBe(`/fixture/runtime/${runtime}`);
        expect(args.slice(-5, -1)).toEqual(['exec', 'same-id', 'sh', '-c']);
        expect(args.at(-1)).toContain('nc -z -w 2 host.docker.internal 53');
        expect(options).toMatchObject({encoding: 'utf-8', timeout: 1234, stdio: ['pipe', 'pipe', 'pipe'], shell: false});
        expect(options.env.CONTAINER_CONNECTION).toBeUndefined();
        expect(options.env.DOCKER_CONTEXT).toBeUndefined();
    });

    it.each(['fixture-command', '/owned/custom command'])('passes an option-only custom command %s directly to the native process seam', command => {
        native.spawn.mockReturnValue(spawnResult({status: 127}));
        expect(detectHostNetworkReach('same-id', {runtimeCli: () => command, timeoutMs: 4321}).reason).toBe('no-probe');
        expect(native.capture).not.toHaveBeenCalled();
        expect(native.cached).not.toHaveBeenCalled();
        expect(native.spawn).toHaveBeenCalledExactlyOnceWith(command, ['exec', 'same-id', 'sh', '-c', expect.any(String)],
            {encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 4321});
    });

    it('retains an explicit spawn implementation when a runtime selector is also supplied', () => {
        const spawnImpl = vi.fn().mockReturnValue(spawnResult({status: 0}));
        expect(detectHostNetworkReach('same-id', {runtimeCli: () => 'podman', spawnImpl: spawnImpl as unknown as typeof import('child_process').spawnSync}).reachable).toBe(true);
        expect(spawnImpl).toHaveBeenCalledExactlyOnceWith('podman', ['exec', 'same-id', 'sh', '-c', expect.any(String)],
            {encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000});
        expect(native.spawn).not.toHaveBeenCalled();
        expect(native.capture).not.toHaveBeenCalled();
        expect(native.cached).not.toHaveBeenCalled();
    });

    it('preserves a thrown custom-command native failure', () => {
        const failure = {native: 'custom command failed'};
        native.spawn.mockImplementation(() => {throw failure;});
        try {detectHostNetworkReach('same-id', {runtimeCli: () => '/owned/custom-command'}); throw new Error('missing failure');}
        catch (error) {expect(error).toBe(failure);}
        expect(native.capture).not.toHaveBeenCalled();
        expect(native.cached).not.toHaveBeenCalled();
    });

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
