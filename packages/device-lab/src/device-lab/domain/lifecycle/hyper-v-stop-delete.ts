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
export type HyperVCommandExecution<Receipt> = {
    receipt?:Receipt;
    mode: string;
    provider: string;
    status?: number | null;
    stdout?: string;
    stderr?: string;
    error?: string;
    timedOut?: boolean;
};
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
/** Native cleanup evidence is carried outward; policy reads only release facts. */
export type HyperVNetworkCleanupEvidence = import('../hyper-v-network-trust.js').HyperVNetworkRelease & {networkCleanup?:unknown};
export interface HyperVArtifactEvidence extends HyperVCleanupEvidence {
    removed: boolean;
}
export interface HyperVPublication {
    found: boolean;
    matched: boolean;
    device: unknown;
}
export interface HyperVStateFailure {reason:'conflict'|'state-write-failed';error:string;backend?:string;stateKey?:string;detail?:string}
export type HyperVStopDeleteFailureReason='invalid'|'missing'|'conflict'|'provider-unavailable'|'provider-failed'|'deadline'|'state-write-failed';
export interface HyperVStopDeleteFacts<Connection,Receipt> {
 ownerId?:string;backend?:string;stateKey?:string;command?:string;deviceId?:string;device?:unknown;force?:boolean;dryRun?:boolean;invoked?:boolean;
 error?:string;detail?:string;missing?:string[];found?:boolean;idempotent?:boolean;alreadyMissing?:boolean;reconciled?:boolean;
 auxiliaryCleanup?:import('../broker-owner-cleanup.js').AuxiliaryCleanup;execution?:HyperVCommandExecution<Receipt>;mutatesHost?:boolean;
 networkCleanup?:HyperVNetworkCleanupEvidence|null;artifactCleanup?:HyperVArtifactEvidence|null;preparation?:HyperVStopDeletePreparation<Connection>;
}
export type HyperVStopDeleteOutcome<Connection,Receipt>=HyperVStopDeleteFacts<Connection,Receipt>&(
 {kind:'preview';preparation:HyperVStopDeletePreparation<Connection>;device:unknown;invoked:false;dryRun:true;journalDisposition:'clear'} |
 {kind:'already-missing';device:null;idempotent:true;alreadyMissing:true;journalDisposition:'clear'} |
 {kind:'stopped'|'deleted';device:unknown;execution:HyperVCommandExecution<Receipt>;invoked:true;dryRun:false;journalDisposition:'clear'} |
 {kind:'replayed';reconciled:true;device:null;journalDisposition:'clear'} |
 {kind:'refused'|'uncertain';error:string;reason:HyperVStopDeleteFailureReason;journalDisposition:'clear'|'retain'});
export type HyperVStopDeletePreparation<Connection>={kind:'prepared';connection:Connection}|{kind:'unavailable';error:string;missing:string[]};
export type HyperVReplayResult = {
    ok: true;
    reconciled: boolean;
    networkCleanup?: HyperVNetworkCleanupEvidence | null;
} | {
    ok: false;
    reason: HyperVStopDeleteFailureReason;
    journalDisposition: "retain";
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
