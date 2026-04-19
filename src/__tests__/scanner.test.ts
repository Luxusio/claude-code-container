import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { matchesPattern, scanVersionFiles, formatScannedFiles, extractVersionHints, formatVersionHints, VersionHint } from '../scanner.js'
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

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

// ===========================================================================
// scanVersionFiles — filesystem-based tests
// ===========================================================================
describe('scanVersionFiles', () => {
  let testDir: string

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'ccc-scanner-test-'))
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('finds version files in root directory', () => {
    writeFileSync(join(testDir, 'package.json'), '{"name": "test"}')
    writeFileSync(join(testDir, '.nvmrc'), '18')
    const results = scanVersionFiles(testDir)
    expect(results.has('package.json')).toBe(true)
    expect(results.has('.nvmrc')).toBe(true)
  })

  it('returns relative paths', () => {
    writeFileSync(join(testDir, 'package.json'), '{}')
    const results = scanVersionFiles(testDir)
    expect(results.has('package.json')).toBe(true)
    // Should NOT have absolute path
    const keys = [...results.keys()]
    expect(keys.every(k => !k.startsWith('/'))).toBe(true)
  })

  it('scans subdirectories', () => {
    mkdirSync(join(testDir, 'subdir'))
    writeFileSync(join(testDir, 'subdir', 'go.mod'), 'module test\n\ngo 1.21')
    const results = scanVersionFiles(testDir)
    expect(results.has(join('subdir', 'go.mod'))).toBe(true)
  })

  it('skips node_modules directory', () => {
    mkdirSync(join(testDir, 'node_modules'))
    writeFileSync(join(testDir, 'node_modules', 'package.json'), '{}')
    const results = scanVersionFiles(testDir)
    expect(results.size).toBe(0)
  })

  it('skips .git directory', () => {
    mkdirSync(join(testDir, '.git'))
    writeFileSync(join(testDir, '.git', 'package.json'), '{}')
    const results = scanVersionFiles(testDir)
    expect(results.size).toBe(0)
  })

  it('skips hidden directories', () => {
    mkdirSync(join(testDir, '.hidden'))
    writeFileSync(join(testDir, '.hidden', 'package.json'), '{}')
    const results = scanVersionFiles(testDir)
    expect(results.size).toBe(0)
  })

  it('respects maxDepth', () => {
    mkdirSync(join(testDir, 'a', 'b', 'c', 'd'), { recursive: true })
    writeFileSync(join(testDir, 'a', 'b', 'c', 'd', 'package.json'), '{}')
    // maxDepth=3 means depth 0,1,2,3 — d is at depth 4
    const results = scanVersionFiles(testDir, testDir, 0, 3)
    expect(results.size).toBe(0)
  })

  it('finds files within maxDepth', () => {
    mkdirSync(join(testDir, 'a', 'b'), { recursive: true })
    writeFileSync(join(testDir, 'a', 'b', 'package.json'), '{}')
    const results = scanVersionFiles(testDir, testDir, 0, 3)
    expect(results.size).toBe(1)
  })

  it('skips files larger than 100KB', () => {
    const bigContent = 'x'.repeat(101 * 1024)
    writeFileSync(join(testDir, 'package.json'), bigContent)
    const results = scanVersionFiles(testDir)
    expect(results.size).toBe(0)
  })

  it('ignores non-matching files', () => {
    writeFileSync(join(testDir, 'main.ts'), 'console.log("hello")')
    writeFileSync(join(testDir, 'README.md'), '# Test')
    const results = scanVersionFiles(testDir)
    expect(results.size).toBe(0)
  })

  it('returns empty map for non-existent directory', () => {
    const results = scanVersionFiles('/tmp/nonexistent-ccc-test-dir-12345')
    expect(results.size).toBe(0)
  })

  it('matches wildcard patterns like *.csproj', () => {
    writeFileSync(join(testDir, 'MyApp.csproj'), '<Project />')
    const results = scanVersionFiles(testDir)
    expect(results.has('MyApp.csproj')).toBe(true)
  })
})

