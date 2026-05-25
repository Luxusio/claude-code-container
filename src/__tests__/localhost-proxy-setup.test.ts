import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';

vi.mock('child_process', () => ({
    spawnSync: vi.fn(),
}));

const mockIsContainerHostRemote = vi.fn<() => boolean>().mockReturnValue(false);
vi.mock('../container-runtime.js', () => ({
    runtimeCli: () => 'docker',
    isContainerHostRemote: (...args: unknown[]) => mockIsContainerHostRemote(...(args as [])),
}));

const mockDetectHostNetworkReach = vi.fn();
vi.mock('../network-reach.js', () => ({
    detectHostNetworkReach: (...args: unknown[]) => mockDetectHostNetworkReach(...args),
}));

const mockSpawnSync = vi.mocked(spawnSync);

const OK = { status: 0, stdout: '', stderr: '', pid: 0, signal: null, output: [] } as any;
const FAIL = { status: 1, stdout: '', stderr: '', pid: 0, signal: null, output: [] } as any;

describe('setupLocalhostProxy (post-entrypoint verification layer)', () => {
    const originalPlatform = process.platform;
    let warnSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.resetAllMocks();
        mockIsContainerHostRemote.mockReturnValue(false);
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });

    it('skips entirely on native Linux Docker (--network host works natively)', async () => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        mockIsContainerHostRemote.mockReturnValue(false);
        const { setupLocalhostProxy } = await import('../localhost-proxy-setup.js');

        setupLocalhostProxy('test-container');

        expect(mockDetectHostNetworkReach).not.toHaveBeenCalled();
        expect(mockSpawnSync).not.toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it('skips when the container already has direct host reach (mirrored mode)', async () => {
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        mockDetectHostNetworkReach.mockReturnValue({ reachable: true, latencyMs: 3 });

        const { setupLocalhostProxy } = await import('../localhost-proxy-setup.js');
        setupLocalhostProxy('test-container');

        expect(mockDetectHostNetworkReach).toHaveBeenCalledWith('test-container', { timeoutMs: 1500 });
        // No further checks — the proxy is unnecessary in this environment.
        expect(mockSpawnSync).not.toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it('confirms silently when host is unreachable and the proxy daemon is running', async () => {
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        mockDetectHostNetworkReach.mockReturnValue({ reachable: false, latencyMs: 12, reason: 'unreachable' });
        mockSpawnSync.mockReturnValue(OK); // isProxyRunning → port listening

        const { setupLocalhostProxy } = await import('../localhost-proxy-setup.js');
        setupLocalhostProxy('test-container');

        expect(mockSpawnSync).toHaveBeenCalledTimes(1);
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it('warns loudly when host is unreachable AND the proxy daemon is missing', async () => {
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        mockDetectHostNetworkReach.mockReturnValue({ reachable: false, latencyMs: 12, reason: 'unreachable' });
        mockSpawnSync.mockReturnValue(FAIL); // proxy port not listening

        const { setupLocalhostProxy } = await import('../localhost-proxy-setup.js');
        setupLocalhostProxy('test-container');

        expect(warnSpy).toHaveBeenCalled();
        const messages = warnSpy.mock.calls.map((c) => c[0] as string).join('\n');
        expect(messages).toMatch(/proxy daemon not detected/i);
        expect(messages).toContain('docker logs test-container');
    });

    it('runs the verification path on Windows (win32) the same as darwin', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        mockDetectHostNetworkReach.mockReturnValue({ reachable: false, latencyMs: 50, reason: 'timeout' });
        mockSpawnSync.mockReturnValue(OK);

        const { setupLocalhostProxy } = await import('../localhost-proxy-setup.js');
        setupLocalhostProxy('test-container');

        expect(mockDetectHostNetworkReach).toHaveBeenCalled();
        expect(mockSpawnSync).toHaveBeenCalledTimes(1);
    });

    it('runs the verification path on Linux when the container host is remote (WSL2)', async () => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        mockIsContainerHostRemote.mockReturnValue(true);
        mockDetectHostNetworkReach.mockReturnValue({ reachable: false, latencyMs: 8, reason: 'unreachable' });
        mockSpawnSync.mockReturnValue(OK);

        const { setupLocalhostProxy } = await import('../localhost-proxy-setup.js');
        setupLocalhostProxy('test-container');

        expect(mockDetectHostNetworkReach).toHaveBeenCalled();
        expect(mockSpawnSync).toHaveBeenCalledTimes(1);
    });
});
