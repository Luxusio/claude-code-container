import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, chmodSync} from 'fs';
import {join} from 'path';
import {tmpdir} from 'os';
import {SpawnSyncReturns} from 'child_process';
import {
    needsCredentialSync,
    syncCredentials,
    syncFromMacKeychain,
    syncFromLinuxFile,
    syncFromWindowsFile,
    syncFromWindowsCredentialManager,
    readValidCredentialsFile,
    CredentialDeps
} from '../credentials.js';

// Mock fetch globally - always fail to skip refresh in tests
vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false })));

// Test directory - use unique dir per test run
let testDir: string;
let testClaudeDir: string;

// Mock credentials data
function createValidCredentials() {
    return {
        claudeAiOauth: {
            accessToken: 'test-access-token',
            refreshToken: 'test-refresh-token',
            expiresAt: Date.now() + 3600000, // 1 hour from now
            scopes: ['user:inference']
        }
    };
}

function createExpiredCredentials() {
    // Expired but still has refreshToken - should still be valid for sync
    // Claude Code can refresh the token using refreshToken
    return {
        claudeAiOauth: {
            accessToken: 'expired-access-token',
            refreshToken: 'expired-refresh-token',
            expiresAt: Date.now() - 3600000, // 1 hour ago
            scopes: ['user:inference']
        }
    };
}

function createNoRefreshTokenCredentials() {
    return {
        claudeAiOauth: {
            accessToken: 'test-access-token',
            expiresAt: Date.now() + 3600000,
            scopes: ['user:inference']
        }
    };
}

// Create mock deps with real fs functions
function createMockDeps(overrides: Partial<CredentialDeps> = {}): CredentialDeps {
    return {
        homedir: () => testDir,
        spawnSync: () => ({ status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null }),
        existsSync,
        readFileSync: (p: string, e: BufferEncoding) => readFileSync(p, e),
        writeFileSync: (p: string, d: string, o?: object) => writeFileSync(p, d, o),
        chmodSync,
        platform: 'linux',
        ...overrides
    };
}

