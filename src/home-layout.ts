// src/home-layout.ts - Host-side ~/.ccc layout and its one-time migration.
//
// ~/.ccc/
// ├── config.json                  settings (+ "remote": { <project-hash>: RemoteConfig })
// ├── profiles/<name>/{claude/, claude.json, codex/}   ("default" = no --profile)
// ├── run/{locks/, clipboard.port, clipboard.starting, clipboard-files/, bin/}
// ├── devices/, device-broker-private/                 (not managed here)
//
// Every path resolves per entry: the pre-layout location is used only while it
// still exists and the new one does not, so an unmigrated or partly migrated
// home keeps working (doc/common/REQ__ccc-home-layout.md).

import {
    closeSync,
    existsSync,
    lstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmdirSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { DEFAULT_PROFILE_NAME as domainDefaultProfileName, normalizeProfile as normalizeProfileRequest } from "./domain/profile-request.js";

import { createHomeLayoutPaths } from "./application/home/layout-paths.js";
import { createCccConfig } from "./application/home/config.js";

import { createHomeLayoutMigration } from "./application/home-layout-migration.js";
import type { ClipboardStartupSlot, HomeLayoutMigrationNotice, HomeLayoutMigrationOptions, HomeLayoutMigrationResult, ManagedHomeEntry } from "./ports/home-layout-migration.js";
export type { HomeLayoutMigrationOptions, HomeLayoutMigrationResult } from "./ports/home-layout-migration.js";

export const DEFAULT_PROFILE_NAME = domainDefaultProfileName;
const MIGRATION_LOCK_STALE_MS = 10 * 60 * 1000;

function exists(path: string): boolean {
    try {
        lstatSync(path);
        return true;
    } catch {
        return false;
    }
}

/** `undefined` and "default" both mean the default profile. */
export function normalizeProfile(profile?: string): string | undefined {
    return normalizeProfileRequest(profile);
}

// profiles/default is the no-profile account only when ccc made it so. Before
// this layout, "default" was an ordinary profile name, so a profiles/default
// without this marker may be another account and must never replace ~/.ccc/claude.
export const DEFAULT_PROFILE_MARKER = ".ccc-default-profile";
const DEFAULT_PROFILE_ENTRIES = ["claude", "claude.json", "codex"];

const layoutPaths = createHomeLayoutPaths({
    homeDirectory: () => homedir(),
    joinHostPath: (...parts) => join(...parts),
    entryExists: (path) => exists(path),
    createDirectory: (path, options) => {
        mkdirSync(path, options);
        return undefined;
    },
    writeMarker: (path, content, options) => {
        writeFileSync(path, content, options);
        return undefined;
    },
}, DEFAULT_PROFILE_NAME, DEFAULT_PROFILE_MARKER, DEFAULT_PROFILE_ENTRIES);

const cccConfig = createCccConfig({
    resolveConfigPath: () => configFile(),
    resolveHomePath: () => cccHome(),
    createDirectory: (path, options) => {
        mkdirSync(path, options);
        return undefined;
    },
    fileExists: (path) => existsSync(path),
    readText: (path) => readFileSync(path, "utf-8"),
    processId: () => process.pid,
    writeText: (path, data, options) => {
        writeFileSync(path, data as string, options);
        return undefined;
    },
    replaceFile: (tempPath, path) => {
        renameSync(tempPath, path);
        return undefined;
    },
});

export function cccHome(): string {
    return layoutPaths.cccHome();
}

export function profilesDir(): string {
    return layoutPaths.profilesDir();
}

export function defaultProfileDir(): string {
    return layoutPaths.defaultProfileDir();
}

/** Create profiles/default (0700) and mark it as the no-profile account. */
export function ensureDefaultProfileDir(): void {
    layoutPaths.ensureDefaultProfileDir();
}

export function profileClaudeDir(profile?: string): string {
    return layoutPaths.profileClaudeDir(profile);
}

export function profileClaudeJsonFile(profile?: string): string {
    return layoutPaths.profileClaudeJsonFile(profile);
}

export function profileCodexDir(profile?: string): string {
    return layoutPaths.profileCodexDir(profile);
}

export function runDir(): string {
    return layoutPaths.runDir();
}

export function locksDir(): string {
    return layoutPaths.locksDir();
}

export function clipboardFilesDir(): string {
    return layoutPaths.clipboardFilesDir();
}

export function helperBinDir(): string {
    return layoutPaths.helperBinDir();
}

/** Startup locks and new port files follow the session lock layout. Existing
 * port inodes remain discoverable independently during a partial migration. */
export function clipboardStateDir(): string {
    return layoutPaths.clipboardStateDir();
}

export function clipboardPortFile(): string {
    return layoutPaths.clipboardPortFile();
}

export function clipboardStartingLock(): string {
    return layoutPaths.clipboardStartingLock();
}

export function configFile(): string {
    return layoutPaths.configFile();
}

export function legacyRemoteConfigDir(): string {
    return layoutPaths.legacyRemoteConfigDir();
}

// === config.json ===

export function readCccConfig(): Record<string, unknown> {
    return cccConfig.read();
}

/**
 * Read-modify-write config.json atomically. An unparseable file is never
 * overwritten: the update throws and the file stays as it is.
 */
export function updateCccConfig(mutate: (config: Record<string, unknown>) => void): void {
    cccConfig.update(mutate);
}

// === Migration ===

// Entries that could not be migrated are reported once; the record lives in
// run/ so deleting run/ only repeats the notice.
function reportedConflictsFile(home: string): string {
    return join(home, "run", "layout-conflicts");
}

function readReportedConflicts(home: string): Set<string> {
    try {
        return new Set(readFileSync(reportedConflictsFile(home), "utf-8").split("\n").filter(Boolean));
    } catch {
        return new Set();
    }
}

function recordReportedConflicts(home: string, reported: Set<string>): void {
    try {
        mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
        writeFileSync(reportedConflictsFile(home), [...reported].sort().join("\n") + "\n", { mode: 0o600 });
    } catch {
        // Worst case the notice repeats on a later start.
    }
}

function acquireMigrationLock(lockPath: string, now: number): boolean {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            closeSync(openSync(lockPath, "wx", 0o600));
            return true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) return false;
            try {
                if (now - statSync(lockPath).mtimeMs < MIGRATION_LOCK_STALE_MS) return false;
                unlinkSync(lockPath);
            } catch {
                return false;
            }
        }
    }
    return false;
}

