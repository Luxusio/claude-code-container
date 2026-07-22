import { claimOwnerDevice, findOwnerDevice, readOwnerDevices, transitionOwnerDeviceRecord, updateOwnerDevice, writeOwnerDevices } from "./device-store.mjs";

const BACKEND = "windows-vm";

export function readWindowsVmDevices() {
    return readOwnerDevices(BACKEND);
}

export function writeWindowsVmDevices(devices) {
    writeOwnerDevices(BACKEND, devices);
}

export function claimWindowsVmDevice(device) {
    return claimOwnerDevice(BACKEND, device, ["id", "vmId", "vmName", "diskPath"]);
}

export function findWindowsVmDevice(id) {
    return findOwnerDevice(BACKEND, id);
}

export function updateWindowsVmDevice(id, updater) {
    return updateOwnerDevice(BACKEND, id, updater);
}

export function transitionWindowsVmDevice(id, expected, replacement) {
    return transitionOwnerDeviceRecord(BACKEND, id, expected, replacement);
}
