export interface SessionCleanupPeerVetoes {
    sharedDeviceCleanupBlocked: boolean;
    exactContainerStopBlocked: boolean;
    responsibilityTransferred: boolean;
}

export interface SessionCleanupSettlement {
    containerId: string | null;
    cleanupEnabled: boolean;
    containerStopped: boolean;
    responsibilityTransferred: boolean;
}

export interface SessionCleanupPorts {
    projectId(path: string): string;
    withLifecycleLock<T>(prefix: string, operation: () => T): T;
    peerVetoes(prefix: string, ownPath: string, pinnedContainerId: string | null): SessionCleanupPeerVetoes;
    removeClaim(path: string, settlement: SessionCleanupSettlement): undefined;
    cleanupDevices(path: string, timeoutMs: number, profile?: string): undefined;
    reportDeviceCleanupFailure(error: unknown): undefined;
    stopContainer(readContainerId: () => string | null): undefined;
}
