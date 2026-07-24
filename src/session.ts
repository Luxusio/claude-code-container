import { spawnSync } from "child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { randomBytes } from "crypto";
import { getProjectId, DATA_DIR } from "./utils.js";
import { saveClaudeBinaryToVolume } from "./container-setup.js";
import { runtimeCli } from "./container-runtime.js";
import { cleanupOwnerDevices } from "./device-lab-admin.js";
import { withSharedMutationLock, withSharedMutationLockAsync } from "./device-lab-shared-state.js";
import { processStartToken, sessionLockLiveness } from "./session-lock-liveness.js";

const locksDir = join(DATA_DIR, "locks");

function containerLifecycleLock(containerPrefix: string): string {
    return join(locksDir, `${containerPrefix}.container-lifecycle.guard`);
}

function projectFamilyLifecycleLock(projectId: string): string {
    return join(locksDir, `${projectId}.project-family-lifecycle.guard`);
}

function ensureLocksDirectory(): void {
    mkdirSync(locksDir, { recursive: true, mode: 0o700 });
    const observed = lstatSync(locksDir);
    if (!observed.isDirectory() || observed.isSymbolicLink()) {
        throw new Error("CCC session lock path must be a real directory");
    }
    if (process.platform !== "win32") chmodSync(locksDir, 0o700);
}

export function withContainerLifecycleLock<T>(containerPrefix: string, operation: () => T): T {
    ensureLocksDirectory();
    return withSharedMutationLock(containerLifecycleLock(containerPrefix), operation, { waitMs: 180_000 });
}

export function withProjectFamilyLifecycleLock<T>(projectId: string, operation: () => T): T {
    ensureLocksDirectory();
    return withSharedMutationLock(projectFamilyLifecycleLock(projectId), operation, { waitMs: 180_000 });
}

export async function withProjectFamilyLifecycleLockAsync<T>(projectId: string, operation: () => Promise<T> | T): Promise<T> {
    ensureLocksDirectory();
    return withSharedMutationLockAsync(projectFamilyLifecycleLock(projectId), operation, { waitMs: 180_000 });
}

export async function withContainerLifecycleLockAsync<T>(containerPrefix: string, operation: () => Promise<T> | T): Promise<T> {
    ensureLocksDirectory();
    return withSharedMutationLockAsync(containerLifecycleLock(containerPrefix), operation, { waitMs: 180_000 });
}

// Module state - managed via getter/setter for testability
let currentSessionLockFile: string | null = null;
let currentProjectPath: string | null = null;
let currentProfile: string | undefined = undefined;
let currentToolName: string | null = null;
let currentContainerId: string | null = null;

export function setSession(lockFile: string, projectPath: string, profile?: string, toolName?: string): void {
    currentSessionLockFile = lockFile;
    currentProjectPath = projectPath;
    currentProfile = profile;
    currentToolName = toolName ?? "claude";
    currentContainerId = null;
}

export function setSessionContainerId(containerId: string | null): void {
    currentContainerId = containerId;
}

export function getCurrentSession(): { lockFile: string | null; projectPath: string | null; profile?: string; toolName: string | null } {
    return { lockFile: currentSessionLockFile, projectPath: currentProjectPath, profile: currentProfile, toolName: currentToolName };
}

export function clearSession(): void {
    currentSessionLockFile = null;
    currentProjectPath = null;
    currentProfile = undefined;
    currentToolName = null;
    currentContainerId = null;
    cleanedUp = false;
}

export function createSessionLock(projectId: string, profile?: string): string {
    ensureLocksDirectory();
    const sessionId = randomBytes(16).toString("hex");
    const prefix = profile ? `${projectId}--p--${profile}` : projectId;
    const lockFile = join(locksDir, `${prefix}--${sessionId}.lock`);
    withContainerLifecycleLock(prefix, () => {
        const startToken = processStartToken(process.pid);
        const record = startToken
            ? JSON.stringify({ version: 2, pid: process.pid, startToken })
            : String(process.pid);
        writeFileSync(lockFile, record, { mode: 0o600, flag: "wx" });
    });
    return lockFile;
}

export function removeSessionLock(lockFile: string): void {
    try {
        if (existsSync(lockFile)) {
            unlinkSync(lockFile);
        }
    } catch {
        // Ignore errors during cleanup
    }
}

/**
 * Get active sessions for a container prefix.
 * containerPrefix is the full container name without trailing "--".
 * For non-profile containers (e.g. "projectId"), only returns files that match
 * `${containerPrefix}--<sessionId>.lock` and do NOT contain "--p--" after the prefix.
 * For profile containers (e.g. "projectId--p--work"), returns files that match
 * `${containerPrefix}--<sessionId>.lock`.
 */
export function getActiveSessionsForContainer(containerPrefix: string): string[] {
    let entries: string[];
    try {
        ensureLocksDirectory();
        entries = readdirSync(locksDir);
    } catch (error) {
        // The directory was just established above. Any observation failure,
        // including a concurrent ENOENT, must not authorize container cleanup.
        throw error;
    }
    return filterLiveSessionLocks(sessionLockClaimsForContainer(entries, containerPrefix));
}

