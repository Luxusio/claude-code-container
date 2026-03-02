import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { hashPath } from '../utils.js'
import { getProjectHash, getMutagenSessionName, checkTailscale, checkMutagen, isHostReachable, getMutagenSyncStatus, isValidEnvKey, shellEscapeArg, isValidHostOrUser } from '../remote.js'
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

describe('isHostReachable', () => {
  const mockSpawnSync = vi.mocked(childProcess.spawnSync)

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns true when ping succeeds', () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: 'PING host (1.2.3.4): 56 data bytes\n64 bytes from 1.2.3.4',
      stderr: '',
      pid: 123,
      output: [],
      signal: null
    })

    expect(isHostReachable('my-host')).toBe(true)
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'ping',
      ['-c', '1', '-W', '1', 'my-host'],
      { encoding: 'utf-8' }
    )
  })

  it('returns false when ping fails', () => {
    mockSpawnSync.mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'ping: cannot resolve my-host',
      pid: 123,
      output: [],
      signal: null
    })

    expect(isHostReachable('my-host')).toBe(false)
  })

  it('returns false when ping command errors', () => {
    mockSpawnSync.mockReturnValue({
      status: 2,
      stdout: '',
      stderr: '',
      pid: 123,
      output: [],
      signal: null,
      error: new Error('ENOENT')
    })

    expect(isHostReachable('my-host')).toBe(false)
  })
})

describe('getMutagenSyncStatus', () => {
  const mockSpawnSync = vi.mocked(childProcess.spawnSync)

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns status when sync session exists', () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: 'Name: ccc-project-abc123\nStatus: Watching for changes\n',
      stderr: '',
      pid: 123,
      output: [],
      signal: null
    })

    const result = getMutagenSyncStatus('ccc-project-abc123')
    expect(result).toBe('Watching for changes')
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'mutagen',
      ['sync', 'list', 'ccc-project-abc123'],
      { encoding: 'utf-8' }
    )
  })

  it('returns null when session does not exist', () => {
    mockSpawnSync.mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'Error: unable to locate requested sessions',
      pid: 123,
      output: [],
      signal: null
    })

    expect(getMutagenSyncStatus('nonexistent')).toBeNull()
  })

  it('returns null when mutagen command errors', () => {
    mockSpawnSync.mockReturnValue({
      status: null,
      stdout: '',
      stderr: '',
      pid: 123,
      output: [],
      signal: null,
      error: new Error('Command not found')
    })

    expect(getMutagenSyncStatus('session-name')).toBeNull()
  })

  it('returns "Unknown" when status line not found in output', () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: 'Name: ccc-project-abc123\nSome other info\n',
      stderr: '',
      pid: 123,
      output: [],
      signal: null
    })

    expect(getMutagenSyncStatus('ccc-project-abc123')).toBe('Unknown')
  })

  it('handles stdout being null', () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: null as any,
      stderr: '',
      pid: 123,
      output: [],
      signal: null
    })

    expect(getMutagenSyncStatus('session')).toBe('Unknown')
  })
})

describe('isValidEnvKey', () => {
  it('accepts valid POSIX env key names', () => {
    expect(isValidEnvKey('FOO')).toBe(true)
    expect(isValidEnvKey('FOO_BAR')).toBe(true)
    expect(isValidEnvKey('_PRIVATE')).toBe(true)
    expect(isValidEnvKey('MY_VAR_123')).toBe(true)
    expect(isValidEnvKey('a')).toBe(true)
  })

  it('rejects keys starting with a digit', () => {
    expect(isValidEnvKey('1FOO')).toBe(false)
    expect(isValidEnvKey('0BAR')).toBe(false)
  })

  it('rejects keys with shell metacharacters', () => {
    expect(isValidEnvKey("FOO'BAR")).toBe(false)
    expect(isValidEnvKey('KEY;echo')).toBe(false)
    expect(isValidEnvKey('KEY$OTHER')).toBe(false)
    expect(isValidEnvKey('KEY=VALUE')).toBe(false)
    expect(isValidEnvKey('KEY SPACE')).toBe(false)
    expect(isValidEnvKey('KEY&CMD')).toBe(false)
    expect(isValidEnvKey('KEY|pipe')).toBe(false)
    expect(isValidEnvKey('KEY`cmd`')).toBe(false)
    expect(isValidEnvKey('KEY(paren')).toBe(false)
    expect(isValidEnvKey('KEY>redir')).toBe(false)
  })

  it('rejects empty string', () => {
    expect(isValidEnvKey('')).toBe(false)
  })
})

describe('isValidHostOrUser', () => {
  it('accepts valid hostnames', () => {
    expect(isValidHostOrUser('my-desktop')).toBe(true)
    expect(isValidHostOrUser('server.local')).toBe(true)
    expect(isValidHostOrUser('192.168.1.1')).toBe(true)
    expect(isValidHostOrUser('host_name')).toBe(true)
  })

  it('accepts valid usernames', () => {
    expect(isValidHostOrUser('john')).toBe(true)
    expect(isValidHostOrUser('root')).toBe(true)
    expect(isValidHostOrUser('user.name')).toBe(true)
    expect(isValidHostOrUser('user-name')).toBe(true)
  })

  it('rejects shell metacharacters', () => {
    expect(isValidHostOrUser('host;rm -rf /')).toBe(false)
    expect(isValidHostOrUser('host$(cmd)')).toBe(false)
    expect(isValidHostOrUser('host`cmd`')).toBe(false)
    expect(isValidHostOrUser("host'inject")).toBe(false)
    expect(isValidHostOrUser('host"inject')).toBe(false)
    expect(isValidHostOrUser('host&bg')).toBe(false)
    expect(isValidHostOrUser('host|pipe')).toBe(false)
    expect(isValidHostOrUser('host name')).toBe(false)
  })

  it('rejects empty string', () => {
    expect(isValidHostOrUser('')).toBe(false)
  })

  it('rejects strings longer than 253 characters', () => {
    expect(isValidHostOrUser('a'.repeat(254))).toBe(false)
    expect(isValidHostOrUser('a'.repeat(253))).toBe(true)
  })
})

describe('shellEscapeArg', () => {
  it('wraps argument in single quotes', () => {
    expect(shellEscapeArg('hello')).toBe("'hello'")
  })

  it('escapes single quotes inside the argument', () => {
    expect(shellEscapeArg("it's")).toBe("'it'\\''s'")
  })

  it('does not need to escape other special characters inside single quotes', () => {
    expect(shellEscapeArg('hello; rm -rf /')).toBe("'hello; rm -rf /'")
    expect(shellEscapeArg('$HOME')).toBe("'$HOME'")
    expect(shellEscapeArg('foo`bar`')).toBe("'foo`bar`'")
    expect(shellEscapeArg('key=value')).toBe("'key=value'")
  })

  it('escapes multiple single quotes', () => {
    expect(shellEscapeArg("a'b'c")).toBe("'a'\\''b'\\''c'")
  })

  it('handles empty string', () => {
    expect(shellEscapeArg('')).toBe("''")
  })
})
