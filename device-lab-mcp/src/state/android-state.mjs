import { findOwnerDevice, readOwnerDevices, updateOwnerDevice, writeOwnerDevices } from "./device-store.mjs";

const BACKEND = "android";

export function readAndroidDevices() {
    return readOwnerDevices(BACKEND);
}

export function writeAndroidDevices(devices) {
    writeOwnerDevices(BACKEND, devices);
}

export function findAndroidDevice(id) {
    return findOwnerDevice(BACKEND, id);
}

export function updateAndroidDevice(id, updater) {
    return updateOwnerDevice(BACKEND, id, updater);
}
