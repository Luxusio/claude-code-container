export type BrokerRecordingExecution = { status?: number | null; error?: string; pid?: number; processIdentity?: unknown; receipt: unknown };
export type BrokerRecordingSignal = {attempted: boolean; ok: boolean; stale?: boolean; receipt: unknown};
export type BrokerRecordingRefusal = {
    kind: "refused" | "uncertain";
    reason: "invalid" | "missing" | "conflict" | "forbidden" | "unsupported" | "provider-failed" | "state-read-failed";
    error: string; ownerId?: string; tool?: string; backend?: string | null; stateKey?: string; deviceId?: string | null;
    detail?: string; matches?: (string | null)[]; leaseError?: string; missing?: unknown; remedy?: string; recording?: unknown; found?: boolean; currentRecording?: unknown;
    signal?: BrokerRecordingSignal; rollback?: BrokerRecordingSignal; execution?: BrokerRecordingExecution; executions?: BrokerRecordingExecution[];
    unsupportedReason?: string;
};
export type BrokerRecordingFacts = {ownerId: string; tool: string; backend: string | null; stateKey: string; deviceId: string | null};
export type BrokerRecordingObserved = BrokerRecordingFacts & {kind: "observed"; recording: unknown; provider: string | null; supported: boolean};
export type BrokerRecordingStarted = BrokerRecordingFacts & {kind: "started"; recording: Record<string, unknown>; device: Record<string, unknown> | null; provider: unknown; execution: BrokerRecordingExecution};
export type BrokerRecordingStopped = BrokerRecordingFacts & {kind: "stopped" | "stopped-with-copy-failure"; error?: "recording-artifact-copy-failed"; recording: Record<string, unknown>; device: Record<string, unknown> | null; provider: string; signal: BrokerRecordingSignal; executions: BrokerRecordingExecution[]};
export type BrokerRecordingStatusOutcome = BrokerRecordingObserved | BrokerRecordingRefusal;
export type BrokerRecordingStartOutcome = BrokerRecordingStarted | BrokerRecordingRefusal;
export type BrokerRecordingStopOutcome = BrokerRecordingStopped | BrokerRecordingRefusal;
export type BrokerRecordingResponse = BrokerRecordingObserved | BrokerRecordingStarted | BrokerRecordingStopped | BrokerRecordingRefusal;

export type BrokerRecordingRequest = {
    tool: string;
    backend: string | null;
    stateKey: string | null;
    deviceId: string | null;
    remotePath: string | null;
    localPath: string | null;
    timeLimitSec: number | null;
};
export type BrokerRecordingTarget = { stateKey: string; backend: string | null; device: Record<string, unknown> };
const DEVICE_BROKER_RECORDING_PROVIDERS = new Map([
    ["android", "adb-screenrecord"],
    ["android-device", "adb-screenrecord"],
    ["ios", "simctl-recordVideo"],
    ["windows", "windows-helper-frame-archive"],
    ["macos", "ssh-screencapture-video"],
]);

export function recordingUnsupported(ownerId: string, parsed: BrokerRecordingRequest, match: BrokerRecordingTarget, unsupportedReason: string): BrokerRecordingRefusal {
    return {kind: "refused", reason: "unsupported", error: "broker-device-recording-unsupported", ownerId,
        tool: parsed.tool, backend: match.backend, stateKey: match.stateKey, deviceId: parsed.deviceId, unsupportedReason};
}

export function recordingRuntimeMatches(expected: unknown, current: unknown): boolean {
    if (expected === null || expected === undefined) return current === null || current === undefined;
    if (!recordingObject(expected) || Array.isArray(expected)
        || !recordingObject(current) || Array.isArray(current)) return false;
    const expectedRecord = expected;
    const currentRecord = current;
    const expectedRuntimeId = typeof expectedRecord.runtimeId === "string" ? expectedRecord.runtimeId : null;
    const currentRuntimeId = typeof currentRecord.runtimeId === "string" ? currentRecord.runtimeId : null;
    if ((expectedRuntimeId || currentRuntimeId) && (expectedRuntimeId === null || expectedRuntimeId !== currentRuntimeId)) return false;
    const identityFields = ["authority", "processOwner", "startedBy", "pid", "provider", "startedAt", "remotePath", "localPath",
        "active", "stoppedAt", "artifactCopyPending", "artifactCopied"];
    return identityFields.every((field) => expectedRecord[field] === currentRecord[field]);
}

/** Captured recording target identity excludes mutable recording, status and heartbeat fields. */
export function recordingTargetMatches(target: BrokerRecordingTarget, current: unknown): boolean {
    if (!recordingObject(current) || Array.isArray(current)) return false;
    const fields = ["id", "backend", "incarnationId", "createdAt"];
    if (target.stateKey === "android" || target.stateKey === "android-device") fields.push("serial", "port");
    if (target.stateKey === "ios" || target.stateKey === "ios-device") fields.push("udid", "simulatorName");
    if (target.stateKey === "android-device" || target.stateKey === "ios-device") fields.push("leaseClaimId", "leaseClaimNonce");
    return fields.every(field => target.device[field] === current[field]);
}

/** A stopped Android artifact remains recoverable until remote cleanup and state clearing succeed. */
export function recordingCopyPending(value: unknown): boolean {
    return recordingObject(value) && !Array.isArray(value)
        && value.active === false && typeof value.stoppedAt === "string" && Boolean(value.stoppedAt)
        && value.provider === "adb-screenrecord" && typeof value.remotePath === "string" && Boolean(value.remotePath)
        && value.authority === "host-broker" && value.processOwner === "host-broker"
        && value.startedBy === "broker.device.recording.start";
}

export function recordingSerial(device: Record<string, unknown>): string | null {
    if (typeof device.serial === "string" && device.serial) return device.serial;
    return typeof device.port === "number" && Number.isFinite(device.port) && device.port ? `emulator-${device.port}` : null;
}

/** Recording metadata policy; native command formatting is not part of this plan. */
export function recordingLaunchPlan(request: BrokerRecordingRequest, target: BrokerRecordingTarget, facts: {localPath: string; timestamp: string}): {active: boolean; provider: string; authority: string; processOwner: string; startedBy: string; localPath: string; startedAt: string; remotePath?: string; timeLimitSec: number | null} {
    const provider = DEVICE_BROKER_RECORDING_PROVIDERS.get(target.stateKey) || "unknown";
    const common = {active: true, provider, authority: "host-broker", processOwner: "host-broker", startedBy: "broker.device.recording.start", localPath: facts.localPath, startedAt: facts.timestamp};
    return target.stateKey === "android" || target.stateKey === "android-device"
        ? {...common, remotePath: request.remotePath || `/sdcard/ccc-${String(request.deviceId)}-recording.mp4`, timeLimitSec: request.timeLimitSec || 180}
        : {...common, timeLimitSec: request.timeLimitSec};
}

export function recordingPublication(record: Record<string, unknown>, recording: Record<string, unknown> | null, updatedAt: string): Record<string, unknown> {
    return { ...record, recording, updatedAt };
}

export function recordingObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object";
}

export function recordingProvider(stateKey: string): string | null {
    return DEVICE_BROKER_RECORDING_PROVIDERS.get(stateKey) || null;
}
