export interface CleanupBackend { stateKey: string; name: string }
export type CleanupRecord = Record<string, unknown> & { id?: string; status?: string };
export type CleanupCommandResult = { command: string; status: number | null; stderr?: string; stdout?: string };
export type CleanupDeviceResult = { id: string; backend: string; previousStatus: string; status: "stopped" | "skipped" | "failed"; commands: CleanupCommandResult[]; reason?: string };
export type OwnedCleanupRuntime = { label: "appium" | "recording" | "runtime"; runtime: Record<string, unknown>; signal: "SIGINT" | "SIGTERM"; signalDirectly: boolean };
export type CleanupStopEffect =
    | { kind: "android-recording-stop"; device: CleanupRecord }
    | { kind: "android-emulator-stop"; device: CleanupRecord }
    | { kind: "ios-simulator-stop"; device: CleanupRecord }
    | { kind: "windows-sandbox-stop"; ownerId: string; device: CleanupRecord }
    | { kind: "macos-instance-stop"; device: CleanupRecord };
export type CleanupStopEffectsResult = { ok: boolean; commands: CleanupCommandResult[] };
export type CleanupAllProjectsResult = { ok: boolean; projects: { ownerId: string; results: CleanupDeviceResult[] }[] };

export function windowsSandboxClaimMatchesOwnerDevice(
    ownerId: string,
    device: CleanupRecord,
    current: Readonly<Record<string, unknown>> | null,
): boolean {
    const expectedClaimId = device.singletonClaimId;
    const legacy = expectedClaimId === null || expectedClaimId === undefined;
    if (!legacy && (typeof expectedClaimId !== "string" || !expectedClaimId)) return false;
    if (!current) return legacy;
    const sameGeneration = legacy ? current.claimId === undefined : current.claimId === expectedClaimId;
    const sameOwner = current.ownerId === ownerId;
    const sameDevice = !device.id || !current.deviceId || current.deviceId === device.id;
    const sameSandbox = typeof device.sandboxId !== "string" || !current.sandboxId || current.sandboxId === device.sandboxId;
    return sameGeneration && sameOwner && sameDevice && sameSandbox;
}

export function lifecycleActive(device: CleanupRecord): boolean {
    return ["running", "starting", "booted"].includes(device.status || "");
}

export function appiumServerPid(device: CleanupRecord): unknown {
    const appium = device.appium as { serverPid?: unknown } | null | undefined;
    return appium?.serverPid;
}

export function recordingPid(device: CleanupRecord): unknown {
    const recording = device.recording as { pid?: unknown } | null | undefined;
    return recording?.pid;
}

export function hasVolatileProcessMetadata(device: CleanupRecord): boolean {
    return Boolean(device.pid || appiumServerPid(device) || recordingPid(device) || device.recording || device.appium);
}

export function ownedCleanupRuntimes(device: CleanupRecord): OwnedCleanupRuntime[] {
    const runtimes: OwnedCleanupRuntime[] = [];
    const recording = device.recording;
    if (recording && typeof recording === "object" && !Array.isArray(recording)) {
        const metadata = recording as Record<string, unknown>;
        if (typeof metadata.runtimeId === "string" && typeof metadata.pid === "number" && metadata.processIdentity) {
            runtimes.push({ label: "recording", runtime: metadata, signal: "SIGINT", signalDirectly: true });
        }
    }
    const appium = device.appium;
    if (appium && typeof appium === "object" && !Array.isArray(appium)) {
        const metadata = appium as Record<string, unknown>;
        if (metadata.processOwner === "device-lab-mcp"
            && metadata.startedBy === "direct-provider"
            && typeof metadata.runtimeId === "string"
            && typeof metadata.serverPid === "number"
            && metadata.processIdentity) {
            runtimes.push({
                label: "appium",
                runtime: { ...metadata, pid: metadata.serverPid },
                signal: "SIGTERM",
                signalDirectly: true,
            });
        }
    }
    const runtime = device.runtime;
    if (runtime && typeof runtime === "object" && !Array.isArray(runtime)) {
        const metadata = runtime as Record<string, unknown>;
        if (typeof metadata.runtimeId === "string" && typeof metadata.pid === "number" && metadata.processIdentity) {
            runtimes.push({ label: "runtime", runtime: metadata, signal: "SIGTERM", signalDirectly: false });
        }
    }
    return runtimes;
}

export function lifecycleStopRequired(backend: CleanupBackend, device: CleanupRecord): boolean {
    if (!lifecycleActive(device)) return false;
    if (backend.stateKey === "android-device" || backend.stateKey === "ios-device") return false;
    return true;
}

export function stoppedDevice(device: CleanupRecord): CleanupRecord {
    return {
        ...device,
        status: "stopped",
        pid: null,
        appium: null,
        recording: null,
    };
}

export function cleanedDevice(backend: CleanupBackend, device: CleanupRecord): CleanupRecord {
    if (backend.stateKey === "android-device" || backend.stateKey === "ios-device") {
        return {
            ...device,
            status: "detached",
            pid: null,
            appium: null,
            recording: null,
            };
    }
    return stoppedDevice(device);
}

export function shouldCleanupDevice(backend: CleanupBackend, device: CleanupRecord): boolean {
    if ((backend.stateKey === "android-device" || backend.stateKey === "ios-device") && device.status === "attached") return true;
    return lifecycleActive(device) || hasVolatileProcessMetadata(device);
}

