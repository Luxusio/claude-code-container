import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { homedir, hostname } from "os";
import { dirname, join } from "path";
import { spawnSync } from "child_process";

export const DEVICE_BACKENDS = [
    { stateKey: "android", name: "android-emulator", tools: ["adb", "emulator", "avdmanager"] },
    { stateKey: "android-device", name: "android-device", tools: ["adb"] },
    { stateKey: "ios", name: "ios-simulator", tools: ["xcrun"] },
    { stateKey: "ios-device", name: "ios-device", tools: ["xcrun", "xcodebuild"] },
    { stateKey: "windows", name: "windows-sandbox", tools: ["wsb"] },
    { stateKey: "macos", name: "macos-vm", tools: ["tart", "vz", "utmctl"] },
] as const;

type Backend = typeof DEVICE_BACKENDS[number];
type DeviceRecord = Record<string, unknown> & { id?: string; status?: string };
type CommandResult = { command: string; status: number | null; stderr?: string; stdout?: string };
type OwnerDeviceMatch = { backend: Backend; devices: DeviceRecord[]; index: number; device: DeviceRecord };
type SmokeResult = { backend: string; status: "PASS" | "SKIP" | "FAIL"; detail: string; commands?: CommandResult[] };
type CleanupDeviceResult = { id: string; backend: string; previousStatus: string; status: "stopped" | "skipped"; commands: CommandResult[] };

export function deviceLabOwnerId(cwd = process.cwd()): string {
    return createHash("sha256").update(`${hostname()}:${cwd || "/project"}`).digest("hex").slice(0, 16);
}

function ownerDevicesFile(ownerId: string, stateKey: string): string {
    return join(homedir(), ".ccc/devices/owners", ownerId, stateKey, "devices.json");
}

function physicalLeaseLockFile(stateKey: string, hardwareId: string): string {
    return join(homedir(), ".ccc/devices/physical-leases", stateKey, "locks", `${encodeURIComponent(hardwareId)}.json`);
}

function readDevices(ownerId: string, stateKey: string): DeviceRecord[] {
    const file = ownerDevicesFile(ownerId, stateKey);
    if (!existsSync(file)) return [];
    try {
        const parsed = JSON.parse(readFileSync(file, "utf-8"));
        return Array.isArray(parsed.devices) ? parsed.devices : [];
    } catch {
        return [];
    }
}

function writeDevices(ownerId: string, stateKey: string, devices: DeviceRecord[]): void {
    const file = ownerDevicesFile(ownerId, stateKey);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ devices }, null, 2), { mode: 0o600 });
}

function commandPath(command: string): string | null {
    const result = process.platform === "win32"
        ? spawnSync("where", [command], { encoding: "utf-8", env: process.env })
        : spawnSync("/bin/sh", ["-c", `command -v ${command}`], {
            encoding: "utf-8",
            env: process.env,
        });
    return result.status === 0 ? result.stdout.trim().split("\n")[0] : null;
}

function runCommand(command: string | null, args: string[], timeoutMs?: number): CommandResult | null {
    if (!command) return null;
    const result = spawnSync(command, args, { encoding: "utf-8", env: process.env, timeout: timeoutMs });
    return {
        command: [command, ...args].join(" "),
        status: result.status,
        stdout: result.stdout || "",
        stderr: result.stderr || result.error?.message || "",
    };
}

function smokeCommand(command: string, args: string[], timeoutMs: number): CommandResult {
    return runCommand(command, args, timeoutMs) || {
        command: [command, ...args].join(" "),
        status: null,
        stderr: "command not found",
    };
}

function smokeFromCommands(backend: string, commands: Array<[string, string[]]>, detail: string, timeoutMs: number): SmokeResult {
    const results = commands.map(([command, args]) => smokeCommand(command, args, timeoutMs));
    const failed = results.find((result) => result.status !== 0);
    if (failed) {
        return {
            backend,
            status: "FAIL",
            detail: failed.stderr || failed.stdout || `command exited ${failed.status}`,
            commands: results,
        };
    }
    return { backend, status: "PASS", detail, commands: results };
}

