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

export const DEFAULT_PROFILE_NAME = domainDefaultProfileName;
const MIGRATION_LOCK_STALE_MS = 10 * 60 * 1000;

export function cccHome(): string {
    return join(homedir(), ".ccc");
}

function exists(path: string): boolean {
    try {
        lstatSync(path);
        return true;
    } catch {
        return false;
    }
}

function resolveEntry(legacyRel: string, nextRel: string): string {
    const home = cccHome();
    const legacy = join(home, legacyRel);
    const next = join(home, nextRel);
    return exists(legacy) && !exists(next) ? legacy : next;
}

/** `undefined` and "default" both mean the default profile. */
export function normalizeProfile(profile?: string): string | undefined {
    return normalizeProfileRequest(profile);
}

export function profilesDir(): string {
    return join(cccHome(), "profiles");
}

// profiles/default is the no-profile account only when ccc made it so. Before
// this layout, "default" was an ordinary profile name, so a profiles/default
// without this marker may be another account and must never replace ~/.ccc/claude.
export const DEFAULT_PROFILE_MARKER = ".ccc-default-profile";

export function defaultProfileDir(): string {
    return join(profilesDir(), DEFAULT_PROFILE_NAME);
}

function hasDefaultProfileMarker(): boolean {
    return exists(join(defaultProfileDir(), DEFAULT_PROFILE_MARKER));
}

/** Create profiles/default (0700) and mark it as the no-profile account. */
export function ensureDefaultProfileDir(): void {
    mkdirSync(defaultProfileDir(), { recursive: true, mode: 0o700 });
    const marker = join(defaultProfileDir(), DEFAULT_PROFILE_MARKER);
    if (!exists(marker)) writeFileSync(marker, "", { mode: 0o600 });
}

const DEFAULT_PROFILE_ENTRIES = ["claude", "claude.json", "codex"];

function hasLegacyDefaultEntries(): boolean {
    return DEFAULT_PROFILE_ENTRIES.some((entry) => exists(join(cccHome(), entry)));
}

function profileEntry(profile: string | undefined, entry: string): string {
    const named = normalizeProfile(profile);
    if (named) return join(profilesDir(), named, entry);
    const legacy = join(cccHome(), entry);
    const next = join(defaultProfileDir(), entry);
    // Unmarked: a pre-layout home keeps every default entry on its old path (even
    // one that does not exist yet); only a fresh home starts in profiles/default.
    if (!hasDefaultProfileMarker()) return hasLegacyDefaultEntries() ? legacy : next;
    return exists(legacy) && !exists(next) ? legacy : next;
}

export function profileClaudeDir(profile?: string): string {
    return profileEntry(profile, "claude");
}

export function profileClaudeJsonFile(profile?: string): string {
    return profileEntry(profile, "claude.json");
}

export function profileCodexDir(profile?: string): string {
    return profileEntry(profile, "codex");
}

export function runDir(): string {
    return join(cccHome(), "run");
}

export function locksDir(): string {
    return resolveEntry("locks", join("run", "locks"));
}

export function clipboardFilesDir(): string {
    return resolveEntry("clipboard-files", join("run", "clipboard-files"));
}

export function helperBinDir(): string {
    return resolveEntry("bin", join("run", "bin"));
}

/** Startup locks and new port files follow the session lock layout. Existing
 * port inodes remain discoverable independently during a partial migration. */
export function clipboardStateDir(): string {
    return locksDir() === join(cccHome(), "locks") ? cccHome() : runDir();
}

export function clipboardPortFile(): string {
    const legacy = join(cccHome(), "clipboard.port");
    if (exists(legacy)) return legacy;
    const migrated = join(runDir(), "clipboard.port");
    // Retain an already moved inode after a partial migration. If no port file
    // exists yet (or a legacy daemon removed it), follow the active lock layout.
    return exists(migrated) ? migrated : join(clipboardStateDir(), "clipboard.port");
}

export function clipboardStartingLock(): string {
    return join(clipboardStateDir(), "clipboard.starting.v2");
}

export function configFile(): string {
    return join(cccHome(), "config.json");
}

export function legacyRemoteConfigDir(): string {
    return join(cccHome(), "remote");
}

// === config.json ===

export function readCccConfig(): Record<string, unknown> {
    const file = configFile();
    if (!existsSync(file)) return {};
    try {
        const parsed = JSON.parse(readFileSync(file, "utf-8"));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
        return {};
    }
}

/**
 * Read-modify-write config.json atomically. An unparseable file is never
 * overwritten: the update throws and the file stays as it is.
 */
