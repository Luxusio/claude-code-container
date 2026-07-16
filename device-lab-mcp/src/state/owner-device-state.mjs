import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync } from "fs";

export const OWNER_DEVICE_STATE_FILE_LIMIT_BYTES = 256 * 1024;
export const OWNER_DEVICE_ID_PATTERN = /^(?!\.\.?$)[A-Za-z0-9._-]{1,128}$/;

export class OwnerDeviceStateError extends Error {
    constructor(code, options) {
        super(code, options);
        this.name = "OwnerDeviceStateError";
        this.code = code;
    }
}

function stateError(code, cause) {
    return new OwnerDeviceStateError(code, cause === undefined ? undefined : { cause });
}

function sameOpenedFile(opened, path) {
    if (!opened.isFile() || !path.isFile() || path.isSymbolicLink()) return false;
    if (opened.nlink !== 1 || path.nlink !== 1) return false;
    if (opened.dev !== 0 && path.dev !== 0 && opened.dev !== path.dev) return false;
    if (opened.ino !== 0 && path.ino !== 0 && opened.ino !== path.ino) return false;
    return true;
}

function readBounded(descriptor, limitBytes) {
    const buffer = Buffer.allocUnsafe(limitBytes + 1);
    let total = 0;
    while (total <= limitBytes) {
        const count = readSync(descriptor, buffer, total, buffer.length - total, null);
        if (count === 0) return buffer.subarray(0, total).toString("utf8");
        total += count;
    }
    throw stateError("owner-devices-file-too-large");
}

function validateDevicesPayload(parsed) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.devices)) {
        throw stateError("owner-devices-state-invalid");
    }
    const ids = new Set();
    for (const device of parsed.devices) {
        if (!device || typeof device !== "object" || Array.isArray(device)) {
            throw stateError("owner-devices-state-invalid");
        }
        const id = device.id;
        if (typeof id !== "string" || !OWNER_DEVICE_ID_PATTERN.test(id) || ids.has(id)) {
            throw stateError("owner-devices-state-invalid");
        }
        ids.add(id);
    }
    return parsed.devices;
}

export function readOwnerDeviceStateFile(file, limitBytes = OWNER_DEVICE_STATE_FILE_LIMIT_BYTES) {
    let descriptor = null;
    try {
        const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
        descriptor = openSync(file, fsConstants.O_RDONLY | noFollow);
        const opened = fstatSync(descriptor);
        const path = lstatSync(file);
        if (!sameOpenedFile(opened, path)) throw stateError("owner-devices-state-invalid");
        if (opened.size > limitBytes) throw stateError("owner-devices-file-too-large");
        let parsed;
        try {
            parsed = JSON.parse(readBounded(descriptor, limitBytes));
        } catch (error) {
            if (error instanceof OwnerDeviceStateError) throw error;
            throw stateError("owner-devices-state-invalid", error);
        }
        return validateDevicesPayload(parsed);
    } catch (error) {
        if (error instanceof OwnerDeviceStateError) throw error;
        if (error?.code === "ENOENT" && descriptor === null) return [];
        if (error?.code === "ELOOP") throw stateError("owner-devices-state-invalid", error);
        throw stateError("owner-devices-state-read-failed", error);
    } finally {
        if (descriptor !== null) closeSync(descriptor);
    }
}

export function assertOwnerDeviceStateWritable(devices, limitBytes = OWNER_DEVICE_STATE_FILE_LIMIT_BYTES) {
    validateDevicesPayload({ devices });
    if (Buffer.byteLength(JSON.stringify({ devices }, null, 2), "utf8") > limitBytes) {
        throw stateError("owner-devices-file-too-large");
    }
}
