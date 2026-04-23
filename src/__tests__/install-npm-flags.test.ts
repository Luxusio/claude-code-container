import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const installJsPath = join(__dirname, '..', '..', 'scripts', 'install.js')
const source = readFileSync(installJsPath, 'utf-8')

describe('scripts/install.js — Phase 6 npm argv structural assertions', () => {
    it('retains --include=optional flag (variant 2 defense-in-depth)', () => {
        expect(source).toContain('--include=optional')
    })

    it('contains --os=${process.platform} interpolation (variant 3 fix)', () => {
        expect(source).toMatch(/--os=\$\{process\.platform\}/)
    })

    it('contains --cpu=${process.arch} interpolation (variant 3 fix)', () => {
        expect(source).toMatch(/--cpu=\$\{process\.arch\}/)
    })

    it('retains cleanUiDepsForFreshInstall import and call (Phase 6a non-regression)', () => {
        expect(source).toContain('cleanUiDepsForFreshInstall')
    })

    it('retains ensureTauriCliPlatformBinding(uiDir) call (Phase 6b non-regression)', () => {
        expect(source).toContain('ensureTauriCliPlatformBinding(uiDir)')
    })

    it('retains Phase 6a label string (Pre-clean ui deps)', () => {
        expect(source).toContain('Pre-clean ui deps')
    })

    it('retains Phase 6b label string (Verify @tauri-apps/cli platform binding)', () => {
        expect(source).toContain('Verify @tauri-apps/cli platform binding')
    })
})
