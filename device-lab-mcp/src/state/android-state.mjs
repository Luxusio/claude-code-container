import { claimOwnerDevice, findOwnerDevice, mutateOwnerDevices, readOwnerDevices, transitionOwnerDeviceRecord, updateOwnerDevice } from "./device-store.mjs";

const BACKEND = "android";

export function readAndroidDevices() {
    return readOwnerDevices(BACKEND);
}

export function mutateAndroidDevices(updater) {
    return mutateOwnerDevices(BACKEND, updater);
}

export function claimAndroidDevice(device) {
    return claimOwnerDevice(BACKEND, device, ["id", "avdName", "port"]);
}

export function findAndroidDevice(id) {
    return findOwnerDevice(BACKEND, id);
}

export function updateAndroidDevice(id, updater) {
    return updateOwnerDevice(BACKEND, id, updater);
}

export function transitionAndroidDevice(id, expected, replacement) {
    return transitionOwnerDeviceRecord(BACKEND, id, expected, replacement);
}
