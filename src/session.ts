import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "fs";
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

export function setSession(lockFile: string, projectPath: string): void {
    currentSessionLockFile = lockFile;
    currentProjectPath = projectPath;
}

export function getCurrentSession(): { lockFile: string | null; projectPath: string | null } {
    return { lockFile: currentSessionLockFile, projectPath: currentProjectPath };
}

export function clearSession(): void {
    currentSessionLockFile = null;
    currentProjectPath = null;
}

export function createSessionLock(projectId: string): string {
    mkdirSync(locksDir, { recursive: true });
    const sessionId = randomBytes(16).toString("hex");
    const lockFile = join(locksDir, `${projectId}-${sessionId}.lock`);
    writeFileSync(lockFile, String(process.pid));
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

export function getActiveSessionsForProject(projectId: string): string[] {
    if (!existsSync(locksDir)) {
        return [];
    }
    return readdirSync(locksDir).filter(
        (f) => f.startsWith(`${projectId}-`) && f.endsWith(".lock"),
    );
}

export function hasOtherActiveSessions(
    projectId: string,
    currentLockFile: string,
): boolean {
    const sessions = getActiveSessionsForProject(projectId);
    const currentLockName = basename(currentLockFile);
    return sessions.some((s) => s !== currentLockName);
}

export function cleanupSession(): void {
    if (!currentSessionLockFile || !currentProjectPath) {
        return;
    }

    const projectId = getProjectId(currentProjectPath);
    const hasOthers = hasOtherActiveSessions(projectId, currentSessionLockFile);

    // Stop clipboard server if this is the last CCC session (check BEFORE removing lock)
    stopClipboardServerIfLast(currentSessionLockFile);

    // Remove our lock file
    removeSessionLock(currentSessionLockFile);

    // Stop container if no other sessions are using this project
    if (!hasOthers) {
        const containerName = getContainerName(currentProjectPath);
        if (isContainerRunning(containerName)) {
            // Save claude binary to volume before stopping (handles `claude update`)
            saveClaudeBinaryToVolume(containerName);
            spawnSync("docker", ["stop", containerName], { stdio: "ignore" });
        }
    }

    currentSessionLockFile = null;
    currentProjectPath = null;
}

// Setup signal handlers for cleanup
export function setupSignalHandlers(): void {
    const cleanup = () => {
        cleanupSession();
        process.exit(0);
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
    process.on("SIGHUP", cleanup);
}
