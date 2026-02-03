/**
 * Cross-platform credential sync for Claude Code Container
 * Syncs credentials from host system to container's credential file
 * Refreshes tokens when expired
 */

import {spawnSync, SpawnSyncReturns} from "child_process";
import {randomBytes} from "crypto";
import {readFileSync, writeFileSync, chmodSync, mkdirSync, renameSync, accessSync, constants, openSync, writeSync, closeSync, unlinkSync} from "fs";
import {homedir as osHomedir} from "os";
import {join} from "path";

// Claude Code OAuth
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';

/** Error thrown when OAuth token refresh fails */
export class TokenRefreshError extends Error {
    constructor() {
        super('Failed to refresh OAuth token. Please re-authenticate with Claude.');
        this.name = 'TokenRefreshError';
    }
}

// Constants for validation
const MAX_TOKEN_LENGTH = 10000;  // OAuth tokens should never exceed this
const MIN_TOKEN_LENGTH = 10;    // Minimum reasonable token length
const CREDENTIAL_STORAGE_KEY = 'Claude Code-credentials';
const DEFAULT_TOKEN_LIFETIME_SECONDS = 28800;  // 8 hours default
const MAX_TOKEN_LIFETIME_SECONDS = 31536000;   // 1 year max
const REFRESH_TIMEOUT_MS = 10000;  // 10 second timeout for refresh
const POWERSHELL_TIMEOUT_MS = 15000;  // 15 second timeout for PowerShell

export interface CredentialSyncOptions {
    claudeDir: string;
}

/** Dependencies for testing */
export interface CredentialDeps {
    homedir: () => string;
    spawnSync: (cmd: string, args: string[], opts?: object) => SpawnSyncReturns<string>;
    existsSync: (path: string) => boolean;
    readFileSync: (path: string, encoding: BufferEncoding) => string;
    writeFileSync: (path: string, data: string, opts?: object) => void;
    chmodSync: (path: string, mode: number) => void;
    mkdirSync: (path: string, options?: { recursive?: boolean; mode?: number }) => void;
    renameSync: (oldPath: string, newPath: string) => void;
    unlinkSync: (path: string) => void;
    openSync: (path: string, flags: string, mode?: number) => number;
    writeSync: (fd: number, data: string) => number;
    closeSync: (fd: number) => void;
    randomBytes: (size: number) => Buffer;
    platform: NodeJS.Platform;
}

const defaultDeps: CredentialDeps = {
    homedir: osHomedir,
    spawnSync: spawnSync as CredentialDeps['spawnSync'],
    existsSync: (path: string) => {
        try {
            accessSync(path, constants.F_OK);
            return true;
        } catch {
            return false;
        }
    },
    readFileSync: readFileSync as CredentialDeps['readFileSync'],
    writeFileSync: writeFileSync as CredentialDeps['writeFileSync'],
    chmodSync,
    mkdirSync,
    renameSync,
    unlinkSync,
    openSync,
    writeSync,
    closeSync,
    randomBytes,
    platform: process.platform
};

/**
 * Check if token is expired
 */
function isTokenExpired(expiresAt?: number): boolean {
    return !expiresAt || Date.now() >= expiresAt;
}

/**
 * Validate token format, length, and trimming
 * @param token - Token value to validate
 * @param required - Whether the token is required (true) or optional (false)
 * @returns Trimmed token string, or null if invalid, or undefined if optional and not provided
 */
function validateToken(token: unknown, required: boolean): string | null {
    if (token === undefined) return required ? null : undefined as unknown as string;
    if (typeof token !== 'string') return null;
    const trimmed = token.trim();
    if (trimmed.length < MIN_TOKEN_LENGTH || trimmed.length > MAX_TOKEN_LENGTH) return null;
    return trimmed;
}

/**
 * Check if credentials file needs sync (missing, no refreshToken, or expired)
 */
export function needsCredentialSync(credentialsPath: string, deps = defaultDeps): boolean {
    try {
        const existing = JSON.parse(deps.readFileSync(credentialsPath, 'utf-8'));
        if (!existing?.claudeAiOauth?.refreshToken) return true;
        return isTokenExpired(existing?.claudeAiOauth?.expiresAt);
    } catch {
        return true;
    }
}

