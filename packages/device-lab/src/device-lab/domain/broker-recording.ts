export type BrokerRecordingResponse = { status: number; payload: unknown };
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
export type BrokerRecordingCommand = { mode: "exec" | "detached"; provider: string; executable: string; args: string[] };
const DEVICE_BROKER_RECORDING_PROVIDERS = new Map([
    ["android", "adb-screenrecord"],
    ["android-device", "adb-screenrecord"],
    ["ios", "simctl-recordVideo"],
    ["windows", "windows-helper-frame-archive"],
    ["macos", "ssh-screencapture-video"],
]);

export function recordingUnsupported(ownerId: string, parsed: BrokerRecordingRequest, match: BrokerRecordingTarget, reason: string): BrokerRecordingResponse {
    return {
        status: 501,
        payload: {
            ok: false,
            error: "broker-device-recording-unsupported",
            ownerId,
            tool: parsed.tool,
            backend: match.backend,
            stateKey: match.stateKey,
            deviceId: parsed.deviceId,
            reason,
            fallbackAvailable: false,
            directProviderFallback: false,
            startsDevices: false,
        },
    };
}

export function recordingRuntimeMatches(expected: unknown, current: unknown): boolean {
    if (expected === null || expected === undefined) return current === null || current === undefined;
    if (!recordingObject(expected) || Array.isArray(expected)
        || !recordingObject(current) || Array.isArray(current)) return false;
    const expectedRecord = expected;
    const currentRecord = current;
    const expectedRuntimeId = typeof expectedRecord.runtimeId === "string" ? expectedRecord.runtimeId : null;
    const currentRuntimeId = typeof currentRecord.runtimeId === "string" ? currentRecord.runtimeId : null;
    if (expectedRuntimeId || currentRuntimeId) return expectedRuntimeId !== null && expectedRuntimeId === currentRuntimeId;
    const identityFields = ["authority", "processOwner", "startedBy", "pid", "provider", "startedAt", "remotePath", "localPath"];
    return identityFields.every((field) => expectedRecord[field] === currentRecord[field]);
}

export function recordingSerial(device: Record<string, unknown>): string | null {
    if (typeof device.serial === "string" && device.serial) return device.serial;
    return typeof device.port === "number" && Number.isFinite(device.port) && device.port ? `emulator-${device.port}` : null;
}

export function recordingLaunchPlan(
    request: BrokerRecordingRequest,
    target: BrokerRecordingTarget,
    facts: { executable: string; providerTarget: string; localPath: string; timestamp: string },
): { command: BrokerRecordingCommand; recording: Record<string, unknown> } {
    const provider = DEVICE_BROKER_RECORDING_PROVIDERS.get(target.stateKey) || "unknown";
    const common = {
        active: true, provider, authority: "host-broker", processOwner: "host-broker",
        startedBy: "broker.device.recording.start", localPath: facts.localPath, startedAt: facts.timestamp,
    };
    if (target.stateKey === "android" || target.stateKey === "android-device") {
        const remotePath = request.remotePath || `/sdcard/ccc-${String(request.deviceId)}-recording.mp4`;
        const timeLimitSec = request.timeLimitSec || 180;
        return {
            command: { mode: "detached", provider: "adb", executable: facts.executable,
                args: ["-s", facts.providerTarget, "shell", "screenrecord", "--time-limit", String(timeLimitSec), remotePath] },
            recording: { ...common, remotePath, timeLimitSec },
        };
    }
    return {
        command: { mode: "detached", provider: "xcrun", executable: facts.executable,
            args: ["simctl", "io", facts.providerTarget, "recordVideo", facts.localPath] },
        recording: { ...common, timeLimitSec: request.timeLimitSec },
    };
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
