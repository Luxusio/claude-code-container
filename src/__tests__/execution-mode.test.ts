import { describe, it, expect } from 'vitest'
import {
    getExecutionMode,
    buildElevatedCommand,
    buildUserCommand,
} from '../../scripts/ui-toolchain.js'

describe('getExecutionMode', () => {
    it('returns "user" for normal uid on linux', () => {
        expect(getExecutionMode(1000, {}, 'linux')).toBe('user')
    })
    it('returns "user" for normal uid on darwin', () => {
        expect(getExecutionMode(1000, {}, 'darwin')).toBe('user')
    })
    it('returns "sudo-user" for uid 0 with SUDO_USER set', () => {
        expect(getExecutionMode(0, { SUDO_USER: 'alice' }, 'linux')).toBe('sudo-user')
    })
    it('returns "root-bare" for uid 0 with no SUDO_USER', () => {
        expect(getExecutionMode(0, {}, 'linux')).toBe('root-bare')
    })
    it('returns "root-bare" for uid 0 with SUDO_USER="root"', () => {
        expect(getExecutionMode(0, { SUDO_USER: 'root' }, 'linux')).toBe('root-bare')
    })
    it('returns "windows" regardless of uid on win32', () => {
        expect(getExecutionMode(0, {}, 'win32')).toBe('windows')
        expect(getExecutionMode(1000, {}, 'win32')).toBe('windows')
    })
})

describe('buildElevatedCommand', () => {
    it('prefixes sudo in user mode', () => {
        expect(buildElevatedCommand('cp', ['a', 'b'], 'user')).toEqual({
            cmd: 'sudo',
            args: ['cp', 'a', 'b'],
        })
    })
    it('returns bare command in sudo-user mode', () => {
        expect(buildElevatedCommand('cp', ['a', 'b'], 'sudo-user')).toEqual({
            cmd: 'cp',
            args: ['a', 'b'],
        })
    })
    it('returns bare command in root-bare mode', () => {
        expect(buildElevatedCommand('cp', ['a', 'b'], 'root-bare')).toEqual({
            cmd: 'cp',
            args: ['a', 'b'],
        })
    })
    it('returns bare command in windows mode', () => {
        expect(buildElevatedCommand('cp', ['a', 'b'], 'windows')).toEqual({
            cmd: 'cp',
            args: ['a', 'b'],
        })
    })
})

describe('buildUserCommand', () => {
    it('wraps with sudo -u -H -E in sudo-user mode', () => {
        expect(buildUserCommand('cargo', ['build'], 'sudo-user', 'alice')).toEqual({
            cmd: 'sudo',
            args: ['-u', 'alice', '-H', '-E', 'cargo', 'build'],
        })
    })
    it('throws if sudoUser is missing in sudo-user mode', () => {
        expect(() => buildUserCommand('cargo', ['build'], 'sudo-user', undefined)).toThrow()
    })
    it('returns bare command in user mode', () => {
        expect(buildUserCommand('cargo', ['build'], 'user', 'alice')).toEqual({
            cmd: 'cargo',
            args: ['build'],
        })
    })
    it('returns bare command in root-bare mode', () => {
        expect(buildUserCommand('cargo', ['build'], 'root-bare', undefined)).toEqual({
            cmd: 'cargo',
            args: ['build'],
        })
    })
    it('returns bare command in windows mode', () => {
        expect(buildUserCommand('cargo', ['build'], 'windows', undefined)).toEqual({
            cmd: 'cargo',
            args: ['build'],
        })
    })
})