/**
 * Write credentials atomically to file
 * Uses openSync with exclusive flag and proper mode to avoid race conditions
 */
function writeCredentialsAtomic(credentialsPath: string, content: string, deps: CredentialDeps): void {
    const uniqueId = deps.randomBytes(8).toString('hex');
    const tempPath = `${credentialsPath}.tmp.${process.pid}.${uniqueId}`;

    try {
        if (deps.platform !== 'win32') {
            // Create file with correct permissions atomically (wx = exclusive write)
            const fd = deps.openSync(tempPath, 'wx', 0o600);
            try {
                deps.writeSync(fd, content);
            } finally {
                deps.closeSync(fd);
            }
        } else {
            // Windows doesn't support mode in openSync the same way
            deps.writeFileSync(tempPath, content);
        }
        deps.renameSync(tempPath, credentialsPath);
    } catch (error) {
        // Clean up temp file on any error
        try {
            deps.unlinkSync(tempPath);
        } catch {
            // Ignore cleanup errors (file may not exist)
        }
        throw error;
    }
}

/**
 * Refresh OAuth token using refreshToken
 * Returns refreshed credentials object or null on failure
 */
export async function refreshOAuthToken(credentials: {
    claudeAiOauth: {
        refreshToken: string;
        [key: string]: unknown;
    };
}): Promise<typeof credentials | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
    try {
        const params = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: credentials.claudeAiOauth.refreshToken,
            client_id: OAUTH_CLIENT_ID,
        });

        const response = await fetch(OAUTH_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString(),
            signal: controller.signal,
        });

        if (!response.ok) {
            return null;
        }

        let data: unknown;
        try {
            data = await response.json();
        } catch {
            return null;
        }

        if (!data || typeof data !== 'object') {
            return null;
        }

        const tokenData = data as Record<string, unknown>;
        const expires_in = tokenData.expires_in;

        // Validate access token (required)
        const trimmedAccessToken = validateToken(tokenData.access_token, true);
        if (trimmedAccessToken === null) {
            return null;
        }

        // Validate refresh token (optional)
        const trimmedRefreshToken = validateToken(tokenData.refresh_token, false);
        if (trimmedRefreshToken === null) {
            return null;
        }

        // Validate expires_in is a positive integer and reasonable
        let validExpiresIn = DEFAULT_TOKEN_LIFETIME_SECONDS;
        if (typeof expires_in === 'number') {
            if (!Number.isInteger(expires_in) || expires_in <= 0 || expires_in > MAX_TOKEN_LIFETIME_SECONDS) {
                return null;
            }
            validExpiresIn = expires_in;
        }

        return {
            ...credentials,
            claudeAiOauth: {
                ...credentials.claudeAiOauth,
                accessToken: trimmedAccessToken,
                refreshToken: trimmedRefreshToken ?? credentials.claudeAiOauth.refreshToken,
                expiresAt: Date.now() + validExpiresIn * 1000,
            }
        };
    } catch {
        return null;
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * Get credentials from platform-specific source
 */
function getCredentialsFromSource(deps: CredentialDeps): string | null {
    switch (deps.platform) {
        case 'darwin':
            return syncFromMacKeychain(deps);
        case 'linux':
            return readHostCredentials(deps);
        case 'win32':
            return readHostCredentials(deps) ?? syncFromWindowsCredentialManager(deps);
        default:
            return null;
    }
}

/**
 * Refresh credentials if expired and save to file
 * @returns true if credentials were saved (refreshed or as-is)
 */
async function refreshAndSave(
    creds: { claudeAiOauth?: { refreshToken?: string; expiresAt?: number } },
    credentialsPath: string,
    originalJson: string | null,
    deps: CredentialDeps
): Promise<boolean> {
    if (!creds?.claudeAiOauth?.refreshToken) return false;

    if (isTokenExpired(creds.claudeAiOauth.expiresAt)) {
        const refreshed = await refreshOAuthToken(creds as Parameters<typeof refreshOAuthToken>[0]);
        if (!refreshed) throw new TokenRefreshError();
        writeCredentialsAtomic(credentialsPath, JSON.stringify(refreshed), deps);
        return true;
    }

    // Not expired - save original if provided
    if (originalJson) {
        writeCredentialsAtomic(credentialsPath, originalJson, deps);
        return true;
    }
    return false;
}

/**
 * Sync credentials from host system to container credential file
 * Refreshes tokens when expired
 */
export async function syncCredentials(options: CredentialSyncOptions, deps = defaultDeps): Promise<void> {
    const credentialsPath = join(options.claudeDir, '.credentials.json');

    // Try external source if local credentials are missing/expired
    if (needsCredentialSync(credentialsPath, deps)) {
        const credentialsJson = getCredentialsFromSource(deps);
        if (credentialsJson) {
            try {
                const creds = JSON.parse(credentialsJson);
                await refreshAndSave(creds, credentialsPath, credentialsJson, deps);
            } catch (e) {
                if (e instanceof TokenRefreshError) throw e;
            }
            return;
        }
    }

    // Fallback: refresh existing local credentials if needed
    try {
        const existing = JSON.parse(deps.readFileSync(credentialsPath, 'utf-8'));
        await refreshAndSave(existing, credentialsPath, null, deps);
    } catch (e) {
        if (e instanceof TokenRefreshError) throw e;
    }
}

/**
 * macOS: Extract credentials from Keychain
 */
export function syncFromMacKeychain(deps = defaultDeps): string | null {
    const result = deps.spawnSync('security', [
        'find-generic-password',
        '-s', CREDENTIAL_STORAGE_KEY,
        '-w'
    ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });

    if (result.status === 0 && result.stdout) {
        return result.stdout.trim() || null;
    }
    return null;
}

/**
 * Read credentials from host file at ~/.claude/.credentials.json
 */
export function readHostCredentials(deps = defaultDeps): string | null {
    const hostCredentials = join(deps.homedir(), '.claude', '.credentials.json');
    return readValidCredentialsFile(hostCredentials, deps);
}

/**
 * Read credentials file and validate it has refresh token
 */
export function readValidCredentialsFile(filePath: string, deps = defaultDeps): string | null {
    try {
        const content = deps.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(content);
        if (parsed?.claudeAiOauth?.refreshToken) {
            return content;
        }
    } catch {
        // File not found or corrupt
    }
    return null;
}

/**
 * Windows: Extract credentials from Credential Manager using P/Invoke
 */
export function syncFromWindowsCredentialManager(deps = defaultDeps): string | null {
    const psScript = `
$ErrorActionPreference = 'Stop'
$sig = @'
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct NativeCredential
{
    public UInt32 Flags;
    public UInt32 Type;
    public IntPtr TargetName;
    public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public IntPtr TargetAlias;
    public IntPtr UserName;
}

[DllImport("Advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern bool CredRead(string target, uint type, int reservedFlag, out IntPtr CredentialPtr);

[DllImport("Advapi32.dll", EntryPoint = "CredFree", SetLastError = true)]
public static extern bool CredFree(IntPtr cred);
'@

try {
    Add-Type -MemberDefinition $sig -Namespace "ADVAPI32" -Name 'Util' -ErrorAction Stop
} catch {
    if ($_.Exception.Message -notlike '*already exists*') { throw }
}

$ptr = [IntPtr]::Zero
$success = [ADVAPI32.Util]::CredRead('${CREDENTIAL_STORAGE_KEY}', 1, 0, [ref]$ptr)

if ($success -and $ptr -ne [IntPtr]::Zero) {
    try {
        $ncred = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [Type][ADVAPI32.Util+NativeCredential])
        $blob = [System.Runtime.InteropServices.Marshal]::PtrToStringUni($ncred.CredentialBlob, [int]($ncred.CredentialBlobSize / 2))
        Write-Output $blob
    } finally {
        [void][ADVAPI32.Util]::CredFree($ptr)
    }
}
`;

    const result = deps.spawnSync('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        psScript
    ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: POWERSHELL_TIMEOUT_MS });

    if (result.status === 0 && result.stdout?.trim()) {
        const credentials = result.stdout.trim();
        try {
            const parsed = JSON.parse(credentials);
            if (parsed?.claudeAiOauth?.refreshToken) {
                return credentials;
            }
        } catch {
            // Not valid JSON
        }
    }
    return null;
}
