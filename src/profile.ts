// src/profile.ts - Profile management for ccc

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { PROFILES_DIR } from "./utils.js";

/**
 * Validate a profile name.
 * Must start with a lowercase letter or digit, followed by up to 63 lowercase
 * alphanumeric or [._-] characters (total max 64 chars).
 */
export function validateProfileName(name: string): boolean {
    return /^[a-z0-9][a-z0-9_.\-]{0,63}$/.test(name);
}

/**
 * Parse an env file at <profileDir>/env.
 * Supports: # comments, blank lines, KEY=VALUE, export KEY=VALUE,
 * quote stripping, first-= splitting, duplicate keys (last wins).
 * Lines without = are skipped.
 */
export function loadProfileEnv(profileDir: string): Record<string, string> {
    const envFile = join(profileDir, "env");
    if (!existsSync(envFile)) return {};

    const content = readFileSync(envFile, "utf-8");
    const result: Record<string, string> = {};

    for (const rawLine of content.split("\n")) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;

        // Strip leading "export " prefix
        const stripped = line.startsWith("export ") ? line.slice(7).trimStart() : line;

        const eqIdx = stripped.indexOf("=");
        if (eqIdx === -1) continue;

        const key = stripped.slice(0, eqIdx);
        let value = stripped.slice(eqIdx + 1);

        // Strip surrounding quotes (single or double)
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }

        result[key] = value;
    }

    return result;
}

/**
 * List all profile names (subdirectories of PROFILES_DIR).
 */
export function listProfiles(): string[] {
    if (!existsSync(PROFILES_DIR)) return [];
    return readdirSync(PROFILES_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
}

/**
 * Check if a profile exists.
 */
export function profileExists(name: string): boolean {
    return existsSync(join(PROFILES_DIR, name));
}

const ENV_TEMPLATES: Record<string, string> = {
    anthropic: `# Anthropic API profile
ANTHROPIC_API_KEY=sk-ant-xxx
`,
    bedrock: `# AWS Bedrock profile
CLAUDE_CODE_USE_BEDROCK=1
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=us-east-1
`,
    vertex: `# Google Vertex AI profile
CLAUDE_CODE_USE_VERTEX=1
CLOUD_ML_REGION=us-east5
ANTHROPIC_VERTEX_PROJECT_ID=my-project
`,
    custom: `# Custom / local LLM profile
ANTHROPIC_BASE_URL=http://host.docker.internal:11434/v1
ANTHROPIC_API_KEY=dummy-key-for-local
`,
};

/**
 * Create a new profile directory with claude/ subdirectory and env template.
 */
export function createProfile(name: string, type: string): void {
    const profileDir = join(PROFILES_DIR, name);
    const claudeDir = join(profileDir, "claude");

    mkdirSync(claudeDir, { recursive: true });

    const template = ENV_TEMPLATES[type] ?? `# ${type} profile\n`;
    const envFile = join(profileDir, "env");
    writeFileSync(envFile, template, { mode: 0o600 });

    // Store type metadata
    writeFileSync(join(profileDir, "type"), type, { mode: 0o600 });
}

/**
 * Remove a profile directory recursively.
 */
export function removeProfile(name: string): void {
    const profileDir = join(PROFILES_DIR, name);
    rmSync(profileDir, { recursive: true, force: true });
}

/**
 * Check if an environment variable key is considered sensitive.
 * Matches keys containing KEY, SECRET, TOKEN, PASSWORD, or CREDENTIAL.
 */
export function isSensitiveKey(key: string): boolean {
    const upper = key.toUpperCase();
    return /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/.test(upper);
}

/**
 * Mask a sensitive value.
 * Short values (≤8 chars) → "*****"
 * Longer values → first 3 chars + "***" + last 3 chars
 */
export function maskValue(value: string): string {
    if (value.length <= 8) return "*****";
    return value.slice(0, 3) + "***" + value.slice(-3);
}

/**
 * Get profile info: parsed env and type.
 */
export function getProfileInfo(name: string): { env: Record<string, string>; type: string } {
    const profileDir = join(PROFILES_DIR, name);
    if (!existsSync(profileDir)) {
        throw new Error(`Profile "${name}" does not exist`);
    }

    const typeFile = join(profileDir, "type");
    const type = existsSync(typeFile) ? readFileSync(typeFile, "utf-8").trim() : "unknown";
    const env = loadProfileEnv(profileDir);

    return { env, type };
}
