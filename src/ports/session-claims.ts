import type { NativeRuntimeInvocation } from "./container-runtime-invocation.js";
import type { ProcessStartObservation, SessionLockLiveness } from "../domain/session-lock.js";
import type { SessionClaimObservationSnapshot, SessionClaimObservationStore } from "./session-claim-observation.js";
import type { SessionOwnershipReceipt } from "./session-ownership.js";

/** Current project inspection and effects pinned to one native runtime invocation. */
export interface SessionClaimRecoveryScope {
    readonly runtimeInvocation?: NativeRuntimeInvocation;
    inspectContainer(): {
        known: boolean;
        containerId: string | null;
        running?: boolean;
        requiresLiveVerification?: true;
        reason?: string;
    };
    stopContainer(readContainerId: () => string | null): undefined;
}

/** Qualified file effects used only while the caller holds the exact lifecycle guard. */
export interface SessionClaimResponsibilityPorts {
    captureClaim(name: string): { receipt: SessionOwnershipReceipt; content: string };
    matchesClaim(receipt: SessionOwnershipReceipt): boolean;
    retireClaim(receipt: SessionOwnershipReceipt): undefined;
    observationStore: SessionClaimObservationStore;
    projectId(path: string): string;
    cleanup(snapshot: SessionClaimObservationSnapshot): void;
}

export interface SessionClaimsPorts {
    responsibility?: SessionClaimResponsibilityPorts;
    ensureDirectory(): undefined;
    listEntries(): string[];
    claimPath(name: string): string;
    claimName(path: string): string;
    readClaim(name: string): string;
    writeClaim(path: string, content: string): undefined;
    removeClaim(path: string): undefined;
    createId(): string;
    currentPid(): number;
    startToken(pid: number): string | null;
    observeOwners(pids: readonly number[]): ReadonlyMap<number, ProcessStartObservation>;
    classify(content: string, observations: ReadonlyMap<number, ProcessStartObservation>): SessionLockLiveness;
    withLifecycleLock<T>(prefix: string, operation: () => T): T;
}