export function deviceLabSmoke(cwd = process.cwd(), timeoutMs = 5000): { ownerId: string; results: SmokeResult[] } {
    const ownerId = deviceLabOwnerId(cwd);
    const tools = Object.fromEntries(
        DEVICE_BACKENDS.flatMap((backend) => backend.tools.map((tool) => [tool, commandPath(tool)])),
    ) as Record<string, string | null>;

    const results: SmokeResult[] = [];
    if (!tools.adb || !tools.emulator) {
        results.push({ backend: "android-emulator", status: "SKIP", detail: `missing ${["adb", "emulator"].filter((tool) => !tools[tool]).join(", ")}` });
    } else {
        results.push(smokeFromCommands("android-emulator", [[tools.adb, ["version"]], [tools.emulator, ["-list-avds"]]], "adb and emulator responded", timeoutMs));
    }
    if (!tools.adb) {
        results.push({ backend: "android-device", status: "SKIP", detail: "missing adb" });
    } else {
        results.push(smokeFromCommands("android-device", [[tools.adb, ["devices", "-l"]]], "adb physical-device inventory responded", timeoutMs));
    }

    if (!tools.xcrun) {
        results.push({ backend: "ios-simulator", status: "SKIP", detail: "missing xcrun" });
    } else {
        results.push(smokeFromCommands("ios-simulator", [[tools.xcrun, ["simctl", "list", "-j"]]], "xcrun simctl inventory responded", timeoutMs));
    }
    if (!tools.xcrun || !tools.xcodebuild) {
        results.push({ backend: "ios-device", status: "SKIP", detail: `missing ${["xcrun", "xcodebuild"].filter((tool) => !tools[tool]).join(", ")}` });
    } else {
        results.push(smokeFromCommands("ios-device", [[tools.xcrun, ["xctrace", "list", "devices"]], [tools.xcodebuild, ["-version"]]], "xcrun xctrace and xcodebuild responded", timeoutMs));
    }

    if (!tools.wsb) {
        results.push({ backend: "windows-sandbox", status: "SKIP", detail: "missing wsb" });
    } else {
        results.push(smokeFromCommands("windows-sandbox", [[tools.wsb, ["--help"]]], "wsb CLI responded", timeoutMs));
    }

    const macosProvider = tools.tart || tools.vz || tools.utmctl;
    if (!macosProvider) {
        results.push({ backend: "macos-vm", status: "SKIP", detail: "missing tart, vz, utmctl" });
    } else {
        results.push(smokeFromCommands("macos-vm", [[macosProvider, ["--version"]]], "macOS VM provider responded", timeoutMs));
    }

    return { ownerId, results };
}

function killPid(value: unknown): boolean {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return false;
    try {
        process.kill(value);
        return true;
    } catch {
        return false;
    }
}

