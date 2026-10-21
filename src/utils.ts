// src/utils.ts - Shared utilities for ccc

import {createInterface} from "readline";
import {homedir} from "os";
import {join} from "path";
import {normalizeProfile, profileClaudeDir, profileClaudeJsonFile, profileCodexDir} from "./home-layout.js";
import {writeNativeEnvFile, writeOwnedNativeEnvFile} from "./adapters/session-env-file.js";
import {planForwardedEnvironment, type ForwardedEnvPlan} from "./application/environment-forwarding.js";

export {DEFAULT_ENV_FORWARD_BYTE_LIMIT, EXCLUDE_ENV_KEYS, isValidEnvKey} from "./application/environment-forwarding.js";
export type {ForwardedEnvPlan} from "./application/environment-forwarding.js";

// === CLI Version (injected at build time) ===
export const CLI_VERSION: string = "__CLI_VERSION__";

// === Shared Constants ===
export const DATA_DIR = join(homedir(), ".ccc");
export const CLIPBOARD_FILES_CONTAINER_DIR = "/run/ccc/clipboard-files";

function useMountedCredentialPaths(): boolean {
    return process.env.container === CONTAINER_ENV_VALUE;
}

// Host paths come from home-layout.ts (doc/common/REQ__ccc-home-layout.md).
// Inside a ccc container the credentials are the mounted ~/.claude and ~/.codex.
export function getClaudeDir(profile?: string): string {
    if (!normalizeProfile(profile) && useMountedCredentialPaths()) return join(homedir(), ".claude");
    return profileClaudeDir(profile);
}

export function getClaudeJsonFile(profile?: string): string {
    if (!normalizeProfile(profile) && useMountedCredentialPaths()) return join(homedir(), ".claude.json");
    return profileClaudeJsonFile(profile);
}

export function getCodexDir(profile?: string): string {
    if (useMountedCredentialPaths()) return join(homedir(), ".codex");
    return profileCodexDir(profile);
}

export function getCodexConfigFile(profile?: string): string {
    return join(getCodexDir(profile), "config.toml");
}
export const IMAGE_NAME = "ccc";
export const DOCKER_REGISTRY_IMAGE = process.env.CCC_REGISTRY || "luxusio/claude-code-container";
export const CONTAINER_PID_LIMIT = "-1"; // -1 = unlimited (same as host)
export const MISE_VOLUME_NAME = "ccc-mise-cache";
// Codex installs its app-server daemon under $CODEX_HOME/packages. Keeping that
// subtree on a named volume avoids a rename that Windows-backed bind mounts
// reject right after a binary inside it ran (doc/common/REQ__codex-daemon-packages-volume.md).
export const CODEX_PACKAGES_VOLUME_NAME = "ccc-codex-packages";
export const CODEX_PACKAGES_CONTAINER_DIR = "/home/ccc/.codex/packages";
export const LAB_RUNNER_PROFILE_NAME = "lab-runner";
export const LAB_RUNNER_STATE_CONTAINER_DIR = "/home/ccc/.ccc/labs";
export const COMMON_IGNORE_DIRS = [
    "node_modules", ".git", "dist", "build", "target",
    "__pycache__", ".next", ".nuxt", "vendor"
];

// Container marker: set inside container to enable per-project env separation via mise.toml [env]
// Uses systemd convention (https://systemd.io/CONTAINER_INTERFACE/)
export const CONTAINER_ENV_KEY = "container";
export const CONTAINER_ENV_VALUE = "docker";

export {hashPath, canonicalProjectPath, projectPathsEquivalent, projectIdentityPath, getProjectId} from "@ccc/device-lab/project-identity.js";

function estimateEnvEntryBytes(key: string, value: string): number {
    return Buffer.byteLength(`${key}=${value}`) + 1;
}

export function collectForwardedEnv(
    env: NodeJS.ProcessEnv,
    options: { byteLimit?: number } = {},
): ForwardedEnvPlan {
    return planForwardedEnvironment(env, estimateEnvEntryBytes, options);
}

/**
 * Write environment variable entries to a host-side temp file for use with
 * `docker exec --env-file <path>`.
 *
 * Passing many env vars as repeated `-e KEY=VALUE` flags on the docker exec
 * command line can exceed the OS ARG_MAX limit ("Argument list too long").
 * Writing them to a file and passing a single `--env-file` argument avoids
 * that limit regardless of how many variables are forwarded.
 *
 * Entries whose values contain embedded newlines, carriage returns, or null
 * bytes are silently skipped: the Docker env-file format (one KEY=VALUE per
 * line) cannot represent multi-line values.
 *
 * The caller is responsible for deleting the returned path after use.
 */
export function writeEnvFile(entries: Array<[string, string]>): string {
    return writeNativeEnvFile(entries);
}

/** Write an environment file owned until explicit disposal or process exit. */
export function writeOwnedEnvFile(entries: Array<[string, string]>): { path: string; dispose(): void } {
    return writeOwnedNativeEnvFile(entries);
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
