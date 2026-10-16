export interface DestructiveContainerIdentity {
    containerId: string;
    running: boolean;
}

export interface ContainerDestructiveLifecycleOptions {
    force?: boolean;
}

export interface ContainerDestructiveLifecyclePorts {
    resolvePath(path: string): string;
    projectId(fullPath: string): string;
    containerName(fullPath: string, profile?: string): string;
    withLifecycleLock(prefix: string, operation: () => undefined): undefined;
    sessionClaims(prefix: string): readonly string[];
    ensureRuntime(): undefined;
    managedIdentity(name: string, fullPath: string): DestructiveContainerIdentity | null;
    cleanupDevices(fullPath: string, timeoutMs: number, profile?: string): undefined;
    stop(id: string): undefined;
    remove(id: string): undefined;
    reportNotFound(): undefined;
    reportStopping(name: string, fullPath: string): undefined;
    reportStopped(): undefined;
    reportRemoving(name: string, fullPath: string): undefined;
    reportRemoved(): undefined;
    reportDeviceCleanupFailure(error: unknown): undefined;
    throwSessionClaims(count: number, fullPath: string): never;
}
