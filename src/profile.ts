// src/profile.ts - Profile management for ccc
// A profile is ~/.ccc/profiles/<name>/{claude/, claude.json, codex/}. The account
// used without CCC_PROFILE is the reserved profile "default"
// (doc/common/REQ__ccc-home-layout.md).

import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync, type Stats } from "fs";
import { createHash } from "crypto";
import { homedir } from "os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { LAB_RUNNER_PROFILE_NAME } from "./utils.js";
import { DEFAULT_PROFILE_NAME, locksDir, profilesDir } from "./home-layout.js";
import { withSharedMutationLock, writeJsonFileAtomically } from "@ccc/device-lab/device-lab-shared-state.js";

import { createProfileCatalog, validateProfileName as validateCatalogProfileName } from "./application/profile-catalog.js";
import type { BuiltinProfile, ProfileSettings } from "./ports/profile-catalog.js";

export type { BuiltinProfile, ProfileSettings } from "./ports/profile-catalog.js";

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
    [LAB_RUNNER_PROFILE_NAME]: {
        description: "Opt-in lab runner — enables bounded in-container VM runtime wiring when the host supports it",
    },
};

function profileCatalog() {
    return createProfileCatalog({
        listProfileDirectoryNames() {
            return existsSync(profilesDir())
                ? readdirSync(profilesDir(), { withFileTypes: true })
                    .filter((d) => d.isDirectory())
                    .map((d) => d.name)
                : [];
        },
        profileEntryExists(name) {
            return existsSync(join(profilesDir(), name));
        },
        writeProfile(name, settings) {
            const profileDir = join(profilesDir(), name);
            const claudeDir = join(profileDir, "claude");

            mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
            mkdirSync(join(profileDir, "codex"), { recursive: true, mode: 0o700 });
            writeFileSync(join(profileDir, "claude.json"), "{}", { mode: 0o600 });

            if (settings) {
                writeFileSync(
                    join(claudeDir, "settings.json"),
                    JSON.stringify(settings, null, 2),
                    { mode: 0o600 },
                );
            }
        },
        removeProfileDirectory(name) {
            const profileDir = join(profilesDir(), name);
            rmSync(profileDir, { recursive: true, force: true });
        },
        hasBuiltinProfile(name) {
            return Object.prototype.hasOwnProperty.call(BUILTIN_PROFILES, name);
        },
        readBuiltinSettings(name) {
            return BUILTIN_PROFILES[name].settings;
        },
    }, DEFAULT_PROFILE_NAME);
}

// === Validation ===

/**
 * Validate a profile name.
 * Must start with a lowercase letter or digit, followed by up to 63 lowercase
 * alphanumeric or [._-] characters (total max 64 chars).
 */
export function validateProfileName(name: string): boolean {
    return validateCatalogProfileName(name);
}

// === Queries ===

/**
 * List all profile names: "default" first, then the named profile directories.
 */
export function listProfiles(): string[] {
    return profileCatalog().list();
}

/**
 * Check if a profile exists.
 */
export function profileExists(name: string): boolean {
    return profileCatalog().exists(name);
}

/**
 * Check if a name is a built-in profile.
 */
export function isBuiltinProfile(name: string): boolean {
    return profileCatalog().isBuiltin(name);
}

// === Mutations ===

/**
 * Create a new profile — claude/, codex/ and an empty claude.json.
 * When settings are provided, also writes claude/settings.json.
 */
export function createProfile(name: string, settings?: ProfileSettings): void {
    profileCatalog().create(name, settings);
}

/**
 * Ensure a profile exists. If it's a built-in and doesn't exist, auto-create it.
 * Returns true if a new profile was created, false if it already existed.
 * Throws for unknown non-builtin profiles.
 */
export function ensureProfile(name: string): boolean {
    return profileCatalog().ensure(name);
}

