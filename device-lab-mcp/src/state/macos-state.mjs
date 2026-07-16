import { claimOwnerDevice, findOwnerDevice, readOwnerDevices, transitionOwnerDeviceRecord, updateOwnerDevice, writeOwnerDevices } from "./device-store.mjs";

const BACKEND = "macos";

export function readMacosDevices() {
    return readOwnerDevices(BACKEND);
}

export function writeMacosDevices(devices) {
    writeOwnerDevices(BACKEND, devices);
}

export function claimMacosDevice(device) {
    return claimOwnerDevice(BACKEND, device, ["id", ["provider", "providerInstance"]]);
}

export function findMacosDevice(id) {
    return findOwnerDevice(BACKEND, id);
}

export function updateMacosDevice(id, updater) {
    return updateOwnerDevice(BACKEND, id, updater);
}

export function transitionMacosDevice(id, expected, replacement) {
    return transitionOwnerDeviceRecord(BACKEND, id, expected, replacement);
}
