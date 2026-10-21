import type { NativeRuntimeInvocation } from "./container-runtime-invocation.js";
import type { SessionClaimObservationStore } from "./session-claim-observation.js";

export interface SessionOwnershipBinding {
    lockFile: string;
    projectPath: string;
    profile?: string;
    toolName?: string;
}

export interface SessionOwnershipReceipt {
    path: string;
    bytes: string;
    device: string;
    inode: string;
    birthtime: string;
    ownerPid: number;
}

export type SessionOwnershipRuntime = "docker" | "podman";

export type SessionOwnershipMessage =
    | { type: "init"; binding: SessionOwnershipBinding; receipt: SessionOwnershipReceipt; runtimeInvocation: NativeRuntimeInvocation }
    | { type: "ready" }
    | { type: "update"; sequence: number; containerId: string | null; cleanupEnabled: boolean }
    | { type: "release"; sequence: number }
    | { type: "ack"; sequence: number }
    | { type: "error" };

export interface SessionOwnershipChannel {
    readonly pid?: number;
    send(message: SessionOwnershipMessage): Promise<void>;
    onMessage(listener: (message: unknown) => void): () => void;
    onLoss(listener: (error: Error) => void): () => void;
    unref(): void;
    close(): void;
}

export interface SessionOwnershipHandle {
    readonly pid?: number;
    updateContainer(containerId: string | null, cleanupEnabled?: boolean): Promise<boolean>;
    updateContainerInHeldLifecycleLock(containerId: string | null, cleanupEnabled?: boolean): Promise<boolean>;
    prepareContainerUpdateInHeldLifecycleLock(containerId: string | null, cleanupEnabled?: boolean): () => Promise<boolean>;
    beginStartupInHeldLifecycleLock(): void;
    recordOwnStartInHeldLifecycleLock(containerId: string): void;
    release(): Promise<void>;
    assertOwnership(): void;
}

export interface SessionOwnershipPublication {
    readonly generation: string;
    readonly sequence: number;
}

/** Each synchronous publication runs inside the caller's lifecycle guard. */
export interface SessionOwnershipPublicationPorts {
    withLifecycleLock<T>(operation: () => T | Promise<T>): Promise<T>;
    registerGuardian(pid: number | undefined): void;
    ready(): void;
    stageUpdate(sequence: number, containerId: string | null, cleanupEnabled: boolean): SessionOwnershipPublication;
    acknowledgeUpdate(publication: SessionOwnershipPublication): boolean;
    beginStartup(): void;
    recordOwnStart(containerId: string): void;
}

export interface SessionOwnershipPublicationEffects {
    readonly store: Pick<SessionClaimObservationStore, "begin" | "assertCurrent" | "update">;
    guardianStartToken(pid: number): string | null;
    withLifecycleLock<T>(operation: () => T | Promise<T>): Promise<T>;
}

export interface SessionOwnershipPorts {
    decodeRuntimeInvocation(value: unknown): NativeRuntimeInvocation;
    launch(): SessionOwnershipChannel;
    cleanup(binding: SessionOwnershipBinding, receipt: SessionOwnershipReceipt): void | Promise<void>;
    setTimer(callback: () => void, milliseconds: number): unknown;
    clearTimer(timer: unknown): void;
    timeoutMs: number;
    assertOwnership(binding: SessionOwnershipBinding, receipt: SessionOwnershipReceipt): void;
    publication: SessionOwnershipPublicationPorts;
}

export interface SessionOwnershipGuardianPorts {
    decodeRuntimeInvocation(value: unknown): NativeRuntimeInvocation;
    rollback(binding: SessionOwnershipBinding, receipt: SessionOwnershipReceipt): void | Promise<void>;
    validate(binding: SessionOwnershipBinding, receipt: SessionOwnershipReceipt, runtimeInvocation: NativeRuntimeInvocation): void | Promise<void>;
    cleanup(binding: SessionOwnershipBinding, receipt: SessionOwnershipReceipt,
        containerId: string | null, runtimeInvocation: NativeRuntimeInvocation): void | Promise<void>;
    send(message: SessionOwnershipMessage): Promise<void>;
    pause(milliseconds: number): Promise<void>;
    finish(status?: 0 | 1, error?: unknown): void;
}
