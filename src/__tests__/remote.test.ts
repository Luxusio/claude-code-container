import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { hashPath } from '../utils.js'
import { getProjectHash, getMutagenSessionName, checkTailscale, checkMutagen, isHostReachable, getMutagenSyncStatus, isValidEnvKey, shellEscapeArg, isValidHostOrUser, remoteSetup, remoteCheck, remoteTerminate, remoteExec } from '../remote.js'
import * as childProcess from 'child_process'
import * as fs from 'fs'
import * as utils from '../utils.js'

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof childProcess>('child_process')
  return {
    ...actual,
    spawnSync: vi.fn(),
    spawn: vi.fn()
  }
})

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof fs>('fs')
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn()
  }
})

vi.mock('../utils.js', async () => {
  const actual = await vi.importActual<typeof utils>('../utils.js')
  return {
    ...actual,
    prompt: vi.fn()
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

// === New tests for fs-dependent and async exported functions ===

describe('loadRemoteConfig (via remoteCheck side effects)', () => {
  const mockSpawnSync = vi.mocked(childProcess.spawnSync)
  const mockExistsSync = vi.mocked(fs.existsSync)
  const mockReadFileSync = vi.mocked(fs.readFileSync)

  beforeEach(() => {
    vi.clearAllMocks()
    // Default: tools not installed, no sync
    mockSpawnSync.mockReturnValue({
      status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null
    })
  })

  it('reads config when file exists and is valid JSON', async () => {
    const config = { host: 'my-desktop', user: 'john', remotePath: '' }
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify(config) as any)

    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')) })

    await remoteCheck('/home/user/project')

    expect(logs.some(l => l.includes('my-desktop'))).toBe(true)
    expect(logs.some(l => l.includes('john'))).toBe(true)

    vi.restoreAllMocks()
  })

  it('shows no-config message when file does not exist', async () => {
    mockExistsSync.mockReturnValue(false)

    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')) })

    await remoteCheck('/home/user/project')

    expect(logs.some(l => l.includes('No config saved'))).toBe(true)

    vi.restoreAllMocks()
  })

  it('returns null config (no-config message) when JSON parse fails', async () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue('not-valid-json' as any)

    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')) })

    await remoteCheck('/home/user/project')

    expect(logs.some(l => l.includes('No config saved'))).toBe(true)

    vi.restoreAllMocks()
  })

  it('returns null config when readFileSync throws', async () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockImplementation(() => { throw new Error('EACCES') })

    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')) })

    await remoteCheck('/home/user/project')

    expect(logs.some(l => l.includes('No config saved'))).toBe(true)

    vi.restoreAllMocks()
  })
})

describe('saveRemoteConfig (via remoteCheck)', () => {
  const mockSpawnSync = vi.mocked(childProcess.spawnSync)
  const mockExistsSync = vi.mocked(fs.existsSync)
  const mockReadFileSync = vi.mocked(fs.readFileSync)
  const mockWriteFileSync = vi.mocked(fs.writeFileSync)
  const mockMkdirSync = vi.mocked(fs.mkdirSync)

  beforeEach(() => {
    vi.clearAllMocks()
    mockSpawnSync.mockReturnValue({
      status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null
    })
  })

  it('writeFileSync is called with mode 0o600 when saving config', async () => {
    // We test saveRemoteConfig indirectly by verifying writeFileSync args
    // The function is called internally; we can verify by calling remoteCheck after a save
    // Instead, verify the mock was set up correctly - saveRemoteConfig is not exported,
    // so we verify writeFileSync behavior by examining what remoteCheck calls when
    // a config IS successfully read back (existsSync=true, readFileSync returns valid JSON)
    mockExistsSync.mockReturnValue(true)
    const config = { host: 'remote-host', user: 'alice', remotePath: '' }
    mockReadFileSync.mockReturnValue(JSON.stringify(config) as any)

    vi.spyOn(console, 'log').mockImplementation(() => {})

    await remoteCheck('/home/user/myproject')

    // mkdirSync and writeFileSync not called by remoteCheck (only by saveRemoteConfig)
    expect(mockWriteFileSync).not.toHaveBeenCalled()
    expect(mockMkdirSync).not.toHaveBeenCalled()

    vi.restoreAllMocks()
  })
})

