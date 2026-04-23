import { describe, it, expect, vi } from 'vitest'
import { getTauriCliBindingName, ensureTauriCliPlatformBinding } from '../../scripts/ui-toolchain.js'

// ─── AC-001: getTauriCliBindingName mapping ───────────────────────────────────

describe('getTauriCliBindingName', () => {
    const cases: [string, string, string | null][] = [
        ["darwin", "arm64", "@tauri-apps/cli-darwin-arm64"],
        ["darwin", "x64",   "@tauri-apps/cli-darwin-x64"],
        ["linux",  "x64",   "@tauri-apps/cli-linux-x64-gnu"],
        ["linux",  "arm64", "@tauri-apps/cli-linux-arm64-gnu"],
        ["linux",  "arm",   "@tauri-apps/cli-linux-arm-gnueabihf"],
        ["win32",  "x64",   "@tauri-apps/cli-win32-x64-msvc"],
        ["win32",  "arm64", "@tauri-apps/cli-win32-arm64-msvc"],
        ["win32",  "ia32",  "@tauri-apps/cli-win32-ia32-msvc"],
    ]

    it.each(cases)('returns correct name for %s/%s', (platform, arch, expected) => {
        expect(getTauriCliBindingName(platform, arch)).toBe(expected)
    })

    const unknownCases: [string, string][] = [
        ["freebsd", "x64"],
        ["linux",   "ppc64"],
        ["win32",   "mips"],
        ["sunos",   "x64"],
    ]

    it.each(unknownCases)('returns null for unknown %s/%s', (platform, arch) => {
        expect(getTauriCliBindingName(platform, arch)).toStrictEqual(null)
    })
})

// ─── AC-002: no-op when binding is already present ───────────────────────────

describe('ensureTauriCliPlatformBinding — binding present', () => {
    it('returns {status:"present"} and never calls spawnSync when binding dir exists', () => {
        const mockFs = {
            existsSync: vi.fn(() => true),
            readFileSync: vi.fn(),
        }
        const mockSpawn = vi.fn()
        const mockLog = vi.fn()

        const result = ensureTauriCliPlatformBinding('/fake/ui', {
            fs:        mockFs,
            spawnSync: mockSpawn,
            platform:  'win32',
            arch:      'x64',
            log:       mockLog,
        })

        expect(result).toEqual({ status: 'present', name: '@tauri-apps/cli-win32-x64-msvc' })
        expect(mockSpawn).not.toHaveBeenCalled()
    })
})

// ─── AC-003: fallback install succeeds ───────────────────────────────────────

describe('ensureTauriCliPlatformBinding — fallback install succeeds', () => {
    it('runs npm install with correct argv and returns {status:"installed"}', () => {
        let existsCallCount = 0
        const mockFs = {
            existsSync:   vi.fn(() => {
                existsCallCount++
                // false on first call (binding absent), true on second (after install)
                return existsCallCount > 1
            }),
            readFileSync: vi.fn(() => JSON.stringify({ version: '2.10.1' })),
        }
        const mockSpawn = vi.fn(() => ({ status: 0 }))
        const mockLog = vi.fn()

        const result = ensureTauriCliPlatformBinding('/fake/ui', {
            fs:        mockFs,
            spawnSync: mockSpawn,
            platform:  'win32',
            arch:      'x64',
            log:       mockLog,
        })

        expect(result).toEqual({
            status:  'installed',
            name:    '@tauri-apps/cli-win32-x64-msvc',
            version: '2.10.1',
        })

        expect(mockSpawn).toHaveBeenCalledWith(
            'npm',
            ['install', '@tauri-apps/cli-win32-x64-msvc@2.10.1', '--no-save', '--include=optional', '--os=win32', '--cpu=x64'],
            expect.objectContaining({ cwd: '/fake/ui' })
        )
    })
})

// ─── AC-004: fallback install still leaves binding missing → throws ───────────

describe('ensureTauriCliPlatformBinding — fallback install fails to place binding', () => {
    it('throws descriptive error naming the binding and mentioning npm config get omit', () => {
        const mockFs = {
            existsSync:   vi.fn(() => false),
            readFileSync: vi.fn(() => JSON.stringify({ version: '2.10.1' })),
        }
        const mockSpawn = vi.fn(() => ({ status: 0 }))
        const mockLog = vi.fn()

        expect(() =>
            ensureTauriCliPlatformBinding('/fake/ui', {
                fs:        mockFs,
                spawnSync: mockSpawn,
                platform:  'win32',
                arch:      'x64',
                log:       mockLog,
            })
        ).toThrow(
            expect.objectContaining({
                message: expect.stringContaining('@tauri-apps/cli-win32-x64-msvc'),
            })
        )

        expect(() =>
            ensureTauriCliPlatformBinding('/fake/ui', {
                fs:        mockFs,
                spawnSync: mockSpawn,
                platform:  'win32',
                arch:      'x64',
                log:       mockLog,
            })
        ).toThrow(
            expect.objectContaining({
                message: expect.stringContaining('npm config get omit'),
            })
        )
    })
})

// ─── Extra: unknown platform returns skipped without touching fs/spawn ────────

describe('ensureTauriCliPlatformBinding — unknown platform', () => {
    it('returns {status:"skipped"} for unknown platform/arch without touching fs or spawn', () => {
        const mockFs = {
            existsSync:   vi.fn(),
            readFileSync: vi.fn(),
        }
        const mockSpawn = vi.fn()
        const mockLog = vi.fn()

        const result = ensureTauriCliPlatformBinding('/fake/ui', {
            fs:        mockFs,
            spawnSync: mockSpawn,
            platform:  'freebsd',
            arch:      'x64',
            log:       mockLog,
        })

        expect(result).toEqual({ status: 'skipped' })
        expect(mockFs.existsSync).not.toHaveBeenCalled()
        expect(mockFs.readFileSync).not.toHaveBeenCalled()
        expect(mockSpawn).not.toHaveBeenCalled()
    })
})