describe('credentials', () => {
    beforeEach(() => {
        testDir = join(tmpdir(), `ccc-cred-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        testClaudeDir = join(testDir, 'claude');
        mkdirSync(testClaudeDir, {recursive: true});
    });

    afterEach(() => {
        try {
            rmSync(testDir, {recursive: true, force: true});
        } catch {
            // Ignore cleanup errors
        }
    });

    describe('needsCredentialSync', () => {
        it('should return true if credentials file does not exist', () => {
            const credPath = join(testClaudeDir, '.credentials.json');
            expect(needsCredentialSync(credPath)).toBe(true);
        });

        it('should return false if credentials are expired but have refreshToken', () => {
            // Expired credentials with refreshToken can be refreshed by Claude Code
            const credPath = join(testClaudeDir, '.credentials.json');
            writeFileSync(credPath, JSON.stringify(createExpiredCredentials()));
            expect(needsCredentialSync(credPath)).toBe(false);
        });

        it('should return false if credentials are valid', () => {
            const credPath = join(testClaudeDir, '.credentials.json');
            writeFileSync(credPath, JSON.stringify(createValidCredentials()));
            expect(needsCredentialSync(credPath)).toBe(false);
        });

        it('should return true if credentials file is corrupt', () => {
            const credPath = join(testClaudeDir, '.credentials.json');
            writeFileSync(credPath, 'not valid json');
            expect(needsCredentialSync(credPath)).toBe(true);
        });

        it('should return true if refreshToken is missing', () => {
            const credPath = join(testClaudeDir, '.credentials.json');
            writeFileSync(credPath, JSON.stringify(createNoRefreshTokenCredentials()));
            expect(needsCredentialSync(credPath)).toBe(true);
        });
    });

    describe('readValidCredentialsFile', () => {
        it('should return null if file does not exist', () => {
            const result = readValidCredentialsFile(join(testDir, 'nonexistent.json'));
            expect(result).toBeNull();
        });

        it('should return content if credentials are expired but have refreshToken', () => {
            // Expired credentials with refreshToken can be refreshed by Claude Code
            const filePath = join(testDir, 'expired.json');
            writeFileSync(filePath, JSON.stringify(createExpiredCredentials()));
            const result = readValidCredentialsFile(filePath);
            expect(result).not.toBeNull();
            expect(JSON.parse(result!).claudeAiOauth.refreshToken).toBe('expired-refresh-token');
        });

        it('should return null if no refreshToken', () => {
            const filePath = join(testDir, 'no-refresh.json');
            writeFileSync(filePath, JSON.stringify(createNoRefreshTokenCredentials()));
            expect(readValidCredentialsFile(filePath)).toBeNull();
        });

        it('should return content if credentials are valid', () => {
            const filePath = join(testDir, 'valid.json');
            const validCreds = createValidCredentials();
            writeFileSync(filePath, JSON.stringify(validCreds));
            const result = readValidCredentialsFile(filePath);
            expect(result).not.toBeNull();
            expect(JSON.parse(result!).claudeAiOauth.accessToken).toBe('test-access-token');
        });

        it('should return null if file is corrupt', () => {
            const filePath = join(testDir, 'corrupt.json');
            writeFileSync(filePath, '{invalid json');
            expect(readValidCredentialsFile(filePath)).toBeNull();
        });
    });

    describe('syncFromLinuxFile', () => {
        it('should return null if host credentials file does not exist', () => {
            const deps = createMockDeps();
            expect(syncFromLinuxFile(deps)).toBeNull();
        });

        it('should return credentials if host file exists and is valid', () => {
            const hostCredPath = join(testDir, '.claude', '.credentials.json');
            mkdirSync(join(testDir, '.claude'), {recursive: true});
            const validCreds = createValidCredentials();
            writeFileSync(hostCredPath, JSON.stringify(validCreds));

            const deps = createMockDeps();
            const result = syncFromLinuxFile(deps);
            expect(result).not.toBeNull();
            expect(JSON.parse(result!).claudeAiOauth.accessToken).toBe('test-access-token');
        });

        it('should return credentials even if expired (has refreshToken)', () => {
            const hostCredPath = join(testDir, '.claude', '.credentials.json');
            mkdirSync(join(testDir, '.claude'), {recursive: true});
            writeFileSync(hostCredPath, JSON.stringify(createExpiredCredentials()));

            const deps = createMockDeps();
            const result = syncFromLinuxFile(deps);
            expect(result).not.toBeNull();
            expect(JSON.parse(result!).claudeAiOauth.refreshToken).toBe('expired-refresh-token');
        });
    });

    describe('syncFromWindowsFile', () => {
        it('should return null if host credentials file does not exist', () => {
            const deps = createMockDeps({ platform: 'win32' });
            expect(syncFromWindowsFile(deps)).toBeNull();
        });

        it('should return credentials if host file exists and is valid', () => {
            const hostCredPath = join(testDir, '.claude', '.credentials.json');
            mkdirSync(join(testDir, '.claude'), {recursive: true});
            const validCreds = createValidCredentials();
            writeFileSync(hostCredPath, JSON.stringify(validCreds));

            const deps = createMockDeps({ platform: 'win32' });
            const result = syncFromWindowsFile(deps);
            expect(result).not.toBeNull();
            expect(JSON.parse(result!).claudeAiOauth.accessToken).toBe('test-access-token');
        });
    });

    describe('syncFromMacKeychain', () => {
        it('should return null if security command fails', () => {
            const deps = createMockDeps({
                platform: 'darwin',
                spawnSync: () => ({
                    status: 1,
                    stdout: '',
                    stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found.',
                    pid: 0,
                    output: [],
                    signal: null
                })
            });
            expect(syncFromMacKeychain(deps)).toBeNull();
        });

        it('should return credentials if security command succeeds', () => {
            const credJson = JSON.stringify(createValidCredentials());
            const deps = createMockDeps({
                platform: 'darwin',
                spawnSync: () => ({
                    status: 0,
                    stdout: credJson + '\n',
                    stderr: '',
                    pid: 0,
                    output: [],
                    signal: null
                })
            });
            expect(syncFromMacKeychain(deps)).toBe(credJson);
        });

        it('should return null if stdout is empty', () => {
            const deps = createMockDeps({
                platform: 'darwin',
                spawnSync: () => ({
                    status: 0,
                    stdout: '',
                    stderr: '',
                    pid: 0,
                    output: [],
                    signal: null
                })
            });
            expect(syncFromMacKeychain(deps)).toBeNull();
        });

        it('should return null if stdout is only whitespace', () => {
            const deps = createMockDeps({
                platform: 'darwin',
                spawnSync: () => ({
                    status: 0,
                    stdout: '   \n',
                    stderr: '',
                    pid: 0,
                    output: [],
                    signal: null
                })
            });
            expect(syncFromMacKeychain(deps)).toBeNull();
        });
    });

    describe('syncFromWindowsCredentialManager', () => {
        it('should return null if powershell command fails', () => {
            const deps = createMockDeps({
                platform: 'win32',
                spawnSync: () => ({
                    status: 1,
                    stdout: '',
                    stderr: 'Error',
                    pid: 0,
                    output: [],
                    signal: null
                })
            });
            expect(syncFromWindowsCredentialManager(deps)).toBeNull();
        });

        it('should return credentials if powershell returns valid JSON', () => {
            const validCreds = createValidCredentials();
            const credJson = JSON.stringify(validCreds);
            const deps = createMockDeps({
                platform: 'win32',
                spawnSync: () => ({
                    status: 0,
                    stdout: credJson + '\n',
                    stderr: '',
                    pid: 0,
                    output: [],
                    signal: null
                })
            });
            expect(syncFromWindowsCredentialManager(deps)).toBe(credJson);
        });

        it('should return credentials even if expired (has refreshToken)', () => {
            const expiredCreds = createExpiredCredentials();
            const deps = createMockDeps({
                platform: 'win32',
                spawnSync: () => ({
                    status: 0,
                    stdout: JSON.stringify(expiredCreds) + '\n',
                    stderr: '',
                    pid: 0,
                    output: [],
                    signal: null
                })
            });
            const result = syncFromWindowsCredentialManager(deps);
            expect(result).not.toBeNull();
            expect(JSON.parse(result!).claudeAiOauth.refreshToken).toBe('expired-refresh-token');
        });

        it('should return null if no refreshToken', () => {
            const deps = createMockDeps({
                platform: 'win32',
                spawnSync: () => ({
                    status: 0,
                    stdout: JSON.stringify(createNoRefreshTokenCredentials()) + '\n',
                    stderr: '',
                    pid: 0,
                    output: [],
                    signal: null
                })
            });
            expect(syncFromWindowsCredentialManager(deps)).toBeNull();
        });

        it('should return null if powershell returns invalid JSON', () => {
            const deps = createMockDeps({
                platform: 'win32',
                spawnSync: () => ({
                    status: 0,
                    stdout: 'not json',
                    stderr: '',
                    pid: 0,
                    output: [],
                    signal: null
                })
            });
            expect(syncFromWindowsCredentialManager(deps)).toBeNull();
        });
    });

    describe('syncCredentials', () => {
        it('should not sync on Linux if credentials are already valid', async () => {
            const credPath = join(testClaudeDir, '.credentials.json');
            writeFileSync(credPath, JSON.stringify(createValidCredentials()));

            let spawnCalled = false;
            const deps = createMockDeps({
                platform: 'linux',
                spawnSync: () => {
                    spawnCalled = true;
                    return { status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null };
                }
            });

            await syncCredentials({claudeDir: testClaudeDir}, deps);
            expect(spawnCalled).toBe(false);
        });

        it('should always refresh and save on macOS', async () => {
            const validCreds = createValidCredentials();

            let writtenContent = '';
            const deps = createMockDeps({
                platform: 'darwin',
                spawnSync: () => ({
                    status: 0,
                    stdout: JSON.stringify(validCreds),
                    stderr: '',
                    pid: 0,
                    output: [],
                    signal: null
                }),
                writeFileSync: (_path: string, content: string) => { writtenContent = content; }
            });

            await syncCredentials({claudeDir: testClaudeDir}, deps);
            // Should write credentials (refresh failed, so fallback to original)
            expect(writtenContent).toBe(JSON.stringify(validCreds));
        });

        it('should sync on macOS using Keychain', async () => {
            const validCreds = createValidCredentials();
            const credJson = JSON.stringify(validCreds);

            const deps = createMockDeps({
                platform: 'darwin',
                spawnSync: () => ({
                    status: 0,
                    stdout: credJson,
                    stderr: '',
                    pid: 0,
                    output: [],
                    signal: null
                })
            });

            await syncCredentials({claudeDir: testClaudeDir}, deps);

            const credPath = join(testClaudeDir, '.credentials.json');
            expect(existsSync(credPath)).toBe(true);
            expect(readFileSync(credPath, 'utf-8')).toBe(credJson);
        });

        it('should sync on Linux using file copy', async () => {
            const hostCredPath = join(testDir, '.claude', '.credentials.json');
            mkdirSync(join(testDir, '.claude'), {recursive: true});
            const validCreds = createValidCredentials();
            const credJson = JSON.stringify(validCreds);
            writeFileSync(hostCredPath, credJson);

            const deps = createMockDeps({ platform: 'linux' });
            await syncCredentials({claudeDir: testClaudeDir}, deps);

            const credPath = join(testClaudeDir, '.credentials.json');
            expect(existsSync(credPath)).toBe(true);
            const written = readFileSync(credPath, 'utf-8');
            expect(JSON.parse(written).claudeAiOauth.accessToken).toBe('test-access-token');
        });

        it('should sync on Windows using file first', async () => {
            const hostCredPath = join(testDir, '.claude', '.credentials.json');
            mkdirSync(join(testDir, '.claude'), {recursive: true});
            const validCreds = createValidCredentials();
            const credJson = JSON.stringify(validCreds);
            writeFileSync(hostCredPath, credJson);

            const deps = createMockDeps({ platform: 'win32' });
            await syncCredentials({claudeDir: testClaudeDir}, deps);

            const credPath = join(testClaudeDir, '.credentials.json');
            expect(existsSync(credPath)).toBe(true);
        });

        it('should sync on Windows using Credential Manager if file not found', async () => {
            // No host file exists
            const validCreds = createValidCredentials();
            const credJson = JSON.stringify(validCreds);

            const deps = createMockDeps({
                platform: 'win32',
                spawnSync: () => ({
                    status: 0,
                    stdout: credJson,
                    stderr: '',
                    pid: 0,
                    output: [],
                    signal: null
                })
            });

            await syncCredentials({claudeDir: testClaudeDir}, deps);

            const credPath = join(testClaudeDir, '.credentials.json');
            expect(existsSync(credPath)).toBe(true);
            expect(readFileSync(credPath, 'utf-8')).toBe(credJson);
        });

        it('should prefer Windows file over Credential Manager', async () => {
            const hostCredPath = join(testDir, '.claude', '.credentials.json');
            mkdirSync(join(testDir, '.claude'), {recursive: true});
            const fileCreds = {...createValidCredentials(), source: 'file'};
            writeFileSync(hostCredPath, JSON.stringify(fileCreds));

            const cmCreds = {...createValidCredentials(), source: 'cm'};
            const deps = createMockDeps({
                platform: 'win32',
                spawnSync: () => ({
                    status: 0,
                    stdout: JSON.stringify(cmCreds),
                    stderr: '',
                    pid: 0,
                    output: [],
                    signal: null
                })
            });

            await syncCredentials({claudeDir: testClaudeDir}, deps);

            const credPath = join(testClaudeDir, '.credentials.json');
            const written = JSON.parse(readFileSync(credPath, 'utf-8'));
            expect(written.source).toBe('file');
        });

        it('should not write if no credentials found', async () => {
            const deps = createMockDeps({
                platform: 'darwin',
                spawnSync: () => ({
                    status: 1,
                    stdout: '',
                    stderr: '',
                    pid: 0,
                    output: [],
                    signal: null
                })
            });

            await syncCredentials({claudeDir: testClaudeDir}, deps);

            const credPath = join(testClaudeDir, '.credentials.json');
            expect(existsSync(credPath)).toBe(false);
        });

        it('should call chmodSync on non-Windows platforms', async () => {
            const validCreds = createValidCredentials();
            const credJson = JSON.stringify(validCreds);
            let chmodCalled = false;

            const deps = createMockDeps({
                platform: 'darwin',
                spawnSync: () => ({
                    status: 0,
                    stdout: credJson,
                    stderr: '',
                    pid: 0,
                    output: [],
                    signal: null
                }),
                chmodSync: () => { chmodCalled = true; }
            });

            await syncCredentials({claudeDir: testClaudeDir}, deps);
            expect(chmodCalled).toBe(true);
        });

        it('should not call chmodSync on Windows', async () => {
            const validCreds = createValidCredentials();
            const credJson = JSON.stringify(validCreds);
            let chmodCalled = false;

            const deps = createMockDeps({
                platform: 'win32',
                spawnSync: () => ({
                    status: 0,
                    stdout: credJson,
                    stderr: '',
                    pid: 0,
                    output: [],
                    signal: null
                }),
                chmodSync: () => { chmodCalled = true; }
            });

            await syncCredentials({claudeDir: testClaudeDir}, deps);
            expect(chmodCalled).toBe(false);
        });
    });
});
