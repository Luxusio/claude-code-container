#!/usr/bin/env node

import { spawn, spawnSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { androidDiscovery, handleAndroidTool } from "../../device-lab-mcp/src/backends/android.mjs";
import { handleAndroidRealTool } from "../../device-lab-mcp/src/backends/android-device.mjs";
import { ownerId as currentOwnerId } from "../../device-lab-mcp/src/context.mjs";
import { listOwnedAndroidAvdArtifacts, removeOwnedAndroidAvdArtifacts } from "../../device-lab-mcp/src/state/android-avd-storage.mjs";
import { readPhysicalLeases, releaseOwnedPhysicalLeaseResidue } from "../../device-lab-mcp/src/state/physical-lease-store.mjs";
import { listRunningWindowsSandboxSessions } from "../real-tests/windows-sandbox-e2e.ts";
import { withExclusiveRealProviderRun } from "../real-tests/exclusive-real-provider-run.ts";
import {
    describeProcessIdentities,
    identityForPid,
    liveOwnedProcessIdentities,
    processIdentityKey,
    processIdentitySnapshot,
    sameProcessIdentity,
    sampleOwnedProcessIdentities,
} from "./process-identity.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");
const realTestRunner = join(repoRoot, "scripts", "real-tests", "run.ts");
const OUTPUT_LIMIT_BYTES = 64 * 1024;
const PROCESS_SAMPLE_INTERVAL_MS = 50;
const RESIDUE_INLINE_LIMIT = 4;
const HYPER_V_NETWORK = Object.freeze({
    switchName: "CCC Device Lab",
    switchMarker: "ccc-device-lab:hyper-v-network:v1",
    natName: "CCCDeviceLab",
    prefix: "172.29.0.0/24",
    gateway: "172.29.0.1",
    prefixLength: 24,
});

export const REAL_PROVIDER_TARGETS = Object.freeze({
    "android-emulator": {
        module: "scripts/real-tests/level2-android-emulator-e2e.ts",
        backendState: "android",
        devicePrefix: "android-real-e2e-",
        tempPrefixes: ["ccc-android-emulator-e2e-"],
        destructive: "Creates, boots, controls, stops, and deletes a disposable Android emulator and AVD.",
    },
    "android-device": {
        module: "scripts/real-tests/level2-android-device-e2e.ts",
        backendState: "android-device",
        devicePrefix: "android-device-real-e2e-",
        tempPrefixes: ["android-device-e2e-"],
        destructive: "Uses the configured physical Android device, changes device/app state, and may install/uninstall the configured APK.",
    },
    "windows-sandbox": {
        module: "scripts/real-tests/level2-windows-sandbox.ts",
        backendState: "windows",
        devicePrefix: "windows-real-sandbox-",
        tempPrefixes: ["ccc-windows-sandbox-e2e-"],
        destructive: "Creates, controls, stops, and deletes a disposable Windows Sandbox session.",
        requireNoExistingWindowsSandbox: true,
    },
    "windows-vm": {
        module: "scripts/real-tests/level2-hyper-v-windows-vm.ts",
        backendState: "windows-vm",
        devicePrefix: "windows-vm-real-e2e-",
        tempPrefixes: ["ccc-hyper-v-windows-e2e-"],
        destructive: "Creates, boots, controls, checkpoints, stops, and deletes a disposable Hyper-V Windows VM.",
    },
    "linux-vm": {
        module: "scripts/real-tests/level2-hyper-v-linux-vm.ts",
        backendState: "linux-vm",
        devicePrefix: "linux-hyper-v-real-e2e-",
        tempPrefixes: ["ccc-hyper-v-linux-e2e-"],
        destructive: "Creates, boots, controls, checkpoints, stops, and deletes a disposable Hyper-V Linux VM.",
    },
});

export function usage() {
    return [
        "Usage: npm run test:durability:device-lab:real -- --target <target> [options]",
        "",
        `Targets: ${Object.keys(REAL_PROVIDER_TARGETS).join(" | ")}`,
        "",
        "Options:",
        "  --cycles <n>    Number of complete real E2E cycles, 1-100 (default: 10)",
        "  --timeout <t>   Per-cycle timeout (default: 20m; Hyper-V VM targets: 7h)",
        "  --dry-run       Validate and print the execution plan without creating devices",
        "  --help          Show this help",
        "",
        "WARNING: This command runs destructive or physical-provider E2E operations.",
        "It fails rather than stopping a pre-existing Windows Sandbox session.",
    ].join("\n");
}

function positiveInteger(value, name, maximum) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
        throw new Error(`${name} must be an integer from 1 to ${maximum}`);
    }
    return parsed;
}

function durationMs(value, name) {
    const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(String(value));
    if (!match) throw new Error(`${name} must be a duration such as 30s, 10m, or 1h`);
    const factor = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[(match[2] || "ms").toLowerCase()];
    const parsed = Math.ceil(Number(match[1]) * factor);
    if (!Number.isFinite(parsed) || parsed < 1000 || parsed > 24 * 3_600_000) {
        throw new Error(`${name} must be between 1s and 24h`);
    }
    return parsed;
}

export function parseRealProviderCycleArgs(args) {
    const options = { target: "", cycles: 10, timeoutMs: 20 * 60_000, dryRun: false, help: false };
    let timeoutExplicit = false;
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        const next = () => {
            const value = args[index + 1];
            if (value === undefined || value.startsWith("--")) throw new Error(`${argument} requires a value`);
            index += 1;
            return value;
        };
        if (argument === "--target") options.target = next();
        else if (argument === "--cycles") options.cycles = positiveInteger(next(), argument, 100);
        else if (argument === "--timeout") {
            options.timeoutMs = durationMs(next(), argument);
            timeoutExplicit = true;
        }
        else if (argument === "--dry-run") options.dryRun = true;
        else if (argument === "--help" || argument === "-h") options.help = true;
        else throw new Error(`unknown option: ${argument}`);
    }
    if (!options.help && !REAL_PROVIDER_TARGETS[options.target]) {
        throw new Error(`--target must be one of: ${Object.keys(REAL_PROVIDER_TARGETS).join(", ")}`);
    }
    if (!timeoutExplicit && (options.target === "windows-vm" || options.target === "linux-vm")) {
        options.timeoutMs = 7 * 60 * 60_000;
    }
    return options;
}

function readOptionalJson(path, kind) {
    let text;
    try {
        text = readFileSync(path, "utf8");
    } catch (error) {
        if (error?.code === "ENOENT") return { exists: false, value: null };
        throw new Error(`${kind} metadata unreadable at ${path}: ${error?.code || error?.message || error}`);
    }
    try {
        return { exists: true, value: JSON.parse(text) };
    } catch (error) {
        throw new Error(`${kind} metadata malformed at ${path}: ${error.message}`);
    }
}

function listOptionalDirectory(path, kind) {
    try {
        return readdirSync(path);
    } catch (error) {
        if (error?.code === "ENOENT") return [];
        throw new Error(`${kind} directory unreadable at ${path}: ${error?.code || error?.message || error}`);
    }
}

function matchingEntries(path, prefix) {
    return listOptionalDirectory(path, "test artifact")
        .filter((entry) => entry.startsWith(prefix))
        .map((entry) => join(path, entry));
}

function hyperVArtifactVhdxPaths(path, limit = 512) {
    let root;
    try {
        root = lstatSync(path);
    } catch (error) {
        if (error?.code === "ENOENT") return [];
        throw error;
    }
    if (!root.isDirectory() || root.isSymbolicLink()) return [];
    const pending = [path];
    const matches = [];
    let inspected = 0;
    while (pending.length > 0) {
        const directory = pending.pop();
        for (const entry of listOptionalDirectory(directory, "Hyper-V artifact")) {
            inspected += 1;
            if (inspected > limit) throw new Error(`Hyper-V artifact inspection exceeded ${limit} entries at ${path}`);
            const candidate = join(directory, entry);
            const metadata = lstatSync(candidate);
            if (metadata.isSymbolicLink()) continue;
            if (metadata.isDirectory()) pending.push(candidate);
            else if (metadata.isFile() && /\.(?:avhdx|vhdx)$/i.test(entry)) matches.push(candidate);
        }
    }
    return matches;
}

function hyperVOperationLockKey(deviceId) {
    return createHash("sha256").update(deviceId).digest("hex").slice(0, 32);
}

function classifyHyperVVm(vm, owner, definition) {
    const namePrefix = `ccc-${owner}-`;
    const markerPrefix = `ccc-device-lab:${owner}:`;
    const nameBody = vm.name.startsWith(namePrefix) ? vm.name.slice(namePrefix.length) : "";
    const nameMatch = nameBody.match(/^(.*)-([a-f0-9]{32})$/);
    const nameDeviceId = nameMatch ? nameMatch[1] : "";
    const nameIncarnationId = nameMatch ? nameMatch[2] : "";
    const markerBody = vm.notes.startsWith(markerPrefix) ? vm.notes.slice(markerPrefix.length) : "";
    const incarnationMarker = markerBody.match(/^(.*):([a-f0-9]{32})$/);
    const markerDeviceId = incarnationMarker ? incarnationMarker[1] : markerBody;
    const nameMatches = nameDeviceId.startsWith(definition.devicePrefix);
    const markerMatches = markerDeviceId.startsWith(definition.devicePrefix);
    const expectedNameDeviceId = markerDeviceId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "vm";
    if (nameMatches && markerMatches && nameDeviceId === expectedNameDeviceId && nameIncarnationId === incarnationMarker?.[2]) {
        return { ownership: "owned", deviceId: markerDeviceId };
    }
    if (nameMatches && !vm.notes) return { ownership: "owned", deviceId: nameDeviceId };
    if (nameMatches || markerMatches) return { ownership: "ambiguous", deviceId: nameDeviceId || markerDeviceId };
    return { ownership: "foreign", deviceId: "" };
}