function sessionLockClaimsForContainer(entries: string[], containerPrefix: string): string[] {
    const isProfilePrefix = containerPrefix.includes("--p--");
    return entries.filter((f) => {
        if (!f.endsWith(".lock")) return false;

        // New format: prefix--sessionId.lock
        if (f.startsWith(`${containerPrefix}--`)) {
            if (isProfilePrefix) {
                const sessionId = f.slice(containerPrefix.length + 2, -".lock".length);
                // Profile names may contain "--". Only the single session-id
                // segment belongs to this exact profile prefix.
                return sessionId.length > 0 && !sessionId.includes("--");
            } else {
                const afterPrefix = f.slice(containerPrefix.length + 2);
                if (afterPrefix.startsWith("p--")) return false;
            }
            return true;
        }

        // Legacy fallback: prefix-sessionId.lock (single dash, non-profile only)
        if (!isProfilePrefix && f.startsWith(`${containerPrefix}-`)) {
            // Make sure it's not actually a new-format file with --
            const afterPrefix = f.slice(containerPrefix.length + 1);
            if (!afterPrefix.startsWith("-")) return true;
        }

        return false;
    });
}

/**
 * Return raw ownership claims without PID/start-token inference.
 * Automatic container shutdown must not turn an imperfect Windows process
 * observation into permission to terminate another session.
 */
export function getSessionLockClaimsForContainer(containerPrefix: string): string[] {
    ensureLocksDirectory();
    return sessionLockClaimsForContainer(readdirSync(locksDir), containerPrefix);
}

export function getSessionLockClaimsForProjectFamily(projectId: string): string[] {
    ensureLocksDirectory();
    return readdirSync(locksDir).filter((entry) =>
        entry.endsWith(".lock") && entry.startsWith(`${projectId}--`),
    );
}

function filterLiveSessionLocks(locks: string[]): string[] {
    return locks.filter((f) => {
        const lockPath = join(locksDir, f);
        try {
            const content = readFileSync(lockPath, "utf-8").trim();
            const liveness = sessionLockLiveness(content);
            if (liveness === "stale") {
                try { unlinkSync(lockPath); } catch { /* ignore */ }
                return false;
            }
            // Unknown observation is not proof that the owner exited.
            return true;
        } catch {
            // Failure to read a candidate lock is not proof that its owner is
            // dead. Preserve it and fail closed so transient Windows sharing,
            // antivirus, or permission errors cannot authorize stop/rm.
            return true;
        }
    });
}

/**
 * Return every live session for one project path, including all profile
 * containers. This broader query is reserved for removing the project path.
 */
export function getActiveSessionsForProjectFamily(projectId: string): string[] {
    return filterLiveSessionLocks(getSessionLockClaimsForProjectFamily(projectId));
}

/**
 * @deprecated Use getActiveSessionsForContainer instead.
 * Kept for backwards compatibility: recognizes old single-dash format.
 */
export function getActiveSessionsForProject(projectId: string): string[] {
    return getActiveSessionsForContainer(projectId);
}

export function hasOtherActiveSessions(
    containerPrefix: string,
    currentLockFile: string,
): boolean {
    const sessions = getActiveSessionsForContainer(containerPrefix);
    const currentLockName = basename(currentLockFile);
    return sessions.some((s) => s !== currentLockName);
}

export function hasOtherSessionClaims(
    containerPrefix: string,
    currentLockFile: string,
): boolean {
    const claims = getSessionLockClaimsForContainer(containerPrefix);
    const currentLockName = basename(currentLockFile);
    return claims.some((claim) => claim !== currentLockName);
}

/**
 * Atomically prove replacement is currently allowed, then require that no
 * foreign ownership claim exists before destructive replacement. Session
 * creation takes the same lock, so a new CCC process cannot appear between
 * the final check and stop/rm.
 */
export function recreateContainerWithoutInterruptingSessions(
    containerPrefix: string,
    currentLockFile: string,
    recreate: () => void,
    replacementAllowed: () => boolean = () => true,
): boolean {
    return withContainerLifecycleLock(containerPrefix, () => {
        if (!replacementAllowed()) return false;
        if (hasOtherSessionClaims(containerPrefix, currentLockFile)) return false;
        recreate();
        return true;
    });
}

let cleanedUp = false;

function cleanupDevicesBestEffort(projectPath: string, profile?: string): void {
    try {
        cleanupOwnerDevices(projectPath, 5000, profile);
    } catch (err) {
        console.error(`[ccc] device cleanup failed during session cleanup: ${err instanceof Error ? err.message : String(err)}`);
    }
}

export function cleanupSession(): void {
    if (cleanedUp || !currentSessionLockFile || !currentProjectPath) {
        return;
    }
    const projectId = getProjectId(currentProjectPath);
    const containerPrefix = currentProfile ? `${projectId}--p--${currentProfile}` : projectId;
    // Automatic shutdown requires the absence of every foreign ownership claim.
    // Liveness inference is intentionally excluded from this destructive path.
    withContainerLifecycleLock(containerPrefix, () => {
        const hasOthers = hasOtherSessionClaims(containerPrefix, currentSessionLockFile!);
        removeSessionLock(currentSessionLockFile!);
        if (!hasOthers) {
            cleanupDevicesBestEffort(currentProjectPath!, currentProfile);
            if (currentContainerId) {
                if (currentToolName === "claude") {
                    saveClaudeBinaryToVolume(currentContainerId);
                }
                spawnSync(runtimeCli(), ["stop", currentContainerId], { stdio: "ignore" });
            }
        }
    });

    cleanedUp = true;

    currentSessionLockFile = null;
    currentProjectPath = null;
    currentProfile = undefined;
}

// Setup signal handlers for cleanup
export function setupSignalHandlers(): void {
    const cleanup = () => {
        cleanupSession();
        process.exit(0);
    };

    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
    process.once("SIGHUP", cleanup);
}
