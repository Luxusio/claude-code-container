import { randomBytes } from "crypto";
import { createStateFilePublication } from "../providers/application/state-file-publication.mjs";
import { createSharedMutationLock } from "../providers/application/shared-mutation-lock.mjs";
import type { StateFilePublicationPorts } from "../providers/ports/state-file-publication.mjs";
import type { SharedMutationLockPorts } from "../providers/ports/shared-mutation-lock.mjs";
import { chmodSync, closeSync, constants as fsConstants, copyFileSync, fchmodSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, writeFileSync, writeSync } from "fs";
import type { Stats } from "fs";
import { hostname, uptime } from "os";
import { basename, dirname, isAbsolute, parse, resolve, sep } from "path";
import {
    deviceRuntimeProcessIdentityMatches,
    inspectDeviceRuntimeProcessIdentity,
    readDeviceRuntimeProcessIdentity,
    readDeviceRuntimeProcessIdentityAsync,
} from "./device-lab-process-identity.js";
import { DeviceLabStateFileError, readDeviceLabStateFile, withDeviceLabReadableFile } from "./device-lab-state-file.js";

const SHARED_MUTATION_LOCK_FILE_LIMIT_BYTES = 16 * 1024;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

type DirectoryIdentity = { path: string; stats: Stats | null };

function sameDirectory(left: Stats, right: Stats): boolean {
    if (!left.isDirectory() || !right.isDirectory() || left.isSymbolicLink() || right.isSymbolicLink()) return false;
    const leftHasFileId = left.dev !== 0 && left.ino !== 0;
    const rightHasFileId = right.dev !== 0 && right.ino !== 0;
    if (leftHasFileId || rightHasFileId) {
        return leftHasFileId && rightHasFileId && left.dev === right.dev && left.ino === right.ino;
    }
    const leftHasBirthtime = Number.isFinite(left.birthtimeMs) && left.birthtimeMs > 0;
    const rightHasBirthtime = Number.isFinite(right.birthtimeMs) && right.birthtimeMs > 0;
    return leftHasBirthtime && rightHasBirthtime && left.birthtimeMs === right.birthtimeMs;
}

function managedDirectoryComponents(file: string): string[] {
    const absolute = isAbsolute(file) ? resolve(file) : resolve(process.cwd(), file);
    const parent = dirname(absolute);
    const root = parse(parent).root;
    const segments = parent.slice(root.length).split(sep).filter(Boolean);
    const normalized = process.platform === "win32" ? segments.map((segment) => segment.toLowerCase()) : segments;
    const cccIndex = normalized.findIndex((segment, index) => segment === ".ccc"
        && (index === normalized.length - 1
            || ["devices", "locks", "run", "device-broker-private"].includes(normalized[index + 1])));
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
    publication.rename(source, destination, () => { validateDirectories(); return undefined; });
}


export function writeFileAtomically(file: string, value: string | NodeJS.ArrayBufferView): void {
    publication.write(file, value);
}

export function writeJsonFileAtomically(file: string, value: unknown): void {
    publication.writeJson(file, value);
}

export function copyFileAtomically(
    source: string,
    destination: string,
    options: { prefix?: string; limitBytes: number },
): number {
    return publication.copy(source, destination, options);
}