export function listAndroidAvdNames(options = {}) {
    if (options.names) return [...options.names];
    const avdmanager = options.avdmanager || androidDiscovery().avdmanager;
    if (!avdmanager) throw new Error("Android AVD inventory unavailable: missing avdmanager");
    const invocation = androidAvdManagerInventoryInvocation(avdmanager, options.platform || process.platform);
    const result = (options.spawnSyncImpl || spawnSync)(invocation.command, invocation.args, {
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
    });
    if (result.status !== 0) {
        throw new Error(`Android AVD inventory failed: ${cleanupCommandError(result)}`);
    }
    return String(result.stdout || "").split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
}

export function listAndroidE2EAvdArtifactNames(options = {}) {
    const owner = options.owner || currentOwnerId();
    return listOwnedAndroidAvdArtifacts(owner, {
        ...options,
        suffixPattern: "real-android-e2e-[A-Za-z0-9._-]+",
    }).map((artifact) => artifact.name);
}

export function parseAndroidPhysicalDeviceInventory(text) {
    return String(text || "").split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("List of devices"))
        .map((line) => {
            const [serial, state] = line.split(/\s+/);
            return { serial, state: state || "unknown" };
        })
        .filter((device) => device.serial && !device.serial.startsWith("emulator-") && device.state === "device");
}

export function selectAndroidPhysicalDevice(devices, leases = [], owner = currentOwnerId()) {
    const candidates = [...new Map(devices.map((device) => [String(device.serial), device])).values()]
        .filter((device) => device.serial)
        .sort((left, right) => left.serial < right.serial ? -1 : left.serial > right.serial ? 1 : 0);
    if (candidates.length === 0) return null;
    const leaseFor = (serial) => leases.find((lease) => lease?.hardwareId === serial);
    return candidates.find((device) => leaseFor(device.serial)?.ownerId === owner)
        || candidates.find((device) => !leaseFor(device.serial))
        || null;
}

export function parseHyperVVmInventory(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return [];
    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    } catch (error) {
        throw new Error(`Hyper-V VM inventory returned invalid JSON: ${error.message}`);
    }
    const values = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? [parsed] : null;
    if (!values) throw new Error("Hyper-V VM inventory must be an array");
    return values.map((value) => {
        if (!value || typeof value !== "object" || typeof value.name !== "string" || typeof value.notes !== "string") {
            throw new Error("Hyper-V VM inventory entry must contain name and notes strings");
        }
        return {
            name: value.name,
            notes: value.notes,
            vmId: typeof value.vmId === "string" ? value.vmId.toLowerCase() : "",
            diskPaths: Array.isArray(value.diskPaths) ? value.diskPaths.filter((item) => typeof item === "string") : [],
            checkpoints: Array.isArray(value.checkpoints) ? value.checkpoints.filter((item) => typeof item === "string") : [],
        };
    });
}

function parseOptionalInventoryArray(value, kind) {
    if (value === null || value === undefined) return null;
    if (!Array.isArray(value) || value.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
        throw new Error(`Hyper-V network inventory ${kind} must be an array`);
    }
    return value;
}

export function parseHyperVNetworkInventory(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return { switches: null, nats: null, addresses: null };
    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    } catch (error) {
        throw new Error(`Hyper-V network inventory returned invalid JSON: ${error.message}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Hyper-V network inventory must be an object");
    }
    const switches = parseOptionalInventoryArray(parsed.switches, "switches");
    const nats = parseOptionalInventoryArray(parsed.nats, "NATs");
    const addresses = parseOptionalInventoryArray(parsed.addresses, "addresses");
    return {
        switches: switches?.map((item) => ({
            name: typeof item.name === "string" ? item.name : "",
            id: typeof item.id === "string" ? item.id.toLowerCase() : "",
            type: typeof item.type === "string" ? item.type : "",
            notes: typeof item.notes === "string" ? item.notes : "",
        })) ?? null,
        nats: nats?.map((item) => ({
            name: typeof item.name === "string" ? item.name : "",
            prefix: typeof item.prefix === "string" ? item.prefix : "",
            instanceId: typeof item.instanceId === "string" ? item.instanceId : "",
        })) ?? null,
        addresses: addresses?.map((item) => ({
            interfaceAlias: typeof item.interfaceAlias === "string" ? item.interfaceAlias : "",
            address: typeof item.address === "string" ? item.address : "",
            prefixLength: Number.isInteger(item.prefixLength) ? item.prefixLength : null,
        })) ?? null,
    };
}

export function listHyperVVmInventory(options = {}) {
    if ((options.platform || process.platform) !== "win32") return [];
    const script = [
        "$ErrorActionPreference = 'Stop'",
        "try {",
        "  $Rows = @(Get-VM -ErrorAction Stop | ForEach-Object {",
        "    $Vm = $_",
        "    [ordered]@{ name = [string]$Vm.Name; notes = [string]$Vm.Notes; vmId = [string]$Vm.Id; diskPaths = @((Get-VMHardDiskDrive -VM $Vm -ErrorAction Stop | ForEach-Object { [string]$_.Path })); checkpoints = @((Get-VMSnapshot -VM $Vm -ErrorAction Stop | ForEach-Object { [string]$_.Name })) }",
        "  })",
        "} catch {",
        "  $InventoryError = $_",
        "  $CurrentUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
        "  $HyperVGroupSid = [Security.Principal.SecurityIdentifier]'S-1-5-32-578'",
        "  $IsMember = $false",
        "  try { $IsMember = [bool]@(Get-LocalGroupMember -SID $HyperVGroupSid -ErrorAction Stop | Where-Object { $_.SID.Value -eq $CurrentUserSid }).Count } catch { $IsMember = $false }",
        "  $Principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()",
        "  $TokenHasRole = $Principal.IsInRole($HyperVGroupSid) -or $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
        "  if ($TokenHasRole) { throw $InventoryError }",
        "  if ($IsMember) { throw 'hyper-v-management-permission-unavailable:sign out of Windows and sign in once, then rerun the durability test' }",
        "  throw 'hyper-v-management-permission-unavailable:run ccc devices setup hyper-v --confirm, approve the one-time elevation, then sign out and sign in once'",
        "}",
        "ConvertTo-Json -InputObject $Rows -Compress -Depth 5",
    ].join("; ");
    const result = (options.spawnSyncImpl || spawnSync)(options.powershell || "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
    });
    if (result.status !== 0) throw new Error(`Hyper-V VM inventory failed: ${cleanupCommandError(result)}`);
    return parseHyperVVmInventory(result.stdout);
}

export function listHyperVNetworkInventory(options = {}) {
    if ((options.platform || process.platform) !== "win32") return { switches: null, nats: null, addresses: null };
    const script = [
        "$ErrorActionPreference = 'Stop'",
        "$Switches = @(Get-VMSwitch -ErrorAction Stop | ForEach-Object { [ordered]@{ name = [string]$_.Name; id = [string]$_.Id; type = [string]$_.SwitchType; notes = [string]$_.Notes } })",
        "$Nats = @(Get-NetNat -ErrorAction Stop | ForEach-Object { [ordered]@{ name = [string]$_.Name; prefix = [string]$_.InternalIPInterfaceAddressPrefix; instanceId = [string]$_.InstanceID } })",
        "$Addresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | ForEach-Object { [ordered]@{ interfaceAlias = [string]$_.InterfaceAlias; address = [string]$_.IPAddress; prefixLength = [int]$_.PrefixLength } })",
        "[ordered]@{ switches = $Switches; nats = $Nats; addresses = $Addresses } | ConvertTo-Json -Compress -Depth 5",
    ].join("; ");
    const result = (options.spawnSyncImpl || spawnSync)(options.powershell || "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
    });
    if (result.status !== 0) throw new Error(`Hyper-V network inventory failed: ${cleanupCommandError(result)}`);
    return parseHyperVNetworkInventory(result.stdout);
}

function hyperVSnapshotNetworkIdentity(options = {}) {
    if (options.networkIdentity !== undefined) return options.networkIdentity;
    const home = options.home || homedir();
    const path = join(home, ".ccc", "device-broker-private", "network", "hyper-v.json");
    const metadata = readOptionalJson(path, "Hyper-V snapshot network state");
    if (!metadata.exists) return null;
    const state = metadata.value;
    if (!state || typeof state !== "object" || Array.isArray(state)
        || state.version !== 1
        || state.switchName !== HYPER_V_NETWORK.switchName
        || typeof state.switchId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(state.switchId)
        || typeof state.marker !== "string" || !/^ccc-device-lab:hyper-v-network:(?:v1|[a-f0-9]{24})$/.test(state.marker)
        || (state.natName !== HYPER_V_NETWORK.natName && !/^CCCDeviceLab-[a-f0-9]{24}$/.test(String(state.natName || "")))
        || state.prefix !== HYPER_V_NETWORK.prefix
        || state.gateway !== HYPER_V_NETWORK.gateway
        || typeof state.managedNat !== "boolean"
        || !Array.isArray(state.allocations)
        || (state.managedNat === true && (typeof state.natInstanceId !== "string" || !state.natInstanceId))) {
        throw new Error(`Hyper-V snapshot network state malformed at ${path}`);
    }
    return state;
}

export function snapshotHyperVHostIdentity(options = {}) {
    const vms = (options.listHyperVVms || listHyperVVmInventory)(options.hyperVOptions || {})
        .filter((vm) => !options.owner || !options.definition || classifyHyperVVm(vm, options.owner, options.definition).ownership !== "owned")
        .map((vm) => ({
            name: vm.name,
            notes: vm.notes,
            vmId: vm.vmId,
            diskPaths: [...(vm.diskPaths || [])].sort(),
            checkpoints: [...(vm.checkpoints || [])].sort(),
        }))
        .sort((left, right) => `${left.vmId}\0${left.name}`.localeCompare(`${right.vmId}\0${right.name}`));
    const network = (options.listHyperVNetworks || listHyperVNetworkInventory)(options.hyperVNetworkOptions || options.hyperVOptions || {});
    if (!Array.isArray(network.switches) || !Array.isArray(network.nats) || !Array.isArray(network.addresses)) {
        throw new Error("Hyper-V network identity inventory incomplete");
    }
    const identity = hyperVSnapshotNetworkIdentity(options);
    const sortBy = (values, key) => [...values].sort((left, right) => String(left[key] || "").localeCompare(String(right[key] || "")));
    const switches = network.switches.filter((item) => !identity
        || item.name !== identity.switchName
        || item.id !== String(identity.switchId).toLowerCase()
        || item.notes !== identity.marker);
    const nats = network.nats.filter((item) => !identity
        || identity.managedNat !== true
        || item.name !== identity.natName
        || item.prefix !== identity.prefix
        || item.instanceId !== identity.natInstanceId);
    const managedAlias = identity ? `vEthernet (${identity.switchName})` : null;
    const addresses = network.addresses.filter((item) => item.interfaceAlias.startsWith("vEthernet (")
        && (!identity || item.interfaceAlias !== managedAlias || item.address !== identity.gateway || item.prefixLength !== HYPER_V_NETWORK.prefixLength));
    return {
        vms,
        switches: sortBy(switches, "id"),
        nats: sortBy(nats, "instanceId"),
        addresses: [...addresses].sort((left, right) =>
            `${left.interfaceAlias}\0${left.address}\0${left.prefixLength}`.localeCompare(`${right.interfaceAlias}\0${right.address}\0${right.prefixLength}`)),
    };
}

export function assertHyperVHostIdentityUnchanged(before, after) {
    const beforeJson = JSON.stringify(before);
    const afterJson = JSON.stringify(after);
    if (beforeJson === afterJson) return;
    const digest = (value) => createHash("sha256").update(value).digest("hex").slice(0, 16);
    throw new Error(`Hyper-V host identity changed during cycle (before=${digest(beforeJson)} after=${digest(afterJson)})`);
}

export function configureAndroidPhysicalDevice(env = process.env, options = {}) {
    const configured = String(env.CCC_REAL_ANDROID_DEVICE_SERIAL || env.CCC_REAL_DEVICE_LAB_ANDROID_DEVICE_SERIAL || "").trim();
    if (configured) return { serial: configured, source: "configured", candidates: 1 };
    const discovery = options.discovery || androidDiscovery();
    if (!discovery.adb) throw new Error("Android physical device auto-selection unavailable: missing adb");
    const result = (options.spawnSyncImpl || spawnSync)(discovery.adb, ["devices", "-l"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
    });
    if (result.status !== 0) throw new Error(`Android physical device inventory failed: ${cleanupCommandError(result)}`);
    const devices = parseAndroidPhysicalDeviceInventory(result.stdout);
    const leases = (options.readLeases || readPhysicalLeases)("android-device");
    const selected = selectAndroidPhysicalDevice(devices, leases, options.owner || currentOwnerId());
    if (!selected) throw new Error(devices.length > 0
        ? "all authorized physical Android devices are leased by other owners"
        : "no authorized physical Android device is connected");
    env.CCC_REAL_ANDROID_DEVICE_SERIAL = selected.serial;
    return { serial: selected.serial, source: "auto", candidates: devices.length };
}

function quoteWindowsCommandArg(value) {
    if (!/[ \t"&|<>^]/.test(value)) return value;
    return `"${String(value).replace(/(["^&|<>])/g, "^$1")}"`;
}

