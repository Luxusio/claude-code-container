import { createDeviceAdminDiagnostics } from "./application/device-admin-diagnostics.js";
import { createDeviceAdminSetup } from "./application/device-admin-setup.js";
import { admitDeviceAdminSmokeArgs, pushDeviceLabWiringDiagnostic, type SmokeOptions, type SmokeFormatOptions, type DeviceLabBenchHealth } from "./domain/device-admin-diagnostics.js";
import { admitDeviceAdminSetupArgs } from "./domain/device-admin-setup.js";
export type { DeviceLabBenchHealth } from "./domain/device-admin-diagnostics.js";
export type { HyperVSetupHostResult } from "./domain/device-admin-setup.js";
import type { HyperVSetupHostResult } from "./domain/device-admin-setup.js";
import { createDeviceAdminAllProjectCleanup } from "./application/device-admin-cleanup.js";
import { createDeviceAdminPrune } from "./application/device-admin-prune.js";
import { macosManagedProviderResources } from "./domain/device-admin-prune.js";
import { admitDeviceAdminInventoryCommand } from "./domain/device-admin-inventory.js";
import { createDeviceAdminInventory } from "./application/device-admin-inventory.js";
import type { DeviceAdminOwnerSnapshot } from "./ports/device-admin-inventory.js";
import {
    DEVICE_BACKENDS,
    deviceAdminCleanupNativePorts,
    commandPath,
    deviceLabOwnerId,
    hardwareIdForPhysicalDevice,
    physicalLeaseAggregateFile,
    physicalLeaseAggregateMutationLockFile,
    physicalLeaseLockFile,
    physicalLeaseMatchesOwnerDevice,
    physicalLeaseMutationLockFile,
    readDevices,
    readPhysicalLeaseAggregate,
    releaseWindowsSandboxLockForOwner,
    runCommand,
    stopOwnerDeviceRecord,
    transitionOwnerDeviceRecord,
    transitionOwnerDeviceRecordWithPhysicalLease,
    withAdminOwnerDeviceOperation,
} from "./device-lab-cleanup.js";
import type { Backend, CommandResult, DeviceRecord, OwnerDeviceMatch, PhysicalLeaseRecord } from "./device-lab-cleanup.js";
export { DEVICE_BACKENDS, deviceLabOwnerIdentity, deviceLabOwnerId, cleanupOwnerDevices } from "./device-lab-cleanup.js";
import { existsSync, lstatSync, mkdirSync, realpathSync, unlinkSync } from "fs";

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
    withSharedMutationLock,
    withSharedMutationLockAsync,
    writeJsonFileAtomically,
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

function releasePhysicalLeaseForOwner(ownerId: string, backend: Backend, device: DeviceRecord): void {
    const hardwareId = hardwareIdForPhysicalDevice(backend, device);
    if (!hardwareId) return;
    const file = physicalLeaseLockFile(backend.stateKey, hardwareId);
    withSharedMutationLock(physicalLeaseMutationLockFile(backend.stateKey, hardwareId), () => {
        withSharedMutationLock(physicalLeaseAggregateMutationLockFile(backend.stateKey), () => {
            const lease = readPhysicalLeaseStateFile(file, backend.stateKey, hardwareId) as PhysicalLeaseRecord | null;
            if (!physicalLeaseMatchesOwnerDevice(ownerId, device, lease)) return;

            const aggregateFile = physicalLeaseAggregateFile(backend.stateKey);
            const previousLeases = readPhysicalLeaseAggregate(aggregateFile, backend.stateKey);
            const nextLeases = previousLeases.filter((candidate) => candidate.hardwareId !== hardwareId
                || !physicalLeaseMatchesOwnerDevice(ownerId, device, candidate));
            const aggregateChanged = !isDeepStrictEqual(previousLeases, nextLeases);
            if (aggregateChanged) writeJsonFileAtomically(aggregateFile, { leases: nextLeases });
            try {
                unlinkSync(file);
            } catch (error) {
                if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
                if (aggregateChanged) {
                    try {
                        writeJsonFileAtomically(aggregateFile, { leases: previousLeases });
                    } catch (rollbackError) {
                        throw new AggregateError([error, rollbackError], "physical-lease-aggregate-rollback-failed");
                    }
                }
                throw error;
            }
        });
    });
}

