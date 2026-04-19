import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync, execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Podman availability gate. Requires both:
//   1. `podman` CLI on PATH
//   2. `podman info` succeeds (i.e., rootless namespaces work on this host)
// CI runners and dev machines without working rootless namespaces will skip
// this entire suite without failing.
function isPodmanAvailable(): boolean {
    const which = spawnSync('podman', ['--version'], { encoding: 'utf-8', timeout: 5000 })
    if (which.status !== 0) return false
    const info = spawnSync('podman', ['info'], { encoding: 'utf-8', timeout: 10000 })
    return info.status === 0
}

// Run ccc with CCC_RUNTIME=podman forced, so the runtime override is exercised
// even on hosts where docker is also installed.
//
// Spawns the compiled `dist/index.js` directly with the same node binary
// vitest is using. Earlier attempts went through `npx tsx` and then through
// `node_modules/.bin/tsx` — both produced empty stdout in CI (tsx + Node 24
// loader hooks misbehaved). Using the prod artifact is what real users hit,
// it has no loader dependency, and `npm run build` runs before this suite.
const CCC_PATH = join(__dirname, '../../dist/index.js')

function ensureBuilt(): void {
    if (existsSync(CCC_PATH)) return
    // Local convenience: build on demand if dist is missing.
    execFileSync('npm', ['run', 'build'], {
        cwd: join(__dirname, '../..'),
        stdio: 'inherit',
    })
}

function runCcc(args: string[], options: { cwd?: string, timeout?: number } = {}): { stdout: string, stderr: string, status: number | null } {
    const result = spawnSync(process.execPath, [CCC_PATH, ...args], {
        encoding: 'utf-8',
        cwd: options.cwd ?? process.cwd(),
        timeout: options.timeout ?? 60000,
        env: { ...process.env, NODE_ENV: 'test', CCC_RUNTIME: 'podman' }
    })
    return {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        status: result.status
    }
}

let testProjectDir: string

describe.skipIf(!isPodmanAvailable())('E2E: Podman Integration', () => {

    beforeAll(() => {
        ensureBuilt()
        testProjectDir = mkdtempSync(join(tmpdir(), 'ccc-podman-test-'))
        writeFileSync(join(testProjectDir, 'package.json'), JSON.stringify({ name: 'test-project' }))
    })

    afterAll(() => {
        if (testProjectDir) {
            // Best-effort cleanup of the test container before removing the dir
            runCcc(['rm'], { cwd: testProjectDir, timeout: 30000 })
            rmSync(testProjectDir, { recursive: true, force: true })
        }
    })

    describe('Podman runtime detection', () => {
        it('ccc runtime reports podman with version + flavor + socket', () => {
            const result = runCcc(['runtime'], { cwd: testProjectDir })
            expect(result.status).toBe(0)
            expect(result.stdout).toMatch(/runtime=podman\b/)
            expect(result.stdout).toMatch(/version=\d+\.\d+(\.\d+)?/)
            expect(result.stdout).toMatch(/flavor=(linux-rootless|linux-rootful|podman-machine)/)
            expect(result.stdout).toMatch(/socket=\S+/)
        })

        it('--runtime podman flag is honoured', () => {
            const result = runCcc(['--runtime', 'podman', 'runtime'], { cwd: testProjectDir })
            expect(result.status).toBe(0)
            expect(result.stdout).toMatch(/runtime=podman/)
        })

        it('rejects invalid --runtime values', () => {
            const result = runCcc(['--runtime', 'invalid', 'runtime'], { cwd: testProjectDir })
            expect(result.status).not.toBe(0)
            expect(result.stderr).toMatch(/Invalid --runtime value/)
        })
    })

    describe('Podman image build', () => {
        it('builds image from Containerfile', { timeout: 600000 }, () => {
            // Podman picks up Containerfile automatically when -f is omitted;
            // we pass it explicitly to make the intent visible in CI logs.
            const result = spawnSync(
                'podman',
                ['build', '-t', 'ccc', '-f', join(__dirname, '../..', 'Containerfile'), join(__dirname, '../..')],
                { encoding: 'utf-8', timeout: 600000 },
            )
            expect(result.status).toBe(0)
        })

        it('image is tagged as ccc and inspectable', () => {
            const result = spawnSync('podman', ['images', '-q', 'ccc'], { encoding: 'utf-8' })
            expect((result.stdout ?? '').trim()).not.toBe('')
        })
    })

    describe('ccc status (podman)', () => {
        it('shows image status', { timeout: 15000 }, () => {
            const result = runCcc(['status'], { cwd: testProjectDir })
            expect(result.stdout).toContain('Image:')
        })

        it('shows containers section', { timeout: 15000 }, () => {
            const result = runCcc(['status'], { cwd: testProjectDir })
            expect(result.stdout).toContain('Containers:')
        })
    })

    describe('ccc doctor (podman)', () => {
        it('reports Podman runtime in summary', { timeout: 15000 }, () => {
            const result = runCcc(['doctor'], { cwd: testProjectDir })
            // Doctor prints "Runtime: Podman running ..." on success
            expect(result.stdout).toMatch(/Runtime:.*Podman/)
        })
    })

    describe('Container Lifecycle (podman)', () => {
        it('creates container on command execution', { timeout: 120000 }, () => {
            runCcc(['echo', 'hello'], { cwd: testProjectDir, timeout: 120000 })
            const ps = spawnSync(
                'podman',
                ['ps', '-a', '--filter', 'name=^ccc-', '--format', '{{.Names}}'],
                { encoding: 'utf-8' },
            )
            expect(ps.stdout ?? '').toMatch(/ccc-ccc-podman-test-/)
        })

        it('executes command and returns output', { timeout: 60000 }, () => {
            const result = runCcc(['echo', 'podman-output'], { cwd: testProjectDir, timeout: 60000 })
            expect(result.stdout).toContain('podman-output')
        })

        it('ccc stop stops the container', { timeout: 30000 }, () => {
            const result = runCcc(['stop'], { cwd: testProjectDir, timeout: 30000 })
            expect(result.stdout).toContain('Container stopped')
        })

        it('ccc rm removes the container', { timeout: 30000 }, () => {
            runCcc(['echo', 'setup'], { cwd: testProjectDir, timeout: 60000 })
            const result = runCcc(['rm'], { cwd: testProjectDir, timeout: 30000 })
            expect(result.stdout).toContain('Container removed')
        })
    })

    describe('Environment Variables (podman)', () => {
        it('passes --env to container', { timeout: 60000 }, () => {
            const result = runCcc(['--env', 'TEST_VAR=podman-pass', 'printenv', 'TEST_VAR'], { cwd: testProjectDir, timeout: 60000 })
            expect(result.stdout).toContain('podman-pass')
        })
    })
})

