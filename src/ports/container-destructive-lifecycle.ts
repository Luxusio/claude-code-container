export interface DestructiveContainerIdentity {
    containerId: string;
    running: boolean;
}

export interface ContainerDestructiveLifecycleOptions {
    force?: boolean;
}

export type ContainerDeviceCleanupObservation =
    | { kind: "observed"; stopped: number; skipped: number; failed: number }
    | { kind: "unavailable" };

export type ContainerDestructiveCommandObservation =
    | { kind: "completed" }
    | { kind: "unconfirmed" };

export interface ContainerDestructiveLifecycleEvidence {
    target: DestructiveContainerIdentity | null;
    cleanup: ContainerDeviceCleanupObservation | { kind: "not-run" };
    stop: "not-run" | "completed" | "unconfirmed";
    removal: "not-run" | "completed" | "unconfirmed";
}

export type ContainerDestructiveLifecycleOutcome =
    | { kind: "completed"; value: ContainerDestructiveLifecycleEvidence }
    | { kind: "failed"; reason: "device-cleanup-incomplete"; evidence: ContainerDestructiveLifecycleEvidence }
    | { kind: "indeterminate"; reason: "container-stop-unconfirmed" | "container-remove-unconfirmed"; evidence: ContainerDestructiveLifecycleEvidence };

export interface ContainerDestructiveLifecyclePorts {
    resolvePath(path: string): string;
    projectId(fullPath: string): string;
    containerName(fullPath: string, profile?: string): string;
    withLifecycleLock(prefix: string, operation: () => ContainerDestructiveLifecycleOutcome): ContainerDestructiveLifecycleOutcome;
    sessionClaims(prefix: string, fullPath: string, profile?: string): readonly string[];
    ensureRuntime(): undefined;
    managedIdentity(name: string, fullPath: string): DestructiveContainerIdentity | null;
    cleanupDevices(fullPath: string, timeoutMs: number, profile?: string): ContainerDeviceCleanupObservation;
    stop(id: string): ContainerDestructiveCommandObservation;
    remove(id: string): ContainerDestructiveCommandObservation;
    reportNotFound(): undefined;
    reportStopping(name: string, fullPath: string): undefined;
    reportStopped(): undefined;
    reportRemoving(name: string, fullPath: string): undefined;
    reportRemoved(): undefined;
    reportDeviceCleanupFailure(cleanup: ContainerDeviceCleanupObservation): undefined;
    throwSessionClaims(count: number, fullPath: string): never;
}
