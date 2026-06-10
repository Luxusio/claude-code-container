import { findOwnerDevice, readOwnerDevices, updateOwnerDevice, writeOwnerDevices } from "./device-store.mjs";

const BACKEND = "ios-device";

export function readIosRealDevices() {
    return readOwnerDevices(BACKEND);
}

export function writeIosRealDevices(devices) {
    writeOwnerDevices(BACKEND, devices);
}

export function findIosRealDevice(id) {
    return findOwnerDevice(BACKEND, id);
}

export function updateIosRealDevice(id, updater) {
    return updateOwnerDevice(BACKEND, id, updater);
}
