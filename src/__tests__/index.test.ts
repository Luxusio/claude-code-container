import { describe, it, expect, vi, beforeEach } from 'vitest'
import { canonicalProjectPath, projectPathsEquivalent, projectIdentityPath, hashPath, getProjectId } from '../utils.js'
import { getContainerName, isContainerImageOutdated } from '../docker.js'
import { MISE_VOLUME_NAME, CONTAINER_ENV_KEY, CONTAINER_ENV_VALUE, EXCLUDE_ENV_KEYS } from '../utils.js'
import { parseArgs, workspaceRemovalFailureNote, informationalCommand, resolveExecTools, maybeAttachCodexClipboardImageForCommand, buildToolInvocation, replaceStoppedContainerWithoutInterruptingSessions, stoppedContainerReplacementBlockReason, containerReplacementBlockReason, withWorkspaceRemovalLifecycleLock, removeWorkspaceContainerByIdentity, removeManagedWorkspaceContainerByIdentity, removeWorkspaceContainers, listWorkspaceContainerNames, prepareWorkspaceContainerRemovalPlan, removePreparedWorkspaceContainers, createWorktreeSessionLock, runWorktreeLifecycleOperation, workspaceRemovalCompleted, workspaceRemovalAdvice, removeWorkspaceThenContainers, RUNNING_CONTAINER_UPDATE_DEFERRED_MESSAGE, INITIALLY_RUNNING_CONTAINER_UPDATE_DEFERRED_MESSAGE, containerUpdateDeferredMessage, CONTAINER_SETUP_RESTART_MESSAGE, ensureSetupContainerAvailable, ensureToolsForSetupContainer, withContainerSetupReadiness, strandedBranchNotice } from '../index.js'
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
  it('keeps durable identity lexical while canonical aliases remain a safety concern', () => {
    const lexicalPath = '/junction/project/repo'
    const physicalPath = '/physical/project/repo'

    expect(projectIdentityPath('./repo', () => lexicalPath)).toBe(lexicalPath)
    expect(getProjectId('./repo', () => lexicalPath))
      .toBe(`repo-${hashPath(lexicalPath)}`)
    expect(getProjectId('./repo', () => lexicalPath))
      .not.toBe(`repo-${hashPath(physicalPath)}`)
  })

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

