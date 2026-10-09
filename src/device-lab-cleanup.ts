// Cohesive native cleanup authority. Legacy admin imports and reexports shared bindings.
import { existsSync, readdirSync, unlinkSync } from "fs";
import { createHash } from "crypto";
import { homedir } from "os";
import { dirname, join } from "path";
import { spawnSync } from "child_process";
import { isDeepStrictEqual } from "util";
import { deviceLabOwnerBasis, deviceLabOwnerId as canonicalDeviceLabOwnerId } from "@ccc/device-lab/device-lab-owner.js";
import { inspectDeviceRuntimeProcessIdentity, signalDeviceRuntimeProcess } from "@ccc/device-lab/device-lab-process-identity.js";
import { assertOwnerDeviceStateWritable, readOwnerDeviceStateFile } from "@ccc/device-lab/device-lab-owner-state.js";
import { readPhysicalLeaseStateFile, readWindowsSandboxLockStateFile, validatePhysicalLease } from "@ccc/device-lab/device-lab-ownership-state.js";
import { withSharedMutationLock, writeJsonFileAtomically } from "@ccc/device-lab/device-lab-shared-state.js";
import { readDeviceLabStateFile } from "@ccc/device-lab/device-lab-state-file.js";

export const DEVICE_BACKENDS = [
    { stateKey: "android", name: "android-emulator", tools: ["adb", "emulator", "avdmanager"] },
    { stateKey: "android-device", name: "android-device", tools: ["adb"] },
    { stateKey: "ios", name: "ios-simulator", tools: ["xcrun"] },
    { stateKey: "ios-device", name: "ios-device", tools: ["xcrun"] },
    { stateKey: "windows", name: "windows-sandbox", tools: ["wsb"] },
    { stateKey: "windows-vm", name: "windows-vm", tools: ["powershell.exe"] },
    { stateKey: "macos", name: "macos-vm", tools: ["tart", "vz", "utmctl"] },
    { stateKey: "linux-vm", name: "linux-vm", tools: ["powershell.exe", "ssh", "scp"] },
] as const;

export type Backend = typeof DEVICE_BACKENDS[number];

export type DeviceRecord = Record<string, unknown> & { id?: string; status?: string };

export type CommandResult = { command: string; status: number | null; stderr?: string; stdout?: string };

export type OwnerDeviceMatch = { backend: Backend; devices: DeviceRecord[]; index: number; device: DeviceRecord };

type CleanupDeviceResult = { id: string; backend: string; previousStatus: string; status: "stopped" | "skipped" | "failed"; commands: CommandResult[]; reason?: string };

export type PhysicalLeaseRecord = Record<string, unknown> & { ownerId?: string; deviceId?: string; hardwareId?: string; expiresAt?: string };

const cleanupWaiter = new Int32Array(new SharedArrayBuffer(4));

export function deviceLabOwnerIdentity(cwd = process.cwd(), profile?: string): { ownerId: string; basis: string } {
    const projectPath = cwd || "/project";
    return {
        ownerId: canonicalDeviceLabOwnerId(projectPath, profile),
        basis: deviceLabOwnerBasis(projectPath, profile),
    };
}

export function deviceLabOwnerId(cwd = process.cwd(), profile?: string): string {
    return deviceLabOwnerIdentity(cwd, profile).ownerId;
}

function ownerDevicesFile(ownerId: string, stateKey: string): string {
    return join(homedir(), ".ccc/devices/owners", ownerId, stateKey, "devices.json");
}

export function physicalLeaseLockFile(stateKey: string, hardwareId: string): string {
    return join(homedir(), ".ccc/devices/physical-leases", stateKey, "locks", `${encodeURIComponent(hardwareId)}.json`);
}

export function physicalLeaseMutationLockFile(stateKey: string, hardwareId: string): string {
    return join(homedir(), ".ccc/devices/physical-leases", stateKey, "locks", `${encodeURIComponent(hardwareId)}.mutation.lock`);
}

export function physicalLeaseAggregateFile(stateKey: string): string {
    return join(homedir(), ".ccc/devices/physical-leases", `${stateKey}.json`);
}

export function physicalLeaseAggregateMutationLockFile(stateKey: string): string {
    return join(homedir(), ".ccc/devices/physical-leases", `${stateKey}.mutation.lock`);
}