function findOwnerDevice(ownerId: string, deviceId: string): OwnerDeviceMatch | null {
    for (const backend of DEVICE_BACKENDS) {
        const devices = readDevices(ownerId, backend.stateKey);
        const index = devices.findIndex((device) => device.id === deviceId);
        if (index >= 0) return { backend, devices, index, device: devices[index] };
    }
    return null;
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
    try {
        const lease = JSON.parse(readFileSync(file, "utf-8")) as { ownerId?: string; deviceId?: string };
        if (lease.ownerId === ownerId && (!device.id || !lease.deviceId || lease.deviceId === device.id)) unlinkSync(file);
    } catch {
        /* ignore missing, stale, or malformed physical lock files */
    }
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

function stopOwnedDevice(match: OwnerDeviceMatch, timeoutMs?: number): CommandResult[] {
    const results: CommandResult[] = [];
    killPid(match.device.pid);
    killPid(recordingPid(match.device));
    killPid(appiumServerPid(match.device));

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
            const result = runCommand(commandPath("wsb"), ["stop"], timeoutMs);
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
    return results;
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

function shouldCleanupDevice(backend: Backend, device: DeviceRecord): boolean {
    if ((backend.stateKey === "android-device" || backend.stateKey === "ios-device") && device.status === "attached") return true;
    return lifecycleActive(device) || hasVolatileProcessMetadata(device);
}

export function cleanupOwnerDevices(cwd = process.cwd(), timeoutMs = 5000): { ownerId: string; results: CleanupDeviceResult[] } {
    const ownerId = deviceLabOwnerId(cwd);
    const results: CleanupDeviceResult[] = [];
    for (const backend of DEVICE_BACKENDS) {
        const devices = readDevices(ownerId, backend.stateKey);
        let changed = false;
        const updated = devices.map((device) => {
            if (!device.id || !shouldCleanupDevice(backend, device)) {
                results.push({
                    id: device.id || "(unknown)",
                    backend: backend.name,
                    previousStatus: device.status || "unknown",
                    status: "skipped",
                    commands: [],
                });
                return device;
            }

            const commands = stopOwnedDevice({ backend, devices, index: -1, device }, timeoutMs);
            releasePhysicalLeaseForOwner(ownerId, backend, device);
            results.push({
                id: device.id,
                backend: backend.name,
                previousStatus: device.status || "unknown",
                status: "stopped",
                commands,
            });
            changed = true;
            return cleanedDevice(backend, device);
        });
        if (changed) writeDevices(ownerId, backend.stateKey, updated);
    }
    return { ownerId, results };
}

export function deviceLabSnapshot(cwd = process.cwd()) {
    const ownerId = deviceLabOwnerId(cwd);
    const backends = DEVICE_BACKENDS.map((backend) => {
        const devices = readDevices(ownerId, backend.stateKey);
        const tools = Object.fromEntries(backend.tools.map((tool) => [tool, commandPath(tool)]));
        const missing = backend.tools.filter((tool) => !tools[tool]);
        return {
            ...backend,
            devices,
            tools,
            missing,
            available: missing.length === 0,
        };
    });
    return { ownerId, backends };
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

export function stopOwnerDevice(deviceId: string, cwd = process.cwd()): { ok: boolean; text: string } {
    const ownerId = deviceLabOwnerId(cwd);
    const match = findOwnerDevice(ownerId, deviceId);
    if (!match) return { ok: false, text: `Device not found for owner ${ownerId}: ${deviceId}\n` };

    const commands = stopOwnedDevice(match);
    releasePhysicalLeaseForOwner(ownerId, match.backend, match.device);
    const updated = cleanedDevice(match.backend, match.device);
    const devices = [...match.devices];
    devices[match.index] = updated;
    writeDevices(ownerId, match.backend.stateKey, devices);

    const lines = [
        `stopped: ${deviceId}`,
        `backend: ${match.backend.name}`,
        `owner: ${ownerId}`,
    ];
    for (const result of commands) {
        lines.push(`command: ${result.command} -> ${result.status ?? "unknown"}`);
    }
    return { ok: true, text: `${lines.join("\n")}\n` };
}

export function deleteOwnerDevice(deviceId: string, cwd = process.cwd()): { ok: boolean; text: string } {
    const ownerId = deviceLabOwnerId(cwd);
    const match = findOwnerDevice(ownerId, deviceId);
    if (!match) return { ok: false, text: `Device not found for owner ${ownerId}: ${deviceId}\n` };
    if (match.device.status !== "stopped" && match.device.status !== "detached") {
        return { ok: false, text: `Refusing to delete ${deviceId} while status is ${match.device.status || "unknown"}; run 'ccc devices stop ${deviceId}' first.\n` };
    }

    const remaining = match.devices.filter((device) => device.id !== deviceId);
    writeDevices(ownerId, match.backend.stateKey, remaining);
    return { ok: true, text: `deleted: ${deviceId}\nbackend: ${match.backend.name}\nowner: ${ownerId}\n` };
}

export function pruneOwnerDevices(cwd = process.cwd()): { ok: boolean; text: string } {
    const ownerId = deviceLabOwnerId(cwd);
    const lines = [`owner: ${ownerId}`];
    let deleted = 0;
    for (const backend of DEVICE_BACKENDS) {
        const devices = readDevices(ownerId, backend.stateKey);
        const remaining = devices.filter((device) => {
            const prune = device.status === "stopped" || device.status === "detached";
            if (prune) {
                deleted += 1;
                lines.push(`pruned: ${device.id || "(unknown)"}  backend=${backend.name}`);
            }
            return !prune;
        });
        if (remaining.length !== devices.length) writeDevices(ownerId, backend.stateKey, remaining);
    }
    if (deleted === 0) lines.push("pruned: 0");
    return { ok: true, text: `${lines.join("\n")}\n` };
}

export function formatDevicesStatus(cwd = process.cwd()): string {
    const snapshot = deviceLabSnapshot(cwd);
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

export function formatDevicesList(cwd = process.cwd()): string {
    const snapshot = deviceLabSnapshot(cwd);
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

export function formatDevicesBackends(cwd = process.cwd()): string {
    const snapshot = deviceLabSnapshot(cwd);
    const lines = [
        "=== CCC Device Backends ===",
        "",
        `owner: ${snapshot.ownerId}`,
        "",
    ];
    for (const backend of snapshot.backends) {
        lines.push(`${backend.name}:`);
        lines.push(`  status: ${backend.available ? "available" : "missing-prerequisites"}`);
        for (const [tool, path] of Object.entries(backend.tools)) {
            lines.push(`  ${tool}: ${path || "missing"}`);
        }
    }
    return `${lines.join("\n")}\n`;
}

export function formatDevicesDoctor(cwd = process.cwd()): string {
    const snapshot = deviceLabSnapshot(cwd);
    const lines = [
        "=== CCC Devices Doctor ===",
        "",
        `owner: ${snapshot.ownerId}`,
        "",
        "Device-lab MCP: managed by CCC when containers are started",
        "Startup policy: lazy; these diagnostics do not start devices",
        "",
    ];
    for (const backend of snapshot.backends) {
        if (backend.available) {
            lines.push(`${backend.name}: ok`);
        } else {
            lines.push(`${backend.name}: missing ${backend.missing.join(", ")}`);
        }
    }
    return `${lines.join("\n")}\n`;
}

export function formatDevicesSmoke(cwd = process.cwd(), timeoutMs = 5000): string {
    const smoke = deviceLabSmoke(cwd, timeoutMs);
    const lines = [
        "=== CCC Devices Smoke ===",
        "",
        `owner: ${smoke.ownerId}`,
        "Startup policy: lazy; smoke checks do not start devices",
        "",
    ];
    for (const result of smoke.results) {
        lines.push(`${result.backend}: ${result.status} - ${result.detail}`);
        for (const command of result.commands || []) {
            lines.push(`  ${command.command} -> ${command.status ?? "unknown"}`);
        }
    }
    return `${lines.join("\n")}\n`;
}

export function devicesCli(args: string[], cwd = process.cwd()): number {
    const subcommand = args[0] || "status";
    switch (subcommand) {
        case "status":
            console.log(formatDevicesStatus(cwd));
            return 0;
        case "list":
            console.log(formatDevicesList(cwd));
            return 0;
        case "backends":
            console.log(formatDevicesBackends(cwd));
            return 0;
        case "doctor":
            console.log(formatDevicesDoctor(cwd));
            return 0;
        case "smoke":
            console.log(formatDevicesSmoke(cwd));
            return 0;
        case "stop": {
            const deviceId = args[1];
            if (!deviceId) {
                console.error("Usage: ccc devices stop <device-id>");
                return 1;
            }
            const result = stopOwnerDevice(deviceId, cwd);
            (result.ok ? console.log : console.error)(result.text);
            return result.ok ? 0 : 1;
        }
        case "delete": {
            const deviceId = args[1];
            if (!deviceId) {
                console.error("Usage: ccc devices delete <device-id>");
                return 1;
            }
            const result = deleteOwnerDevice(deviceId, cwd);
            (result.ok ? console.log : console.error)(result.text);
            return result.ok ? 0 : 1;
        }
        case "prune": {
            const result = pruneOwnerDevices(cwd);
            console.log(result.text);
            return 0;
        }
        default:
            console.error("Usage: ccc devices <status|list|backends|doctor|smoke|stop|delete|prune>");
            return 1;
    }
}
