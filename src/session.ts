import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { randomBytes } from "crypto";
import { getProjectId, DATA_DIR } from "./utils.js";
import { getContainerName, isContainerRunning } from "./docker.js";
import { saveClaudeBinaryToVolume } from "./container-setup.js";
import { stopClipboardServerIfLast } from "./clipboard-server.js";

const locksDir = join(DATA_DIR, "locks");

// Module state - managed via getter/setter for testability
let currentSessionLockFile: string | null = null;
let currentProjectPath: string | null = null;
let currentProfile: string | undefined = undefined;

export function setSession(lockFile: string, projectPath: string, profile?: string): void {
    currentSessionLockFile = lockFile;
    currentProjectPath = projectPath;
    currentProfile = profile;
}

export function getCurrentSession(): { lockFile: string | null; projectPath: string | null; profile?: string } {
    return { lockFile: currentSessionLockFile, projectPath: currentProjectPath, profile: currentProfile };
}

export function clearSession(): void {
    currentSessionLockFile = null;
    currentProjectPath = null;
    currentProfile = undefined;
    cleanedUp = false;
}

export function createSessionLock(projectId: string, profile?: string): string {
    mkdirSync(locksDir, { recursive: true });
    const sessionId = randomBytes(16).toString("hex");
    const prefix = profile ? `${projectId}--p--${profile}` : projectId;
    const lockFile = join(locksDir, `${prefix}--${sessionId}.lock`);
    writeFileSync(lockFile, String(process.pid), { mode: 0o600 });
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
    } catch {
        return false;
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
    if (!existsSync(locksDir)) {
        return [];
    }
    const isProfilePrefix = containerPrefix.includes("--p--");
    const locks = readdirSync(locksDir).filter((f) => {
        if (!f.startsWith(`${containerPrefix}--`) || !f.endsWith(".lock")) return false;
        // For non-profile prefix, exclude files that belong to profile sessions.
        // Profile lock files look like: projectId--p--<profile>--<sessionId>.lock
        // After stripping containerPrefix + "--", they start with "p--".
        if (!isProfilePrefix) {
            const afterPrefix = f.slice(containerPrefix.length + 2); // skip "--"
            if (afterPrefix.startsWith("p--")) return false;
        }
        return true;
    });
    return locks.filter((f) => {
        const lockPath = join(locksDir, f);
        try {
            const content = readFileSync(lockPath, "utf-8").trim();
            const pid = parseInt(content, 10);
            if (isNaN(pid) || !isPidAlive(pid)) {
                try { unlinkSync(lockPath); } catch { /* ignore */ }
                return false;
            }
            return true;
        } catch {
            try { unlinkSync(lockPath); } catch { /* ignore */ }
            return false;
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

let cleanedUp = false;

export function cleanupSession(): void {
    if (cleanedUp || !currentSessionLockFile || !currentProjectPath) {
        return;
    }
    cleanedUp = true;

    const projectId = getProjectId(currentProjectPath);
    const containerPrefix = currentProfile ? `${projectId}--p--${currentProfile}` : projectId;
    const hasOthers = hasOtherActiveSessions(containerPrefix, currentSessionLockFile);

    // Stop clipboard server if this is the last CCC session (check BEFORE removing lock)
    stopClipboardServerIfLast(currentSessionLockFile);

    // Remove our lock file
    removeSessionLock(currentSessionLockFile);

    // Stop container if no other sessions are using this project
    if (!hasOthers) {
        const containerName = getContainerName(currentProjectPath, currentProfile);
        if (isContainerRunning(containerName)) {
            // Save claude binary to volume before stopping (handles `claude update`)
            saveClaudeBinaryToVolume(containerName);
            spawnSync("docker", ["stop", containerName], { stdio: "ignore" });
        }
    }

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