export function androidAvdManagerInvocation(avdmanager, args, platform = process.platform) {
    if (platform !== "win32" || !/\.(bat|cmd)$/i.test(String(avdmanager))) {
        return { command: avdmanager, args };
    }
    const commandLine = [quoteWindowsCommandArg(avdmanager), ...args.map(quoteWindowsCommandArg)].join(" ");
    return { command: "cmd.exe", args: ["/d", "/s", "/c", commandLine] };
}

export function androidAvdManagerInventoryInvocation(avdmanager, platform = process.platform) {
    return androidAvdManagerInvocation(avdmanager, ["list", "avd", "-c"], platform);
}

export function inspectTestOwnedResidue(target, options = {}) {
    const definition = REAL_PROVIDER_TARGETS[target];
    if (!definition) throw new Error(`unknown target: ${target}`);
    const home = options.home || homedir();
    const owner = options.owner || currentOwnerId();
    const root = join(home, ".ccc", "devices");
    const backendRoot = join(root, "owners", owner, definition.backendState);
    const statePath = join(backendRoot, "devices.json");
    const stateMetadata = readOptionalJson(statePath, "device state");
    const state = stateMetadata.value;
    if (stateMetadata.exists && (!state || typeof state !== "object" || !Array.isArray(state.devices))) {
        throw new Error(`device state metadata malformed at ${statePath}: expected an object with devices[]`);
    }
    const residue = [];
    const hyperVTarget = target === "windows-vm" || target === "linux-vm";
    const testDeviceIds = new Set();
    for (const device of Array.isArray(state?.devices) ? state.devices : []) {
        if (String(device?.id || "").startsWith(definition.devicePrefix)) {
            residue.push(`device-state:${device.id}`);
            testDeviceIds.add(device.id);
        }
    }
    const ownerArtifacts = matchingEntries(backendRoot, definition.devicePrefix);
    for (const path of ownerArtifacts) {
        residue.push(`owner-artifact:${path}`);
        testDeviceIds.add(path.replace(/\\/g, "/").split("/").at(-1));
        if (hyperVTarget) for (const diskPath of hyperVArtifactVhdxPaths(path)) residue.push(`vhdx:${diskPath}`);
    }
    let hyperVNetworkState = null;
    let hyperVNetworkIntent = null;
    if (hyperVTarget) {
        const privateBackendRoot = join(home, ".ccc", "device-broker-private", "owners", owner, definition.backendState);
        for (const path of matchingEntries(privateBackendRoot, definition.devicePrefix)) {
            residue.push(`private-artifact:${path}`);
            testDeviceIds.add(path.replace(/\\/g, "/").split("/").at(-1));
        }
        const networkStatePath = join(home, ".ccc", "device-broker-private", "network", "hyper-v.json");
        const networkMetadata = readOptionalJson(networkStatePath, "Hyper-V network state");
        const networkState = networkMetadata.value;
        if (networkMetadata.exists && (!networkState || typeof networkState !== "object" || Array.isArray(networkState)
            || networkState.version !== 1 || networkState.switchName !== HYPER_V_NETWORK.switchName
            || typeof networkState.switchId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(networkState.switchId)
            || (networkState.natName !== HYPER_V_NETWORK.natName && !/^CCCDeviceLab-[a-f0-9]{24}$/.test(String(networkState.natName || "")))
            || (networkState.marker !== undefined && !/^ccc-device-lab:hyper-v-network:(?:v1|[a-f0-9]{24})$/.test(String(networkState.marker)))
            || (networkState.managedNat === true && (typeof networkState.natInstanceId !== "string" || !networkState.natInstanceId))
            || networkState.prefix !== HYPER_V_NETWORK.prefix
            || networkState.gateway !== HYPER_V_NETWORK.gateway || !Array.isArray(networkState.allocations))) {
            throw new Error(`Hyper-V network state metadata malformed at ${networkStatePath}: expected the CCC Hyper-V v1 network and allocations[]`);
        }
        hyperVNetworkState = networkState;
        const networkIntentPath = join(home, ".ccc", "device-broker-private", "network", "hyper-v-intent.json");
        const intentMetadata = readOptionalJson(networkIntentPath, "Hyper-V network intent");
        const intent = intentMetadata.value;
        if (intentMetadata.exists && (!intent || typeof intent !== "object" || Array.isArray(intent)
            || intent.version !== 1 || typeof intent.token !== "string" || !/^[a-f0-9]{24}$/.test(intent.token)
            || intent.switchName !== HYPER_V_NETWORK.switchName
            || intent.natName !== `${HYPER_V_NETWORK.natName}-${intent.token}`
            || intent.marker !== `ccc-device-lab:hyper-v-network:${intent.token}`
            || intent.prefix !== HYPER_V_NETWORK.prefix || intent.gateway !== HYPER_V_NETWORK.gateway
            || typeof intent.createdAt !== "string")) {
            throw new Error(`Hyper-V network intent metadata malformed at ${networkIntentPath}`);
        }
        if (networkState && intent && (networkState.natName !== intent.natName
            || (networkState.marker || HYPER_V_NETWORK.switchMarker) !== intent.marker)) {
            throw new Error(`Hyper-V network intent conflicts with committed state at ${networkIntentPath}`);
        }
        hyperVNetworkIntent = intent;
        const identities = new Set();
        const addresses = new Set();
        for (const allocation of Array.isArray(networkState?.allocations) ? networkState.allocations : []) {
            if (!allocation || typeof allocation !== "object" || Array.isArray(allocation)
                || typeof allocation.ownerId !== "string" || !/^[a-f0-9]{16}$/.test(allocation.ownerId)
                || typeof allocation.deviceId !== "string" || !/^(?!\.\.?$)[A-Za-z0-9._:-]{1,128}$/.test(allocation.deviceId)
                || typeof allocation.address !== "string" || !/^172\.29\.0\.(?:[1-9]\d?|1\d\d|2[0-4]\d|250)$/.test(allocation.address)
                || typeof allocation.allocatedAt !== "string") {
                throw new Error(`Hyper-V network allocation metadata malformed at ${networkStatePath}`);
            }
            const identity = `${allocation.ownerId}:${allocation.deviceId}`;
            if (identities.has(identity) || addresses.has(allocation.address)) {
                throw new Error(`Hyper-V network allocation metadata conflicted at ${networkStatePath}`);
            }
            identities.add(identity);
            addresses.add(allocation.address);
            if (allocation.ownerId === owner && allocation.deviceId.startsWith(definition.devicePrefix)) {
                residue.push(`network-allocation:${networkStatePath}:${allocation.deviceId}`);
            }
        }
    }

    const leaseRoot = join(root, "physical-leases", definition.backendState, "locks");
    {
        for (const entry of listOptionalDirectory(leaseRoot, "physical lease").filter((name) => name.endsWith(".json"))) {
            const path = join(leaseRoot, entry);
            const leaseMetadata = readOptionalJson(path, "physical lease");
            const lease = leaseMetadata.value;
            if (!lease || typeof lease !== "object" || typeof lease.ownerId !== "string" || typeof lease.deviceId !== "string") {
                throw new Error(`physical lease metadata malformed at ${path}: expected ownerId and deviceId strings`);
            }
            if (lease?.ownerId === owner && String(lease?.deviceId || "").startsWith(definition.devicePrefix)) {
                residue.push(`physical-lease:${path}`);
            }
        }
    }
    const leaseAggregatePath = join(root, "physical-leases", `${definition.backendState}.json`);
    const leaseAggregateMetadata = readOptionalJson(leaseAggregatePath, "physical lease aggregate");
    const leaseAggregate = leaseAggregateMetadata.value;
    if (leaseAggregateMetadata.exists && (!leaseAggregate || typeof leaseAggregate !== "object" || !Array.isArray(leaseAggregate.leases))) {
        throw new Error(`physical lease aggregate metadata malformed at ${leaseAggregatePath}: expected an object with leases[]`);
    }
    for (const lease of Array.isArray(leaseAggregate?.leases) ? leaseAggregate.leases : []) {
        if (lease?.ownerId === owner && String(lease?.deviceId || "").startsWith(definition.devicePrefix)) {
            residue.push(`physical-lease-aggregate:${leaseAggregatePath}:${lease.deviceId}`);
        }
    }

    if (target === "windows-sandbox") {
        const lockPath = join(root, "host-locks", "windows-sandbox.json");
        const lockMetadata = readOptionalJson(lockPath, "Windows Sandbox host lock");
        const lock = lockMetadata.value;
        if (lockMetadata.exists && (!lock || typeof lock !== "object" || typeof lock.ownerId !== "string" || typeof lock.deviceId !== "string")) {
            throw new Error(`Windows Sandbox host lock metadata malformed at ${lockPath}: expected ownerId and deviceId strings`);
        }
        if (lock?.ownerId === owner && String(lock?.deviceId || "").startsWith(definition.devicePrefix)) {
            residue.push(`host-lock:${lockPath}`);
        }
    }
    if (target === "android-emulator") {
        const testAvdPrefix = `ccc-${owner}-real-android-e2e-`;
        const names = (options.listAndroidAvds || listAndroidAvdNames)(options.androidAvdOptions || {});
        for (const name of names) {
            if (name.startsWith(testAvdPrefix)) residue.push(`sdk-avd:${name}`);
        }
        const artifactNames = (options.listAndroidAvdArtifacts || listAndroidE2EAvdArtifactNames)({
            ...(options.androidAvdArtifactOptions || {}),
            home,
            owner,
        });
        for (const name of artifactNames) {
            if (name.startsWith(testAvdPrefix) && !names.includes(name)) residue.push(`sdk-avd-artifact:${name}`);
        }
    }
    if (hyperVTarget) {
        const inventory = (options.listHyperVVms || listHyperVVmInventory)(options.hyperVOptions || {});
        for (const vm of inventory) {
            const classification = classifyHyperVVm(vm, owner, definition);
            if (classification.ownership === "ambiguous") {
                residue.push(`ambiguous-host-vm:${vm.name || classification.deviceId}`);
                continue;
            }
            if (classification.ownership === "owned") {
                testDeviceIds.add(classification.deviceId);
                residue.push(`host-vm:${vm.name}`);
                for (const diskPath of vm.diskPaths || []) residue.push(`host-vm-disk:${vm.name}:${diskPath}`);
                for (const checkpoint of vm.checkpoints || []) residue.push(`host-vm-checkpoint:${vm.name}:${checkpoint}`);
            }
        }
        const operationRoot = join(backendRoot, "operations");
        const operationEntries = listOptionalDirectory(operationRoot, "Hyper-V operation lock");
        for (const deviceId of testDeviceIds) {
            const prefix = `${hyperVOperationLockKey(deviceId)}.lock`;
            for (const entry of operationEntries.filter((candidate) => candidate.startsWith(prefix))) {
                residue.push(`operation-lock:${join(operationRoot, entry)}:${deviceId}`);
            }
        }
        const mutationLocks = listOptionalDirectory(backendRoot, "Hyper-V mutation lock")
            .filter((entry) => entry.startsWith("devices.mutation.lock"));
        if (testDeviceIds.size > 0) {
            const hasForeignState = (state?.devices || []).some((device) => !String(device?.id || "").startsWith(definition.devicePrefix));
            for (const entry of mutationLocks) {
                residue.push(`${hasForeignState ? "ambiguous-mutation-lock" : "mutation-lock"}:${join(backendRoot, entry)}`);
            }
        }

        const networkInventory = (options.listHyperVNetworks || listHyperVNetworkInventory)(options.hyperVNetworkOptions || options.hyperVOptions || {});
        const switches = networkInventory?.switches;
        const namedSwitches = Array.isArray(switches) ? switches.filter((item) => item.name === HYPER_V_NETWORK.switchName) : [];
        const networkIdentity = hyperVNetworkState || hyperVNetworkIntent;
        const expectedMarker = networkIdentity?.marker || HYPER_V_NETWORK.switchMarker;
        const expectedNatName = networkIdentity?.natName || HYPER_V_NETWORK.natName;
        const ownedSwitches = namedSwitches.filter((item) => item.notes === expectedMarker
            && item.type === "Internal"
            && (!hyperVNetworkState || item.id === hyperVNetworkState.switchId.toLowerCase()));
        if (namedSwitches.length > 0 && ownedSwitches.length !== 1) {
            residue.push(`ambiguous-host-network-switch:${HYPER_V_NETWORK.switchName}`);
        }
        const hasNonTargetAllocation = (hyperVNetworkState?.allocations || []).some((allocation) =>
            allocation.ownerId !== owner || !allocation.deviceId.startsWith(definition.devicePrefix));
        if (ownedSwitches.length === 1 && !hasNonTargetAllocation && !hyperVNetworkIntent) {
            residue.push(`host-network-switch:${ownedSwitches[0].name}`);
            const matchingNats = Array.isArray(networkInventory?.nats)
                ? networkInventory.nats.filter((item) => item.name === expectedNatName
                    && item.prefix === HYPER_V_NETWORK.prefix
                    && hyperVNetworkState?.managedNat === true
                    && item.instanceId === hyperVNetworkState.natInstanceId)
                : [];
            if (matchingNats.length === 1) residue.push(`host-network-nat:${matchingNats[0].name}`);
            else if (Array.isArray(networkInventory?.nats) && networkInventory.nats.some((item) => item.name === expectedNatName)) {
                residue.push(`ambiguous-host-network-nat:${expectedNatName}`);
            }
            const alias = `vEthernet (${HYPER_V_NETWORK.switchName})`;
            for (const address of Array.isArray(networkInventory?.addresses) ? networkInventory.addresses : []) {
                if (address.interfaceAlias === alias && address.address === HYPER_V_NETWORK.gateway
                    && address.prefixLength === HYPER_V_NETWORK.prefixLength) {
                    residue.push(`host-network-address:${alias}:${address.address}/${address.prefixLength}`);
                }
            }
        }
    }
    return residue;
}