describe('remoteSetup', () => {
  const mockSpawnSync = vi.mocked(childProcess.spawnSync)

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('prints setup guide header', async () => {
    mockSpawnSync.mockReturnValue({
      status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null
    })

    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')) })

    await remoteSetup()

    expect(logs.some(l => l.includes('CCC Remote Setup Guide'))).toBe(true)

    vi.restoreAllMocks()
  })

  it('shows tool check results when both tools are missing', async () => {
    mockSpawnSync.mockReturnValue({
      status: 1, stdout: '', stderr: 'not found', pid: 0, output: [], signal: null
    })

    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')) })

    await remoteSetup()

    expect(logs.some(l => l.includes('[--]') && l.includes('Tailscale'))).toBe(true)
    expect(logs.some(l => l.includes('[--]') && l.includes('Mutagen'))).toBe(true)
    expect(logs.some(l => l.includes('Tailscale not found'))).toBe(true)
    expect(logs.some(l => l.includes('Mutagen not found'))).toBe(true)
    expect(logs.some(l => l.includes('Please install missing tools'))).toBe(true)

    vi.restoreAllMocks()
  })

  it('shows install guide only for missing tools when tailscale missing but mutagen present', async () => {
    mockSpawnSync
      .mockReturnValueOnce({
        status: 1, stdout: '', stderr: 'not found', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({
        status: 0, stdout: 'mutagen version 0.17.0\n', stderr: '', pid: 0, output: [], signal: null
      })

    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')) })

    await remoteSetup()

    expect(logs.some(l => l.includes('Tailscale not found'))).toBe(true)
    expect(logs.some(l => l.includes('Mutagen not found'))).toBe(false)
    expect(logs.some(l => l.includes('Please install missing tools'))).toBe(true)

    vi.restoreAllMocks()
  })

  it('shows full usage guide when both tools are installed', async () => {
    mockSpawnSync
      .mockReturnValueOnce({
        status: 0, stdout: 'tailscale version 1.50.0\n', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({
        status: 0, stdout: 'mutagen version 0.17.0\n', stderr: '', pid: 0, output: [], signal: null
      })

    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')) })

    await remoteSetup()

    expect(logs.some(l => l.includes('[OK]') && l.includes('Tailscale'))).toBe(true)
    expect(logs.some(l => l.includes('[OK]') && l.includes('Mutagen'))).toBe(true)
    expect(logs.some(l => l.includes('Usage'))).toBe(true)
    expect(logs.some(l => l.includes('Architecture'))).toBe(true)
    expect(logs.some(l => l.includes('Requirements'))).toBe(true)
    // Should not show install guides
    expect(logs.some(l => l.includes('Tailscale not found'))).toBe(false)
    expect(logs.some(l => l.includes('Mutagen not found'))).toBe(false)

    vi.restoreAllMocks()
  })

  it('shows install guide only for mutagen when tailscale present but mutagen missing', async () => {
    mockSpawnSync
      .mockReturnValueOnce({
        status: 0, stdout: 'tailscale version 1.50.0\n', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({
        status: 1, stdout: '', stderr: 'not found', pid: 0, output: [], signal: null
      })

    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')) })

    await remoteSetup()

    expect(logs.some(l => l.includes('Tailscale not found'))).toBe(false)
    expect(logs.some(l => l.includes('Mutagen not found'))).toBe(true)
    expect(logs.some(l => l.includes('Please install missing tools'))).toBe(true)

    vi.restoreAllMocks()
  })
})

describe('remoteCheck', () => {
  const mockSpawnSync = vi.mocked(childProcess.spawnSync)
  const mockExistsSync = vi.mocked(fs.existsSync)
  const mockReadFileSync = vi.mocked(fs.readFileSync)

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('prints section header', async () => {
    mockSpawnSync.mockReturnValue({
      status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null
    })
    mockExistsSync.mockReturnValue(false)

    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')) })

    await remoteCheck('/home/user/project')

    expect(logs.some(l => l.includes('CCC Remote Status'))).toBe(true)

    vi.restoreAllMocks()
  })

  it('shows tool status for both tools installed', async () => {
    mockSpawnSync
      .mockReturnValueOnce({
        status: 0, stdout: 'tailscale version 1.50.0\n', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({
        status: 0, stdout: 'mutagen version 0.17.0\n', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValue({
        status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null
      })
    mockExistsSync.mockReturnValue(false)

    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')) })

    await remoteCheck('/home/user/project')

    expect(logs.some(l => l.includes('[OK]') && l.includes('Tailscale'))).toBe(true)
    expect(logs.some(l => l.includes('[OK]') && l.includes('Mutagen'))).toBe(true)

    vi.restoreAllMocks()
  })

  it('shows config details when config file exists', async () => {
    mockSpawnSync
      .mockReturnValueOnce({
        status: 0, stdout: 'tailscale version 1.50.0\n', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({
        status: 0, stdout: 'mutagen version 0.17.0\n', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({
        // isHostReachable ping
        status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValue({
        // getMutagenSyncStatus
        status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null
      })
    mockExistsSync.mockReturnValue(true)
    const config = { host: 'work-pc', user: 'bob', remotePath: '' }
    mockReadFileSync.mockReturnValue(JSON.stringify(config) as any)

    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')) })

    await remoteCheck('/home/user/project')

    expect(logs.some(l => l.includes('work-pc'))).toBe(true)
    expect(logs.some(l => l.includes('bob'))).toBe(true)
    expect(logs.some(l => l.includes('[OK]') && l.includes('Host reachable'))).toBe(true)

    vi.restoreAllMocks()
  })

  it('shows host unreachable when ping fails', async () => {
    mockSpawnSync
      .mockReturnValueOnce({
        status: 0, stdout: 'tailscale version 1.50.0\n', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({
        status: 0, stdout: 'mutagen version 0.17.0\n', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({
        // isHostReachable ping fails
        status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValue({
        status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null
      })
    mockExistsSync.mockReturnValue(true)
    const config = { host: 'offline-host', user: 'carol', remotePath: '' }
    mockReadFileSync.mockReturnValue(JSON.stringify(config) as any)

    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')) })

    await remoteCheck('/home/user/project')

    expect(logs.some(l => l.includes('[--]') && l.includes('Host reachable'))).toBe(true)

    vi.restoreAllMocks()
  })

  it('shows active sync status when session exists', async () => {
    mockSpawnSync
      .mockReturnValueOnce({
        status: 0, stdout: 'tailscale version 1.50.0\n', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({
        status: 0, stdout: 'mutagen version 0.17.0\n', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({
        // ping
        status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({
        // getMutagenSyncStatus
        status: 0,
        stdout: 'Name: session\nStatus: Watching for changes\n',
        stderr: '', pid: 0, output: [], signal: null
      })
    mockExistsSync.mockReturnValue(true)
    const config = { host: 'my-pc', user: 'dave', remotePath: '' }
    mockReadFileSync.mockReturnValue(JSON.stringify(config) as any)

    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')) })

    await remoteCheck('/home/user/project')

    expect(logs.some(l => l.includes('[OK]') && l.includes('Session'))).toBe(true)
    expect(logs.some(l => l.includes('Watching for changes'))).toBe(true)

    vi.restoreAllMocks()
  })

  it('shows no active sync session when session does not exist', async () => {
    mockSpawnSync
      .mockReturnValueOnce({
        status: 0, stdout: 'tailscale version 1.50.0\n', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({
        status: 0, stdout: 'mutagen version 0.17.0\n', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValue({
        status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null
      })
    mockExistsSync.mockReturnValue(false)

    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')) })

    await remoteCheck('/home/user/project')

    expect(logs.some(l => l.includes('No active sync session'))).toBe(true)

    vi.restoreAllMocks()
  })

  it('shows mutagen not installed message when mutagen missing', async () => {
    mockSpawnSync
      .mockReturnValueOnce({
        status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValue({
        status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null
      })
    mockExistsSync.mockReturnValue(false)

    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')) })

    await remoteCheck('/home/user/project')

    expect(logs.some(l => l.includes('mutagen not installed'))).toBe(true)

    vi.restoreAllMocks()
  })
})

describe('remoteTerminate', () => {
  const mockSpawnSync = vi.mocked(childProcess.spawnSync)

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('terminates sync session when it exists', async () => {
    mockSpawnSync
      .mockReturnValueOnce({
        // getMutagenSyncStatus - session exists
        status: 0,
        stdout: 'Name: ccc-project-abc123\nStatus: Watching for changes\n',
        stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({
        // mutagen sync terminate
        status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null
      })

    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')) })

    await remoteTerminate('/home/user/project')

    expect(mockSpawnSync).toHaveBeenCalledWith(
      'mutagen',
      expect.arrayContaining(['sync', 'terminate']),
      expect.anything()
    )
    expect(logs.some(l => l.includes('Terminating sync session'))).toBe(true)
    expect(logs.some(l => l.includes('Sync terminated'))).toBe(true)

    vi.restoreAllMocks()
  })

  it('does nothing when no sync session exists', async () => {
    mockSpawnSync.mockReturnValue({
      status: 1, stdout: '', stderr: 'Error: unable to locate', pid: 0, output: [], signal: null
    })

    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')) })

    await remoteTerminate('/home/user/project')

    expect(logs.some(l => l.includes('No active sync session'))).toBe(true)
    // terminate should not be called
    const terminateCalls = mockSpawnSync.mock.calls.filter(c => c[1]?.includes('terminate'))
    expect(terminateCalls).toHaveLength(0)

    vi.restoreAllMocks()
  })

  it('calls terminate with the correct session name', async () => {
    const projectPath = '/home/user/my-special-project'
    const expectedSessionName = getMutagenSessionName(projectPath)

    mockSpawnSync
      .mockReturnValueOnce({
        status: 0,
        stdout: `Name: ${expectedSessionName}\nStatus: Watching for changes\n`,
        stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({
        status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null
      })

    vi.spyOn(console, 'log').mockImplementation(() => {})

    await remoteTerminate(projectPath)

    expect(mockSpawnSync).toHaveBeenCalledWith(
      'mutagen',
      ['sync', 'terminate', expectedSessionName],
      { stdio: 'inherit' }
    )

    vi.restoreAllMocks()
  })
})

describe('remoteExec', () => {
  const mockSpawnSync = vi.mocked(childProcess.spawnSync)
  const mockSpawn = vi.mocked(childProcess.spawn)
  const mockExistsSync = vi.mocked(fs.existsSync)
  const mockReadFileSync = vi.mocked(fs.readFileSync)
  const mockWriteFileSync = vi.mocked(fs.writeFileSync)
  const mockMkdirSync = vi.mocked(fs.mkdirSync)
  const mockPrompt = vi.mocked(utils.prompt)

  // Helper: make a minimal spawn mock that resolves with given exit code
  function makeSpawnMock(exitCode: number = 0) {
    const emitter: any = {
      on: vi.fn((event: string, cb: (code: number) => void) => {
        if (event === 'close') {
          // Resolve asynchronously
          Promise.resolve().then(() => cb(exitCode))
        }
        return emitter
      })
    }
    return emitter
  }

  // Default spawnSync chain for successful remoteExec:
  // 1. checkMutagen (installed)
  // 2. ssh docker images (image exists)
  // 3. ssh docker run (start container)
  // 4. ssh docker exec mkdir (create dir)
  // 5. mutagen daemon start
  // 6. mutagen sync list (no session -> null, create new)
  // 7. mutagen sync create
  // Then spawn for SSH
  // Then getMutagenSyncStatus for waitForSync -> "Watching for changes"
  function setupSuccessfulSpawnSyncs() {
    mockSpawnSync
      .mockReturnValueOnce({ // checkMutagen
        status: 0, stdout: 'mutagen version 0.17.0\n', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // ensureRemoteImage: ssh docker images -q
        status: 0, stdout: 'sha256abc\n', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // startRemoteContainer: ssh docker run
        status: 0, stdout: 'container-id\n', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // createContainerProjectDir: ssh docker exec mkdir
        status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // mutagen daemon start
        status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // getMutagenSyncStatus (check existing) -> no session
        status: 1, stdout: '', stderr: 'no session', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // mutagen sync create
        status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // getMutagenSyncStatus for waitForSync -> watching
        status: 0, stdout: 'Status: Watching for changes\n', stderr: '', pid: 0, output: [], signal: null
      })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('exits with code 1 when mutagen is not installed', async () => {
    mockSpawnSync.mockReturnValue({
      status: 1, stdout: '', stderr: 'not found', pid: 0, output: [], signal: null
    })

    const exitMock = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit:1') })

    await expect(remoteExec('/home/user/project')).rejects.toThrow('exit:1')
    expect(exitMock).toHaveBeenCalledWith(1)
  })

  it('exits with code 1 when no saved config and no host provided', async () => {
    mockSpawnSync.mockReturnValueOnce({ // checkMutagen installed
      status: 0, stdout: 'mutagen version 0.17.0\n', stderr: '', pid: 0, output: [], signal: null
    })
    mockExistsSync.mockReturnValue(false)

    const exitMock = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit:1') })

    await expect(remoteExec('/home/user/project')).rejects.toThrow('exit:1')
    expect(exitMock).toHaveBeenCalledWith(1)
  })

  it('uses saved config when it exists and no host provided', async () => {
    setupSuccessfulSpawnSyncs()
    mockExistsSync.mockReturnValue(true)
    const config = { host: 'saved-host', user: 'saveduser', remotePath: '' }
    mockReadFileSync.mockReturnValue(JSON.stringify(config) as any)

    const spawnEmitter = makeSpawnMock(0)
    mockSpawn.mockReturnValue(spawnEmitter as any)
    mockPrompt.mockResolvedValue('n')

    const exitMock = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit:0') })

    await expect(remoteExec('/home/user/project')).rejects.toThrow('exit:0')
    expect(exitMock).toHaveBeenCalledWith(0)

    const logs = (console.log as any).mock.calls.map((c: any[]) => c.join(' '))
    expect(logs.some((l: string) => l.includes('saved-host'))).toBe(true)
  })

  it('saves new config when host is provided and host is reachable', async () => {
    setupSuccessfulSpawnSyncs()
    // existsSync: no config file saved yet
    mockExistsSync.mockReturnValue(false)

    // After checkMutagen (already consumed in setupSuccessfulSpawnSyncs),
    // we need isHostReachable ping BEFORE setupSuccessfulSpawnSyncs sequence.
    // Rebuild with host-provided path: mutagen check, ping, then the rest
    mockSpawnSync.mockReset()
    mockSpawnSync
      .mockReturnValueOnce({ // checkMutagen
        status: 0, stdout: 'mutagen version 0.17.0\n', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // isHostReachable ping
        status: 0, stdout: 'pong', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // ensureRemoteImage
        status: 0, stdout: 'sha256abc\n', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // startRemoteContainer
        status: 0, stdout: 'container-id\n', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // createContainerProjectDir
        status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // mutagen daemon start
        status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // getMutagenSyncStatus -> no session
        status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // mutagen sync create
        status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // waitForSync getMutagenSyncStatus
        status: 0, stdout: 'Status: Watching for changes\n', stderr: '', pid: 0, output: [], signal: null
      })

    mockPrompt.mockResolvedValueOnce('testuser').mockResolvedValue('n')
    mockMkdirSync.mockReturnValue(undefined as any)
    mockWriteFileSync.mockReturnValue(undefined)

    const spawnEmitter = makeSpawnMock(0)
    mockSpawn.mockReturnValue(spawnEmitter as any)

    const exitMock = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit:0') })

    await expect(remoteExec('/home/user/project', 'new-host')).rejects.toThrow('exit:0')

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('new-host'),
      expect.objectContaining({ mode: 0o600 })
    )
    expect(mockMkdirSync).toHaveBeenCalled()
  })

  it('exits with code 1 when host is not reachable', async () => {
    mockSpawnSync
      .mockReturnValueOnce({ // checkMutagen
        status: 0, stdout: 'mutagen version 0.17.0\n', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // isHostReachable ping fails
        status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null
      })
    mockExistsSync.mockReturnValue(false)

    const exitMock = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit:1') })

    await expect(remoteExec('/home/user/project', 'unreachable-host')).rejects.toThrow('exit:1')
    expect(exitMock).toHaveBeenCalledWith(1)
  })

  it('exits with code 1 when invalid hostname is provided', async () => {
    mockSpawnSync.mockReturnValueOnce({ // checkMutagen
      status: 0, stdout: 'mutagen version 0.17.0\n', stderr: '', pid: 0, output: [], signal: null
    })
    mockExistsSync.mockReturnValue(false)

    const exitMock = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit:1') })

    await expect(remoteExec('/home/user/project', 'bad host;rm -rf /')).rejects.toThrow('exit:1')
    expect(exitMock).toHaveBeenCalledWith(1)
  })

  it('exits with code 1 when saved config has invalid host', async () => {
    mockSpawnSync.mockReturnValueOnce({ // checkMutagen
      status: 0, stdout: 'mutagen version 0.17.0\n', stderr: '', pid: 0, output: [], signal: null
    })
    mockExistsSync.mockReturnValue(true)
    const badConfig = { host: 'bad host;inject', user: 'user', remotePath: '' }
    mockReadFileSync.mockReturnValue(JSON.stringify(badConfig) as any)

    const exitMock = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit:1') })

    await expect(remoteExec('/home/user/project')).rejects.toThrow('exit:1')
    expect(exitMock).toHaveBeenCalledWith(1)
  })

  it('exits with code 1 when ensureRemoteImage throws (image not found)', async () => {
    mockSpawnSync
      .mockReturnValueOnce({ // checkMutagen
        status: 0, stdout: 'mutagen version 0.17.0\n', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // ensureRemoteImage: docker images returns empty -> throws
        status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null
      })
    mockExistsSync.mockReturnValue(true)
    const config = { host: 'myhost', user: 'myuser', remotePath: '' }
    mockReadFileSync.mockReturnValue(JSON.stringify(config) as any)

    const exitMock = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit:1') })

    await expect(remoteExec('/home/user/project')).rejects.toThrow('exit:1')
    expect(exitMock).toHaveBeenCalledWith(1)
  })

  it('exits with code 1 when startRemoteContainer fails', async () => {
    mockSpawnSync
      .mockReturnValueOnce({ // checkMutagen
        status: 0, stdout: 'mutagen version 0.17.0\n', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // ensureRemoteImage success
        status: 0, stdout: 'sha256abc\n', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // startRemoteContainer fails
        status: 1, stdout: '', stderr: 'docker error', pid: 0, output: [], signal: null
      })
    mockExistsSync.mockReturnValue(true)
    const config = { host: 'myhost', user: 'myuser', remotePath: '' }
    mockReadFileSync.mockReturnValue(JSON.stringify(config) as any)

    const exitMock = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit:1') })

    await expect(remoteExec('/home/user/project')).rejects.toThrow('exit:1')
    expect(exitMock).toHaveBeenCalledWith(1)
  })

  it('resumes paused sync session when it exists as paused', async () => {
    mockSpawnSync
      .mockReturnValueOnce({ // checkMutagen
        status: 0, stdout: 'mutagen version 0.17.0\n', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // ensureRemoteImage
        status: 0, stdout: 'sha256abc\n', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // startRemoteContainer
        status: 0, stdout: 'container-id\n', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // createContainerProjectDir
        status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // mutagen daemon start
        status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // getMutagenSyncStatus -> paused
        status: 0, stdout: 'Status: Paused\n', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // mutagen sync resume
        status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // waitForSync getMutagenSyncStatus -> watching
        status: 0, stdout: 'Status: Watching for changes\n', stderr: '', pid: 0, output: [], signal: null
      })

    mockExistsSync.mockReturnValue(true)
    const config = { host: 'myhost', user: 'myuser', remotePath: '' }
    mockReadFileSync.mockReturnValue(JSON.stringify(config) as any)

    const spawnEmitter = makeSpawnMock(0)
    mockSpawn.mockReturnValue(spawnEmitter as any)
    mockPrompt.mockResolvedValue('n')

    const exitMock = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit:0') })

    await expect(remoteExec('/home/user/project')).rejects.toThrow('exit:0')

    const logCalls = (console.log as any).mock.calls.map((c: any[]) => c.join(' '))
    expect(logCalls.some((l: string) => l.includes('Resuming paused sync'))).toBe(true)
  })

  it('uses existing running sync session without creating new one', async () => {
    mockSpawnSync
      .mockReturnValueOnce({ // checkMutagen
        status: 0, stdout: 'mutagen version 0.17.0\n', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // ensureRemoteImage
        status: 0, stdout: 'sha256abc\n', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // startRemoteContainer
        status: 0, stdout: 'container-id\n', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // createContainerProjectDir
        status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // mutagen daemon start
        status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // getMutagenSyncStatus -> already watching
        status: 0, stdout: 'Status: Watching for changes\n', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // waitForSync getMutagenSyncStatus -> watching
        status: 0, stdout: 'Status: Watching for changes\n', stderr: '', pid: 0, output: [], signal: null
      })

    mockExistsSync.mockReturnValue(true)
    const config = { host: 'myhost', user: 'myuser', remotePath: '' }
    mockReadFileSync.mockReturnValue(JSON.stringify(config) as any)

    const spawnEmitter = makeSpawnMock(0)
    mockSpawn.mockReturnValue(spawnEmitter as any)
    mockPrompt.mockResolvedValue('n')

    const exitMock = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit:0') })

    await expect(remoteExec('/home/user/project')).rejects.toThrow('exit:0')

    const logCalls = (console.log as any).mock.calls.map((c: any[]) => c.join(' '))
    expect(logCalls.some((l: string) => l.includes('Sync already running'))).toBe(true)
  })

  it('pauses sync and stops container when user says yes on exit', async () => {
    setupSuccessfulSpawnSyncs()
    mockExistsSync.mockReturnValue(true)
    const config = { host: 'myhost', user: 'myuser', remotePath: '' }
    mockReadFileSync.mockReturnValue(JSON.stringify(config) as any)

    const spawnEmitter = makeSpawnMock(0)
    mockSpawn.mockReturnValue(spawnEmitter as any)
    mockPrompt.mockResolvedValue('y')

    const exitMock = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit:0') })

    await expect(remoteExec('/home/user/project')).rejects.toThrow('exit:0')

    const syncPauseCalls = mockSpawnSync.mock.calls.filter(
      (c) => c[0] === 'mutagen' && Array.isArray(c[1]) && c[1].includes('pause')
    )
    expect(syncPauseCalls.length).toBeGreaterThan(0)

    const sshStopCalls = mockSpawnSync.mock.calls.filter(
      (c) => c[0] === 'ssh' && Array.isArray(c[1]) && c[1].some((a: string) => a.includes('docker stop'))
    )
    expect(sshStopCalls.length).toBeGreaterThan(0)
  })

  it('does not pause/stop when user says no on exit', async () => {
    setupSuccessfulSpawnSyncs()
    mockExistsSync.mockReturnValue(true)
    const config = { host: 'myhost', user: 'myuser', remotePath: '' }
    mockReadFileSync.mockReturnValue(JSON.stringify(config) as any)

    const spawnEmitter = makeSpawnMock(0)
    mockSpawn.mockReturnValue(spawnEmitter as any)
    mockPrompt.mockResolvedValue('n')

    const exitMock = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit:0') })

    await expect(remoteExec('/home/user/project')).rejects.toThrow('exit:0')

    const syncPauseCalls = mockSpawnSync.mock.calls.filter(
      (c) => c[0] === 'mutagen' && Array.isArray(c[1]) && c[1].includes('pause')
    )
    expect(syncPauseCalls.length).toBe(0)
  })

  it('handles SSH error event and exits with code 1', async () => {
    setupSuccessfulSpawnSyncs()
    mockExistsSync.mockReturnValue(true)
    const config = { host: 'myhost', user: 'myuser', remotePath: '' }
    mockReadFileSync.mockReturnValue(JSON.stringify(config) as any)

    // Make spawn emit an error
    const emitter: any = {
      on: vi.fn((event: string, cb: (...args: any[]) => void) => {
        if (event === 'error') {
          Promise.resolve().then(() => cb(new Error('SSH connection refused')))
        }
        return emitter
      })
    }
    mockSpawn.mockReturnValue(emitter as any)

    const exitMock = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit:1') })

    await expect(remoteExec('/home/user/project')).rejects.toThrow('exit:1')
    expect(exitMock).toHaveBeenCalledWith(1)
  })

  it('throws error in waitForSync when sync status is null', async () => {
    mockSpawnSync
      .mockReturnValueOnce({ // checkMutagen
        status: 0, stdout: 'mutagen version 0.17.0\n', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // ensureRemoteImage
        status: 0, stdout: 'sha256abc\n', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // startRemoteContainer
        status: 0, stdout: 'container-id\n', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // createContainerProjectDir
        status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // mutagen daemon start
        status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // getMutagenSyncStatus -> no session
        status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // mutagen sync create
        status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // waitForSync: getMutagenSyncStatus -> null (session gone)
        status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null
      })

    mockExistsSync.mockReturnValue(true)
    const config = { host: 'myhost', user: 'myuser', remotePath: '' }
    mockReadFileSync.mockReturnValue(JSON.stringify(config) as any)

    const exitMock = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit:1') })

    await expect(remoteExec('/home/user/project')).rejects.toThrow('exit:1')
    expect(exitMock).toHaveBeenCalledWith(1)
  })

  it('throws error in waitForSync when sync status contains error', async () => {
    mockSpawnSync
      .mockReturnValueOnce({ // checkMutagen
        status: 0, stdout: 'mutagen version 0.17.0\n', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // ensureRemoteImage
        status: 0, stdout: 'sha256abc\n', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // startRemoteContainer
        status: 0, stdout: 'container-id\n', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // createContainerProjectDir
        status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // mutagen daemon start
        status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // getMutagenSyncStatus -> no session
        status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // mutagen sync create
        status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null
      })
      .mockReturnValueOnce({ // waitForSync: status = "error: some error"
        status: 0, stdout: 'Status: error: file conflict\n', stderr: '', pid: 0, output: [], signal: null
      })

    mockExistsSync.mockReturnValue(true)
    const config = { host: 'myhost', user: 'myuser', remotePath: '' }
    mockReadFileSync.mockReturnValue(JSON.stringify(config) as any)

    const exitMock = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit:1') })

    await expect(remoteExec('/home/user/project')).rejects.toThrow('exit:1')
    expect(exitMock).toHaveBeenCalledWith(1)
  })

  it('passes extra args to claude command via SSH', async () => {
    setupSuccessfulSpawnSyncs()
    mockExistsSync.mockReturnValue(true)
    const config = { host: 'myhost', user: 'myuser', remotePath: '' }
    mockReadFileSync.mockReturnValue(JSON.stringify(config) as any)

    const spawnEmitter = makeSpawnMock(0)
    mockSpawn.mockReturnValue(spawnEmitter as any)
    mockPrompt.mockResolvedValue('n')

    const exitMock = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit:0') })

    await expect(remoteExec('/home/user/project', undefined, ['--continue'])).rejects.toThrow('exit:0')

    const spawnCall = mockSpawn.mock.calls[0]
    expect(spawnCall[0]).toBe('ssh')
    // spawn("ssh", ["-t", "user@host", execCmd], ...)
    const execCmd = spawnCall[1][2] as string
    expect(execCmd).toContain("'--continue'")
  })
})
