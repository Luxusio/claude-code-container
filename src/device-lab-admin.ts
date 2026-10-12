import { createDeviceAdminDelete } from "./application/device-admin-delete.js";
import type { DeviceAdminDeletePorts } from "./ports/device-admin-delete.js";
import { createDeviceAdminDiagnostics } from "./application/device-admin-diagnostics.js";
import { createDeviceAdminSetup } from "./application/device-admin-setup.js";
import type { DiagnosticProbe, DiagnosticRow, HyperVReadiness } from "./domain/device-admin-diagnostics.js";
import type { DeviceAdminDiagnosticsPorts } from "./ports/device-admin-diagnostics.js";
import type { SetupObservation, SetupResult } from "./domain/device-admin-setup.js";
import type { DeviceAdminSetupPorts } from "./ports/device-admin-setup.js";
export type SmokeResult = { backend: string; status: "PASS" | "SKIP" | "FAIL"; detail: string; commands?: CommandResult[] };
export type SmokeMode = "prerequisite" | "real-provider";
export type SmokeOptions = { mode?: SmokeMode };
export type SmokeFormatOptions = SmokeOptions & { mcpSurface?: boolean; mcpServerPath?: string; mcpSmokeScriptPath?: string };
export type ParsedSmokeArgs = { ok: true; mode: SmokeMode; timeoutMs: number } | { ok: false; message: string };
export type BenchDeviceStatus = "healthy" | "lease-ok" | "missing-hardware-id" | "missing-lease" | "expired-lease" | "foreign-lease" | "device-mismatch" | "inventory-missing";
export type BenchDeviceCheck = {
    deviceId: string;
    name: string;
    status: BenchDeviceStatus;
    detail: string;
    hardwareId: string | null;
    inventoryState: "present" | "missing" | "unknown";
    expiresAt?: string;
};
export type BenchBackendHealth = {
    backend: "android-device" | "ios-device";
    status: "PASS" | "SKIP" | "FAIL";
    detail: string;
    command: { command: string; status: number | null } | null;
    devices: BenchDeviceCheck[];
};
export type DeviceLabBenchHealth = { ownerId: string; backends: BenchBackendHealth[] };
export type DeviceLabWiringDiagnostic = {
    stateRoot: string;
    stateExists: boolean;
    context: "container" | "host";
    environmentRequired: boolean;
    ownerResolution: "host-broker-resolve";
    incomplete: boolean;
};

export type HyperVSetupHostResult = { ok: boolean; text: string };
import { createDeviceAdminAllProjectCleanup } from "./application/device-admin-cleanup.js";
import type { CleanupAllProjectsResult } from "./domain/device-admin-cleanup.js";
import { createDeviceAdminPrune } from "./application/device-admin-prune.js";
import { admitDeviceAdminInventoryCommand } from "./domain/device-admin-inventory.js";
import { createDeviceAdminInventory } from "./application/device-admin-inventory.js";
import type { DeviceAdminOwnerSnapshot } from "./ports/device-admin-inventory.js";
import {
    DEVICE_BACKENDS,
    deviceAdminCleanupNativePorts,
    deviceAdminPhysicalTransitionNativePorts,
    commandPath,
    deviceLabOwnerId,
    hardwareIdForPhysicalDevice,
    physicalLeaseLockFile,
    readDevices,
    releaseWindowsSandboxLockForOwner,
    runCommand,
    stopOwnerDeviceRecord,
    transitionOwnerDeviceRecordWithPhysicalLease,
    withAdminOwnerDeviceOperation,
} from "./device-lab-cleanup.js";
import type { Backend, CommandResult, OwnerDeviceMatch, PhysicalLeaseRecord } from "./device-lab-cleanup.js";
export { DEVICE_BACKENDS, deviceLabOwnerIdentity, deviceLabOwnerId, cleanupOwnerDevices } from "./device-lab-cleanup.js";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "fs";

import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { isDeepStrictEqual } from "util";
import {
    deviceBrokerCli,
    deviceBrokerCliAsync,
    DEVICE_BROKER_HYPER_V_MAX_BOOT_TIMEOUT_MS,
    DEVICE_BROKER_HYPER_V_CLEANUP_RESERVE_MS,
    ensureHyperVHostNetworkForSetup,
    invokeHostDeviceBrokerOwnerRpc,
    type HostDeviceBrokerOwnerRpcResult,
} from "@ccc/device-lab/device-lab-broker.js";

import { readPhysicalLeaseStateFile } from "@ccc/device-lab/device-lab-ownership-state.js";
import { DeviceLabProjectEnumerationError, enumerateDeviceProjectIds } from "@ccc/device-lab/device-lab-project-state.js";
export { DeviceLabProjectEnumerationError } from "@ccc/device-lab/device-lab-project-state.js";
import {
    withSharedMutationLockAsync,
} from "@ccc/device-lab/device-lab-shared-state.js";

import {
    acceptHyperVWindowsEvaluationLicense,
    HYPER_V_WINDOWS_EVALUATION_LICENSE_URL,
    readHyperVWindowsEvaluationReceipt,
} from "@ccc/device-lab/device-lab/hyper-v-images.js";
import { inspectHyperVUbuntuImageCache } from "@ccc/device-lab/device-lab/broker/hyper-v/image-store.js";
import { hyperVLinuxImageBlockers, hyperVLinuxSmokeImageResult } from "@ccc/device-lab/device-lab/hyper-v-linux-image-readiness.js";

import {
    hyperVReadinessCommand,
    hyperVSetupCommand,
    parseHyperVReadiness,
    parseHyperVSetupObservation,
} from "@ccc/device-lab/host-control/hyper-v/index.js";
type DeviceLifecycleAction = "create" | "start" | "stop" | "reboot" | "delete" | "status";
type DeviceSnapshotAction = "list" | "create" | "restore" | "delete";
type ParsedLifecycleArgs = {
    ok: true;
    action: DeviceLifecycleAction;
    backend: string;
    deviceId: string;
    params: Record<string, unknown>;
} | { ok: false; message: string };
type ParsedSnapshotArgs = {
    ok: true;
    action: DeviceSnapshotAction;
    backend: "windows-vm" | "linux-vm";
    deviceId: string;
    params: Record<string, unknown>;
} | { ok: false; message: string };
type DevicesCliAsyncHooks = Parameters<typeof deviceBrokerCliAsync>[3] & {
    invokeOwnerRpc?: typeof invokeHostDeviceBrokerOwnerRpc;
    setupHyperV?: typeof setupHyperVHost;
};
type HyperVSetupHostOptions = {
    platform?: NodeJS.Platform;
    powershell?: string | null;
    systemRoot?: string;
    stateRoot?: string;
    networkStateRoot?: string;
    mutationLockFile?: string;
    commandRunner?: (command: string, args: string[], timeoutMs: number, input?: string) => CommandResult | null;
    acceptWindowsEvaluationLicense?: boolean;
    ensureHostNetwork?: typeof ensureHyperVHostNetworkForSetup;
    ownerId?: string;
};

const WINDOWS_SYSTEM_POWERSHELL_PATH = "\\\\?\\GLOBALROOT\\SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

export function spawnableWindowsExecutablePath(path: string): string | null {
    if (/^\\\\\?\\[A-Za-z]:\\/.test(path)) return path.slice(4);
    if (/^[A-Za-z]:\\/.test(path)) return path;
    return null;
}

