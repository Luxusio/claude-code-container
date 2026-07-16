import { randomUUID } from "crypto";

export function runtimeGenerationMatches(expected, current, legacyIdentityFields = []) {
    if (expected === null || expected === undefined) return current === null || current === undefined;
    if (!expected || typeof expected !== "object" || Array.isArray(expected)
        || !current || typeof current !== "object" || Array.isArray(current)) return false;
    const expectedRuntimeId = typeof expected.runtimeId === "string" ? expected.runtimeId : null;
    const currentRuntimeId = typeof current.runtimeId === "string" ? current.runtimeId : null;
    if (expectedRuntimeId || currentRuntimeId) return expectedRuntimeId !== null && expectedRuntimeId === currentRuntimeId;
    const presentIdentityFields = legacyIdentityFields.filter((field) => expected[field] !== undefined || current[field] !== undefined);
    return presentIdentityFields.length > 0 && presentIdentityFields.every((field) => expected[field] === current[field]);
}

export function recordingGenerationMatches(expected, current) {
    return runtimeGenerationMatches(expected, current, [
        "authority",
        "processOwner",
        "startedBy",
        "pid",
        "provider",
        "startedAt",
        "remotePath",
        "localPath",
        "sessionId",
    ]);
}

export function appiumGenerationMatches(expected, current) {
    return runtimeGenerationMatches(expected, current, [
        "authority",
        "processOwner",
        "startedBy",
        "serverPid",
        "serverUrl",
        "sessionId",
        "updatedAt",
    ]);
}

export function transitionRecordingGeneration(updateDevice, deviceId, expected, replacement, updatedAt = new Date().toISOString()) {
    let committed = false;
    const device = updateDevice(deviceId, (current) => {
        if (!recordingGenerationMatches(expected, current.recording)) return current;
        committed = true;
        return { ...current, recording: replacement, updatedAt };
    });
    return { committed, device };
}

export function claimRecordingFinalization(updateDevice, deviceId, expected, overrides = {}, updatedAt = new Date().toISOString()) {
    if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
        return { committed: false, device: null };
    }
    const replacement = {
        ...expected,
        ...overrides,
        active: false,
        recorderRuntimeId: expected.recorderRuntimeId || expected.runtimeId || null,
        runtimeId: randomUUID(),
        finalizingAt: updatedAt,
    };
    return transitionRecordingGeneration(updateDevice, deviceId, expected, replacement, updatedAt);
}

export function transitionAppiumGeneration(updateDevice, deviceId, expected, replacement, updatedAt = new Date().toISOString()) {
    let committed = false;
    const device = updateDevice(deviceId, (current) => {
        if (!appiumGenerationMatches(expected, current.appium)) return current;
        committed = true;
        return { ...current, appium: replacement, updatedAt };
    });
    return { committed, device };
}
