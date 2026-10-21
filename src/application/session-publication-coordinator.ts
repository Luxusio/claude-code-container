import type { SessionOwnershipHandle } from "../ports/session-ownership.js";

export interface SessionPublicationCoordinatorPorts {
    currentOwnership(): SessionOwnershipHandle | null;
    prepareStandaloneUpdate(owner: SessionOwnershipHandle, containerId: string | null,
        enabled: boolean): (() => Promise<boolean>) | undefined;
    setCleanupEnabled(enabled: boolean): void;
    setContainerId(containerId: string | null): void;
}

export function createSessionPublicationCoordinator(ports: SessionPublicationCoordinatorPorts) {
    let pendingOwnershipUpdate: Promise<void> = Promise.resolve();
    let capturedContainerId: string | null = null;
    let sessionCleanupEnabled = true;
    let cleanupAuthorizationVersion = 0;

    function enqueueOwnershipUpdate(version: number, activeOwnership: SessionOwnershipHandle, enabled: boolean,
        dispatch: () => Promise<boolean>): void {
        const previous = pendingOwnershipUpdate;
        // Keep the primary failure, but let later transport requests run.
        const execution = previous.catch(() => undefined).then(async () => {
            if (ports.currentOwnership() !== activeOwnership || cleanupAuthorizationVersion !== version) return;
            const acknowledged = await dispatch();
            // A stale ACK cannot reauthorize a subsequently revoked session.
            if (acknowledged && ports.currentOwnership() === activeOwnership && cleanupAuthorizationVersion === version) {
                ports.setCleanupEnabled(enabled);
            }
        });
        pendingOwnershipUpdate = Promise.allSettled([previous, execution]).then(results => {
            const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
            if (failures.length === 1) throw failures[0];
            if (failures.length > 1) throw new AggregateError(failures, "Session ownership publication failed.", { cause: failures[0] });
        });
        // Transport failure is consumed here while confirm retains rejection.
        void pendingOwnershipUpdate.catch(() => undefined);
    }

    function queueOwnershipUpdate(version: number): void {
        const activeOwnership = ports.currentOwnership();
        if (!activeOwnership) return;
        const enabled = sessionCleanupEnabled;
        const dispatch = ports.prepareStandaloneUpdate(activeOwnership, capturedContainerId, enabled);
        if (dispatch) enqueueOwnershipUpdate(version, activeOwnership, enabled, dispatch);
    }

    return {
        beginCapture(enabled: boolean): void {
            capturedContainerId = null;
            sessionCleanupEnabled = enabled;
            if (!enabled) ports.setCleanupEnabled(false);
            cleanupAuthorizationVersion++;
        },
        captureAcknowledgedContainer(containerId: string): void {
            capturedContainerId = containerId;
            ports.setContainerId(containerId);
        },
        retire(): void {
            pendingOwnershipUpdate = Promise.resolve();
            capturedContainerId = null;
            sessionCleanupEnabled = true;
            cleanupAuthorizationVersion++;
        },
        async confirm(): Promise<void> {
            await pendingOwnershipUpdate;
            ports.currentOwnership()?.assertOwnership();
        },
        setCleanupEnabled(enabled: boolean): void {
            sessionCleanupEnabled = enabled;
            const version = ++cleanupAuthorizationVersion;
            if (!enabled || !ports.currentOwnership()) ports.setCleanupEnabled(enabled);
            queueOwnershipUpdate(version);
        },
        setContainerId(containerId: string | null): void {
            // Cleanup permission belongs to the captured identity only.
            if (ports.currentOwnership() && capturedContainerId !== containerId) {
                sessionCleanupEnabled = false;
                ports.setCleanupEnabled(false);
            }
            capturedContainerId = containerId;
            ports.setContainerId(containerId);
            queueOwnershipUpdate(++cleanupAuthorizationVersion);
        },
        beginStartupInHeldLifecycleLock(owner: SessionOwnershipHandle): void {
            owner.beginStartupInHeldLifecycleLock();
            cleanupAuthorizationVersion++;
            sessionCleanupEnabled = false;
            ports.setCleanupEnabled(false);
        },
        recordOwnStartInHeldLifecycleLock(owner: SessionOwnershipHandle, containerId: string): void {
            // Durable compensation and local authority precede fallible transport preparation.
            owner.recordOwnStartInHeldLifecycleLock(containerId);
            capturedContainerId = containerId;
            ports.setContainerId(containerId);
            sessionCleanupEnabled = true;
            ports.setCleanupEnabled(true);
            const version = ++cleanupAuthorizationVersion;
            const dispatch = owner.prepareContainerUpdateInHeldLifecycleLock(containerId, true);
            enqueueOwnershipUpdate(version, owner, true, dispatch);
        },
        publishReadyInHeldLifecycleLock(owner: SessionOwnershipHandle, containerId: string,
            handoff: { startedByInvocation: boolean }): void {
            capturedContainerId = containerId;
            ports.setContainerId(containerId);
            sessionCleanupEnabled = handoff.startedByInvocation;
            if (!sessionCleanupEnabled) ports.setCleanupEnabled(false);
            const version = ++cleanupAuthorizationVersion;
            const dispatch = owner.prepareContainerUpdateInHeldLifecycleLock(containerId, sessionCleanupEnabled);
            enqueueOwnershipUpdate(version, owner, sessionCleanupEnabled, dispatch);
        },
    };
}
