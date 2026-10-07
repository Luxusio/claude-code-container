import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync, execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'

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

type CommandResult = {
    command: string[]
    cwd: string
    timeout: number
    durationMs: number
    stdout: string
    stderr: string
    status: number | null
    signal: NodeJS.Signals | null
    error?: Error & { code?: string }
}

function runCommand(command: string, args: string[], options: { cwd?: string, timeout?: number, env?: NodeJS.ProcessEnv } = {}): CommandResult {
    const cwd = options.cwd ?? process.cwd()
    const timeout = options.timeout ?? 60000
    const startedAt = Date.now()
    const result = spawnSync(command, args, { encoding: 'utf-8', cwd, timeout, env: options.env })
    return {
        command: [command, ...args], cwd, timeout, durationMs: Date.now() - startedAt,
        stdout: result.stdout ?? '', stderr: result.stderr ?? '',
        status: result.status, signal: result.signal, error: result.error,
    }
}

// Keep failures readable in CI while retaining both the start and end of output.
function boundedOutput(output: string): string {
    const limit = 8000
    if (output.length <= limit) return output
    return `${output.slice(0, limit / 2)}\n... ${output.length - limit} characters omitted ...\n${output.slice(-limit / 2)}`
}

function commandEvidence(result: CommandResult): string {
    return JSON.stringify({
        command: result.command, cwd: result.cwd,
        timeoutMs: result.timeout, durationMs: result.durationMs,
        status: result.status, signal: result.signal,
        error: result.error ? { name: result.error.name, code: result.error.code, message: boundedOutput(result.error.message) } : null,
        stdout: boundedOutput(result.stdout), stderr: boundedOutput(result.stderr),
    }, null, 2)
}

function expectSuccess(result: CommandResult): void {
    const evidence = commandEvidence(result)
    expect(result.error, evidence).toBeUndefined()
    expect(result.signal, evidence).toBeNull()
    expect(result.status, evidence).toBe(0)
}

function runCcc(args: string[], options: { cwd?: string, timeout?: number } = {}): CommandResult {
    // Strip VITEST from the child env: src/index.ts gates main() behind
    // `if (!process.env.VITEST)`, so an inherited VITEST=true makes the CLI
    // exit silently with status 0 and empty stdout/stderr.
    const childEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
        if (v === undefined) continue
        if (k === 'VITEST' || k.startsWith('VITEST_')) continue
        childEnv[k] = v
    }
    childEnv.NODE_ENV = 'test'
    childEnv.CCC_RUNTIME = 'podman'

    return runCommand(process.execPath, [CCC_PATH, ...args], { ...options, env: childEnv })
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
            expect(result.stdout).toMatch(/flavor=(podman-rootless|podman-rootful|podman-machine)/)
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
        let observedContainer: { id: string, name: string } | undefined

        function listContainers(): { result: CommandResult, containers: { id: string, name: string, state: string }[] } {
            const result = runCommand('podman',
                ['ps', '-a', '--no-trunc', '--filter', 'name=^ccc-', '--format', '{{.ID}}\t{{.Names}}\t{{.State}}'],
                { timeout: 10000 })
            expectSuccess(result)
            const containers = result.stdout.trim().split('\n').filter(Boolean).map(line => {
                const [id, name, state] = line.split('\t')
                return { id, name, state }
            })
            return { result, containers }
        }

        function expectObservedContainer(state: string): void {
            const { result, containers } = listContainers()
            expect(observedContainer, commandEvidence(result)).toBeDefined()
            expect(containers, commandEvidence(result)).toContainEqual({ ...observedContainer, state })
        }

        it('creates container on command execution', { timeout: 120000 }, () => {
            const creation = runCcc(['echo', 'hello'], { cwd: testProjectDir, timeout: 120000 })
            expectSuccess(creation)
            expect(creation.stdout, commandEvidence(creation)).toContain('hello')
            const { result, containers } = listContainers()
            // Capture the native identity for this fixture, including its full name.
            const matches = containers.filter(container => container.name.startsWith(`ccc-${basename(testProjectDir).toLowerCase()}-`))
            expect(matches, commandEvidence(result)).toHaveLength(1)
            observedContainer = { id: matches[0].id, name: matches[0].name }
            expect(matches[0].state, commandEvidence(result)).toBe('running')
        })

        it('executes command and returns output', { timeout: 60000 }, () => {
            const result = runCcc(['echo', 'podman-output'], { cwd: testProjectDir, timeout: 60000 })
            expectSuccess(result)
            expect(result.stdout, commandEvidence(result)).toContain('podman-output')
            expectObservedContainer('running')
        })

        it('ccc stop stops the container', { timeout: 30000 }, () => {
            const result = runCcc(['stop'], { cwd: testProjectDir, timeout: 30000 })
            expectSuccess(result)
            expect(result.stdout, commandEvidence(result)).toContain('Container stopped')
            expectObservedContainer('exited')
        })

        it('ccc rm removes the container', { timeout: 30000 }, () => {
            const setup = runCcc(['echo', 'setup'], { cwd: testProjectDir, timeout: 60000 })
            expectSuccess(setup)
            expect(setup.stdout, commandEvidence(setup)).toContain('setup')
            expectObservedContainer('running')
            const result = runCcc(['rm'], { cwd: testProjectDir, timeout: 30000 })
            expectSuccess(result)
            expect(result.stdout, commandEvidence(result)).toContain('Container removed')
            const listed = listContainers()
            expect(observedContainer, commandEvidence(listed.result)).toBeDefined()
            expect(listed.containers.some(container => container.id === observedContainer?.id || container.name === observedContainer?.name),
                commandEvidence(listed.result)).toBe(false)
        })
    })

})

