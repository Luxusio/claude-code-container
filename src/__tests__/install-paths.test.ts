import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// installedUiBinPaths is in scripts/ (not src/), but vitest can import it
// directly because the project root is in module resolution scope.
// We use a dynamic import inside each test so vi.mock can intercept os.homedir().

describe('installedUiBinPaths — POSIX paths', () => {
    it('returns /usr/local/bin/ccc-ui-dist as binDir', async () => {
        const { installedUiBinPaths } = await import('../../scripts/ui-toolchain.js')
        const paths = installedUiBinPaths('linux')
        expect(paths.binDir).toBe('/usr/local/bin/ccc-ui-dist')
    })

    it('returns /usr/local/bin/ccc-ui as binPath on linux', async () => {
        const { installedUiBinPaths } = await import('../../scripts/ui-toolchain.js')
        const paths = installedUiBinPaths('linux')
        expect(paths.binPath).toBe('/usr/local/bin/ccc-ui')
    })

    it('returns /usr/local/bin/ccc-ui-dist as distDir on darwin', async () => {
        const { installedUiBinPaths } = await import('../../scripts/ui-toolchain.js')
        const paths = installedUiBinPaths('darwin')
        expect(paths.distDir).toBe('/usr/local/bin/ccc-ui-dist')
    })

    it('binDir and distDir are the same on POSIX', async () => {
        const { installedUiBinPaths } = await import('../../scripts/ui-toolchain.js')
        const paths = installedUiBinPaths('linux')
        expect(paths.binDir).toBe(paths.distDir)
    })

    it('spawnPath equals /usr/local/bin/ccc-ui on linux', async () => {
        const { installedUiBinPaths } = await import('../../scripts/ui-toolchain.js')
        const paths = installedUiBinPaths('linux')
        expect(paths.spawnPath).toBe('/usr/local/bin/ccc-ui')
    })
})

describe('installedUiBinPaths — Windows paths', () => {
    beforeEach(() => {
        // Override LOCALAPPDATA so tests are deterministic and don't touch real filesystem
        process.env.LOCALAPPDATA = 'C:\\Users\\TestUser\\AppData\\Local'
    })

    afterEach(() => {
        delete process.env.LOCALAPPDATA
    })

    it('binDir contains Programs\\ccc\\ui on win32', async () => {
        const { installedUiBinPaths } = await import('../../scripts/ui-toolchain.js')
        const paths = installedUiBinPaths('win32')
        // Use forward-slash normalisation for cross-platform assertion
        expect(paths.binDir.replace(/\\/g, '/')).toContain('Programs/ccc/ui')
    })

    it('binPath ends with ccc-ui.cmd on win32', async () => {
        const { installedUiBinPaths } = await import('../../scripts/ui-toolchain.js')
        const paths = installedUiBinPaths('win32')
        expect(paths.binPath.endsWith('ccc-ui.cmd')).toBe(true)
    })

    it('spawnPath ends with ccc-ui.exe on win32', async () => {
        const { installedUiBinPaths } = await import('../../scripts/ui-toolchain.js')
        const paths = installedUiBinPaths('win32')
        expect(paths.spawnPath.endsWith('ccc-ui.exe')).toBe(true)
    })

    it('uses LOCALAPPDATA env var when set', async () => {
        process.env.LOCALAPPDATA = 'C:\\Custom\\AppData'
        const { installedUiBinPaths } = await import('../../scripts/ui-toolchain.js')
        const paths = installedUiBinPaths('win32')
        expect(paths.binDir.replace(/\\/g, '/')).toContain('Custom/AppData')
    })
})
