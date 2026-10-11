import {
    closeSync,
    constants as fsConstants,
    fstatSync,
    lstatSync,
    openSync,
    readSync,
} from "fs";
import type { Stats } from "fs";
import { createOwnerStateContent } from "../providers/application/owner-state-content.mjs";
import { assertStateDirectoriesUnchanged, secureStateParentDirectory } from "./device-lab-shared-state.js";

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

const ownerStateContent = createOwnerStateContent({
    idPattern: OWNER_DEVICE_ID_PATTERN,
    byteLength: text => Buffer.byteLength(text, "utf8"),
    isStateError: error => error instanceof OwnerDeviceStateError,
    stateError,
});

export function readOwnerDeviceStateFile(file: string, limitBytes = OWNER_DEVICE_STATE_FILE_LIMIT_BYTES): unknown[] {
    let descriptor: number | null = null;
    try {
        const directories = secureStateParentDirectory(file, { create: false });
        assertStateDirectoriesUnchanged(directories);
        const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
        descriptor = openSync(file, fsConstants.O_RDONLY | noFollow);
        assertStateDirectoriesUnchanged(directories);
        const opened = fstatSync(descriptor);
        const path = lstatSync(file);
        if (!sameOpenedFile(opened, path)) throw stateError("owner-devices-state-invalid");
        if (opened.size > limitBytes) throw stateError("owner-devices-file-too-large");
        const contentDescriptor = descriptor;
        const devices = ownerStateContent.read(() => readBounded(contentDescriptor, limitBytes));
        assertStateDirectoriesUnchanged(directories);
        return devices;
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
    ownerStateContent.assertWritable(devices, limitBytes);
}

export function ownerDeviceStateErrorCode(error: unknown): OwnerDeviceStateErrorCode | null {
    return error instanceof OwnerDeviceStateError ? error.code : null;
}