export function readPhysicalLeaseAggregate(file: string, stateKey: string): PhysicalLeaseRecord[] {
    return readDeviceLabStateFile(file, (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid physical lease aggregate");
        const leases = (value as { leases?: unknown }).leases;
        if (!Array.isArray(leases)) throw new TypeError("invalid physical lease aggregate");
        return leases.map((lease) => validatePhysicalLease(lease, stateKey));
    }, "physical-lease-aggregate") ?? [];
}

export function readDevices(ownerId: string, stateKey: string): DeviceRecord[] {
    return readOwnerDeviceStateFile(ownerDevicesFile(ownerId, stateKey)) as DeviceRecord[];
}

function mutateDevices(ownerId: string, stateKey: string, updater: (devices: DeviceRecord[]) => DeviceRecord[]): DeviceRecord[] {
    return withSharedMutationLock(join(dirname(ownerDevicesFile(ownerId, stateKey)), "devices.mutation.lock"), () => {
        const devices = updater(readDevices(ownerId, stateKey));
        assertOwnerDeviceStateWritable(devices);
        writeJsonFileAtomically(ownerDevicesFile(ownerId, stateKey), { devices });
        return devices;
    });
}

function ownerDeviceOperationLockFile(ownerId: string, stateKey: string, deviceId: string): string {
    const key = createHash("sha256").update(deviceId).digest("hex").slice(0, 32);
    return join(dirname(ownerDevicesFile(ownerId, stateKey)), "operations", `${key}.lock`);
}

export function withAdminOwnerDeviceOperation<T>(ownerId: string, stateKey: string, deviceId: string, operation: () => T): T {
    return withSharedMutationLock(ownerDeviceOperationLockFile(ownerId, stateKey, deviceId), operation, {
        waitMs: 30000,
        staleMs: 15 * 60 * 1000,
    });
}

export function transitionOwnerDeviceRecord(
    ownerId: string,
    backend: Backend,
    expected: DeviceRecord,
    replacement: DeviceRecord | null,
) {
    let found = false;
    let matched = false;
    let currentDevice: DeviceRecord | null = null;
    mutateDevices(ownerId, backend.stateKey, (devices) => {
        const next: DeviceRecord[] = [];
        for (const candidate of devices) {
            if (!expected.id || candidate.id !== expected.id) {
                next.push(candidate);
                continue;
            }
            found = true;
            currentDevice = candidate;
            if (!isDeepStrictEqual(candidate, expected)) {
                next.push(candidate);
                continue;
            }
            matched = true;
            if (replacement) next.push(replacement);
        }
        return next;
    });
    return { found, matched, currentDevice };
}

