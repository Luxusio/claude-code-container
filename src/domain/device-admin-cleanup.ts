export interface CleanupBackend { stateKey: string; name: string }
export type CleanupRecord = Record<string, unknown> & { id?: string; status?: string };
export type CleanupCommandResult = { command: string; status: number | null; stderr?: string; stdout?: string };
export type CleanupDeviceResult = { id: string; backend: string; previousStatus: string; status: "stopped" | "skipped" | "failed"; commands: CleanupCommandResult[]; reason?: string };
export type OwnedCleanupRuntime = { label: "appium" | "recording" | "runtime"; runtime: Record<string, unknown>; signal: "SIGINT" | "SIGTERM"; signalDirectly: boolean };
export function isGuid(value: unknown): value is string {
    return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function serialForAndroid(device: CleanupRecord): string | null {
    if (typeof device.serial === "string" && device.serial) return device.serial;
    if (typeof device.port === "number") return `emulator-${device.port}`;
    return null;
}

export function simctlTarget(device: CleanupRecord): string | null {
    for (const key of ["udid", "simulatorName", "name", "id"]) {
        const value = device[key];
        if (typeof value === "string" && value) return value;
    }
    return null;
}

export function stopMacosArgs(provider: string, instance: string): string[] | null {
    if (provider === "tart") return ["stop", instance];
    if (provider === "vz") return ["stop", instance];
    if (provider === "utmctl") return ["stop", instance];
    return null;
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

export function lifecycleStopFailed(backend: CleanupBackend, device: CleanupRecord, commands: CleanupCommandResult[]): boolean {
    if (!lifecycleStopRequired(backend, device)) return false;
    return commands.length === 0 || commands.some((command) => command.status !== 0);
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