export function updateCccConfig(mutate: (config: Record<string, unknown>) => void): void {
    const file = configFile();
    mkdirSync(cccHome(), { recursive: true, mode: 0o700 });
    let config: Record<string, unknown> = {};
    if (existsSync(file)) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(readFileSync(file, "utf-8"));
        } catch {
            parsed = null;
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error(`${file} is not a valid JSON object; fix or remove it`);
        }
        config = parsed as Record<string, unknown>;
    }
    mutate(config);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(config, null, 2), { mode: 0o600 });
    renameSync(temp, file);
}

// === Migration ===

export interface HomeLayoutMigrationOptions {
    /** True when a ccc session may still be using the pre-layout paths. */
    hasLiveSessions: () => boolean;
    /** True if any stopped/running container still references legacy managed paths. */
    hasContainerMounts?: () => boolean;
    /** Deprecated: retained for callers; normal clipboard startup owns retirement. */
    retireLegacyClipboard?: (portFile: string) => void;
    warn?: (message: string) => void;
    now?: () => number;
}

export type HomeLayoutMigrationResult =
    | { status: "not-needed" | "busy" | "sessions-active" | "mounts-active" }
    | { status: "migrated"; moved: string[]; failed: string[] };

const MOVES: ReadonlyArray<readonly [string, string]> = [
    ["clipboard.port", join("run", "clipboard.port")],
    ...DEFAULT_PROFILE_ENTRIES.map((entry) => [entry, join("profiles", DEFAULT_PROFILE_NAME, entry)] as const),
    ["locks", join("run", "locks")],
    ["clipboard-files", join("run", "clipboard-files")],
    ["bin", join("run", "bin")],
];
const CLIPBOARD_LOCK_NAMES = ["clipboard.starting", "clipboard.starting.v2"];

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

function legacyRemoteFiles(home: string): string[] {
    try {
        return readdirSync(join(home, "remote")).filter((name) => name.endsWith(".json"));
    } catch {
        return [];
    }
}

/** A profiles/default that ccc did not mark while pre-layout credentials exist
 * is a profile the user named "default" before this layout. */
function unmarkedDefaultProfile(home: string): boolean {
    return exists(join(home, "profiles", DEFAULT_PROFILE_NAME))
        && !exists(join(home, "profiles", DEFAULT_PROFILE_NAME, DEFAULT_PROFILE_MARKER))
        && DEFAULT_PROFILE_ENTRIES.some((entry) => exists(join(home, entry)));
}

