import { ownerId } from "./context.mjs";
import { readPhysicalLeases } from "./state/physical-lease-store.mjs";

function targetKindFor(target) {
    if (target?.backend === "x11" || target?.kind === "display") return "current-display";
    if (target?.physical) return "physical-device";
    return "virtual-device";
}

function runtimeStateFor(target) {
    if (target?.lifecycle) return target.lifecycle;
    if (target?.status) return target.status;
    if (target?.available === false) return "unavailable";
    if (target?.available === true) return "available";
    return "unknown";
}

function readinessFor(target, runtimeState) {
    if (target?.available === false) return { state: "unavailable", reason: "missing-prerequisites" };
    if (["running", "booted", "attached", "current", "available"].includes(runtimeState)) return { state: "ready" };
    if (["stopped", "shutdown"].includes(runtimeState)) return { state: "stopped" };
    return { state: "unknown" };
}

function leaseHardwareId(target) {
    return target?.hardwareId || target?.serial || target?.udid || null;
}

function leaseExpired(lease) {
    return typeof lease?.expiresAt === "string" && Date.parse(lease.expiresAt) <= Date.now();
}

function leaseStateFor(target) {
    if (!target?.physical) return { state: "not-required" };
    const backend = target.backend;
    const hardwareId = leaseHardwareId(target);
    if (!backend || !hardwareId) return { state: "unknown", hardwareId };
    const lease = readPhysicalLeases(backend).find((entry) => entry.hardwareId === hardwareId && entry.ownerId === ownerId()) || null;
    if (!lease) return { state: "missing", hardwareId };
    return {
        state: leaseExpired(lease) ? "expired" : "owned",
        ownerId: lease.ownerId,
        hardwareId,
        deviceId: lease.deviceId || target.id || null,
        expiresAt: lease.expiresAt || null,
        heartbeatAt: lease.heartbeatAt || null,
    };
}

function sessionStateFor(target) {
    const appium = target?.appium || null;
    const recording = target?.recording || null;
    const helper = target?.helper || null;
    const active = Boolean(appium?.sessionId || appium?.serverPid || recording?.active);
    return {
        state: active ? "active" : "none",
        appium: appium ? {
            serverUrl: appium.serverUrl || null,
            serverPid: appium.serverPid || null,
            sessionId: appium.sessionId || null,
            updatedAt: appium.updatedAt || null,
        } : null,
        recording: recording ? {
            active: Boolean(recording.active),
            provider: recording.provider || null,
            startedAt: recording.startedAt || null,
        } : null,
        helper: helper ? {
            status: helper.status || helper.provisioning?.status || null,
            provider: helper.provisioning?.provider || null,
        } : null,
    };
}

export function normalizeTargetStatus(target, options = {}) {
    const runtimeState = options.runtimeState || runtimeStateFor(target);
    return {
        targetKind: options.targetKind || targetKindFor(target),
        creatable: Boolean(options.creatable ?? target?.creatable),
        attachable: Boolean(options.attachable ?? target?.attachable),
        runtimeState,
        readiness: options.readiness || readinessFor(target, runtimeState),
        leaseState: options.leaseState || leaseStateFor(target),
        sessionState: options.sessionState || sessionStateFor(target),
    };
}

export function withTargetStatus(target, options = {}) {
    const targetStatus = normalizeTargetStatus(target, options);
    return {
        ...target,
        ...targetStatus,
        targetStatus,
    };
}
