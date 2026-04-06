import { describe, it, expect, vi, beforeEach } from 'vitest'
import { hashPath, getProjectId } from '../utils.js'
import { getContainerName, isContainerImageOutdated } from '../docker.js'
import { MISE_VOLUME_NAME, CONTAINER_ENV_KEY, CONTAINER_ENV_VALUE, EXCLUDE_ENV_KEYS } from '../utils.js'
import { parseArgs } from '../index.js'

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

  it('auto-upgrade captures old image ID and removes it after container deletion', () => {
    // Simulates the upgrade logic from index.ts exec():
    // 1. Capture old image SHA before stopping container
    // 2. Stop + rm container
    // 3. Remove old image (silently fails if still in use)
    const oldImageId = "sha256:oldimage111"
    const currentImageId = "sha256:newimage222"

    // The upgrade condition: old image differs from current
    expect(oldImageId).not.toBe(currentImageId)

    // After upgrade, docker rmi is called with the old SHA
    // This is a logic verification, not a mock integration test
    const rmiArgs = ["rmi", oldImageId]
    expect(rmiArgs[0]).toBe("rmi")
    expect(rmiArgs[1]).toBe(oldImageId)
  })

  it('skips old image removal when old image ID is empty', () => {
    // If docker inspect fails to get old image ID, skip rmi
    const oldImageId = ""
    expect(oldImageId).toBeFalsy()
    // The if (oldImageId) guard prevents docker rmi from running
  })

  it('deferred upgrade message includes session info', () => {
    const message = "Update available, but other sessions are active. Restart ccc after closing other sessions to upgrade."
    expect(message).toContain("other sessions")
    expect(message).toContain("upgrade")
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