/**
 * Move a pre-layout ~/.ccc into the profile/run layout. Runs only while no
 * session is live, never copies or deletes credentials, and is idempotent.
 */
export function migrateHomeLayout(options: HomeLayoutMigrationOptions): HomeLayoutMigrationResult {
    const home = cccHome();
    const warn = options.warn ?? ((message: string) => console.error(message));
    const lockPath = join(home, ".layout-migration.lock");
    const legacyPath = (entry: ManagedHomeEntry): string => join(home, entry);
    const targetPath = (entry: ManagedHomeEntry): string => DEFAULT_PROFILE_ENTRIES.includes(entry)
        ? join(home, "profiles", DEFAULT_PROFILE_NAME, entry)
        : join(home, "run", entry);
    const startupPath = (slot: ClipboardStartupSlot): string => join(slot.namespace === "legacy" ? home : join(home, "run"), slot.name);
    const remoteDirectory = join(home, "remote");
    function report(notice: HomeLayoutMigrationNotice): undefined {
        switch (notice.kind) {
            case "clipboard-conflict":
                warn(`ccc: both ${legacyPath("clipboard.port")} and ${targetPath("clipboard.port")} exist; layout migration deferred without replacing either clipboard file.`);
                break;
            case "unsafe-clipboard":
                warn(`ccc: unsafe clipboard state at ${notice.namespace === "legacy" ? legacyPath("clipboard.port") : targetPath("clipboard.port")}; layout migration deferred.`);
                break;
            case "default-profile-renamed":
                warn(`ccc: your profile named "default" is now "${notice.name}" (use CCC_PROFILE=${notice.name}); "default" is the account used without CCC_PROFILE.`);
                break;
            case "profile-prepare-failed":
                warn(`ccc: could not prepare ${defaultProfileDir()} (${(notice.error as NodeJS.ErrnoException).code ?? "error"}); still using the old paths, will retry on a later start.`);
                break;
            case "entry-conflict":
                warn(`ccc: both ${legacyPath(notice.entry)} and ${targetPath(notice.entry)} exist; using ${targetPath(notice.entry)} and leaving the old one untouched.`);
                break;
            case "clipboard-move-failed":
                warn(`ccc: could not move ${legacyPath("clipboard.port")}; layout migration deferred without changing other paths.`);
                break;
            case "entry-move-failed":
                warn(`ccc: could not move ${legacyPath(notice.entry)} to ${targetPath(notice.entry)} (${(notice.error as NodeJS.ErrnoException).code ?? "error"}); still using the old path, will retry on a later start.`);
                break;
            case "invalid-remote":
                warn(`ccc: kept ${join(remoteDirectory, notice.name)} (not valid JSON); it is not used.`);
                break;
            case "remote-merge-failed":
                warn(`ccc: could not merge ${remoteDirectory} into config.json (${(notice.error as Error).message}); remote configs are still read from there.`);
                break;
        }
        return undefined;
    }
    return createHomeLayoutMigration<{ path: string; dev: number; ino: number }>({
        homeExists: () => exists(home),
        readReportedConflicts: () => readReportedConflicts(home),
        defaultProfileExists: () => exists(join(home, "profiles", DEFAULT_PROFILE_NAME)),
        defaultProfileMarkerExists: () => exists(join(home, "profiles", DEFAULT_PROFILE_NAME, DEFAULT_PROFILE_MARKER)),
        profileNameExists: (name) => exists(join(home, "profiles", name)),
        legacyEntryExists: (entry) => exists(legacyPath(entry)),
        targetEntryExists: (entry) => exists(targetPath(entry)),
        startupSlotExists: (slot) => exists(startupPath(slot)),
        clipboardPortIsRegular: (namespace) => lstatSync(namespace === "legacy" ? legacyPath("clipboard.port") : targetPath("clipboard.port")).isFile(),
        listLegacyRemoteNames: () => {
            try { return readdirSync(remoteDirectory); } catch { return []; }
        },
        legacyRemoteDirectoryIsEmpty: () => {
            try { return readdirSync(remoteDirectory).length === 0; } catch { return false; }
        },
        remoteEntryKey: (name) => join("remote", name),
        readLegacyRemoteText: (name) => readFileSync(join(remoteDirectory, name), "utf-8"),
        acquireMigrationLock: (now) => acquireMigrationLock(lockPath, now),
        releaseMigrationLock: () => {
            try { unlinkSync(lockPath); } catch { /* Already gone. */ }
            return undefined;
        },
        ensureRuntimeDirectory: () => {
            mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
            return undefined;
        },
        claimStartupSlot: (slot) => {
            const path = startupPath(slot);
            closeSync(openSync(path, "wx", 0o600));
            const identity = lstatSync(path);
            return { path, dev: identity.dev, ino: identity.ino };
        },
        releaseStartupReceipt: (held) => {
            try {
                const current = lstatSync(held.path);
                if (current.dev === held.dev && current.ino === held.ino) unlinkSync(held.path);
            } catch { /* Removed by its owner or another process; never remove a replacement. */ }
            return undefined;
        },
        renameDefaultProfile: (name) => {
            renameSync(join(home, "profiles", DEFAULT_PROFILE_NAME), join(home, "profiles", name));
            return undefined;
        },
        ensureDefaultProfileDirectory: () => {
            ensureDefaultProfileDir();
            return undefined;
        },
        moveEntry: (entry) => {
            const next = targetPath(entry);
            mkdirSync(dirname(next), { recursive: true, mode: 0o700 });
            renameSync(legacyPath(entry), next);
            return undefined;
        },
        updateConfig: (mutate) => {
            updateCccConfig(mutate);
            return undefined;
        },
        removeLegacyRemoteFile: (name) => {
            unlinkSync(join(remoteDirectory, name));
            return undefined;
        },
        removeEmptyLegacyRemoteDirectory: () => {
            try { rmdirSync(remoteDirectory); } catch { /* Not empty (kept files) or already gone. */ }
            return undefined;
        },
        recordReportedConflicts: (reported) => {
            recordReportedConflicts(home, reported);
            return undefined;
        },
        hasLiveSessions: () => options.hasLiveSessions(),
        hasContainerMounts: () => options.hasContainerMounts?.() ?? false,
        currentTime: () => (options.now ?? Date.now)(),
        report,
    })();
}
