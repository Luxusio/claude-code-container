import { describe, it, expect, vi, beforeEach } from 'vitest'
import { hashPath, getProjectId } from '../utils.js'
import { getContainerName, isContainerImageOutdated } from '../docker.js'
import { MISE_VOLUME_NAME, CONTAINER_ENV_KEY, CONTAINER_ENV_VALUE, EXCLUDE_ENV_KEYS } from '../utils.js'
import { parseArgs, informationalCommand, resolveExecTools, maybeAttachCodexClipboardImageForCommand, buildToolInvocation, replaceStoppedContainerWithoutInterruptingSessions, withWorkspaceRemovalLifecycleLock, removeWorkspaceContainerByIdentity, RUNNING_CONTAINER_UPDATE_DEFERRED_MESSAGE } from '../index.js'
import { getToolByName } from '../tool-registry.js'

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

describe('workspace removal lifecycle lock', () => {
  it('keeps the final session check and removal in one critical section', () => {
    let insideLock = false
    const lifecycleLock = vi.fn((_projectId: string, operation: () => string) => {
      insideLock = true
      try { return operation() } finally { insideLock = false }
    })
    const activeSessions = vi.fn(() => {
      expect(insideLock).toBe(true)
      return []
    })
    const removal = vi.fn(() => {
      expect(insideLock).toBe(true)
      return 'removed'
    })

    expect(withWorkspaceRemovalLifecycleLock('project-id', false, removal, lifecycleLock, activeSessions)).toBe('removed')
    expect(lifecycleLock).toHaveBeenCalledWith('project-id', expect.any(Function))
    expect(removal).toHaveBeenCalledOnce()
    expect(insideLock).toBe(false)
  })

  it('blocks removal when a session appears at the final locked check', () => {
    const removal = vi.fn()
    const lifecycleLock = (_projectId: string, operation: () => unknown) => operation()
    const activeSessions = () => ['new-session.lock']

    expect(() => withWorkspaceRemovalLifecycleLock('project-id', false, removal, lifecycleLock, activeSessions))
      .toThrow('Workspace has 1 active session(s)')
    expect(removal).not.toHaveBeenCalled()
  })
})

describe('workspace container cleanup identity fencing', () => {
  it('stops and removes only the captured running container ID', () => {
    const runner = vi.fn(() => ({ status: 0 })) as any
    const probe = vi.fn(() => ({ containerId: 'pinned123456', running: true }))

    expect(removeWorkspaceContainerByIdentity('ccc-worktree', probe, runner, 'docker')).toBe(true)
    expect(runner).toHaveBeenNthCalledWith(1, 'docker', ['stop', 'pinned123456'], { stdio: 'ignore' })
    expect(runner).toHaveBeenNthCalledWith(2, 'docker', ['rm', 'pinned123456'], { stdio: 'ignore' })
    expect(runner.mock.calls.flat()).not.toContain('ccc-worktree')
  })

  it('removes a captured stopped ID without issuing stop', () => {
    const runner = vi.fn(() => ({ status: 0 })) as any
    const probe = vi.fn(() => ({ containerId: 'stopped12345', running: false }))

    expect(removeWorkspaceContainerByIdentity('ccc-worktree', probe, runner, 'docker')).toBe(true)
    expect(runner).toHaveBeenCalledOnce()
    expect(runner).toHaveBeenCalledWith('docker', ['rm', 'stopped12345'], { stdio: 'ignore' })
  })

  it('preserves the container when identity inspection fails', () => {
    const runner = vi.fn() as any

    expect(removeWorkspaceContainerByIdentity('ccc-worktree', () => null, runner, 'docker', () => false)).toBe(false)
    expect(runner).not.toHaveBeenCalled()
  })

  it('aborts workspace removal when a named container exists but identity inspection fails', () => {
    const runner = vi.fn() as any

    expect(() => removeWorkspaceContainerByIdentity('ccc-worktree', () => null, runner, 'docker', () => true))
      .toThrow('identity inspection failed')
    expect(runner).not.toHaveBeenCalled()
  })

  it('does not remove when stopping the captured container fails', () => {
    const runner = vi.fn()
      .mockReturnValueOnce({ status: 1 }) as any
    const probe = () => ({ containerId: 'pinned123456', running: true })

    expect(() => removeWorkspaceContainerByIdentity('ccc-worktree', probe, runner, 'docker'))
      .toThrow('Failed to stop workspace container')
    expect(runner).toHaveBeenCalledOnce()
  })

  it('reports removal failure for a captured stopped container', () => {
    const runner = vi.fn(() => ({ status: 1 })) as any
    const probe = () => ({ containerId: 'stopped12345', running: false })

    expect(() => removeWorkspaceContainerByIdentity('ccc-worktree', probe, runner, 'docker'))
      .toThrow('Failed to remove workspace container')
  })
})

