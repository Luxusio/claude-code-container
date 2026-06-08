import { mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { commandPath, run } from "../commands.mjs";
import { ownerId, slug } from "../context.mjs";
import { fail, jsonResult, textResult } from "../responses.mjs";
import { findWindowsDevice, readWindowsDevices, updateWindowsDevice, writeWindowsDevices } from "../state/windows-state.mjs";

export function windowsDiscovery() {
    const wsb = commandPath("wsb");
    const missing = [];
    if (!wsb) missing.push("wsb");
    return {
        wsb,
        available: missing.length === 0,
        missing,
    };
}

export function windowsBackend() {
    const discovery = windowsDiscovery();
    return {
        name: "windows-sandbox",
        host: "windows-host",
        creatable: true,
        available: discovery.available,
        lazy: true,
        status: discovery.available ? "available" : "missing-prerequisites",
        missing: discovery.missing,
        tools: { wsb: discovery.wsb },
        capabilities: [
            "device_create",
            "device_delete",
            "device_start",
            "device_stop",
            "device_status",
        ],
    };
}

function windowsDeviceId(name) {
    return `windows-${slug(name)}`;
}

function windowsScratchDir(device) {
    return join(homedir(), ".ccc/devices/owners", ownerId(), "windows", device.id);
}

function wsbConfigPath(device) {
    return join(windowsScratchDir(device), `${device.id}.wsb`);
}

function escapeXml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function writeWsbConfig(device) {
    const scratch = windowsScratchDir(device);
    mkdirSync(scratch, { recursive: true });
    const networking = device.networking === true ? "Enable" : "Disable";
    const clipboard = device.clipboard === true ? "Enable" : "Disable";
    const vgpu = device.vgpu === true ? "Enable" : "Disable";
    const memoryMb = device.memoryMb || 4096;
    const config = [
        "<Configuration>",
        `  <VGpu>${vgpu}</VGpu>`,
        `  <Networking>${networking}</Networking>`,
        `  <ClipboardRedirection>${clipboard}</ClipboardRedirection>`,
        `  <MemoryInMB>${memoryMb}</MemoryInMB>`,
        "  <MappedFolders>",
        "    <MappedFolder>",
        `      <HostFolder>${escapeXml(scratch)}</HostFolder>`,
        "      <ReadOnly>false</ReadOnly>",
        "    </MappedFolder>",
        "  </MappedFolders>",
        "</Configuration>",
        "",
    ].join("\n");
    const path = wsbConfigPath(device);
    writeFileSync(path, config, { mode: 0o600 });
    return path;
}

export function listWindowsDevices() {
    return readWindowsDevices().map((device) => ({ ...device, ownerId: ownerId() }));
}

export async function handleWindowsTool(name, args) {
    switch (name) {
        case "device_create": {
            const { backend, name: deviceName, deviceId, networking = false, clipboard = false, vgpu = false, memoryMb = 4096 } = args;
            if (backend !== "windows-sandbox") return undefined;

            const id = deviceId || windowsDeviceId(deviceName);
            const devices = readWindowsDevices();
            if (devices.some((device) => device.id === id)) {
                return textResult(false, `Device already exists for this owner: ${id}`);
            }

            const device = {
                id,
                name: deviceName,
                backend,
                kind: "desktop",
                platform: "windows",
                ownerId: ownerId(),
                networking: Boolean(networking),
                clipboard: Boolean(clipboard),
                vgpu: Boolean(vgpu),
                memoryMb,
                status: "stopped",
                creatable: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            };
            devices.push(device);
            writeWindowsDevices(devices);
            return jsonResult({ device });
        }

        case "device_delete": {
            const { deviceId, force = false } = args;
            const devices = readWindowsDevices();
            const device = devices.find((item) => item.id === deviceId);
            if (!device) return undefined;
            if (!force && device.status !== "stopped") {
                return textResult(false, `Refusing to delete ${deviceId} while status is ${device.status}`);
            }
            writeWindowsDevices(devices.filter((item) => item.id !== deviceId));
            return jsonResult({ deleted: deviceId });
        }

        case "device_status": {
            const { deviceId } = args;
            const device = findWindowsDevice(deviceId);
            if (!device) return undefined;
            return jsonResult({ device, backend: windowsBackend() });
        }

        case "device_start": {
            const { deviceId } = args;
            const device = findWindowsDevice(deviceId);
            if (!device) return undefined;

            const discovery = windowsDiscovery();
            if (!discovery.available) {
                return textResult(false, `Windows Sandbox backend missing prerequisites: ${discovery.missing.join(", ")}`);
            }

            const configPath = writeWsbConfig(device);
            const r = run(discovery.wsb, ["start", configPath]);
            if (r.status !== 0) return fail(r);

            const updated = updateWindowsDevice(deviceId, (item) => ({
                ...item,
                status: "running",
                configPath,
                updatedAt: new Date().toISOString(),
            }));
            return jsonResult({ device: updated });
        }

        case "device_stop": {
            const { deviceId } = args;
            const device = findWindowsDevice(deviceId);
            if (!device) return undefined;

            const discovery = windowsDiscovery();
            if (discovery.available) run(discovery.wsb, ["stop"]);

            const updated = updateWindowsDevice(deviceId, (item) => ({
                ...item,
                status: "stopped",
                updatedAt: new Date().toISOString(),
            }));
            return jsonResult({ device: updated });
        }

        default:
            return undefined;
    }
}
