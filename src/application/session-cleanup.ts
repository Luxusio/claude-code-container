import { sessionClaimPrefix } from "../domain/session-claims.js";
import type { SessionCleanupPorts } from "../ports/session-cleanup.js";

export type SessionCleanupMode = "retryable-owner" | "ended-owner";

export function createSessionCleanup(ports: SessionCleanupPorts, mode: SessionCleanupMode = "retryable-owner") {
    if (mode !== "retryable-owner" && mode !== "ended-owner") throw new TypeError("Invalid session cleanup mode.");
    for (const name of [
        "projectId", "withLifecycleLock", "hasOtherClaims", "removeClaim",
        "cleanupDevices", "reportDeviceCleanupFailure", "stopContainer",
    ] as const) {
        if (typeof ports?.[name] !== "function") {
            throw new TypeError(`Session cleanup requires a callable ${name} port.`);
        }
    }

    let currentSessionLockFile: string | null = null;
    let currentProjectPath: string | null = null;
    let currentProfile: string | undefined = undefined;
    let currentToolName: string | null = null;
    let currentContainerId: string | null = null;
    let cleanedUp = false;
    let cleanupEnabled = true;

    function setSession(lockFile: string, projectPath: string, profile?: string, toolName?: string): void {
        currentSessionLockFile = lockFile;
        currentProjectPath = projectPath;
        currentProfile = profile;
        currentToolName = toolName ?? "claude";
        currentContainerId = null;
        cleanupEnabled = true;
    }

    function setSessionContainerId(containerId: string | null): void {
        currentContainerId = containerId;
    }

    function setSessionCleanupEnabled(enabled: boolean): void {
        if (typeof enabled !== "boolean") throw new TypeError("Invalid session cleanup authorization.");
        cleanupEnabled = enabled;
    }

    function getCurrentSession(): { lockFile: string | null; projectPath: string | null; profile?: string; toolName: string | null } {
        return { lockFile: currentSessionLockFile, projectPath: currentProjectPath, profile: currentProfile, toolName: currentToolName };
    }

    function clearSession(): void {
        currentSessionLockFile = null;
        currentProjectPath = null;
        currentProfile = undefined;
        currentToolName = null;
        currentContainerId = null;
        cleanupEnabled = true;
        cleanedUp = false;
    }

    function cleanupSession(): void {
        if (cleanedUp || !currentSessionLockFile || !currentProjectPath) {
            return;
        }
        const projectId = ports.projectId(currentProjectPath);
        const containerPrefix = sessionClaimPrefix(projectId, currentProfile);
        // The composed query reconciles proven stale foreign owners, then uses
        // remaining raw claims as the shutdown veto under this same guard.
        ports.withLifecycleLock(containerPrefix, () => {
            if (mode === "ended-owner") ports.removeClaim(currentSessionLockFile!);
            const hasOthers = ports.hasOtherClaims(containerPrefix, currentSessionLockFile!);
            if (!hasOthers && cleanupEnabled) {
                try {
                    ports.cleanupDevices(currentProjectPath!, 5000, currentProfile);
                } catch (error) {
                    ports.reportDeviceCleanupFailure(error);
                }
                if (currentContainerId) {
                    // Native runtime selection happens before this mutable ID is read.
                    ports.stopContainer(() => currentContainerId);
                }
            }
            // Keep the receipt through a failed stop so owned cleanup can retry.
            if (mode === "retryable-owner") ports.removeClaim(currentSessionLockFile!);
        });

        cleanedUp = true;
        currentSessionLockFile = null;
        currentProjectPath = null;
        currentProfile = undefined;
    }

    return {
        setSession,
        setSessionContainerId,
        setSessionCleanupEnabled,
        getCurrentSession,
        clearSession,
        cleanupSession,
    };
}