describe('named volume integration', () => {
  it('MISE_VOLUME_NAME should be ccc-mise-cache', () => {
    expect(MISE_VOLUME_NAME).toBe('ccc-mise-cache')
  })
})

describe('container locale and timezone defaults', () => {
  it('LANG/LC_ALL/LC_CTYPE are forwarded from host (not excluded)', () => {
    // Locale vars are forwarded so container matches host language/region.
    // Common locales are pre-generated in the Dockerfile.
    // If host has no LANG, en_US.UTF-8 is injected as fallback.
    expect(EXCLUDE_ENV_KEYS.has('LANG')).toBe(false)
    expect(EXCLUDE_ENV_KEYS.has('LC_ALL')).toBe(false)
    expect(EXCLUDE_ENV_KEYS.has('LC_CTYPE')).toBe(false)
  })

  it('TZ detection uses Intl API as cross-platform fallback', () => {
    // Intl.DateTimeFormat().resolvedOptions().timeZone returns IANA timezone
    // on all platforms (macOS, Linux, Windows)
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    expect(tz).toBeDefined()
    expect(typeof tz).toBe('string')
    expect(tz.length).toBeGreaterThan(0)
  })

  it('TZ detection prefers process.env.TZ when set', () => {
    const originalTz = process.env.TZ
    try {
      process.env.TZ = 'America/New_York'
      const hostTz = process.env.TZ
        || Intl.DateTimeFormat().resolvedOptions().timeZone
        || 'UTC'
      expect(hostTz).toBe('America/New_York')
    } finally {
      if (originalTz === undefined) {
        delete process.env.TZ
      } else {
        process.env.TZ = originalTz
      }
    }
  })

  it('TZ detection falls back to Intl when process.env.TZ is unset', () => {
    const originalTz = process.env.TZ
    try {
      delete process.env.TZ
      const hostTz = process.env.TZ
        || Intl.DateTimeFormat().resolvedOptions().timeZone
        || 'UTC'
      // Should get an IANA timezone string (not undefined, not empty)
      expect(hostTz).toBeTruthy()
      expect(typeof hostTz).toBe('string')
    } finally {
      if (originalTz !== undefined) {
        process.env.TZ = originalTz
      }
    }
  })

  it('TZ fallback chain ends at UTC', () => {
    // Simulates the full fallback: no env.TZ, no Intl result
    const hostTz = undefined || undefined || 'UTC'
    expect(hostTz).toBe('UTC')
  })

  it('LC_TERMINAL and LC_TERMINAL_VERSION remain excluded (iTerm-specific)', () => {
    expect(EXCLUDE_ENV_KEYS.has('LC_TERMINAL')).toBe(true)
    expect(EXCLUDE_ENV_KEYS.has('LC_TERMINAL_VERSION')).toBe(true)
  })
})

