import { findOwnerDevice, readOwnerDevices, updateOwnerDevice, writeOwnerDevices } from "./device-store.mjs";

const BACKEND = "ios";

export function readIosDevices() {
    return readOwnerDevices(BACKEND);
}

export function writeIosDevices(devices) {
    writeOwnerDevices(BACKEND, devices);
}

export function findIosDevice(id) {
    return findOwnerDevice(BACKEND, id);
}

export function updateIosDevice(id, updater) {
    return updateOwnerDevice(BACKEND, id, updater);
}
