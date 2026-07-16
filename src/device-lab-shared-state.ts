import { randomBytes } from "crypto";
import { chmodSync, closeSync, constants as fsConstants, copyFileSync, fchmodSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, writeFileSync, writeSync } from "fs";
import type { Stats } from "fs";
import { hostname, uptime } from "os";
import { basename, dirname, isAbsolute, parse, resolve, sep } from "path";
import { DeviceLabStateFileError, readDeviceLabStateFile, withDeviceLabReadableFile } from "./device-lab-state-file.js";

const DEFAULT_WAIT_MS = 5000;
const DEFAULT_STALE_MS = 30000;
const MALFORMED_STALE_MS = 1000;
const POLL_MS = 10;
const ATOMIC_RENAME_WAIT_MS = 2000;
const ABANDONED_ATOMIC_TEMP_MIN_AGE_MS = 100;
const SHARED_MUTATION_LOCK_FILE_LIMIT_BYTES = 16 * 1024;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

type DirectoryIdentity = { path: string; stats: Stats | null };

function sameDirectory(left: Stats, right: Stats): boolean {
    if (!left.isDirectory() || !right.isDirectory() || left.isSymbolicLink() || right.isSymbolicLink()) return false;
    if (left.dev !== 0 && right.dev !== 0 && left.dev !== right.dev) return false;
    if (left.ino !== 0 && right.ino !== 0 && left.ino !== right.ino) return false;
    return true;
}

function managedDirectoryComponents(file: string): string[] {
    const absolute = isAbsolute(file) ? resolve(file) : resolve(process.cwd(), file);
    const parent = dirname(absolute);
    const root = parse(parent).root;
    const segments = parent.slice(root.length).split(sep).filter(Boolean);
    const normalized = process.platform === "win32" ? segments.map((segment) => segment.toLowerCase()) : segments;
    const cccIndex = normalized.findIndex((segment, index) => segment === ".ccc" && normalized[index + 1] === "devices");
    if (cccIndex < 0) return [];
    const start = cccIndex;
    const result: string[] = [];
    let current = root;
    for (let index = 0; index < segments.length; index += 1) {
        current = resolve(current, segments[index]);
        if (index >= start) result.push(current);
    }
    return result;
}

function invalidStateDirectory(path: string): Error & { code: string } {
    const error = new Error(`Unsafe device-lab state directory: ${path}`) as Error & { code: string };
    error.code = "device-lab-state-directory-invalid";
    return error;
}

/**
 * Creates and captures managed state directories one component at a time. The
 * returned identities must be checked again after path-based filesystem work;
 * Node does not expose openat/renameat, so this is the strongest portable
 * defense against an ancestor replacement race.
 */
export function secureStateParentDirectory(file: string, options: { create?: boolean } = {}): DirectoryIdentity[] {
    const identities: DirectoryIdentity[] = [];
    for (const path of managedDirectoryComponents(file)) {
        assertStateDirectoriesUnchanged(identities);
        let stats: Stats | null;
        try {
            stats = lstatSync(path);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            if (options.create === false) {
                identities.push({ path, stats: null });
                break;
            }
            try {
                mkdirSync(path, { mode: 0o700 });
            } catch (mkdirError) {
                if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
            }
            stats = lstatSync(path);
        }
        if (!stats.isDirectory() || stats.isSymbolicLink()) throw invalidStateDirectory(path);
        identities.push({ path, stats });
    }
    return identities;
}

export function assertStateDirectoriesUnchanged(identities: DirectoryIdentity[]): void {
    for (const identity of identities) {
        let current: Stats | null;
        try {
            current = lstatSync(identity.path);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT" && identity.stats === null) continue;
            throw invalidStateDirectory(`${identity.path}: ${(error as NodeJS.ErrnoException).code || "missing"}`);
        }
        if (identity.stats === null) throw invalidStateDirectory(identity.path);
        if (!sameDirectory(identity.stats, current)) throw invalidStateDirectory(identity.path);
    }
}

