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
let currentToolName: string | null = null;

export function setSession(lockFile: string, projectPath: string, toolName?: string): void {
    currentSessionLockFile = lockFile;
    currentProjectPath = projectPath;
    currentToolName = toolName ?? "claude";
}

export function getCurrentSession(): { lockFile: string | null; projectPath: string | null; toolName: string | null } {
    return { lockFile: currentSessionLockFile, projectPath: currentProjectPath, toolName: currentToolName };
}

export function clearSession(): void {
    currentSessionLockFile = null;
    currentProjectPath = null;
    currentToolName = null;
    cleanedUp = false;
}

export function createSessionLock(projectId: string): string {
    mkdirSync(locksDir, { recursive: true });
    const sessionId = randomBytes(16).toString("hex");
    const lockFile = join(locksDir, `${projectId}-${sessionId}.lock`);
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

export function getActiveSessionsForProject(projectId: string): string[] {
    if (!existsSync(locksDir)) {
        return [];
    }
    const locks = readdirSync(locksDir).filter(
        (f) => f.startsWith(`${projectId}-`) && f.endsWith(".lock"),
    );
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

export function hasOtherActiveSessions(
    projectId: string,
    currentLockFile: string,
): boolean {
    const sessions = getActiveSessionsForProject(projectId);
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
            if (currentToolName === "claude") {
                saveClaudeBinaryToVolume(containerName);
            }
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

    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
    process.once("SIGHUP", cleanup);
}
