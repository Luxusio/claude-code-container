import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, chmodSync, renameSync, unlinkSync, openSync, writeSync, closeSync} from 'fs';
import {randomBytes} from 'crypto';
import {join} from 'path';
import {tmpdir} from 'os';
import {SpawnSyncReturns} from 'child_process';
import {
    needsCredentialSync,
    syncCredentials,
    syncFromMacKeychain,
    readHostCredentials,
    syncFromWindowsCredentialManager,
    readValidCredentialsFile,
    validateToken,
    CredentialDeps,
    TokenRefreshError
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
        mkdirSync,
        renameSync,
        unlinkSync,
        openSync,
        writeSync,
        closeSync,
        randomBytes,
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

        it('should return true if credentials are expired even with refreshToken', () => {
            // Expired credentials need sync to get fresh token from external source
            const credPath = join(testClaudeDir, '.credentials.json');
            writeFileSync(credPath, JSON.stringify(createExpiredCredentials()));
            expect(needsCredentialSync(credPath)).toBe(true);
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

    describe('readHostCredentials', () => {
        it('should return null if host credentials file does not exist', () => {
            const deps = createMockDeps();
            expect(readHostCredentials(deps)).toBeNull();
        });

        it('should return credentials if host file exists and is valid', () => {
            const hostCredPath = join(testDir, '.claude', '.credentials.json');
            mkdirSync(join(testDir, '.claude'), {recursive: true});
            const validCreds = createValidCredentials();
            writeFileSync(hostCredPath, JSON.stringify(validCreds));

            const deps = createMockDeps();
            const result = readHostCredentials(deps);
            expect(result).not.toBeNull();
            expect(JSON.parse(result!).claudeAiOauth.accessToken).toBe('test-access-token');
        });

        it('should return credentials even if expired (has refreshToken)', () => {
            const hostCredPath = join(testDir, '.claude', '.credentials.json');
            mkdirSync(join(testDir, '.claude'), {recursive: true});
            writeFileSync(hostCredPath, JSON.stringify(createExpiredCredentials()));

            const deps = createMockDeps();
            const result = readHostCredentials(deps);
            expect(result).not.toBeNull();
            expect(JSON.parse(result!).claudeAiOauth.refreshToken).toBe('expired-refresh-token');
        });

        it('should work on Windows platform', () => {
            const hostCredPath = join(testDir, '.claude', '.credentials.json');
            mkdirSync(join(testDir, '.claude'), {recursive: true});
            const validCreds = createValidCredentials();
            writeFileSync(hostCredPath, JSON.stringify(validCreds));

            const deps = createMockDeps({ platform: 'win32' });
            const result = readHostCredentials(deps);
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

        it('should save valid credentials on macOS', async () => {
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
                openSync: (path: string, _flags: string, _mode?: number) => {
                    return 999; // fake fd
                },
                writeSync: (_fd: number, content: string) => {
                    writtenContent = content;
                    return content.length;
                },
                closeSync: () => {},
                renameSync: (oldPath: string, newPath: string) => {
                    // In tests, just verify the atomic write pattern
                    expect(oldPath).toContain('.tmp.');
                    expect(newPath).toBe(join(testClaudeDir, '.credentials.json'));
                }
            });

            await syncCredentials({claudeDir: testClaudeDir}, deps);
            // Should write credentials (no refresh needed)
            expect(writtenContent).toBe(JSON.stringify(validCreds));
        });

        it('should throw error when refresh fails for expired credentials', async () => {
            const expiredCreds = createExpiredCredentials();

            const deps = createMockDeps({
                platform: 'darwin',
                spawnSync: () => ({
                    status: 0,
                    stdout: JSON.stringify(expiredCreds),
                    stderr: '',
                    pid: 0,
                    output: [],
                    signal: null
                })
            });

            await expect(syncCredentials({claudeDir: testClaudeDir}, deps))
                .rejects.toThrow(TokenRefreshError);
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

        it('should set correct permissions via openSync on non-Windows platforms', async () => {
            const validCreds = createValidCredentials();
            const credJson = JSON.stringify(validCreds);
            let openSyncMode: number | undefined;

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
                openSync: (_path: string, _flags: string, mode?: number) => {
                    openSyncMode = mode;
                    return 999;
                },
                writeSync: () => credJson.length,
                closeSync: () => {}
            });

            await syncCredentials({claudeDir: testClaudeDir}, deps);
            expect(openSyncMode).toBe(0o600);
        });

        it('should use writeFileSync on Windows (no openSync with mode)', async () => {
            const validCreds = createValidCredentials();
            const credJson = JSON.stringify(validCreds);
            let writeFileSyncCalled = false;
            let openSyncCalled = false;

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
                writeFileSync: () => { writeFileSyncCalled = true; },
                openSync: () => { openSyncCalled = true; return 999; }
            });

            await syncCredentials({claudeDir: testClaudeDir}, deps);
            expect(writeFileSyncCalled).toBe(true);
            expect(openSyncCalled).toBe(false);
        });

        it('should use atomic write pattern with temp file and rename', async () => {
            // Use valid credentials to test atomic write pattern
            const validCreds = createValidCredentials();
            const credJson = JSON.stringify(validCreds);
            const writePaths: string[] = [];
            const renameCalls: { from: string; to: string }[] = [];

            const deps: CredentialDeps = {
                homedir: () => testDir,
                spawnSync: () => ({
                    status: 0,
                    stdout: credJson,
                    stderr: '',
                    pid: 0,
                    output: [],
                    signal: null
                }),
                existsSync: () => false,
                readFileSync: () => { throw new Error('ENOENT'); },
                writeFileSync: (path: string, _content: string) => {
                    writePaths.push(path);
                },
                chmodSync: () => {},
                mkdirSync: () => {},
                renameSync: (oldPath: string, newPath: string) => {
                    renameCalls.push({ from: oldPath, to: newPath });
                },
                unlinkSync: () => {},
                openSync: (path: string, _flags: string, _mode?: number) => {
                    writePaths.push(path);
                    return 1;
                },
                writeSync: () => 0,
                closeSync: () => {},
                randomBytes: (size: number) => randomBytes(size),
                platform: 'darwin'
            };

            await syncCredentials({claudeDir: testClaudeDir}, deps);

            // Should write to temp file first
            expect(writePaths.length).toBeGreaterThan(0);
            expect(writePaths[0]).toContain('.tmp.');
            // Should rename temp to final path
            expect(renameCalls.length).toBeGreaterThan(0);
            expect(renameCalls[0].from).toBe(writePaths[0]);
            expect(renameCalls[0].to).toBe(join(testClaudeDir, '.credentials.json'));
        });
    });

    describe('validateToken', () => {
        it('should return null for required token when undefined', () => {
            expect(validateToken(undefined, true)).toBeNull();
        });

        it('should return undefined for optional token when undefined', () => {
            expect(validateToken(undefined, false)).toBeUndefined();
        });

        it('should return null for non-string token', () => {
            expect(validateToken(123, true)).toBeNull();
            expect(validateToken({}, true)).toBeNull();
            expect(validateToken(null, true)).toBeNull();
        });

        it('should return null for token shorter than MIN_TOKEN_LENGTH', () => {
            expect(validateToken('short', true)).toBeNull();  // less than 10 chars
        });

        it('should return null for token longer than MAX_TOKEN_LENGTH', () => {
            const longToken = 'a'.repeat(10001);
            expect(validateToken(longToken, true)).toBeNull();
        });

        it('should return trimmed token for valid token', () => {
            const validToken = 'a'.repeat(50);
            expect(validateToken(validToken, true)).toBe(validToken);
        });

        it('should trim whitespace from token', () => {
            const validToken = 'a'.repeat(50);
            expect(validateToken(`  ${validToken}  `, true)).toBe(validToken);
        });

        it('should accept token at MIN_TOKEN_LENGTH boundary', () => {
            const minToken = 'a'.repeat(10);
            expect(validateToken(minToken, true)).toBe(minToken);
        });

        it('should accept token at MAX_TOKEN_LENGTH boundary', () => {
            const maxToken = 'a'.repeat(10000);
            expect(validateToken(maxToken, true)).toBe(maxToken);
        });
    });
});