export function recoverHyperVPrivateResidue(target, options = {}) {
    const definition = REAL_PROVIDER_TARGETS[target];
    if (!definition || (target !== "windows-vm" && target !== "linux-vm")) {
        throw new Error(`Hyper-V private residue recovery does not support target: ${target}`);
    }
    const home = options.home || homedir();
    const owner = options.owner || currentOwnerId();
    const backendRoot = resolve(home, ".ccc", "device-broker-private", "owners", owner, definition.backendState);
    if (!existsSync(backendRoot)) return { privateArtifacts: 0 };
    const rootMetadata = lstatSync(backendRoot);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
        throw new Error(`Hyper-V private residue root is not a stable directory: ${backendRoot}`);
    }
    let privateArtifacts = 0;
    for (const entry of listOptionalDirectory(backendRoot, "Hyper-V private artifact")) {
        if (!entry.startsWith(definition.devicePrefix)) continue;
        const path = resolve(backendRoot, entry);
        if (dirname(path) !== backendRoot) throw new Error(`refusing Hyper-V private residue path outside root: ${path}`);
        const metadata = lstatSync(path);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
            throw new Error(`refusing non-directory Hyper-V private residue: ${path}`);
        }
        rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        if (existsSync(path)) throw new Error(`Hyper-V private residue remained after cleanup: ${path}`);
        privateArtifacts += 1;
    }
    return { privateArtifacts };
}