function pendingWork(home: string, reported: Set<string>): boolean {
    if (unmarkedDefaultProfile(home)) return true;
    for (const [legacyRel, nextRel] of MOVES) {
        if (!exists(join(home, legacyRel))) continue;
        if (!exists(join(home, nextRel)) || !reported.has(legacyRel)) return true;
    }
    if (CLIPBOARD_LOCK_NAMES.some((name) => exists(join(home, name)))) return true;
    const remote = legacyRemoteFiles(home);
    if (remote.some((name) => !reported.has(join("remote", name)))) return true;
    try {
        return readdirSync(join(home, "remote")).length === 0;
    } catch {
        return false;
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

function setAsideUnmarkedDefaultProfile(home: string, warn: (message: string) => void): void {
    const current = join(home, "profiles", DEFAULT_PROFILE_NAME);
    let name = "default-pre-layout";
    for (let suffix = 2; exists(join(home, "profiles", name)); suffix++) name = `default-pre-layout-${suffix}`;
    renameSync(current, join(home, "profiles", name));
    warn(`ccc: your profile named "default" is now "${name}" (use CCC_PROFILE=${name}); "default" is the account used without CCC_PROFILE.`);
}

function mergeLegacyRemoteConfigs(home: string, reported: Set<string>, warn: (message: string) => void): string[] {
    const dir = join(home, "remote");
    const merged: string[] = [];
    const parsed: Record<string, unknown> = {};
    for (const name of legacyRemoteFiles(home)) {
        try {
            parsed[name.slice(0, -".json".length)] = JSON.parse(readFileSync(join(dir, name), "utf-8"));
            merged.push(name);
        } catch {
            const key = join("remote", name);
            if (!reported.has(key)) {
                warn(`ccc: kept ${join(dir, name)} (not valid JSON); it is not used.`);
                reported.add(key);
            }
        }
    }
    if (merged.length > 0) {
        // Throws on an unparseable config.json; the legacy files then stay and keep being read.
        updateCccConfig((config) => {
            const remote = config.remote && typeof config.remote === "object" && !Array.isArray(config.remote)
                ? config.remote as Record<string, unknown>
                : {};
            for (const [hash, value] of Object.entries(parsed)) {
                if (!(hash in remote)) remote[hash] = value;
            }
            config.remote = remote;
        });
        for (const name of merged) unlinkSync(join(dir, name));
    }
    try {
        rmdirSync(dir);
    } catch {
        // Not empty (kept files) or already gone.
    }
    return merged.map((name) => join("remote", name));
}

/**
 * Move a pre-layout ~/.ccc into the profile/run layout. Runs only while no
 * session is live, never copies or deletes credentials, and is idempotent.
 */
export function migrateHomeLayout(options: HomeLayoutMigrationOptions): HomeLayoutMigrationResult {
    const home = cccHome();
    const warn = options.warn ?? ((message: string) => console.error(message));
    if (!exists(home)) return { status: "not-needed" };
    const reported = readReportedConflicts(home);
    if (!pendingWork(home, reported)) return { status: "not-needed" };

    const lockPath = join(home, ".layout-migration.lock");
    if (!acquireMigrationLock(lockPath, (options.now ?? Date.now)())) return { status: "busy" };
    const reportedBefore = reported.size;
    const clipboardLocks: Array<{ path: string; dev: number; ino: number }> = [];
    try {
        if (options.hasLiveSessions()) return { status: "sessions-active" };
        if (options.hasContainerMounts?.()) return { status: "mounts-active" };
        // Lock both namespaces and both protocol generations before moving paths.
        // Never reclaim a startup lock here: its owner may still publish or retire.
        const startupPaths = [home, join(home, "run")].flatMap(dir => CLIPBOARD_LOCK_NAMES.map(name => join(dir, name)));
        if (startupPaths.some(exists)) return { status: "busy" };
        const legacyPort = join(home, "clipboard.port");
        const nextPort = join(home, "run", "clipboard.port");
        if (exists(legacyPort) && exists(nextPort)) {
            warn(`ccc: both ${legacyPort} and ${nextPort} exist; layout migration deferred without replacing either clipboard file.`);
            return { status: "busy" };
        }
        for (const path of [legacyPort, nextPort]) {
            if (exists(path) && !lstatSync(path).isFile()) {
                warn(`ccc: unsafe clipboard state at ${path}; layout migration deferred.`);
                return { status: "busy" };
            }
        }
        mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
        for (const path of startupPaths) {
            try {
                closeSync(openSync(path, "wx", 0o600));
                const identity = lstatSync(path);
                clipboardLocks.push({ path, dev: identity.dev, ino: identity.ino });
            } catch {
                return { status: "busy" };
            }
        }
        const moved: string[] = [];
        const failed: string[] = [];
        try {
            if (unmarkedDefaultProfile(home)) setAsideUnmarkedDefaultProfile(home, warn);
            if (DEFAULT_PROFILE_ENTRIES.some((entry) => exists(join(home, entry)))) ensureDefaultProfileDir();
        } catch (error) {
            warn(`ccc: could not prepare ${defaultProfileDir()} (${(error as NodeJS.ErrnoException).code ?? "error"}); still using the old paths, will retry on a later start.`);
            return { status: "migrated", moved, failed: [...DEFAULT_PROFILE_ENTRIES] };
        }
        for (const [legacyRel, nextRel] of MOVES) {
            const legacy = join(home, legacyRel);
            const next = join(home, nextRel);
            if (!exists(legacy)) continue;
            if (exists(next)) {
                if (!reported.has(legacyRel)) {
                    warn(`ccc: both ${legacy} and ${next} exist; using ${next} and leaving the old one untouched.`);
                    reported.add(legacyRel);
                }
                continue;
            }
            try {
                mkdirSync(dirname(next), { recursive: true, mode: 0o700 });
                renameSync(legacy, next);
                moved.push(legacyRel);
            } catch (error) {
                failed.push(legacyRel);
                if (legacyRel === "clipboard.port") {
                    warn(`ccc: could not move ${legacy}; layout migration deferred without changing other paths.`);
                    return { status: "migrated", moved, failed };
                }
                warn(`ccc: could not move ${legacy} to ${next} (${(error as NodeJS.ErrnoException).code ?? "error"}); still using the old path, will retry on a later start.`);
            }
        }
        try {
            moved.push(...mergeLegacyRemoteConfigs(home, reported, warn));
        } catch (error) {
            failed.push("remote");
            warn(`ccc: could not merge ${join(home, "remote")} into config.json (${(error as Error).message}); remote configs are still read from there.`);
        }
        return { status: "migrated", moved, failed };
    } finally {
        for (const held of clipboardLocks) {
            try {
                const current = lstatSync(held.path);
                if (current.dev === held.dev && current.ino === held.ino) unlinkSync(held.path);
            } catch { /* Removed by its owner or another process; never remove a replacement. */ }
        }
        if (reported.size !== reportedBefore) recordReportedConflicts(home, reported);
        try {
            unlinkSync(lockPath);
        } catch {
            // Already gone.
        }
    }
}
