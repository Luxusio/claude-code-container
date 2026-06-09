import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir, hostname } from "os";
import { dirname, join } from "path";
import { spawnSync } from "child_process";

export const DEVICE_BACKENDS = [
    { stateKey: "android", name: "android-emulator", tools: ["adb", "emulator", "avdmanager"] },
    { stateKey: "ios", name: "ios-simulator", tools: ["xcrun"] },
    { stateKey: "windows", name: "windows-sandbox", tools: ["wsb"] },
    { stateKey: "macos", name: "macos-vm", tools: ["tart", "vz", "utmctl"] },
] as const;

type Backend = typeof DEVICE_BACKENDS[number];
type DeviceRecord = Record<string, unknown> & { id?: string; status?: string };
type CommandResult = { command: string; status: number | null; stderr?: string; stdout?: string };
type OwnerDeviceMatch = { backend: Backend; devices: DeviceRecord[]; index: number; device: DeviceRecord };

export function deviceLabOwnerId(cwd = process.cwd()): string {
    return createHash("sha256").update(`${hostname()}:${cwd || "/project"}`).digest("hex").slice(0, 16);
}

function ownerDevicesFile(ownerId: string, stateKey: string): string {
    return join(homedir(), ".ccc/devices/owners", ownerId, stateKey, "devices.json");
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

function runCommand(command: string | null, args: string[]): CommandResult | null {
    if (!command) return null;
    const result = spawnSync(command, args, { encoding: "utf-8", env: process.env });
    return {
        command: [command, ...args].join(" "),
        status: result.status,
        stdout: result.stdout || "",
        stderr: result.stderr || result.error?.message || "",
    };
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

function stopOwnedDevice(match: OwnerDeviceMatch): CommandResult[] {
    const results: CommandResult[] = [];
    if (match.backend.stateKey === "android") {
        const adb = commandPath("adb");
        const serial = serialForAndroid(match.device);
        if (adb && serial) {
            const result = runCommand(adb, ["-s", serial, "emu", "kill"]);
            if (result) results.push(result);
        }
        killPid(match.device.pid);
        const appium = match.device.appium as { serverPid?: unknown } | null | undefined;
        if (appium) killPid(appium.serverPid);
    } else if (match.backend.stateKey === "ios") {
        const xcrun = commandPath("xcrun");
        const target = simctlTarget(match.device);
        if (xcrun && target) {
            const result = runCommand(xcrun, ["simctl", "shutdown", target]);
            if (result) results.push(result);
        }
        const appium = match.device.appium as { serverPid?: unknown } | null | undefined;
        if (appium) killPid(appium.serverPid);
    } else if (match.backend.stateKey === "windows") {
        const result = runCommand(commandPath("wsb"), ["stop"]);
        if (result) results.push(result);
    } else if (match.backend.stateKey === "macos") {
        const provider = typeof match.device.provider === "string" ? match.device.provider : null;
        const instance = typeof match.device.providerInstance === "string" ? match.device.providerInstance : null;
        if (provider && instance) {
            const args = stopMacosArgs(provider, instance);
            if (args) {
                const result = runCommand(commandPath(provider), args);
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
        updatedAt: now(),
    };
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
    const updated = stoppedDevice(match.device);
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
    if (match.device.status !== "stopped") {
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
            const prune = device.status === "stopped";
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
            console.error("Usage: ccc devices <status|list|backends|doctor|stop|delete|prune>");
            return 1;
    }
}
