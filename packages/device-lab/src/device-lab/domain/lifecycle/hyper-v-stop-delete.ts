export interface HyperVStopDeleteRequest {
    ok: true;
    backend: string;
    stateKey: string;
    command: "device_stop" | "device_delete";
    deviceId: string;
    expectedIncarnationId?: string;
    force: boolean;
    dryRun: boolean;
    preserveNetwork?: boolean;
}
export interface HyperVOperationEvidence {
    version: 1;
    operationId: string;
    ownerId: string;
    deviceId: string;
    incarnationId: string;
    command: "device_start" | "device_stop" | "device_reboot" | "device_delete";
    vmId: string;
    vmName: string;
    diskPath: string;
    startedAt: string;
}
export interface HyperVCommandDescriptor {
    mode: "exec" | "detached" | "noop";
    provider: string;
    executable?: string;
    args?: string[];
    input?: string;
}
export interface HyperVCommandExecution {
    mode: string;
    provider: string;
    status?: number | null;
    stdout?: string;
    stderr?: string;
    error?: string;
    timedOut?: boolean;
}
export interface HyperVTerminalObservation {
    vmId: string;
    vmName: string;
    state: string;
    status?: string;
    diskPath?: string;
}
export type HyperVReplayObservation = {
    kind: "pending";
    action: "start" | "stop" | "remove" | "wait";
    reason: "terminal-state-mismatch" | "transitioning-or-unknown" | "removal-required";
    virtualMachine: {
        state: string;
        status: string;
    };
} | {
    kind: "settled";
    virtualMachine: {
        state: string;
        status: string;
    };
} | {
    kind: "absent";
    satisfiesIntent: boolean;
} | {
    kind: "identity-conflict" | "attachment-conflict";
};
export interface HyperVCleanupEvidence {
    ok: boolean;
    error?: string;
}
export interface HyperVArtifactEvidence extends HyperVCleanupEvidence {
    removed: boolean;
}
export interface HyperVPublication {
    found: boolean;
    matched: boolean;
    device: unknown;
}
export interface HyperVStopDeleteResponse {
    status: number;
    payload: unknown;
}
export type HyperVReplayResult = {
    ok: true;
    reconciled: boolean;
    hyperVNetworkAllocationCleanup?: Record<string, unknown> | null;
} | {
    ok: false;
    status: number;
    error: string;
    detail?: string;
};
export function hyperVRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
export function hyperVField(value: unknown, field: string): string | null { if (!hyperVRecord(value))
    return null; const candidate = value[field]; return typeof candidate === "string" && candidate ? candidate : null; }
export function hyperVSelectedDevice(devices: unknown[], id: string): Record<string, unknown> | undefined { return devices.find((value): value is Record<string, unknown> => hyperVRecord(value) && value.id === id); }
export function hyperVStopReplacement(current: Record<string, unknown>, observation: HyperVTerminalObservation | null, timestamp: string): Record<string, unknown> {
    return {
        ...current, status: "stopped", ...(observation ? {
            vmId: observation.vmId, vmName: observation.vmName, runtimeState: observation.state, hyperVStatus: observation.status
        } : {}), updatedAt: timestamp
    };
}
