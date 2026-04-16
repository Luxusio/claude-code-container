import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'child_process'

vi.mock('child_process', () => ({
    spawnSync: vi.fn(),
}))

const mockIsDockerDesktop = vi.fn<() => boolean>().mockReturnValue(false)
vi.mock('../docker.js', () => ({
    isDockerDesktop: (...args: unknown[]) => mockIsDockerDesktop(...(args as [])),
}))

const mockSpawnSync = vi.mocked(spawnSync)

const OK = { status: 0, stdout: '', stderr: '', pid: 0, signal: null, output: [] } as any
const FAIL = { status: 1, stdout: '', stderr: '', pid: 0, signal: null, output: [] } as any

describe('localhost-proxy-setup', () => {
    const originalPlatform = process.platform
    const originalEnv = { ...process.env }

    beforeEach(() => {
        vi.resetAllMocks()
        mockIsDockerDesktop.mockReturnValue(false)
    })

    afterEach(() => {
        Object.defineProperty(process, 'platform', { value: originalPlatform })
        process.env = { ...originalEnv }
    })

    it('skips proxy setup on native Linux Docker (--network host works natively)', async () => {
        Object.defineProperty(process, 'platform', { value: 'linux' })
        mockIsDockerDesktop.mockReturnValue(false)
        const { setupLocalhostProxy } = await import('../localhost-proxy-setup.js')

        setupLocalhostProxy('test-container')
        expect(mockSpawnSync).not.toHaveBeenCalled()
    })

    it('runs proxy setup on Linux with Docker Desktop (WSL2)', async () => {
        Object.defineProperty(process, 'platform', { value: 'linux' })
        mockIsDockerDesktop.mockReturnValue(true)

        mockSpawnSync
            .mockReturnValueOnce(FAIL)                                          // isProxyRunning → not running
            .mockReturnValueOnce({ ...OK, stdout: '999\n' } as any)             // id -u ccc-proxy → 999
            .mockReturnValueOnce(FAIL)                                          // iptables -C → not exists
            .mockReturnValueOnce(OK)                                            // iptables -A → success
            .mockReturnValueOnce(OK)                                            // start ccc-proxy binary

        const { setupLocalhostProxy } = await import('../localhost-proxy-setup.js')
        setupLocalhostProxy('test-container')

        expect(mockSpawnSync.mock.calls.length).toBe(5)

        // Verify iptables add was called
        const iptablesAddCall = mockSpawnSync.mock.calls.find(
            (call) => {
                const args = call[1] as string[]
                return args && args.includes('-A') && args.includes('OUTPUT')
            }
        )
        expect(iptablesAddCall).toBeDefined()

        // Verify Go proxy binary was started
        const proxyCall = mockSpawnSync.mock.calls.find(
            (call) => {
                const args = call[1] as string[]
                return args && args.includes('/usr/local/bin/ccc-proxy')
            }
        )
        expect(proxyCall).toBeDefined()
    })

    it('runs proxy setup on macOS (darwin)', async () => {
        Object.defineProperty(process, 'platform', { value: 'darwin' })

        mockSpawnSync
            .mockReturnValueOnce(FAIL)                                          // isProxyRunning → not running
            .mockReturnValueOnce({ ...OK, stdout: '999\n' } as any)             // id -u ccc-proxy → 999
            .mockReturnValueOnce(FAIL)                                          // iptables -C → not exists
            .mockReturnValueOnce(OK)                                            // iptables -A → success
            .mockReturnValueOnce(OK)                                            // start ccc-proxy binary

        const { setupLocalhostProxy } = await import('../localhost-proxy-setup.js')
        setupLocalhostProxy('test-container')

        expect(mockSpawnSync.mock.calls.length).toBe(5)

        // Verify iptables add was called with correct args
        const iptablesAddCall = mockSpawnSync.mock.calls.find(
            (call) => {
                const args = call[1] as string[]
                return args && args.includes('-A') && args.includes('OUTPUT')
            }
        )
        expect(iptablesAddCall).toBeDefined()
        const addArgs = iptablesAddCall![1] as string[]
        expect(addArgs).toContain('127.0.0.1')
        expect(addArgs).toContain('REDIRECT')
        expect(addArgs).toContain('999')
    })

    it('runs proxy setup on Windows (win32)', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' })

        mockSpawnSync
            .mockReturnValueOnce(FAIL)                                          // isProxyRunning → not running
            .mockReturnValueOnce({ ...OK, stdout: '999\n' } as any)             // id -u ccc-proxy → 999
            .mockReturnValueOnce(OK)                                            // iptables -C → already exists
            .mockReturnValueOnce(OK)                                            // start ccc-proxy binary

        const { setupLocalhostProxy } = await import('../localhost-proxy-setup.js')
        setupLocalhostProxy('test-container')

        // 4 calls: isProxyRunning, id, iptables-C (exists), start proxy
        expect(mockSpawnSync.mock.calls.length).toBe(4)
    })

    it('skips if proxy is already running', async () => {
        Object.defineProperty(process, 'platform', { value: 'darwin' })

        // isProxyRunning → already running
        mockSpawnSync.mockReturnValueOnce(OK)

        const { setupLocalhostProxy } = await import('../localhost-proxy-setup.js')
        setupLocalhostProxy('test-container')

        // Only one call (the isProxyRunning check)
        expect(mockSpawnSync.mock.calls.length).toBe(1)
    })

    it('handles missing ccc-proxy user gracefully', async () => {
        Object.defineProperty(process, 'platform', { value: 'darwin' })

        mockSpawnSync
            .mockReturnValueOnce(FAIL)                                          // isProxyRunning → not running
            .mockReturnValueOnce({ ...FAIL, stderr: 'no such user' } as any)    // id -u ccc-proxy → fails

        const { setupLocalhostProxy } = await import('../localhost-proxy-setup.js')

        // Should not throw
        expect(() => setupLocalhostProxy('test-container')).not.toThrow()
    })

    it('handles iptables failure gracefully', async () => {
        Object.defineProperty(process, 'platform', { value: 'darwin' })

        mockSpawnSync
            .mockReturnValueOnce(FAIL)                                          // isProxyRunning → not running
            .mockReturnValueOnce({ ...OK, stdout: '999\n' } as any)             // id -u ccc-proxy → 999
            .mockReturnValueOnce(FAIL)                                          // iptables -C → not exists
            .mockReturnValueOnce({ ...FAIL, stderr: 'iptables error' } as any)  // iptables -A → fails

        const { setupLocalhostProxy } = await import('../localhost-proxy-setup.js')

        // Should not throw even if iptables fails
        expect(() => setupLocalhostProxy('test-container')).not.toThrow()
        // Should NOT start proxy (iptables failed, so no redirect would happen)
        expect(mockSpawnSync.mock.calls.length).toBe(4)
    })
})
