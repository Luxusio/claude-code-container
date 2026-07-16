import {
    closeSync,
    constants as fsConstants,
    fstatSync,
    lstatSync,
    openSync,
    readSync,
} from "fs";
import type { Stats } from "fs";
import { dirname, isAbsolute, relative, resolve, sep } from "path";

export const DEVICE_LAB_STATE_FILE_LIMIT_BYTES = 256 * 1024;

export class DeviceLabStateFileError extends Error {
    readonly code: string;

    constructor(code: string, options?: { cause?: unknown }) {
        super(code, options);
        this.name = "DeviceLabStateFileError";
        this.code = code;
    }
}

function sameOpenedFile(opened: Stats, path: Stats): boolean {
    if (!opened.isFile() || !path.isFile() || path.isSymbolicLink()) return false;
    if (opened.nlink !== 1 || path.nlink !== 1) return false;
    if (opened.dev !== 0 && path.dev !== 0 && opened.dev !== path.dev) return false;
    if (opened.ino !== 0 && path.ino !== 0 && opened.ino !== path.ino) return false;
    return true;
}

function readBounded(descriptor: number, limitBytes: number, prefix: string): Buffer {
    const buffer = Buffer.allocUnsafe(limitBytes + 1);
    let total = 0;
    while (total <= limitBytes) {
        const count = readSync(descriptor, buffer, total, buffer.length - total, null);
        if (count === 0) return buffer.subarray(0, total);
        total += count;
    }
    throw new DeviceLabStateFileError(`${prefix}-file-too-large`);
}

export function readDeviceLabBinaryFile(
    file: string,
    prefix: string,
    limitBytes = DEVICE_LAB_STATE_FILE_LIMIT_BYTES,
): Buffer | null {
    return withDeviceLabReadableFile(file, prefix, limitBytes, (descriptor) => readBounded(descriptor, limitBytes, prefix));
}

export function withDeviceLabReadableFile<T>(
    file: string,
    prefix: string,
    limitBytes: number,
    operation: (descriptor: number, stat: Stats) => T,
): T | null {
    let descriptor: number | null = null;
    let operationStarted = false;
    try {
        const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
        descriptor = openSync(file, fsConstants.O_RDONLY | noFollow);
        const opened = fstatSync(descriptor);
        const path = lstatSync(file);
        if (!sameOpenedFile(opened, path)) throw new DeviceLabStateFileError(`${prefix}-state-invalid`);
        if (opened.size > limitBytes) throw new DeviceLabStateFileError(`${prefix}-file-too-large`);
        operationStarted = true;
        return operation(descriptor, opened);
    } catch (error) {
        if (operationStarted) throw error;
        if (error instanceof DeviceLabStateFileError) throw error;
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT" && descriptor === null) return null;
        if ((error as NodeJS.ErrnoException)?.code === "ELOOP") {
            throw new DeviceLabStateFileError(`${prefix}-state-invalid`, { cause: error });
        }
        throw new DeviceLabStateFileError(`${prefix}-state-read-failed`, { cause: error });
    } finally {
        if (descriptor !== null) closeSync(descriptor);
    }
}

export function readDeviceLabTextFile(
    file: string,
    prefix: string,
    limitBytes = DEVICE_LAB_STATE_FILE_LIMIT_BYTES,
): string | null {
    return readDeviceLabBinaryFile(file, prefix, limitBytes)?.toString("utf8") ?? null;
}

export function assertDeviceLabPathWithinRoot(root: string, file: string, prefix: string): void {
    const resolvedRoot = resolve(root);
    const resolvedFile = resolve(file);
    const child = relative(resolvedRoot, resolvedFile);
    if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
        throw new DeviceLabStateFileError(`${prefix}-path-outside-root`);
    }
    const parent = dirname(resolvedFile);
    const parentChild = relative(resolvedRoot, parent);
    const segments = parentChild ? parentChild.split(sep) : [];
    let current = resolvedRoot;
    try {
        for (const segment of ["", ...segments]) {
            if (segment) current = resolve(current, segment);
            const stat = lstatSync(current);
            if (!stat.isDirectory() || stat.isSymbolicLink()) {
                throw new DeviceLabStateFileError(`${prefix}-path-invalid`);
            }
        }
    } catch (error) {
        if (error instanceof DeviceLabStateFileError) throw error;
        throw new DeviceLabStateFileError(`${prefix}-path-invalid`, { cause: error });
    }
}

export function readDeviceLabStateFile<T>(
    file: string,
    validate: (value: unknown) => T,
    prefix: string,
    limitBytes = DEVICE_LAB_STATE_FILE_LIMIT_BYTES,
): T | null {
    const bytes = readDeviceLabBinaryFile(file, prefix, limitBytes);
    if (bytes === null) return null;
    try {
        let parsed: unknown;
        try {
            parsed = JSON.parse(bytes.toString("utf8"));
        } catch (error) {
            if (error instanceof DeviceLabStateFileError) throw error;
            throw new DeviceLabStateFileError(`${prefix}-state-invalid`, { cause: error });
        }
        try {
            return validate(parsed);
        } catch (error) {
            if (error instanceof DeviceLabStateFileError) throw error;
            throw new DeviceLabStateFileError(`${prefix}-state-invalid`, { cause: error });
        }
    } catch (error) {
        if (error instanceof DeviceLabStateFileError) throw error;
        throw new DeviceLabStateFileError(`${prefix}-state-invalid`, { cause: error });
    }
}

export function deviceLabStateFileErrorCode(error: unknown): string | null {
    return error instanceof DeviceLabStateFileError ? error.code : null;
}
