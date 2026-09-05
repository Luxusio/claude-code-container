import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync, execFileSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Check Docker availability
function isDockerAvailable(): boolean {
    const result = spawnSync('docker', ['info'], { encoding: 'utf-8', timeout: 5000 })
    return result.status === 0
}

// These drive the real `ccc` CLI against a real daemon, so they need to run where that daemon
// resolves paths the same way this process does — i.e. on the Docker host.
//
// Run from inside a container and they fail rather than skip, which is how they read for a while as
// "Docker is missing" when Docker is reachable and the daemon is fine. The actual refusal comes from
// ccc's own safety check: it creates the container, verifies the bind mounts point where it asked,
// and finds "bind source changed for /home/ccc/.claude" — because the paths it passed are paths in
// THIS container and the daemon resolved them on the host. That check is doing its job; the tests
// simply cannot be satisfied from here.
//
// Detected the way systemd conventions and Docker itself mark a container, both of which ccc already
// relies on elsewhere (`container=docker` is set into every ccc container; /.dockerenv is Docker's
// own marker).
function isInsideContainer(): boolean {
    return process.env.container === 'docker' || existsSync('/.dockerenv')
}

// Run ccc command from the project root
const CCC_PATH = join(__dirname, '../../dist/index.js')

function ensureBuilt(): void {
    if (existsSync(CCC_PATH) && process.env.CCC_E2E_SKIP_BUILD === '1') return
    execFileSync('npm', ['run', 'build'], {
        cwd: join(__dirname, '../..'),
        stdio: 'inherit',
    })
}

function runCcc(args: string[], options: { cwd?: string, timeout?: number, env?: Record<string, string> } = {}): { stdout: string, stderr: string, status: number | null } {
    const childEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
        if (v === undefined) continue
        if (k === 'VITEST' || k.startsWith('VITEST_')) continue
        childEnv[k] = v
    }
    childEnv.NODE_ENV = 'test'
    childEnv.CCC_RUNTIME = 'docker'
    if (cccHomeDir) childEnv.HOME = cccHomeDir
    Object.assign(childEnv, options.env ?? {})

    const result = spawnSync(process.execPath, [CCC_PATH, ...args], {
        encoding: 'utf-8',
        cwd: options.cwd ?? process.cwd(),
        timeout: options.timeout ?? 60000,
        env: childEnv,
    })
    return {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        status: result.status
    }
}

// Every assertion below reads stdout, while the reason a ccc invocation failed is on stderr — so a
// failure printed the expected/received diff and nothing about the cause. Diagnosing one of these
// required reproducing the command by hand outside the suite; this makes the next one self-serving.
function cccDiagnostic(result: { stdout: string, stderr: string, status: number | null }): string {
    const stderr = result.stderr.trim()
    return [
        `ccc exited ${result.status}`,
        stderr ? `stderr:\n${stderr}` : 'stderr: (empty)',
    ].join('\n')
}

// Get test project path with unique hash
let testProjectDir: string
let cccHomeDir: string
let gitHomeDir: string