function deleteMacosArgs(provider: string, instance: string): string[] | null {
    if (provider === "tart") return ["delete", instance];
    if (provider === "vz") return ["delete", instance];
    if (provider === "utmctl") return ["delete", instance];
    return null;
}

function macosProviderDeleteFailure(provider: string, instance: string, stderr: string): CommandResult {
    return {
        command: `${provider} delete ${instance}`,
        status: null,
        stdout: "",
        stderr,
    };
}

function deleteMacosProviderResources(device: DeviceRecord, timeoutMs?: number): CommandResult[] {
    const results: CommandResult[] = [];
    for (const resource of macosManagedProviderResources(device)) {
        const args = deleteMacosArgs(resource.provider, resource.instance);
        if (!args) {
            results.push(macosProviderDeleteFailure(resource.provider, resource.instance, `unsupported macOS VM provider: ${resource.provider}`));
            continue;
        }
        const command = commandPath(resource.provider);
        if (!command) {
            results.push(macosProviderDeleteFailure(resource.provider, resource.instance, "command not found"));
            continue;
        }
        const result = runCommand(command, args, timeoutMs);
        if (result) results.push(result);
    }
    return results;
}

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
    const deletion = withAdminOwnerDeviceOperation(ownerId, match.backend.stateKey, deviceId, () => {
        const current = readDevices(ownerId, match.backend.stateKey).find((candidate) => candidate.id === deviceId);
        if (!current || !isDeepStrictEqual(current, match.device)) return { ok: false as const, reason: "owner-device-state-conflict", commands: [] as CommandResult[] };
        if (current.status !== "stopped" && current.status !== "detached") {
            return { ok: false as const, reason: `device-status-${current.status || "unknown"}`, commands: [] as CommandResult[] };
        }
        const commands = match.backend.stateKey === "macos" ? deleteMacosProviderResources(current) : [];
        if (commands.some((command) => command.status !== 0)) return { ok: false as const, reason: "provider-delete-failed", commands };
        try {
            releasePhysicalLeaseForOwner(ownerId, match.backend, current);
        } catch {
            return { ok: false as const, reason: "physical-lease-release-failed", commands };
        }
        releaseWindowsSandboxLockForOwner(ownerId, match.backend, current);
        const transition = transitionOwnerDeviceRecord(ownerId, match.backend, current, null);
        if (!transition.matched) return { ok: false as const, reason: "owner-device-state-conflict", commands };
        return { ok: true as const, commands };
    });
    if (!deletion.ok) {
        if (deletion.reason.startsWith("device-status-")) {
            return { ok: false, text: `Refusing to delete ${deviceId} while status is ${deletion.reason.slice("device-status-".length)}; run 'ccc devices stop ${deviceId}' first.\n` };
        }
        const lines = [`failed: ${deviceId}`, `backend: ${match.backend.name}`, `owner: ${ownerId}`, `reason: ${deletion.reason}`];
        for (const result of deletion.commands) lines.push(`command: ${result.command} -> ${result.status ?? "unknown"}`);
        return { ok: false, text: `${lines.join("\n")}\n` };
    }
    const lines = [
        `deleted: ${deviceId}`,
        `backend: ${match.backend.name}`,
        `owner: ${ownerId}`,
    ];
    for (const result of deletion.commands) lines.push(`command: ${result.command} -> ${result.status ?? "unknown"}`);
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