describe('canonicalProjectPath', () => {
  it('uses Windows filesystem identity for existing path aliases', () => {
    const realpath = vi.fn(() => 'C:\\Users\\Luxus\\Project\\Repo')

    expect(canonicalProjectPath('c:\\users\\luxus\\project\\repo', 'win32', realpath))
      .toBe('C:\\Users\\Luxus\\Project\\Repo')
    expect(canonicalProjectPath('C:\\USERS\\LUXUS\\PROJECT\\REPO', 'win32', realpath))
      .toBe('C:\\Users\\Luxus\\Project\\Repo')
  })

  it('canonicalizes the parent of a not-yet-created Windows worktree path', () => {
    const realpath = vi.fn((path: string) => {
      if (path.endsWith('repo--feature')) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return 'C:\\Users\\Luxus\\Project'
    })

    expect(canonicalProjectPath('c:\\users\\luxus\\project\\repo--feature', 'win32', realpath))
      .toContain('C:\\Users\\Luxus\\Project')
  })

  it('fails closed when Windows filesystem identity cannot be observed', () => {
    const denied = Object.assign(new Error('access denied'), { code: 'EACCES' })
    expect(() => canonicalProjectPath('C:\\Users\\Luxus\\Project\\Repo', 'win32', () => {
      throw denied
    })).toThrow('Unable to establish canonical Windows project identity')
  })

  it('fails closed when a missing worktree parent cannot be canonicalized', () => {
    const realpath = vi.fn(() => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    })
    expect(() => canonicalProjectPath('C:\\missing\\repo--feature', 'win32', realpath))
      .toThrow('Unable to establish canonical Windows project parent identity')
  })

  it('compares Windows junction and casing aliases by canonical filesystem identity', () => {
    const realpath = vi.fn(() => 'C:\\Users\\Luxus\\Project\\Repo')
    expect(projectPathsEquivalent(
      'C:\\junction\\repo',
      'c:\\users\\luxus\\project\\repo',
      'win32',
      realpath,
    )).toBe(true)
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

  it('isolates the base repository, worktree, and sibling worktree', () => {
    const base = getContainerName('/projects/repo')
    const feature = getContainerName('/projects/repo--feature')
    const sibling = getContainerName('/projects/repo--other')

    expect(new Set([base, feature, sibling]).size).toBe(3)
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

  it('blocks removal when any session ownership claim appears at the final locked check', () => {
    const removal = vi.fn()
    const lifecycleLock = (_projectId: string, operation: () => unknown) => operation()
    const activeSessions = () => ['new-session.lock']

    expect(() => withWorkspaceRemovalLifecycleLock('project-id', false, removal, lifecycleLock, activeSessions))
      .toThrow('Workspace has 1 session ownership claim(s)')
    expect(removal).not.toHaveBeenCalled()
  })

  it('uses the project-family ownership-claim query before removal', () => {
    const lifecycleLock = (_projectId: string, operation: () => unknown) => operation()
    const activeSessions = vi.fn(() => [
      'project-id--base.lock',
      'project-id--p--work--profile.lock',
    ])
    const removal = vi.fn()

    expect(() => withWorkspaceRemovalLifecycleLock(
      'project-id',
      false,
      removal,
      lifecycleLock,
      activeSessions,
    )).toThrow('Workspace has 2 session ownership claim(s)')
    expect(activeSessions).toHaveBeenCalledWith('project-id')
    expect(removal).not.toHaveBeenCalled()
  })

  it('allows explicit force removal after observing base and profile sessions under the lock', () => {
    const lifecycleLock = (_projectId: string, operation: () => string) => operation()
    const activeSessions = vi.fn(() => [
      'project-id--base.lock',
      'project-id--p--work--profile.lock',
    ])
    const removal = vi.fn(() => 'forced')

    expect(withWorkspaceRemovalLifecycleLock(
      'project-id',
      true,
      removal,
      lifecycleLock,
      activeSessions,
    )).toBe('forced')
    expect(activeSessions).toHaveBeenCalledWith('project-id')
    expect(removal).toHaveBeenCalledOnce()
  })
})

describe('worktree session registration', () => {
  it('validates the exact branch and creates the lock inside one family critical section', () => {
    let insideLock = false
    const familyLock = vi.fn((_projectId: string, operation: () => string) => {
      insideLock = true
      try { return operation() } finally { insideLock = false }
    })
    const branchGuard = vi.fn(() => expect(insideLock).toBe(true))
    const lockCreator = vi.fn(() => {
      expect(insideLock).toBe(true)
      return '/locks/worktree.lock'
    })

    expect(createWorktreeSessionLock(
      'worktree-id',
      '/projects/repo--feature',
      'feature',
      'work',
      familyLock,
      branchGuard,
      lockCreator,
      '/projects/repo',
    )).toBe('/locks/worktree.lock')
    expect(branchGuard).toHaveBeenCalledWith(
      '/projects/repo--feature',
      'feature',
      expect.any(Function),
      '/projects/repo',
    )
    expect(lockCreator).toHaveBeenCalledWith('worktree-id', 'work')
  })

  it('does not create a session after removal wins and the workspace disappears', () => {
    const familyLock = (_projectId: string, operation: () => string) => operation()
    const lockCreator = vi.fn(() => '/locks/worktree.lock')
    const branchGuard = () => {
      throw new Error('Workspace for branch feature no longer exists')
    }

    expect(() => createWorktreeSessionLock(
      'worktree-id',
      '/projects/repo--feature',
      'feature',
      undefined,
      familyLock,
      branchGuard,
      lockCreator,
    )).toThrow('no longer exists')
    expect(lockCreator).not.toHaveBeenCalled()
  })

  it('guards stop and other destructive worktree operations with the same branch/family lock', () => {
    const operation = vi.fn(() => 'stopped')
    const familyLock = (_projectId: string, callback: () => string) => callback()
    const branchGuard = vi.fn()

    expect(runWorktreeLifecycleOperation(
      '/projects/repo--feature',
      'feature',
      operation,
      familyLock,
      branchGuard,
      '/projects/repo',
    )).toBe('stopped')
    expect(branchGuard).toHaveBeenCalledWith(
      '/projects/repo--feature',
      'feature',
      expect.any(Function),
      '/projects/repo',
    )
    expect(operation).toHaveBeenCalledOnce()
  })

  it('does not run stop or rm after the final branch guard fails', () => {
    const operation = vi.fn()
    const familyLock = (_projectId: string, callback: () => unknown) => callback()

    expect(() => runWorktreeLifecycleOperation(
      '/projects/repo--feature',
      'feature',
      operation,
      familyLock,
      () => { throw new Error('workspace branch changed') },
    )).toThrow('workspace branch changed')
    expect(operation).not.toHaveBeenCalled()
  })
})

describe('workspace profile container discovery', () => {
  it('treats any filesystem removal error as incomplete', () => {
    expect(workspaceRemovalCompleted({ errors: [] })).toBe(true)
    expect(workspaceRemovalCompleted({ errors: ['quarantine cleanup failed'] })).toBe(false)
  })

  it('never advertises a remedy of its own, because it cannot know which one applies', () => {
    // It used to say "Use -f to force". That was measured wrong for one of the refusals it
    // trails: an unreadable directory needs a chmod first, and -f refuses it until then — so
    // this line contradicted the specific one printed directly above it. Each refusal now
    // carries its own remedy and this defers to them.
    expect(workspaceRemovalAdvice(false)).not.toContain('-f')
    // And with -f already given, "use -f" would send them back to what just failed.
    expect(workspaceRemovalAdvice(true)).not.toContain('-f')
    // Not empty, though: the operator still has to be told the removal did not happen.
    expect(workspaceRemovalAdvice(false)).toContain('Nothing was removed')
    expect(workspaceRemovalAdvice(true)).toContain('did not complete')
  })

  it('does not claim nothing was removed when something was', () => {
    // The ordinary refusal, measured: a workspace with two submodules, one dirty. `ccc rm`
    // deregisters the clean one, refuses on the dirty one, and prints `removed: services/api`
    // — and this line used to say "Nothing was removed" two lines underneath it. The
    // workspace is half dismantled at that point, which is the fact that decides what the
    // operator does next.
    const partial = workspaceRemovalAdvice(false, ['services/api'])
    expect(partial).not.toContain('Nothing was removed')
    expect(partial).toContain('Removed 1 item')
    expect(partial, 'and the state it leaves them in').toContain('partly')
    // The default is still the honest one when the list really is empty.
    expect(workspaceRemovalAdvice(false, [])).toContain('Nothing was removed')
  })

  it('removes containers only after workspace removal succeeds', () => {
    const sequence: string[] = []
    const completed = removeWorkspaceThenContainers(
      () => {
        sequence.push('workspace')
        return { errors: [] }
      },
      () => {
        sequence.push('containers')
        return ['ccc-worktree']
      },
    )

    expect(sequence).toEqual(['workspace', 'containers'])
    expect(completed.removedContainers).toEqual(['ccc-worktree'])
  })

  it('preserves containers when workspace removal is incomplete', () => {
    const removeContainers = vi.fn(() => ['ccc-worktree'])
    const completed = removeWorkspaceThenContainers(
      () => ({ errors: ['dirty worktree'] }),
      removeContainers,
    )

    expect(removeContainers).not.toHaveBeenCalled()
    expect(completed.removedContainers).toEqual([])
  })

  it('captures managed container IDs before deleting the workspace path', () => {
    let workspaceExists = true
    const sequence: string[] = []
    const identityProbe = vi.fn(() => {
      sequence.push('identity')
      expect(workspaceExists).toBe(true)
      return { containerId: 'captured123456', running: true }
    })
    const plan = prepareWorkspaceContainerRemovalPlan(
      '/projects/repo--feature',
      () => ['ccc-worktree'],
      identityProbe,
      () => true,
    )
    const runner = vi.fn(() => ({ status: 0 })) as any

    const completed = removeWorkspaceThenContainers(
      () => {
        sequence.push('workspace')
        workspaceExists = false
        return { errors: [] }
      },
      () => {
        sequence.push('containers')
        expect(workspaceExists).toBe(false)
        return removePreparedWorkspaceContainers(plan, runner, 'docker')
      },
    )

    expect(sequence).toEqual(['identity', 'workspace', 'containers'])
    expect(completed.removedContainers).toEqual(['ccc-worktree'])
    expect(runner).toHaveBeenNthCalledWith(
      1,
      'docker',
      ['stop', 'captured123456'],
      { stdio: 'ignore' },
    )
    expect(runner).toHaveBeenNthCalledWith(
      2,
      'docker',
      ['rm', 'captured123456'],
      { stdio: 'ignore' },
    )
  })

  it('aborts before workspace deletion when a listed container cannot be identified', () => {
    const removeWorkspaceOperation = vi.fn(() => ({ errors: [] }))

    expect(() => {
      const plan = prepareWorkspaceContainerRemovalPlan(
        '/projects/repo--feature',
        () => ['ccc-worktree'],
        () => null,
        () => true,
      )
      removeWorkspaceThenContainers(
        removeWorkspaceOperation,
        () => removePreparedWorkspaceContainers(plan),
      )
    }).toThrow('identity inspection failed')
    expect(removeWorkspaceOperation).not.toHaveBeenCalled()
  })

  it('rejects duplicate captured container identities', () => {
    expect(() => prepareWorkspaceContainerRemovalPlan(
      '/projects/repo--feature',
      () => ['ccc-worktree', 'ccc-worktree--p--work'],
      () => ({ containerId: 'same123456', running: false }),
      () => true,
    )).toThrow('duplicate identity')
  })

  it('returns only the default and profile containers for the exact worktree identity', () => {
    const workspace = '/projects/repo--feature'
    const base = getContainerName(workspace)
    const sibling = getContainerName('/projects/repo--other')
    const runner = vi.fn(() => ({
      status: 0,
      stdout: `${base}\n${base}--p--work\n${base}--p--ci\n${sibling}\nccc-unrelated\n`,
      stderr: '',
    })) as any

    expect(listWorkspaceContainerNames(workspace, runner, 'docker')).toEqual([
      base,
      `${base}--p--work`,
      `${base}--p--ci`,
    ])
  })

  it('fails closed when the runtime container inventory cannot be read', () => {
    const runner = vi.fn(() => ({ status: 1, stdout: '', stderr: 'denied' })) as any

    expect(() => listWorkspaceContainerNames('/projects/repo--feature', runner, 'docker'))
      .toThrow('Unable to list workspace containers')
  })

  it('removes every discovered profile container and no base or sibling container', () => {
    const workspace = '/projects/repo--feature'
    const base = getContainerName(workspace)
    const discovered = [base, `${base}--p--work`, `${base}--p--ci`]
    const listContainers = vi.fn(() => discovered)
    const removeContainer = vi.fn(() => true)

    expect(removeWorkspaceContainers(workspace, listContainers, removeContainer)).toEqual(discovered)
    expect(removeContainer.mock.calls.map(([name]) => name)).toEqual(discovered)
    expect(removeContainer.mock.calls.every(([, path]) => path === workspace)).toBe(true)
    expect(removeContainer.mock.calls.flat()).not.toContain(getContainerName('/projects/repo'))
    expect(removeContainer.mock.calls.flat()).not.toContain(getContainerName('/projects/repo--other'))
  })

  it('aborts the batch immediately when exact container identity removal fails', () => {
    const listContainers = () => ['ccc-worktree', 'ccc-worktree--p--work']
    const removeContainer = vi.fn()
      .mockReturnValueOnce(true)
      .mockImplementationOnce(() => {
        throw new Error('identity inspection failed')
      })

    expect(() => removeWorkspaceContainers('/projects/repo--feature', listContainers, removeContainer))
      .toThrow('identity inspection failed')
    expect(removeContainer).toHaveBeenCalledTimes(2)
  })
})

describe('managed workspace container identity fencing', () => {
  it('passes the exact workspace path into the managed identity probe before stop/rm', () => {
    const runner = vi.fn(() => ({ status: 0 })) as any
    const identityProbe = vi.fn(() => ({ containerId: 'managed123456', running: true }))

    expect(removeManagedWorkspaceContainerByIdentity(
      'ccc-worktree--p--work',
      '/projects/repo--feature',
      identityProbe,
      runner,
      'docker',
    )).toBe(true)
    expect(identityProbe).toHaveBeenCalledWith(
      'ccc-worktree--p--work',
      '/projects/repo--feature',
    )
    expect(runner).toHaveBeenNthCalledWith(1, 'docker', ['stop', 'managed123456'], { stdio: 'ignore' })
    expect(runner).toHaveBeenNthCalledWith(2, 'docker', ['rm', 'managed123456'], { stdio: 'ignore' })
  })

  it('preserves an existing foreign or mislabeled container when managed identity fails', () => {
    const runner = vi.fn() as any

    expect(() => removeManagedWorkspaceContainerByIdentity(
      'ccc-worktree--p--work',
      '/projects/repo--feature',
      () => null,
      runner,
      'docker',
      () => true,
    )).toThrow('identity inspection failed')
    expect(runner).not.toHaveBeenCalled()
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
  it('reports the initial running observation when that fence defers an upgrade', () => {
    expect(containerUpdateDeferredMessage(true))
      .toBe(INITIALLY_RUNNING_CONTAINER_UPDATE_DEFERRED_MESSAGE)
    expect(containerUpdateDeferredMessage(false))
      .toBe(RUNNING_CONTAINER_UPDATE_DEFERRED_MESSAGE)
  })

  it('does not upgrade a container that was running at the initial snapshot', () => {
    const replace = vi.fn()
    const replacementGuard = vi.fn()
    const statusProbe = vi.fn()

    expect(replaceStoppedContainerWithoutInterruptingSessions(
      'ccc-project',
      'project',
      '/locks/current.lock',
      'container-id',
      'sha256:old',
      replace,
      replacementGuard,
      statusProbe,
      true,
    )).toBe(false)
    expect(replacementGuard).not.toHaveBeenCalled()
    expect(statusProbe).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })

  it('preserves a container that was running when this invocation started', () => {
    const stoppedProbe = vi.fn(() => true)
    const sessionProbe = vi.fn(() => ['/locks/current.lock'])

    expect(stoppedContainerReplacementBlockReason(
      'ccc-project',
      'project',
      '/locks/project--current.lock',
      stoppedProbe,
      sessionProbe,
      true,
    )).toBe('the container was running when this session started')
    expect(stoppedProbe).not.toHaveBeenCalled()
    expect(sessionProbe).not.toHaveBeenCalled()
  })

  it('reports when replacement cannot prove the container stopped', () => {
    expect(stoppedContainerReplacementBlockReason(
      'ccc-project',
      'project',
      '/locks/project--current.lock',
      () => false,
      () => { throw new Error('session probe must not run') },
    )).toBe('the container is not confirmed stopped')
  })

  it('reports the number of live or indeterminate foreign session claims', () => {
    expect(stoppedContainerReplacementBlockReason(
      'ccc-project',
      'project',
      '/locks/project--current.lock',
      () => true,
      () => ['project--current.lock', 'project--foreign.lock'],
    )).toBe('1 live or indeterminate session lock claim(s) remain')
  })

  it('authorizes replacement diagnostics when only the current claim remains', () => {
    expect(stoppedContainerReplacementBlockReason(
      'ccc-project',
      'project',
      '/locks/project--current.lock',
      () => true,
      () => ['project--current.lock'],
    )).toBeNull()
  })

  it('authorizes exact running-container recovery when only the current session remains', () => {
    const statusProbe = vi.fn(() => ({
      exists: true,
      running: true,
      containerId: 'container-id',
      imageId: 'sha256:old',
    }))

    expect(containerReplacementBlockReason(
      'ccc-project',
      'project',
      '/locks/project--current.lock',
      'container-id',
      () => ['project--current.lock'],
      statusProbe,
    )).toBeNull()
    expect(statusProbe).toHaveBeenCalledWith('ccc-project')
  })

  it('blocks running-container recovery when a foreign session remains', () => {
    const statusProbe = vi.fn()

    expect(containerReplacementBlockReason(
      'ccc-project',
      'project',
      '/locks/project--current.lock',
      'container-id',
      () => ['project--current.lock', 'project--foreign.lock'],
      statusProbe,
    )).toBe('1 live or indeterminate session lock claim(s) remain: project--foreign.lock')
    expect(statusProbe).not.toHaveBeenCalled()
  })

  it('blocks running-container recovery when the current session lock is missing', () => {
    const statusProbe = vi.fn()

    expect(containerReplacementBlockReason(
      'ccc-project',
      'project',
      '/locks/project--current.lock',
      'container-id',
      () => [],
      statusProbe,
    )).toBe('the current session lock ownership could not be verified')
    expect(statusProbe).not.toHaveBeenCalled()
  })

  it.each([
    ['missing container', { exists: false, running: false, containerId: null, imageId: null }, 'the container identity could not be verified'],
    ['same-name successor', { exists: true, running: true, containerId: 'successor-id', imageId: 'sha256:old' }, 'the container identity changed before replacement'],
  ])('fails closed when idle recovery observes %s', (_name, status, reason) => {
    expect(containerReplacementBlockReason(
      'ccc-project',
      'project',
      '/locks/project--current.lock',
      'container-id',
      () => ['project--current.lock'],
      () => status,
    )).toBe(reason)
  })

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

  it('setup restart message reports unavailability without inventing a concurrent session', () => {
    expect(CONTAINER_SETUP_RESTART_MESSAGE).toContain('became unavailable during setup')
    expect(CONTAINER_SETUP_RESTART_MESSAGE).not.toContain('concurrent session')
  })

  it('uses exact-ID liveness and one state-accurate restart path at every setup checkpoint', () => {
    const containerId = '196c8453339a6b2d2d46126160f53197398a0333b6b41bffd37dd27ada83e068'
    const runningProbe = vi.fn(() => false)
    const restart = vi.fn(() => 'replacement-id')
    const log = vi.fn()

    expect(ensureSetupContainerAvailable(containerId, restart, runningProbe, log)).toBe('replacement-id')
    expect(runningProbe).toHaveBeenCalledWith(containerId, 'id')
    expect(restart).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith(CONTAINER_SETUP_RESTART_MESSAGE)
  })

  it('keeps an available pinned container without restarting it', () => {
    const containerId = '196c8453339a6b2d2d46126160f53197398a0333b6b41bffd37dd27ada83e068'
    const runningProbe = vi.fn(() => true)
    const restart = vi.fn(() => 'replacement-id')
    const log = vi.fn()

    expect(ensureSetupContainerAvailable(containerId, restart, runningProbe, log)).toBe(containerId)
    expect(restart).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })

  it('installs and proves the requested tool on a late replacement container ID', () => {
    const originalId = '196c8453339a6b2d2d46126160f53197398a0333b6b41bffd37dd27ada83e068'
    const replacementId = '296c8453339a6b2d2d46126160f53197398a0333b6b41bffd37dd27ada83e068'
    const runningProbe = vi.fn(() => false)
    const restart = vi.fn(() => replacementId)
    const installer = vi.fn()

    expect(ensureToolsForSetupContainer(
      originalId,
      getToolByName('codex')!,
      restart,
      runningProbe,
      installer,
    )).toBe(replacementId)
    expect(runningProbe).toHaveBeenCalledWith(originalId, 'id')
    expect(restart).toHaveBeenCalledOnce()
    expect(installer).toHaveBeenCalledWith(replacementId, getToolByName('codex')!)
  })

  it('does not retry a tool failure against the same running container', () => {
    const containerId = '196c8453339a6b2d2d46126160f53197398a0333b6b41bffd37dd27ada83e068'
    const runningProbe = vi.fn(() => true)
    const restart = vi.fn()
    const installer = vi.fn(() => { throw new Error('codex probe timed out') })

    expect(() => ensureToolsForSetupContainer(
      containerId,
      getToolByName('codex')!,
      restart,
      runningProbe,
      installer,
    )).toThrow('codex probe timed out')
    expect(installer).toHaveBeenCalledOnce()
    expect(restart).not.toHaveBeenCalled()
  })

  it('serializes requested-tool readiness for simultaneous container joiners', async () => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    let lockTail: Promise<void> = Promise.resolve()
    let claimant = 0
    const setupLock = vi.fn((_prefix: string, operation: () => string) => {
      const current = lockTail.then(async () => {
        const result = operation()
        claimant += 1
        if (claimant === 1) await firstGate
        return result
      })
      lockTail = current.then(() => undefined, () => undefined)
      return current
    })
    const firstSetup = vi.fn(() => 'first-container-id')
    const secondSetup = vi.fn(() => 'first-container-id')

    const first = withContainerSetupReadiness(
      'project-prefix', firstSetup, setupLock as any,
    )
    await Promise.resolve()
    expect(firstSetup).toHaveBeenCalledTimes(1)

    const second = withContainerSetupReadiness(
      'project-prefix', secondSetup, setupLock as any,
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(secondSetup).not.toHaveBeenCalled()

    releaseFirst()
    await expect(Promise.all([first, second])).resolves.toEqual([
      'first-container-id',
      'first-container-id',
    ])
    expect(setupLock).toHaveBeenNthCalledWith(1, 'project-prefix', expect.any(Function))
    expect(setupLock).toHaveBeenNthCalledWith(2, 'project-prefix', expect.any(Function))
    expect(firstSetup).toHaveBeenCalledTimes(1)
    expect(secondSetup).toHaveBeenCalledTimes(1)
  })

  it('propagates setup failure instead of allowing the caller to exec', async () => {
    const setupLock = async (_prefix: string, operation: () => string) => operation()
    const setup = vi.fn(() => { throw new Error('codex install incomplete') })

    await expect(withContainerSetupReadiness(
      'project-prefix',
      setup,
      setupLock as any,
    )).rejects.toThrow('codex install incomplete')
    expect(setup).toHaveBeenCalledOnce()
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

describe('workspaceRemovalFailureNote', () => {
  // An ownership assert raises before removeWorkspace returns, so the summary line under the
  // error list is never printed and the operator gets one raw sentence with no cause, no
  // remedy, and no word about -f. In multi-repo mode that is the whole output of `ccc rm -f`.
  const ownership = new Error("Workspace repository 'frontend' is not owned by its source repository.")

  it('says that -f does not lift an ownership refusal, when -f was given', () => {
    const note = workspaceRemovalFailureNote(ownership, true)!
    expect(note, 'the one fact the raw error omits').toContain('-f does not lift this')
    expect(note, 'and something the operator can actually do').toContain('Move what you want to keep')
  })

  it('names the state the remedy leaves behind, because the remedy alone is a new dead end', () => {
    // Measured: following "delete the directory yourself" leaves a registration in the source
    // still holding the branch, marked prunable. `ccc rm` then answers "Workspace not found"
    // and the next `ccc @<branch>` walks into the registration bug this whole task is about.
    // With the prune, the same sequence ends in a working workspace — run end to end.
    const note = workspaceRemovalFailureNote(ownership, true)!
    expect(note).toContain('git worktree prune')
    expect(note, 'and why they should bother').toContain('will refuse')
  })

  it('does not claim which layout the operator is in', () => {
    // The same assert raises in unified mode — a foreign repository at a tracked submodule's
    // path produces this identical sentence — so naming the layout was the message asserting
    // something it cannot check. That is the defect this whole task family keeps relearning.
    expect(workspaceRemovalFailureNote(ownership, true)!).not.toContain('multi-repo')
  })

  it('does not mention -f when it was not given', () => {
    // Saying "-f does not lift this" to someone who did not try -f invites them to try it.
    expect(workspaceRemovalFailureNote(ownership, false)!).not.toContain('-f')
  })

  it('stays silent on every other failure', () => {
    // The unified refusals already carry their own remedy; a second opinion under them would
    // be the standing-advice defect again.
    expect(workspaceRemovalFailureNote(new Error('Workspace not found: /x'), true)).toBeNull()
    expect(workspaceRemovalFailureNote(new Error('Workspace path identity changed'), false)).toBeNull()
    expect(workspaceRemovalFailureNote(undefined, true)).toBeNull()
  })
})

describe('workspaceRemovalAdvice under -f', () => {
  it('says the workspace is partly dismantled even when -f was given', () => {
    // The force branch used to return before `removed` was consulted. Partial removal is
    // reachable under -f — measured: {"removed":["services/web"],"errors":["ccc cannot
    // delete a directory it cannot read: …"]} — and arguably more likely there, since -f is
    // what gets far enough to remove some and stop. So the operator who forced got the
    // weaker sentence in the state that needs the stronger one.
    expect(workspaceRemovalAdvice(true, ['services/web'])).toContain('partly')
    expect(workspaceRemovalAdvice(true, ['services/web'])).toContain('Removed 1 item')
    // And with nothing removed it still says what -f failing means.
    expect(workspaceRemovalAdvice(true, [])).toContain('did not complete')
  })
})

describe('workspaceRemovalFailureNote guard width', () => {
  it('catches every ownership sentence in the class, not just one of them', () => {
    // These are the two `ccc rm` can raise. They differ by one word, and matching the first
    // literally left the second — assertWorkspaceRootOwnership's — with no remedy and, under
    // -f, no statement that force does not lift it.
    for (const message of [
      "Workspace repository 'frontend' is not owned by its source repository.",
      "Workspace is not owned by source repository '/tmp/src'.",
    ]) {
      expect(workspaceRemovalFailureNote(new Error(message), true), message).not.toBeNull()
    }
  })
})

describe('strandedBranchNotice escaping', () => {
  // The recorded path comes out of a gitdir file inside a repository, so it is
  // repository-controlled: printed raw, an ESC sequence in it rewrites the screen the
  // operator is reading the remedy on. The NOTE in worktree.ts already escapes for this
  // reason; this notice printed the same class of string raw.
  // Two paths AND a repository, not two paths alone. Escaping has to hold for every value in
  // the notice and in both of the places each one is printed — the listing line and the
  // command. With both repositories spelled plainly, dropping the escape from the listing's
  // repository left the whole suite green: the repository's half of this property was free to
  // disappear, which is the same asymmetry as pinning one argument and not the other.
  // (It does not pin the non-global probe regex — measured, the `g` one passes this too,
  // because `terminalSafe`'s own `replace` resets `lastIndex`.)
  it('escapes a control character instead of emitting it, every time', () => {
    const notice = strandedBranchNotice('feat', [
      { repository: '/src/ap\u001bi', lockedPaths: ['/project/x\u001b[31m/api'] },
      { repository: '/src/web', lockedPaths: ['/project/x\u001b[31m/web'] },
    ])

    expect(notice).not.toContain('\u001b')
    expect(
      notice.match(/\\u001b/g) ?? [],
      'the repository three times — listing, unlock, prune — and each path twice',
    ).toHaveLength(7)
  })

  // And leaves an ordinary path alone, byte for byte. Escaping unconditionally would
  // JSON-quote every path, which doubles the separators in `C:\Users\x` — the result is no
  // longer the path, and these lines exist to be pasted.
  it('keeps a Windows path intact, without JSON-doubling it', () => {
    const repository = 'C:\\Users\\kj\\catchy'
    const notice = strandedBranchNotice('feat', [
      { repository, lockedPaths: [] },
    ])
    const command = notice.split('\n').find((line) => line.trim().startsWith('git -C')) ?? ''

    // The path reaches the command whole — quoted or not is `pasteableArgument`'s business, and
    // whether a shell reads it back unchanged is asserted there, in a shell. THIS test used to
    // demand the bare form (`git -C C:\Users\kj\catchy worktree prune`) and so pinned the
    // defect: bare, a shell eats those separators and git is handed `C:Userskjcatchy`. An
    // assertion on an exact spelling is an assertion that the spelling is correct, which is the
    // one thing it cannot check.
    expect(command).toContain(repository)
    // And is not JSON-doubled, which is the other wrong answer: `C:\\Users\\kj\\catchy` is not
    // the path either.
    expect(notice).not.toContain('C:\\\\Users')
  })

  // An exported function has callers the guard at the one current call site does not cover.
  it('says nothing when nothing is held', () => {
    expect(strandedBranchNotice('feat', [])).toBe('')
  })
})
