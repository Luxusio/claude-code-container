import { cleanupRecord, type CleanupRpcResult, type PhysicalRecord } from './broker-owner-cleanup.js';
export type PhysicalParamError = {
    ok: false;
    status: number;
    error: string;
    allowed?: string[];
};
export interface AttachParams {
    ok: true;
    backend: string;
    stateKey: string;
    deviceId: string;
    name: string | null;
    serial: string | null;
    udid: string | null;
    connection: string;
    connectionProvided: boolean;
    host: string | null;
    port: number | null;
}
export interface AppleTrustParams {
    ok: true;
    action: string;
    backend: 'ios-device';
    udid: string | null;
}
export interface AppleHostDevice {
    name: string;
    udid: string;
    version: string | null;
    connection: string;
    availability: string;
    raw: string;
}
export interface PhysicalCommand {
    mode: 'noop';
    provider: string;
    reason: string;
}
export interface PhysicalExecution {
    mode?: string;
    provider?: string;
    status?: number | null;
    stdout?: string;
    stderr?: string;
    error?: string;
    timedOut?: boolean;
    executable?: string;
    args?: string[];
    [key: string]: unknown;
}
export interface PhysicalStopRequest {
    backend: string;
    stateKey: string;
    deviceId: string;
    force: boolean;
    dryRun: boolean;
}
export function commandSucceeded(command: PhysicalExecution) { return command.status === 0 && !command.error; }
export function physicalStopReplacement(device: PhysicalRecord, timestamp: string) { return {
    ...device, status: 'detached', leaseClaimId: null, leaseClaimNonce: null, updatedAt: timestamp
}; }
export function validateAttachParams(params: unknown, deriveDeviceId: (backend: string, identity: string) => string): PhysicalParamError | AttachParams {
    if (!cleanupRecord(params)) {
        return {
            ok: false, status: 400, error: "invalid-attach-params"
        };
    }
    const input = params;
    const backend = typeof input.backend === "string" ? input.backend : "";
    if (!["android-device", "ios-device"].includes(backend)) {
        return {
            ok: false, status: 400, error: "invalid-attach-backend", allowed: ["android-device", "ios-device"]
        };
    }
    const stateKey = backend;
    const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : null;
    const serial = typeof input.serial === "string" && input.serial.trim() ? input.serial.trim() : null;
    const udid = typeof input.udid === "string" && input.udid.trim() ? input.udid.trim() : null;
    const identity = backend === "android-device" ? serial || (typeof input.host === "string" ? input.host : null) : udid;
    const deviceId = typeof input.deviceId === "string" && input.deviceId.trim()
        ? input.deviceId.trim()
        : deriveDeviceId(backend, String(identity || name || "real-device"));
    if (!deviceId || deviceId.length > 128 || /[^a-zA-Z0-9._:-]/.test(deviceId)) {
        return {
            ok: false, status: 400, error: "invalid-device-id"
        };
    }
    const connectionProvided = typeof input.connection === "string";
    const connection = connectionProvided ? String(input.connection) : "usb";
    if (!["usb", "wifi"].includes(connection))
        return {
            ok: false, status: 400, error: "invalid-connection"
        };
    const host = typeof input.host === "string" && input.host.trim() ? input.host.trim() : null;
    const port = Number.isFinite(input.port) ? Number(input.port) : null;
    return {
        ok: true, backend, stateKey, deviceId, name, serial, udid, connection, connectionProvided, host, port
    };
}
export function validateAppleTrustParams(params: unknown): PhysicalParamError | AppleTrustParams {
    if (!cleanupRecord(params)) {
        return {
            ok: false, status: 400, error: "invalid-apple-trust-params"
        };
    }
    const input = params;
    const backend = typeof input.backend === "string" ? input.backend : "ios-device";
    if (backend !== "ios-device") {
        return {
            ok: false, status: 400, error: "invalid-apple-trust-backend", allowed: ["ios-device"]
        };
    }
    const action = typeof input.action === "string" && input.action.trim() ? input.action.trim() : "status";
    if (!["status", "pair", "connect"].includes(action)) {
        return {
            ok: false, status: 400, error: "invalid-apple-trust-action", allowed: ["status", "pair", "connect"]
        };
    }
    const udid = typeof input.udid === "string" && input.udid.trim() ? input.udid.trim() : null;
    return {
        ok: true, action, backend, udid
    };
}
function appleTrustManualSteps() {
    return [
        "Connect the iPhone or iPad to the macOS host over USB, unlock it, and accept the Trust This Computer prompt.",
        "Enable Developer Mode on the device when iOS requires it.",
        "Open Xcode Devices and Simulators on the macOS host and enable network pairing if Wi-Fi attach is needed.",
        "Re-run device_wireless with backend=ios-device and action=status, then call device_attach when xctrace reports the UDID as USB or Network.",
    ];
}
export function appleTrustDiagnostic(action: string, udid: string | null, hostDevice: AppleHostDevice | null, inventory: PhysicalExecution | null) {
    const visible = Boolean(hostDevice);
    const networkVisible = hostDevice?.connection === "wifi";
    const unavailable = hostDevice?.availability === "unavailable";
    const readyToAttach = visible && !unavailable;
    const manualRequired = action !== "status" || !readyToAttach;
    return {
        backend: "ios-device",
        action,
        udid,
        provider: "xcrun-xctrace",
        selected: hostDevice,
        visible,
        networkVisible,
        readyToAttach,
        manualRequired,
        trustState: visible ? unavailable ? "visible-unavailable" : "visible-to-xctrace" : "not-visible",
        supportedActions: ["status"],
        unsupportedActions: ["pair", "connect"],
        attachFlow: networkVisible
            ? "Call device_attach with backend=ios-device, connection=wifi, and this UDID."
            : readyToAttach
                ? "Call device_attach with backend=ios-device and this UDID for USB attach, or complete Xcode network pairing first for Wi-Fi attach."
                : "Complete Apple trust, Developer Mode, and Xcode pairing on the macOS host, then re-run this status check.",
        manualSteps: appleTrustManualSteps(),
        safety: {
            bypassesTrustPrompt: false,
            powersOffDevice: false,
            erasesDevice: false,
            disconnectsDevice: false,
        },
        inventoryCommand: inventory ? {
            provider: inventory.provider,
            executable: inventory.executable,
            args: inventory.args,
            status: inventory.status,
            stderr: inventory.stderr,
        } : null,
    };
}
export function detachedPhysicalDeviceCanReattach(existing: Record<string, unknown>, deviceId: string, hardwareId: string, hardwareField: "serial" | "udid") {
    return existing.id === deviceId
        && existing[hardwareField] === hardwareId
        && existing.status === "detached";
}
export function physicalParamError(parsed: PhysicalParamError): CleanupRpcResult { return {
    status: parsed.status, payload: {
        ok: false, error: parsed.error, ...(parsed.allowed ? {
            allowed: parsed.allowed
        } : {})
    }
}; }
export function physicalOwnerConflict(devices: unknown[], device: PhysicalRecord, hardwareField: 'serial' | 'udid') {
    const conflicts = devices.filter((candidate): candidate is PhysicalRecord => cleanupRecord(candidate) && (candidate.id === device.id || candidate[hardwareField] === device[hardwareField]));
    return {
        conflicts, allowed: conflicts.length === 0 || conflicts.length === 1 && detachedPhysicalDeviceCanReattach(conflicts[0], String(device.id), String(device[hardwareField]), hardwareField)
    };
}
export function physicalStopCommand(backend: string): PhysicalCommand { return {
    mode: 'noop', provider: backend, reason: backend === 'android-device' ? 'physical Android stop/delete does not power off or disconnect the real device' : 'physical iOS stop/delete does not power off, erase, or disconnect the real device'
}; }
export function physicalFailureDetail(result: PhysicalExecution): string {
    const parts = [result.error ? `error: ${result.error}` : '', result.stderr ? `stderr: ${result.stderr}` : '', result.stdout ? `stdout: ${result.stdout}` : ''].filter(Boolean);
    return (parts.join('\n') || `provider exited with status ${String(result.status)}`).slice(0, 8192);
}