function stopIsolatedTestBroker(): void {
    const runtimeFiles = [
        join(cccHomeDir, '.ccc', 'devices', 'broker', 'runtime.json'),
        join(gitHomeDir, '.ccc', 'devices', 'broker', 'runtime.json'),
    ]
    for (const runtimeFile of new Set(runtimeFiles)) {
        if (!existsSync(runtimeFile)) continue
        let runtime: { managedBy?: string, cwd?: string, pid?: number }
        try {
            runtime = JSON.parse(readFileSync(runtimeFile, 'utf8'))
        } catch {
            continue
        }
        if (runtime.managedBy !== 'ccc-host' || runtime.cwd !== testProjectDir || !Number.isInteger(runtime.pid) || Number(runtime.pid) <= 0) continue
        if (process.platform === 'win32') {
            spawnSync('taskkill', ['/PID', String(runtime.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 })
        } else {
            try { process.kill(Number(runtime.pid), 'SIGTERM') } catch { /* already stopped */ }
        }
        rmSync(runtimeFile, { force: true })
    }
}

describe.skipIf(!isDockerAvailable() || isInsideContainer())('E2E: Docker Integration', () => {

    beforeAll(() => {
        ensureBuilt()
        // Create a unique temp directory for test project
        testProjectDir = mkdtempSync(join(tmpdir(), 'ccc-test-'))
        cccHomeDir = mkdtempSync(join(tmpdir(), 'ccc-home-'))
        gitHomeDir = mkdtempSync(join(tmpdir(), 'ccc-git-home-'))
        // Create a minimal project structure
        writeFileSync(join(testProjectDir, 'package.json'), JSON.stringify({ name: 'test-project' }))
        writeFileSync(join(testProjectDir, 'mise.toml'), '[tools]\n')
        writeFileSync(join(gitHomeDir, '.gitconfig'), [
            '[user]',
            '\tname = CCC E2E User',
            '\temail = ccc-e2e@example.com',
            '',
        ].join('\n'))
    })

    afterAll(() => {
        // Cleanup: remove test containers and temp directory
        if (testProjectDir) {
            // Stop and remove any test containers
            const result = runCcc(['rm'], { cwd: testProjectDir, timeout: 30000 })
            stopIsolatedTestBroker()
            // Remove temp directory
            rmSync(testProjectDir, { recursive: true, force: true })
            rmSync(cccHomeDir, { recursive: true, force: true })
            rmSync(gitHomeDir, { recursive: true, force: true })
        }
    })

    describe('Docker Image', () => {
        it('builds image successfully', { timeout: 300000 }, async () => {
            // Build should succeed (or image already exists)
            const result = spawnSync('docker', ['build', '-t', 'ccc', '-f', join(__dirname, '../..', 'Dockerfile'), join(__dirname, '../..')], {
                encoding: 'utf-8',
                timeout: 300000
            })
            expect(result.status).toBe(0)
        })

        it('image exists after build', () => {
            const result = spawnSync('docker', ['images', '-q', 'ccc'], { encoding: 'utf-8' })
            expect(result.stdout?.trim()).not.toBe('')
        })
    })

    describe('ccc status', () => {
        it('shows image status', { timeout: 10000 }, () => {
            const result = runCcc(['status'], { cwd: testProjectDir })
            expect(result.stdout).toContain('Image:')
        })

        it('shows containers section', { timeout: 10000 }, () => {
            const result = runCcc(['status'], { cwd: testProjectDir })
            expect(result.stdout).toContain('Containers:')
        })
    })

    describe('ccc help', () => {
        it('shows help text', () => {
            const result = runCcc(['--help'], { cwd: testProjectDir })
            expect(result.stdout).toContain('ccc - Claude Code Container')
            expect(result.stdout).toContain('USAGE:')
        })
    })

    describe('Container Lifecycle', () => {
        it('creates container on command execution', { timeout: 120000 }, () => {
            // Run a simple command that creates container
            const result = runCcc(['echo', 'hello'], { cwd: testProjectDir, timeout: 120000 })
            // Container should be created (check with docker ps)
            const ps = spawnSync('docker', ['ps', '-a', '--filter', 'name=^ccc-ccc-test-', '--format', '{{.Names}}'], { encoding: 'utf-8' })
            expect(ps.stdout?.trim(), cccDiagnostic(result)).toMatch(/^ccc-ccc-test-/)
        })

        it('executes command and returns output', { timeout: 60000 }, () => {
            const result = runCcc(['echo', 'test-output'], { cwd: testProjectDir, timeout: 60000 })
            expect(result.stdout, cccDiagnostic(result)).toContain('test-output')
        })

        it('mounts host git identity into the container', { timeout: 120000 }, () => {
            runCcc(['rm'], { cwd: testProjectDir, timeout: 30000, env: { HOME: gitHomeDir } })

            const result = runCcc(
                ['git', 'config', '--global', 'user.email'],
                { cwd: testProjectDir, timeout: 120000, env: { HOME: gitHomeDir } },
            )

            expect(result.status).toBe(0)
            expect(result.stdout.trim().split(/\r?\n/).at(-1)).toBe('ccc-e2e@example.com')
        })

        it('ccc stop stops the container', { timeout: 30000 }, () => {
            const result = runCcc(['stop'], { cwd: testProjectDir, timeout: 30000 })
            expect(result.stdout).toContain('Container stopped')
        })

        it('ccc rm removes the container', { timeout: 30000 }, () => {
            // First ensure container exists
            runCcc(['echo', 'setup'], { cwd: testProjectDir, timeout: 60000 })
            // Then remove it
            const result = runCcc(['rm'], { cwd: testProjectDir, timeout: 30000 })
            expect(result.stdout).toContain('Container removed')
        })
    })

})

describe('E2E: Docker Not Available', () => {
    it.skipIf(isDockerAvailable())('gracefully handles missing Docker', () => {
        const result = runCcc(['status'])
        // Should either error or show "not built"
        expect(result.stdout + result.stderr).toBeTruthy()
    })
})