function canonicalWindowsPowerShellPath(testSystemRoot?: string): string | null {
    const candidate = testSystemRoot
        ? join(resolve(testSystemRoot), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
        : WINDOWS_SYSTEM_POWERSHELL_PATH;
    try {
        assertPlainDirectoryPath(dirname(candidate), "hyper-v-system-powershell");
        const metadata = lstatSync(candidate);
        if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
        const resolved = realpathSync.native(candidate);
        const executable = testSystemRoot ? resolved : spawnableWindowsExecutablePath(resolved);
        if (!executable) return null;
        assertPlainDirectoryPath(dirname(executable), "hyper-v-system-powershell");
        const resolvedMetadata = lstatSync(executable);
        return resolvedMetadata.isFile() && !resolvedMetadata.isSymbolicLink() ? executable : null;
    } catch {
        return null;
    }
}

function assertPlainDirectoryPath(path: string, label: string): void {
    const chain: string[] = [];
    let current = resolve(path);
    while (true) {
        chain.push(current);
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
    }
    for (const candidate of chain.reverse()) {
        if (!existsSync(candidate)) continue;
        const metadata = lstatSync(candidate);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label}-path-invalid`);
    }
}

function ownersRoot(): string {
    return join(homedir(), ".ccc/devices/owners");
}

function readPhysicalLeaseLock(stateKey: string, hardwareId: string): PhysicalLeaseRecord | null {
    return readPhysicalLeaseStateFile(physicalLeaseLockFile(stateKey, hardwareId), stateKey, hardwareId) as PhysicalLeaseRecord | null;
}

function allOwnerIds(): string[] {
    return enumerateDeviceProjectIds(ownersRoot());
}

function packageRoot(): string {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    return dirname(moduleDir);
}

function findOwnerDevice(ownerId: string, deviceId: string): OwnerDeviceMatch | null {
    return findOwnerDevices(ownerId, deviceId)[0] || null;
}

function findOwnerDevices(ownerId: string, deviceId: string): OwnerDeviceMatch[] {
    const matches: OwnerDeviceMatch[] = [];
    for (const backend of DEVICE_BACKENDS) {
        const devices = readDevices(ownerId, backend.stateKey);
        for (let index = 0; index < devices.length; index += 1) {
            if (devices[index].id === deviceId) matches.push({ backend, devices, index, device: devices[index] });
        }
    }
    return matches;
}

const CREATABLE_DEVICE_BACKENDS = new Set(["android-emulator", "ios-simulator", "windows-sandbox", "windows-vm", "macos-vm", "linux-vm"]);
const LIFECYCLE_STRING_OPTIONS = new Map([
    ["--name", "name"],
    ["--avd-name", "avdName"],
    ["--system-image", "systemImage"],
    ["--device-profile", "deviceProfile"],
    ["--simulator-name", "simulatorName"],
    ["--device-type", "deviceType"],
    ["--runtime", "runtime"],
    ["--udid", "udid"],
    ["--provider", "provider"],
    ["--image", "image"],
    ["--source-image", "sourceImage"],
    ["--vm-profile", "profile"],
    ["--switch-name", "switchName"],
    ["--secure-boot-template", "secureBootTemplate"],
    ["--ssh-host", "sshHost"],
    ["--ssh-user", "sshUser"],
    ["--ssh-key-path", "sshKeyPath"],
]);
const LIFECYCLE_NUMBER_OPTIONS = new Map([
    ["--port", "port"],
    ["--memory-mb", "memoryMb"],
    ["--cpus", "cpus"],
    ["--ssh-port", "sshPort"],
    ["--boot-timeout-ms", "bootTimeoutMs"],
]);
const LIFECYCLE_BOOLEAN_OPTIONS = new Map([
    ["create-avd", "createAvd"],
    ["headless", "headless"],
    ["minimized", "minimized"],
    ["create-simulator", "createSimulator"],
    ["networking", "networking"],
    ["clipboard", "clipboard"],
    ["vgpu", "vgpu"],
    ["wait-for-boot", "waitForBoot"],
    ["force", "force"],
    ["start-if-stopped", "startIfStopped"],
]);
const CREATE_OPTIONS_BY_BACKEND = new Map<string, ReadonlySet<string>>([
    ["android-emulator", new Set(["name", "avdName", "port", "systemImage", "deviceProfile", "createAvd", "headless"])],
    ["ios-simulator", new Set(["name", "simulatorName", "deviceType", "runtime", "udid", "createSimulator"])],
    ["windows-sandbox", new Set(["name", "networking", "clipboard", "vgpu", "memoryMb", "minimized"])],
    ["windows-vm", new Set(["name", "provider", "image", "sourceImage", "profile", "memoryMb", "cpus", "switchName", "secureBootTemplate"])],
    ["linux-vm", new Set(["name", "provider", "image", "sourceImage", "profile", "memoryMb", "cpus", "switchName", "secureBootTemplate", "networking"])],
    ["macos-vm", new Set(["name", "provider", "image", "cpus", "sshHost", "sshPort", "sshUser", "sshKeyPath"])],
]);
const START_OPTIONS_BY_BACKEND = new Map<string, ReadonlySet<string>>([
    ["android-emulator", new Set(["headless", "waitForBoot", "bootTimeoutMs"])],
    ["ios-simulator", new Set()],
    ["windows-sandbox", new Set(["minimized"])],
    ["windows-vm", new Set(["waitForBoot", "bootTimeoutMs"])],
    ["linux-vm", new Set(["waitForBoot", "bootTimeoutMs"])],
    ["macos-vm", new Set(["waitForBoot", "bootTimeoutMs"])],
]);
const REBOOT_OPTIONS = new Set(["force", "startIfStopped", "waitForBoot", "bootTimeoutMs"]);

function lifecycleUsage(action?: DeviceLifecycleAction): string {
    if (action === "create") return "Usage: ccc devices create <backend> <device-id> [--name <name>] [provider options]";
    if (action === "start") return "Usage: ccc devices start <device-id> [--minimized|--no-minimized] [provider options]";
    if (action === "stop") return "Usage: ccc devices stop <device-id>";
    if (action === "reboot") return "Usage: ccc devices reboot <device-id> [--force] [--start-if-stopped] [--wait-for-boot|--no-wait-for-boot] [--boot-timeout-ms <ms>]";
    if (action === "delete") return "Usage: ccc devices delete <device-id>";
    if (action === "status") return "Usage: ccc devices status <device-id>";
    return "Usage: ccc devices <create|start|stop|reboot|delete|status> ...";
}

function parseLifecycleOptions(args: string[]): { ok: true; params: Record<string, unknown> } | { ok: false; message: string } {
    const params: Record<string, unknown> = {};
    for (let index = 0; index < args.length; index += 1) {
        const option = args[index];
        const stringKey = LIFECYCLE_STRING_OPTIONS.get(option);
        const numberKey = LIFECYCLE_NUMBER_OPTIONS.get(option);
        if (stringKey || numberKey) {
            const value = args[index + 1];
            if (!value || value.startsWith("--")) return { ok: false, message: `Missing value for ${option}` };
            if (stringKey) params[stringKey] = value;
            if (numberKey) {
                const parsed = Number(value);
                if (!Number.isInteger(parsed) || parsed <= 0 || (numberKey === "port" || numberKey === "sshPort") && parsed > 65535) {
                    return { ok: false, message: `Invalid positive integer for ${option}: ${value}` };
                }
                params[numberKey] = parsed;
            }
            index += 1;
            continue;
        }
        const booleanMatch = /^--(no-)?(.+)$/.exec(option);
        const booleanKey = booleanMatch ? LIFECYCLE_BOOLEAN_OPTIONS.get(booleanMatch[2]) : undefined;
        if (booleanMatch && booleanKey) {
            params[booleanKey] = !booleanMatch[1];
            continue;
        }
        return { ok: false, message: `Unknown device option: ${option}` };
    }
    return { ok: true, params };
}

function validateLifecycleOptions(action: "create" | "start", backend: string, params: Record<string, unknown>): { ok: true } | { ok: false; message: string } {
    const allowed = (action === "create" ? CREATE_OPTIONS_BY_BACKEND : START_OPTIONS_BY_BACKEND).get(backend) || new Set<string>();
    const unsupported = Object.keys(params).filter((key) => !allowed.has(key));
    return unsupported.length === 0
        ? { ok: true }
        : { ok: false, message: `Unsupported ${backend} ${action} option: ${unsupported[0]}` };
}

function parseDeviceLifecycleArgs(args: string[], cwd: string, profile?: string): ParsedLifecycleArgs {
    const action = args[0] === "device-status" ? "status" : args[0] as DeviceLifecycleAction;
    if (action === "create") {
        const backend = args[1] || "";
        const deviceId = args[2] || "";
        if (!CREATABLE_DEVICE_BACKENDS.has(backend) || !deviceId) return { ok: false, message: lifecycleUsage(action) };
        if (deviceId.length > 128 || /[^a-zA-Z0-9._:-]/.test(deviceId)) return { ok: false, message: `Invalid device id: ${deviceId}` };
        const options = parseLifecycleOptions(args.slice(3));
        if (!options.ok) return options;
        const validated = validateLifecycleOptions(action, backend, options.params);
        if (!validated.ok) return validated;
        const existing = findOwnerDevices(deviceLabOwnerId(cwd, profile), deviceId);
        if (existing.length > 1 || existing.some((match) => match.backend.name !== backend)) {
            return { ok: false, message: `Device id already exists for current owner: ${deviceId}` };
        }
        return {
            ok: true,
            action,
            backend,
            deviceId,
            params: {
                ...options.params,
                name: typeof options.params.name === "string" ? options.params.name : deviceId,
                ...(backend === "windows-sandbox" && typeof options.params.minimized !== "boolean" ? { minimized: true } : {}),
            },
        };
    }
    if (action === "start" || action === "stop" || action === "reboot" || action === "delete" || action === "status") {
        const deviceId = args[1] || "";
        if (!deviceId) return { ok: false, message: lifecycleUsage(action) };
        const ownerId = deviceLabOwnerId(cwd, profile);
        const matches = findOwnerDevices(ownerId, deviceId);
        if (matches.length > 1) return { ok: false, message: `Device id is ambiguous across backends: ${deviceId}` };
        const match = matches[0];
        if (!match) return { ok: false, message: `Device not found for current owner: ${deviceId}` };
        if ((action === "status" || action === "stop" || action === "delete") && args.length !== 2) {
            return { ok: false, message: lifecycleUsage(action) };
        }
        if (action === "delete" && match.device.status !== "stopped" && match.device.status !== "detached") {
            return { ok: false, message: `Refusing to delete ${deviceId} while status is ${match.device.status || "unknown"}; run 'ccc devices stop ${deviceId}' first.` };
        }
        const options: { ok: true; params: Record<string, unknown> } | { ok: false; message: string } = action !== "start" && action !== "reboot"
            ? { ok: true, params: {} }
            : parseLifecycleOptions(args.slice(2));
        if (!options.ok) return options;
        if (action === "start") {
            const validated = validateLifecycleOptions(action, match.backend.name, options.params);
            if (!validated.ok) return validated;
        }
        if (action === "reboot") {
            if (match.backend.name !== "windows-vm" && match.backend.name !== "linux-vm") {
                return { ok: false, message: `Device reboot is supported only for windows-vm and linux-vm: ${deviceId}` };
            }
            const unsupported = Object.keys(options.params).filter((key) => !REBOOT_OPTIONS.has(key));
            if (unsupported.length > 0) return { ok: false, message: `Unsupported ${match.backend.name} reboot option: ${unsupported[0]}` };
        }
        return {
            ok: true,
            action,
            backend: match.backend.name,
            deviceId,
            params: {
                ...options.params,
                ...((match.backend.name === "windows-vm" || match.backend.name === "linux-vm")
                    && action !== "status"
                    && typeof match.device.incarnationId === "string"
                    ? { incarnationId: match.device.incarnationId }
                    : {}),
                ...(action === "start" && match.backend.name === "windows-sandbox" && typeof options.params.minimized !== "boolean"
                    ? { minimized: true }
                    : {}),
            },
        };
    }
    return { ok: false, message: lifecycleUsage() };
}

function snapshotUsage(action?: DeviceSnapshotAction): string {
    if (action === "list") return "Usage: ccc devices snapshot list <device-id>";
    if (action === "create") return "Usage: ccc devices snapshot create <device-id> <snapshot-name>";
    if (action === "restore") return "Usage: ccc devices snapshot restore <device-id> <snapshot-name-or-id> --confirm-destructive [--force]";
    if (action === "delete") return "Usage: ccc devices snapshot delete <device-id> <snapshot-name-or-id> --confirm-destructive";
    return "Usage: ccc devices snapshot <list|create|restore|delete> ...";
}

function parseDeviceSnapshotArgs(args: string[], cwd: string, profile?: string): ParsedSnapshotArgs {
    const action = args[1] as DeviceSnapshotAction;
    if (action !== "list" && action !== "create" && action !== "restore" && action !== "delete") {
        return { ok: false, message: snapshotUsage() };
    }
    const deviceId = args[2] || "";
    const target = args[3] || "";
    if (!deviceId || (action !== "list" && !target) || (action === "list" && args.length !== 3)) {
        return { ok: false, message: snapshotUsage(action) };
    }

    const flags = new Set(action === "list" ? [] : args.slice(4));
    const allowedFlags = action === "restore"
        ? new Set(["--confirm-destructive", "--force"])
        : action === "delete"
            ? new Set(["--confirm-destructive"])
            : new Set<string>();
    const unknownFlag = [...flags].find((flag) => !allowedFlags.has(flag));
    if (unknownFlag || (action !== "list" && flags.size !== args.length - 4)) {
        return { ok: false, message: unknownFlag ? `Unknown snapshot option: ${unknownFlag}` : snapshotUsage(action) };
    }
    if ((action === "restore" || action === "delete") && !flags.has("--confirm-destructive")) {
        return { ok: false, message: `Refusing to ${action} snapshot without --confirm-destructive` };
    }

    const matches = findOwnerDevices(deviceLabOwnerId(cwd, profile), deviceId);
    if (matches.length > 1) return { ok: false, message: `Device id is ambiguous across backends: ${deviceId}` };
    const match = matches[0];
    if (!match) return { ok: false, message: `Device not found for current owner: ${deviceId}` };
    if (match.backend.name !== "windows-vm" && match.backend.name !== "linux-vm") {
        return { ok: false, message: `Device snapshots are not supported by backend: ${match.backend.name}` };
    }

    if (action === "list") {
        return {
            ok: true,
            action,
            backend: match.backend.name,
            deviceId,
            params: {},
        };
    }

    const snapshotId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(target);
    if (!snapshotId && !/^(?!\.\.?$)[A-Za-z0-9._-]{1,64}$/.test(target)) {
        return { ok: false, message: `Invalid snapshot name or id: ${target}` };
    }
    if (action === "create" && snapshotId) {
        return { ok: false, message: `Snapshot create requires a name, not an id: ${target}` };
    }
    return {
        ok: true,
        action,
        backend: match.backend.name,
        deviceId,
        params: {
            ...(snapshotId ? { snapshotId: target.toLowerCase() } : { snapshotName: target }),
            ...(typeof match.device.incarnationId === "string" ? { incarnationId: match.device.incarnationId } : {}),
            ...(flags.has("--force") ? { force: true } : {}),
            ...(flags.has("--confirm-destructive") ? { confirmDestructive: true } : {}),
        },
    };
}

function brokerRpcDevice(result: HostDeviceBrokerOwnerRpcResult): Record<string, unknown> | null {
    const payload = result.body?.result;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const device = (payload as Record<string, unknown>).device;
    return device && typeof device === "object" && !Array.isArray(device) ? device as Record<string, unknown> : null;
}

// The TWO readiness reasons that are terminal for a device. Both require the PowerShell Direct
// probe to have landed and reported either a missing completion marker or live secrets, which puts
// OOBE past first logon — and FirstLogonCommands fires once per OOBE with no re-provision path, so
// restarting cannot help. That was documented in doc/common/PLAN__hyper-v-vm-provider.md and said
// nowhere the operator would actually be looking.
//
// hyper-v-guest-scrub-containment-failed is deliberately NOT here, though it was, and an earlier
// version of this comment miscounted it as a third. It has one producer — the broker synthesizing
// it when readiness never ran at all — so it means the exact opposite: nothing established that
// OOBE is past first logon, and the unconfirmed stop means the guest is still running and may yet
// finish. Including it re-admitted the destructive advice through the reason branch immediately
// after it had been removed from the flag branch.
const SCRUB_FAILURE_REASONS = new Set([
    "hyper-v-guest-first-logon-incomplete",
    "hyper-v-guest-provisioning-not-scrubbed",
]);
const SCRUB_FAILURE_REMEDY = "the first-logon scrub cannot be retried on this guest — delete and recreate the device";
// For a containment that was not confirmed. The scrub state is unknown rather than known-finished:
// the guest is still running and a slow first boot may yet complete, so this says what to try
// before anything destructive.
const UNCONFIRMED_CONTAINMENT_NEXT_STEP = "stop the device, and if it recurs raise --boot-timeout-ms or delete and recreate";
// The broker bounds these codes to [a-z0-9-] before they leave it, but that invariant lives two
// modules away and lastBootCheck rides a denylist redaction on non-hyper-v backends. Re-checking
// at the render site costs one regex and makes the terminal output self-defending rather than
// trusting something maintained elsewhere.
const BOUNDED_BOOT_CODE = /^[a-z0-9-]{1,128}$/;

// Shared by the success and failure renderers. The failure path is where an operator actually
// lands on a refused start, and it read only error/detail/missing — so the warning and the remedy
// were dead exactly there. Worse, a refused start whose containment FAILED printed byte-identically
// to one where the guest was cleanly powered off, because the reason is the same string in both.
function bootCheckLines(device: Record<string, unknown> | null): string[] {
    const bootCheck = device?.lastBootCheck;
    if (!bootCheck || typeof bootCheck !== "object" || Array.isArray(bootCheck)) return [];
    const record = bootCheck as Record<string, unknown>;
    const reason = typeof record.error === "string" && BOUNDED_BOOT_CODE.test(record.error) ? record.error : null;
    const lines: string[] = [];
    if (reason) lines.push(`bootError: ${reason}`);
    if (record.scrubContainmentFailed === true) {
        lines.push("scrubContainmentFailed: true");
        lines.push("WARNING: this guest may still be running with provisioning secrets intact.");
    }
    // The destructive remedy is gated on the reason, and only on the two where the probe LANDED
    // and reported a missing marker or live secrets — OOBE is then past first logon, so the scrub
    // cannot fire again. `scrubContainmentFailed` does not carry that property, and briefly gating
    // on it too was wrong in the dangerous direction: that flag means the stop was not confirmed,
    // i.e. the guest is still RUNNING and may yet finish a slow OOBE, which a longer
    // --boot-timeout-ms would have allowed. Telling someone to destroy that device is worse than
    // saying nothing. The inverse case — a slow boot the stop did kill mid-OOBE — is genuinely
    // terminal, but the CLI cannot distinguish it here and the flag is absent there anyway.
    if (reason && SCRUB_FAILURE_REASONS.has(reason)) {
        lines.push(`remedy: ${SCRUB_FAILURE_REMEDY}`);
    } else if (record.scrubContainmentFailed === true) {
        // Not nothing, which was the original complaint, and not a destructive instruction either.
        lines.push(`next: ${UNCONFIRMED_CONTAINMENT_NEXT_STEP}`);
    }
    return lines;
}

function formatLifecycleResult(action: DeviceLifecycleAction, backend: string, deviceId: string, result: HostDeviceBrokerOwnerRpcResult): string {
    const device = brokerRpcDevice(result);
    const lines = [
        "=== CCC Device ===",
        "",
        `action: ${action}`,
        `id: ${String(device?.id || deviceId)}`,
        `backend: ${String(device?.backend || backend)}`,
        `status: ${String(device?.status || (action === "delete" ? "deleted" : "unknown"))}`,
    ];
    for (const key of ["name", "minimized", "minimizeConfirmed", "sandboxId", "runtimeState", "bootReady"]) {
        if (device?.[key] !== undefined) lines.push(`${key}: ${String(device[key])}`);
    }
    lines.push(...bootCheckLines(device));
    return `${lines.join("\n")}\n`;
}

function formatLifecycleError(action: DeviceLifecycleAction, result: HostDeviceBrokerOwnerRpcResult): string {
    const body = result.body;
    const error = typeof body?.error === "string" ? body.error : result.error || "broker-operation-failed";
    const detail = typeof body?.detail === "string" ? body.detail : result.detail;
    const missing = Array.isArray(body?.missing) && body.missing.length > 0 ? ` (missing: ${body.missing.join(", ")})` : "";
    // The refusal body carries result.device, so the same lastBootCheck lines the success path
    // prints are available here — and this is the path an operator actually sees. Without them a
    // failed containment was indistinguishable from a clean power-off: identical reason, identical
    // line, while one of the two guests is still up with a live autologon.
    const details = bootCheckLines(brokerRpcDevice(result))
        .map((line) => `\n  ${line}`)
        .join("");
    // Also matched against `detail` itself: on a start refused for one of the terminal reasons the
    // record may not carry it yet, but the reply always does.
    const remedy = typeof detail === "string" && SCRUB_FAILURE_REASONS.has(detail) && !details.includes(SCRUB_FAILURE_REMEDY)
        ? `\n  remedy: ${SCRUB_FAILURE_REMEDY}`
        : "";
    return `CCC device ${action} failed: ${error}${missing}${detail ? ` - ${detail}` : ""}${details}${remedy}`;
}

function formatSnapshotResult(action: DeviceSnapshotAction, backend: "windows-vm" | "linux-vm", deviceId: string, result: HostDeviceBrokerOwnerRpcResult): string {
    const payload = result.body?.result;
    if (action === "list") {
        const resultRecord = payload && typeof payload === "object" && !Array.isArray(payload)
            ? payload as Record<string, unknown>
            : {};
        const snapshots = Array.isArray(resultRecord.snapshots)
            ? resultRecord.snapshots.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
            : [];
        const activeSnapshotId = typeof resultRecord.activeSnapshotId === "string" ? resultRecord.activeSnapshotId : null;
        return `${[
            "=== CCC Device Snapshots ===",
            "",
            `device: ${deviceId}`,
            `backend: ${backend}`,
            `count: ${snapshots.length}`,
            ...snapshots.map((snapshot) => `${snapshot.id === activeSnapshotId ? "*" : "-"} ${String(snapshot.name || "unknown")} (${String(snapshot.id || "unknown")})`),
        ].join("\n")}\n`;
    }
    const snapshot = payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).snapshot
        : null;
    const record = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
        ? snapshot as Record<string, unknown>
        : {};
    return `${[
        "=== CCC Device Snapshot ===",
        "",
        `action: ${action}`,
        `device: ${deviceId}`,
        `backend: ${backend}`,
        `name: ${String(record.name || "unknown")}`,
        `id: ${String(record.id || "unknown")}`,
        "provider: hyper-v",
    ].join("\n")}\n`;
}

function formatSnapshotError(action: DeviceSnapshotAction, result: HostDeviceBrokerOwnerRpcResult): string {
    const error = typeof result.body?.error === "string" ? result.body.error : result.error || "broker-operation-failed";
    const detail = typeof result.body?.detail === "string" ? result.body.detail : result.detail;
    return `CCC device snapshot ${action} failed: ${error}${detail ? ` - ${detail}` : ""}`;
}

const deviceAdminDeleteNativePorts: DeviceAdminDeletePorts<Backend, CommandResult> = {
    ...deviceAdminPhysicalTransitionNativePorts,
    withRecordLock: withAdminOwnerDeviceOperation,
    readDevices,
    sameRecord: isDeepStrictEqual,
    deleteManagedResource(provider, instance, timeoutMs) {
        const failure = (stderr: string) => ({ state: "failure" as const,
            evidence: { command: `${provider} delete ${instance}`, status: null, stdout: "", stderr } });
        if (!["tart", "vz", "utmctl"].includes(provider)) return failure(`unsupported macOS VM provider: ${provider}`);
        const executable = commandPath(provider);
        if (!executable) return failure("command not found");
        const result = runCommand(executable, ["delete", instance], timeoutMs);
        if (!result) return { state: "no-result" };
        return { state: result.status === 0 ? "success" : "failure", evidence: result };
    },
    releaseWindowsClaim: (ownerId, backend, device) => { releaseWindowsSandboxLockForOwner(ownerId, backend, device); return undefined; },
};
const deviceAdminDelete = createDeviceAdminDelete(deviceAdminDeleteNativePorts);

const deviceAdminInventory = createDeviceAdminInventory({
    backends: DEVICE_BACKENDS,
    resolveOwnerId: deviceLabOwnerId,
    enumerateOwnerIds: allOwnerIds,
    readDevices,
    commandPath,
});

export function deviceLabSnapshot(cwd = process.cwd(), profile?: string) {
    return deviceAdminInventory.snapshot(cwd, profile);
}

export function deviceLabAllOwnersSnapshot(): { owners: DeviceAdminOwnerSnapshot[] } {
    return deviceAdminInventory.allOwnersSnapshot();
}

export function stopOwnerDevice(deviceId: string, cwd = process.cwd(), profile?: string): { ok: boolean; text: string } {
    const ownerId = deviceLabOwnerId(cwd, profile);
    const match = findOwnerDevice(ownerId, deviceId);
    if (!match) return { ok: false, text: `Device not found for owner ${ownerId}: ${deviceId}\n` };

    const stopped = stopOwnerDeviceRecord(ownerId, match.backend, match.device);
    if (stopped.status !== "stopped") {
        const lines = [
            `failed: ${deviceId}`,
            `backend: ${match.backend.name}`,
            `owner: ${ownerId}`,
            `reason: ${stopped.reason || "device-stop-failed"}`,
        ];
        for (const result of stopped.commands) lines.push(`command: ${result.command} -> ${result.status ?? "unknown"}`);
        return { ok: false, text: `${lines.join("\n")}\n` };
    }

    const lines = [
        `stopped: ${deviceId}`,
        `backend: ${match.backend.name}`,
        `owner: ${ownerId}`,
    ];
    for (const result of stopped.commands) {
        lines.push(`command: ${result.command} -> ${result.status ?? "unknown"}`);
    }
    return { ok: true, text: `${lines.join("\n")}\n` };
}

export function deleteOwnerDevice(deviceId: string, cwd = process.cwd(), profile?: string): { ok: boolean; text: string } {
    const ownerId = deviceLabOwnerId(cwd, profile);
    const match = findOwnerDevice(ownerId, deviceId);
    if (!match) return { ok: false, text: `Device not found for owner ${ownerId}: ${deviceId}\n` };
    const deletion = deviceAdminDelete.deleteDevice(ownerId, match.backend, deviceId, match.device);
    if (!deletion.ok) {
        if (deletion.reason.startsWith("device-status-")) {
            return { ok: false, text: `Refusing to delete ${deviceId} while status is ${deletion.reason.slice("device-status-".length)}; run 'ccc devices stop ${deviceId}' first.\n` };
        }
        const lines = [`failed: ${deviceId}`, `backend: ${match.backend.name}`, `owner: ${ownerId}`, `reason: ${deletion.reason}`];
        for (const result of deletion.evidence) lines.push(`command: ${result.command} -> ${result.status ?? "unknown"}`);
        return { ok: false, text: `${lines.join("\n")}\n` };
    }
    const lines = [
        `deleted: ${deviceId}`,
        `backend: ${match.backend.name}`,
        `owner: ${ownerId}`,
    ];
    for (const result of deletion.evidence) lines.push(`command: ${result.command} -> ${result.status ?? "unknown"}`);
    return { ok: true, text: `${lines.join("\n")}\n` };
}

function deviceAdminPrune() {
    return createDeviceAdminPrune<Backend>({
        get backends() { return DEVICE_BACKENDS; },
        resolveOwnerId: (cwd, profile) => deviceLabOwnerId(cwd, profile),
        enumerateOwnerIds: () => allOwnerIds(),
        readDevices: (ownerId, stateKey) => readDevices(ownerId, stateKey),
        sameRecord: (current, expected) => isDeepStrictEqual(current, expected),
        withRecordLock: (ownerId, stateKey, deviceId, decide) => withAdminOwnerDeviceOperation(ownerId, stateKey, deviceId, decide),
        removeRecord: (ownerId, backend, expected) => transitionOwnerDeviceRecordWithPhysicalLease(ownerId, backend, expected, null),
    });
}

export function pruneOwnerDevices(cwd = process.cwd(), profile?: string): { ok: boolean; text: string } {
    return deviceAdminPrune().owner(cwd, profile);
}

function formatAllProjectCleanup(result: CleanupAllProjectsResult): string {
    const lines = ["projects: stop --all-projects"];
    let stopped = 0;
    let skipped = 0;
    let failed = 0;
    for (const project of result.projects) {
        lines.push(`project: ${project.ownerId}`);
        for (const device of project.results) {
            if (device.status === "skipped") {
                skipped += 1;
                lines.push(`skipped: ${device.id}  backend=${device.backend}  status=${device.previousStatus}`);
                continue;
            }
            if (device.status === "failed") {
                failed += 1;
                lines.push(`failed: ${device.id}  backend=${device.backend}  previous=${device.previousStatus}  reason=${device.reason || "device-stop-failed"}`);
            } else {
                stopped += 1;
                lines.push(`stopped: ${device.id}  backend=${device.backend}  previous=${device.previousStatus}`);
            }
            for (const command of device.commands) lines.push(`command: ${command.command} -> ${command.status ?? "unknown"}`);
        }
    }
    if (stopped === 0) lines.push("stopped: 0");
    if (failed > 0) lines.push(`failed: ${failed}`);
    lines.push(`skipped: ${skipped}`);
    return `${lines.join("\n")}\n`;
}

export function stopAllProjectDevices(timeoutMs = 5000): { ok: boolean; text: string } {
 const native = deviceAdminCleanupNativePorts();
 const result = createDeviceAdminAllProjectCleanup({
  ...native,
  get backends() { return DEVICE_BACKENDS; },
  enumerateOwnerIds: () => allOwnerIds(),
 }).allProjects(timeoutMs);
 return { ok: result.ok, text: formatAllProjectCleanup(result) };
}

export function pruneAllProjectDevices(): { ok: boolean; text: string } {
    return deviceAdminPrune().allProjects();
}

export function formatDevicesStatus(cwd = process.cwd(), profile?: string): string {
    return deviceAdminInventory.formatStatus(cwd, profile);
}

export function formatDevicesList(cwd = process.cwd(), profile?: string): string {
    return deviceAdminInventory.formatList(cwd, profile);
}

export function formatDevicesAllProjectsList(): string {
    return deviceAdminInventory.formatAllProjectsList();
}


type DiagnosticEvidence = { commands?: CommandResult[]; detail?: string };
function pushDeviceLabWiringDiagnostic(lines: string[], diagnostic: DeviceLabWiringDiagnostic, includeState = true): void {
    if (includeState) {
        lines.push(
            `state: ${diagnostic.stateRoot}`,
            `stateExists: ${diagnostic.stateExists}`,
            `ownerResolution: ${diagnostic.ownerResolution}`,
            `environmentRequired: ${diagnostic.environmentRequired}`,
        );
    }
    if (diagnostic.incomplete) {
        lines.push(
            "",
            "warning: device-lab container wiring is incomplete; the host-backed device state mount is unavailable from this container.",
            "remedy: restart or recreate ccc from the host so the project container has /home/ccc/.ccc/devices mounted.",
        );
    }
}

function missingPrerequisiteFromCommandFailure(result: CommandResult): string | null {
    const output = `${result.stderr || ""}\n${result.stdout || ""}`;
    const command = result.command;
    if (/\bemulator\b/.test(command) && /\s-list-avds\b/.test(command) && /ETIMEDOUT|timed out|Timeout/i.test(output)) {
        return "emulator inventory timed out";
    }
    if (!/xcrun|xcodebuild/.test(command)) return null;
    if (/unable to find utility "simctl"|not a developer tool/i.test(output) && /\bsimctl\b/.test(command)) return "missing simctl";
    if (/unable to find utility "xctrace"|not a developer tool/i.test(output) && /\bxctrace\b/.test(command)) return "missing xctrace";
    if (/xcode-select: error|No developer tools were found|not a developer tool/i.test(output)) return "missing Xcode developer tools";
    return null;
}

function smokePathCheck(command: string): CommandResult {
    return {
        command: `${command} path-check`,
        status: 0,
        stdout: "",
        stderr: "",
    };
}

function compactSmokeOutput(output: string): string {
    return output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 6)
        .join(" | ");
}

function admitDeviceAdminSmokeArgs(args: string[]): ParsedSmokeArgs {
    let mode: SmokeMode = "prerequisite";
    let timeoutMs = 5000;
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === "--real-provider" || arg === "--real-lab") {
            mode = "real-provider";
            continue;
        }
        if (arg === "--timeout-ms") {
            const value = args[i + 1];
            i += 1;
            const parsed = Number(value);
            if (!Number.isInteger(parsed) || parsed < 1 || parsed > 600000) {
                return { ok: false, message: "Usage: ccc devices smoke [--real-provider|--real-lab] [--timeout-ms 1..600000]" };
            }
            timeoutMs = parsed;
            continue;
        }
        if (arg.startsWith("--timeout-ms=")) {
            const parsed = Number(arg.slice("--timeout-ms=".length));
            if (!Number.isInteger(parsed) || parsed < 1 || parsed > 600000) {
                return { ok: false, message: "Usage: ccc devices smoke [--real-provider|--real-lab] [--timeout-ms 1..600000]" };
            }
            timeoutMs = parsed;
            continue;
        }
        return { ok: false, message: "Usage: ccc devices smoke [--real-provider|--real-lab] [--timeout-ms 1..600000]" };
    }
    return { ok: true, mode, timeoutMs };
}

const OPT_DIST_DEVICE_LAB_MCP_SERVER = "/opt/ccc/dist/device-lab-mcp/server.mjs";
const OPT_SOURCE_DEVICE_LAB_MCP_SERVER = "/opt/ccc/device-lab-mcp/server.mjs";
function runInstalledMcpSmoke(script: string, server: string, timeoutMs: number): CommandResult {
    const result = spawnSync(process.execPath, [script, server], {
        encoding: "utf-8", env: process.env, timeout: timeoutMs, windowsHide: true,
    });
    return { command: [process.execPath, script, server].join(" "), status: result.status,
        stdout: result.stdout || "", stderr: result.stderr || result.error?.message || "" };
}
function installedMcpSmokeScriptPath(options: SmokeFormatOptions): string {
    return options.mcpSmokeScriptPath || join(packageRoot(), "scripts", "real-tests", "installed-mcp-smoke.ts");
}

function installedDeviceLabMcpServerPath(options: SmokeFormatOptions): string {
    if (options.mcpServerPath) return options.mcpServerPath;
    const configuredServer = process.env.CCC_REAL_DEVICE_LAB_MCP_SERVER;
    if (configuredServer) return configuredServer;
    const packageDist = join(packageRoot(), "dist", "device-lab-mcp", "server.mjs");
    if (existsSync(packageDist)) return packageDist;
    if (existsSync(OPT_DIST_DEVICE_LAB_MCP_SERVER)) return OPT_DIST_DEVICE_LAB_MCP_SERVER;
    return OPT_SOURCE_DEVICE_LAB_MCP_SERVER;
}

function installedMcpSurfaceSmoke(timeoutMs: number, options: SmokeFormatOptions = {}): SmokeResult {
    const serverPath = installedDeviceLabMcpServerPath(options);
    const scriptPath = installedMcpSmokeScriptPath(options);
    if (!existsSync(serverPath)) {
        return { backend: "device-lab-mcp-installed", status: "SKIP", detail: `installed MCP server not found: ${serverPath}` };
    }
    if (!existsSync(scriptPath)) {
        return { backend: "device-lab-mcp-installed", status: "SKIP", detail: `installed MCP smoke script not found: ${scriptPath}` };
    }
    const command = runInstalledMcpSmoke(scriptPath, serverPath, Math.max(timeoutMs, 15000));
    if (command.status === 0) {
        return {
            backend: "device-lab-mcp-installed",
            status: "PASS",
            detail: "installed MCP advertised surface dispatches current-display aliases",
            commands: [command],
        };
    }
    const detail = compactSmokeOutput(`${command.stderr || ""}\n${command.stdout || ""}`) || `command exited ${command.status ?? "unknown"}`;
    return {
        backend: "device-lab-mcp-installed",
        status: "FAIL",
        detail,
        commands: [command],
    };
}


function deviceLabWiringDiagnostic(_cwd = process.cwd(), _profile?: string): DeviceLabWiringDiagnostic {
    const stateRoot = join(homedir(), ".ccc/devices");
    const stateExists = existsSync(stateRoot);
    return { stateRoot, stateExists, context: process.env.container === "docker" ? "container" : "host",
        environmentRequired: false, ownerResolution: "host-broker-resolve", incomplete: !stateExists };
}
function semanticHyperVReadiness(readiness: NonNullable<ReturnType<typeof parseHyperVReadiness>>): HyperVReadiness {
    return {
        available: readiness.available,
        moduleAvailable: readiness.moduleAvailable,
        hypervisorPresent: readiness.hypervisorPresent,
        vmmsRunning: readiness.vmmsRunning,
        rebootPending: readiness.rebootPending,
        missing: readiness.missing,
        ...(readiness.hyperVAdministratorsMember !== undefined ? { hyperVAdministratorsMember: readiness.hyperVAdministratorsMember } : {}),
        ...(readiness.managementAccess !== undefined ? { managementAccess: readiness.managementAccess } : {}),
        ...(readiness.sessionRefreshRequired !== undefined ? { sessionRefreshRequired: readiness.sessionRefreshRequired } : {}),
        ...(readiness.qemuImgAvailable !== undefined ? { qemuImgAvailable: readiness.qemuImgAvailable } : {}),
        ...(readiness.qemuImgTrusted !== undefined ? { qemuImgTrusted: readiness.qemuImgTrusted } : {}),
        ...(readiness.qemuImgSignatureStatus !== undefined ? { qemuImgSignatureStatus: readiness.qemuImgSignatureStatus } : {}),
        ...(readiness.linuxImageMissing !== undefined ? { linuxImageMissing: readiness.linuxImageMissing } : {}),
    };
}
function deviceAdminDiagnosticsNative(options: SmokeFormatOptions = {}): DeviceAdminDiagnosticsPorts<Backend, DiagnosticEvidence> {
    function execute(executable: string, args: string[], timeoutMs: number): CommandResult {
        return runCommand(executable, args, timeoutMs) || { command: [executable, ...args].join(" "), status: null, stderr: "command not found" };
    }
    function probe(tool: string, args: string[], timeoutMs: number): DiagnosticProbe<DiagnosticEvidence> {
        const executable = commandPath(tool);
        if (!executable) return { state: "missing" };
        const command = execute(executable, args, timeoutMs);
        const missing = command.status !== 0 ? missingPrerequisiteFromCommandFailure(command) : null;
        const detail = command.status === 0 ? undefined : missing
            ? `${missing} (${command.stderr || command.stdout || `command exited ${command.status}`})`
            : command.stderr || command.stdout || `command exited ${command.status}`;
        return { state: command.status === 0 ? "available" : missing ? "missing" : "failed",
            reason: missing ? "prerequisite-missing" : command.status === 0 ? undefined : "command-failed",
            evidence: { commands: [command], detail },
            tokens: command.status === 0 ? (`${command.stdout || ""}\n${command.stderr || ""}`.match(/[A-Za-z0-9._:-]+/g) || []) : undefined };
    }
    return {
        backends: DEVICE_BACKENDS, resolveOwnerId: deviceLabOwnerId, readDevices, hardwareIdForPhysicalDevice,
        readPhysicalLease: readPhysicalLeaseLock, now: () => Date.now(),
        availability() {
            const tools = Object.fromEntries(DEVICE_BACKENDS.flatMap(backend => backend.tools.map(tool => [tool, Boolean(commandPath(tool))])));
            return { adb: Boolean(tools.adb), emulator: Boolean(tools.emulator), xcrun: Boolean(tools.xcrun),
                wsb: Boolean(tools.wsb), powershell: Boolean(tools["powershell.exe"]),
                tart: Boolean(tools.tart), vz: Boolean(tools.vz), utmctl: Boolean(tools.utmctl),
                ssh: Boolean(commandPath("ssh")), scp: Boolean(commandPath("scp")), windowsHost: process.platform === "win32" };
        },
        physicalTargets: () => ({
            ios: Boolean((process.env.CCC_REAL_IOS_DEVICE_UDID || "").trim()),
            android: Boolean((process.env.CCC_REAL_ANDROID_DEVICE_SERIAL || process.env.CCC_REAL_ANDROID_SERIAL || "").trim()),
        }),
        probeAndroidVersion: timeout => probe("adb", ["version"], timeout),
        probeAndroidEmulatorInventory: timeout => probe("emulator", ["-list-avds"], timeout),
        probeAndroidPhysicalInventory: timeout => probe("adb", ["devices", "-l"], timeout),
        probeIosSimulatorInventory: timeout => probe("xcrun", ["simctl", "list", "-j"], timeout),
        probeIosPhysicalInventory: timeout => probe("xcrun", ["xctrace", "list", "devices"], timeout),
        probeWindowsSandbox: timeout => probe("wsb", ["--help"], timeout),
        probeMacosVersion: (provider, timeout) => probe(provider, ["--version"], timeout),
        probeSsh: timeout => probe("ssh", ["-V"], timeout),
        probeScp() {
            const executable = commandPath("scp");
            return executable ? { state: "available", evidence: { commands: [smokePathCheck(executable)] } } : { state: "missing" };
        },
        probeHyperV(timeoutMs) {
            const executable = commandPath("powershell.exe");
            if (!executable) return { state: "missing" };
            const plan = hyperVReadinessCommand(executable);
            const command = execute(plan.executable, plan.args, timeoutMs);
            const evidence = { commands: [command], detail: command.status === 0 ? undefined
                : compactSmokeOutput(String(command.stderr || command.stdout || "")) || `command exited ${command.status}` };
            if (command.status !== 0) return { state: "failed", evidence };
            const readiness = parseHyperVReadiness(command.stdout || "");
            return readiness ? { state: "available", readiness: semanticHyperVReadiness(readiness), evidence } : { state: "invalid", evidence: { ...evidence, detail: "invalid Hyper-V readiness response" } };
        },
        probeInstalledSurface(timeoutMs) {
            const result = installedMcpSurfaceSmoke(timeoutMs, options);
            return { state: result.status === "PASS" ? "available" : result.status === "SKIP" ? "missing" : "failed",
                reason: result.status === "SKIP" ? result.detail.startsWith("installed MCP server") ? "installed-server-missing" : "installed-script-missing" : undefined,
                evidence: { commands: result.commands, detail: result.detail } };
        },
        linuxImage(ownerId, readiness) {
            const result = hyperVLinuxSmokeImageResult(readiness, inspectHyperVUbuntuImageCache(join(homedir(), ".ccc/device-broker-private"), ownerId));
            return { available: result.status === "PASS", evidence: { detail: result.detail } };
        },
    };
}
function renderDiagnosticRow(result: DiagnosticRow<DiagnosticEvidence>, mode: SmokeMode): SmokeResult {
    const commands = result.evidence.flatMap(evidence => evidence.commands || []);
    const failureDetail = result.evidence.find(evidence => evidence.detail)?.detail;
    const responded: Record<string, [string, string]> = {
        "android-emulator": ["adb and emulator responded", "real provider adb/emulator readiness responded; no emulator started"],
        "android-device": ["adb physical-device inventory responded", "real provider adb physical-device inventory responded; no device claimed"],
        "ios-simulator": ["xcrun simctl inventory responded", "real provider simctl inventory responded; no simulator booted"],
        "ios-device": ["xcrun xctrace physical-device inventory responded", "real provider xctrace physical-device inventory responded; no device claimed"],
        "windows-sandbox": ["wsb CLI responded", "real provider Windows Sandbox CLI responded; no sandbox started"],
        "windows-vm": ["Hyper-V module, hypervisor, and VMMS service are ready; no VM started", "Hyper-V module, hypervisor, and VMMS service are ready; no VM started"],
    };
    let detail: string;
    switch (result.reason) {
    case "missing-tools": case "missing-bridge": detail = `missing ${result.missing!.map(name => result.backend === "linux-vm" && name === "powershell" ? "powershell.exe" : name).join(", ")}`; break;
    case "not-windows": detail = "not a Windows host"; break;
    case "hyper-v-unavailable": detail = `missing ${result.missing?.join(", ") || "Hyper-V prerequisites"}`; break;
    case "invalid-readiness": detail = "invalid Hyper-V readiness response"; break;
    case "macos-responded": detail = "macOS VM provider responded"; break;
    case "macos-real-responded": detail = "real provider macOS VM CLI and SSH bridge responded; SCP bridge tool found; no VM started"; break;
    case "optional-inventory-unavailable": detail = `physical-device inventory unavailable without an explicit leased device target (${failureDetail})`; break;
    case "responded": detail = failureDetail || responded[result.backend]?.[mode === "real-provider" ? 1 : 0] || ""; break;
    default: detail = failureDetail || ""; break;
    }
    return { backend: result.backend, status: result.status, detail, ...(commands.length ? { commands } : {}) };
}
export function deviceLabSmoke(cwd = process.cwd(), timeoutMs = 5000, profile?: string, options: SmokeOptions = {}) {
    const smoke = createDeviceAdminDiagnostics(deviceAdminDiagnosticsNative()).smoke(cwd, timeoutMs, profile, options);
    return { ...smoke, results: smoke.results.map(result => renderDiagnosticRow(result, smoke.mode)) };
}
export function deviceLabBenchHealth(cwd = process.cwd(), profile?: string, timeoutMs = 5000): DeviceLabBenchHealth {
    const bench = createDeviceAdminDiagnostics(deviceAdminDiagnosticsNative()).benchHealth(cwd, profile, timeoutMs);
    const deviceDetail: Record<BenchDeviceStatus, string> = {
        "missing-hardware-id": "attached physical device record has no serial/UDID", "missing-lease": "physical lease lock is missing",
        "foreign-lease": "lease belongs to another owner", "device-mismatch": "lease is bound to a different device id",
        "expired-lease": "", "inventory-missing": "host inventory did not list the attached hardware id",
        "lease-ok": "lease is current; inventory unavailable", healthy: "lease is current and host inventory lists the device",
    };
    return { ownerId: bench.ownerId, backends: bench.backends.map(backend => {
        const command = backend.evidence?.commands?.[0];
        const detail = backend.reason === "missing-tools" ? `missing ${backend.backend === "android-device" ? "adb" : "xcrun"}`
            : backend.reason === "probe-failed" ? `inventory command failed with status ${command?.status ?? "unknown"}`
            : backend.backend === "android-device" ? "adb physical-device inventory responded" : "xcrun physical-device inventory responded";
        return { backend: backend.backend, status: backend.status, detail,
            command: command ? { command: command.command, status: command.status } : null,
            devices: backend.devices.map(device => ({ ...device, detail: device.status === "expired-lease" ? `lease expired at ${device.expiresAt}` : deviceDetail[device.status] })) };
    }) };
}
export function formatDevicesDoctor(cwd = process.cwd(), profile?: string): string {
    const snapshot = deviceAdminInventory.snapshot(cwd, profile);
    const bench = deviceLabBenchHealth(cwd, profile);
    const wiring = deviceLabWiringDiagnostic();
    const lines = [
        "=== CCC Devices Doctor ===",
        "",
        `owner: ${snapshot.ownerId}`,
    ];
    pushDeviceLabWiringDiagnostic(lines, wiring);
    lines.push(
        "",
        "Device-lab MCP: managed by CCC when containers are started",
        "Startup policy: lazy; these diagnostics do not start devices",
        "",
    );
    for (const backend of snapshot.backends) {
        if (backend.available) {
            lines.push(`${backend.name}: ok`);
        } else {
            lines.push(`${backend.name}: missing ${backend.missing.join(", ")}`);
        }
    }
    lines.push("");
    lines.push("Lab bench health:");
    for (const backend of bench.backends) {
        lines.push(`${backend.backend}: ${backend.status} - ${backend.detail}`);
        if (backend.devices.length === 0) {
            lines.push("  (no current-owner attached physical devices)");
            continue;
        }
        for (const device of backend.devices) {
            const hardware = device.hardwareId ? ` hardware=${device.hardwareId}` : "";
            lines.push(`  ${device.deviceId}: ${device.status}${hardware} inventory=${device.inventoryState} - ${device.detail}`);
        }
    }
    return `${lines.join("\n")}\n`;
}

export function formatDevicesSmoke(cwd = process.cwd(), timeoutMs = 5000, profile?: string, options: SmokeFormatOptions = {}): string {
    const semantic = createDeviceAdminDiagnostics(deviceAdminDiagnosticsNative(options)).smoke(cwd, timeoutMs, profile, options);
    const smoke = { ...semantic, results: semantic.results.map(result => renderDiagnosticRow(result, semantic.mode)) };
    const wiring = deviceLabWiringDiagnostic();
    const results = smoke.results;
    const lines = [
        "=== CCC Devices Smoke ===",
        "",
        `owner: ${smoke.ownerId}`,
    ];
    pushDeviceLabWiringDiagnostic(lines, wiring);
    lines.push("Startup policy: lazy; smoke checks do not start devices", "");
    if (smoke.mode === "real-provider") {
        const startupIndex = lines.findIndex((line) => line === "Startup policy: lazy; smoke checks do not start devices");
        lines.splice(startupIndex, 0, "mode: real-provider (explicit opt-in)", "Real provider policy: bounded readiness/inventory commands only; no devices are created, started, stopped, or deleted");
    }
    for (const result of results) {
        lines.push(`${result.backend}: ${result.status} - ${result.detail}`);
        for (const command of result.commands || []) {
            lines.push(`  ${command.command} -> ${command.status ?? "unknown"}`);
        }
    }
    return `${lines.join("\n")}\n`;
}

type SetupEvidence = { execution?: CommandResult | null; detail?: string; receipt?: ReturnType<typeof readHyperVWindowsEvaluationReceipt> };
function admitDeviceAdminSetupArgs(args: string[]): { ok: true; confirm: boolean; acceptWindowsEvaluationLicense: boolean } | { ok: false; message: string } {
    const setupArgs = args.slice(2);
    const allowed = new Set(["--confirm", "--accept-windows-evaluation-license"]);
    if (args[1] !== "hyper-v" || setupArgs.some((arg) => !allowed.has(arg))
        || new Set(setupArgs).size !== setupArgs.length
        || (setupArgs.includes("--accept-windows-evaluation-license") && !setupArgs.includes("--confirm"))) {
        return { ok: false, message: "Usage: ccc devices setup hyper-v [--confirm [--accept-windows-evaluation-license]]" };
    }
    return { ok: true, confirm: setupArgs.includes("--confirm"), acceptWindowsEvaluationLicense: setupArgs.includes("--accept-windows-evaluation-license") };
}

function hyperVSetupFailureDetail(execution: CommandResult | null | undefined): string {
    const output = `${execution?.stderr || ""}\n${execution?.stdout || ""}`;
    const compact = output.replace(/_x[0-9a-f]{4}_/gi, "").replace(/\s+/g, "");
    const allowedCodes = [
        "hyper-v-setup-elevation-failed",
        "hyper-v-setup-pipe-handshake-timeout",
        "hyper-v-setup-pipe-client-mismatch",
        "hyper-v-setup-child-timeout",
        "hyper-v-setup-result-invalid",
        "hyper-v-setup-enable-failed",
        "hyper-v-setup-elevated-operation-failed",
        "hyper-v-setup-command-timeout",
        "hyper-v-setup-user-sid-invalid",
        "hyper-v-setup-pipe-name-invalid",
    ];
    for (const code of allowedCodes) {
        const pattern = new RegExp(`(^|[^a-z0-9-])${code}(?=$|[^a-z0-9-])`);
        if (pattern.test(output) || pattern.test(compact)) return code;
    }
    if (execution?.status === null && /ETIMEDOUT|timed out|timeout/i.test(output)) return "hyper-v-setup-command-timeout";
    return execution?.status === 0 ? "hyper-v-setup-result-invalid" : "hyper-v-setup-host-operation-failed";
}

function renderHyperVSetup(result: SetupResult<SetupEvidence>): HyperVSetupHostResult {
    if (!result.ok) {
        if (result.reason === "not-windows") return { ok: false, text: "CCC Hyper-V setup is only available on a Windows host." };
        if (result.reason === "powershell-missing") return { ok: false, text: "CCC Hyper-V setup failed: PowerShell was not found." };
        const detail = result.reason === "network-invalid" ? "hyper-v-setup-network-result-invalid"
            : result.evidence?.detail || hyperVSetupFailureDetail(result.evidence?.execution);
        return { ok: false, text: `CCC Hyper-V setup ${result.reason === "diagnostic-failed" ? "diagnostic " : ""}failed: ${detail}` };
    }
    if (result.mode === "diagnostic") {
        const { readiness, linuxImage, licenseAccepted } = result;
        const actions: string[] = [];
        if (!readiness.moduleAvailable || !readiness.hypervisorPresent) {
            actions.push("action: verify that the Windows edition supports Hyper-V and firmware virtualization is enabled, then run 'ccc devices setup hyper-v --confirm'");
        }
        if (!readiness.vmmsRunning) {
            actions.push("action: start the Hyper-V Virtual Machine Management (vmms) service, then rerun this diagnostic");
        }
        if (readiness.rebootPending) {
            actions.push("action: reboot Windows manually, then rerun this diagnostic");
        }
        if (readiness.managementAccess === false) {
            actions.push(readiness.sessionRefreshRequired
                ? "action: sign out of Windows and sign in once to activate Hyper-V Administrators membership, then rerun this diagnostic"
                : "action: grant the current user Hyper-V management access with 'ccc devices setup hyper-v --confirm', then rerun this diagnostic");
        }
        const qemuImgMissing = readiness.linuxImageMissing || [];
        const qemuImgRemedy = qemuImgMissing.includes("hyper-v-qemu-img-unavailable")
            ? "install the Android SDK Emulator package from Google so %LOCALAPPDATA%\\Android\\Sdk\\emulator\\qemu-img.exe is available for Hyper-V Linux images at that exact path, with no junction or symbolic link in any path component"
            : qemuImgMissing.includes("hyper-v-qemu-img-untrusted")
                ? `reinstall or update the Android Emulator through the Android SDK Manager until %LOCALAPPDATA%\\Android\\Sdk\\emulator\\qemu-img.exe has a Valid Google LLC signature (signature status: ${readiness.qemuImgSignatureStatus ?? "unknown"}); never substitute a qemu-img from another source`
                : null;
        const linuxImageActions: string[] = [];
        if (linuxImage.baseImage.state === "conflict") {
            // Partial and acquire-work artifacts also exist while a create is still acquiring the image.
            const acquisitionMayBeRunning = linuxImage.blockers.includes("hyper-v-base-image-artifact-owner-unknown")
                ? "; a Hyper-V Linux VM create that is still acquiring the image also leaves these artifacts, so first let any such create finish and rerun this diagnostic"
                : "";
            linuxImageActions.push(`action: resolve ${linuxImage.blockers.join(", ")} in the ubuntu-lts base image cache under %USERPROFILE%\\.ccc\\device-broker-private\\images\\hyper-v\\ubuntu-lts before creating a Hyper-V Linux VM; CCC does not repair or replace it automatically${acquisitionMayBeRunning}`);
        }
        if (qemuImgRemedy) {
            linuxImageActions.push(linuxImage.baseImage.state === "valid"
                ? `advisory: qemu-img is not needed until the ubuntu-lts image must be re-acquired; before then, ${qemuImgRemedy}`
                : `action: ${qemuImgRemedy}`);
        }
        return {
            ok: true,
            text: [
                "=== CCC Hyper-V Setup ===",
                "",
                "mode: diagnostic",
                `available: ${readiness.available}`,
                `moduleAvailable: ${readiness.moduleAvailable}`,
                `hypervisorPresent: ${readiness.hypervisorPresent}`,
                `vmmsRunning: ${readiness.vmmsRunning}`,
                `hyperVAdministratorsMember: ${readiness.hyperVAdministratorsMember ?? "unknown"}`,
                `managementAccess: ${readiness.managementAccess ?? "unknown"}`,
                `sessionRefreshRequired: ${readiness.sessionRefreshRequired ?? false}`,
                `rebootPending: ${readiness.rebootPending}`,
                `missing: ${readiness.missing.join(", ")}`,
                `qemuImgAvailable: ${readiness.qemuImgAvailable ?? false}`,
                `qemuImgTrusted: ${readiness.qemuImgTrusted ?? false}`,
                `qemuImgSignatureStatus: ${readiness.qemuImgSignatureStatus ?? "unknown"}`,
                `linuxImageMissing: ${(readiness.linuxImageMissing || []).join(", ")}`,
                `linuxBaseImage: ${linuxImage.baseImage.state}${linuxImage.baseImage.source ? ` (${linuxImage.baseImage.source})` : ""}`,
                `windowsEvaluationLicenseAccepted: ${licenseAccepted}`,
                ...(!licenseAccepted ? ["action: accept the Windows Server evaluation terms once with 'ccc devices setup hyper-v --confirm --accept-windows-evaluation-license'"] : []),
                ...linuxImageActions,
                ...actions,
            ].join("\n"),
        };

    }
    const { observation, network } = result;
    const receipt = result.receipt?.receipt;
    return {
        ok: true,
        text: [
            "=== CCC Hyper-V Setup ===",
            "",
            "mode: confirmed",
            `feature: ${observation.featureName}`,
            `beforeState: ${observation.beforeState}`,
            `afterState: ${observation.afterState}`,
            `changed: ${observation.changed}`,
            `hyperVAdministratorsMember: ${observation.hyperVAdministratorsMember ?? "unknown"}`,
            `membershipChanged: ${observation.membershipChanged ?? false}`,
            `managementAccess: ${observation.managementAccess ?? "unknown"}`,
            `sessionRefreshRequired: ${observation.sessionRefreshRequired ?? false}`,
            `rebootRequired: ${observation.rebootRequired}`,
            "networkPrepared: true",
            `networkSwitch: ${network.switchName}`,
            `networkGateway: ${network.gateway}`,
            `windowsEvaluationLicenseAccepted: ${Boolean(receipt)}`,
            ...(receipt ? [`windowsEvaluationLicense: ${HYPER_V_WINDOWS_EVALUATION_LICENSE_URL}`] : []),
            ...(receipt ? [`windowsEvaluationImageSourceTrust: ${receipt.sourceTrustId}`] : []),
            ...(observation.rebootRequired
                ? ["action: reboot Windows manually, then run 'ccc devices smoke --real-provider'"]
                : observation.sessionRefreshRequired
                    ? ["action: sign out of Windows and sign in once to activate Hyper-V Administrators membership, then run 'ccc devices smoke --real-provider'"]
                    : ["action: run 'ccc devices smoke --real-provider'"]),
            "hostRebooted: false",
        ].join("\n"),
    };
}
function semanticHyperVSetupObservation(observation: NonNullable<ReturnType<typeof parseHyperVSetupObservation>>): SetupObservation {
    return {
        ok: observation.ok,
        featureName: observation.featureName,
        beforeState: observation.beforeState,
        afterState: observation.afterState,
        changed: observation.changed,
        rebootRequired: observation.rebootRequired,
        ...(observation.hyperVAdministratorsMember !== undefined ? { hyperVAdministratorsMember: observation.hyperVAdministratorsMember } : {}),
        ...(observation.membershipChanged !== undefined ? { membershipChanged: observation.membershipChanged } : {}),
        ...(observation.managementAccess !== undefined ? { managementAccess: observation.managementAccess } : {}),
        ...(observation.sessionRefreshRequired !== undefined ? { sessionRefreshRequired: observation.sessionRefreshRequired } : {}),
    };
}
export async function setupHyperVHost(confirm: boolean, options: HyperVSetupHostOptions = {}): Promise<HyperVSetupHostResult> {
    let powershell: string;
    let setupRoot: string;
    let mutationLockFile: string;
    const runner = options.commandRunner || runCommand;
    const native: DeviceAdminSetupPorts<SetupEvidence> = {
        prepareContext(confirmed) {
            if ((options.platform || process.platform) !== "win32") return { ok: false, reason: "not-windows" };
            const injectedPowerShell = options.commandRunner && options.powershell !== undefined ? options.powershell : undefined;
            const executable = confirmed
                ? injectedPowerShell ?? canonicalWindowsPowerShellPath(options.commandRunner ? options.systemRoot : undefined)
                : options.powershell === undefined
                    ? commandPath("powershell.exe") || commandPath("pwsh") || commandPath("powershell")
                    : options.powershell;
            if (!executable) return { ok: false, reason: "powershell-missing" };
            powershell = executable;
            setupRoot = resolve(options.stateRoot || join(homedir(), ".ccc/device-broker-private/setup"));
            try { assertPlainDirectoryPath(setupRoot, "hyper-v-setup-root"); }
            catch (error) { return { ok: false, reason: "root-invalid", evidence: { detail: error instanceof Error ? error.message : String(error) } }; }
            return { ok: true };
        },
        prepareMutation() {
            mkdirSync(setupRoot, { recursive: true });
            try { assertPlainDirectoryPath(setupRoot, "hyper-v-setup-root"); }
            catch (error) { return { ok: false, reason: "root-invalid", evidence: { detail: error instanceof Error ? error.message : String(error) } }; }
            mutationLockFile = resolve(options.mutationLockFile || (options.stateRoot
                ? join(setupRoot, "host-locks", "hyper-v.mutation.lock")
                : join(homedir(), ".ccc/devices/host-locks/hyper-v.mutation.lock")));
            return { ok: true };
        },
        now: () => Date.now(),
        diagnose(timeoutMs) {
            const command = hyperVReadinessCommand(powershell);
            const execution = runner(command.executable, command.args, timeoutMs);
            const readiness = execution?.status === 0 ? parseHyperVReadiness(execution.stdout || "") : null;
            return readiness ? { state: "available", value: semanticHyperVReadiness(readiness), evidence: { execution } } : { state: "failed", evidence: { execution } };
        },
        linuxImage: (ownerId, readiness) => hyperVLinuxImageBlockers(readiness, inspectHyperVUbuntuImageCache(dirname(setupRoot), ownerId)),
        enableFeature(timeoutMs) {
            const command = hyperVSetupCommand(powershell);
            const execution = runner(command.executable, command.args, timeoutMs, command.input);
            const observation = execution?.status === 0 ? parseHyperVSetupObservation(execution.stdout || "") : null;
            return observation ? { state: "available", value: semanticHyperVSetupObservation(observation), evidence: { execution } } : { state: "failed", evidence: { execution } };
        },
        withMutationLock(operation, lockOptions) {
            mkdirSync(dirname(mutationLockFile), { recursive: true });
            assertPlainDirectoryPath(dirname(mutationLockFile), "hyper-v-setup-mutation-lock-root");
            return withSharedMutationLockAsync(mutationLockFile, operation, lockOptions);
        },
        ensureHostNetwork: async (deadlineAt) => {
            const network = await (options.ensureHostNetwork || ensureHyperVHostNetworkForSetup)({}, deadlineAt);
            return network.ok ? { ok: true, switchName: network.switchName, gateway: network.gateway }
                : { ok: false, evidence: { detail: network.detail || network.error } };
        },
        mutationFailure(error) {
            return { detail: (error as Error & { code?: string }).code === "shared-mutation-lock-timeout"
                ? "hyper-v-setup-lock-timeout" : error instanceof Error ? error.message : String(error) };
        },
        readEvaluationReceipt() { const receipt = readHyperVWindowsEvaluationReceipt(setupRoot); return receipt ? { receipt } : null; },
        acceptEvaluationLicense() { return { receipt: acceptHyperVWindowsEvaluationLicense(setupRoot) }; },
    };
    return renderHyperVSetup(await createDeviceAdminSetup(native).setup(confirm, {
        acceptWindowsEvaluationLicense: options.acceptWindowsEvaluationLicense, ownerId: options.ownerId,
    }));
}

export function formatDevicesBackends(cwd = process.cwd(), profile?: string): string {
    const snapshot = deviceLabSnapshot(cwd, profile);
    const wiring = deviceLabWiringDiagnostic(cwd, profile);
    const lines = [
        "=== CCC Device Backends ===",
        "",
        `owner: ${snapshot.ownerId}`,
    ];
    pushDeviceLabWiringDiagnostic(lines, wiring);
    lines.push("");
    for (const backend of snapshot.backends) {
        lines.push(`${backend.name}:`);
        lines.push(`  status: ${backend.available ? "available" : "missing-prerequisites"}`);
        for (const [tool, path] of Object.entries(backend.tools)) {
            lines.push(`  ${tool}: ${path || "missing"}`);
        }
    }
    return `${lines.join("\n")}\n`;
}

export function devicesCli(args: string[], cwd = process.cwd(), profile?: string): number {
    const subcommand = args[0] || "status";
    try {
        switch (subcommand) {
        case "status":
        case "list": {
            const admission = admitDeviceAdminInventoryCommand(args, subcommand);
            const publisher = console;
            const publish = admission === "invalid-list" ? publisher.error : publisher.log;
            const result = deviceAdminInventory.command(args, cwd, profile, admission)!;
            Reflect.apply(publish, publisher, [result.text]);
            return result.ok ? 0 : 1;
        }
        case "backends":
            console.log(formatDevicesBackends(cwd, profile));
            return 0;
        case "doctor":
            console.log(formatDevicesDoctor(cwd, profile));
            return 0;
        case "smoke":
            {
                const parsed = admitDeviceAdminSmokeArgs(args.slice(1));
                if (!parsed.ok) {
                    console.error(parsed.message);
                    return 1;
                }
                console.log(formatDevicesSmoke(cwd, parsed.timeoutMs, profile, { mode: parsed.mode, mcpSurface: true }));
            }
            return 0;
        case "stop": {
            const deviceId = args[1];
            if (deviceId === "--all-projects" && args.length === 2) {
                const result = stopAllProjectDevices();
                (result.ok ? console.log : console.error)(result.text);
                return result.ok ? 0 : 1;
            }
            if (!deviceId || args.length !== 2) {
                console.error("Usage: ccc devices stop <device-id>|--all-projects");
                return 1;
            }
            const result = stopOwnerDevice(deviceId, cwd, profile);
            (result.ok ? console.log : console.error)(result.text);
            return result.ok ? 0 : 1;
        }
        case "delete": {
            const deviceId = args[1];
            if (!deviceId) {
                console.error("Usage: ccc devices delete <device-id>");
                return 1;
            }
            const result = deleteOwnerDevice(deviceId, cwd, profile);
            (result.ok ? console.log : console.error)(result.text);
            return result.ok ? 0 : 1;
        }
        case "prune": {
            if (args.length === 1) {
                const result = pruneOwnerDevices(cwd, profile);
                console.log(result.text);
                return 0;
            }
            if (args.length === 2 && args[1] === "--all-projects") {
                const result = pruneAllProjectDevices();
                console.log(result.text);
                return result.ok ? 0 : 1;
            }
            console.error("Usage: ccc devices prune [--all-projects]");
            return 1;
        }
        case "broker":
            return deviceBrokerCli(args.slice(1), cwd, profile);
        default:
            console.error("Usage: ccc devices <status|list|create|start|stop|reboot|delete|snapshot|prune|backends|doctor|smoke|setup|broker>");
            return 1;
        }
    } catch (error) {
        if (error instanceof DeviceLabProjectEnumerationError) {
            console.error(`CCC device project enumeration failed: ${error.code}`);
            return 1;
        }
        throw error;
    }
}

export async function devicesCliAsync(
    args: string[],
    cwd = process.cwd(),
    profile?: string,
    hooks: DevicesCliAsyncHooks = {},
): Promise<number> {
    const subcommand = args[0] || "status";
    if (subcommand === "broker") {
        return deviceBrokerCliAsync(args.slice(1), cwd, profile, { ...hooks, trustedCliPaths: [join(packageRoot(), "dist", "index.js")] });
    }
    if (subcommand === "setup") {
        const parsed = admitDeviceAdminSetupArgs(args);
        if (!parsed.ok) {
            console.error(parsed.message);
            return 1;
        }
        const setup = hooks.setupHyperV || setupHyperVHost;
        const result = await setup(parsed.confirm, {
            acceptWindowsEvaluationLicense: parsed.acceptWindowsEvaluationLicense,
            ownerId: deviceLabOwnerId(cwd, profile),
        });
        (result.ok ? console.log : console.error)(result.text);
        return result.ok ? 0 : 1;
    }
    if (subcommand === "snapshot") {
        const parsed = parseDeviceSnapshotArgs(args, cwd, profile);
        if (!parsed.ok) {
            console.error(parsed.message);
            return 1;
        }
        const invoke = hooks.invokeOwnerRpc || invokeHostDeviceBrokerOwnerRpc;
        const result = await invoke("broker.device.tool.invoke", {
            tool: `device_snapshot_${parsed.action}`,
            backend: parsed.backend,
            deviceId: parsed.deviceId,
            ...parsed.params,
        }, { cwd, profile, trustedCliPaths: [join(packageRoot(), "dist", "index.js")], rpcTimeoutMs: 150000 });
        if (!result.ok) {
            console.error(formatSnapshotError(parsed.action, result));
            return 1;
        }
        console.log(formatSnapshotResult(parsed.action, parsed.backend, parsed.deviceId, result));
        return 0;
    }
    const crossProjectStop = subcommand === "stop" && args.length === 2 && args[1] === "--all-projects";
    if (!crossProjectStop && (subcommand === "create" || subcommand === "start" || subcommand === "stop" || subcommand === "reboot" || subcommand === "delete" || subcommand === "device-status" || (subcommand === "status" && args.length > 1))) {
        const parsed = parseDeviceLifecycleArgs(args, cwd, profile);
        if (!parsed.ok) {
            console.error(parsed.message);
            return 1;
        }
        const invoke = hooks.invokeOwnerRpc || invokeHostDeviceBrokerOwnerRpc;
        const hyperVBootTimeoutMs = (parsed.backend === "windows-vm" || parsed.backend === "linux-vm")
            && (parsed.action === "start" || parsed.action === "reboot")
            && parsed.params.waitForBoot !== false
            ? Number.isFinite(parsed.params.bootTimeoutMs)
                ? Math.min(DEVICE_BROKER_HYPER_V_MAX_BOOT_TIMEOUT_MS, Math.max(1000, Number(parsed.params.bootTimeoutMs)))
                : 5 * 60 * 1000
            : 0;
        const result = await invoke("broker.command.invoke", {
            backend: parsed.backend,
            command: parsed.action === "status" ? "device_status" : `device_${parsed.action}`,
            deviceId: parsed.deviceId,
            dryRun: false,
            ...parsed.params,
        }, {
            cwd,
            profile,
            trustedCliPaths: [join(packageRoot(), "dist", "index.js")],
            rpcTimeoutMs: parsed.action === "status"
                ? 15000
                : parsed.action === "create" && (parsed.backend === "windows-vm" || parsed.backend === "linux-vm")
                    ? 21615000
                    : (parsed.backend === "windows-vm" || parsed.backend === "linux-vm")
                        // The reserve term matches what the broker actually waits. Without it this
                        // sum gave up 4m45s before the broker's own window closed — precisely the
                        // stretch in which windows-vm containment runs — so `ccc devices start`
                        // could time out mid-containment and lose the reply carrying
                        // scrubContainmentFailed. The MCP client already includes it; the host CLI
                        // did not, and windows-vm taking the reserve is what made that gap bite.
                        ? (10 * 60 * 1000) + 120000 + hyperVBootTimeoutMs
                            + (hyperVBootTimeoutMs > 0 ? DEVICE_BROKER_HYPER_V_CLEANUP_RESERVE_MS : 0) + 15000
                    : 300000,
        });
        if (!result.ok) {
            console.error(formatLifecycleError(parsed.action, result));
            return 1;
        }
        if (parsed.action !== "delete" && !brokerRpcDevice(result)) {
            console.error(`CCC device ${parsed.action} failed: invalid-broker-response`);
            return 1;
        }
        console.log(formatLifecycleResult(parsed.action, parsed.backend, parsed.deviceId, result));
        return 0;
    }
    return devicesCli(args, cwd, profile);
}
