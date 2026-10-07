import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';

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

    it.each([
        ['unavailable shell', { ...FAIL, status: 127 }],
        ['timed out', { ...FAIL, status: null, signal: 'SIGTERM', error: new Error('ETIMEDOUT') }],
        ['failed exec', { ...OK, error: new Error('spawn docker ENOENT') }],
    ])('warns when listener inspection %s', async (_reason, result) => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        mockIsContainerHostRemote.mockReturnValue(true);
        mockDetectHostNetworkReach.mockReturnValue({ reachable: false, reason: 'unreachable' });
        mockSpawnSync.mockReturnValue(result);

        const { setupLocalhostProxy } = await import('../localhost-proxy-setup.js');
        setupLocalhostProxy('test-container');

        expect(mockSpawnSync.mock.calls[0][2]).toMatchObject({ timeout: 5000 });
        expect(warnSpy.mock.calls.flat().join('\n')).toContain('docker logs test-container');
    });

    describe.skipIf(originalPlatform === 'win32')('production socket inspection script', () => {
        async function probeScript(): Promise<string> {
            Object.defineProperty(process, 'platform', { value: originalPlatform });
            mockIsContainerHostRemote.mockReturnValue(true);
            mockDetectHostNetworkReach.mockReturnValue({ reachable: false, reason: 'unreachable' });
            mockSpawnSync.mockReturnValue(OK);
            const { setupLocalhostProxy } = await import('../localhost-proxy-setup.js');
            setupLocalhostProxy('test-container');
            const args = mockSpawnSync.mock.calls[0][1] as string[];
            expect(args.slice(0, 4)).toEqual(['exec', 'test-container', 'bash', '-c']);
            return args[4];
        }

        it.each([
            ['exact loopback listener', '0100007F:4E1F', '0A', 0],
            ['different address', '0200007F:4E1F', '0A', 1],
            ['wildcard address', '00000000:4E1F', '0A', 1],
            ['different port', '0100007F:4E20', '0A', 1],
            ['port suffix match', '0100007F:14E1F', '0A', 1],
            ['established connection', '0100007F:4E1F', '01', 1],
            ['listener port only in remote address', '0100007F:4E20', '0A', 1],
        ])('accepts only the exact LISTEN socket: %s', async (name, localAddress, state, expected) => {
            const script = await probeScript();
            const { spawnSync: actualSpawnSync } = await vi.importActual<typeof import('child_process')>('child_process');
            const directory = mkdtempSync(join(tmpdir(), 'ccc-proxy-table-'));
            const table = join(directory, 'tcp');
            try {
                const remoteAddress = name === 'listener port only in remote address' ? '0100007F:4E1F' : '00000000:0000';
                writeFileSync(table, `  sl  local_address rem_address st tx_queue rx_queue\n  0: ${localAddress} ${remoteAddress} ${state} 00000000:00000000\n`);
                const result = actualSpawnSync('/bin/bash', ['-c', script.replace('/proc/net/tcp', '"$CCC_TEST_TCP_TABLE"')], {
                    encoding: 'utf-8',
                    env: { ...process.env, PATH: '', BASH_ENV: '', CCC_TEST_TCP_TABLE: table },
                    timeout: 1000,
                });
                expect(result.error).toBeUndefined();
                expect(result.status).toBe(expected);
                expect(result.stderr).toBe('');
            } finally {
                rmSync(directory, { recursive: true, force: true });
            }
        });

        it.each(['empty', 'malformed', 'unavailable'])('rejects socket table when %s', async (kind) => {
            const script = await probeScript();
            const { spawnSync: actualSpawnSync } = await vi.importActual<typeof import('child_process')>('child_process');
            const directory = mkdtempSync(join(tmpdir(), 'ccc-proxy-table-'));
            const table = join(directory, 'tcp');
            try {
                if (kind !== 'unavailable') writeFileSync(table, kind === 'empty' ? '' : '0100007F:4E1F 0A\n');
                const result = actualSpawnSync('/bin/bash', ['-c', script.replace('/proc/net/tcp', '"$CCC_TEST_TCP_TABLE"')], {
                    encoding: 'utf-8',
                    env: { ...process.env, PATH: '', BASH_ENV: '', CCC_TEST_TCP_TABLE: table },
                    timeout: 1000,
                });
                expect(result.error).toBeUndefined();
                expect(result.status).toBe(1);
            } finally {
                rmSync(directory, { recursive: true, force: true });
            }
        });

        it.skipIf(originalPlatform !== 'linux')('detects a real loopback listener without connecting or requiring ss', async () => {
            const script = await probeScript();
            expect(script).toContain('0100007F:4E1F');
            const { spawnSync: actualSpawnSync } = await vi.importActual<typeof import('child_process')>('child_process');
            let acceptedConnections = 0;
            const server = createServer((socket) => {
                acceptedConnections++;
                socket.destroy();
            });
            await new Promise<void>((resolve, reject) => {
                server.once('error', reject);
                server.listen(0, '127.0.0.1', resolve);
            });
            try {
                const address = server.address();
                if (!address || typeof address === 'string') throw new Error('Missing fixture listener address');
                // Use an ephemeral port so the test cannot disturb a real CCC proxy.
                const fixtureAddress = `0100007F:${address.port.toString(16).toUpperCase().padStart(4, '0')}`;
                const result = actualSpawnSync('/bin/bash', ['-c', script.replace('0100007F:4E1F', fixtureAddress)], {
                    encoding: 'utf-8',
                    env: { ...process.env, PATH: '', BASH_ENV: '' },
                    timeout: 1000,
                });
                expect(result.error).toBeUndefined();
                expect(result.status).toBe(0);
                await new Promise((resolve) => setTimeout(resolve, 25));
                expect(acceptedConnections).toBe(0);
            } finally {
                await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            }
        });
    });
});
