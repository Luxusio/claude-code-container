import { findOwnerDevice, readOwnerDevices, updateOwnerDevice, writeOwnerDevices } from "./device-store.mjs";

const BACKEND = "macos";

export function readMacosDevices() {
    return readOwnerDevices(BACKEND);
}

export function writeMacosDevices(devices) {
    writeOwnerDevices(BACKEND, devices);
}

export function findMacosDevice(id) {
    return findOwnerDevice(BACKEND, id);
}

export function updateMacosDevice(id, updater) {
    return updateOwnerDevice(BACKEND, id, updater);
}
