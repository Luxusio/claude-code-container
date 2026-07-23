import { spawnSync } from "child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { randomBytes } from "crypto";
import { getProjectId, DATA_DIR } from "./utils.js";
import { getContainerName, getConfirmedRunningContainerId } from "./docker.js";
import { saveClaudeBinaryToVolume } from "./container-setup.js";
import { stopClipboardServerIfLast } from "./clipboard-server.js";
import { runtimeCli } from "./container-runtime.js";
import { cleanupOwnerDevices } from "./device-lab-admin.js";
import { withSharedMutationLock, withSharedMutationLockAsync } from "./device-lab-shared-state.js";
import { canonicalWindowsPowerShellPath } from "./windows-system-powershell.js";

const locksDir = join(DATA_DIR, "locks");

function containerLifecycleLock(containerPrefix: string): string {
    return join(locksDir, `${containerPrefix}.container-lifecycle.guard`);
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

export async function withContainerLifecycleLockAsync<T>(containerPrefix: string, operation: () => Promise<T> | T): Promise<T> {
    ensureLocksDirectory();
    return withSharedMutationLockAsync(containerLifecycleLock(containerPrefix), operation, { waitMs: 180_000 });
}

// Module state - managed via getter/setter for testability
let currentSessionLockFile: string | null = null;
let currentProjectPath: string | null = null;
let currentProfile: string | undefined = undefined;
let currentToolName: string | null = null;

export function setSession(lockFile: string, projectPath: string, profile?: string, toolName?: string): void {
    currentSessionLockFile = lockFile;
    currentProjectPath = projectPath;
    currentProfile = profile;
    currentToolName = toolName ?? "claude";
}

export function getCurrentSession(): { lockFile: string | null; projectPath: string | null; profile?: string; toolName: string | null } {
    return { lockFile: currentSessionLockFile, projectPath: currentProjectPath, profile: currentProfile, toolName: currentToolName };
}

export function clearSession(): void {
    currentSessionLockFile = null;
    currentProjectPath = null;
    currentProfile = undefined;
    currentToolName = null;
    cleanedUp = false;
}

export function createSessionLock(projectId: string, profile?: string): string {
    ensureLocksDirectory();
    const sessionId = randomBytes(16).toString("hex");
    const prefix = profile ? `${projectId}--p--${profile}` : projectId;
    const lockFile = join(locksDir, `${prefix}--${sessionId}.lock`);
    withContainerLifecycleLock(prefix, () => {
        const startToken = processStartToken(process.pid);
        if (!startToken) {
            throw new Error("Unable to establish process identity for CCC session lock");
        }
        writeFileSync(lockFile, JSON.stringify({
            version: 2,
            pid: process.pid,
            startToken,
        }), { mode: 0o600, flag: "wx" });
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

function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // Windows can deny observation of a live process. EPERM is positive
        // liveness evidence for lock ownership, not a stale-session signal.
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

function processStartToken(pid: number): string | null {
    try {
        if (process.platform === "linux") {
            const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
            const close = stat.lastIndexOf(")");
            if (close < 0) return null;
            const fields = stat.slice(close + 1).trim().split(/\s+/);
            return fields[19] ? `linux:${fields[19]}` : null;
        }
        if (process.platform === "win32") {
            const powershell = canonicalWindowsPowerShellPath();
            if (!powershell) return null;
            const script = `$P = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($P) { $P.StartTime.ToUniversalTime().Ticks }`;
            const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
                encoding: "utf-8",
                timeout: 1000,
                windowsHide: true,
            });
            const value = result.status === 0 ? result.stdout?.trim() : "";
            return value ? `windows:${value}` : null;
        }
        const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
            encoding: "utf-8",
            timeout: 1000,
            windowsHide: true,
        });
        const value = result.status === 0 ? result.stdout?.trim() : "";
        return value ? `ps:${value}` : null;
    } catch {
        return null;
    }
}

function sessionLockRecord(content: string): { pid: number; startToken?: string } | null {
    try {
        const parsed = JSON.parse(content) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const record = parsed as { version?: unknown; pid?: unknown; startToken?: unknown };
            if (record.version !== 2 || !Number.isSafeInteger(record.pid) || Number(record.pid) <= 0
                || typeof record.startToken !== "string" || record.startToken.length === 0 || record.startToken.length > 256) return null;
            return { pid: Number(record.pid), startToken: record.startToken };
        }
    } catch {
        // Legacy lock files contain only the decimal PID.
    }
    const legacy = content.trim();
    if (!/^[1-9]\d*$/.test(legacy)) return null;
    const pid = Number(legacy);
    return Number.isSafeInteger(pid) ? { pid } : null;
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
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
    }
    const isProfilePrefix = containerPrefix.includes("--p--");
    const locks = entries.filter((f) => {
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
    return locks.filter((f) => {
        const lockPath = join(locksDir, f);
        try {
            const content = readFileSync(lockPath, "utf-8").trim();
            const record = sessionLockRecord(content);
            // An unreadable or malformed ownership record is not proof that
            // its owner is dead. Preserve it until an operator can inspect it.
            if (!record) return true;
            if (!isPidAlive(record.pid)) {
                try { unlinkSync(lockPath); } catch { /* ignore */ }
                return false;
            }
            const currentStartToken = record.startToken ? processStartToken(record.pid) : null;
            if (record.startToken && currentStartToken && record.startToken !== currentStartToken) {
                try { unlinkSync(lockPath); } catch { /* ignore */ }
                return false;
            }
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

/**
 * Atomically check for another live session and, only when none exists, run a
 * destructive container replacement. Session creation takes the same lock, so
 * a new CCC process cannot appear between the final check and stop/rm.
 */
export function recreateContainerWithoutInterruptingSessions(
    containerPrefix: string,
    currentLockFile: string,
    recreate: () => void,
    replacementAllowed: () => boolean = () => true,
): boolean {
    return withContainerLifecycleLock(containerPrefix, () => {
        if (hasOtherActiveSessions(containerPrefix, currentLockFile)) return false;
        if (!replacementAllowed()) return false;
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
    // Stop clipboard server if this is the last CCC session (check BEFORE removing lock)
    const containerName = getContainerName(currentProjectPath, currentProfile);
    withContainerLifecycleLock(containerPrefix, () => {
        // Stop clipboard server if this is the last CCC session (check BEFORE removing lock).
        stopClipboardServerIfLast(currentSessionLockFile!);
        const hasOthers = hasOtherActiveSessions(containerPrefix, currentSessionLockFile!);
        removeSessionLock(currentSessionLockFile!);
        if (!hasOthers) {
            cleanupDevicesBestEffort(currentProjectPath!, currentProfile);
            const runningContainerId = getConfirmedRunningContainerId(containerName);
            if (runningContainerId) {
                if (currentToolName === "claude") {
                    saveClaudeBinaryToVolume(runningContainerId);
                }
                spawnSync(runtimeCli(), ["stop", runningContainerId], { stdio: "ignore" });
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
