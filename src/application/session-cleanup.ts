import { sessionClaimPrefix } from "../domain/session-claims.js";
import type { SessionCleanupOutcome, SessionCleanupPorts, SessionDeviceCleanupFailure } from "../ports/session-cleanup.js";

export function createSessionCleanup(ports: SessionCleanupPorts) {
    for (const name of [
        "projectId", "withLifecycleLock", "peerVetoes", "removeClaim",
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
    let authorizationGeneration = 0;
    let currentSessionIdentity: object | null = null;

    type CleanupContext = {
        sessionIdentity: object | null;
        lockFile: string;
        projectPath: string;
        profile: string | undefined;
        containerId: string | null;
        cleanupEnabled: boolean;
        generation: number;
    };

    function setSession(lockFile: string, projectPath: string, profile?: string, toolName?: string): void {
        authorizationGeneration++;
        currentSessionIdentity = {};
        currentSessionLockFile = lockFile;
        currentProjectPath = projectPath;
        currentProfile = profile;
        currentToolName = toolName ?? "claude";
        currentContainerId = null;
        cleanupEnabled = true;
    }

    function setSessionContainerId(containerId: string | null): void {
        authorizationGeneration++;
        currentContainerId = containerId;
    }

    function setSessionCleanupEnabled(enabled: boolean): void {
        if (typeof enabled !== "boolean") throw new TypeError("Invalid session cleanup authorization.");
        authorizationGeneration++;
        cleanupEnabled = enabled;
    }

    function getCurrentSession(): { lockFile: string | null; projectPath: string | null; profile?: string; toolName: string | null } {
        return { lockFile: currentSessionLockFile, projectPath: currentProjectPath, profile: currentProfile, toolName: currentToolName };
    }

    function clearSession(): void {
        authorizationGeneration++;
        currentSessionIdentity = null;
        currentSessionLockFile = null;
        currentProjectPath = null;
        currentProfile = undefined;
        currentToolName = null;
        currentContainerId = null;
        cleanupEnabled = true;
        cleanedUp = false;
    }

    function captureCleanupContext(): CleanupContext | null {
        if (cleanedUp || !currentSessionLockFile || !currentProjectPath) {
            return null;
        }
        return {
            sessionIdentity: currentSessionIdentity,
            lockFile: currentSessionLockFile,
            projectPath: currentProjectPath,
            profile: currentProfile,
            containerId: currentContainerId,
            cleanupEnabled,
            generation: authorizationGeneration,
        };
    }

    function assertCleanupContext(context: CleanupContext, cause?: unknown): void {
        if (authorizationGeneration !== context.generation
            || currentSessionLockFile !== context.lockFile
            || currentProjectPath !== context.projectPath
            || currentProfile !== context.profile
            || currentContainerId !== context.containerId
            || cleanupEnabled !== context.cleanupEnabled) {
            throw new Error("cleanup-authorization-changed: Session cleanup authorization changed; cleanup remains incomplete.", { cause });
        }
    }

    function cleanupContainerPrefix(context: CleanupContext): string {
        const projectId = ports.projectId(context.projectPath);
        assertCleanupContext(context);
        return sessionClaimPrefix(projectId, context.profile);
    }

    function cleanupSessionBody(containerPrefix: string, context: CleanupContext): SessionCleanupOutcome {
        assertCleanupContext(context);
        const vetoes = ports.peerVetoes(containerPrefix, context.lockFile, context.containerId);
        assertCleanupContext(context);
        let devices: Extract<SessionCleanupOutcome, { kind: "settled" }>["devices"];
        if (!context.cleanupEnabled) {
            devices = { kind: "skipped", reason: "cleanup-disabled" };
        } else if (vetoes.sharedDeviceCleanupBlocked) {
            devices = { kind: "skipped", reason: "peer-veto" };
        } else {
            let failure: SessionDeviceCleanupFailure | undefined;
            try {
                const counts = ports.cleanupDevices(context.projectPath, 5000, context.profile);
                devices = { kind: "observed", stopped: counts.stopped, skipped: counts.skipped, failed: counts.failed };
            } catch (error) {
                assertCleanupContext(context, error);
                devices = { kind: "indeterminate", reason: "device-cleanup-threw" };
                failure = { kind: "exception", error };
            }
            assertCleanupContext(context);
            if (devices.kind === "observed" && devices.failed > 0) {
                failure = { kind: "reported-failures", failedDevices: devices.failed };
            }
            if (failure) {
                assertCleanupContext(context);
                ports.reportDeviceCleanupFailure(failure);
                assertCleanupContext(context);
            }
        }
        let container: Extract<SessionCleanupOutcome, { kind: "settled" }>["container"] = { kind: "not-required" };
        if (context.cleanupEnabled && context.containerId) {
            if (!vetoes.exactContainerStopBlocked) {
                // Native runtime selection happens before this guarded ID read.
                ports.stopContainer(() => {
                    assertCleanupContext(context);
                    return context.containerId;
                });
                assertCleanupContext(context);
                container = { kind: "stopped" };
            } else if (!vetoes.responsibilityTransferred) {
                throw new Error("session-cleanup-responsibility-incomplete: Exact container shutdown is blocked and no qualified successor owns its cleanup responsibility.");
            } else {
                container = { kind: "transferred" };
            }
        }
        // Keep the receipt through a failed stop so owned cleanup can retry.
        ports.removeClaim(context.lockFile, {
            containerId: context.containerId,
            cleanupEnabled: context.cleanupEnabled,
            containerStopped: container.kind === "stopped",
            responsibilityTransferred: vetoes.responsibilityTransferred,
        });
        // Successful retirement settles this session before the guard returns.
        finalizeSessionCleanup(context);
        return { kind: "settled", claim: "retired", devices, container };
    }

    function finalizeSessionCleanup(context: CleanupContext): void {
        if (currentSessionIdentity !== context.sessionIdentity) return;
        cleanedUp = true;
        currentSessionIdentity = null;
        currentSessionLockFile = null;
        currentProjectPath = null;
        currentProfile = undefined;
    }

    function cleanupSessionInHeldLifecycleLock(): SessionCleanupOutcome {
        const context = captureCleanupContext();
        if (!context) return { kind: "no-active-session" };
        const containerPrefix = cleanupContainerPrefix(context);
        return cleanupSessionBody(containerPrefix, context);
    }

    function cleanupSession(): SessionCleanupOutcome {
        const context = captureCleanupContext();
        if (!context) return { kind: "no-active-session" };
        const containerPrefix = cleanupContainerPrefix(context);
        return ports.withLifecycleLock(containerPrefix, () => cleanupSessionBody(containerPrefix, context));
    }

    return {
        setSession,
        setSessionContainerId,
        setSessionCleanupEnabled,
        getCurrentSession,
        clearSession,
        cleanupSession,
        cleanupSessionInHeldLifecycleLock,
    };
}