function sleepSync(ms: number): void {
    Atomics.wait(sleeper, 0, 0, ms);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function renameReplacingFileSync(source: string, destination: string, validateDirectories: () => void = () => {}): void {
    const deadline = Date.now() + ATOMIC_RENAME_WAIT_MS;
    while (true) {
        try {
            validateDirectories();
            renameSync(source, destination);
            validateDirectories();
            return;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (!["EACCES", "EBUSY", "EEXIST", "EPERM"].includes(code || "") || Date.now() >= deadline) throw error;
            sleepSync(POLL_MS);
        }
    }
}

function removeAbandonedAtomicTemporaryFiles(file: string): void {
    const base = basename(file);
    const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^${escapedBase}\\.(\\d+)\\.(?:[a-f0-9]{16}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\\.tmp$`, "i");
    let entries: string[];
    try {
        entries = readdirSync(dirname(file));
    } catch {
        return;
    }
    for (const entry of entries) {
        const match = entry.match(pattern);
        if (!match || processIsAlive(Number(match[1]))) continue;
        const candidate = resolve(dirname(file), entry);
        try {
            const stats = lstatSync(candidate);
            if (!stats.isFile() || stats.isSymbolicLink() || Date.now() - stats.mtimeMs < ABANDONED_ATOMIC_TEMP_MIN_AGE_MS) continue;
            rmSync(candidate, { force: true });
        } catch {
            // A concurrent writer may already have removed or replaced the candidate.
        }
    }
}

export function writeFileAtomically(file: string, value: string | NodeJS.ArrayBufferView): void {
    const directories = secureStateParentDirectory(file);
    removeAbandonedAtomicTemporaryFiles(file);
    assertStateDirectoriesUnchanged(directories);
    const temporaryFile = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
        writeFileSync(temporaryFile, value, { flag: "wx", mode: 0o600 });
        assertStateDirectoriesUnchanged(directories);
        renameReplacingFileSync(temporaryFile, file);
        assertStateDirectoriesUnchanged(directories);
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
    const directories = secureStateParentDirectory(destination);
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
        assertStateDirectoriesUnchanged(directories);
        renameReplacingFileSync(temporaryFile, destination);
        assertStateDirectoriesUnchanged(directories);
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

function restoreMovedLockIfPathEmpty(moved: string, file: string): void {
    try {
        linkSync(moved, file);
        rmSync(moved, { force: true });
        return;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    }
    try {
        copyFileSync(moved, file, fsConstants.COPYFILE_EXCL);
        rmSync(moved, { force: true });
    } catch {
        // A current lock won the path, or restoration is unsupported. Preserve the moved record for diagnostics.
    }
}

function moveIfTokenMatches(file: string, expectedToken: string, suffix: string, validateDirectories: () => void = () => {}): boolean {
    const moved = `${file}.${expectedToken}.${suffix}`;
    try {
        renameReplacingFileSync(file, moved, validateDirectories);
    } catch {
        return false;
    }
    if (readLock(moved)?.token === expectedToken) {
        rmSync(moved, { force: true });
        return true;
    }
    restoreMovedLockIfPathEmpty(moved, file);
    return false;
}

function moveMalformedLock(file: string, token: string, validateDirectories: () => void = () => {}): boolean {
    const moved = `${file}.${token}.malformed`;
    try {
        renameReplacingFileSync(file, moved, validateDirectories);
    } catch {
        return false;
    }
    if (!readLock(moved)) {
        rmSync(moved, { force: true });
        return true;
    }
    restoreMovedLockIfPathEmpty(moved, file);
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
    const directories = secureStateParentDirectory(file);
    const validateDirectories = () => assertStateDirectoriesUnchanged(directories);

    while (true) {
        try {
            validateDirectories();
            const fd = openSync(file, "wx", 0o600);
            try {
                writeFileSync(fd, JSON.stringify({ token, pid: process.pid, host: hostname(), bootId: currentBootId(), createdAt: new Date().toISOString() }));
            } finally {
                closeSync(fd);
            }
            validateDirectories();
            break;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            const existing = readLock(file);
            const existingToken = typeof existing?.token === "string" ? existing.token : null;
            if (existingToken && lockIsStale(file, existing, staleMs)) {
                if (moveIfTokenMatches(file, existingToken, "stale", validateDirectories)) continue;
            }
            if (!existing && lockIsStale(file, existing, staleMs)) {
                if (moveMalformedLock(file, token, validateDirectories)) continue;
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
        validateDirectories();
        return operation();
    } finally {
        validateDirectories();
        moveIfTokenMatches(file, token, "release", validateDirectories);
        validateDirectories();
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
    const directories = secureStateParentDirectory(file);
    const validateDirectories = () => assertStateDirectoriesUnchanged(directories);

    while (true) {
        try {
            validateDirectories();
            const fd = openSync(file, "wx", 0o600);
            try {
                writeFileSync(fd, JSON.stringify({ token, pid: process.pid, host: hostname(), bootId: currentBootId(), createdAt: new Date().toISOString() }));
            } finally {
                closeSync(fd);
            }
            validateDirectories();
            break;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            const existing = readLock(file);
            const existingToken = typeof existing?.token === "string" ? existing.token : null;
            if (existingToken && lockIsStale(file, existing, staleMs)) {
                if (moveIfTokenMatches(file, existingToken, "stale", validateDirectories)) continue;
            }
            if (!existing && lockIsStale(file, existing, staleMs)) {
                if (moveMalformedLock(file, token, validateDirectories)) continue;
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
        validateDirectories();
        return await operation();
    } finally {
        validateDirectories();
        moveIfTokenMatches(file, token, "release", validateDirectories);
        validateDirectories();
    }
}
