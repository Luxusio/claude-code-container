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
    | { type: "init"; binding: SessionOwnershipBinding; receipt: SessionOwnershipReceipt }
    | { type: "ready" }
    | { type: "update"; sequence: number; containerId: string | null; runtime: SessionOwnershipRuntime; cleanupEnabled: boolean }
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
    updateContainer(containerId: string | null, runtime: SessionOwnershipRuntime, cleanupEnabled?: boolean): Promise<void>;
    release(): Promise<void>;
    assertOwnership(): void;
}

export interface SessionOwnershipPorts {
    launch(): SessionOwnershipChannel;
    cleanup(binding: SessionOwnershipBinding, receipt: SessionOwnershipReceipt): void;
    setTimer(callback: () => void, milliseconds: number): unknown;
    clearTimer(timer: unknown): void;
    timeoutMs: number;
    assertOwnership(binding: SessionOwnershipBinding, receipt: SessionOwnershipReceipt): void;
}

export interface SessionOwnershipGuardianPorts {
    rollback(binding: SessionOwnershipBinding, receipt: SessionOwnershipReceipt): void;
    validate(binding: SessionOwnershipBinding, receipt: SessionOwnershipReceipt): void;
    cleanup(binding: SessionOwnershipBinding, receipt: SessionOwnershipReceipt,
        containerId: string | null, runtime: SessionOwnershipRuntime): void;
    send(message: SessionOwnershipMessage): Promise<void>;
    finish(status?: 0 | 1): void;
}
