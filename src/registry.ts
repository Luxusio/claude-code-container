// src/registry.ts — global project registry at ~/.ccc/registry.json
// Provides atomic, concurrency-safe read/write of project metadata.

import * as fs from "fs";
import * as path from "path";
import { DATA_DIR, getProjectId } from "./utils.js";

// ============================================================
// Types
// ============================================================

export interface RegistryProject {
    id: string;
    host_path: string;
    kind: "source" | "worktree";
    source: string | null;      // null for source, parent id for worktree
    branch: string | null;      // null for source, branch slug for worktree
    worktrees: string[];         // populated only on source entries
    first_seen: string;         // ISO8601
    last_seen: string;          // ISO8601
}

export interface Registry {
    schema_version: 1;
    updated_at: string;         // ISO8601
    projects: Record<string, RegistryProject>;
}

export interface UpsertInput {
    id: string;
    host_path: string;
    kind: "source" | "worktree";
    source?: string | null;
    branch?: string | null;
}

// ============================================================
// Path helpers
// ============================================================

export function getRegistryPath(): string {
    const override = process.env.CCC_REGISTRY_PATH;
    if (override && override.length > 0) return override;
    return path.join(DATA_DIR, "registry.json");
}

export function getRegistryLockPath(): string {
    return `${getRegistryPath()}.lock`;
}

// ============================================================
// loadRegistry — tolerant reader
// ============================================================

let _warnedParseFailure = false;

export function loadRegistry(): Registry {
    const empty: Registry = {
        schema_version: 1,
        updated_at: new Date().toISOString(),
        projects: {},
    };

    try {
        const raw = fs.readFileSync(getRegistryPath(), "utf8").trim();
        if (!raw) return empty;

        const parsed = JSON.parse(raw) as Partial<Registry>;
        if (!parsed || typeof parsed !== "object" || !parsed.projects) return empty;
        return parsed as Registry;
    } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return empty;
        // JSON parse failure or other I/O
        if (!_warnedParseFailure) {
            _warnedParseFailure = true;
            console.warn("[ccc] registry.json parse failed; starting fresh:", err);
        }
        return empty;
    }
}

// ============================================================
// upsertProject — concurrency-safe write
// ============================================================

const LOCK_POLL_BASE_MS = 10;
const LOCK_POLL_CAP_MS = 200;
const LOCK_STALE_MS = 30_000;

