import { findOwnerDevice, readOwnerDevices, updateOwnerDevice, writeOwnerDevices } from "./device-store.mjs";

const BACKEND = "windows";

export function readWindowsDevices() {
    return readOwnerDevices(BACKEND);
}

export function writeWindowsDevices(devices) {
    writeOwnerDevices(BACKEND, devices);
}

export function findWindowsDevice(id) {
    return findOwnerDevice(BACKEND, id);
}

export function updateWindowsDevice(id, updater) {
    return updateOwnerDevice(BACKEND, id, updater);
}
