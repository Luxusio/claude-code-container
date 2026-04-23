import { describe, it, expect, vi } from 'vitest'
import { join } from 'path'
import { cleanUiDepsForFreshInstall } from '../../scripts/ui-toolchain.js'

function makeMockFs(initialExisting: Record<string, boolean>) {
    const existing = { ...initialExisting }
    return {
        existsSync: vi.fn((p: string) => existing[p] === true),
        rmSync: vi.fn((p: string, _opts?: unknown) => {
            delete existing[p]
        }),
        _state: existing,
    }
}

describe('cleanUiDepsForFreshInstall', () => {
    const uiDir = join('some', 'ui', 'dir')
    const nodeModulesPath = join(uiDir, 'node_modules')
    const lockfilePath = join(uiDir, 'package-lock.json')

    it('removes both paths when both exist', () => {
        const fs = makeMockFs({ [nodeModulesPath]: true, [lockfilePath]: true })
        const result = cleanUiDepsForFreshInstall(uiDir, { fs })

        expect(result).toEqual({ removedNodeModules: true, removedLockfile: true })
        expect(fs.rmSync).toHaveBeenCalledWith(nodeModulesPath, { recursive: true, force: true })
        expect(fs.rmSync).toHaveBeenCalledWith(lockfilePath, { force: true })
        expect(fs.rmSync).toHaveBeenCalledTimes(2)
    })

    it('is a no-op when neither path exists', () => {
        const fs = makeMockFs({})
        const result = cleanUiDepsForFreshInstall(uiDir, { fs })

        expect(result).toEqual({ removedNodeModules: false, removedLockfile: false })
        expect(fs.rmSync).not.toHaveBeenCalled()
    })

    it('removes only node_modules when only it exists', () => {
        const fs = makeMockFs({ [nodeModulesPath]: true })
        const result = cleanUiDepsForFreshInstall(uiDir, { fs })

        expect(result).toEqual({ removedNodeModules: true, removedLockfile: false })
        expect(fs.rmSync).toHaveBeenCalledTimes(1)
        expect(fs.rmSync).toHaveBeenCalledWith(nodeModulesPath, { recursive: true, force: true })
    })

    it('removes only lockfile when only it exists', () => {
        const fs = makeMockFs({ [lockfilePath]: true })
        const result = cleanUiDepsForFreshInstall(uiDir, { fs })

        expect(result).toEqual({ removedNodeModules: false, removedLockfile: true })
        expect(fs.rmSync).toHaveBeenCalledTimes(1)
        expect(fs.rmSync).toHaveBeenCalledWith(lockfilePath, { force: true })
    })

    it('does not throw when fs is not injected (uses real fs default)', () => {
        // Call against a clearly-nonexistent path — both existsSync returns should be false,
        // so rmSync is never called on the real fs. No throw expected.
        const result = cleanUiDepsForFreshInstall('/definitely/not/a/real/path/ccc-test-xyz')
        expect(result).toEqual({ removedNodeModules: false, removedLockfile: false })
    })
})
