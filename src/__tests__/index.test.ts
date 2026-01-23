import { describe, it, expect } from 'vitest'
import { hashPath, getProjectId, getContainerName } from '../index.js'

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
