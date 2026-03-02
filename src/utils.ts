// src/utils.ts - Shared utilities for ccc

import {createHash} from "crypto";
import {createInterface} from "readline";
import {homedir} from "os";
import {basename, join, resolve} from "path";

// === Shared Constants ===
export const DATA_DIR = join(homedir(), ".ccc");
export const CLAUDE_DIR = join(DATA_DIR, "claude");
export const CLAUDE_JSON_FILE = join(DATA_DIR, "claude.json"); // ~/.claude.json in container (onboarding state)
export const REMOTE_CONFIG_DIR = join(DATA_DIR, "remote");
export const IMAGE_NAME = "ccc";
export const CONTAINER_PID_LIMIT = "-1"; // -1 = unlimited (same as host)
export const MISE_VOLUME_NAME = "ccc-mise-cache";
export const COMMON_IGNORE_DIRS = [
    "node_modules", ".git", "dist", "build", "target",
    "__pycache__", ".next", ".nuxt", "vendor"
];

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
    "LC_ALL", "LC_CTYPE", "LANG",
    // Claude
    "CLAUDE_CONFIG_DIR",
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
            rl.close();
            const result = answer.trim();
            resolve(lowercase ? result.toLowerCase() : result);
        });
    });
}