// ===========================================================================
// extractVersionHints — additional edge cases
// ===========================================================================
describe('extractVersionHints — additional cases', () => {
  it('extracts ruby version from .ruby-version', () => {
    const files = new Map([['.ruby-version', '3.2.2']])
    const hints = extractVersionHints(files)
    expect(hints).toContainEqual({ tool: 'ruby', version: '3.2.2', source: '.ruby-version' })
  })

  it('extracts java version from .java-version with temurin prefix', () => {
    const files = new Map([['.java-version', '17']])
    const hints = extractVersionHints(files)
    expect(hints).toContainEqual({ tool: 'java', version: 'temurin-17', source: '.java-version' })
  })

  it('extracts java from .sdkmanrc', () => {
    const files = new Map([['.sdkmanrc', 'java=21.0.1-tem\ngradle=8.5']])
    const hints = extractVersionHints(files)
    expect(hints).toContainEqual({ tool: 'java', version: '21.0.1-tem', source: '.sdkmanrc' })
  })

  it('extracts node from .node-version', () => {
    const files = new Map([['.node-version', 'v20.11.0']])
    const hints = extractVersionHints(files)
    expect(hints).toContainEqual({ tool: 'node', version: '20.11.0', source: '.node-version' })
  })

  it('extracts terraform from .terraform-version', () => {
    const files = new Map([['.terraform-version', '1.6.4']])
    const hints = extractVersionHints(files)
    expect(hints).toContainEqual({ tool: 'terraform', version: '1.6.4', source: '.terraform-version' })
  })

  it('extracts rust from plain rust-toolchain file', () => {
    const files = new Map([['rust-toolchain', 'stable']])
    const hints = extractVersionHints(files)
    expect(hints).toContainEqual({ tool: 'rust', version: 'stable', source: 'rust-toolchain' })
  })

  it('extracts rust from Cargo.toml rust-version', () => {
    const files = new Map([['Cargo.toml', '[package]\nname = "myapp"\nrust-version = "1.70"']])
    const hints = extractVersionHints(files)
    expect(hints).toContainEqual({ tool: 'rust', version: '1.70', source: 'Cargo.toml' })
  })

  it('extracts python from pyproject.toml requires-python', () => {
    const files = new Map([['pyproject.toml', '[project]\nrequires-python = ">=3.11"']])
    const hints = extractVersionHints(files)
    expect(hints).toContainEqual({ tool: 'python', version: '3.11', source: 'pyproject.toml' })
  })

  it('extracts dotnet from global.json', () => {
    const files = new Map([['global.json', '{"sdk": {"version": "8.0.100"}}']])
    const hints = extractVersionHints(files)
    expect(hints).toContainEqual({ tool: 'dotnet', version: '8.0.100', source: 'global.json' })
  })

  it('extracts node from volta.json', () => {
    const files = new Map([['volta.json', '{"node": "v20.10.0"}']])
    const hints = extractVersionHints(files)
    expect(hints).toContainEqual({ tool: 'node', version: '20.10.0', source: 'volta.json' })
  })

  it('extracts node from .volta.json', () => {
    const files = new Map([['.volta.json', '{"node": "18.19.0"}']])
    const hints = extractVersionHints(files)
    expect(hints).toContainEqual({ tool: 'node', version: '18.19.0', source: '.volta.json' })
  })

  it('handles invalid JSON in package.json gracefully', () => {
    const files = new Map([['package.json', 'not valid json']])
    const hints = extractVersionHints(files)
    expect(hints).toHaveLength(0)
  })

  it('handles invalid JSON in volta.json gracefully', () => {
    const files = new Map([['volta.json', '{broken']])
    const hints = extractVersionHints(files)
    expect(hints).toHaveLength(0)
  })

  it('handles invalid JSON in global.json gracefully', () => {
    const files = new Map([['global.json', 'nope']])
    const hints = extractVersionHints(files)
    expect(hints).toHaveLength(0)
  })

  it('handles package.json without engines field', () => {
    const files = new Map([['package.json', '{"name": "test"}']])
    const hints = extractVersionHints(files)
    expect(hints).toHaveLength(0)
  })

  it('handles empty .tool-versions file', () => {
    const files = new Map([['.tool-versions', '']])
    const hints = extractVersionHints(files)
    expect(hints).toHaveLength(0)
  })

  it('handles subdirectory paths correctly', () => {
    const files = new Map([['frontend/.nvmrc', 'v22']])
    const hints = extractVersionHints(files)
    expect(hints).toContainEqual({ tool: 'node', version: '22', source: 'frontend/.nvmrc' })
  })

  it('strips v prefix from .nvmrc', () => {
    const files = new Map([['.nvmrc', 'v18.17.0']])
    const hints = extractVersionHints(files)
    expect(hints[0].version).toBe('18.17.0')
  })

  it('handles .nvmrc without v prefix', () => {
    const files = new Map([['.nvmrc', '20']])
    const hints = extractVersionHints(files)
    expect(hints[0].version).toBe('20')
  })
})