export function snapshotTestTempArtifacts(target, options = {}) {
    const definition = REAL_PROVIDER_TARGETS[target];
    const roots = [options.tempRoot || tmpdir()];
    if (target === "android-device") roots.push(join(options.repoRoot || repoRoot, "results", "device-lab-real"));
    const paths = new Set();
    for (const root of roots) {
        for (const prefix of definition.tempPrefixes) {
            for (const path of matchingEntries(root, prefix)) paths.add(path);
        }
    }
    return paths;
}

export function cleanupTestTempArtifacts(target, paths, options = {}) {
    const definition = REAL_PROVIDER_TARGETS[target];
    if (!definition) throw new Error(`unknown target: ${target}`);
    const allowedRoots = [resolve(options.tempRoot || tmpdir())];
    if (target === "android-device") allowedRoots.push(resolve(options.repoRoot || repoRoot, "results", "device-lab-real"));
    for (const path of paths) {
        const resolved = resolve(path);
        const allowedRoot = allowedRoots.find((root) => dirname(resolved) === root);
        const name = allowedRoot ? resolved.slice(allowedRoot.length + 1) : "";
        if (!allowedRoot || !definition.tempPrefixes.some((prefix) => name.startsWith(prefix))) {
            throw new Error(`refusing to remove unverified test artifact: ${path}`);
        }
        rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        if (existsSync(resolved)) throw new Error(`test artifact remained after cleanup: ${resolved}`);
    }
}

function androidDeviceRecoveryState(options = {}) {
    const home = options.home || homedir();
    const owner = options.owner || currentOwnerId();
    const definition = REAL_PROVIDER_TARGETS["android-device"];
    const backendRoot = join(home, ".ccc", "devices", "owners", owner, definition.backendState);
    const statePath = join(backendRoot, "devices.json");
    const metadata = readOptionalJson(statePath, "device state");
    if (metadata.exists && (!metadata.value || typeof metadata.value !== "object" || !Array.isArray(metadata.value.devices))) {
        throw new Error(`device state metadata malformed at ${statePath}: expected an object with devices[]`);
    }
    return {
        home,
        owner,
        backendRoot,
        devicePrefix: definition.devicePrefix,
        devices: (metadata.value?.devices || []).filter((device) => String(device?.id || "").startsWith(definition.devicePrefix)),
    };
}

function physicalLeaseExpired(lease, nowMs = Date.now()) {
    if (typeof lease?.expiresAt === "string" && !Number.isNaN(Date.parse(lease.expiresAt))) {
        return Date.parse(lease.expiresAt) <= nowMs;
    }
    const updatedAt = typeof lease?.updatedAt === "string" ? Date.parse(lease.updatedAt) : Number.NaN;
    const ttlMs = Number.isInteger(lease?.ttlMs) && lease.ttlMs > 0 ? lease.ttlMs : 60 * 60 * 1000;
    return Number.isFinite(updatedAt) && updatedAt + ttlMs <= nowMs;
}

async function detachAndroidPhysicalRecoveryDevice(device) {
    const result = await handleAndroidRealTool("device_detach", { deviceId: device.id });
    const payload = parseBackendResult(result, `Android physical recovery detach ${device.id}`);
    if (payload.detached !== device.id || payload.physicalDevicePoweredOff !== false) {
        throw new Error(`Android physical recovery detach ${device.id} was not verified`);
    }
}

export async function recoverAndroidPhysicalDeviceResidue(options = {}) {
    const initial = androidDeviceRecoveryState(options);
    const detachStateDevice = options.detachStateDevice || detachAndroidPhysicalRecoveryDevice;
    const readLeases = options.readLeases || readPhysicalLeases;
    const initialLeases = readLeases("android-device");
    for (const device of initial.devices) {
        if (device.ownerId && device.ownerId !== initial.owner) {
            throw new Error(`refusing Android physical recovery for foreign owner device ${device.id}`);
        }
        if (device.backend !== "android-device" || typeof device.serial !== "string" || !device.serial) {
            throw new Error(`refusing Android physical recovery for unverified device ${device.id}`);
        }
        const matchingLeases = initialLeases.filter((lease) => lease?.ownerId === initial.owner
            && lease?.hardwareId === device.serial
            && lease?.deviceId === device.id
            && lease?.claimId === device.leaseClaimId
            && lease?.claimNonce === device.leaseClaimNonce);
        if (matchingLeases.length !== 1 || !physicalLeaseExpired(matchingLeases[0], options.nowMs)) {
            throw new Error(`refusing Android physical recovery for active or ambiguous device lease ${device.id}`);
        }
        await detachStateDevice(device);
    }
    const afterDetach = androidDeviceRecoveryState(options);
    if (afterDetach.devices.length > 0) {
        throw new Error(`Android physical recovery device state remained: ${afterDetach.devices.map((device) => device.id).join(", ")}`);
    }

    const releaseResidue = options.releaseLeaseResidue || releaseOwnedPhysicalLeaseResidue;
    const allowActiveAggregateOrphans = options.allowActiveAggregateOrphans === true;
    const leases = readLeases("android-device").filter((lease) => lease?.ownerId === initial.owner
        && String(lease?.deviceId || "").startsWith(initial.devicePrefix));
    for (const lease of leases) {
        if (lease.backend !== "android-device" || typeof lease.hardwareId !== "string" || !lease.hardwareId) {
            throw new Error(`refusing Android physical recovery for unverified lease ${lease.deviceId}`);
        }
        const released = releaseResidue("android-device", {
            hardwareId: lease.hardwareId,
            deviceId: lease.deviceId,
            ...(lease.claimId ? { claimId: lease.claimId } : {}),
            ...(lease.claimNonce ? { claimNonce: lease.claimNonce } : {}),
        }, allowActiveAggregateOrphans
            ? { requireLockAbsent: true }
            : { requireExpired: true });
        if (!released?.ok) throw new Error(`Android physical recovery lease ${lease.deviceId} was not released: ${released?.error || "unknown error"}`);
    }

    const artifacts = matchingEntries(initial.backendRoot, initial.devicePrefix);
    for (const path of artifacts) {
        const metadata = lstatSync(path);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
            throw new Error(`refusing to remove unverified Android physical recovery artifact: ${path}`);
        }
        rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        if (existsSync(path)) throw new Error(`Android physical recovery owner artifact remained: ${path}`);
    }
    const tempArtifacts = [...(options.snapshotTempArtifacts || snapshotTestTempArtifacts)("android-device", options)];
    (options.cleanupTempArtifacts || cleanupTestTempArtifacts)("android-device", tempArtifacts, options);
    return { devices: initial.devices.length, leases: leases.length, ownerArtifacts: artifacts.length, tempArtifacts: tempArtifacts.length };
}

function androidRecoveryPaths(options = {}) {
    const home = options.home || homedir();
    const owner = options.owner || currentOwnerId();
    const backendRoot = join(home, ".ccc", "devices", "owners", owner, "android");
    return {
        home,
        owner,
        backendRoot,
        statePath: join(backendRoot, "devices.json"),
        devicePrefix: REAL_PROVIDER_TARGETS["android-emulator"].devicePrefix,
        avdPrefix: `ccc-${owner}-real-android-e2e-`,
    };
}

function androidRecoveryState(options = {}) {
    const paths = androidRecoveryPaths(options);
    const metadata = readOptionalJson(paths.statePath, "device state");
    if (metadata.exists && (!metadata.value || typeof metadata.value !== "object" || !Array.isArray(metadata.value.devices))) {
        throw new Error(`device state metadata malformed at ${paths.statePath}: expected an object with devices[]`);
    }
    return {
        ...paths,
        devices: (metadata.value?.devices || []).filter((device) => String(device?.id || "").startsWith(paths.devicePrefix)),
    };
}

function parseBackendResult(result, operation) {
    const text = String(result?.content?.[0]?.text || "").trim();
    if (!result || result.isError === true) throw new Error(`${operation} failed: ${text || "empty backend response"}`);
    try {
        return JSON.parse(text || "{}");
    } catch {
        throw new Error(`${operation} returned invalid JSON`);
    }
}

async function deleteAndroidRecoveryStateDevice(device) {
    const result = await handleAndroidTool("device_delete", {
        deviceId: device.id,
        force: true,
        deleteAvd: true,
    });
    const payload = parseBackendResult(result, `Android recovery delete ${device.id}`);
    if (payload.deleted !== device.id || payload.avdDeleted !== true) {
        throw new Error(`Android recovery delete ${device.id} was not verified`);
    }
}

export function listRunningAndroidAvdNames(options = {}) {
    const adb = options.adb || androidDiscovery().adb;
    if (!adb) throw new Error("Android emulator runtime inspection unavailable: missing adb");
    const spawnImpl = options.spawnSyncImpl || spawnSync;
    const inventory = spawnImpl(adb, ["devices"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
    });
    if (inventory.status !== 0) throw new Error(`Android emulator runtime inspection failed: ${cleanupCommandError(inventory)}`);
    const emulatorLines = String(inventory.stdout || "").split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^emulator-\d+\s+/.test(line));
    const unavailable = emulatorLines.filter((line) => !/^emulator-\d+\s+device\b/.test(line));
    if (unavailable.length > 0) throw new Error(`Android emulator runtime inspection found unavailable targets: ${unavailable.join(", ")}`);
    const serials = emulatorLines.map((line) => /^(emulator-\d+)/.exec(line)[1]);
    const names = [];
    for (const serial of serials) {
        const result = spawnImpl(adb, ["-s", serial, "emu", "avd", "name"], {
            encoding: "utf8",
            windowsHide: true,
            timeout: 30_000,
            maxBuffer: 1024 * 1024,
        });
        if (result.status !== 0) throw new Error(`Android emulator ${serial} identity inspection failed: ${cleanupCommandError(result)}`);
        const name = String(result.stdout || "").split(/\r?\n/).map((line) => line.trim()).find((line) => line && line !== "OK");
        if (!name) throw new Error(`Android emulator ${serial} identity inspection returned no AVD name`);
        if (names.includes(name)) throw new Error(`Android emulator AVD identity is duplicated: ${name}`);
        names.push(name);
    }
    return names;
}