/** Merge the requested permission default into the selected CCC credential copy. */
export function ensureClaudePermissionDefaults(claudeDirectory: string): void {
    const directory = resolve(claudeDirectory);
    const profileRoot = dirname(profilesDir());
    const mounted = process.env.container === "docker" && directory === resolve(join(homedir(), ".claude"));
    const root = mounted ? directory : profileRoot;
    const child = relative(root, directory);
    if ((!mounted && basename(directory) !== "claude") || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
        throw new Error("Claude settings must belong to the selected CCC profile.");
    }
    const file = join(directory, "settings.json");
    const key = createHash("sha256").update(file).digest("hex");
    const owner = process.getuid?.();
    const ordinary = (metadata: Stats) => !metadata.isSymbolicLink()
        && (owner === undefined || metadata.uid === owner)
        && (process.platform === "win32" || (metadata.mode & 0o022) === 0);
    const same = (left: Stats, right: Stats) => left.dev === right.dev && left.ino === right.ino
        && left.birthtimeMs === right.birthtimeMs;
    const directories: Array<[string, Stats]> = [];
    let current = root;
    for (const component of ["", ...child.split(sep).filter(Boolean)]) {
        current = component ? join(current, component) : current;
        const metadata = lstatSync(current);
        if (!ordinary(metadata) || !metadata.isDirectory()) throw new Error("Unsafe CCC Claude settings directory; preserved.");
        directories.push([current, metadata]);
    }
    const checkDirectories = () => {
        for (const [path, before] of directories) {
            const after = lstatSync(path);
            if (!ordinary(after) || !after.isDirectory() || !same(before, after)) throw new Error("CCC Claude settings directory changed; preserved.");
        }
    };
    const lockDirectory = resolve(locksDir());
    const lockChild = relative(profileRoot, lockDirectory);
    if (lockChild === ".." || lockChild.startsWith(`..${sep}`) || isAbsolute(lockChild)) throw new Error("Claude settings lock must remain in CCC state.");
    current = profileRoot;
    for (const component of ["", ...lockChild.split(sep).filter(Boolean)]) {
        checkDirectories();
        current = component ? join(current, component) : current;
        let metadata: Stats;
        try { metadata = lstatSync(current); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            if (current === profileRoot) throw new Error("CCC state root is unavailable for Claude settings; preserved.");
            // Every parent is qualified before creating the next private directory.
            try { mkdirSync(current, {mode: 0o700}); }
            catch (created) { if ((created as NodeJS.ErrnoException).code !== "EEXIST") throw created; }
            metadata = lstatSync(current);
        }
        if (!ordinary(metadata) || !metadata.isDirectory()) throw new Error("Unsafe CCC Claude settings lock directory; preserved.");
        directories.push([current, metadata]);
    }
    checkDirectories();
    withSharedMutationLock(join(lockDirectory, `claude-settings-${key}.lock`), () => {
        checkDirectories();
        let before: Stats | undefined;
        let settings: Record<string, unknown> = {};
        try {
            before = lstatSync(file);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (before) {
            if (!ordinary(before) || !before.isFile() || before.nlink !== 1) throw new Error("Unsafe CCC Claude settings file; preserved.");
            const descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
            try {
                const opened = fstatSync(descriptor);
                if (!ordinary(opened) || !opened.isFile() || opened.nlink !== 1 || !same(before, opened)) throw new Error("CCC Claude settings file changed; preserved.");
                try { settings = JSON.parse(readFileSync(descriptor, "utf8")) as Record<string, unknown>; }
                catch { throw new Error("Invalid CCC Claude settings JSON; preserved."); }
            } finally { closeSync(descriptor); }
        }
        if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("CCC Claude settings must be a JSON object; preserved.");
        const permissions = settings.permissions;
        if (permissions !== undefined && (!permissions || typeof permissions !== "object" || Array.isArray(permissions))) throw new Error("CCC Claude permissions must be a JSON object; preserved.");
        const existing = permissions as Record<string, unknown> | undefined;
        checkDirectories();
        let after: Stats | undefined;
        try { after = lstatSync(file); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (before ? !after || !ordinary(after) || !after.isFile() || after.nlink !== 1 || !same(before, after)
            || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs : after !== undefined) {
            throw new Error("CCC Claude settings changed before publication; preserved.");
        }
        if (existing?.defaultMode === "bypassPermissions") return;
        writeJsonFileAtomically(file, {...settings, permissions: {...existing, defaultMode: "bypassPermissions"}});
        checkDirectories();
    }, {waitMs: 5_000, reclaimStale: false});
}

/**
 * Remove a profile directory recursively.
 */
export function removeProfile(name: string): void {
    profileCatalog().remove(name);
}
