import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { parseArgs } from '../index.js'

// Top-level mocks — vitest hoists them anyway, but explicit top-level
// placement prevents the deprecation warning and matches the actual execution order.
vi.mock('fs', async () => {
    const actual = await vi.importActual<typeof import('fs')>('fs')
    return { ...actual, existsSync: vi.fn(() => false) }
})

vi.mock('child_process', async () => {
    const actual = await vi.importActual<typeof import('child_process')>('child_process')
    return {
        ...actual,
        spawnSync: vi.fn(() => ({ status: 0, error: null, pid: 0, output: [], stdout: '', stderr: '', signal: null })),
    }
})

describe('parseArgs — ui command', () => {
    it('parseArgs(["ui"]) puts "ui" in filteredArgs[0]', () => {
        const result = parseArgs(['ui'])
        expect(result.filteredArgs[0]).toBe('ui')
        expect(result.worktreeArg).toBeUndefined()
    })

    it('parseArgs(["ui", "--some-flag"]) preserves extra args', () => {
        const result = parseArgs(['ui', '--some-flag'])
        expect(result.filteredArgs).toEqual(['ui', '--some-flag'])
    })

    it('parseArgs(["ui"]) does not set worktreeArg', () => {
        const result = parseArgs(['ui'])
        expect(result.worktreeArg).toBeUndefined()
    })

    it('parseArgs(["@main", "ui"]) extracts worktree and keeps ui in filteredArgs', () => {
        const result = parseArgs(['@main', 'ui'])
        expect(result.worktreeArg).toBe('@main')
        expect(result.filteredArgs[0]).toBe('ui')
    })
})

describe('launchUi — spawn behaviour', () => {
    beforeEach(() => {
        vi.resetModules()
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('exits 1 when binary is not installed', async () => {
        // Mock process.exit so we can intercept it
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
            throw new Error(`process.exit(${_code})`)
        })

        const { launchUi } = await import('../ui-launcher.js')

        await expect(launchUi([])).rejects.toThrow('process.exit(1)')
        expect(exitSpy).toHaveBeenCalledWith(1)
    })

    it('surfaces spawnSync error and exits 1', async () => {
        // Mock existsSync to return true so we reach the spawn call
        const fsMod = await import('fs')
        vi.mocked(fsMod.existsSync).mockReturnValue(true)

        // Re-mock spawnSync to simulate Node 22 .cmd rejection
        const cpMod = await import('child_process')
        vi.mocked(cpMod.spawnSync).mockReturnValue({
            status: null,
            error: new Error('EINVAL spawn ccc-ui.exe'),
            pid: 0,
            output: [],
            stdout: '',
            stderr: '',
            signal: null,
        })

        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
            throw new Error(`process.exit(${_code})`)
        })
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

        const { launchUi } = await import('../ui-launcher.js')

        await expect(launchUi([])).rejects.toThrow('process.exit(1)')

        const allErrCalls = errSpy.mock.calls.flat().join(' ')
        expect(allErrCalls).toContain('EINVAL spawn ccc-ui.exe')
        expect(exitSpy).toHaveBeenCalledWith(1)
    })

    it('in dev mode, spawns npm tauri dev instead of installed binary', async () => {
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
            throw new Error(`process.exit(${_code})`)
        })

        const origEnv = process.env.CCC_DEV
        process.env.CCC_DEV = '1'
        try {
            const { launchUi } = await import('../ui-launcher.js')
            await expect(launchUi([])).rejects.toThrow('process.exit(0)')
        } finally {
            if (origEnv === undefined) {
                delete process.env.CCC_DEV
            } else {
                process.env.CCC_DEV = origEnv
            }
        }
        expect(exitSpy).toHaveBeenCalledWith(0)
    })
})
