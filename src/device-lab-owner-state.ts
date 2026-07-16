import {
    closeSync,
    constants as fsConstants,
    fstatSync,
    lstatSync,
    openSync,
    readSync,
} from "fs";
import type { Stats } from "fs";

export const OWNER_DEVICE_STATE_FILE_LIMIT_BYTES = 256 * 1024;
export const OWNER_DEVICE_ID_PATTERN = /^(?!\.\.?$)[A-Za-z0-9._-]{1,128}$/;

export type OwnerDeviceStateErrorCode =
    | "owner-devices-file-too-large"
    | "owner-devices-state-invalid"
    | "owner-devices-state-read-failed";

export class OwnerDeviceStateError extends Error {
    readonly code: OwnerDeviceStateErrorCode;

    constructor(code: OwnerDeviceStateErrorCode, options?: { cause?: unknown }) {
        super(code, options);
        this.name = "OwnerDeviceStateError";
        this.code = code;
    }
}

function stateError(code: OwnerDeviceStateErrorCode, cause?: unknown): OwnerDeviceStateError {
    return new OwnerDeviceStateError(code, cause === undefined ? undefined : { cause });
}

function sameOpenedFile(opened: Stats, path: Stats): boolean {
    if (!opened.isFile() || !path.isFile() || path.isSymbolicLink()) return false;
    if (opened.nlink !== 1 || path.nlink !== 1) return false;
    if (opened.dev !== 0 && path.dev !== 0 && opened.dev !== path.dev) return false;
    if (opened.ino !== 0 && path.ino !== 0 && opened.ino !== path.ino) return false;
    return true;
}

function readBounded(descriptor: number, limitBytes: number): string {
    const buffer = Buffer.allocUnsafe(limitBytes + 1);
    let total = 0;
    while (total <= limitBytes) {
        const count = readSync(descriptor, buffer, total, buffer.length - total, null);
        if (count === 0) return buffer.subarray(0, total).toString("utf8");
        total += count;
    }
    throw stateError("owner-devices-file-too-large");
}

function validateDevicesPayload(parsed: unknown): unknown[] {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw stateError("owner-devices-state-invalid");
    }
    const devices = (parsed as { devices?: unknown }).devices;
    if (!Array.isArray(devices)) throw stateError("owner-devices-state-invalid");
    const ids = new Set<string>();
    for (const device of devices) {
        if (!device || typeof device !== "object" || Array.isArray(device)) {
            throw stateError("owner-devices-state-invalid");
        }
        const id = (device as { id?: unknown }).id;
        if (typeof id !== "string" || !OWNER_DEVICE_ID_PATTERN.test(id) || ids.has(id)) {
            throw stateError("owner-devices-state-invalid");
        }
        ids.add(id);
    }
    return devices;
}

export function readOwnerDeviceStateFile(file: string, limitBytes = OWNER_DEVICE_STATE_FILE_LIMIT_BYTES): unknown[] {
    let descriptor: number | null = null;
    try {
        const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
        descriptor = openSync(file, fsConstants.O_RDONLY | noFollow);
        const opened = fstatSync(descriptor);
        const path = lstatSync(file);
        if (!sameOpenedFile(opened, path)) throw stateError("owner-devices-state-invalid");
        if (opened.size > limitBytes) throw stateError("owner-devices-file-too-large");
        let parsed: unknown;
        try {
            parsed = JSON.parse(readBounded(descriptor, limitBytes));
        } catch (error) {
            if (error instanceof OwnerDeviceStateError) throw error;
            throw stateError("owner-devices-state-invalid", error);
        }
        return validateDevicesPayload(parsed);
    } catch (error) {
        if (error instanceof OwnerDeviceStateError) throw error;
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT" && descriptor === null) return [];
        if ((error as NodeJS.ErrnoException)?.code === "ELOOP") {
            throw stateError("owner-devices-state-invalid", error);
        }
        throw stateError("owner-devices-state-read-failed", error);
    } finally {
        if (descriptor !== null) closeSync(descriptor);
    }
}

export function assertOwnerDeviceStateWritable(devices: unknown[], limitBytes = OWNER_DEVICE_STATE_FILE_LIMIT_BYTES): void {
    validateDevicesPayload({ devices });
    if (Buffer.byteLength(JSON.stringify({ devices }, null, 2), "utf8") > limitBytes) {
        throw stateError("owner-devices-file-too-large");
    }
}

export function ownerDeviceStateErrorCode(error: unknown): OwnerDeviceStateErrorCode | null {
    return error instanceof OwnerDeviceStateError ? error.code : null;
}
