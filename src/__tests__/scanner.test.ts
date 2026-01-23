import { describe, it, expect } from 'vitest'
import { matchesPattern, formatScannedFiles, extractVersionHints, formatVersionHints, VersionHint } from '../scanner.js'

describe('matchesPattern', () => {
  it('matches exact filenames', () => {
    expect(matchesPattern('package.json')).toBe(true)
    expect(matchesPattern('go.mod')).toBe(true)
    expect(matchesPattern('Cargo.toml')).toBe(true)
    expect(matchesPattern('.nvmrc')).toBe(true)
  })

  it('matches wildcard patterns', () => {
    expect(matchesPattern('myapp.csproj')).toBe(true)
    expect(matchesPattern('lib.cabal')).toBe(true)
    expect(matchesPattern('foo.opam')).toBe(true)
  })

  it('rejects non-matching files', () => {
    expect(matchesPattern('random.txt')).toBe(false)
    expect(matchesPattern('app.js')).toBe(false)
    expect(matchesPattern('main.go')).toBe(false)
  })
})

describe('formatScannedFiles', () => {
  it('returns message for empty map', () => {
    const result = formatScannedFiles(new Map())
    expect(result).toBe('No version files found in project.')
  })

  it('formats files correctly', () => {
    const files = new Map([
      ['package.json', '{"name": "test"}'],
      ['.nvmrc', '18']
    ])
    const result = formatScannedFiles(files)
    expect(result).toContain('Detected version files')
    expect(result).toContain('=== package.json ===')
    expect(result).toContain('{"name": "test"}')
    expect(result).toContain('=== .nvmrc ===')
    expect(result).toContain('18')
  })

  it('truncates long files', () => {
    const longContent = 'x'.repeat(3000)
    const files = new Map([['long.txt', longContent]])
    const result = formatScannedFiles(files)
    expect(result).toContain('truncated')
    expect(result.length).toBeLessThan(longContent.length)
  })
})

describe('extractVersionHints', () => {
  it('extracts node version from .nvmrc', () => {
    const files = new Map([['.nvmrc', 'v18.17.0']])
    const hints = extractVersionHints(files)
    expect(hints).toContainEqual({ tool: 'node', version: '18.17.0', source: '.nvmrc' })
  })

  it('extracts python version', () => {
    const files = new Map([['.python-version', '3.11.4']])
    const hints = extractVersionHints(files)
    expect(hints).toContainEqual({ tool: 'python', version: '3.11.4', source: '.python-version' })
  })

  it('extracts from .tool-versions', () => {
    const files = new Map([['.tool-versions', 'node 20.0.0\npython 3.12.0']])
    const hints = extractVersionHints(files)
    expect(hints).toContainEqual({ tool: 'node', version: '20.0.0', source: '.tool-versions' })
    expect(hints).toContainEqual({ tool: 'python', version: '3.12.0', source: '.tool-versions' })
  })

  it('extracts node from package.json engines', () => {
    const files = new Map([['package.json', '{"engines": {"node": ">=18"}}']])
    const hints = extractVersionHints(files)
    expect(hints).toContainEqual({ tool: 'node', version: '18', source: 'package.json' })
  })

  it('extracts go version from go.mod', () => {
    const files = new Map([['go.mod', 'module example\n\ngo 1.21']])
    const hints = extractVersionHints(files)
    expect(hints).toContainEqual({ tool: 'go', version: '1.21', source: 'go.mod' })
  })

  it('extracts rust from rust-toolchain.toml', () => {
    const files = new Map([['rust-toolchain.toml', '[toolchain]\nchannel = "1.75.0"']])
    const hints = extractVersionHints(files)
    expect(hints).toContainEqual({ tool: 'rust', version: '1.75.0', source: 'rust-toolchain.toml' })
  })

  it('deduplicates tools', () => {
    const files = new Map([
      ['.nvmrc', '18'],
      ['package.json', '{"engines": {"node": ">=20"}}']
    ])
    const hints = extractVersionHints(files)
    const nodeHints = hints.filter(h => h.tool === 'node')
    expect(nodeHints.length).toBe(1) // Only first occurrence
  })
})

describe('formatVersionHints', () => {
  it('returns empty string for no hints', () => {
    expect(formatVersionHints([])).toBe('')
  })

  it('formats hints correctly', () => {
    const hints: VersionHint[] = [
      { tool: 'node', version: '18', source: '.nvmrc' },
      { tool: 'python', version: '3.12', source: '.python-version' }
    ]
    const result = formatVersionHints(hints)
    expect(result).toContain('Pre-extracted versions')
    expect(result).toContain('node = "18"')
    expect(result).toContain('python = "3.12"')
    expect(result).toContain('from .nvmrc')
  })
})
