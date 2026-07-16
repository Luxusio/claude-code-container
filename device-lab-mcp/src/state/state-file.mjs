import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync } from "fs";
import { dirname, isAbsolute, relative, resolve, sep } from "path";

export const DEVICE_LAB_STATE_FILE_LIMIT_BYTES = 256 * 1024;

export class DeviceLabStateFileError extends Error {
    constructor(code, options) {
        super(code, options);
        this.name = "DeviceLabStateFileError";
        this.code = code;
    }
}

function sameOpenedFile(opened, path) {
    if (!opened.isFile() || !path.isFile() || path.isSymbolicLink()) return false;
    if (opened.nlink !== 1 || path.nlink !== 1) return false;
    if (opened.dev !== 0 && path.dev !== 0 && opened.dev !== path.dev) return false;
    if (opened.ino !== 0 && path.ino !== 0 && opened.ino !== path.ino) return false;
    return true;
}

function readBounded(descriptor, limitBytes, prefix) {
    const buffer = Buffer.allocUnsafe(limitBytes + 1);
    let total = 0;
    while (total <= limitBytes) {
        const count = readSync(descriptor, buffer, total, buffer.length - total, null);
        if (count === 0) return buffer.subarray(0, total);
        total += count;
    }
    throw new DeviceLabStateFileError(`${prefix}-file-too-large`);
}

export function readDeviceLabBinaryFile(file, prefix, limitBytes = DEVICE_LAB_STATE_FILE_LIMIT_BYTES) {
    return withDeviceLabReadableFile(file, prefix, limitBytes, (descriptor) => readBounded(descriptor, limitBytes, prefix));
}

export function withDeviceLabReadableFile(file, prefix, limitBytes, operation) {
    let descriptor = null;
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
        if (error?.code === "ENOENT" && descriptor === null) return null;
        if (error?.code === "ELOOP") throw new DeviceLabStateFileError(`${prefix}-state-invalid`, { cause: error });
        throw new DeviceLabStateFileError(`${prefix}-state-read-failed`, { cause: error });
    } finally {
        if (descriptor !== null) closeSync(descriptor);
    }
}

export function readDeviceLabTextFile(file, prefix, limitBytes = DEVICE_LAB_STATE_FILE_LIMIT_BYTES) {
    return readDeviceLabBinaryFile(file, prefix, limitBytes)?.toString("utf8") ?? null;
}

export function assertDeviceLabPathWithinRoot(root, file, prefix) {
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

export function readDeviceLabStateFile(file, validate, prefix, limitBytes = DEVICE_LAB_STATE_FILE_LIMIT_BYTES) {
    const bytes = readDeviceLabBinaryFile(file, prefix, limitBytes);
    if (bytes === null) return null;
    let parsed;
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
}
