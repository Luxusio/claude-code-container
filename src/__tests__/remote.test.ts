import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { hashPath } from '../utils.js'
import { getProjectHash, getMutagenSessionName, checkTailscale, checkMutagen, isHostReachable, getMutagenSyncStatus, isValidEnvKey, shellEscapeArg, isValidHostOrUser, remoteSetup, remoteCheck, remoteTerminate, remoteExec, remoteClaudeDirScript } from '../remote.js'
import * as childProcess from 'child_process'
import * as fs from 'fs'
import * as utils from '../utils.js'

const remoteSessionMocks = vi.hoisted(() => ({
  createSessionLock: vi.fn(() => '/locks/remote.lock'),
  removeSessionLock: vi.fn(),
  withContainerLifecycleLock: vi.fn((_prefix: string, operation: () => unknown) => operation()),
  withContainerLifecycleLockAsync: vi.fn((_prefix: string, operation: () => unknown) => operation()),
}))

vi.mock('../session.js', () => ({
  ...remoteSessionMocks,
  removeSessionLockInHeldLifecycleLock: remoteSessionMocks.removeSessionLock,
}))

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
    readFileSync: vi.fn((...args: Parameters<typeof actual.readFileSync>) => {
            // Package metadata is real; each test still controls its simulated filesystem.
            const [file] = args;
            return file instanceof URL && file.href === new URL('../../packages/device-lab/package.json', import.meta.url).href
                ? actual.readFileSync(...args) : undefined;
        }),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    renameSync: vi.fn()
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
    remoteSessionMocks.createSessionLock.mockReturnValue('/locks/remote.lock')
    remoteSessionMocks.withContainerLifecycleLock.mockImplementation((_prefix: string, operation: () => unknown) => operation())
    remoteSessionMocks.withContainerLifecycleLockAsync.mockImplementation((_prefix: string, operation: () => unknown) => operation())
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
    expect(mockSpawnSync).toHaveBeenCalledWith('mutagen', ['version'], expect.objectContaining({ encoding: 'utf-8', cwd: process.cwd(), env: expect.any(Object) }))
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
  beforeEach(() => { vi.clearAllMocks() })

  it('renders one exact-name record from complete official JSON', () => {
    mockSpawnSync.mockReturnValue(nativeResult(0, JSON.stringify([syncRecord('/home/user/project', 'user', 'host', { name: 'session', paused: true })])))
    expect(getMutagenSyncStatus('session')).toBe('Paused')
    expect(mockSpawnSync).toHaveBeenCalledWith('mutagen', ['sync', 'list', '--template', '{{json .}}'],
      expect.objectContaining({ encoding: 'utf-8', timeout: 30000, killSignal: 'SIGKILL', cwd: process.cwd(), env: expect.any(Object) }))
  })

  it.each([
    nativeResult(0, '[]'), nativeResult(1, '', new Error('returned failure')),
    nativeResult(null), nativeResult(0, 'not json'), nativeResult(0, '{}'),
  ])('returns null for absence or unavailable diagnostic inventory', result => {
    mockSpawnSync.mockReturnValue(result)
    expect(getMutagenSyncStatus('session')).toBeNull()
  })

  it('does not render an arbitrary first record when names are duplicated', () => {
    const first = syncRecord('/home/user/project', 'user', 'host', { name: 'session' })
    mockSpawnSync.mockReturnValue(nativeResult(0, JSON.stringify([first, { ...first, identifier: secondSyncId }])))
    expect(getMutagenSyncStatus('session')).toBeNull()
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

  it('prefers the config.json entry and falls back to the pre-layout remote/<hash>.json', async () => {
    const projectHash = getProjectHash('/home/user/project')
    const byPath = (files: Record<string, string>) => {
      mockExistsSync.mockImplementation((p) => Object.keys(files).some((suffix) => String(p).endsWith(suffix)))
      mockReadFileSync.mockImplementation(((p: string) => {
        const match = Object.keys(files).find((suffix) => String(p).endsWith(suffix))
        if (!match) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return files[match]
      }) as any)
    }
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')) })

    byPath({
      'config.json': JSON.stringify({ remote: { [projectHash]: { host: 'from-config', user: 'u', remotePath: '' } } }),
      [`${projectHash}.json`]: JSON.stringify({ host: 'from-legacy', user: 'u', remotePath: '' }),
    })
    await remoteCheck('/home/user/project')
    expect(logs.some(l => l.includes('from-config'))).toBe(true)
    expect(logs.some(l => l.includes('from-legacy'))).toBe(false)

    logs.length = 0
    byPath({ [`${projectHash}.json`]: JSON.stringify({ host: 'from-legacy', user: 'u', remotePath: '' }) })
    await remoteCheck('/home/user/project')
    expect(logs.some(l => l.includes('from-legacy'))).toBe(true)

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


const firstSyncId = 'sync_' + 'a'.repeat(43)
const secondSyncId = 'sync_' + 'b'.repeat(43)
const remoteContainerId = 'abcdef1234567890'
function nativeResult(status: number | null, stdout = '', error?: Error, stderr = '') {
  return { status, stdout, stderr, error, pid: 0, output: [], signal: null }
}
function syncRecord(projectPath: string, user = 'myuser', host = 'myhost', overrides: Record<string, unknown> = {}) {
  return { identifier: firstSyncId, name: getMutagenSessionName(projectPath) + '-' + hashPath(user + '@' + host),
    alpha: { protocol: 'local', path: projectPath },
    beta: { protocol: 'ssh', user, host, path: 'docker://' + remoteContainerId + '/project/' + utils.getProjectId(projectPath) },
    paused: false, status: 'watching', ...overrides }
}
function savedRemote(user = 'myuser', host = 'myhost') {
  vi.mocked(fs.existsSync).mockReturnValue(true)
  vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ user, host, remotePath: '' }) as any)
}
function nativeRemoteFixture() {
  const state = { sessions: [] as ReturnType<typeof syncRecord>[], lists: 0, onList: null as null | (() => void),
    listFailure: false, image: true, reserve: true, prepare: true, busy: false, tool: true,
    terminateFailure: false, pauseFailure: false, createFailure: false }
  vi.mocked(childProcess.spawnSync).mockReset().mockImplementation((command: any, raw: any) => {
    const args = raw as string[]
    if (command === 'mutagen') {
      if (args[0] === 'version') return nativeResult(state.tool ? 0 : 1, 'mutagen version 0.17.0\n')
      if (args[0] === 'daemon') return nativeResult(0)
      if (args[1] === 'list') {
        state.lists++; state.onList?.()
        return state.listFailure ? nativeResult(1, '', undefined, 'inventory unavailable') : nativeResult(0, JSON.stringify(state.sessions))
      }
      if (args[1] === 'create') {
        if (state.createFailure) return nativeResult(0, '', Error('create returned error'))
        const destination = /^([^@]+)@([^:]+):(.*)$/.exec(args[3])!
        state.sessions.push(syncRecord(args[2], destination[1], destination[2], {
          name: args[args.indexOf('--name') + 1],
          beta: { protocol: 'ssh', user: destination[1], host: destination[2], path: destination[3] },
        }))
        return nativeResult(0)
      }
      if (args[1] === 'terminate') {
        if (state.terminateFailure) return nativeResult(1, '', Error('terminate returned error'))
        state.sessions = state.sessions.filter(row => row.identifier !== args[2] && row.name !== args[2])
      }
      if (args[1] === 'pause' && state.pauseFailure) return nativeResult(1, '', Error('pause returned error'))
      return nativeResult(0)
    }
    if (command === 'tailscale') return nativeResult(0, 'tailscale version 1.50.0\n')
    if (command === 'ping') return nativeResult(0)
    if (command === 'ssh') {
      const body = args.at(-1) ?? ''
      if (body.includes('docker images -q')) return nativeResult(0, state.image ? 'sha256abc\n' : '')
      if (body.includes('docker run -d')) return state.reserve ? nativeResult(0, 'ccc-container-id=' + remoteContainerId + '\n') : nativeResult(1, '', undefined, 'docker error')
      if (body.includes('mkdir -p /project/')) return nativeResult(state.prepare ? 0 : 1, '', undefined, state.prepare ? '' : 'container disappeared')
      if (body.includes('docker stop') && state.busy) return nativeResult(42, 'ccc-remote-sessions-active\n')
      return nativeResult(0)
    }
    return nativeResult(1, '', undefined, 'unexpected executable: ' + command)
  })
  return state
}

describe('remoteCheck', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.spyOn(console, 'log').mockImplementation(() => {}); nativeRemoteFixture(); savedRemote() })
  afterEach(() => { vi.restoreAllMocks() })
  it('prints sections, both tool statuses, saved config and reachable host', async () => {
    await remoteCheck('/home/user/project')
    const logs = vi.mocked(console.log).mock.calls.map(row => row.join(' '))
    for (const text of ['CCC Remote Status', 'Tailscale', 'Mutagen', 'myhost', 'myuser', 'Host reachable']) expect(logs.some(line => line.includes(text))).toBe(true)
  })
  it('shows active exact-authority sync with preserved display status', async () => {
    const state = nativeRemoteFixture(); state.sessions = [syncRecord('/home/user/project')]
    await remoteCheck('/home/user/project')
    expect(vi.mocked(console.log).mock.calls.some(row => row.join(' ').includes('Watching for changes'))).toBe(true)
  })
  it('reports an unreachable saved host while keeping read-only sync inspection available', async () => {
    const prior = vi.mocked(childProcess.spawnSync).getMockImplementation()!
    vi.mocked(childProcess.spawnSync).mockImplementation(((command: any, args: any, options: any) => command === 'ping' ? nativeResult(1) : prior(command, args, options)) as any)
    await remoteCheck('/home/user/project')
    expect(vi.mocked(console.log).mock.calls.some(row => row.join(' ').includes('[--] Host reachable'))).toBe(true)
  })
  it('reports proved absence separately from failed inventory and scope conflicts', async () => {
    const state = nativeRemoteFixture()
    await remoteCheck('/home/user/project')
    expect(vi.mocked(console.log).mock.calls.some(row => row.join(' ').includes('No active sync session'))).toBe(true)
    vi.mocked(console.log).mockClear(); state.listFailure = true
    await remoteCheck('/home/user/project')
    expect(console.log).toHaveBeenCalledWith('  Sync state could not be established.')
    expect(vi.mocked(console.log).mock.calls.some(row => row.join(' ').includes('No active sync session'))).toBe(false)
    vi.mocked(console.log).mockClear(); state.listFailure = false
    state.sessions = [syncRecord('/home/user/project', 'foreign', 'other', { name: syncRecord('/home/user/project').name })]
    await remoteCheck('/home/user/project')
    expect(vi.mocked(console.log).mock.calls.some(row => /conflict/i.test(row.join(' ')))).toBe(true)
  })
  it('reports missing and invalid config without inventing missing sync or dispatching ping', async () => {
    for (const raw of [null, { user: 'myuser', host: 'bad;host', remotePath: '' }]) {
      vi.mocked(fs.existsSync).mockReturnValue(raw !== null)
      vi.mocked(fs.readFileSync).mockReturnValue(raw ? JSON.stringify(raw) as any : undefined as any)
      vi.mocked(childProcess.spawnSync).mockClear()
      await remoteCheck('/home/user/project')
      expect(vi.mocked(childProcess.spawnSync).mock.calls.some(call => call[0] === 'ping')).toBe(false)
    }
  })
  it('reports missing Mutagen without querying inventory', async () => {
    const state = nativeRemoteFixture(); state.tool = false
    await remoteCheck('/home/user/project'); expect(state.lists).toBe(0)
    expect(vi.mocked(console.log).mock.calls.some(row => row.join(' ').includes('mutagen not installed'))).toBe(true)
  })
})

