import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, unlinkSync } from "fs";
import { createHash } from "crypto";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { isDeepStrictEqual } from "util";
import {
    deviceBrokerCli,
    deviceBrokerCliAsync,
    DEVICE_BROKER_HYPER_V_MAX_BOOT_TIMEOUT_MS,
    invokeHostDeviceBrokerOwnerRpc,
    type HostDeviceBrokerOwnerRpcResult,
} from "./device-lab-broker.js";
import { deviceLabOwnerBasis, deviceLabOwnerId as canonicalDeviceLabOwnerId } from "./device-lab-owner.js";
import { inspectDeviceRuntimeProcessIdentity, signalDeviceRuntimeProcess } from "./device-lab-process-identity.js";
import { assertOwnerDeviceStateWritable, readOwnerDeviceStateFile } from "./device-lab-owner-state.js";
import { readPhysicalLeaseStateFile, readWindowsSandboxLockStateFile, validatePhysicalLease } from "./device-lab-ownership-state.js";
import { DeviceLabProjectEnumerationError, enumerateDeviceProjectIds } from "./device-lab-project-state.js";
import {
    assertStateDirectoriesUnchanged,
    secureStateParentDirectory,
    withSharedMutationLock,
    writeJsonFileAtomically,
} from "./device-lab-shared-state.js";
import { readDeviceLabStateFile } from "./device-lab-state-file.js";
import {
    acceptHyperVWindowsEvaluationLicense,
    HYPER_V_WINDOWS_EVALUATION_LICENSE_URL,
    readHyperVWindowsEvaluationReceipt,
} from "./device-lab/hyper-v-images.js";
import {
    HYPER_V_NETWORK_GATEWAY,
    HYPER_V_NETWORK_MARKER,
    HYPER_V_NETWORK_NAT,
    HYPER_V_NETWORK_PREFIX,
    HYPER_V_NETWORK_PREFIX_LENGTH,
    HYPER_V_NETWORK_SWITCH,
    hyperVReadinessCommand,
    hyperVSetupCommand,
    parseHyperVReadiness,
    parseHyperVSetupObservation,
} from "./device-lab/providers/hyper-v.js";

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

type Backend = typeof DEVICE_BACKENDS[number];
type DeviceRecord = Record<string, unknown> & { id?: string; status?: string };
type CommandResult = { command: string; status: number | null; stderr?: string; stdout?: string };
type OwnerDeviceMatch = { backend: Backend; devices: DeviceRecord[]; index: number; device: DeviceRecord };
type SmokeResult = { backend: string; status: "PASS" | "SKIP" | "FAIL"; detail: string; commands?: CommandResult[] };
type SmokeMode = "prerequisite" | "real-provider";
type SmokeOptions = { mode?: SmokeMode };
type SmokeFormatOptions = SmokeOptions & { mcpSurface?: boolean; mcpServerPath?: string; mcpSmokeScriptPath?: string };
type ParsedSmokeArgs = { ok: true; mode: SmokeMode; timeoutMs: number } | { ok: false; message: string };
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
};
export type HyperVSetupHostResult = { ok: boolean; text: string };

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

type HyperVSetupNetworkAllocation = {
    ownerId: string;
    deviceId: string;
    incarnationId?: string;
    address: string;
    macAddress: string;
    allocatedAt: string;
};

type HyperVSetupNetworkState = {
    version: 1;
    switchName: string;
    switchId: string;
    marker: string;
    natName: string;
    natInstanceId: string;
    prefix: string;
    gateway: string;
    outboundPolicy: "nat";
    managedNat: boolean;
    allocations: HyperVSetupNetworkAllocation[];
};

function readHyperVSetupNetworkState(file: string): HyperVSetupNetworkState | null {
    if (!existsSync(file)) return null;
    try {
        return readDeviceLabStateFile(file, (parsed) => {
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                throw new Error("hyper-v-network-state-identity-conflict");
            }
            const current = parsed as Record<string, unknown>;
            if (current.version !== 1
                || current.switchName !== HYPER_V_NETWORK_SWITCH
                || typeof current.switchId !== "string"
                || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(current.switchId)
                || (current.natName !== HYPER_V_NETWORK_NAT && !/^CCCDeviceLab-[a-f0-9]{24}$/.test(String(current.natName || "")))
                || typeof current.natInstanceId !== "string" || !current.natInstanceId
                || current.natInstanceId.length > 256 || /[\u0000-\u001f]/.test(current.natInstanceId)
                || typeof current.marker !== "string"
                || !/^ccc-device-lab:hyper-v-network:(?:v1|[a-f0-9]{24})$/.test(current.marker)
                || current.prefix !== HYPER_V_NETWORK_PREFIX
                || current.gateway !== HYPER_V_NETWORK_GATEWAY
                || current.outboundPolicy !== "nat"
                || typeof current.managedNat !== "boolean"
                || !Array.isArray(current.allocations)) {
                throw new Error("hyper-v-network-state-identity-conflict");
            }
            const identities = new Set<string>();
            const addresses = new Set<string>();
            const macAddresses = new Set<string>();
            const allocations = current.allocations.map((candidate) => {
                if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
                    throw new Error("hyper-v-network-state-identity-conflict");
                }
                const allocation = candidate as Record<string, unknown>;
                if (typeof allocation.ownerId !== "string" || !/^[a-f0-9]{16}$/.test(allocation.ownerId)
                    || typeof allocation.deviceId !== "string" || !/^(?!\.\.?$)[A-Za-z0-9._:-]{1,128}$/.test(allocation.deviceId)
                    || (allocation.incarnationId !== undefined
                        && (typeof allocation.incarnationId !== "string" || !/^[a-f0-9]{32}$/.test(allocation.incarnationId)))
                    || typeof allocation.address !== "string" || !/^172\.29\.0\.(?:[1-9]\d?|1\d\d|2[0-4]\d|250)$/.test(allocation.address)
                    || (allocation.macAddress !== undefined
                        && (typeof allocation.macAddress !== "string" || !/^02(?::[a-f0-9]{2}){5}$/.test(allocation.macAddress)))
                    || typeof allocation.allocatedAt !== "string" || Number.isNaN(Date.parse(allocation.allocatedAt))) {
                    throw new Error("hyper-v-network-state-identity-conflict");
                }
                const identity = `${allocation.ownerId}:${allocation.deviceId}`;
                const digest = createHash("sha256").update(`${allocation.ownerId}\0${allocation.deviceId}\0${0}`).digest();
                const macAddress = typeof allocation.macAddress === "string"
                    ? allocation.macAddress
                    : [0x02, digest[0], digest[1], digest[2], digest[3], digest[4]]
                        .map((byte) => byte.toString(16).padStart(2, "0"))
                        .join(":");
                if (identities.has(identity) || addresses.has(allocation.address) || macAddresses.has(macAddress)) {
                    throw new Error("hyper-v-network-state-identity-conflict");
                }
                identities.add(identity);
                addresses.add(allocation.address);
                macAddresses.add(macAddress);
                return {
                    ownerId: allocation.ownerId,
                    deviceId: allocation.deviceId,
                    ...(typeof allocation.incarnationId === "string" ? { incarnationId: allocation.incarnationId } : {}),
                    address: allocation.address,
                    macAddress,
                    allocatedAt: allocation.allocatedAt,
                };
            });
            return {
                version: 1,
                switchName: current.switchName,
                switchId: current.switchId.toLowerCase(),
                marker: current.marker,
                natName: current.natName,
                natInstanceId: current.natInstanceId,
                prefix: current.prefix,
                gateway: current.gateway,
                outboundPolicy: "nat",
                managedNat: current.managedNat,
                allocations,
            } as HyperVSetupNetworkState;
        }, "hyper-v-network-state", 256 * 1024);
    } catch {
        throw new Error("hyper-v-network-state-identity-conflict");
    }
}

