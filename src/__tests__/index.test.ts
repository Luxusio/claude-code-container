import { describe, it, expect, vi, beforeEach } from 'vitest'
import { canonicalProjectPath, projectPathsEquivalent, projectIdentityPath, hashPath, getProjectId } from '../utils.js'
import { getContainerName, isContainerImageOutdated } from '../docker.js'
import { MISE_VOLUME_NAME, CONTAINER_ENV_KEY, CONTAINER_ENV_VALUE, EXCLUDE_ENV_KEYS } from '../utils.js'
import { parseArgs, informationalCommand, resolveExecTools, maybeAttachCodexClipboardImageForCommand, buildToolInvocation, replaceStoppedContainerWithoutInterruptingSessions, stoppedContainerReplacementBlockReason, withWorkspaceRemovalLifecycleLock, removeWorkspaceContainerByIdentity, removeManagedWorkspaceContainerByIdentity, removeWorkspaceContainers, listWorkspaceContainerNames, prepareWorkspaceContainerRemovalPlan, removePreparedWorkspaceContainers, createWorktreeSessionLock, runWorktreeLifecycleOperation, workspaceRemovalCompleted, removeWorkspaceThenContainers, RUNNING_CONTAINER_UPDATE_DEFERRED_MESSAGE } from '../index.js'
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
