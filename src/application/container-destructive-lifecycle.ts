import { sessionClaimPrefix } from "../domain/session-claims.js";
import type {
    ContainerDestructiveLifecycleOptions,
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
        operation: () => undefined,
    ): void {
        const guardPath = ports.resolvePath(projectPath);
        const projectId = ports.projectId(guardPath);
        const prefix = sessionClaimPrefix(projectId, profile);
        ports.withLifecycleLock(prefix, () => {
            const claims = ports.sessionClaims(prefix);
            if (claims.length > 0 && options.force !== true) {
                ports.throwSessionClaims(claims.length, guardPath);
            }
            return operation();
        });
    }

    function cleanupDevices(fullPath: string, profile: string | undefined): void {
        try {
            ports.cleanupDevices(fullPath, 5000, profile);
        } catch (error) {
            ports.reportDeviceCleanupFailure(error);
        }
    }

    function stop(
        projectPath: string,
        profile?: string,
        options: ContainerDestructiveLifecycleOptions = {},
    ): void {
        withGuard(projectPath, profile, options, () => {
            ports.ensureRuntime();
            const fullPath = ports.resolvePath(projectPath);
            const containerName = ports.containerName(fullPath, profile);
            const identity = ports.managedIdentity(containerName, fullPath);
            if (!identity) {
                ports.reportNotFound();
                return;
            }

            cleanupDevices(fullPath, profile);
            if (identity.running) {
                ports.reportStopping(containerName, fullPath);
                ports.stop(identity.containerId);
            }
            ports.reportStopped();
        });
    }

    function remove(
        projectPath: string,
        profile?: string,
        options: ContainerDestructiveLifecycleOptions = {},
    ): void {
        withGuard(projectPath, profile, options, () => {
            ports.ensureRuntime();
            const containerName = ports.containerName(ports.resolvePath(projectPath), profile);
            const fullPath = ports.resolvePath(projectPath);
            const identity = ports.managedIdentity(containerName, fullPath);
            if (!identity) {
                ports.reportNotFound();
                return;
            }

            cleanupDevices(ports.resolvePath(projectPath), profile);
            if (identity.running) {
                ports.reportStopping(containerName, fullPath);
                ports.stop(identity.containerId);
                ports.reportStopped();
            }
            ports.reportRemoving(containerName, fullPath);
            ports.remove(identity.containerId);
            ports.reportRemoved();
        });
    }

    return { stop, remove };
}
