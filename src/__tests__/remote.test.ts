import { describe, it, expect } from 'vitest'
import { hashPath, getProjectHash, getMutagenSessionName } from '../remote.js'

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