function readLock(file: string): ReturnType<typeof locks.readLock> {
    return locks.readLock(file);
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
    const moved = `${file}.${randomBytes(8).toString("hex")}.${suffix}`;
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

type AtomicStage = { path: string; output: number | null };
function nativeErrorCode(error: unknown): string | undefined {
    return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
const publicationPorts: StateFilePublicationPorts<DirectoryIdentity[], AtomicStage> = {
    variant: "typescript",
    capture: file => secureStateParentDirectory(file),
    check: fence => { assertStateDirectoriesUnchanged(fence); return undefined; },
    basename,
    stage: file => ({ path: `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`, output: null }),
    entries: file => readdirSync(dirname(file)),
    temporaryFacts: (file, entry) => { const stats = lstatSync(resolve(dirname(file), entry)); return { ordinary: stats.isFile(), linked: stats.isSymbolicLink(), mtimeMs: stats.mtimeMs }; },
    removeTemporary: (file, entry) => { rmSync(resolve(dirname(file), entry), { force: true }); return undefined; },
    alive: processIsAlive,
    writeStage: (stage, value) => { writeFileSync(stage.path, typeof value === "string" ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength), { flag: "wx", mode: 0o600 }); return undefined; },
    renameAttempt: (source, destination) => { renameSync(source, destination); return undefined; },
    removeStage: stage => { rmSync(stage.path, { force: true }); return undefined; },
    chmodTarget: file => { chmodSync(file, 0o600); return undefined; },
    withSource: (source, prefix, limit, operation, stage) => withDeviceLabReadableFile(source, prefix, limit, input => operation({
        openOutput: () => {
            const descriptor = openSync(stage.path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
            stage.output = descriptor;
            const buffer = Buffer.allocUnsafe(64 * 1024);
            return {
                read: () => readSync(input, buffer, 0, buffer.length, null),
                write: (offset, length) => writeSync(descriptor, buffer, offset, length),
                permissions: () => { fchmodSync(descriptor, 0o600); return undefined; },
                close: () => { closeSync(descriptor); stage.output = null; return undefined; },
            };
        },
    })),
    closeOutput: stage => { if (stage.output !== null) closeSync(stage.output); return undefined; },
    now: Date.now,
    pauseSync: ms => { sleepSync(ms); return undefined; },
    errorCode: nativeErrorCode,
    stateError: code => new DeviceLabStateFileError(code),
};
const publication = createStateFilePublication(publicationPorts);
const lockPorts: SharedMutationLockPorts<DirectoryIdentity[]> = {
    variant: "typescript",
    capture: file => secureStateParentDirectory(file),
    check: fence => { assertStateDirectoriesUnchanged(fence); return undefined; },
    token: () => randomBytes(16).toString("hex"),
    pid: () => process.pid,
    host: hostname,
    boot: currentBootId,
    platform: () => process.platform,
    timestamp: () => new Date().toISOString(),
    now: Date.now,
    monotonic: () => performance.now(),
    pauseSync: ms => { sleepSync(ms); return undefined; },
    pause: ms => sleep(ms).then(() => undefined),
    openClaim: file => openSync(file, "wx", 0o600),
    writeClaim: (descriptor, text) => { writeFileSync(descriptor, text); return undefined; },
    closeClaim: descriptor => { closeSync(descriptor); return undefined; },
    readRaw: file => ({ kind: "value", value: readDeviceLabStateFile(file, value => value, "shared-mutation-lock", SHARED_MUTATION_LOCK_FILE_LIMIT_BYTES) }),
    mtime: file => { try { return lstatSync(file).mtimeMs; } catch { return null; } },
    alive: processIsAlive,
    identitySync: readDeviceRuntimeProcessIdentity,
    identityAsync: readDeviceRuntimeProcessIdentityAsync,
    observe: (identity, pid) => inspectDeviceRuntimeProcessIdentity(identity, pid).status,
    matches: deviceRuntimeProcessIdentityMatches,
    moveQualified: (file, token, suffix, fence) => moveIfTokenMatches(file, token, suffix, () => assertStateDirectoriesUnchanged(fence)),
    moveMalformed: (file, token, fence) => moveMalformedLock(file, token, () => assertStateDirectoriesUnchanged(fence)),
    errorCode: nativeErrorCode,
    timeout: file => Object.assign(new Error(`Timed out acquiring shared mutation lock: ${file}`), { code: "shared-mutation-lock-timeout" }),
};
const locks = createSharedMutationLock(lockPorts);

export function withSharedMutationLock<T>(
    file: string,
    operation: () => T,
    options: { reclaimStale?: boolean; waitMs?: number; staleMs?: number; waitBudget?: { remaining(): number } } = {},
): T {
    return locks.withLock(file, operation, options);
}

export async function withSharedMutationLockAsync<T>(
    file: string,
    operation: () => Promise<T> | T,
    options: { waitMs?: number; staleMs?: number; waitBudget?: { remaining(): number } } = {},
): Promise<T> {
    return locks.withLockAsync(file, operation, options);
}
