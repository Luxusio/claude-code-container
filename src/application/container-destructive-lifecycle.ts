import { sessionClaimPrefix } from "../domain/session-claims.js";
import type {
    ContainerDeviceCleanupObservation,
    ContainerDestructiveLifecycleEvidence,
    ContainerDestructiveLifecycleOptions,
    ContainerDestructiveLifecycleOutcome,
    ContainerDestructiveLifecyclePorts,
} from "../ports/container-destructive-lifecycle.js";

export function createContainerDestructiveLifecycle(ports: ContainerDestructiveLifecyclePorts) {
    for (const name of [
        "resolvePath", "projectId", "containerName", "withLifecycleLock",
        "sessionClaims", "ensureRuntime", "managedIdentity", "cleanupDevices",
        "stop", "remove", "reportNotFound", "reportStopping", "reportStopped",
        "reportRemoving", "reportRemoved", "reportDeviceCleanupFailure", "throwSessionClaims",
    ] as const) {
        if (typeof ports?.[name] !== "function") {
            throw new TypeError(`Container destructive lifecycle requires a callable ${name} port.`);
        }
    }

    function withGuard(
        projectPath: string,
        profile: string | undefined,
        options: ContainerDestructiveLifecycleOptions,
        operation: (fullPath: string) => ContainerDestructiveLifecycleOutcome,
    ): ContainerDestructiveLifecycleOutcome {
        const fullPath = ports.resolvePath(projectPath);
        const projectId = ports.projectId(fullPath);
        const prefix = sessionClaimPrefix(projectId, profile);
        return ports.withLifecycleLock(prefix, () => {
            const claims = ports.sessionClaims(prefix, fullPath, profile);
            if (claims.length > 0 && options.force !== true) {
                ports.throwSessionClaims(claims.length, fullPath);
            }
            return operation(fullPath);
        });
    }

    function cleanupDevices(fullPath: string, profile: string | undefined): ContainerDeviceCleanupObservation {
        let cleanup: ContainerDeviceCleanupObservation;
        try {
            cleanup = ports.cleanupDevices(fullPath, 5000, profile);
        } catch {
            cleanup = { kind: "unavailable" };
        }
        if (cleanup.kind === "unavailable" || cleanup.failed > 0) {
            ports.reportDeviceCleanupFailure(cleanup);
        }
        return cleanup;
    }

    function completed(evidence: ContainerDestructiveLifecycleEvidence): ContainerDestructiveLifecycleOutcome {
        const cleanup = evidence.cleanup;
        if (cleanup.kind === "unavailable" || (cleanup.kind === "observed" && cleanup.failed > 0)) {
            return { kind: "failed", reason: "device-cleanup-incomplete", evidence };
        }
        return { kind: "completed", value: evidence };
    }

    function stop(
        projectPath: string,
        profile?: string,
        options: ContainerDestructiveLifecycleOptions = {},
    ): ContainerDestructiveLifecycleOutcome {
        return withGuard(projectPath, profile, options, (fullPath) => {
            ports.ensureRuntime();
            const containerName = ports.containerName(fullPath, profile);
            const identity = ports.managedIdentity(containerName, fullPath);
            if (!identity) {
                ports.reportNotFound();
                return { kind: "completed", value: { target: null, cleanup: { kind: "not-run" }, stop: "not-run", removal: "not-run" } };
            }

            const target = { containerId: identity.containerId, running: identity.running };
            const evidence: ContainerDestructiveLifecycleEvidence = {
                target, cleanup: cleanupDevices(fullPath, profile), stop: "not-run", removal: "not-run",
            };
            if (target.running) {
                ports.reportStopping(containerName, fullPath);
                evidence.stop = ports.stop(target.containerId).kind;
                if (evidence.stop === "unconfirmed") {
                    return { kind: "indeterminate", reason: "container-stop-unconfirmed", evidence };
                }
            }
            ports.reportStopped();
            return completed(evidence);
        });
    }

    function remove(
        projectPath: string,
        profile?: string,
        options: ContainerDestructiveLifecycleOptions = {},
    ): ContainerDestructiveLifecycleOutcome {
        return withGuard(projectPath, profile, options, (fullPath) => {
            ports.ensureRuntime();
            const containerName = ports.containerName(fullPath, profile);
            const identity = ports.managedIdentity(containerName, fullPath);
            if (!identity) {
                ports.reportNotFound();
                return { kind: "completed", value: { target: null, cleanup: { kind: "not-run" }, stop: "not-run", removal: "not-run" } };
            }

            const target = { containerId: identity.containerId, running: identity.running };
            const evidence: ContainerDestructiveLifecycleEvidence = {
                target, cleanup: cleanupDevices(fullPath, profile), stop: "not-run", removal: "not-run",
            };
            if (target.running) {
                ports.reportStopping(containerName, fullPath);
                evidence.stop = ports.stop(target.containerId).kind;
                if (evidence.stop === "unconfirmed") {
                    return { kind: "indeterminate", reason: "container-stop-unconfirmed", evidence };
                }
                ports.reportStopped();
            }
            ports.reportRemoving(containerName, fullPath);
            evidence.removal = ports.remove(target.containerId).kind;
            if (evidence.removal === "unconfirmed") {
                return { kind: "indeterminate", reason: "container-remove-unconfirmed", evidence };
            }
            ports.reportRemoved();
            return completed(evidence);
        });
    }

    return { stop, remove };
}