function persistHyperVSetupNetworkState(
    file: string,
    current: HyperVSetupNetworkState | null,
    network: NonNullable<ReturnType<typeof parseHyperVSetupObservation>>["network"],
): void {
    if (!network) throw new Error("hyper-v-setup-network-result-invalid");
    const expectedSwitchName = current?.switchName || HYPER_V_NETWORK_SWITCH;
    const expectedNatName = current?.natName || HYPER_V_NETWORK_NAT;
    if (network.switchName !== expectedSwitchName
        || (current && network.switchId.toLowerCase() !== current.switchId)
        || network.natName !== expectedNatName
        || (current && network.natInstanceId !== current.natInstanceId)
        || network.prefix !== HYPER_V_NETWORK_PREFIX
        || network.gateway !== HYPER_V_NETWORK_GATEWAY) {
        throw new Error("hyper-v-network-state-identity-conflict");
    }
    writeJsonFileAtomically(file, {
        version: 1,
        switchName: network.switchName,
        switchId: network.switchId.toLowerCase(),
        marker: current?.marker || HYPER_V_NETWORK_MARKER,
        natName: network.natName,
        natInstanceId: network.natInstanceId,
        prefix: network.prefix,
        gateway: network.gateway,
        outboundPolicy: "nat",
        managedNat: current?.managedNat === true,
        allocations: current?.allocations || [],
    });
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
type CleanupDeviceResult = { id: string; backend: string; previousStatus: string; status: "stopped" | "skipped" | "failed"; commands: CommandResult[]; reason?: string };
type AdminBackendSnapshot = { stateKey: string; name: string; devices: DeviceRecord[] };
type AdminOwnerSnapshot = { ownerId: string; backends: AdminBackendSnapshot[] };
type PhysicalLeaseRecord = Record<string, unknown> & { ownerId?: string; deviceId?: string; hardwareId?: string; expiresAt?: string };
type BenchDeviceStatus = "healthy" | "lease-ok" | "missing-hardware-id" | "missing-lease" | "expired-lease" | "foreign-lease" | "device-mismatch" | "inventory-missing";
type BenchDeviceCheck = {
    deviceId: string;
    name: string;
    status: BenchDeviceStatus;
    detail: string;
    hardwareId: string | null;
    inventoryState: "present" | "missing" | "unknown";
    expiresAt?: string;
};
type BenchBackendHealth = {
    backend: "android-device" | "ios-device";
    status: "PASS" | "SKIP" | "FAIL";
    detail: string;
    command: { command: string; status: number | null } | null;
    devices: BenchDeviceCheck[];
};
export type DeviceLabBenchHealth = { ownerId: string; backends: BenchBackendHealth[] };
type BackendToolSnapshot = {
    tools: Record<string, string | null>;
    missing: string[];
    available: boolean;
};
type DeviceLabWiringDiagnostic = {
    stateRoot: string;
    stateExists: boolean;
    context: "container" | "host";
    environmentRequired: boolean;
    ownerResolution: "host-broker-resolve";
    incomplete: boolean;
};

export { DeviceLabProjectEnumerationError } from "./device-lab-project-state.js";

const OPT_DIST_DEVICE_LAB_MCP_SERVER = "/opt/ccc/dist/device-lab-mcp/server.mjs";
const OPT_SOURCE_DEVICE_LAB_MCP_SERVER = "/opt/ccc/device-lab-mcp/server.mjs";
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

function ownersRoot(): string {
    return join(homedir(), ".ccc/devices/owners");
}

function backendToolSnapshot(backend: Backend): BackendToolSnapshot {
    const tools = Object.fromEntries(backend.tools.map((tool) => [tool, commandPath(tool)])) as Record<string, string | null>;
    if (backend.name === "macos-vm") {
        const providerAvailable = backend.tools.some((tool) => Boolean(tools[tool]));
        return {
            tools,
            missing: providerAvailable ? [] : [...backend.tools],
            available: providerAvailable,
        };
    }
    const missing = backend.tools.filter((tool) => !tools[tool]);
    return {
        tools,
        missing,
        available: missing.length === 0,
    };
}

function deviceLabWiringDiagnostic(_cwd = process.cwd(), _profile?: string): DeviceLabWiringDiagnostic {
    const stateRoot = join(homedir(), ".ccc/devices");
    const stateExists = existsSync(stateRoot);
    const context = process.env.container === "docker" ? "container" : "host";
    return {
        stateRoot,
        stateExists,
        context,
        environmentRequired: false,
        ownerResolution: "host-broker-resolve",
        incomplete: !stateExists,
    };
}

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

function physicalLeaseLockFile(stateKey: string, hardwareId: string): string {
    return join(homedir(), ".ccc/devices/physical-leases", stateKey, "locks", `${encodeURIComponent(hardwareId)}.json`);
}

function physicalLeaseMutationLockFile(stateKey: string, hardwareId: string): string {
    return join(homedir(), ".ccc/devices/physical-leases", stateKey, "locks", `${encodeURIComponent(hardwareId)}.mutation.lock`);
}

function physicalLeaseAggregateFile(stateKey: string): string {
    return join(homedir(), ".ccc/devices/physical-leases", `${stateKey}.json`);
}

function physicalLeaseAggregateMutationLockFile(stateKey: string): string {
    return join(homedir(), ".ccc/devices/physical-leases", `${stateKey}.mutation.lock`);
}

function readPhysicalLeaseAggregate(file: string, stateKey: string): PhysicalLeaseRecord[] {
    return readDeviceLabStateFile(file, (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid physical lease aggregate");
        const leases = (value as { leases?: unknown }).leases;
        if (!Array.isArray(leases)) throw new TypeError("invalid physical lease aggregate");
        return leases.map((lease) => validatePhysicalLease(lease, stateKey));
    }, "physical-lease-aggregate") ?? [];
}

function readPhysicalLeaseLock(stateKey: string, hardwareId: string): PhysicalLeaseRecord | null {
    return readPhysicalLeaseStateFile(physicalLeaseLockFile(stateKey, hardwareId), stateKey, hardwareId) as PhysicalLeaseRecord | null;
}

function leaseExpired(lease: PhysicalLeaseRecord | null, nowMs = Date.now()): boolean {
    if (!lease?.expiresAt || Number.isNaN(Date.parse(lease.expiresAt))) return false;
    return Date.parse(lease.expiresAt) <= nowMs;
}

function allOwnerIds(): string[] {
    return enumerateDeviceProjectIds(ownersRoot());
}

function readDevices(ownerId: string, stateKey: string): DeviceRecord[] {
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

function withAdminOwnerDeviceOperation<T>(ownerId: string, stateKey: string, deviceId: string, operation: () => T): T {
    return withSharedMutationLock(ownerDeviceOperationLockFile(ownerId, stateKey, deviceId), operation, {
        waitMs: 30000,
        staleMs: 15 * 60 * 1000,
    });
}

function transitionOwnerDeviceRecord(
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

function commandPath(command: string): string | null {
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

function runCommand(command: string | null, args: string[], timeoutMs?: number, input?: string): CommandResult | null {
    if (!command) return null;
    const result = spawnSync(command, args, { encoding: "utf-8", env: process.env, timeout: timeoutMs, windowsHide: true, input });
    return {
        command: [command, ...args].join(" "),
        status: result.status,
        stdout: result.stdout || "",
        stderr: result.stderr || result.error?.message || "",
    };
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

function smokeCommand(command: string, args: string[], timeoutMs: number): CommandResult {
    return runCommand(command, args, timeoutMs) || {
        command: [command, ...args].join(" "),
        status: null,
        stderr: "command not found",
    };
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

function smokeFromCommands(backend: string, commands: Array<[string, string[]]>, detail: string, timeoutMs: number): SmokeResult {
    const results = commands.map(([command, args]) => smokeCommand(command, args, timeoutMs));
    const failed = results.find((result) => result.status !== 0);
    if (failed) {
        const missing = missingPrerequisiteFromCommandFailure(failed);
        if (missing) {
            return {
                backend,
                status: "SKIP",
                detail: `${missing} (${failed.stderr || failed.stdout || `command exited ${failed.status}`})`,
                commands: results,
            };
        }
        return {
            backend,
            status: "FAIL",
            detail: failed.stderr || failed.stdout || `command exited ${failed.status}`,
            commands: results,
        };
    }
    return { backend, status: "PASS", detail, commands: results };
}

function optionalPhysicalInventorySmoke(backend: "android-device" | "ios-device", command: string, args: string[], detail: string, timeoutMs: number): SmokeResult {
    const result = smokeFromCommands(backend, [[command, args]], detail, timeoutMs);
    if (result.status !== "FAIL") return result;
    const explicitTarget = backend === "ios-device"
        ? Boolean((process.env.CCC_REAL_IOS_DEVICE_UDID || "").trim())
        : Boolean((process.env.CCC_REAL_ANDROID_DEVICE_SERIAL || process.env.CCC_REAL_ANDROID_SERIAL || "").trim());
    if (explicitTarget) return result;
    return {
        ...result,
        status: "SKIP",
        detail: `physical-device inventory unavailable without an explicit leased device target (${result.detail})`,
    };
}

function smokeDetail(mode: SmokeMode, normal: string, realProvider: string): string {
    return mode === "real-provider" ? realProvider : normal;
}

function smokePathCheck(command: string): CommandResult {
    return {
        command: `${command} path-check`,
        status: 0,
        stdout: "",
        stderr: "",
    };
}

function packageRoot(): string {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    return dirname(moduleDir);
}

function installedMcpSmokeScriptPath(options: SmokeFormatOptions): string {
    return options.mcpSmokeScriptPath || join(packageRoot(), "scripts", "real-tests", "installed-mcp-smoke.ts");
}

function installedDeviceLabMcpServerPath(options: SmokeFormatOptions): string {
    if (options.mcpServerPath) return options.mcpServerPath;
    if (process.env.CCC_REAL_DEVICE_LAB_MCP_SERVER) return process.env.CCC_REAL_DEVICE_LAB_MCP_SERVER;
    const packageDist = join(packageRoot(), "dist", "device-lab-mcp", "server.mjs");
    if (existsSync(packageDist)) return packageDist;
    if (existsSync(OPT_DIST_DEVICE_LAB_MCP_SERVER)) return OPT_DIST_DEVICE_LAB_MCP_SERVER;
    return OPT_SOURCE_DEVICE_LAB_MCP_SERVER;
}

function compactSmokeOutput(output: string): string {
    return output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 6)
        .join(" | ");
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
    const result = spawnSync(process.execPath, [scriptPath, serverPath], {
        encoding: "utf-8",
        env: process.env,
        timeout: Math.max(timeoutMs, 15000),
        windowsHide: true,
    });
    const command: CommandResult = {
        command: [process.execPath, scriptPath, serverPath].join(" "),
        status: result.status,
        stdout: result.stdout || "",
        stderr: result.stderr || result.error?.message || "",
    };
    if (result.status === 0) {
        return {
            backend: "device-lab-mcp-installed",
            status: "PASS",
            detail: "installed MCP advertised surface dispatches current-display aliases",
            commands: [command],
        };
    }
    const detail = compactSmokeOutput(`${command.stderr || ""}\n${command.stdout || ""}`) || `command exited ${result.status ?? "unknown"}`;
    return {
        backend: "device-lab-mcp-installed",
        status: "FAIL",
        detail,
        commands: [command],
    };
}

function macosSmokeResult(tools: Record<string, string | null>, mode: SmokeMode, timeoutMs: number): SmokeResult {
    const macosProvider = tools.tart || tools.vz || tools.utmctl;
    if (!macosProvider) {
        return { backend: "macos-vm", status: "SKIP", detail: "missing tart, vz, utmctl" };
    }

    const provider = smokeCommand(macosProvider, ["--version"], timeoutMs);
    const commands: CommandResult[] = [provider];
    if (provider.status !== 0) {
        return {
            backend: "macos-vm",
            status: "FAIL",
            detail: provider.stderr || provider.stdout || `command exited ${provider.status}`,
            commands,
        };
    }

    if (mode !== "real-provider") {
        return { backend: "macos-vm", status: "PASS", detail: "macOS VM provider responded", commands };
    }

    const ssh = commandPath("ssh");
    const scp = commandPath("scp");
    const missingBridgeTools = [
        ["ssh", ssh],
        ["scp", scp],
    ].filter(([, path]) => !path).map(([tool]) => tool);
    if (missingBridgeTools.length > 0) {
        return {
            backend: "macos-vm",
            status: "SKIP",
            detail: `missing ${missingBridgeTools.join(", ")}`,
            commands,
        };
    }

    const sshTool = ssh as string;
    const scpTool = scp as string;
    const sshVersion = smokeCommand(sshTool, ["-V"], timeoutMs);
    const bridgeCommands = [sshVersion, smokePathCheck(scpTool)];
    commands.push(...bridgeCommands);
    const failed = bridgeCommands.find((result) => result.status !== 0);
    if (failed) {
        return {
            backend: "macos-vm",
            status: "FAIL",
            detail: failed.stderr || failed.stdout || `command exited ${failed.status}`,
            commands,
        };
    }

    return {
        backend: "macos-vm",
        status: "PASS",
        detail: "real provider macOS VM CLI and SSH bridge responded; SCP bridge tool found; no VM started",
        commands,
    };
}

export function setupHyperVHost(confirm: boolean, options: HyperVSetupHostOptions = {}): HyperVSetupHostResult {
    const platform = options.platform || process.platform;
    if (platform !== "win32") {
        return { ok: false, text: "CCC Hyper-V setup is only available on a Windows host." };
    }
    const injectedPowerShell = options.commandRunner && options.powershell !== undefined ? options.powershell : undefined;
    const powershell = confirm
        ? injectedPowerShell ?? canonicalWindowsPowerShellPath(options.commandRunner ? options.systemRoot : undefined)
        : options.powershell === undefined
            ? commandPath("powershell.exe") || commandPath("pwsh") || commandPath("powershell")
            : options.powershell;
    if (!powershell) return { ok: false, text: "CCC Hyper-V setup failed: PowerShell was not found." };
    const runner = options.commandRunner || ((command, args, timeoutMs, input) => runCommand(command, args, timeoutMs, input));
    const setupRoot = resolve(options.stateRoot || join(homedir(), ".ccc/device-broker-private/setup"));
    try {
        assertPlainDirectoryPath(setupRoot, "hyper-v-setup-root");
    } catch (error) {
        return { ok: false, text: `CCC Hyper-V setup failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    const licenseAccepted = Boolean(readHyperVWindowsEvaluationReceipt(setupRoot));
    if (!confirm) {
        const readinessCommand = hyperVReadinessCommand(powershell);
        const execution = runner(readinessCommand.executable, readinessCommand.args, 30_000);
        const readiness = execution?.status === 0 ? parseHyperVReadiness(execution.stdout || "") : null;
        if (!readiness) {
            const detail = hyperVSetupFailureDetail(execution);
            return { ok: false, text: `CCC Hyper-V setup diagnostic failed: ${detail}` };
        }
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
                `windowsEvaluationLicenseAccepted: ${licenseAccepted}`,
                ...(!licenseAccepted ? ["action: accept the Windows Server evaluation terms once with 'ccc devices setup hyper-v --confirm --accept-windows-evaluation-license'"] : []),
                ...actions,
            ].join("\n"),
        };
    }
    mkdirSync(setupRoot, { recursive: true });
    try {
        assertPlainDirectoryPath(setupRoot, "hyper-v-setup-root");
    } catch (error) {
        return { ok: false, text: `CCC Hyper-V setup failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    const mutationLockFile = resolve(options.mutationLockFile
        || (options.stateRoot
            ? join(setupRoot, "host-locks", "hyper-v.mutation.lock")
            : join(homedir(), ".ccc/devices/host-locks/hyper-v.mutation.lock")));
    let prepared: {
        execution: CommandResult | null;
        observation: ReturnType<typeof parseHyperVSetupObservation>;
    };
    try {
        mkdirSync(dirname(mutationLockFile), { recursive: true });
        assertPlainDirectoryPath(dirname(mutationLockFile), "hyper-v-setup-mutation-lock-root");
        prepared = withSharedMutationLock(mutationLockFile, () => {
            const networkStateRoot = resolve(options.networkStateRoot
                || (options.stateRoot ? join(setupRoot, "network") : join(dirname(setupRoot), "network")));
            mkdirSync(networkStateRoot, { recursive: true });
            assertPlainDirectoryPath(networkStateRoot, "hyper-v-network-state-root");
            const networkStateFile = join(networkStateRoot, "hyper-v.json");
            const networkDirectories = secureStateParentDirectory(networkStateFile);
            const current = readHyperVSetupNetworkState(networkStateFile);
            const setupCommand = hyperVSetupCommand(powershell, {
                switchName: current?.switchName || HYPER_V_NETWORK_SWITCH,
                natName: current?.natName || HYPER_V_NETWORK_NAT,
                marker: current?.marker || HYPER_V_NETWORK_MARKER,
                prefix: HYPER_V_NETWORK_PREFIX,
                gateway: HYPER_V_NETWORK_GATEWAY,
                prefixLength: HYPER_V_NETWORK_PREFIX_LENGTH,
                allowExistingNat: current !== null,
                expectedSwitchId: current?.switchId,
                expectedNatInstanceId: current?.natInstanceId,
            });
            const execution = runner(setupCommand.executable, setupCommand.args, 15 * 60_000, setupCommand.input);
            const observation = execution?.status === 0 ? parseHyperVSetupObservation(execution.stdout || "") : null;
            if (!observation?.ok || !observation.network) return { execution, observation };
            assertStateDirectoriesUnchanged(networkDirectories);
            const latest = readHyperVSetupNetworkState(networkStateFile);
            if (!isDeepStrictEqual(latest, current)) throw new Error("hyper-v-network-state-identity-conflict");
            persistHyperVSetupNetworkState(networkStateFile, current, observation.network);
            assertStateDirectoriesUnchanged(networkDirectories);
            return { execution, observation };
        }, { waitMs: 10 * 60_000, staleMs: 20 * 60_000 });
    } catch (error) {
        const code = (error as Error & { code?: string }).code;
        const detail = code === "shared-mutation-lock-timeout"
            ? "hyper-v-setup-lock-timeout"
            : error instanceof Error ? error.message : String(error);
        return { ok: false, text: `CCC Hyper-V setup failed: ${detail}` };
    }
    const { execution, observation } = prepared;
    if (!observation?.ok) {
        const detail = hyperVSetupFailureDetail(execution);
        return { ok: false, text: `CCC Hyper-V setup failed: ${detail}` };
    }
    if (!observation.network) {
        return { ok: false, text: "CCC Hyper-V setup failed: hyper-v-setup-network-result-invalid" };
    }
    const receipt = options.acceptWindowsEvaluationLicense
        ? acceptHyperVWindowsEvaluationLicense(setupRoot)
        : readHyperVWindowsEvaluationReceipt(setupRoot);
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
            `networkSwitch: ${observation.network.switchName}`,
            `networkNat: ${observation.network.natName}`,
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

function hyperVSmokeResult(tools: Record<string, string | null>, timeoutMs: number): SmokeResult {
    if (process.platform !== "win32") return { backend: "windows-vm", status: "SKIP", detail: "not a Windows host" };
    const powershell = tools["powershell.exe"];
    if (!powershell) return { backend: "windows-vm", status: "SKIP", detail: "missing powershell" };
    const plan = hyperVReadinessCommand(powershell);
    const result = smokeCommand(plan.executable, plan.args, timeoutMs);
    const commands = [result];
    if (result.status !== 0) {
        return { backend: "windows-vm", status: "FAIL", detail: compactSmokeOutput(String(result.stderr || result.stdout || "")) || `command exited ${result.status}`, commands };
    }
    const readiness = parseHyperVReadiness(result.stdout || "");
    if (!readiness) return { backend: "windows-vm", status: "FAIL", detail: "invalid Hyper-V readiness response", commands };
    if (!readiness.available) return { backend: "windows-vm", status: "SKIP", detail: `missing ${readiness.missing.join(", ") || "Hyper-V prerequisites"}`, commands };
    return { backend: "windows-vm", status: "PASS", detail: "Hyper-V module, hypervisor, and VMMS service are ready; no VM started", commands };
}

function hyperVLinuxSmokeResult(tools: Record<string, string | null>, timeoutMs: number): SmokeResult {
    if (process.platform !== "win32") return { backend: "linux-vm", status: "SKIP", detail: "not a Windows host" };
    const missing = ["powershell.exe", "ssh", "scp"].filter((tool) => !tools[tool]);
    if (missing.length > 0) return { backend: "linux-vm", status: "SKIP", detail: `missing ${missing.join(", ")}` };
    const plan = hyperVReadinessCommand(tools["powershell.exe"] as string);
    const result = smokeCommand(plan.executable, plan.args, timeoutMs);
    const commands = [result];
    if (result.status !== 0) return { backend: "linux-vm", status: "FAIL", detail: compactSmokeOutput(String(result.stderr || result.stdout || "")) || `command exited ${result.status}`, commands };
    const readiness = parseHyperVReadiness(result.stdout || "");
    if (!readiness) return { backend: "linux-vm", status: "FAIL", detail: "invalid Hyper-V readiness response", commands };
    if (!readiness.available) return { backend: "linux-vm", status: "SKIP", detail: `missing ${readiness.missing.join(", ") || "Hyper-V prerequisites"}`, commands };
    return { backend: "linux-vm", status: "PASS", detail: "Hyper-V, SSH, and SCP are ready; no VM started", commands };
}

export function deviceLabSmoke(cwd = process.cwd(), timeoutMs = 5000, profile?: string, options: SmokeOptions = {}): { ownerId: string; mode: SmokeMode; results: SmokeResult[] } {
    const ownerId = deviceLabOwnerId(cwd, profile);
    const mode = options.mode || "prerequisite";
    const tools = Object.fromEntries(
        DEVICE_BACKENDS.flatMap((backend) => backend.tools.map((tool) => [tool, commandPath(tool)])),
    ) as Record<string, string | null>;

    const results: SmokeResult[] = [];
    if (!tools.adb || !tools.emulator) {
        results.push({ backend: "android-emulator", status: "SKIP", detail: `missing ${["adb", "emulator"].filter((tool) => !tools[tool]).join(", ")}` });
    } else {
        results.push(smokeFromCommands("android-emulator", [[tools.adb, ["version"]], [tools.emulator, ["-list-avds"]]], smokeDetail(mode, "adb and emulator responded", "real provider adb/emulator readiness responded; no emulator started"), timeoutMs));
    }
    if (!tools.adb) {
        results.push({ backend: "android-device", status: "SKIP", detail: "missing adb" });
    } else {
        results.push(optionalPhysicalInventorySmoke("android-device", tools.adb, ["devices", "-l"], smokeDetail(mode, "adb physical-device inventory responded", "real provider adb physical-device inventory responded; no device claimed"), timeoutMs));
    }

    if (!tools.xcrun) {
        results.push({ backend: "ios-simulator", status: "SKIP", detail: "missing xcrun" });
    } else {
        results.push(smokeFromCommands("ios-simulator", [[tools.xcrun, ["simctl", "list", "-j"]]], smokeDetail(mode, "xcrun simctl inventory responded", "real provider simctl inventory responded; no simulator booted"), timeoutMs));
    }
    if (!tools.xcrun) {
        results.push({ backend: "ios-device", status: "SKIP", detail: "missing xcrun" });
    } else {
        results.push(optionalPhysicalInventorySmoke("ios-device", tools.xcrun, ["xctrace", "list", "devices"], smokeDetail(mode, "xcrun xctrace physical-device inventory responded", "real provider xctrace physical-device inventory responded; no device claimed"), timeoutMs));
    }

    if (!tools.wsb) {
        results.push({ backend: "windows-sandbox", status: "SKIP", detail: "missing wsb" });
    } else {
        results.push(smokeFromCommands("windows-sandbox", [[tools.wsb, ["--help"]]], smokeDetail(mode, "wsb CLI responded", "real provider Windows Sandbox CLI responded; no sandbox started"), timeoutMs));
    }

    results.push(hyperVSmokeResult(tools, timeoutMs));
    results.push(hyperVLinuxSmokeResult(tools, timeoutMs));

    results.push(macosSmokeResult(tools, mode, timeoutMs));

    return { ownerId, mode, results };
}

function parseDevicesSmokeArgs(args: string[]): ParsedSmokeArgs {
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

function benchInventory(stateKey: "android-device" | "ios-device", timeoutMs: number): { status: "PASS" | "SKIP" | "FAIL"; detail: string; command: CommandResult | null } {
    if (stateKey === "android-device") {
        const adb = commandPath("adb");
        if (!adb) return { status: "SKIP", detail: "missing adb", command: null };
        const command = smokeCommand(adb, ["devices", "-l"], timeoutMs);
        if (command.status !== 0) return { status: "FAIL", detail: `inventory command failed with status ${command.status ?? "unknown"}`, command };
        return { status: "PASS", detail: "adb physical-device inventory responded", command };
    }
    const xcrun = commandPath("xcrun");
    if (!xcrun) return { status: "SKIP", detail: "missing xcrun", command: null };
    const command = smokeCommand(xcrun, ["xctrace", "list", "devices"], timeoutMs);
    if (command.status !== 0) return { status: "FAIL", detail: `inventory command failed with status ${command.status ?? "unknown"}`, command };
    return { status: "PASS", detail: "xcrun physical-device inventory responded", command };
}

function inventoryContains(command: CommandResult | null, hardwareId: string): "present" | "missing" | "unknown" {
    if (!command || command.status !== 0) return "unknown";
    const output = `${command.stdout || ""}\n${command.stderr || ""}`;
    const tokens: string[] = output.match(/[A-Za-z0-9._:-]+/g) || [];
    return tokens.includes(hardwareId) ? "present" : "missing";
}

function benchDeviceCheck(ownerId: string, backend: Backend, device: DeviceRecord, command: CommandResult | null): BenchDeviceCheck {
    const deviceId = device.id || "(unknown)";
    const name = typeof device.name === "string" ? device.name : deviceId;
    const hardwareId = hardwareIdForPhysicalDevice(backend, device);
    if (!hardwareId) {
        return { deviceId, name, hardwareId: null, status: "missing-hardware-id", detail: "attached physical device record has no serial/UDID", inventoryState: "unknown" };
    }
    const lease = readPhysicalLeaseLock(backend.stateKey, hardwareId);
    const inventoryState = inventoryContains(command, hardwareId);
    if (!lease) return { deviceId, name, hardwareId, status: "missing-lease", detail: "physical lease lock is missing", inventoryState };
    if (lease.ownerId !== ownerId) return { deviceId, name, hardwareId, status: "foreign-lease", detail: "lease belongs to another owner", inventoryState };
    if (lease.deviceId && lease.deviceId !== deviceId) return { deviceId, name, hardwareId, status: "device-mismatch", detail: "lease is bound to a different device id", inventoryState };
    if (leaseExpired(lease)) return { deviceId, name, hardwareId, status: "expired-lease", detail: `lease expired at ${lease.expiresAt}`, inventoryState, expiresAt: lease.expiresAt };
    if (inventoryState === "missing") return { deviceId, name, hardwareId, status: "inventory-missing", detail: "host inventory did not list the attached hardware id", inventoryState };
    if (inventoryState === "unknown") return { deviceId, name, hardwareId, status: "lease-ok", detail: "lease is current; inventory unavailable", inventoryState };
    return { deviceId, name, hardwareId, status: "healthy", detail: "lease is current and host inventory lists the device", inventoryState };
}

export function deviceLabBenchHealth(cwd = process.cwd(), profile?: string, timeoutMs = 5000): DeviceLabBenchHealth {
    const ownerId = deviceLabOwnerId(cwd, profile);
    const backends = DEVICE_BACKENDS
        .filter((backend): backend is Extract<Backend, { stateKey: "android-device" | "ios-device" }> => backend.stateKey === "android-device" || backend.stateKey === "ios-device")
        .map((backend) => {
            const inventory = benchInventory(backend.stateKey, timeoutMs);
            const devices = readDevices(ownerId, backend.stateKey)
                .filter((device) => device.physical === true && device.status === "attached")
                .map((device) => benchDeviceCheck(ownerId, backend, device, inventory.command));
            return {
                backend: backend.stateKey,
                status: inventory.status,
                detail: inventory.detail,
                command: inventory.command ? { command: inventory.command.command, status: inventory.command.status } : null,
                devices,
            };
        });
    return { ownerId, backends };
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
    return `${lines.join("\n")}\n`;
}

function formatLifecycleError(action: DeviceLifecycleAction, result: HostDeviceBrokerOwnerRpcResult): string {
    const body = result.body;
    const error = typeof body?.error === "string" ? body.error : result.error || "broker-operation-failed";
    const detail = typeof body?.detail === "string" ? body.detail : result.detail;
    const missing = Array.isArray(body?.missing) && body.missing.length > 0 ? ` (missing: ${body.missing.join(", ")})` : "";
    return `CCC device ${action} failed: ${error}${missing}${detail ? ` - ${detail}` : ""}`;
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

function now(): string {
    return new Date().toISOString();
}

function serialForAndroid(device: DeviceRecord): string | null {
    if (typeof device.serial === "string" && device.serial) return device.serial;
    if (typeof device.port === "number") return `emulator-${device.port}`;
    return null;
}

function hardwareIdForPhysicalDevice(backend: Backend, device: DeviceRecord): string | null {
    if (backend.stateKey === "android-device") return serialForAndroid(device);
    if (backend.stateKey === "ios-device") {
        const udid = device.udid;
        return typeof udid === "string" && udid ? udid : null;
    }
    return null;
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

function physicalLeaseMatchesOwnerDevice(ownerId: string, device: DeviceRecord, lease: PhysicalLeaseRecord | null): boolean {
    const expectedClaimId = typeof device.leaseClaimId === "string" ? device.leaseClaimId : null;
    const expectedClaimNonce = typeof device.leaseClaimNonce === "string" ? device.leaseClaimNonce : null;
    const exactGeneration = expectedClaimId && expectedClaimNonce
        ? lease?.claimId === expectedClaimId && lease?.claimNonce === expectedClaimNonce
        : !lease?.claimId && !lease?.claimNonce;
    return lease?.ownerId === ownerId
        && (!device.id || !lease.deviceId || lease.deviceId === device.id)
        && exactGeneration;
}

function transitionOwnerDeviceRecordWithPhysicalLease(
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

function pruneOwnerDeviceRecord(ownerId: string, backend: Backend, expected: DeviceRecord): boolean {
    if (!expected.id) return false;
    return withAdminOwnerDeviceOperation(ownerId, backend.stateKey, expected.id, () => {
        const current = readDevices(ownerId, backend.stateKey).find((candidate) => candidate.id === expected.id);
        if (!current || !isDeepStrictEqual(current, expected)) return false;
        if ((current.status !== "stopped" && current.status !== "detached") || hasMacosManagedProviderResources(backend, current)) return false;

        return transitionOwnerDeviceRecordWithPhysicalLease(ownerId, backend, current, null);
    });
}

function windowsSandboxLockFile(): string {
    return join(homedir(), ".ccc/devices/host-locks/windows-sandbox.json");
}

function windowsSandboxMutationLockFile(): string {
    return join(homedir(), ".ccc/devices/host-locks/windows-sandbox.mutation.lock");
}

function releaseWindowsSandboxLockForOwner(ownerId: string, backend: Backend, device: DeviceRecord): void {
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

function deleteMacosArgs(provider: string, instance: string): string[] | null {
    if (provider === "tart") return ["delete", instance];
    if (provider === "vz") return ["delete", instance];
    if (provider === "utmctl") return ["delete", instance];
    return null;
}

function macosManagedProviderResource(device: DeviceRecord): boolean {
    return Boolean(
        device.providerResourceManaged ||
        device.provisioning === "image-created" ||
        device.provisioning === "image-cloned" ||
        device.imageSource ||
        device.clonedFrom ||
        device.imageCreatedAt ||
        device.clonedAt,
    );
}

function macosSnapshotProviderResources(device: DeviceRecord): Array<{ provider: string; instance: string }> {
    const snapshots = Array.isArray(device.snapshots) ? device.snapshots : [];
    return snapshots.flatMap((snapshot) => {
        if (!snapshot || typeof snapshot !== "object") return [];
        const record = snapshot as Record<string, unknown>;
        const provider = typeof record.provider === "string" ? record.provider : null;
        const instance = typeof record.providerInstance === "string" ? record.providerInstance : null;
        return provider && instance ? [{ provider, instance }] : [];
    });
}

function macosRestoreRecoveryProviderResource(device: DeviceRecord): { provider: string; instance: string } | null {
    const recovery = device.restoreRecovery;
    if (!recovery || typeof recovery !== "object") return null;
    const record = recovery as Record<string, unknown>;
    const provider = typeof record.provider === "string" ? record.provider : typeof device.provider === "string" ? device.provider : null;
    const instance = typeof record.candidateProviderInstance === "string" ? record.candidateProviderInstance : null;
    return provider && instance ? { provider, instance } : null;
}

function macosManagedProviderResources(device: DeviceRecord): Array<{ provider: string; instance: string }> {
    const resources = [
        ...macosSnapshotProviderResources(device),
        macosRestoreRecoveryProviderResource(device),
    ].filter((resource): resource is { provider: string; instance: string } => Boolean(resource));
    const provider = typeof device.provider === "string" ? device.provider : null;
    const instance = typeof device.providerInstance === "string" ? device.providerInstance : null;
    if (provider && instance && macosManagedProviderResource(device)) resources.push({ provider, instance });
    return resources;
}

function hasMacosManagedProviderResources(backend: Backend, device: DeviceRecord): boolean {
    return backend.stateKey === "macos" && macosManagedProviderResources(device).length > 0;
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

function shouldCleanupDevice(backend: Backend, device: DeviceRecord): boolean {
    if ((backend.stateKey === "android-device" || backend.stateKey === "ios-device") && device.status === "attached") return true;
    return lifecycleActive(device) || hasVolatileProcessMetadata(device);
}

function stopOwnerDeviceRecord(
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

export function deviceLabSnapshot(cwd = process.cwd(), profile?: string) {
    const ownerId = deviceLabOwnerId(cwd, profile);
    const backends = DEVICE_BACKENDS.map((backend) => {
        const devices = readDevices(ownerId, backend.stateKey);
        const snapshot = backendToolSnapshot(backend);
        return {
            ...backend,
            devices,
            tools: snapshot.tools,
            missing: snapshot.missing,
            available: snapshot.available,
        };
    });
    return { ownerId, backends };
}

export function deviceLabAllOwnersSnapshot(): { owners: AdminOwnerSnapshot[] } {
    const owners = allOwnerIds().map((ownerId) => ({
        ownerId,
        backends: DEVICE_BACKENDS.map((backend) => ({
            stateKey: backend.stateKey,
            name: backend.name,
            devices: readDevices(ownerId, backend.stateKey),
        })),
    }));
    return { owners };
}

function deviceLabel(device: unknown): string {
    if (!device || typeof device !== "object") return "(unknown)";
    const d = device as Record<string, unknown>;
    return [
        d.id,
        d.name ? `name=${d.name}` : null,
        d.status ? `status=${d.status}` : null,
        d.platform ? `platform=${d.platform}` : null,
    ].filter(Boolean).join("  ");
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

export function pruneOwnerDevices(cwd = process.cwd(), profile?: string): { ok: boolean; text: string } {
    const ownerId = deviceLabOwnerId(cwd, profile);
    const lines = [`owner: ${ownerId}`];
    let deleted = 0;
    for (const backend of DEVICE_BACKENDS) {
        for (const device of readDevices(ownerId, backend.stateKey)) {
            if (pruneOwnerDeviceRecord(ownerId, backend, device)) {
                deleted += 1;
                lines.push(`pruned: ${device.id || "(unknown)"}  backend=${backend.name}`);
            }
        }
    }
    if (deleted === 0) lines.push("pruned: 0");
    return { ok: true, text: `${lines.join("\n")}\n` };
}

export function stopAllProjectDevices(timeoutMs = 5000): { ok: boolean; text: string } {
    const lines = ["projects: stop --all-projects"];
    let stopped = 0;
    let skipped = 0;
    let failed = 0;
    for (const ownerId of allOwnerIds()) {
        lines.push(`project: ${ownerId}`);
        for (const backend of DEVICE_BACKENDS) {
            const devices = readDevices(ownerId, backend.stateKey);
            devices.forEach((device) => {
                if (!device.id || !shouldCleanupDevice(backend, device)) {
                    skipped += 1;
                    lines.push(`skipped: ${device.id || "(unknown)"}  backend=${backend.name}  status=${device.status || "unknown"}`);
                    return;
                }

                const result = stopOwnerDeviceRecord(ownerId, backend, device, timeoutMs);
                if (result.status !== "stopped") {
                    failed += 1;
                    lines.push(`failed: ${device.id}  backend=${backend.name}  previous=${device.status || "unknown"}  reason=${result.reason || "device-stop-failed"}`);
                    for (const command of result.commands) lines.push(`command: ${command.command} -> ${command.status ?? "unknown"}`);
                    return;
                }

                stopped += 1;
                lines.push(`stopped: ${device.id}  backend=${backend.name}  previous=${device.status || "unknown"}`);
                for (const command of result.commands) lines.push(`command: ${command.command} -> ${command.status ?? "unknown"}`);
            });
        }
    }
    if (stopped === 0) lines.push("stopped: 0");
    if (failed > 0) lines.push(`failed: ${failed}`);
    lines.push(`skipped: ${skipped}`);
    return { ok: failed === 0, text: `${lines.join("\n")}\n` };
}

export function pruneAllProjectDevices(): { ok: boolean; text: string } {
    const lines = ["projects: prune --all-projects"];
    let deleted = 0;
    for (const ownerId of allOwnerIds()) {
        lines.push(`project: ${ownerId}`);
        for (const backend of DEVICE_BACKENDS) {
            for (const device of readDevices(ownerId, backend.stateKey)) {
                if (pruneOwnerDeviceRecord(ownerId, backend, device)) {
                    deleted += 1;
                    lines.push(`pruned: ${device.id || "(unknown)"}  backend=${backend.name}`);
                }
            }
        }
    }
    if (deleted === 0) lines.push("pruned: 0");
    return { ok: true, text: `${lines.join("\n")}\n` };
}

export function formatDevicesStatus(cwd = process.cwd(), profile?: string): string {
    const snapshot = deviceLabSnapshot(cwd, profile);
    const lines = [
        "=== CCC Devices Status ===",
        "",
        `owner: ${snapshot.ownerId}`,
        "",
        "Backends:",
    ];
    for (const backend of snapshot.backends) {
        lines.push(`  ${backend.name}: ${backend.devices.length} device(s), ${backend.available ? "available" : `missing ${backend.missing.join(", ")}`}`);
    }
    return `${lines.join("\n")}\n`;
}

export function formatDevicesList(cwd = process.cwd(), profile?: string): string {
    const snapshot = deviceLabSnapshot(cwd, profile);
    const lines = [
        "=== CCC Devices ===",
        "",
        `owner: ${snapshot.ownerId}`,
        "",
    ];
    for (const backend of snapshot.backends) {
        lines.push(`${backend.name}:`);
        if (backend.devices.length === 0) {
            lines.push("  (none)");
        } else {
            for (const device of backend.devices) lines.push(`  ${deviceLabel(device)}`);
        }
    }
    return `${lines.join("\n")}\n`;
}

export function formatDevicesAllProjectsList(): string {
    const snapshot = deviceLabAllOwnersSnapshot();
    const lines = [
        "=== CCC Devices: All Projects ===",
        "",
    ];
    if (snapshot.owners.length === 0) {
        lines.push("(none)");
        return `${lines.join("\n")}\n`;
    }
    for (const owner of snapshot.owners) {
        lines.push(`project: ${owner.ownerId}`);
        for (const backend of owner.backends) {
            lines.push(`${backend.name}:`);
            if (backend.devices.length === 0) {
                lines.push("  (none)");
            } else {
                for (const device of backend.devices) lines.push(`  ${deviceLabel(device)}`);
            }
        }
        lines.push("");
    }
    return `${lines.join("\n").trimEnd()}\n`;
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

export function formatDevicesDoctor(cwd = process.cwd(), profile?: string): string {
    const snapshot = deviceLabSnapshot(cwd, profile);
    const bench = deviceLabBenchHealth(cwd, profile);
    const wiring = deviceLabWiringDiagnostic(cwd, profile);
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
    const smoke = deviceLabSmoke(cwd, timeoutMs, profile, options);
    const wiring = deviceLabWiringDiagnostic(cwd, profile);
    const results = options.mcpSurface === true
        ? [installedMcpSurfaceSmoke(timeoutMs, options), ...smoke.results]
        : smoke.results;
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

export function devicesCli(args: string[], cwd = process.cwd(), profile?: string): number {
    const subcommand = args[0] || "status";
    try {
        switch (subcommand) {
        case "status":
            console.log(formatDevicesStatus(cwd, profile));
            return 0;
        case "list":
            if (args.length === 1) {
                console.log(formatDevicesList(cwd, profile));
                return 0;
            }
            if (args.length === 2 && args[1] === "--all-projects") {
                console.log(formatDevicesAllProjectsList());
                return 0;
            }
            console.error("Usage: ccc devices list [--all-projects]");
            return 1;
        case "backends":
            console.log(formatDevicesBackends(cwd, profile));
            return 0;
        case "doctor":
            console.log(formatDevicesDoctor(cwd, profile));
            return 0;
        case "smoke":
            {
                const parsed = parseDevicesSmokeArgs(args.slice(1));
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
        return deviceBrokerCliAsync(args.slice(1), cwd, profile, hooks);
    }
    if (subcommand === "setup") {
        const setupArgs = args.slice(2);
        const allowed = new Set(["--confirm", "--accept-windows-evaluation-license"]);
        const malformed = args[1] !== "hyper-v"
            || setupArgs.some((arg) => !allowed.has(arg))
            || new Set(setupArgs).size !== setupArgs.length
            || (setupArgs.includes("--accept-windows-evaluation-license") && !setupArgs.includes("--confirm"));
        if (malformed) {
            console.error("Usage: ccc devices setup hyper-v [--confirm [--accept-windows-evaluation-license]]");
            return 1;
        }
        const setup = hooks.setupHyperV || setupHyperVHost;
        const result = setup(setupArgs.includes("--confirm"), {
            acceptWindowsEvaluationLicense: setupArgs.includes("--accept-windows-evaluation-license"),
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
        }, { cwd, profile, rpcTimeoutMs: 150000 });
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
            rpcTimeoutMs: parsed.action === "status"
                ? 15000
                : parsed.action === "create" && (parsed.backend === "windows-vm" || parsed.backend === "linux-vm")
                    ? 21615000
                    : (parsed.backend === "windows-vm" || parsed.backend === "linux-vm")
                        ? (10 * 60 * 1000) + 120000 + hyperVBootTimeoutMs + 15000
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
