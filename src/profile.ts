// src/profile.ts - Profile management for ccc
// A profile is simply an alternate ~/.ccc/claude/ directory.
// No env files, no templates — just credential directory isolation.

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
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
 * Create a new profile — just the claude/ directory and empty claude.json.
 */
export function createProfile(name: string): void {
    const profileDir = join(PROFILES_DIR, name);
    const claudeDir = join(profileDir, "claude");

    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(profileDir, "claude.json"), "{}", { mode: 0o600 });
}

/**
 * Remove a profile directory recursively.
 */
export function removeProfile(name: string): void {
    const profileDir = join(PROFILES_DIR, name);
    rmSync(profileDir, { recursive: true, force: true });
}
