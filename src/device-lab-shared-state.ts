import { randomBytes } from "crypto";
import { chmodSync, closeSync, constants as fsConstants, fchmodSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync, writeSync } from "fs";
import { hostname, uptime } from "os";
import { dirname } from "path";
import { DeviceLabStateFileError, readDeviceLabStateFile, withDeviceLabReadableFile } from "./device-lab-state-file.js";

const DEFAULT_WAIT_MS = 5000;
const DEFAULT_STALE_MS = 30000;
const MALFORMED_STALE_MS = 1000;
const POLL_MS = 10;
const ATOMIC_RENAME_WAIT_MS = 2000;
const SHARED_MUTATION_LOCK_FILE_LIMIT_BYTES = 16 * 1024;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
    Atomics.wait(sleeper, 0, 0, ms);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function renameReplacingFileSync(source: string, destination: string): void {
    const deadline = Date.now() + ATOMIC_RENAME_WAIT_MS;
    while (true) {
        try {
            renameSync(source, destination);
            return;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (!["EACCES", "EBUSY", "EEXIST", "EPERM"].includes(code || "") || Date.now() >= deadline) throw error;
            sleepSync(POLL_MS);
        }
    }
}

export function writeFileAtomically(file: string, value: string | NodeJS.ArrayBufferView): void {
    mkdirSync(dirname(file), { recursive: true });
    const temporaryFile = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
        writeFileSync(temporaryFile, value, { flag: "wx", mode: 0o600 });
        renameReplacingFileSync(temporaryFile, file);
        try { chmodSync(file, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
    } finally {
        rmSync(temporaryFile, { force: true });
    }
}

export function writeJsonFileAtomically(file: string, value: unknown): void {
    writeFileAtomically(file, JSON.stringify(value, null, 2));
}

export function copyFileAtomically(
    source: string,
    destination: string,
    options: { prefix?: string; limitBytes: number },
): number {
    const prefix = options.prefix || "device-lab-copy";
    const limitBytes = options.limitBytes;
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) throw new TypeError("limitBytes must be a non-negative safe integer");
    mkdirSync(dirname(destination), { recursive: true });
    const temporaryFile = `${destination}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    let output: number | null = null;
    try {
        const copied = withDeviceLabReadableFile(source, prefix, limitBytes, (input) => {
            output = openSync(temporaryFile, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
            const buffer = Buffer.allocUnsafe(64 * 1024);
            let total = 0;
            while (true) {
                const count = readSync(input, buffer, 0, buffer.length, null);
                if (count === 0) break;
                if (total + count > limitBytes) throw new DeviceLabStateFileError(`${prefix}-file-too-large`);
                let written = 0;
                while (written < count) {
                    const size = writeSync(output, buffer, written, count - written);
                    if (size <= 0) throw new Error(`${prefix}-write-failed`);
                    written += size;
                }
                total += count;
            }
            try { fchmodSync(output, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
            closeSync(output);
            output = null;
            return total;
        });
        if (copied === null) throw new DeviceLabStateFileError(`${prefix}-file-missing`);
        renameReplacingFileSync(temporaryFile, destination);
        try { chmodSync(destination, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
        return copied;
    } finally {
        if (output !== null) closeSync(output);
        rmSync(temporaryFile, { force: true });
    }
}

function readLock(file: string): Record<string, unknown> | null {
    try {
        return readDeviceLabStateFile(file, (value) => {
            if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-shared-mutation-lock");
            return value as Record<string, unknown>;
        }, "shared-mutation-lock", SHARED_MUTATION_LOCK_FILE_LIMIT_BYTES);
    } catch {
        return null;
    }
}

function fileAgeMs(file: string): number {
    try {
        return Math.max(0, Date.now() - lstatSync(file).mtimeMs);
    } catch {
        return 0;
    }
}

function processIsAlive(pid: unknown): boolean {
    if (!Number.isInteger(pid) || (pid as number) <= 0) return false;
    try {
        process.kill(pid as number, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

function currentBootId(): string {
    try {
        return readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
    } catch {
        return `${hostname()}:${Math.floor((Date.now() - uptime() * 1000) / 1000)}`;
    }
}

function sameBootIdentity(left: unknown, right: unknown): boolean {
    if (left === right) return true;
    const leftMatch = typeof left === "string" ? left.match(/^(.*):(\d+)$/) : null;
    const rightMatch = typeof right === "string" ? right.match(/^(.*):(\d+)$/) : null;
    return Boolean(leftMatch && rightMatch
        && leftMatch[1] === rightMatch[1]
        && Math.abs(Number(leftMatch[2]) - Number(rightMatch[2])) <= 5);
}

function lockIsStale(file: string, lock: Record<string, unknown> | null, staleMs: number): boolean {
    const ageMs = fileAgeMs(file);
    if (ageMs < 100) return false;
    if (!lock) return ageMs >= Math.min(staleMs, MALFORMED_STALE_MS);
    if (lock.bootId && !sameBootIdentity(lock.bootId, currentBootId())) return true;
    if (lock.host === hostname() && Number.isInteger(lock.pid)) return !processIsAlive(lock.pid);
    return ageMs >= staleMs;
}

function moveIfTokenMatches(file: string, expectedToken: string, suffix: string): boolean {
    const moved = `${file}.${expectedToken}.${suffix}`;
    try {
        renameReplacingFileSync(file, moved);
    } catch {
        return false;
    }
    if (readLock(moved)?.token === expectedToken) {
        rmSync(moved, { force: true });
        return true;
    }
    try { renameReplacingFileSync(moved, file); } catch { /* preserve the displaced record for diagnostics */ }
    return false;
}

function moveMalformedLock(file: string, token: string): boolean {
    const moved = `${file}.${token}.malformed`;
    try {
        renameReplacingFileSync(file, moved);
    } catch {
        return false;
    }
    if (!readLock(moved)) {
        rmSync(moved, { force: true });
        return true;
    }
    try { renameReplacingFileSync(moved, file); } catch { /* preserve the displaced record for diagnostics */ }
    return false;
}

export function withSharedMutationLock<T>(
    file: string,
    operation: () => T,
    options: { waitMs?: number; staleMs?: number } = {},
): T {
    const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
    const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
    const deadline = Date.now() + waitMs;
    const token = randomBytes(16).toString("hex");
    mkdirSync(dirname(file), { recursive: true });

    while (true) {
        try {
            const fd = openSync(file, "wx", 0o600);
            try {
                writeFileSync(fd, JSON.stringify({ token, pid: process.pid, host: hostname(), bootId: currentBootId(), createdAt: new Date().toISOString() }));
            } finally {
                closeSync(fd);
            }
            break;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            const existing = readLock(file);
            const existingToken = typeof existing?.token === "string" ? existing.token : null;
            if (existingToken && lockIsStale(file, existing, staleMs)) {
                if (moveIfTokenMatches(file, existingToken, "stale")) continue;
            }
            if (!existing && lockIsStale(file, existing, staleMs)) {
                if (moveMalformedLock(file, token)) continue;
            }
            if (Date.now() >= deadline) {
                const error = new Error(`Timed out acquiring shared mutation lock: ${file}`) as Error & { code?: string };
                error.code = "shared-mutation-lock-timeout";
                throw error;
            }
            sleepSync(POLL_MS);
        }
    }

    try {
        return operation();
    } finally {
        moveIfTokenMatches(file, token, "release");
    }
}

export async function withSharedMutationLockAsync<T>(
    file: string,
    operation: () => Promise<T> | T,
    options: { waitMs?: number; staleMs?: number } = {},
): Promise<T> {
    const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
    const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
    const deadline = Date.now() + waitMs;
    const token = randomBytes(16).toString("hex");
    mkdirSync(dirname(file), { recursive: true });

    while (true) {
        try {
            const fd = openSync(file, "wx", 0o600);
            try {
                writeFileSync(fd, JSON.stringify({ token, pid: process.pid, host: hostname(), bootId: currentBootId(), createdAt: new Date().toISOString() }));
            } finally {
                closeSync(fd);
            }
            break;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            const existing = readLock(file);
            const existingToken = typeof existing?.token === "string" ? existing.token : null;
            if (existingToken && lockIsStale(file, existing, staleMs)) {
                if (moveIfTokenMatches(file, existingToken, "stale")) continue;
            }
            if (!existing && lockIsStale(file, existing, staleMs)) {
                if (moveMalformedLock(file, token)) continue;
            }
            if (Date.now() >= deadline) {
                const error = new Error(`Timed out acquiring shared mutation lock: ${file}`) as Error & { code?: string };
                error.code = "shared-mutation-lock-timeout";
                throw error;
            }
            await sleep(POLL_MS);
        }
    }

    try {
        return await operation();
    } finally {
        moveIfTokenMatches(file, token, "release");
    }
}
