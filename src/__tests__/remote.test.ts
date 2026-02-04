import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { hashPath } from '../utils.js'
import { getProjectHash, getMutagenSessionName, checkTailscale, checkMutagen } from '../remote.js'
import * as childProcess from 'child_process'

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof childProcess>('child_process')
  return {
    ...actual,
    spawnSync: vi.fn()
  }
})

describe('hashPath', () => {
  it('returns 12 character hash', () => {
    const result = hashPath('/some/path')
    expect(result).toHaveLength(12)
  })

  it('returns consistent hashes', () => {
    const h1 = hashPath('/test/path')
    const h2 = hashPath('/test/path')
    expect(h1).toBe(h2)
  })

  it('returns different hashes for different paths', () => {
    const h1 = hashPath('/path/one')
    const h2 = hashPath('/path/two')
    expect(h1).not.toBe(h2)
  })

  it('only contains hex characters', () => {
    const result = hashPath('/any/path')
    expect(result).toMatch(/^[a-f0-9]+$/)
  })
})

describe('getProjectHash', () => {
  it('returns hash for project path', () => {
    const result = getProjectHash('/home/user/project')
    expect(result).toHaveLength(12)
  })
})

describe('getMutagenSessionName', () => {
  it('generates correct session name format', () => {
    const result = getMutagenSessionName('/home/user/my-project')
    expect(result).toMatch(/^ccc-my-project-[a-f0-9]{12}$/)
  })

  it('sanitizes project names', () => {
    const result = getMutagenSessionName('/home/user/My Project!')
    expect(result).toMatch(/^ccc-my-project--[a-f0-9]{12}$/)
  })

  it('returns consistent names', () => {
    const n1 = getMutagenSessionName('/home/user/project')
    const n2 = getMutagenSessionName('/home/user/project')
    expect(n1).toBe(n2)
  })
})

describe('checkTool helper (via checkTailscale/checkMutagen)', () => {
  const mockSpawnSync = vi.mocked(childProcess.spawnSync)

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('checkTailscale should return installed:true with version when command succeeds', () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: 'tailscale version 1.50.0\nother info',
      stderr: '',
      pid: 123,
      output: [],
      signal: null
    })

    const result = checkTailscale()

    expect(result.installed).toBe(true)
    expect(result.version).toBe('tailscale version 1.50.0')
    expect(mockSpawnSync).toHaveBeenCalledWith('tailscale', ['version'], { encoding: 'utf-8' })
  })

  it('checkTailscale should return installed:false when command fails with non-zero status', () => {
    mockSpawnSync.mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'command not found',
      pid: 123,
      output: [],
      signal: null
    })

    const result = checkTailscale()

    expect(result.installed).toBe(false)
    expect(result.version).toBeUndefined()
  })

  it('checkTailscale should return installed:false when command throws error', () => {
    mockSpawnSync.mockReturnValue({
      status: null,
      stdout: '',
      stderr: '',
      pid: 123,
      output: [],
      signal: null,
      error: new Error('Command not found')
    })

    const result = checkTailscale()

    expect(result.installed).toBe(false)
    expect(result.version).toBeUndefined()
  })

  it('checkMutagen should return installed:true with version when command succeeds', () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: 'mutagen version 0.17.0',
      stderr: '',
      pid: 123,
      output: [],
      signal: null
    })

    const result = checkMutagen()

    expect(result.installed).toBe(true)
    expect(result.version).toBe('mutagen version 0.17.0')
    expect(mockSpawnSync).toHaveBeenCalledWith('mutagen', ['version'], { encoding: 'utf-8' })
  })

  it('checkMutagen should return installed:false when command fails with non-zero status', () => {
    mockSpawnSync.mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'command not found',
      pid: 123,
      output: [],
      signal: null
    })

    const result = checkMutagen()

    expect(result.installed).toBe(false)
    expect(result.version).toBeUndefined()
  })

  it('checkMutagen should return installed:false when command throws error', () => {
    mockSpawnSync.mockReturnValue({
      status: null,
      stdout: '',
      stderr: '',
      pid: 123,
      output: [],
      signal: null,
      error: new Error('Command not found')
    })

    const result = checkMutagen()

    expect(result.installed).toBe(false)
    expect(result.version).toBeUndefined()
  })
})
