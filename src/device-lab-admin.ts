import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { homedir, hostname } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

export const DEVICE_BACKENDS = [
    { stateKey: "android", name: "android-emulator", tools: ["adb", "emulator", "avdmanager"] },
    { stateKey: "ios", name: "ios-simulator", tools: ["xcrun"] },
    { stateKey: "windows", name: "windows-sandbox", tools: ["wsb"] },
    { stateKey: "macos", name: "macos-vm", tools: ["tart", "vz", "utmctl"] },
] as const;

export function deviceLabOwnerId(cwd = process.cwd()): string {
    return createHash("sha256").update(`${hostname()}:${cwd || "/project"}`).digest("hex").slice(0, 16);
}

function ownerDevicesFile(ownerId: string, stateKey: string): string {
    return join(homedir(), ".ccc/devices/owners", ownerId, stateKey, "devices.json");
}

function readDevices(ownerId: string, stateKey: string): unknown[] {
    const file = ownerDevicesFile(ownerId, stateKey);
    if (!existsSync(file)) return [];
    try {
        const parsed = JSON.parse(readFileSync(file, "utf-8"));
        return Array.isArray(parsed.devices) ? parsed.devices : [];
    } catch {
        return [];
    }
}

function commandPath(command: string): string | null {
    const result = spawnSync("/bin/sh", ["-c", `command -v ${command}`], {
        encoding: "utf-8",
        env: process.env,
    });
    return result.status === 0 ? result.stdout.trim().split("\n")[0] : null;
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
        default:
            console.error("Usage: ccc devices <status|list|backends|doctor>");
            return 1;
    }
}