export function commandPath(command: string): string | null {
    const result = process.platform === "win32"
        ? spawnSync("where", [command], { encoding: "utf-8", env: process.env, windowsHide: true })
        : spawnSync("/bin/sh", ["-c", `command -v ${command}`], {
            encoding: "utf-8",
            env: process.env,
            windowsHide: true,
        });
    if (result.status !== 0) return androidSdkToolPath(command);
    const firstPath = (result.stdout || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
    return firstPath || androidSdkToolPath(command);
}

function androidSdkToolPath(command: string): string | null {
    const executableNames = process.platform === "win32" && !/\.(exe|bat|cmd)$/i.test(command)
        ? [command, `${command}.exe`, `${command}.bat`, `${command}.cmd`]
        : [command];
    for (const sdk of androidSdkCandidates()) {
        const subdirs = androidToolSubdirs(sdk, command);
        for (const subdir of subdirs) {
            for (const executable of executableNames) {
                const candidate = join(sdk, subdir, executable);
                if (existsSync(candidate)) return candidate;
            }
        }
    }
    return null;
}

function androidSdkCandidates(): string[] {
    return [
        process.env.ANDROID_HOME,
        process.env.ANDROID_SDK_ROOT,
        process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Android", "Sdk") : null,
        process.env.APPDATA ? join(process.env.APPDATA, "Android", "Sdk") : null,
        join(homedir(), "AppData", "Local", "Android", "Sdk"),
        join(homedir(), "Android", "Sdk"),
        join(homedir(), "Library", "Android", "sdk"),
        "/opt/android-sdk",
        "/usr/local/android-sdk",
    ].filter((candidate): candidate is string => Boolean(candidate));
}

function androidToolSubdirs(sdk: string, command: string): string[] {
    if (command === "adb") return ["platform-tools"];
    if (command === "emulator") return ["emulator"];
    if (command === "avdmanager") {
        const versioned: string[] = [];
        try {
            for (const entry of readdirSync(join(sdk, "cmdline-tools"), { withFileTypes: true })) {
                if (entry.isDirectory()) versioned.push(`cmdline-tools/${entry.name}/bin`);
            }
        } catch {
            // Android command-line tools are optional.
        }
        return ["cmdline-tools/latest/bin", ...versioned, "cmdline-tools/bin", "tools/bin"];
    }
    return [];
}

function isGuid(value: unknown): value is string {
    return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function runCommand(command: string | null, args: string[], timeoutMs?: number, input?: string): CommandResult | null {
    if (!command) return null;
    const result = spawnSync(command, args, { encoding: "utf-8", env: process.env, timeout: timeoutMs, windowsHide: true, input });
    return {
        command: [command, ...args].join(" "),
        status: result.status,
        stdout: result.stdout || "",
        stderr: result.stderr || result.error?.message || "",
    };
}

export function now(): string {
    return new Date().toISOString();
}

function serialForAndroid(device: DeviceRecord): string | null {
    if (typeof device.serial === "string" && device.serial) return device.serial;
    if (typeof device.port === "number") return `emulator-${device.port}`;
    return null;
}

export function hardwareIdForPhysicalDevice(backend: Backend, device: DeviceRecord): string | null {
    if (backend.stateKey === "android-device") return serialForAndroid(device);
    if (backend.stateKey === "ios-device") {
        const udid = device.udid;
        return typeof udid === "string" && udid ? udid : null;
    }
    return null;
}

export function physicalLeaseMatchesOwnerDevice(ownerId: string, device: DeviceRecord, lease: PhysicalLeaseRecord | null): boolean {
    const expectedClaimId = typeof device.leaseClaimId === "string" ? device.leaseClaimId : null;
    const expectedClaimNonce = typeof device.leaseClaimNonce === "string" ? device.leaseClaimNonce : null;
    const exactGeneration = expectedClaimId && expectedClaimNonce
        ? lease?.claimId === expectedClaimId && lease?.claimNonce === expectedClaimNonce
        : !lease?.claimId && !lease?.claimNonce;
    return lease?.ownerId === ownerId
        && (!device.id || !lease.deviceId || lease.deviceId === device.id)
        && exactGeneration;
}

export function transitionOwnerDeviceRecordWithPhysicalLease(
    ownerId: string,
    backend: Backend,
    expected: DeviceRecord,
    replacement: DeviceRecord | null,
): boolean {
    const hardwareId = hardwareIdForPhysicalDevice(backend, expected);
    if (!hardwareId) return transitionOwnerDeviceRecord(ownerId, backend, expected, replacement).matched;

    const leaseFile = physicalLeaseLockFile(backend.stateKey, hardwareId);
    const aggregateFile = physicalLeaseAggregateFile(backend.stateKey);
    return withSharedMutationLock(physicalLeaseMutationLockFile(backend.stateKey, hardwareId), () =>
        withSharedMutationLock(physicalLeaseAggregateMutationLockFile(backend.stateKey), () => {
            const lease = readPhysicalLeaseStateFile(leaseFile, backend.stateKey, hardwareId) as PhysicalLeaseRecord | null;
            const previousLeases = readPhysicalLeaseAggregate(aggregateFile, backend.stateKey);
            const nextLeases = previousLeases.filter((candidate) => candidate.hardwareId !== hardwareId
                || !physicalLeaseMatchesOwnerDevice(ownerId, expected, candidate));
            const aggregateChanged = !isDeepStrictEqual(previousLeases, nextLeases);
            const leaseChanged = physicalLeaseMatchesOwnerDevice(ownerId, expected, lease);
            if (!aggregateChanged && !leaseChanged) {
                return transitionOwnerDeviceRecord(ownerId, backend, expected, replacement).matched;
            }
            if (aggregateChanged) writeJsonFileAtomically(aggregateFile, { leases: nextLeases });

            if (leaseChanged) {
                try {
                    unlinkSync(leaseFile);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
                        if (aggregateChanged) {
                            try {
                                writeJsonFileAtomically(aggregateFile, { leases: previousLeases });
                            } catch (rollbackError) {
                                throw new AggregateError([error, rollbackError], "physical-lease-aggregate-rollback-failed");
                            }
                        }
                        throw error;
                    }
                }
            }

            let transitionError: unknown;
            let matched = false;
            try {
                matched = transitionOwnerDeviceRecord(ownerId, backend, expected, replacement).matched;
            } catch (error) {
                transitionError = error;
            }
            if (matched) return true;

            const rollbackErrors: unknown[] = [];
            if (leaseChanged) {
                try {
                    writeJsonFileAtomically(leaseFile, lease);
                } catch (error) {
                    rollbackErrors.push(error);
                }
            }
            if (aggregateChanged) {
                try {
                    writeJsonFileAtomically(aggregateFile, { leases: previousLeases });
                } catch (error) {
                    rollbackErrors.push(error);
                }
            }
            if (rollbackErrors.length > 0) {
                throw new AggregateError(
                    transitionError === undefined ? rollbackErrors : [transitionError, ...rollbackErrors],
                    "physical-lease-owner-state-rollback-failed",
                );
            }
            if (transitionError !== undefined) throw transitionError;
            return false;
        }));
}

function windowsSandboxLockFile(): string {
    return join(homedir(), ".ccc/devices/host-locks/windows-sandbox.json");
}

function windowsSandboxMutationLockFile(): string {
    return join(homedir(), ".ccc/devices/host-locks/windows-sandbox.mutation.lock");
}

export function releaseWindowsSandboxLockForOwner(ownerId: string, backend: Backend, device: DeviceRecord): void {
    if (backend.stateKey !== "windows") return;
    withSharedMutationLock(windowsSandboxMutationLockFile(), () => {
        const lock = readWindowsSandboxLockStateFile(windowsSandboxLockFile());
        if (!lock) return;
        const sameOwner = lock.ownerId === ownerId;
        const sameDevice = !device.id || !lock.deviceId || lock.deviceId === device.id;
        const sameSandbox = typeof device.sandboxId !== "string" || !lock.sandboxId || lock.sandboxId === device.sandboxId;
        if (sameOwner && sameDevice && sameSandbox) unlinkSync(windowsSandboxLockFile());
    });
}

function simctlTarget(device: DeviceRecord): string | null {
    for (const key of ["udid", "simulatorName", "name", "id"]) {
        const value = device[key];
        if (typeof value === "string" && value) return value;
    }
    return null;
}

function stopMacosArgs(provider: string, instance: string): string[] | null {
    if (provider === "tart") return ["stop", instance];
    if (provider === "vz") return ["stop", instance];
    if (provider === "utmctl") return ["stop", instance];
    return null;
}

function lifecycleActive(device: DeviceRecord): boolean {
    return ["running", "starting", "booted"].includes(device.status || "");
}

function appiumServerPid(device: DeviceRecord): unknown {
    const appium = device.appium as { serverPid?: unknown } | null | undefined;
    return appium?.serverPid;
}

function recordingPid(device: DeviceRecord): unknown {
    const recording = device.recording as { pid?: unknown } | null | undefined;
    return recording?.pid;
}

function hasVolatileProcessMetadata(device: DeviceRecord): boolean {
    return Boolean(device.pid || appiumServerPid(device) || recordingPid(device) || device.recording || device.appium);
}

function brokerOwnedAppiumCleanupBlock(device: DeviceRecord): string | null {
    const appium = device.appium;
    if (!appium || typeof appium !== "object" || Array.isArray(appium)) return null;
    const metadata = appium as Record<string, unknown>;
    if (metadata.authority !== "host-broker"
        || metadata.processOwner !== "host-broker"
        || metadata.startedBy !== "broker.appium.start"
        || typeof metadata.runtimeId !== "string") return null;
    const observation = inspectDeviceRuntimeProcessIdentity(metadata.processIdentity, metadata.serverPid);
    if (observation.status === "exited" || observation.status === "mismatch") return null;
    return observation.status === "match" ? "appium-runtime-active" : "appium-runtime-identity-unavailable";
}

type OwnedCleanupRuntime = {
    label: "appium" | "recording" | "runtime";
    runtime: Record<string, unknown>;
    signal: NodeJS.Signals;
    signalDirectly: boolean;
};

function ownedCleanupRuntimes(device: DeviceRecord): OwnedCleanupRuntime[] {
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

function runtimeCleanupBlock(device: DeviceRecord): string | null {
    const recording = device.recording;
    if (!recording || typeof recording !== "object" || Array.isArray(recording)) return null;
    const metadata = recording as Record<string, unknown>;
    if (metadata.processOwner !== "host-broker" || metadata.startedBy !== "broker.device.recording.start") return null;
    const observation = inspectDeviceRuntimeProcessIdentity(metadata.processIdentity, metadata.pid);
    if (observation.status === "exited" || observation.status === "mismatch") return null;
    return observation.status === "match" ? "recording-runtime-active" : "recording-runtime-identity-unavailable";
}

function runtimeExited(runtime: OwnedCleanupRuntime): boolean {
    const observation = inspectDeviceRuntimeProcessIdentity(runtime.runtime.processIdentity, runtime.runtime.pid);
    return observation.status === "exited" || observation.status === "mismatch";
}

function waitForRuntimeExit(runtime: OwnedCleanupRuntime, timeoutMs: number): boolean {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    do {
        if (runtimeExited(runtime)) return true;
        if (Date.now() >= deadline) return false;
        Atomics.wait(cleanupWaiter, 0, 0, Math.min(25, deadline - Date.now()));
    } while (true);
}

function stopOwnedDevice(match: OwnerDeviceMatch, timeoutMs = 5000): { commands: CommandResult[]; reason?: string } {
    const results: CommandResult[] = [];
    const runtimes = ownedCleanupRuntimes(match.device);
    for (const runtime of runtimes) {
        if (!runtime.signalDirectly || runtimeExited(runtime)) continue;
        const signal = signalDeviceRuntimeProcess(runtime.runtime, runtime.signal);
        if (!signal.ok) return { commands: results, reason: `${runtime.label}-process-signal-failed` };
    }

    if (match.backend.stateKey === "android") {
        const adb = commandPath("adb");
        const serial = serialForAndroid(match.device);
        if (adb && serial && match.device.recording) {
            const result = runCommand(adb, ["-s", serial, "shell", "pkill", "-2", "screenrecord"], timeoutMs);
            if (result) results.push(result);
        }
        if (adb && serial && lifecycleActive(match.device)) {
            const result = runCommand(adb, ["-s", serial, "emu", "kill"], timeoutMs);
            if (result) results.push(result);
        }
    } else if (match.backend.stateKey === "android-device") {
        const adb = commandPath("adb");
        const serial = serialForAndroid(match.device);
        if (adb && serial && match.device.recording) {
            const result = runCommand(adb, ["-s", serial, "shell", "pkill", "-2", "screenrecord"], timeoutMs);
            if (result) results.push(result);
        }
    } else if (match.backend.stateKey === "ios") {
        const xcrun = commandPath("xcrun");
        const target = simctlTarget(match.device);
        if (xcrun && target && lifecycleActive(match.device)) {
            const result = runCommand(xcrun, ["simctl", "shutdown", target], timeoutMs);
            if (result) results.push(result);
        }
    } else if (match.backend.stateKey === "ios-device") {
        // Physical iOS devices are never powered off or disconnected by cleanup.
    } else if (match.backend.stateKey === "windows") {
        if (lifecycleActive(match.device)) {
            const sandboxId = isGuid(match.device.sandboxId) ? match.device.sandboxId : null;
            const result = sandboxId ? runCommand(commandPath("wsb"), ["stop", "--id", sandboxId], timeoutMs) : null;
            if (result) results.push(result);
        }
    } else if (match.backend.stateKey === "macos") {
        const provider = typeof match.device.provider === "string" ? match.device.provider : null;
        const instance = typeof match.device.providerInstance === "string" ? match.device.providerInstance : null;
        if (provider && instance && lifecycleActive(match.device)) {
            const args = stopMacosArgs(provider, instance);
            if (args) {
                const result = runCommand(commandPath(provider), args, timeoutMs);
                if (result) results.push(result);
            }
        }
    }
    for (const runtime of runtimes) {
        if (!waitForRuntimeExit(runtime, timeoutMs)) {
            return { commands: results, reason: `${runtime.label}-process-still-active` };
        }
    }
    return { commands: results };
}

function lifecycleStopRequired(backend: Backend, device: DeviceRecord): boolean {
    if (!lifecycleActive(device)) return false;
    if (backend.stateKey === "android-device" || backend.stateKey === "ios-device") return false;
    return true;
}

function lifecycleStopFailed(backend: Backend, device: DeviceRecord, commands: CommandResult[]): boolean {
    if (!lifecycleStopRequired(backend, device)) return false;
    return commands.length === 0 || commands.some((command) => command.status !== 0);
}

function stoppedDevice(device: DeviceRecord): DeviceRecord {
    return {
        ...device,
        status: "stopped",
        pid: null,
        appium: null,
        recording: null,
        updatedAt: now(),
    };
}

function cleanedDevice(backend: Backend, device: DeviceRecord): DeviceRecord {
    if (backend.stateKey === "android-device" || backend.stateKey === "ios-device") {
        return {
            ...device,
            status: "detached",
            pid: null,
            appium: null,
            recording: null,
            updatedAt: now(),
        };
    }
    return stoppedDevice(device);
}

function commitCleanedDevice(
    ownerId: string,
    backend: Backend,
    current: DeviceRecord,
    releaseWindowsClaim: boolean,
): boolean {
    if (!hardwareIdForPhysicalDevice(backend, current)) {
        const matched = transitionOwnerDeviceRecord(ownerId, backend, current, cleanedDevice(backend, current)).matched;
        if (matched && releaseWindowsClaim) releaseWindowsSandboxLockForOwner(ownerId, backend, current);
        return matched;
    }
    return transitionOwnerDeviceRecordWithPhysicalLease(ownerId, backend, current, cleanedDevice(backend, current));
}

export function shouldCleanupDevice(backend: Backend, device: DeviceRecord): boolean {
    if ((backend.stateKey === "android-device" || backend.stateKey === "ios-device") && device.status === "attached") return true;
    return lifecycleActive(device) || hasVolatileProcessMetadata(device);
}

export function stopOwnerDeviceRecord(
    ownerId: string,
    backend: Backend,
    expected: DeviceRecord,
    timeoutMs?: number,
    releaseWindowsClaim = false,
): CleanupDeviceResult {
    const id = expected.id || "(unknown)";
    if (!expected.id) {
        return { id, backend: backend.name, previousStatus: expected.status || "unknown", status: "failed", commands: [], reason: "owner-device-id-missing" };
    }
    return withAdminOwnerDeviceOperation(ownerId, backend.stateKey, expected.id, () => {
        const current = readDevices(ownerId, backend.stateKey).find((candidate) => candidate.id === expected.id);
        if (!current || !isDeepStrictEqual(current, expected)) {
            return { id, backend: backend.name, previousStatus: expected.status || "unknown", status: "failed", commands: [], reason: "owner-device-state-conflict" };
        }
        const appiumBlock = brokerOwnedAppiumCleanupBlock(current);
        if (appiumBlock) {
            return { id, backend: backend.name, previousStatus: current.status || "unknown", status: "failed", commands: [], reason: appiumBlock };
        }
        const ownedRuntimeBlock = runtimeCleanupBlock(current);
        if (ownedRuntimeBlock) {
            return { id, backend: backend.name, previousStatus: current.status || "unknown", status: "failed", commands: [], reason: ownedRuntimeBlock };
        }
        const stopped = stopOwnedDevice({ backend, devices: [current], index: 0, device: current }, timeoutMs);
        const commands = stopped.commands;
        if (stopped.reason) {
            return { id, backend: backend.name, previousStatus: current.status || "unknown", status: "failed", commands, reason: stopped.reason };
        }
        if (lifecycleStopFailed(backend, current, commands)) {
            return { id, backend: backend.name, previousStatus: current.status || "unknown", status: "failed", commands, reason: "provider-stop-failed" };
        }
        if (!commitCleanedDevice(ownerId, backend, current, releaseWindowsClaim)) {
            return { id, backend: backend.name, previousStatus: current.status || "unknown", status: "failed", commands, reason: "owner-device-state-conflict" };
        }
        return { id, backend: backend.name, previousStatus: current.status || "unknown", status: "stopped", commands };
    });
}

export function cleanupOwnerDevices(cwd = process.cwd(), timeoutMs = 5000, profile?: string): { ownerId: string; results: CleanupDeviceResult[] } {
    const ownerId = deviceLabOwnerId(cwd, profile);
    const results: CleanupDeviceResult[] = [];
    for (const backend of DEVICE_BACKENDS) {
        const devices = readDevices(ownerId, backend.stateKey);
        devices.forEach((device) => {
            if (!device.id || !shouldCleanupDevice(backend, device)) {
                results.push({
                    id: device.id || "(unknown)",
                    backend: backend.name,
                    previousStatus: device.status || "unknown",
                    status: "skipped",
                    commands: [],
                });
                return;
            }

            results.push(stopOwnerDeviceRecord(ownerId, backend, device, timeoutMs, true));
        });
    }
    return { ownerId, results };
}
