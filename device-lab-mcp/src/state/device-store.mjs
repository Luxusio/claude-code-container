import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { ownerId } from "../context.mjs";

export function ownerStateDir(backend) {
    return join(homedir(), ".ccc/devices/owners", ownerId(), backend);
}

export function ownerStateFile(backend) {
    return join(ownerStateDir(backend), "devices.json");
}

export function readOwnerDevices(backend) {
    const file = ownerStateFile(backend);
    if (!existsSync(file)) return [];
    try {
        const parsed = JSON.parse(readFileSync(file, "utf-8"));
        return Array.isArray(parsed.devices) ? parsed.devices : [];
    } catch {
        return [];
    }
}

export function writeOwnerDevices(backend, devices) {
    mkdirSync(ownerStateDir(backend), { recursive: true });
    writeFileSync(ownerStateFile(backend), JSON.stringify({ devices }, null, 2), { mode: 0o600 });
}

export function findOwnerDevice(backend, id) {
    return readOwnerDevices(backend).find((device) => device.id === id);
}

export function updateOwnerDevice(backend, id, updater) {
    const devices = readOwnerDevices(backend);
    const index = devices.findIndex((device) => device.id === id);
    if (index < 0) return null;
    devices[index] = updater(devices[index]);
    writeOwnerDevices(backend, devices);
    return devices[index];
}
