/**
 * Cross-platform credential sync for Claude Code Container
 * Syncs credentials from host system to container's credential file
 * Refreshes tokens at startup to ensure fresh 8-hour validity
 */

import {spawnSync, SpawnSyncReturns} from "child_process";
import {existsSync, readFileSync, writeFileSync, chmodSync} from "fs";
import {homedir as osHomedir} from "os";
import {join} from "path";

// Claude Code OAuth
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';

// Only refresh if token is already expired (prevents token revocation when multiple instances run)
const TOKEN_REFRESH_THRESHOLD_MS = 0;

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
    platform: NodeJS.Platform;
}

const defaultDeps: CredentialDeps = {
    homedir: osHomedir,
    spawnSync: spawnSync as CredentialDeps['spawnSync'],
    existsSync,
    readFileSync: readFileSync as CredentialDeps['readFileSync'],
    writeFileSync: writeFileSync as CredentialDeps['writeFileSync'],
    chmodSync,
    platform: process.platform
};

/**
 * Check if credentials file needs sync (missing or no refreshToken)
 */
export function needsCredentialSync(credentialsPath: string, deps = defaultDeps): boolean {
    if (!deps.existsSync(credentialsPath)) return true;
    try {
        const existing = JSON.parse(deps.readFileSync(credentialsPath, 'utf-8'));
        return !existing?.claudeAiOauth?.refreshToken;
    } catch {
        return true;
    }
}

/**
 * Check if token needs refresh (only when already expired)
 */
function tokenNeedsRefresh(creds: { claudeAiOauth?: { expiresAt?: number } }): boolean {
    const expiresAt = creds?.claudeAiOauth?.expiresAt;
    if (!expiresAt) return true;
    return Date.now() >= expiresAt; // Only refresh if expired
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
        });

        if (!response.ok) {
            return null;
        }

        const data = await response.json() as {
            access_token?: string;
            refresh_token?: string;
            expires_in?: number;
        };

        if (!data.access_token) {
            return null;
        }

        return {
            ...credentials,
            claudeAiOauth: {
                ...credentials.claudeAiOauth,
                accessToken: data.access_token,
                refreshToken: data.refresh_token ?? credentials.claudeAiOauth.refreshToken,
                expiresAt: Date.now() + (data.expires_in ?? 28800) * 1000,
            }
        };
    } catch {
        return null;
    }
}

/**
 * Sync credentials from host system to container credential file
 * Refreshes token at startup to ensure fresh 8-hour validity
 *
 * On macOS: Syncs from Keychain, then refreshes
 * On Linux/Windows: Syncs from file if missing, then refreshes
 */
export async function syncCredentials(options: CredentialSyncOptions, deps = defaultDeps): Promise<void> {
    const credentialsPath = join(options.claudeDir, '.credentials.json');
    let credentialsJson: string | null = null;

    // Get credentials from appropriate source
    if (deps.platform === 'darwin') {
        credentialsJson = syncFromMacKeychain(deps);
    } else if (deps.platform === 'linux') {
        // Only sync from file if we don't have valid credentials
        if (needsCredentialSync(credentialsPath, deps)) {
            credentialsJson = syncFromLinuxFile(deps);
        }
    } else if (deps.platform === 'win32') {
        if (needsCredentialSync(credentialsPath, deps)) {
            credentialsJson = syncFromWindowsFile(deps) ?? syncFromWindowsCredentialManager(deps);
        }
    }

    // If we got credentials from a source, check if refresh is needed
    if (credentialsJson) {
        try {
            const creds = JSON.parse(credentialsJson);
            if (creds?.claudeAiOauth?.refreshToken && tokenNeedsRefresh(creds)) {
                // Only refresh if token is expiring soon (within 1 hour)
                const refreshed = await refreshOAuthToken(creds);
                if (refreshed) {
                    deps.writeFileSync(credentialsPath, JSON.stringify(refreshed), { mode: 0o600 });
                    if (deps.platform !== 'win32') {
                        deps.chmodSync(credentialsPath, 0o600);
                    }
                    return;
                }
            }
            // Save credentials (original or if refresh not needed)
            deps.writeFileSync(credentialsPath, credentialsJson, { mode: 0o600 });
            if (deps.platform !== 'win32') {
                deps.chmodSync(credentialsPath, 0o600);
            }
        } catch {
            // Invalid JSON, skip
        }
        return;
    }

    // No new credentials from source, try to refresh existing if needed
    if (deps.existsSync(credentialsPath)) {
        try {
            const existing = JSON.parse(deps.readFileSync(credentialsPath, 'utf-8'));
            if (existing?.claudeAiOauth?.refreshToken && tokenNeedsRefresh(existing)) {
                // Only refresh if token is expiring soon
                const refreshed = await refreshOAuthToken(existing);
                if (refreshed) {
                    deps.writeFileSync(credentialsPath, JSON.stringify(refreshed), { mode: 0o600 });
                    if (deps.platform !== 'win32') {
                        deps.chmodSync(credentialsPath, 0o600);
                    }
                }
            }
        } catch {
            // Failed to read/parse
        }
    }
}

/**
 * macOS: Extract credentials from Keychain
 */
export function syncFromMacKeychain(deps = defaultDeps): string | null {
    const result = deps.spawnSync('security', [
        'find-generic-password',
        '-s', 'Claude Code-credentials',
        '-w'
    ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });

    if (result.status === 0 && result.stdout) {
        return result.stdout.trim() || null;
    }
    return null;
}

/**
 * Linux: Copy credentials from ~/.claude/.credentials.json
 */
export function syncFromLinuxFile(deps = defaultDeps): string | null {
    const hostCredentials = join(deps.homedir(), '.claude', '.credentials.json');
    return readValidCredentialsFile(hostCredentials, deps);
}

/**
 * Windows: Copy credentials from %USERPROFILE%\.claude\.credentials.json
 */
export function syncFromWindowsFile(deps = defaultDeps): string | null {
    const hostCredentials = join(deps.homedir(), '.claude', '.credentials.json');
    return readValidCredentialsFile(hostCredentials, deps);
}

/**
 * Read credentials file and validate it has refresh token
 */
export function readValidCredentialsFile(filePath: string, deps = defaultDeps): string | null {
    if (!deps.existsSync(filePath)) return null;

    try {
        const content = deps.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(content);
        if (parsed?.claudeAiOauth?.refreshToken) {
            return content;
        }
    } catch {
        // File corrupt or invalid
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
$success = [ADVAPI32.Util]::CredRead('Claude Code-credentials', 1, 0, [ref]$ptr)

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
    ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });

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