export function deleteAndroidAvdName(name, options = {}) {
    const avdmanager = options.avdmanager || androidDiscovery().avdmanager;
    if (!avdmanager) throw new Error("Android AVD deletion unavailable: missing avdmanager");
    const invocation = androidAvdManagerInvocation(avdmanager, ["delete", "avd", "--name", name], options.platform || process.platform);
    const result = (options.spawnSyncImpl || spawnSync)(invocation.command, invocation.args, {
        encoding: "utf8",
        windowsHide: true,
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
    });
    const cleanup = (options.removeAndroidAvdArtifacts || removeOwnedAndroidAvdArtifacts)(
        name,
        options.owner || currentOwnerId(),
        options,
    );
    if (result.status !== 0 && cleanup.removed === 0) {
        throw new Error(`Android AVD deletion failed for ${name}: ${cleanupCommandError(result)}`);
    }
    return { commandStatus: result.status, artifactsRemoved: cleanup.removed };
}

export async function recoverAndroidEmulatorResidue(options = {}) {
    const initial = androidRecoveryState(options);
    const deleteStateDevice = options.deleteStateDevice || deleteAndroidRecoveryStateDevice;
    const listAvds = options.listAndroidAvds || (() => listAndroidAvdNames(options.androidAvdOptions || {}));
    const listArtifactAvds = options.listAndroidAvdArtifacts || (() => listAndroidE2EAvdArtifactNames({
        ...(options.androidAvdArtifactOptions || {}),
        home: initial.home,
        owner: initial.owner,
    }));
    const listRunningAvds = options.listRunningAndroidAvds || (() => listRunningAndroidAvdNames(options.androidRuntimeOptions || {}));
    const deleteAvd = options.deleteAndroidAvd || ((name) => deleteAndroidAvdName(name, options.androidAvdOptions || {}));
    for (const device of initial.devices) {
        if (device.ownerId && device.ownerId !== initial.owner) {
            throw new Error(`refusing Android recovery for foreign owner device ${device.id}`);
        }
        const suffix = String(device.id).slice(initial.devicePrefix.length);
        if (device.backend !== "android-emulator" || !suffix || device.avdName !== `${initial.avdPrefix}${suffix}`) {
            throw new Error(`refusing Android recovery for unverified AVD on ${device.id}`);
        }
        await deleteStateDevice(device);
    }

    const afterStateDelete = androidRecoveryState(options);
    if (afterStateDelete.devices.length > 0) {
        throw new Error(`Android recovery device state remained: ${afterStateDelete.devices.map((device) => device.id).join(", ")}`);
    }
    const orphanAvds = [...new Set([
        ...listAvds(),
        ...listArtifactAvds(),
    ])].filter((name) => name.startsWith(initial.avdPrefix));
    if (orphanAvds.length > 0) {
        const running = new Set(listRunningAvds());
        const active = orphanAvds.filter((name) => running.has(name));
        if (active.length > 0) throw new Error(`refusing to delete active orphan Android test AVDs: ${active.join(", ")}`);
        for (const name of orphanAvds) deleteAvd(name);
    }
    const remainingAvds = [...new Set([
        ...listAvds(),
        ...listArtifactAvds(),
    ])].filter((name) => name.startsWith(initial.avdPrefix));
    if (remainingAvds.length > 0) throw new Error(`Android recovery AVDs remained: ${remainingAvds.join(", ")}`);

    const artifacts = matchingEntries(initial.backendRoot, initial.devicePrefix);
    for (const path of artifacts) {
        const metadata = lstatSync(path);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
            throw new Error(`refusing to remove unverified Android recovery artifact: ${path}`);
        }
        rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        if (existsSync(path)) throw new Error(`Android recovery owner artifact remained: ${path}`);
    }
    const tempArtifacts = [...(options.snapshotTempArtifacts || snapshotTestTempArtifacts)("android-emulator", options)];
    (options.cleanupTempArtifacts || cleanupTestTempArtifacts)("android-emulator", tempArtifacts, options);
    return { devices: initial.devices.length, avds: orphanAvds.length, ownerArtifacts: artifacts.length, tempArtifacts: tempArtifacts.length };
}

export function realProviderCycleCommand(target) {
    const definition = REAL_PROVIDER_TARGETS[target];
    if (!definition) throw new Error(`unknown target: ${target}`);
    return {
        command: process.execPath,
        args: [realTestRunner, "--compact", "--fail-on-skip", resolve(repoRoot, definition.module)],
    };
}

function appendBounded(current, chunk) {
    const combined = Buffer.from(`${current}${chunk}`);
    return combined.length <= OUTPUT_LIMIT_BYTES
        ? combined.toString("utf8")
        : combined.subarray(combined.length - OUTPUT_LIMIT_BYTES).toString("utf8");
}

function cleanupCommandError(result) {
    return result.error?.message || String(result.stderr || result.stdout || `status ${result.status}`).trim();
}

function residueKind(item) {
    const separator = String(item).indexOf(":");
    return separator > 0 ? String(item).slice(0, separator) : "other";
}

const HYPER_V_PROVIDER_RECOVERABLE_RESIDUE = new Set([
    "device-state",
    "owner-artifact",
    "private-artifact",
    "vhdx",
    "network-allocation",
    "host-vm",
    "host-vm-disk",
    "host-vm-checkpoint",
    "host-network-switch",
    "host-network-nat",
    "host-network-address",
]);

function hyperVProviderCanRecover(items) {
    return items.some((item) => residueKind(item) === "device-state")
        && items.every((item) => HYPER_V_PROVIDER_RECOVERABLE_RESIDUE.has(residueKind(item)));
}

function compactResidueItem(item) {
    const text = String(item);
    const separator = text.indexOf(":");
    if (separator < 0) return text;
    const kind = text.slice(0, separator);
    const value = text.slice(separator + 1);
    if (kind === "host-vm-disk") {
        const pathSeparator = value.indexOf(":");
        const vmName = pathSeparator >= 0 ? value.slice(0, pathSeparator) : value;
        const path = pathSeparator >= 0 ? value.slice(pathSeparator + 1) : "";
        const leaf = path.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || path;
        return `${kind}:${vmName}:${leaf}`;
    }
    if (!kind.endsWith("artifact") && !kind.includes("lease") && !kind.includes("lock") && kind !== "vhdx") return text;
    const leaf = value.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || value;
    return `${kind}:${leaf}`;
}

export function formatResidueSummary(items, inlineLimit = RESIDUE_INLINE_LIMIT) {
    const entries = [...items].map(String);
    if (entries.length <= inlineLimit) return entries.map((entry) => {
        const kind = residueKind(entry);
        return kind === "host-vm-disk" || kind === "vhdx" || kind.includes("lock") ? compactResidueItem(entry) : entry;
    }).join(", ");
    const counts = new Map();
    const examples = new Map();
    for (const entry of entries) {
        const kind = residueKind(entry);
        counts.set(kind, (counts.get(kind) || 0) + 1);
        if (!examples.has(kind)) examples.set(kind, compactResidueItem(entry));
    }
    return `${entries.length} items (${[...counts].map(([kind, count]) => `${kind}=${count}`).join(", ")}); examples: ${[...examples.values()].join(", ")}`;
}

export function writeResidueDiagnostic(context, items, options = {}) {
    const root = options.root || join(tmpdir(), "ccc-device-lab-durability");
    mkdirSync(root, { recursive: true });
    const target = String(context.target || "unknown").replace(/[^a-z0-9_-]/gi, "-");
    const phase = String(context.phase || "unknown").replace(/[^a-z0-9_-]/gi, "-");
    const path = join(root, `residue-${target}-${phase}-latest.json`);
    writeFileSync(path, `${JSON.stringify({
        generatedAt: new Date().toISOString(),
        target: context.target,
        cycle: context.cycle,
        phase: context.phase,
        items: [...items],
    }, null, 2)}\n`);
    return path;
}

function residueFailureDetail(label, context, items, writer) {
    let report;
    try {
        report = writer(context, items);
    } catch (error) {
        report = `unavailable (${error.message})`;
    }
    return `${label}: ${formatResidueSummary(items)}; details: ${report}`;
}