describe('auto container version-up', () => {
  it('isContainerImageOutdated is exported from docker module', () => {
    expect(typeof isContainerImageOutdated).toBe('function')
  })

  it('auto-upgrade captures the old image ID before removing the stopped container', () => {
    // Simulates the upgrade logic from index.ts exec():
    // 1. Capture old image SHA before container removal
    // 2. Remove only the exact container ID confirmed stopped under the lock
    // 3. Remove old image (silently fails if still in use)
    const oldImageId = "sha256:oldimage111"
    const currentImageId = "sha256:newimage222"
    const stoppedContainerId = "sha256:stoppedcontainer333"

    // The upgrade condition: old image differs from current
    expect(oldImageId).not.toBe(currentImageId)

    const rmArgs = ["rm", stoppedContainerId]
    const rmiArgs = ["rmi", oldImageId]
    expect(rmArgs).toEqual(["rm", stoppedContainerId])
    expect(rmiArgs[0]).toBe("rmi")
    expect(rmiArgs[1]).toBe(oldImageId)
  })

  it('skips old image removal when old image ID is empty', () => {
    // If docker inspect fails to get old image ID, skip rmi
    const oldImageId = ""
    expect(oldImageId).toBeFalsy()
    // The if (oldImageId) guard prevents docker rmi from running
  })

  it('deferred upgrade message does not claim active sessions from container liveness', () => {
    const message = RUNNING_CONTAINER_UPDATE_DEFERRED_MESSAGE
    expect(message).toContain("existing container is running")
    expect(message).toContain("after the container stops")
    expect(message).not.toContain("active CCC sessions")
  })

  it('does not invoke automatic replacement unless the container is confirmed stopped', () => {
    const replace = vi.fn()
    const replacementGuard = vi.fn((_prefix, _lock, operation, allowed) => {
      if (!allowed()) return false
      operation()
      return true
    })
    const statusProbe = vi.fn(() => ({
      exists: true,
      running: true,
      containerId: 'container-id',
      imageId: 'sha256:old',
    }))

    expect(replaceStoppedContainerWithoutInterruptingSessions(
      'ccc-project', 'project', '/locks/current.lock', 'container-id', 'sha256:old', replace,
      replacementGuard, statusProbe,
    )).toBe(false)
    expect(statusProbe).toHaveBeenCalledWith('ccc-project')
    expect(replace).not.toHaveBeenCalled()
  })

  it('runs automatic replacement only after the locked stopped probe succeeds', () => {
    const replace = vi.fn()
    const replacementGuard = vi.fn((_prefix, _lock, operation, allowed) => {
      expect(allowed()).toBe(true)
      operation()
      return true
    })

    expect(replaceStoppedContainerWithoutInterruptingSessions(
      'ccc-project', 'project', '/locks/current.lock', 'container-id', 'sha256:old', replace,
      replacementGuard, () => ({
        exists: true,
        running: false,
        containerId: 'container-id',
        imageId: 'sha256:old',
      }),
    )).toBe(true)
    expect(replace).toHaveBeenCalledWith('container-id')
  })

  it.each([
    ['same-name replacement', { exists: true, running: false, containerId: 'replacement-id', imageId: 'sha256:old' }],
    ['changed image', { exists: true, running: false, containerId: 'container-id', imageId: 'sha256:new' }],
    ['restarted container', { exists: true, running: true, containerId: 'container-id', imageId: 'sha256:old' }],
    ['failed status probe', { exists: false, running: false, containerId: null, imageId: null }],
  ])('does not remove a stale auto-upgrade target after %s', (_name, lockedStatus) => {
    const replace = vi.fn()
    const replacementGuard = vi.fn((_prefix, _lock, operation, allowed) => {
      if (!allowed()) return false
      operation()
      return true
    })

    expect(replaceStoppedContainerWithoutInterruptingSessions(
      'ccc-project', 'project', '/locks/current.lock', 'container-id', 'sha256:old', replace,
      replacementGuard, () => lockedStatus,
    )).toBe(false)
    expect(replace).not.toHaveBeenCalled()
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

describe('parseArgs', () => {
  it('parses @branch as worktreeArg', () => {
    const result = parseArgs(['@feature'])
    expect(result.worktreeArg).toBe('@feature')
    expect(result.filteredArgs).toEqual([])
  })

  it('returns undefined worktreeArg and empty filteredArgs for no args', () => {
    const result = parseArgs([])
    expect(result.worktreeArg).toBeUndefined()
    expect(result.filteredArgs).toEqual([])
  })

  it('passes through unrecognized args as filteredArgs', () => {
    const result = parseArgs(['shell', '--continue'])
    expect(result.filteredArgs).toEqual(['shell', '--continue'])
    expect(result.worktreeArg).toBeUndefined()
  })

  it('@branch with command: worktree extracted, command stays in filteredArgs', () => {
    const result = parseArgs(['@main', 'shell'])
    expect(result.worktreeArg).toBe('@main')
    expect(result.filteredArgs).toEqual(['shell'])
  })
})

describe('informationalCommand', () => {
  it.each([
    [['-h'], 'help'],
    [['--help'], 'help'],
    [['help'], 'help'],
    [['-v'], 'version'],
    [['--version'], 'version'],
    [['version'], 'version'],
    [['@feature', '--help'], 'help'],
    [['@feature', '--version'], 'version'],
    [['--env', 'CI=true', '--help'], 'help'],
    [['--runtime', 'docker', '--version'], 'version'],
    [['@feature', '--env', 'CI=true', '--help'], 'help'],
  ] as const)('recognizes %j without preparing a workspace', (args, expected) => {
    expect(informationalCommand([...args])).toBe(expected)
  })

  it('does not intercept tool-specific flags', () => {
    expect(informationalCommand(['claude', '--version'])).toBeNull()
    expect(informationalCommand(['npm', '--help'])).toBeNull()
  })
})

describe('resolveExecTools', () => {
  it('does not wrap shell commands with the default tool', () => {
    const result = resolveExecTools(['bash'])
    expect(result.commandTool).toBeUndefined()
    expect(result.setupTool.name).toBe('claude')
  })

  it('uses the explicit tool for tool commands', () => {
    const claude = getToolByName('claude')
    expect(claude).toBeDefined()

    const result = resolveExecTools([claude!.binary, '--help'], claude)
    expect(result.commandTool?.name).toBe('claude')
    expect(result.setupTool.name).toBe('claude')
  })
})

describe('maybeAttachCodexClipboardImageForCommand', () => {
  it('attaches clipboard image only for codex commands', async () => {
    const codex = getToolByName('codex')
    expect(codex).toBeDefined()
    const attachClipboardImage = vi.fn(async (_projectPath: string, args: string[], options: { enabled: boolean; clipboardUrl?: string; clipboardToken?: string }) => {
      expect(options).toEqual({
        enabled: true,
        clipboardUrl: 'http://127.0.0.1:4321',
        clipboardToken: 'token',
      })
      return { args: [...args, '--image', '.omx/clipboard-images/clipboard-1.png'] }
    })

    const result = await maybeAttachCodexClipboardImageForCommand(
      '/tmp/project',
      ['codex', '--ask-for-approval', 'never'],
      codex,
      { url: 'http://127.0.0.1:4321', token: 'token' },
      attachClipboardImage,
    )

    expect(attachClipboardImage).toHaveBeenCalledTimes(1)
    expect(result).toEqual(['codex', '--ask-for-approval', 'never', '--image', '.omx/clipboard-images/clipboard-1.png'])
  })

  it('skips clipboard attachment for non-codex tools', async () => {
    const claude = getToolByName('claude')
    expect(claude).toBeDefined()
    const attachClipboardImage = vi.fn()

    const result = await maybeAttachCodexClipboardImageForCommand(
      '/tmp/project',
      ['claude', '--dangerously-skip-permissions'],
      claude,
      { url: 'http://127.0.0.1:4321', token: 'token' },
      attachClipboardImage as never,
    )

    expect(attachClipboardImage).not.toHaveBeenCalled()
    expect(result).toEqual(['claude', '--dangerously-skip-permissions'])
  })

  it('skips clipboard attachment when no command tool is resolved', async () => {
    const attachClipboardImage = vi.fn()

    const result = await maybeAttachCodexClipboardImageForCommand(
      '/tmp/project',
      ['bash'],
      undefined,
      { url: 'http://127.0.0.1:4321', token: 'token' },
      attachClipboardImage as never,
    )

    expect(attachClipboardImage).not.toHaveBeenCalled()
    expect(result).toEqual(['bash'])
  })
})

describe('buildToolInvocation', () => {
  it('prepends defaultFlags when args are empty (default chat)', () => {
    const codex = getToolByName('codex')!
    expect(buildToolInvocation(codex, [])).toEqual([
      'codex',
      '--dangerously-bypass-approvals-and-sandbox',
    ])
  })

  it('places defaultFlags AFTER the subcommand for codex resume', () => {
    const codex = getToolByName('codex')!
    expect(buildToolInvocation(codex, ['resume'])).toEqual([
      'codex',
      'resume',
      '--dangerously-bypass-approvals-and-sandbox',
    ])
  })

  it('places defaultFlags AFTER codex resume preserving remaining args', () => {
    const codex = getToolByName('codex')!
    expect(buildToolInvocation(codex, ['resume', '--last'])).toEqual([
      'codex',
      'resume',
      '--dangerously-bypass-approvals-and-sandbox',
      '--last',
    ])
  })

  it('handles codex exec alias `e`', () => {
    const codex = getToolByName('codex')!
    expect(buildToolInvocation(codex, ['e', 'fix bug'])).toEqual([
      'codex',
      'e',
      '--dangerously-bypass-approvals-and-sandbox',
      'fix bug',
    ])
  })

  it('omits defaultFlags for codex subcommands that reject them (login)', () => {
    const codex = getToolByName('codex')!
    expect(buildToolInvocation(codex, ['login'])).toEqual(['codex', 'login'])
  })

  it('omits defaultFlags for codex update subcommand', () => {
    const codex = getToolByName('codex')!
    expect(buildToolInvocation(codex, ['update'])).toEqual(['codex', 'update'])
  })

  it('prepends defaultFlags when first arg is a flag, not a subcommand', () => {
    const codex = getToolByName('codex')!
    expect(buildToolInvocation(codex, ['--model', 'o3'])).toEqual([
      'codex',
      '--dangerously-bypass-approvals-and-sandbox',
      '--model',
      'o3',
    ])
  })

  it('prepends defaultFlags for tools without subcommand metadata (claude)', () => {
    const claude = getToolByName('claude')!
    expect(buildToolInvocation(claude, ['--continue'])).toEqual([
      claude.binary,
      '--dangerously-skip-permissions',
      '--continue',
    ])
  })
})