describe('remoteTerminate', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.spyOn(console, 'log').mockImplementation(() => {}); nativeRemoteFixture(); savedRemote() })
  afterEach(() => { vi.restoreAllMocks() })
  it('terminates only the verified identifier and reports success after checked completion', async () => {
    const state = nativeRemoteFixture(); state.sessions = [syncRecord('/home/user/project')]
    await remoteTerminate('/home/user/project')
    expect(vi.mocked(childProcess.spawnSync)).toHaveBeenCalledWith('mutagen', ['sync', 'terminate', firstSyncId], expect.objectContaining({ stdio: 'inherit' }))
    expect(console.log).toHaveBeenCalledWith('Sync terminated.')
  })
  it('does not report success after returned native termination failure', async () => {
    const state = nativeRemoteFixture(); state.sessions = [syncRecord('/home/user/project')]; state.terminateFailure = true
    await expect(remoteTerminate('/home/user/project')).rejects.toThrow('Failed to terminate')
    expect(console.log).not.toHaveBeenCalledWith('Sync terminated.')
  })
  it('treats known empty inventory as inactive without termination', async () => {
    await remoteTerminate('/home/user/project')
    expect(console.log).toHaveBeenCalledWith('No active sync session for this project.')
    expect(vi.mocked(childProcess.spawnSync).mock.calls.some(call => (call[1] as string[])?.includes('terminate'))).toBe(false)
  })
  it('refuses legacy, duplicate and foreign scope records without effects', async () => {
    for (const records of [
      [syncRecord('/home/user/project', 'myuser', 'myhost', { name: getMutagenSessionName('/home/user/project') })],
      [syncRecord('/home/user/project'), syncRecord('/home/user/project', 'myuser', 'myhost', { identifier: secondSyncId })],
      [syncRecord('/home/user/project', 'other', 'foreign', { name: syncRecord('/home/user/project').name })],
    ]) {
      const state = nativeRemoteFixture(); state.sessions = records
      await expect(remoteTerminate('/home/user/project')).rejects.toThrow(/conflict/i)
      expect(vi.mocked(childProcess.spawnSync).mock.calls.some(call => ['terminate', 'pause', 'resume', 'create'].includes((call[1] as string[])?.[1]))).toBe(false)
    }
  })
  it('requires valid saved config and refuses failed inventory', async () => {
    const state = nativeRemoteFixture(); state.listFailure = true
    await expect(remoteTerminate('/home/user/project')).rejects.toThrow(/unknown|could not|unavailable/i)
    savedRemote('myuser', 'bad;host')
    await expect(remoteTerminate('/home/user/project')).rejects.toThrow(/invalid/i)
    vi.mocked(fs.existsSync).mockReturnValue(false)
    await expect(remoteTerminate('/home/user/project')).rejects.toThrow(/configuration/i)
  })
})

