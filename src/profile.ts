// src/profile.ts - Profile management for ccc
// A profile is simply an alternate ~/.ccc/claude/ directory.
// No env files, no templates — just credential directory isolation.

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { PROFILES_DIR } from "./utils.js";

// === Types ===

export interface ProfileSettings {
    env?: Record<string, string>;
    [key: string]: unknown;
}

export interface BuiltinProfile {
    description: string;
    settings?: ProfileSettings;
}

// === Built-in profiles ===

export const BUILTIN_PROFILES: Readonly<Record<string, BuiltinProfile>> = {
    "local-llm": {
        description: "Local LLM usage — disables Claude attribution header",
        settings: {
            env: {
                CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
            },
        },
    },
};

// === Validation ===

/**
 * Validate a profile name.
 * Must start with a lowercase letter or digit, followed by up to 63 lowercase
 * alphanumeric or [._-] characters (total max 64 chars).
 */
export function validateProfileName(name: string): boolean {
    return /^[a-z0-9][a-z0-9_.\-]{0,63}$/.test(name);
}

// === Queries ===

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

/**
 * Check if a name is a built-in profile.
 */
export function isBuiltinProfile(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(BUILTIN_PROFILES, name);
}

// === Mutations ===

/**
 * Create a new profile — just the claude/ directory and empty claude.json.
 * When settings are provided, also writes claude/settings.json.
 */
export function createProfile(name: string, settings?: ProfileSettings): void {
    const profileDir = join(PROFILES_DIR, name);
    const claudeDir = join(profileDir, "claude");

    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(profileDir, "claude.json"), "{}", { mode: 0o600 });

    if (settings) {
        writeFileSync(
            join(claudeDir, "settings.json"),
            JSON.stringify(settings, null, 2),
            { mode: 0o600 },
        );
    }
}

/**
 * Ensure a profile exists. If it's a built-in and doesn't exist, auto-create it.
 * Returns true if a new profile was created, false if it already existed.
 * Throws for unknown non-builtin profiles.
 */
export function ensureProfile(name: string): boolean {
    if (profileExists(name)) return false;
    if (!isBuiltinProfile(name)) {
        throw new Error(`Profile "${name}" does not exist. Create it with: ccc profile add ${name}`);
    }
    createProfile(name, BUILTIN_PROFILES[name].settings);
    return true;
}

/**
 * Remove a profile directory recursively.
 */
export function removeProfile(name: string): void {
    const profileDir = join(PROFILES_DIR, name);
    rmSync(profileDir, { recursive: true, force: true });
}
