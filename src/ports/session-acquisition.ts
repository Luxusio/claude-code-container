import type { SessionOwnershipRuntime } from "./session-ownership.js";

export interface SessionAcquisitionRequest {
    projectId: string;
    projectPath: string;
    profile?: string;
    toolName?: string;
}

export interface SessionAcquisitionInspection {
    known: boolean;
    containerId: string | null;
    runtime: SessionOwnershipRuntime;
}

export interface SessionAcquisitionPorts {
    withLifecycleLock<T>(prefix: string, operation: () => Promise<T>): Promise<T>;
    reserve(projectId: string, profile?: string): string;
    initializeCapture(request: SessionAcquisitionRequest, lockFile: string): void | Promise<void>;
    inspectExisting(request: SessionAcquisitionRequest): SessionAcquisitionInspection | Promise<SessionAcquisitionInspection>;
    arm(): Promise<void>;
    acknowledge(containerId: string, runtime: SessionOwnershipRuntime): Promise<void>;
    reconcileForeign(prefix: string, lockFile: string): boolean;
    rollback(lockFile: string): void | Promise<void>;
}

export type SessionAcquisitionCheckpoint = () => void;
