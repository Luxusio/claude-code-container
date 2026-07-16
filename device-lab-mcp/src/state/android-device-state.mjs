import { claimOwnerDevice, findOwnerDevice, readOwnerDevices, transitionOwnerDeviceRecord, updateOwnerDevice } from "./device-store.mjs";

const BACKEND = "android-device";

export function readAndroidRealDevices() {
    return readOwnerDevices(BACKEND);
}

export function claimAndroidRealDevice(device) {
    return claimOwnerDevice(BACKEND, device, ["id", "serial"]);
}

export function findAndroidRealDevice(id) {
    return findOwnerDevice(BACKEND, id);
}

export function updateAndroidRealDevice(id, updater) {
    return updateOwnerDevice(BACKEND, id, updater);
}

export function transitionAndroidRealDevice(id, expected, replacement) {
    return transitionOwnerDeviceRecord(BACKEND, id, expected, replacement);
}
