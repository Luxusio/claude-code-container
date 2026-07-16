import { claimOwnerDevice, findOwnerDevice, readOwnerDevices, transitionOwnerDeviceRecord, updateOwnerDevice } from "./device-store.mjs";

const BACKEND = "windows";

export function readWindowsDevices() {
    return readOwnerDevices(BACKEND);
}

export function claimWindowsDevice(device) {
    return claimOwnerDevice(BACKEND, device, ["id"]);
}

export function findWindowsDevice(id) {
    return findOwnerDevice(BACKEND, id);
}

export function updateWindowsDevice(id, updater) {
    return updateOwnerDevice(BACKEND, id, updater);
}

export function transitionWindowsDevice(id, expected, replacement) {
    return transitionOwnerDeviceRecord(BACKEND, id, expected, replacement);
}
