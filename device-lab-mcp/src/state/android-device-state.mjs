import { findOwnerDevice, readOwnerDevices, updateOwnerDevice, writeOwnerDevices } from "./device-store.mjs";

const BACKEND = "android-device";

export function readAndroidRealDevices() {
    return readOwnerDevices(BACKEND);
}

export function writeAndroidRealDevices(devices) {
    writeOwnerDevices(BACKEND, devices);
}

export function findAndroidRealDevice(id) {
    return findOwnerDevice(BACKEND, id);
}

export function updateAndroidRealDevice(id, updater) {
    return updateOwnerDevice(BACKEND, id, updater);
}