export async function terminateTimedOutProcessTree(child, rootIdentity, registry, options = {}) {
    const platform = options.platform || process.platform;
    const snapshot = options.snapshot || processIdentitySnapshot;
    const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
    const killImpl = options.killImpl || process.kill.bind(process);
    const sleep = options.sleep || ((milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)));
    const verificationTimeoutMs = options.verificationTimeoutMs ?? 5000;
    const errors = [];
    try {
        sampleOwnedProcessIdentities(rootIdentity, registry, snapshot());
    } catch (error) {
        errors.push(`identity sampling failed: ${error.message}`);
    }

    let currentSnapshot;
    try {
        currentSnapshot = snapshot();
    } catch (error) {
        return { ok: false, errors: [...errors, `identity verification failed: ${error.message}`], survivors: [] };
    }
    const currentRoot = identityForPid(rootIdentity.pid, currentSnapshot);
    if (currentRoot && !sameProcessIdentity(rootIdentity, currentRoot)) {
        errors.push(`root PID ${rootIdentity.pid} was reused; cleanup signal was refused`);
    } else if (currentRoot) {
        if (platform === "win32") {
            const result = spawnSyncImpl("taskkill", ["/PID", String(rootIdentity.pid), "/T", "/F"], {
                encoding: "utf8",
                windowsHide: true,
                timeout: 10_000,
                maxBuffer: 1024 * 1024,
            });
            if (result.status !== 0) errors.push(`taskkill failed for ${rootIdentity.pid}: ${cleanupCommandError(result)}`);
        } else {
            try {
                killImpl(-rootIdentity.pid, "SIGKILL");
            } catch (error) {
                errors.push(`process-group SIGKILL failed for ${rootIdentity.pid}: ${error.code || error.message}`);
            }
        }
    }

    let survivors = [];
    const deadline = Date.now() + verificationTimeoutMs;
    do {
        try {
            survivors = liveOwnedProcessIdentities(registry, snapshot());
        } catch (error) {
            errors.push(`survivor verification failed: ${error.message}`);
            break;
        }
        if (survivors.length === 0 || Date.now() >= deadline) break;
        await sleep(50);
    } while (true);

    for (const identity of survivors.filter((item) => item.pid !== rootIdentity.pid)) {
        let current;
        try {
            current = identityForPid(identity.pid, snapshot());
        } catch (error) {
            errors.push(`descendant ${identity.pid} identity verification failed: ${error.message}`);
            continue;
        }
        if (!sameProcessIdentity(identity, current)) continue;
        if (platform === "win32") {
            const result = spawnSyncImpl("taskkill", ["/PID", String(identity.pid), "/T", "/F"], {
                encoding: "utf8",
                windowsHide: true,
                timeout: 10_000,
                maxBuffer: 1024 * 1024,
            });
            if (result.status !== 0) errors.push(`taskkill failed for descendant ${identity.pid}: ${cleanupCommandError(result)}`);
        } else {
            try { killImpl(identity.pid, "SIGKILL"); } catch (error) {
                errors.push(`SIGKILL failed for descendant ${identity.pid}: ${error.code || error.message}`);
            }
        }
    }
    const finalDeadline = Date.now() + verificationTimeoutMs;
    do {
        try {
            survivors = liveOwnedProcessIdentities(registry, snapshot());
        } catch (error) {
            errors.push(`final survivor verification failed: ${error.message}`);
            break;
        }
        if (survivors.length === 0 || Date.now() >= finalDeadline) break;
        await sleep(50);
    } while (true);
    if (survivors.length > 0) errors.push(`survivors: ${describeProcessIdentities(survivors)}`);
    return { ok: errors.length === 0 && survivors.length === 0, errors, survivors };
}

export async function verifySuccessfulProcessTree(rootIdentity, registry, options = {}) {
    const snapshot = options.snapshot || processIdentitySnapshot;
    const sleep = options.sleep || ((milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)));
    const boundarySamples = options.boundarySamples ?? 3;
    const boundaryDelayMs = options.boundaryDelayMs ?? PROCESS_SAMPLE_INTERVAL_MS;
    const errors = [];

    for (let index = 0; index < boundarySamples; index += 1) {
        try {
            sampleOwnedProcessIdentities(rootIdentity, registry, snapshot());
        } catch (error) {
            errors.push(`success-boundary identity sampling failed: ${error.message}`);
            break;
        }
        if (index + 1 < boundarySamples) await sleep(boundaryDelayMs);
    }

    let survivors = [];
    try {
        survivors = liveOwnedProcessIdentities(registry, snapshot());
    } catch (error) {
        errors.push(`success-boundary survivor verification failed: ${error.message}`);
    }
    if (survivors.length > 0) errors.push(`survivors: ${describeProcessIdentities(survivors)}`);
    return { ok: errors.length === 0 && survivors.length === 0, errors, survivors };
}

export async function runCycle(target, timeout, spawnImpl = spawn, options = {}) {
    // Fail before spawning when the host cannot provide PID-reuse-safe identities.
    (options.processIdentitySnapshot || processIdentitySnapshot)();
    const spec = realProviderCycleCommand(target);
    const child = spawnImpl(spec.command, spec.args, {
        cwd: repoRoot,
        env: { ...process.env, CCC_TEST_LEVEL: "2", CCC_DEVICE_LAB_DURABILITY: "1" },
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
    });
    const rootIdentity = identityForPid(child.pid);
    if (!rootIdentity) throw new Error(`could not capture process identity for cycle runner PID ${child.pid}`);
    const processRegistry = new Map([[processIdentityKey(rootIdentity), rootIdentity]]);
    let samplingError = null;
    const sampleProcesses = () => {
        if (samplingError) return;
        try {
            sampleOwnedProcessIdentities(rootIdentity, processRegistry);
        } catch (error) {
            samplingError = error;
        }
    };
    sampleProcesses();
    const samplingTimer = setInterval(sampleProcesses, PROCESS_SAMPLE_INTERVAL_MS);
    samplingTimer.unref?.();
    let output = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
        sampleProcesses();
        output = appendBounded(output, chunk);
    });
    child.stderr?.on("data", (chunk) => {
        sampleProcesses();
        output = appendBounded(output, chunk);
    });
    return await new Promise((resolveRun) => {
        let settled = false;
        let timedOut = false;
        const settle = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearInterval(samplingTimer);
            resolveRun(result);
        };
        const timer = setTimeout(async () => {
            timedOut = true;
            let cleanup;
            try {
                cleanup = samplingError
                    ? { ok: false, errors: [`process sampling failed before timeout: ${samplingError.message}`], survivors: [] }
                    : await terminateTimedOutProcessTree(child, rootIdentity, processRegistry);
            } catch (error) {
                cleanup = { ok: false, errors: [`timeout cleanup threw: ${error.message}`], survivors: [] };
            }
            settle({ code: child.exitCode, signal: child.signalCode || "timeout", timedOut: true, cleanup, output: output.trim() });
        }, timeout);
        child.once("error", async (error) => {
            if (settled) return;
            sampleProcesses();
            let processTree;
            try {
                processTree = await terminateTimedOutProcessTree(child, rootIdentity, processRegistry);
                if (samplingError) {
                    processTree.ok = false;
                    processTree.errors.unshift(`process sampling failed after runner error: ${samplingError.message}`);
                }
            } catch (cleanupError) {
                processTree = { ok: false, errors: [`runner-error cleanup threw: ${cleanupError.message}`], survivors: [] };
            }
            settle({
                code: child.exitCode,
                signal: child.signalCode || "spawn-error",
                timedOut: false,
                processTree,
                cleanup: processTree,
                output: appendBounded(output, error.message).trim(),
            });
        });
        child.once("exit", async (code, signal) => {
            if (timedOut) return;
            clearTimeout(timer);
            sampleProcesses();
            let processTree;
            if (code === 0) {
                processTree = samplingError
                    ? { ok: false, errors: [`process sampling failed during successful cycle: ${samplingError.message}`], survivors: [] }
                    : await verifySuccessfulProcessTree(rootIdentity, processRegistry);
            } else {
                try {
                    processTree = await terminateTimedOutProcessTree(child, rootIdentity, processRegistry);
                    if (samplingError) {
                        processTree.ok = false;
                        processTree.errors.unshift(`process sampling failed during failed cycle: ${samplingError.message}`);
                    }
                } catch (error) {
                    processTree = { ok: false, errors: [`failed-cycle cleanup threw: ${error.message}`], survivors: [] };
                }
            }
            settle({ code, signal, timedOut, processTree, cleanup: code === 0 ? undefined : processTree, output: output.trim() });
        });
    });
}

export function runningWindowsSandboxSessions(options = {}) {
    if ((options.platform || process.platform) !== "win32") return [];
    const listed = (options.listSessions || listRunningWindowsSandboxSessions)(options.sessionOptions || {});
    if (!listed.ok) throw new Error(`could not verify existing Windows Sandbox sessions: ${listed.error || "wsb list failed"}`);
    return listed.ids;
}

function formatElapsed(milliseconds) {
    return `${(milliseconds / 1000).toFixed(1)}s`;
}

