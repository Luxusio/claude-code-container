// src/utils.ts - Shared utilities for ccc

import {createHash} from "crypto";
import {createInterface} from "readline";
import {homedir} from "os";
import {basename, join, resolve} from "path";

// === CLI Version (injected at build time) ===
export const CLI_VERSION: string = "__CLI_VERSION__";

// === Shared Constants ===
export const DATA_DIR = join(homedir(), ".ccc");
export const CLAUDE_DIR = join(DATA_DIR, "claude");
export const CLAUDE_JSON_FILE = join(DATA_DIR, "claude.json"); // ~/.claude.json in container (onboarding state)
export const REMOTE_CONFIG_DIR = join(DATA_DIR, "remote");
export const PROFILES_DIR = join(DATA_DIR, "profiles");

export function getClaudeDir(profile?: string): string {
    if (!profile) return CLAUDE_DIR;
    return join(PROFILES_DIR, profile, "claude");
}

export function getClaudeJsonFile(profile?: string): string {
    if (!profile) return CLAUDE_JSON_FILE;
    return join(PROFILES_DIR, profile, "claude.json");
}
export const IMAGE_NAME = "ccc";
export const DOCKER_REGISTRY_IMAGE = process.env.CCC_REGISTRY || "luxusio/claude-code-container";
export const CONTAINER_PID_LIMIT = "-1"; // -1 = unlimited (same as host)
export const MISE_VOLUME_NAME = "ccc-mise-cache";
export const DEFAULT_ENV_FORWARD_BYTE_LIMIT = 64 * 1024;
export const COMMON_IGNORE_DIRS = [
    "node_modules", ".git", "dist", "build", "target",
    "__pycache__", ".next", ".nuxt", "vendor"
];

// Container marker: set inside container to enable per-project env separation via mise.toml [env]
// Uses systemd convention (https://systemd.io/CONTAINER_INTERFACE/)
export const CONTAINER_ENV_KEY = "container";
export const CONTAINER_ENV_VALUE = "docker";

/**
 * Generate a 12-character SHA256 hash of a path
 */
export function hashPath(path: string): string {
    return createHash("sha256").update(path).digest("hex").slice(0, 12);
}

/**
 * Generate project ID in format: name-hash
 */
export function getProjectId(projectPath: string): string {
    const name = basename(resolve(projectPath)).toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const hash = hashPath(resolve(projectPath));
    return `${name}-${hash}`;
}

/**
 * Environment variables to exclude when forwarding to container
 */
export const EXCLUDE_ENV_KEYS = new Set([
    // Unix system
    "PATH", "HOME", "USER", "SHELL", "LOGNAME", "PWD", "OLDPWD",
    "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "TERM_SESSION_ID",
    "TMPDIR", "TEMP", "TMP", "XPC_SERVICE_NAME", "XPC_FLAGS", "SHLVL", "_",
    "LaunchInstanceID", "SECURITYSESSIONID", "SSH_AUTH_SOCK",
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

function estimateEnvEntryBytes(key: string, value: string): number {
    return Buffer.byteLength(`${key}=${value}`) + 1;
}

export function collectForwardedEnv(
    env: NodeJS.ProcessEnv,
    options: { byteLimit?: number } = {},
): ForwardedEnvPlan {
    const byteLimit = options.byteLimit ?? DEFAULT_ENV_FORWARD_BYTE_LIMIT;
    const excludeUpper = new Set([...EXCLUDE_ENV_KEYS].map((key) => key.toUpperCase()));
    const candidates: Array<{ key: string; value: string; bytes: number }> = [];

    for (const [key, value] of Object.entries(env)) {
        if (value === undefined) continue;
        if (!isValidEnvKey(key)) continue;
        if (shouldExcludeEnvKey(key, excludeUpper)) continue;
        if (isWindowsPathLike(value)) continue;

        candidates.push({
            key,
            value,
            bytes: estimateEnvEntryBytes(key, value),
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

/**
 * Interactive prompt helper
 * @param question - Question to ask
 * @param lowercase - If true, lowercase the answer (default: false)
 */
export async function prompt(question: string, lowercase: boolean = false): Promise<string> {
    const rl = createInterface({input: process.stdin, output: process.stdout});
    return new Promise((resolve) => {
        rl.on("close", () => resolve(""));
        rl.question(question, (answer) => {
            const result = answer.trim();
            resolve(lowercase ? result.toLowerCase() : result);
            rl.close();
        });
    });
}