export function stopAllProjectDevices(timeoutMs = 5000): { ok: boolean; text: string } {
 const native = deviceAdminCleanupNativePorts();
 return createDeviceAdminAllProjectCleanup({
  ...native,
  get backends() { return DEVICE_BACKENDS; },
  enumerateOwnerIds: () => allOwnerIds(),
 }).allProjects(timeoutMs);
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

const deviceAdminDiagnostics = createDeviceAdminDiagnostics({
    backends: DEVICE_BACKENDS, resolveOwnerId: deviceLabOwnerId,
    readDevices, commandPath, hardwareIdForPhysicalDevice, readPhysicalLease: readPhysicalLeaseLock,
    platform: () => process.platform, environment: (name) => process.env[name], now: () => Date.now(),
    homeDirectory: homedir, packageRoot, joinPath: join, exists: existsSync, runCommand,
    readinessCommand: hyperVReadinessCommand, parseReadiness: parseHyperVReadiness,
    inspectLinuxImageCache: inspectHyperVUbuntuImageCache, linuxImageSmokeResult: hyperVLinuxSmokeImageResult,
    runNode(script, server, timeoutMs) {
        const result = spawnSync(process.execPath, [script, server], {
            encoding: "utf-8", env: process.env, timeout: timeoutMs, windowsHide: true,
        });
        return { command: [process.execPath, script, server].join(" "), status: result.status,
            stdout: result.stdout || "", stderr: result.stderr || result.error?.message || "" };
    },
}, deviceAdminInventory);
export function deviceLabSmoke(cwd = process.cwd(), timeoutMs = 5000, profile?: string, options: SmokeOptions = {}) {
    return deviceAdminDiagnostics.smoke(cwd, timeoutMs, profile, options);
}
export function deviceLabBenchHealth(cwd = process.cwd(), profile?: string, timeoutMs = 5000): DeviceLabBenchHealth {
    return deviceAdminDiagnostics.benchHealth(cwd, profile, timeoutMs);
}
export function formatDevicesDoctor(cwd = process.cwd(), profile?: string): string {
    return deviceAdminDiagnostics.formatDoctor(cwd, profile);
}
export function formatDevicesSmoke(cwd = process.cwd(), timeoutMs = 5000, profile?: string, options: SmokeFormatOptions = {}): string {
    return deviceAdminDiagnostics.formatSmoke(cwd, timeoutMs, profile, options);
}
function deviceLabWiringDiagnostic(_cwd = process.cwd(), _profile?: string) {
    return deviceAdminDiagnostics.wiringDiagnostic();
}
export async function setupHyperVHost(confirm: boolean, options: HyperVSetupHostOptions = {}): Promise<HyperVSetupHostResult> {
    const application = createDeviceAdminSetup({
        platform: () => options.platform || process.platform, homeDirectory: homedir, now: () => Date.now(),
        joinPath: join, resolvePath: resolve, parentDirectory: dirname, commandPath,
        canonicalPowerShell: canonicalWindowsPowerShellPath,
        assertPlainDirectory(path, label) { assertPlainDirectoryPath(path, label); return undefined; },
        createDirectory(path) { mkdirSync(path, { recursive: true }); return undefined; },
        runCommand: (command, args, timeoutMs, input) => (options.commandRunner || runCommand)(command, args, timeoutMs, input),
        readinessCommand: hyperVReadinessCommand, setupCommand: hyperVSetupCommand,
        parseReadiness: parseHyperVReadiness, parseSetupObservation: parseHyperVSetupObservation,
        inspectLinuxImageCache: inspectHyperVUbuntuImageCache, linuxImageBlockers: hyperVLinuxImageBlockers,
        withMutationLock: withSharedMutationLockAsync,
        ensureHostNetwork: (deadlineAt) => (options.ensureHostNetwork || ensureHyperVHostNetworkForSetup)({}, deadlineAt),
        readEvaluationReceipt: readHyperVWindowsEvaluationReceipt, acceptEvaluationLicense: acceptHyperVWindowsEvaluationLicense,
        evaluationLicenseUrl: HYPER_V_WINDOWS_EVALUATION_LICENSE_URL,
    });
    return application.setup(confirm, {
        powershell: options.powershell, injectedPowerShell: Boolean(options.commandRunner), systemRoot: options.systemRoot,
        stateRoot: options.stateRoot, mutationLockFile: options.mutationLockFile,
        acceptWindowsEvaluationLicense: options.acceptWindowsEvaluationLicense, ownerId: options.ownerId,
    });
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
