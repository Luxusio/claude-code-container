import { claimOwnerDevice, findOwnerDevice, readOwnerDevices, transitionOwnerDeviceRecord, updateOwnerDevice } from "./device-store.mjs";

const BACKEND = "ios";

export function readIosDevices() {
    return readOwnerDevices(BACKEND);
}

export function claimIosDevice(device) {
    return claimOwnerDevice(BACKEND, device, ["id", "udid", "simulatorName"]);
}

export function findIosDevice(id) {
    return findOwnerDevice(BACKEND, id);
}

export function updateIosDevice(id, updater) {
    return updateOwnerDevice(BACKEND, id, updater);
}

export function transitionIosDevice(id, expected, replacement) {
    return transitionOwnerDeviceRecord(BACKEND, id, expected, replacement);
}
