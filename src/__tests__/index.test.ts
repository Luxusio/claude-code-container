import { describe, it, expect, vi, beforeEach } from 'vitest'
import { hashPath, getProjectId } from '../utils.js'
import { getContainerName } from '../docker.js'
import { MISE_VOLUME_NAME, CONTAINER_ENV_KEY, CONTAINER_ENV_VALUE } from '../utils.js'

vi.mock('fs', async () => {
    const actual = await vi.importActual<typeof import('fs')>('fs')
    return {
        ...actual,
        existsSync: vi.fn(),
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
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
})

describe('getProjectId', () => {
  it('generates correct format', () => {
    const result = getProjectId('/home/user/my-project')
    expect(result).toMatch(/^my-project-[a-f0-9]{12}$/)
  })

  it('sanitizes special characters', () => {
    const result = getProjectId('/home/user/My Project!')
    expect(result).toMatch(/^my-project--[a-f0-9]{12}$/)
  })

  it('handles uppercase', () => {
    const result = getProjectId('/home/user/MyProject')
    expect(result).toMatch(/^myproject-[a-f0-9]{12}$/)
  })

  it('returns consistent IDs', () => {
    const id1 = getProjectId('/home/user/project')
    const id2 = getProjectId('/home/user/project')
    expect(id1).toBe(id2)
  })
})

describe('getContainerName', () => {
  it('generates correct format', () => {
    const result = getContainerName('/home/user/my-project')
    expect(result).toMatch(/^ccc-my-project-[a-f0-9]{12}$/)
  })

  it('prefixes with ccc-', () => {
    const result = getContainerName('/home/user/test')
    expect(result).toMatch(/^ccc-/)
  })

  it('returns consistent names', () => {
    const n1 = getContainerName('/home/user/project')
    const n2 = getContainerName('/home/user/project')
    expect(n1).toBe(n2)
  })
})

describe('named volume integration', () => {
  it('MISE_VOLUME_NAME should be ccc-mise-cache', () => {
    expect(MISE_VOLUME_NAME).toBe('ccc-mise-cache')
  })
})

describe('container environment marker', () => {
  it('CONTAINER_ENV_KEY follows systemd convention (lowercase)', () => {
    expect(CONTAINER_ENV_KEY).toBe('container')
  })

  it('CONTAINER_ENV_VALUE is docker', () => {
    expect(CONTAINER_ENV_VALUE).toBe('docker')
  })

  it('formats correctly as docker exec -e flag', () => {
    const flag = `${CONTAINER_ENV_KEY}=${CONTAINER_ENV_VALUE}`
    expect(flag).toBe('container=docker')
  })

  it('formats correctly as shell-escaped remote env flag', () => {
    const flag = `-e '${CONTAINER_ENV_KEY}=${CONTAINER_ENV_VALUE}'`
    expect(flag).toBe("-e 'container=docker'")
  })
})

describe('ensureBrowserMcp', () => {
  let fsMock: typeof import('fs')
  let existsSync: ReturnType<typeof vi.fn>
  let readFileSync: ReturnType<typeof vi.fn>
  let writeFileSync: ReturnType<typeof vi.fn>
  let ensureBrowserMcp: () => void

  beforeEach(async () => {
    vi.resetModules()
    fsMock = await import('fs')
    existsSync = fsMock.existsSync as ReturnType<typeof vi.fn>
    readFileSync = fsMock.readFileSync as ReturnType<typeof vi.fn>
    writeFileSync = fsMock.writeFileSync as ReturnType<typeof vi.fn>
    vi.clearAllMocks()
    const mod = await import('../index.js')
    ensureBrowserMcp = mod.ensureBrowserMcp
  })

  function getWrittenConfig(): Record<string, unknown> {
    expect(writeFileSync).toHaveBeenCalled()
    const rawJson = writeFileSync.mock.calls[0][1] as string
    return JSON.parse(rawJson)
  }

  it('creates chrome-devtools entry when file contains empty object', () => {
    existsSync.mockReturnValue(true)
    readFileSync.mockReturnValue('{}')
    ensureBrowserMcp()
    const config = getWrittenConfig()
    const servers = config.mcpServers as Record<string, unknown>
    expect(servers['chrome-devtools']).toBeDefined()
  })

  it('preserves existing mcpServers entries while adding chrome-devtools', () => {
    existsSync.mockReturnValue(true)
    readFileSync.mockReturnValue(JSON.stringify({ mcpServers: { 'my-tool': { command: 'foo' } } }))
    ensureBrowserMcp()
    const config = getWrittenConfig()
    const servers = config.mcpServers as Record<string, unknown>
    expect(servers['my-tool']).toEqual({ command: 'foo' })
    expect(servers['chrome-devtools']).toBeDefined()
  })

  it('removes old playwright entry if it exists', () => {
    existsSync.mockReturnValue(true)
    readFileSync.mockReturnValue(JSON.stringify({ mcpServers: { playwright: { command: 'npx' } } }))
    ensureBrowserMcp()
    const config = getWrittenConfig()
    const servers = config.mcpServers as Record<string, unknown>
    expect(servers['playwright']).toBeUndefined()
  })

  it('handles corrupt/invalid JSON by resetting config to empty object', () => {
    existsSync.mockReturnValue(true)
    readFileSync.mockReturnValue('not valid json {{{{')
    ensureBrowserMcp()
    const config = getWrittenConfig()
    expect(config.mcpServers).toBeDefined()
    const servers = config.mcpServers as Record<string, unknown>
    expect(servers['chrome-devtools']).toBeDefined()
  })

  it('uses correct Chromium executable path', () => {
    existsSync.mockReturnValue(true)
    readFileSync.mockReturnValue('{}')
    ensureBrowserMcp()
    const config = getWrittenConfig()
    const servers = config.mcpServers as Record<string, unknown>
    const entry = servers['chrome-devtools'] as { args: string[] }
    expect(entry.args).toContain('--executablePath=/usr/bin/chromium')
  })

  it('includes sandbox-disable flags', () => {
    existsSync.mockReturnValue(true)
    readFileSync.mockReturnValue('{}')
    ensureBrowserMcp()
    const config = getWrittenConfig()
    const servers = config.mcpServers as Record<string, unknown>
    const entry = servers['chrome-devtools'] as { args: string[] }
    expect(entry.args).toContain('--chromeArg=--no-sandbox')
    expect(entry.args).toContain('--chromeArg=--disable-setuid-sandbox')
  })

  it('includes host-resolver-rules for localhost mapping', () => {
    existsSync.mockReturnValue(true)
    readFileSync.mockReturnValue('{}')
    ensureBrowserMcp()
    const config = getWrittenConfig()
    const servers = config.mcpServers as Record<string, unknown>
    const entry = servers['chrome-devtools'] as { args: string[] }
    expect(entry.args).toContain('--chromeArg=--host-resolver-rules=MAP localhost host.docker.internal')
  })

  it('uses mise exec node@22 as command wrapper', () => {
    existsSync.mockReturnValue(true)
    readFileSync.mockReturnValue('{}')
    ensureBrowserMcp()
    const config = getWrittenConfig()
    const servers = config.mcpServers as Record<string, unknown>
    const entry = servers['chrome-devtools'] as { command: string; args: string[] }
    expect(entry.command).toBe('mise')
    expect(entry.args[0]).toBe('exec')
    expect(entry.args[1]).toBe('node@22')
  })

  it('works when CLAUDE_JSON_FILE does not exist (skips read, still writes)', async () => {
    existsSync.mockReturnValue(false)
    ensureBrowserMcp()
    const config = getWrittenConfig()
    const servers = config.mcpServers as Record<string, unknown>
    expect(servers['chrome-devtools']).toBeDefined()
    // readFileSync should not have been called with CLAUDE_JSON_FILE since existsSync returned false
    const { CLAUDE_JSON_FILE } = await import('../utils.js')
    const calledWithConfig = readFileSync.mock.calls.some(
      (call: unknown[]) => call[0] === CLAUDE_JSON_FILE
    )
    expect(calledWithConfig).toBe(false)
  })
})
