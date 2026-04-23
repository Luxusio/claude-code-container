import { describe, it, expect } from 'vitest'
import { basename, join } from 'path'
import { sidecarBinPaths } from '../../scripts/ui-toolchain.js'

const releaseDir = join('some', 'release', 'dir')

describe('sidecarBinPaths', () => {
    describe('win32', () => {
        const triple = 'x86_64-pc-windows-msvc'
        const result = sidecarBinPaths(releaseDir, triple, 'win32')

        it('srcBin basename is ccc-daemon.exe', () => {
            expect(basename(result.srcBin)).toBe('ccc-daemon.exe')
        })

        it('destBin basename is ccc-daemon-<triple>.exe', () => {
            expect(basename(result.destBin)).toBe(`ccc-daemon-${triple}.exe`)
        })

        it('exeSuffix is .exe', () => {
            expect(result.exeSuffix).toBe('.exe')
        })

        it('srcBin is inside releaseDir', () => {
            expect(result.srcBin.startsWith(releaseDir)).toBe(true)
        })
    })

    describe('linux', () => {
        const triple = 'x86_64-unknown-linux-gnu'
        const result = sidecarBinPaths(releaseDir, triple, 'linux')

        it('srcBin basename is ccc-daemon (no .exe)', () => {
            expect(basename(result.srcBin)).toBe('ccc-daemon')
        })

        it('destBin basename is ccc-daemon-<triple> (no .exe)', () => {
            expect(basename(result.destBin)).toBe(`ccc-daemon-${triple}`)
        })

        it('exeSuffix is empty string', () => {
            expect(result.exeSuffix).toBe('')
        })

        it('srcBin is inside releaseDir', () => {
            expect(result.srcBin.startsWith(releaseDir)).toBe(true)
        })
    })

    describe('darwin', () => {
        const triple = 'aarch64-apple-darwin'
        const result = sidecarBinPaths(releaseDir, triple, 'darwin')

        it('srcBin basename is ccc-daemon (no .exe)', () => {
            expect(basename(result.srcBin)).toBe('ccc-daemon')
        })

        it('destBin basename is ccc-daemon-<triple> (no .exe)', () => {
            expect(basename(result.destBin)).toBe(`ccc-daemon-${triple}`)
        })

        it('exeSuffix is empty string', () => {
            expect(result.exeSuffix).toBe('')
        })
    })
})
