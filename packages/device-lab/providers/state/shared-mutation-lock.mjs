import { ownerContext, runOwnerContext } from "./mutation-lock-context.mjs";
import { randomUUID } from "crypto";
import { createStateFilePublication } from "../application/state-file-publication.mjs";
import { createSharedMutationLock } from "../application/shared-mutation-lock.mjs";
import { chmodSync, closeSync, constants as fsConstants, copyFileSync, fchmodSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync } from "fs";
import { hostname, uptime } from "os";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "path";
import { inspectProcessIdentity, processIdentityMatches, readProcessIdentity, readProcessIdentityAsync } from "./process-identity.mjs";
import { DeviceLabStateFileError, readDeviceLabStateFile, withDeviceLabReadableFile } from "./state-file.mjs";

const SHARED_MUTATION_LOCK_FILE_LIMIT_BYTES = 16 * 1024;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** @typedef {{path:string,stats:import('fs').Stats}} DirectoryIdentity */
/** @param {import('fs').Stats} left @param {import('fs').Stats} right @returns {boolean} */
function sameDirectory(left, right) {
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

/** @param {string} file @returns {string[]} */
function managedDirectoryComponents(file) {
    const absolute = isAbsolute(file) ? resolve(file) : resolve(process.cwd(), file);
    const parent = dirname(absolute);
    const root = parse(parent).root;
    const segments = parent.slice(root.length).split(sep).filter(Boolean);
    const normalized = process.platform === "win32" ? segments.map((segment) => segment.toLowerCase()) : segments;
    // The parent of .ccc is the host-managed state root and trust boundary.
    // Validate it plus every component below it; paths outside device state
    // retain normal filesystem semantics for upload/download destinations.
    const cccIndex = normalized.findIndex((segment, index) => segment === ".ccc"
        && ["devices", "locks"].includes(normalized[index + 1]));
    if (cccIndex < 0) return [];
    const managedStart = Math.max(0, cccIndex - 1);
    const result = [];
    let current = root;
    for (let index = 0; index < segments.length; index += 1) {
        current = resolve(current, segments[index]);
        if (index >= managedStart) result.push(current);
    }
    return result;
}

/** @param {string} path @returns {Error & {code:string}} */
function invalidStateDirectory(path) {
    return Object.assign(new Error(`Unsafe device-lab state directory: ${path}`), { code: "device-lab-state-directory-invalid" });
}

/** @param {readonly DirectoryIdentity[]} identities @returns {undefined} */
function assertStateDirectoriesUnchanged(identities) {
    for (const identity of identities) {
        let current;
        try {
            current = lstatSync(identity.path);
        } catch (error) {
            throw invalidStateDirectory(`${identity.path}: ${nativeErrorCode(error) || "missing"}`);
        }
        if (!sameDirectory(identity.stats, current)) throw invalidStateDirectory(identity.path);
    }
}

/** @param {string} file @returns {DirectoryIdentity[]} */
function secureStateParentDirectory(file) {
    /** @type {DirectoryIdentity[]} */
    const identities = [];
    for (const path of managedDirectoryComponents(file)) {
        assertStateDirectoriesUnchanged(identities);
        let stats;
        try {
            stats = lstatSync(path);
        } catch (error) {
            if (nativeErrorCode(error) !== "ENOENT") throw error;
            try {
                mkdirSync(path, { mode: 0o700 });
            } catch (mkdirError) {
                if (nativeErrorCode(mkdirError) !== "EEXIST") throw mkdirError;
            }
            stats = lstatSync(path);
        }
        // On Windows, directory junctions created through Node are reported as
        // symbolic links by lstat. File-id/birthtime checks above then detect
        // replacement of ordinary directories between path-based operations.
        if (!stats.isDirectory() || stats.isSymbolicLink() || !sameDirectory(stats, stats)) throw invalidStateDirectory(path);
        identities.push({ path, stats });
    }
    return identities;
}

/** @param {number} ms @returns {undefined} */
function sleepSync(ms) {
    Atomics.wait(sleeper, 0, 0, ms);
}

/** @param {number} ms @returns {Promise<void>} */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {string} source @param {string} destination @param {()=>undefined} [validateDirectories] @returns {undefined} */
function renameReplacingFileSync(source, destination, validateDirectories = () => {}) {
    publication.rename(source, destination, () => { validateDirectories(); return undefined; });
}


/** @param {string} file @param {string|ArrayBufferView} value @returns {undefined} */
export function writeFileAtomically(file, value) {
    publication.write(file, value);
}

/** @param {string} file @param {unknown} value @returns {undefined} */
export function writeJsonFileAtomically(file, value) {
    publication.writeJson(file, value);
}

/** @param {string} source @param {string} destination @param {{prefix?:string,limitBytes:number}} options @returns {number} */
export function copyFileAtomically(source, destination, options) {
    return publication.copy(source, destination, options);
}

/** @param {string} file @returns {import('../ports/shared-mutation-lock.mjs').MutationLockRecord|null} */
function readLock(file) {
    return locks.readLock(file);
}




/** @param {number} pid @returns {boolean} */
function processIsAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (process.platform === "linux") {
        try {
            const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
            const close = stat.lastIndexOf(")");
            const fields = stat.slice(close + 1).trim().split(/\s+/);
            if (close >= 0 && /^[0-9]+ \(/.test(stat) && Number(stat.slice(0, stat.indexOf(" "))) === pid
                && (fields[0] === "Z" || fields[0] === "X") && /^[0-9]+$/.test(fields[19] ?? "")
                && fields.slice(1, 19).every((field) => /^-?[0-9]+$/.test(field))) return false;
        } catch {
            // An unavailable stat is not evidence of exit; retain the existing probe.
        }
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return nativeErrorCode(error) !== "ESRCH";
    }
}

/** @returns {string} */
function currentBootId() {
    try {
        return readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
    } catch {
        return `${hostname()}:${Math.floor((Date.now() - uptime() * 1000) / 1000)}`;
    }
}












/** @param {string} moved @param {string} file @returns {undefined} */
function restoreMovedLockIfPathEmpty(moved, file) {
    try {
        linkSync(moved, file);
        rmSync(moved, { force: true });
        return;
    } catch (error) {
        if (nativeErrorCode(error) === "EEXIST") return;
    }
    try {
        copyFileSync(moved, file, fsConstants.COPYFILE_EXCL);
        rmSync(moved, { force: true });
    } catch {
        // A current lock won the path, or restoration is unsupported. Preserve the moved record for diagnostics.
    }
}

/** @param {string} file @param {string} expectedToken @param {'stale'|'release'} suffix @param {()=>undefined} [validateDirectories] @returns {boolean} */
function moveIfTokenMatches(file, expectedToken, suffix, validateDirectories = () => {}) {
    const moved = `${file}.${randomUUID()}.${suffix}`;
    try {
        renameReplacingFileSync(file, moved, validateDirectories);
    } catch {
        return false;
    }
    const movedLock = readLock(moved);
    if (movedLock?.token === expectedToken) {
        rmSync(moved, { force: true });
        return true;
    }
    restoreMovedLockIfPathEmpty(moved, file);
    return false;
}

/** @param {string} file @param {string} token @param {()=>undefined} [validateDirectories] @returns {boolean} */
function moveMalformedLock(file, token, validateDirectories = () => {}) {
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


/** @typedef {{path:string,output:number|null}} AtomicStage */
/** @param {unknown} error @returns {string|undefined} */
function nativeErrorCode(error) {
    return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
/** @type {import('../ports/state-file-publication.mjs').StateFilePublicationPorts<ReturnType<typeof secureStateParentDirectory>,AtomicStage>} */
const publicationPorts = {
    variant: "provider",
    capture: file => secureStateParentDirectory(file),
    check: fence => { assertStateDirectoriesUnchanged(fence); return undefined; },
    basename,
    stage: file => ({ path: `${file}.${process.pid}.${randomUUID()}.tmp`, output: null }),
    entries: (file, fence) => { assertStateDirectoriesUnchanged(fence); return readdirSync(dirname(file)); },
    temporaryFacts: (file, entry, fence) => { assertStateDirectoriesUnchanged(fence); const stats = lstatSync(join(dirname(file), entry)); return { ordinary: stats.isFile(), linked: stats.isSymbolicLink(), mtimeMs: stats.mtimeMs }; },
    removeTemporary: (file, entry, fence) => { assertStateDirectoriesUnchanged(fence); rmSync(join(dirname(file), entry), { force: true }); assertStateDirectoriesUnchanged(fence); return undefined; },
    alive: processIsAlive,
    writeStage: (stage, value) => { writeFileSync(stage.path, typeof value === "string" ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength), { flag: "wx", mode: 0o600 }); return undefined; },
    renameAttempt: (source, destination) => { renameSync(source, destination); return undefined; },
    removeStage: stage => { rmSync(stage.path, { force: true }); return undefined; },
    chmodTarget: file => { chmodSync(file, 0o600); return undefined; },
    withSource: (source, prefix, limit, operation, stage, fence) => withDeviceLabReadableFile(source, prefix, limit, input => operation({
        openOutput: () => {
            assertStateDirectoriesUnchanged(fence);
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
/** @type {import('../ports/shared-mutation-lock.mjs').SharedMutationLockPorts<ReturnType<typeof secureStateParentDirectory>>} */
const lockPorts = {
    variant: "provider",
    ownerContext,
    runOwnerContext,
    key: file => {
        const key = join(realpathSync.native(dirname(resolve(file))), basename(file));
        return process.platform === "win32" ? key.toLowerCase() : key;
    },
    capture: file => secureStateParentDirectory(file),
    check: fence => { assertStateDirectoriesUnchanged(fence); return undefined; },
    token: () => randomUUID(),
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
    identitySync: readProcessIdentity,
    identityAsync: readProcessIdentityAsync,
    observe: (identity, pid) => inspectProcessIdentity(identity, pid).status,
    matches: processIdentityMatches,
    moveQualified: (file, token, suffix, fence) => moveIfTokenMatches(file, token, suffix, () => assertStateDirectoriesUnchanged(fence)),
    moveMalformed: (file, token, fence) => moveMalformedLock(file, token, () => assertStateDirectoriesUnchanged(fence)),
    errorCode: nativeErrorCode,
    timeout: file => Object.assign(new Error(`Timed out acquiring shared mutation lock: ${file}`), { code: "shared-mutation-lock-timeout" }),
};
const locks = createSharedMutationLock(lockPorts);

/**
 * @template T
 * @param {string} file
 * @param {()=>T} operation
 * @param {import('../ports/shared-mutation-lock.mjs').MutationLockOptions} [options]
 * @returns {T}
 */
export function withSharedMutationLock(file, operation, options = {}) {
    return locks.withLock(file, operation, options);
}

/**
 * @template T
 * @param {string} file
 * @param {()=>T|Promise<T>} operation
 * @param {Omit<import('../ports/shared-mutation-lock.mjs').MutationLockOptions,'reclaimStale'>} [options]
 * @returns {Promise<T>}
 */
export async function withSharedMutationLockAsync(file, operation, options = {}) {
    return locks.withLockAsync(file, operation, options);
}
