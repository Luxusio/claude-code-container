import { createDeviceAdminCleanup } from "./application/device-admin-cleanup.js";
import type { DeviceAdminCleanupPorts } from "./ports/device-admin-cleanup.js";
import { serialForAndroid } from "./domain/device-admin-cleanup.js";
import type { OwnedCleanupRuntime, CleanupDeviceResult } from "./domain/device-admin-cleanup.js";
export { shouldCleanupDevice } from "./domain/device-admin-cleanup.js";
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


export function deviceAdminCleanupNativePorts(): DeviceAdminCleanupPorts<Backend> {
 return {
  get backends() { return DEVICE_BACKENDS; },
  resolveOwnerId: (cwd, profile) => deviceLabOwnerId(cwd, profile),
  readDevices: (ownerId, stateKey) => readDevices(ownerId, stateKey),
  sameRecord: (current, expected) => isDeepStrictEqual(current, expected),
  withRecordLock: (ownerId, stateKey, deviceId, decide) => withAdminOwnerDeviceOperation(ownerId, stateKey, deviceId, decide),
  appiumCleanupBlock: device => brokerOwnedAppiumCleanupBlock(device),
  runtimeCleanupBlock: device => runtimeCleanupBlock(device),
  runtimeExited: runtime => runtimeExited(runtime),
  signalRuntime: (runtime, signal) => signalDeviceRuntimeProcess(runtime, signal),
  waitForRuntimeExit: (runtime, timeoutMs) => waitForRuntimeExit(runtime, timeoutMs),
  commandPath: command => commandPath(command),
  runCommand: (command, args, timeoutMs) => runCommand(command, args, timeoutMs),
  timestamp: () => now(),
  hardwareId: (backend, device) => hardwareIdForPhysicalDevice(backend, device),
  transitionRecord: (ownerId, backend, expected, replacement) => transitionOwnerDeviceRecord(ownerId, backend, expected, replacement),
  transitionPhysicalRecord: (ownerId, backend, expected, replacement) => transitionOwnerDeviceRecordWithPhysicalLease(ownerId, backend, expected, replacement),
  releaseWindowsClaim: (ownerId, backend, device) => { releaseWindowsSandboxLockForOwner(ownerId, backend, device); return undefined; },
 };
}
export function stopOwnerDeviceRecord(ownerId: string, backend: Backend, expected: DeviceRecord, timeoutMs?: number, releaseWindowsClaim = false): CleanupDeviceResult {
 return createDeviceAdminCleanup(deviceAdminCleanupNativePorts()).stopRecord(ownerId, backend, expected, timeoutMs, releaseWindowsClaim);
}
export function cleanupOwnerDevices(cwd = process.cwd(), timeoutMs = 5000, profile?: string): { ownerId: string; results: CleanupDeviceResult[] } {
 return createDeviceAdminCleanup(deviceAdminCleanupNativePorts()).owner(cwd, timeoutMs, profile);
}
