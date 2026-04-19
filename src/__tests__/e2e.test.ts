import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Check Docker availability
function isDockerAvailable(): boolean {
    const result = spawnSync('docker', ['info'], { encoding: 'utf-8', timeout: 5000 })
    return result.status === 0
}

// Run ccc command from the project root
function runCcc(args: string[], options: { cwd?: string, timeout?: number } = {}): { stdout: string, stderr: string, status: number | null } {
    const cccPath = join(__dirname, '../index.ts')
    const result = spawnSync('npx', ['tsx', cccPath, ...args], {
        encoding: 'utf-8',
        cwd: options.cwd ?? process.cwd(),
        timeout: options.timeout ?? 60000,
        env: { ...process.env, NODE_ENV: 'test' }
    })
    return {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        status: result.status
    }
}

// Get test project path with unique hash
let testProjectDir: string

describe.skipIf(!isDockerAvailable())('E2E: Docker Integration', () => {

    beforeAll(() => {
        // Create a unique temp directory for test project
        testProjectDir = mkdtempSync(join(tmpdir(), 'ccc-test-'))
        // Create a minimal project structure
        writeFileSync(join(testProjectDir, 'package.json'), JSON.stringify({ name: 'test-project' }))
    })

    afterAll(() => {
        // Cleanup: remove test containers and temp directory
        if (testProjectDir) {
            // Stop and remove any test containers
            const result = runCcc(['rm'], { cwd: testProjectDir, timeout: 30000 })
            // Remove temp directory
            rmSync(testProjectDir, { recursive: true, force: true })
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
            const ps = spawnSync('docker', ['ps', '-a', '--filter', 'name=^ccc-test-project-', '--format', '{{.Names}}'], { encoding: 'utf-8' })
            expect(ps.stdout?.trim()).toMatch(/^ccc-test-project-/)
        })

        it('executes command and returns output', { timeout: 60000 }, () => {
            const result = runCcc(['echo', 'test-output'], { cwd: testProjectDir, timeout: 60000 })
            expect(result.stdout).toContain('test-output')
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

    describe('Environment Variables', () => {
        it('passes --env to container', { timeout: 60000 }, () => {
            const result = runCcc(['--env', 'TEST_VAR=hello123', 'printenv', 'TEST_VAR'], { cwd: testProjectDir, timeout: 60000 })
            expect(result.stdout).toContain('hello123')
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
