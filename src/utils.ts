// src/utils.ts - Shared utilities for ccc

import {createHash} from "crypto";
import {createInterface} from "readline";
import {homedir} from "os";
import {basename, join, resolve} from "path";

// === Shared Constants ===
export const DATA_DIR = join(homedir(), ".ccc");
export const CLAUDE_DIR = join(DATA_DIR, "claude");
export const REMOTE_CONFIG_DIR = join(DATA_DIR, "remote");
export const IMAGE_NAME = "ccc";
export const CONTAINER_PID_LIMIT = "512";
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
    "PATH", "HOME", "USER", "SHELL", "LOGNAME", "PWD", "OLDPWD",
    "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "TERM_SESSION_ID",
    "TMPDIR", "XPC_SERVICE_NAME", "XPC_FLAGS", "SHLVL", "_",
    "LaunchInstanceID", "SECURITYSESSIONID", "SSH_AUTH_SOCK",
    "Apple_PubSub_Socket_Render", "COMMAND_MODE", "COLORTERM",
    "TERM", "ITERM_SESSION_ID", "ITERM_PROFILE", "COLORFGBG",
    "LC_TERMINAL", "LC_TERMINAL_VERSION", "__CF_USER_TEXT_ENCODING",
    "LC_ALL", "LC_CTYPE", "LANG",
    "CLAUDE_CONFIG_DIR"
]);

/**
 * Interactive prompt helper
 * @param question - Question to ask
 * @param lowercase - If true, lowercase the answer (default: false)
 */
export async function prompt(question: string, lowercase: boolean = false): Promise<string> {
    const rl = createInterface({input: process.stdin, output: process.stdout});
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            const result = answer.trim();
            resolve(lowercase ? result.toLowerCase() : result);
        });
    });
}