function defaultLockTimeoutMs(): number {
    const override = process.env.CCC_REGISTRY_LOCK_TIMEOUT_MS;
    if (override) {
        const n = parseInt(override, 10);
        if (!isNaN(n) && n > 0) return n;
    }
    return 5_000;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquire an exclusive lock by atomically creating the lockfile with
 * content already filled in. Uses a tmp file + link() to ensure the
 * lockfile is either absent or fully written — eliminating the
 * empty-content race window.
 *
 * Returns true on success. Throws only on non-EEXIST I/O errors.
 * Returns false if another process holds the lock (EEXIST).
 */
async function tryAcquireLock(lockPath: string): Promise<boolean> {
    const content = JSON.stringify({ pid: process.pid, ts: Date.now() });
    const tmp = `${lockPath}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
    try {
        await fs.promises.writeFile(tmp, content, { flag: "w" });
        try {
            await fs.promises.link(tmp, lockPath);
            return true;
        } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
            throw err;
        }
    } finally {
        await fs.promises.unlink(tmp).catch(() => { /* ignore */ });
    }
}

/**
 * Returns true if the lock file is positively stale (and unlinks it).
 *
 * A lock is stale only when we have EVIDENCE of staleness:
 *   - mtime (from recorded ts) older than LOCK_STALE_MS, OR
 *   - recorded pid is dead (process.kill(pid, 0) → ESRCH).
 *
 * Unreadable / unparseable / empty lock content is NOT treated as
 * stale. That window can briefly exist if another writer is in the
 * middle of creating its lockfile (this lockfile implementation uses
 * writeFile+link which is atomic, so the window is closed — but the
 * conservative behavior is still safer to guarantee correctness under
 * any filesystem edge case).
 */
async function reclaimStaleLock(lockPath: string): Promise<boolean> {
    let raw: string;
    try {
        raw = await fs.promises.readFile(lockPath, "utf8");
    } catch (err: unknown) {
        // Gone already — "reclaimed" by the absence. Next open will retry.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
        return false;
    }

    let data: { pid?: number; ts?: number };
    try {
        data = JSON.parse(raw);
    } catch {
        // Malformed / empty — NOT stale. Back off and retry.
        return false;
    }

    const now = Date.now();
    const ts = typeof data.ts === "number" ? data.ts : 0;
    const pid = typeof data.pid === "number" ? data.pid : 0;

    const staleByAge = ts > 0 && (now - ts) > LOCK_STALE_MS;
    let staleByPid = false;
    if (!staleByAge && pid > 0) {
        try {
            process.kill(pid, 0);
        } catch (e: unknown) {
            if ((e as NodeJS.ErrnoException).code === "ESRCH") {
                staleByPid = true;
            }
        }
    }

    if (staleByAge || staleByPid) {
        try { await fs.promises.unlink(lockPath); } catch { /* ignore */ }
        return true;
    }
    return false;
}

export async function upsertProject(input: UpsertInput): Promise<void> {
    const registryPath = getRegistryPath();
    const lockPath = getRegistryLockPath();

    // Ensure DATA_DIR exists
    try {
        await fs.promises.mkdir(path.dirname(registryPath), { recursive: true });
    } catch {
        // ignore
    }

    const timeoutMs = defaultLockTimeoutMs();
    const deadline = Date.now() + timeoutMs;

    let attempt = 0;
    let acquired = false;

    // Acquire lock with exponential backoff
    while (!acquired) {
        let gotIt = false;
        try {
            gotIt = await tryAcquireLock(lockPath);
        } catch (err: unknown) {
            console.warn("[ccc] registry lock open failed:", err);
            return;
        }

        if (gotIt) {
            acquired = true;
            break;
        }

        // Lock is held — check for stale
        try {
            const reclaimed = await reclaimStaleLock(lockPath);
            if (reclaimed) {
                // Retry immediately after reclaim
                continue;
            }
        } catch {
            // ignore, fall through to backoff
        }

        if (Date.now() >= deadline) {
            console.warn("[ccc] registry lock timeout; skipping upsert");
            return;
        }

        // Exponential backoff with jitter, capped
        const backoff = Math.min(LOCK_POLL_BASE_MS * Math.pow(2, attempt), LOCK_POLL_CAP_MS);
        const jitter = Math.random() * 30;
        await sleep(backoff + jitter);
        attempt++;
    }

    // ---- Critical section ----
    try {
        const now = new Date().toISOString();
        const registry = loadRegistry();

        // Upsert the primary entry (source or worktree)
        const existing = registry.projects[input.id];
        const entry: RegistryProject = {
            id: input.id,
            host_path: input.host_path,
            kind: input.kind,
            source: input.source ?? null,
            branch: input.branch ?? null,
            worktrees: existing?.worktrees ?? [],
            first_seen: existing?.first_seen ?? now,
            last_seen: now,
        };
        registry.projects[input.id] = entry;

        // For worktree entries: also stub-upsert the source entry
        if (input.kind === "worktree" && input.source) {
            const sourceId = input.source;
            const sourceExisting = registry.projects[sourceId];
            const sourceEntry: RegistryProject = {
                id: sourceId,
                host_path: sourceExisting?.host_path ?? "",  // stub if unknown
                kind: "source",
                source: null,
                branch: null,
                worktrees: sourceExisting?.worktrees ?? [],
                first_seen: sourceExisting?.first_seen ?? now,
                last_seen: sourceExisting?.last_seen ?? now,
            };
            // Dedup worktree id in source's worktrees array
            if (!sourceEntry.worktrees.includes(input.id)) {
                sourceEntry.worktrees = [...sourceEntry.worktrees, input.id];
            }
            registry.projects[sourceId] = sourceEntry;
        }

        registry.updated_at = now;

        // Atomic write: tmp file + rename
        const rand = Math.random().toString(36).slice(2, 10);
        const tmpPath = `${registryPath}.tmp.${process.pid}.${rand}`;

        const content = JSON.stringify(registry, null, 2);
        const tmpHandle = await fs.promises.open(tmpPath, "w");
        try {
            await tmpHandle.write(content);
            await tmpHandle.datasync();
        } finally {
            await tmpHandle.close();
        }
        await fs.promises.rename(tmpPath, registryPath);
    } catch (err) {
        console.warn("[ccc] registry write failed:", err);
    } finally {
        // Release lock
        try { await fs.promises.unlink(lockPath); } catch { /* ignore */ }
    }
}

// ============================================================
// deriveRegistryEntries — pure helper for index.ts call site
// (also used by tests for AC-004 coverage)
// ============================================================

export interface UpsertInputWithCheck extends UpsertInput {
    // same shape, just aliased for clarity
}

/**
 * Given a resolved host project path, return the UpsertInput array
 * (0, 1, or 2 entries) that main() should upsert into the registry.
 *
 * Detection logic:
 *   - If basename contains "--" AND a sibling dir (basename split at first "--")
 *     exists on disk, treat as worktree → returns [worktreeEntry, sourceEntry].
 *   - Otherwise → returns [sourceEntry].
 *
 * The fs existence check is done via `siblingExists` which defaults to
 * fs.existsSync but can be stubbed in tests.
 */
export function deriveRegistryEntries(
    projectPath: string,
    siblingExists: (p: string) => boolean = (p) => fs.existsSync(p),
): UpsertInput[] {
    const base = path.basename(projectPath);
    const parent = path.dirname(projectPath);
    const sepIdx = base.indexOf("--");

    if (sepIdx > 0) {
        const sourceBasename = base.slice(0, sepIdx);
        const sourcePath = path.join(parent, sourceBasename);
        if (siblingExists(sourcePath)) {
            const branch = base.slice(sepIdx + 2); // after "--"
            const sourceId = getProjectId(sourcePath);
            const worktreeId = getProjectId(projectPath);
            return [
                {
                    id: worktreeId,
                    host_path: projectPath,
                    kind: "worktree",
                    source: sourceId,
                    branch,
                },
                {
                    id: sourceId,
                    host_path: sourcePath,
                    kind: "source",
                },
            ];
        }
    }

    return [
        {
            id: getProjectId(projectPath),
            host_path: projectPath,
            kind: "source",
        },
    ];
}
