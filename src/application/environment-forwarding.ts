export const DEFAULT_ENV_FORWARD_BYTE_LIMIT = 64 * 1024;

/**
 * Environment variables to exclude when forwarding to container
 */
export const EXCLUDE_ENV_KEYS = new Set([
    // Unix system
    "PATH", "HOME", "USER", "SHELL", "LOGNAME", "PWD", "OLDPWD",
    "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "TERM_SESSION_ID",
    "TMPDIR", "TEMP", "TMP", "XPC_SERVICE_NAME", "XPC_FLAGS", "SHLVL", "_",
    "LaunchInstanceID", "SECURITYSESSIONID", "SSH_AUTH_SOCK",
    // Host display servers — forwarding makes clipboard libs (arboard used by
    // codex) try to reach the host's X11/Wayland socket from inside the
    // container and hang/time out. Clipboard bridges via the CCC HTTP server.
    "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_SESSION_TYPE",
    "XDG_RUNTIME_DIR", "XDG_SESSION_ID", "XDG_SESSION_CLASS",
    // macOS
    "Apple_PubSub_Socket_Render", "COMMAND_MODE", "COLORTERM",
    "TERM", "ITERM_SESSION_ID", "ITERM_PROFILE", "COLORFGBG",
    "LC_TERMINAL", "LC_TERMINAL_VERSION", "__CF_USER_TEXT_ENCODING",
    // Claude
    "CLAUDE_CONFIG_DIR",
    // CCC internal
    "CCC_TOOL",
    // Windows system (paths are meaningless inside Linux container)
    "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
    "ProgramFiles", "ProgramFiles(x86)", "ProgramData",
    "CommonProgramFiles", "CommonProgramFiles(x86)",
    "SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT",
    "PSModulePath", "OS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER",
    "NUMBER_OF_PROCESSORS", "COMPUTERNAME",
    // Windows package managers (contain Windows paths like C:\Users\...\AppData)
    "PNPM_HOME", "NPM_CONFIG_PREFIX", "NPM_CONFIG_CACHE",
]);

const EXCLUDE_ENV_PREFIXES = [
    "__MISE_",
    "BASH_FUNC_",
    "npm_config_",
    "npm_package_",
    "NPM_CONFIG_",
];

export interface ForwardedEnvPlan {
    forwarded: Array<[string, string]>;
    skippedDueToLimit: string[];
    totalBytes: number;
}

export function isValidEnvKey(key: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

function isWindowsPathLike(value: string): boolean {
    return /^[A-Za-z]:[/\\]/.test(value) || /;[A-Za-z]:[/\\]/.test(value);
}

function shouldExcludeEnvKey(key: string, excludeUpper: Set<string>): boolean {
    if (excludeUpper.has(key.toUpperCase())) {
        return true;
    }

    return EXCLUDE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function planForwardedEnvironment(
    environment: Record<string, string | undefined>,
    measureEntryBytes: (key: string, value: string) => number,
    options: { byteLimit?: number } = {},
): ForwardedEnvPlan {
    const byteLimit = options.byteLimit ?? DEFAULT_ENV_FORWARD_BYTE_LIMIT;
    const excludeUpper = new Set([...EXCLUDE_ENV_KEYS].map((key) => key.toUpperCase()));
    const candidates: Array<{ key: string; value: string; bytes: number }> = [];

    for (const [key, value] of Object.entries(environment)) {
        if (value === undefined) continue;
        if (!isValidEnvKey(key)) continue;
        if (shouldExcludeEnvKey(key, excludeUpper)) continue;
        if (isWindowsPathLike(value)) continue;

        candidates.push({
            key,
            value,
            bytes: measureEntryBytes(key, value),
        });
    }

    candidates.sort((left, right) => (
        left.bytes - right.bytes
        || left.key.localeCompare(right.key)
    ));

    const forwarded: Array<[string, string]> = [];
    const skippedDueToLimit: string[] = [];
    let totalBytes = 0;

    for (const candidate of candidates) {
        if (totalBytes + candidate.bytes > byteLimit) {
            skippedDueToLimit.push(candidate.key);
            continue;
        }
        forwarded.push([candidate.key, candidate.value]);
        totalBytes += candidate.bytes;
    }

    return { forwarded, skippedDueToLimit, totalBytes };
}
