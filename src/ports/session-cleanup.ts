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

export interface SessionDeviceCleanupCounts {
    stopped: number;
    skipped: number;
    failed: number;
}

export type SessionDeviceCleanupFailure =
    | { kind: "reported-failures"; failedDevices: number }
    | { kind: "exception"; error: unknown };

export type SessionCleanupOutcome =
    | { kind: "no-active-session" }
    | {
        kind: "settled";
        claim: "retired";
        devices:
            | { kind: "observed"; stopped: number; skipped: number; failed: number }
            | { kind: "skipped"; reason: "peer-veto" | "cleanup-disabled" }
            | { kind: "indeterminate"; reason: "device-cleanup-threw" };
        container: { kind: "stopped" | "transferred" | "not-required" };
    };

export interface SessionCleanupPorts {
    projectId(path: string): string;
    withLifecycleLock<T>(prefix: string, operation: () => T): T;
    peerVetoes(prefix: string, ownPath: string, pinnedContainerId: string | null): SessionCleanupPeerVetoes;
    removeClaim(path: string, settlement: SessionCleanupSettlement): undefined;
    cleanupDevices(path: string, timeoutMs: number, profile?: string): SessionDeviceCleanupCounts;
    reportDeviceCleanupFailure(failure: SessionDeviceCleanupFailure): undefined;
    stopContainer(readContainerId: () => string | null): undefined;
}