export async function main(args = process.argv.slice(2), dependencies = {}) {
    const options = parseRealProviderCycleArgs(args);
    if (options.help) {
        console.log(usage());
        return 0;
    }
    const definition = REAL_PROVIDER_TARGETS[options.target];
    const spec = realProviderCycleCommand(options.target);
    console.log(`REAL PROVIDER DURABILITY target=${options.target} cycles=${options.cycles} timeout=${formatElapsed(options.timeoutMs)}`);
    console.log(`WARNING ${definition.destructive}`);
    if (options.dryRun) {
        console.log(`DRY RUN ${spec.command} ${spec.args.join(" ")}`);
        return 0;
    }

    const inspectResidue = dependencies.inspectTestOwnedResidue || inspectTestOwnedResidue;
    const inspectArtifacts = dependencies.snapshotTestTempArtifacts || snapshotTestTempArtifacts;
    const cleanupArtifacts = dependencies.cleanupTestTempArtifacts || cleanupTestTempArtifacts;
    const inspectWindowsSessions = dependencies.runningWindowsSandboxSessions || runningWindowsSandboxSessions;
    const recordResidue = dependencies.writeResidueDiagnostic || writeResidueDiagnostic;
    const recoverAndroidResidue = dependencies.recoverAndroidEmulatorResidue || recoverAndroidEmulatorResidue;
    const recoverAndroidPhysicalResidue = dependencies.recoverAndroidPhysicalDeviceResidue || recoverAndroidPhysicalDeviceResidue;
    const recoverHyperVPrivate = dependencies.recoverHyperVPrivateResidue || recoverHyperVPrivateResidue;
    const snapshotHyperVIdentity = dependencies.snapshotHyperVHostIdentity || snapshotHyperVHostIdentity;
    let androidPhysicalSelected = false;
    for (let cycle = 1; cycle <= options.cycles; cycle += 1) {
        let beforeResidue = inspectResidue(options.target);
        let beforeArtifacts = [...inspectArtifacts(options.target)];
        if ((options.target === "windows-vm" || options.target === "linux-vm")
            && beforeResidue.length > 0
            && beforeResidue.every((item) => item.startsWith("private-artifact:"))
            && beforeArtifacts.length === 0) {
            const recovered = await recoverHyperVPrivate(options.target);
            beforeResidue = inspectResidue(options.target);
            if (beforeResidue.length > 0) {
                throw new Error(residueFailureDetail(
                    `Hyper-V private recovery did not clear residue before cycle ${cycle}`,
                    { target: options.target, cycle, phase: "recovery" },
                    beforeResidue,
                    recordResidue,
                ));
            }
            console.log(`RECOVER cycle=${cycle}/${options.cycles} Hyper-V private E2E residue cleared (${Number(recovered?.privateArtifacts) || 0} items)`);
        }
        if (options.target === "android-emulator" && (beforeResidue.length > 0 || beforeArtifacts.length > 0)) {
            const recovered = await recoverAndroidResidue();
            beforeResidue = inspectResidue(options.target);
            beforeArtifacts = [...inspectArtifacts(options.target)];
            if (beforeResidue.length > 0 || beforeArtifacts.length > 0) {
                const items = [...beforeResidue, ...beforeArtifacts.map((path) => `temp-artifact:${path}`)];
                throw new Error(residueFailureDetail(
                    `Android recovery did not clear residue before cycle ${cycle}`,
                    { target: options.target, cycle, phase: "recovery" },
                    items,
                    recordResidue,
                ));
            }
            const recoveredCount = Object.values(recovered || {}).reduce((total, value) => total + (Number(value) || 0), 0);
            console.log(`RECOVER cycle=${cycle}/${options.cycles} Android emulator E2E residue cleared (${recoveredCount} items)`);
        }
        if (options.target === "android-device" && (beforeResidue.length > 0 || beforeArtifacts.length > 0)) {
            const recovered = await recoverAndroidPhysicalResidue({ allowActiveAggregateOrphans: true });
            beforeResidue = inspectResidue(options.target);
            beforeArtifacts = [...inspectArtifacts(options.target)];
            if (beforeResidue.length > 0 || beforeArtifacts.length > 0) {
                const items = [...beforeResidue, ...beforeArtifacts.map((path) => `temp-artifact:${path}`)];
                throw new Error(residueFailureDetail(
                    `Android physical recovery did not clear residue before cycle ${cycle}`,
                    { target: options.target, cycle, phase: "recovery" },
                    items,
                    recordResidue,
                ));
            }
            const recoveredCount = Object.values(recovered || {}).reduce((total, value) => total + (Number(value) || 0), 0);
            console.log(`RECOVER cycle=${cycle}/${options.cycles} Android physical-device E2E residue cleared (${recoveredCount} items)`);
        }
        if (options.target === "android-device" && !androidPhysicalSelected) {
            const selection = (dependencies.configureAndroidPhysicalDevice || configureAndroidPhysicalDevice)(dependencies.env || process.env);
            console.log(`SELECT Android physical device serial=${selection.serial} source=${selection.source} candidates=${selection.candidates}`);
            androidPhysicalSelected = true;
        }
        if (options.target === "windows-sandbox" && beforeArtifacts.length > 0) {
            cleanupArtifacts(options.target, beforeArtifacts);
            beforeArtifacts = [...inspectArtifacts(options.target)];
        }
        const recoverableWindowsResidue = options.target === "windows-sandbox"
            && beforeResidue.length > 0
            && beforeArtifacts.length === 0;
        const recoverableHyperVResidue = (options.target === "windows-vm" || options.target === "linux-vm")
            && hyperVProviderCanRecover(beforeResidue)
            && beforeArtifacts.length === 0;
        if (definition.requireNoExistingWindowsSandbox) {
            const sessions = inspectWindowsSessions();
            if (sessions.length > 0 && !recoverableWindowsResidue) {
                throw new Error(`refusing cycle ${cycle}/${options.cycles} while a Windows Sandbox session is active (IDs: ${sessions.join(", ")})`);
            }
        }
        if ((beforeResidue.length > 0 && !recoverableWindowsResidue && !recoverableHyperVResidue) || beforeArtifacts.length > 0) {
            const items = [
                ...beforeResidue,
                ...beforeArtifacts.map((path) => `temp-artifact:${path}`),
            ];
            throw new Error(residueFailureDetail(
                `test-owned residue before cycle ${cycle}`,
                { target: options.target, cycle, phase: "preflight" },
                items,
                recordResidue,
            ));
        }
        if (recoverableWindowsResidue) {
            console.log(`RECOVER cycle=${cycle}/${options.cycles} Windows Sandbox E2E residue will be verified and cleaned by the provider test`);
        }
        if (recoverableHyperVResidue) {
            console.log(`RECOVER cycle=${cycle}/${options.cycles} Hyper-V ${options.target === "linux-vm" ? "Linux" : "Windows"} VM E2E residue will be verified and cleaned by the provider test`);
        }
        const hyperVIdentityOptions = { owner: currentOwnerId(), definition, home: homedir() };
        const hyperVIdentityBaseline = (options.target === "windows-vm" || options.target === "linux-vm")
            ? snapshotHyperVIdentity(hyperVIdentityOptions)
            : null;
        const started = Date.now();
        let result = null;
        const failures = [];
        try {
            result = await (dependencies.runCycle || runCycle)(options.target, options.timeoutMs);
        } catch (error) {
            failures.push(`cycle runner threw: ${error.message}`);
        }
        const elapsed = Date.now() - started;
        if (result?.timedOut) {
            const cleanup = result.cleanup || { ok: false, errors: ["cleanup result missing"], survivors: [] };
            const cleanupDetail = cleanup.ok
                ? "process tree terminated and verified"
                : `cleanup failed (${cleanup.errors.join("; ") || "unknown error"})`;
            failures.push(`timed out after ${formatElapsed(options.timeoutMs)}; ${cleanupDetail}`);
        }
        if (result && !result.timedOut && result.code !== 0) {
            failures.push(`failed with ${result.signal || `exit ${result.code}`}\n${result.output || "<no output>"}`);
        }
        if (result && !result.timedOut) {
            const processTree = result.processTree || {
                ok: false,
                errors: ["cycle process-tree verification result missing"],
                survivors: [],
            };
            if (!processTree.ok) {
                failures.push(`process-tree cleanup/verification failed: ${processTree.errors.join("; ") || "unknown error"}`);
            }
        }
        if (definition.requireNoExistingWindowsSandbox) {
            try {
                const sessions = inspectWindowsSessions();
                if (sessions.length > 0) failures.push(`Windows Sandbox session remained or appeared (IDs: ${sessions.join(", ")})`);
            } catch (error) {
                failures.push(`Windows Sandbox post-cycle inspection failed: ${error.message}`);
            }
        }
        try {
            let residue = inspectResidue(options.target);
            let artifacts = [...inspectArtifacts(options.target)];
            if (options.target === "android-device" && failures.length === 0 && (residue.length > 0 || artifacts.length > 0)) {
                const recovered = await recoverAndroidPhysicalResidue({ allowActiveAggregateOrphans: true });
                residue = inspectResidue(options.target);
                artifacts = [...inspectArtifacts(options.target)];
                if (residue.length === 0 && artifacts.length === 0) {
                    const recoveredCount = Object.values(recovered || {}).reduce((total, value) => total + (Number(value) || 0), 0);
                    console.log(`RECOVER cycle=${cycle}/${options.cycles} Android physical-device post-cycle residue cleared (${recoveredCount} items)`);
                }
            }
            if (residue.length > 0 || artifacts.length > 0) {
                failures.push(residueFailureDetail(
                    "leaked test-owned resources",
                    { target: options.target, cycle, phase: "post-cycle" },
                    [...residue, ...artifacts.map((path) => `temp-artifact:${path}`)],
                    recordResidue,
                ));
            }
        } catch (error) {
            failures.push(`post-cycle residue inspection failed: ${error.message}`);
        }
        if (hyperVIdentityBaseline) {
            try {
                assertHyperVHostIdentityUnchanged(hyperVIdentityBaseline, snapshotHyperVIdentity(hyperVIdentityOptions));
            } catch (error) {
                failures.push(error.message);
            }
        }
        if (failures.length > 0) {
            throw new Error(`cycle ${cycle}/${options.cycles} failed: ${failures.join("; ")}`);
        }
        console.log(`PASS cycle=${cycle}/${options.cycles} target=${options.target} duration=${formatElapsed(elapsed)}`);
    }
    console.log(`PASS real-provider durability target=${options.target} cycles=${options.cycles}`);
    return 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const args = process.argv.slice(2);
    const parsed = (() => {
        try { return parseRealProviderCycleArgs(args); } catch { return null; }
    })();
    const execute = () => main(args);
    const run = parsed?.help || parsed?.dryRun || process.env.CCC_REAL_PROVIDER_RUN_LOCK_HELD === "1"
        ? execute()
        : withExclusiveRealProviderRun(`real-provider durability (${parsed?.target || "unknown target"})`, execute);
    run.then((code) => { process.exitCode = code; }).catch((error) => {
        console.error(`FAIL ${error?.message || String(error)}`);
        process.exitCode = 1;
    });
}
