import type { SessionOwnershipRuntime } from "./session-ownership.js";

export interface SessionAcquisitionRequest {
    projectId: string;
    projectPath: string;
    profile?: string;
    toolName?: string;
}

export type SessionContainerInspectionReason =
    | "container-list-timeout" | "container-list-failed" | "container-list-ambiguous"
    | "container-inspection-unavailable" | "container-id-invalid" | "container-id-changed"
    | "container-state-unavailable" | "container-not-managed" | "project-path-mismatch"
    | "project-identity-mismatch" | "project-identity-unavailable" | "project-bind-unverified";

export interface SessionContainerInspection {
    known: boolean;
    containerId: string | null;
    running?: boolean;
    reason?: SessionContainerInspectionReason;
    /** Static stopped admission permits startup, never replacement before live proof. */
    requiresLiveVerification?: true;
}

export interface SessionAcquisitionInspection extends SessionContainerInspection {
    runtime: SessionOwnershipRuntime;
}

export interface SessionAcquisitionRecovery {
    containerId: string;
    runtime: SessionOwnershipRuntime;
    diagnostic: string;
}

export interface SessionAcquisitionResult {
    lockFile: string;
    existingId: string | null;
    requiresLiveVerification?: true;
    existingOnly?: true;
    recoveryWarning?: string;
}

export interface SessionAcquisitionPorts {
    withLifecycleLock<T>(prefix: string, operation: () => Promise<T>): Promise<T>;
    recoverPredecessors(prefix: string): void | SessionAcquisitionRecovery | Promise<void | SessionAcquisitionRecovery>;
    reserve(projectId: string, profile?: string): string;
    initializeCapture(request: SessionAcquisitionRequest, lockFile: string): void | Promise<void>;
    inspectExisting(request: SessionAcquisitionRequest): SessionAcquisitionInspection | Promise<SessionAcquisitionInspection>;
    arm(): Promise<void>;
    acknowledge(containerId: string, runtime: SessionOwnershipRuntime): Promise<void>;
    reconcileForeign(prefix: string, lockFile: string): boolean;
    rollback(lockFile: string): void | Promise<void>;
}

export type SessionAcquisitionCheckpoint = () => void;