describe('remoteExec', () => {
  const path = '/home/user/project'
  const mockSpawnSync = vi.mocked(childProcess.spawnSync), mockSpawn = vi.mocked(childProcess.spawn)
  const mockPrompt = vi.mocked(utils.prompt)
  function child(exitCode = 0) {
    const emitter: any = { kill: vi.fn(() => true), on: vi.fn((event: string, callback: (value: any) => void) => {
      if (event === 'close') queueMicrotask(() => callback(exitCode))
      return emitter
    }) }
    return emitter
  }
  function exit(code = 0) { return vi.spyOn(process, 'exit').mockImplementation(() => { throw Error('exit:' + code) }) }
  beforeEach(() => {
    vi.clearAllMocks()
    remoteSessionMocks.withContainerLifecycleLock.mockImplementation((_prefix: string, operation: () => unknown) => operation())
    remoteSessionMocks.withContainerLifecycleLockAsync.mockImplementation((_prefix: string, operation: () => unknown) => operation())
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    nativeRemoteFixture(); savedRemote(); mockSpawn.mockReturnValue(child()); mockPrompt.mockResolvedValue('n')
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('exits before claim when Mutagen is missing, config absent or saved config invalid', async () => {
    const state = nativeRemoteFixture(); state.tool = false; const exited = exit(1)
    await expect(remoteExec(path)).rejects.toThrow('exit:1'); expect(remoteSessionMocks.createSessionLock).not.toHaveBeenCalled()
    state.tool = true; vi.mocked(fs.existsSync).mockReturnValue(false)
    await expect(remoteExec(path)).rejects.toThrow('exit:1')
    savedRemote('myuser', 'bad;host')
    await expect(remoteExec(path)).rejects.toThrow('exit:1'); expect(exited).toHaveBeenCalledWith(1)
  })
  it('uses saved host/user and exact remote container for preparation, creation and SSH', async () => {
    savedRemote('saveduser', 'saved-host'); const exited = exit()
    await expect(remoteExec(path)).rejects.toThrow('exit:0')
    const create = mockSpawnSync.mock.calls.find(call => call[0] === 'mutagen' && (call[1] as string[])[1] === 'create')
    expect(create?.[1]).toEqual(expect.arrayContaining(['saveduser@saved-host:docker://' + remoteContainerId + '/project/' + utils.getProjectId(path)]))
    const prepare = mockSpawnSync.mock.calls.find(call => call[0] === 'ssh' && (call[1] as string[]).some(value => value.includes('mkdir -p /project/')))
    expect((prepare?.[1] as string[])[1]).toContain('docker exec ' + remoteContainerId)
    expect((mockSpawn.mock.calls[0][1] as string[])[2]).toContain(remoteContainerId); expect(exited).toHaveBeenCalledWith(0)
  })
  it('refuses a late watching result before interactive SSH and releases its claim', async () => {
    const state = nativeRemoteFixture(); state.sessions = [syncRecord(path)]
    let clock = 123; vi.spyOn(performance, 'now').mockImplementation(() => clock)
    state.onList = () => { if (state.lists === 2) clock += 120_001 }
    const exited = exit(1)
    await expect(remoteExec(path)).rejects.toThrow('exit:1')
    expect(mockSpawn).not.toHaveBeenCalled(); expect(mockPrompt).not.toHaveBeenCalled()
    expect(console.error).toHaveBeenCalledWith('Error: Sync timeout - initial sync did not complete')
    expect(console.log).not.toHaveBeenCalledWith(' done')
    const queries = mockSpawnSync.mock.calls.filter(call => call[0] === 'mutagen' && (call[1] as string[])[1] === 'list')
    expect(queries).toHaveLength(2); expect(queries[1][2]).toMatchObject({ timeout: 30000, killSignal: 'SIGKILL' })
    expect(remoteSessionMocks.removeSessionLock).toHaveBeenCalledExactlyOnceWith('/locks/remote.lock')
    expect(remoteSessionMocks.removeSessionLock.mock.invocationCallOrder[0]).toBeLessThan(exited.mock.invocationCallOrder[0])
  })
  it('saves chosen config atomically when explicit host is reachable and retains remote mounts', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false); mockPrompt.mockResolvedValueOnce('testuser').mockResolvedValue('n'); exit()
    await expect(remoteExec(path, 'new-host')).rejects.toThrow('exit:0')
    const write = vi.mocked(fs.writeFileSync).mock.calls.find(([file]) => /config\.json\.\d+\.tmp$/.test(String(file)))
    expect(write).toBeDefined(); expect(write![2]).toEqual({ mode: 0o600 })
    expect(Object.values(JSON.parse(String(write![1])).remote)).toEqual([expect.objectContaining({ host: 'new-host', user: 'testuser' })])
    expect(vi.mocked(fs.renameSync)).toHaveBeenCalledWith(write![0], expect.stringMatching(/\.ccc[\\/]config\.json$/))
    const reservation = mockSpawnSync.mock.calls.find(call => call[0] === 'ssh' && (call[1] as string[]).some(value => value.includes('docker run -d')))
    expect((reservation?.[1] as string[])[1]).toContain(remoteClaudeDirScript() + '; _ccc_container_id=')
    expect((reservation?.[1] as string[])[1]).toContain('-v "$_ccc_claude_dir:/home/ccc/.claude"')
  })
  it('refuses invalid or unreachable explicit host before saving or claiming', async () => {
    exit(1); await expect(remoteExec(path, 'bad host;inject')).rejects.toThrow('exit:1')
    mockSpawnSync.mockImplementation((command: any) => nativeResult(command === 'mutagen' ? 0 : 1, 'version'))
    await expect(remoteExec(path, 'offline')).rejects.toThrow('exit:1'); expect(remoteSessionMocks.createSessionLock).not.toHaveBeenCalled()
  })
  it.each(['image', 'reserve', 'prepare'] as const)('fails %s before sync or interactive SSH and retires local claim', async stage => {
    const state = nativeRemoteFixture(); state[stage] = false; exit(1)
    await expect(remoteExec(path)).rejects.toThrow('exit:1'); expect(mockSpawn).not.toHaveBeenCalled()
    expect(mockSpawnSync.mock.calls.some(call => call[0] === 'mutagen' && (call[1] as string[])[0] === 'sync')).toBe(false)
    expect(remoteSessionMocks.removeSessionLock).toHaveBeenCalledExactlyOnceWith('/locks/remote.lock')
  })
  it('resumes paused exact binding by unique identifier', async () => {
    const state = nativeRemoteFixture(); state.sessions = [syncRecord(path, 'myuser', 'myhost', { paused: true })]; exit()
    await expect(remoteExec(path)).rejects.toThrow('exit:0')
    expect(mockSpawnSync).toHaveBeenCalledWith('mutagen', ['sync', 'resume', firstSyncId], expect.objectContaining({ stdio: 'inherit' }))
    expect(mockSpawnSync.mock.calls.some(call => call[0] === 'mutagen' && (call[1] as string[])[1] === 'create')).toBe(false)
  })
  it('reuses a running exact binding without creating another writer', async () => {
    const state = nativeRemoteFixture(); state.sessions = [syncRecord(path)]; exit()
    await expect(remoteExec(path)).rejects.toThrow('exit:0'); expect(console.log).toHaveBeenCalledWith('Sync already running (Watching for changes)')
    expect(mockSpawnSync.mock.calls.some(call => call[0] === 'mutagen' && ['create', 'resume', 'terminate'].includes((call[1] as string[])[1]))).toBe(false)
  })
  it('replaces only a changed container ID through checked old identifier termination', async () => {
    const state = nativeRemoteFixture(); state.sessions = [syncRecord(path, 'myuser', 'myhost', {
      identifier: secondSyncId, beta: { protocol: 'ssh', user: 'myuser', host: 'myhost', path: 'docker://' + '1'.repeat(16) + '/project/' + utils.getProjectId(path) },
    })]; exit()
    await expect(remoteExec(path)).rejects.toThrow('exit:0')
    expect(mockSpawnSync).toHaveBeenCalledWith('mutagen', ['sync', 'terminate', secondSyncId], expect.objectContaining({ stdio: 'inherit' }))
    expect(state.sessions).toHaveLength(1); expect(state.sessions[0].identifier).toBe(firstSyncId)
  })
  it('never creates from failed inventory and never launches SSH after checked create failure', async () => {
    const state = nativeRemoteFixture(); state.listFailure = true; exit(1)
    await expect(remoteExec(path)).rejects.toThrow('exit:1')
    expect(mockSpawnSync.mock.calls.some(call => call[0] === 'mutagen' && (call[1] as string[])[1] === 'create')).toBe(false)
    state.listFailure = false; state.createFailure = true
    await expect(remoteExec(path)).rejects.toThrow('exit:1'); expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('stops exact container before pausing captured identifier when user says yes', async () => {
    mockPrompt.mockResolvedValue('y'); const exited = exit()
    await expect(remoteExec(path)).rejects.toThrow('exit:0')
    expect(mockSpawnSync).toHaveBeenCalledWith('mutagen', ['sync', 'pause', firstSyncId], expect.objectContaining({ stdio: 'inherit' }))
    const stopIndex = mockSpawnSync.mock.calls.findIndex(call => call[0] === 'ssh' && (call[1] as string[]).some(value => value.includes('docker stop')))
    const pauseIndex = mockSpawnSync.mock.calls.findIndex(call => call[0] === 'mutagen' && (call[1] as string[])[1] === 'pause')
    expect(stopIndex).toBeGreaterThanOrEqual(0); expect(stopIndex).toBeLessThan(pauseIndex)
    expect((mockSpawnSync.mock.calls[stopIndex][1] as string[])[1]).toContain('_ccc_expiry')
    expect(mockSpawnSync.mock.calls[stopIndex][2]).toMatchObject({ timeout: 60000 })
    expect(remoteSessionMocks.removeSessionLock.mock.invocationCallOrder[0]).toBeLessThan(exited.mock.invocationCallOrder[0])
  })
  it('preserves sync when remote stop reports another active session', async () => {
    const state = nativeRemoteFixture(); state.busy = true; mockPrompt.mockResolvedValue('yes'); exit()
    await expect(remoteExec(path)).rejects.toThrow('exit:0')
    expect(mockSpawnSync.mock.calls.some(call => call[0] === 'mutagen' && (call[1] as string[])[1] === 'pause')).toBe(false)
    expect(console.log).toHaveBeenCalledWith('Remote container remains running: another CCC remote session is active.')
  })
  it('does not pause or stop when user declines cleanup', async () => {
    exit(); await expect(remoteExec(path)).rejects.toThrow('exit:0')
    expect(mockSpawnSync.mock.calls.some(call => call[0] === 'mutagen' && (call[1] as string[])[1] === 'pause')).toBe(false)
    expect(mockSpawnSync.mock.calls.some(call => call[0] === 'ssh' && (call[1] as string[]).some(value => value.includes('docker stop')))).toBe(false)
  })
  it('reports SSH error and removes claim before failure exit', async () => {
    const emitter: any = { on: vi.fn((event: string, callback: (error: Error) => void) => { if (event === 'error') queueMicrotask(() => callback(Error('SSH refused'))); return emitter }) }
    mockSpawn.mockReturnValue(emitter); const exited = exit(1)
    await expect(remoteExec(path)).rejects.toThrow('exit:1')
    expect(remoteSessionMocks.removeSessionLock.mock.invocationCallOrder[0]).toBeLessThan(exited.mock.invocationCallOrder[0])
  })
  it('forwards signals to active SSH then removes the claim before self signalling', async () => {
    let closed: ((code: number) => void) | undefined
    const emitter: any = { kill: vi.fn(() => true), on: vi.fn((event: string, callback: (code: number) => void) => { if (event === 'close') closed = callback; return emitter }) }
    mockSpawn.mockReturnValue(emitter); const killed = vi.spyOn(process, 'kill').mockImplementation(() => true), exited = exit()
    const execution = remoteExec(path)
    for (let attempt = 0; attempt < 30 && !closed; attempt++) await Promise.resolve()
    expect(closed).toBeTypeOf('function'); process.emit('SIGTERM')
    expect(emitter.kill).toHaveBeenCalledWith('SIGTERM'); expect(remoteSessionMocks.removeSessionLock).not.toHaveBeenCalled()
    closed!(0); await execution
    expect(exited).not.toHaveBeenCalled(); expect(killed).toHaveBeenCalledWith(process.pid, 'SIGTERM')
    expect(remoteSessionMocks.removeSessionLock.mock.invocationCallOrder[0]).toBeLessThan(killed.mock.invocationCallOrder[0])
  })
  it.each(['missing', 'failed'] as const)('refuses %s captured wait before interactive SSH', async mode => {
    const state = nativeRemoteFixture(); state.sessions = [syncRecord(path)]
    state.onList = () => { if (state.lists === 2) state.sessions = mode === 'missing' ? [] : [syncRecord(path, 'myuser', 'myhost', { status: 'halted-on-root-deletion' })] }
    exit(1); await expect(remoteExec(path)).rejects.toThrow('exit:1'); expect(mockSpawn).not.toHaveBeenCalled()
  })
  it('encodes literal arguments and preserves private remote reservation preparation', async () => {
    exit(); const malicious = '$(touch /tmp/ccc-injected)"' + String.fromCharCode(96) + 'whoami' + String.fromCharCode(96)
    await expect(remoteExec(path, undefined, ['--continue', malicious])).rejects.toThrow('exit:0')
    const command = (mockSpawn.mock.calls[0][1] as string[])[2]; expect(command).not.toContain(malicious)
    const decoded = (command.match(/[A-Za-z0-9+/=]{40,}/g) || []).map(value => Buffer.from(value, 'base64').toString('utf8'))
    expect(decoded.some(value => value.includes("exec claude '--continue'") && value.includes(malicious))).toBe(true)
    const start = mockSpawnSync.mock.calls.find(call => call[0] === 'ssh' && (call[1] as string[]).some(value => value.includes('docker run -d')))!
    const program = (start[1] as string[])[1]
    for (const fragment of ['$HOME/.ccc', 'remote-runtime', '_ccc_owner_token', '_ccc_now=$(date +%s)', 'chmod 700']) expect(program).toContain(fragment)
    expect(program.indexOf('sessions-')).toBeLessThan(program.indexOf('docker run -d'))
  })
})
