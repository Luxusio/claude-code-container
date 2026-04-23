import { describe, it, expect } from 'vitest'
import { isPostinstallMode } from '../../scripts/ui-toolchain.js'

describe('isPostinstallMode', () => {
    it('returns true when npm_lifecycle_event is postinstall', () => {
        expect(isPostinstallMode({ npm_lifecycle_event: 'postinstall' }, [])).toBe(true)
    })
    it('returns true when --postinstall flag in argv', () => {
        expect(isPostinstallMode({}, ['--postinstall'])).toBe(true)
    })
    it('returns true when both signals are present', () => {
        expect(isPostinstallMode({ npm_lifecycle_event: 'postinstall' }, ['--postinstall'])).toBe(true)
    })
    it('returns false when neither signal is present', () => {
        expect(isPostinstallMode({}, [])).toBe(false)
    })
    it('returns false when unrelated lifecycle event is set', () => {
        expect(isPostinstallMode({ npm_lifecycle_event: 'test' }, [])).toBe(false)
    })
    it('returns false when unrelated flags are in argv', () => {
        expect(isPostinstallMode({}, ['--uninstall', '--verbose'])).toBe(false)
    })
})
