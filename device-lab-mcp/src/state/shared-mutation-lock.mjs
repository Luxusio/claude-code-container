import { randomUUID } from "crypto";
import { chmodSync, closeSync, constants as fsConstants, copyFileSync, fchmodSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, writeFileSync, writeSync } from "fs";
import { hostname, uptime } from "os";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "path";
import { inspectProcessIdentity, processIdentityMatches, readProcessIdentity, readProcessIdentityAsync } from "./process-identity.mjs";
import { DeviceLabStateFileError, readDeviceLabStateFile, withDeviceLabReadableFile } from "./state-file.mjs";

const DEFAULT_WAIT_MS = 5000;
const DEFAULT_STALE_MS = 30000;
const POLL_MS = 10;
const MALFORMED_STALE_MS = 1000;
const ATOMIC_RENAME_WAIT_MS = 2000;
const ABANDONED_ATOMIC_TEMP_MIN_AGE_MS = 100;
const SHARED_MUTATION_LOCK_FILE_LIMIT_BYTES = 16 * 1024;
const PROCESS_IDENTITY_OBSERVATION_CACHE_MS = 1000;
const PROCESS_IDENTITY_UNAVAILABLE_CACHE_MS = 30 * 1000;
const PROCESS_IDENTITY_OBSERVATION_MAP_LIMIT = 128;
const PROCESS_IDENTITY_OBSERVATION_CONCURRENCY = 4;
const PROCESS_IDENTITY_RETRY_MS = 60 * 1000;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
let ownLockProcessIdentity;
let ownLockProcessIdentityRetryAt = 0;
let ownLockProcessIdentityPromise = null;
const cachedLockProcessObservations = new Map();
const pendingLockProcessObservations = new Map();
const processIdentityObservationWaiters = [];
let activeProcessIdentityObservations = 0;

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

function invalidStateDirectory(path) {
    const error = new Error(`Unsafe device-lab state directory: ${path}`);
    error.code = "device-lab-state-directory-invalid";
    return error;
}

function assertStateDirectoriesUnchanged(identities) {
    for (const identity of identities) {
        let current;
        try {
            current = lstatSync(identity.path);
        } catch (error) {
            throw invalidStateDirectory(`${identity.path}: ${error?.code || "missing"}`);
        }
        if (!sameDirectory(identity.stats, current)) throw invalidStateDirectory(identity.path);
    }
}

function secureStateParentDirectory(file) {
    const identities = [];
    for (const path of managedDirectoryComponents(file)) {
        assertStateDirectoriesUnchanged(identities);
        let stats;
        try {
            stats = lstatSync(path);
        } catch (error) {
            if (error?.code !== "ENOENT") throw error;
            try {
                mkdirSync(path, { mode: 0o700 });
            } catch (mkdirError) {
                if (mkdirError?.code !== "EEXIST") throw mkdirError;
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

function sleepSync(ms) {
    Atomics.wait(sleeper, 0, 0, ms);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function renameReplacingFileSync(source, destination, validateDirectories = () => {}) {
    const deadline = Date.now() + ATOMIC_RENAME_WAIT_MS;
    while (true) {
        try {
            validateDirectories();
            renameSync(source, destination);
            validateDirectories();
            return;
        } catch (error) {
            if (!["EACCES", "EBUSY", "EEXIST", "EPERM"].includes(error?.code) || Date.now() >= deadline) throw error;
            sleepSync(POLL_MS);
        }
    }
}

function removeAbandonedAtomicTemporaryFiles(file, validateDirectories = () => {}) {
    const directory = dirname(file);
    const base = basename(file);
    const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^${escapedBase}\\.(\\d+)\\.(?:[a-f0-9]{16}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\\.tmp$`, "i");
    let entries;
    try {
        validateDirectories();
        entries = readdirSync(directory);
    } catch {
        return;
    }
    for (const entry of entries) {
        const match = entry.match(pattern);
        if (!match || processIsAlive(Number(match[1]))) continue;
        const candidate = join(directory, entry);
        try {
            validateDirectories();
            const stats = lstatSync(candidate);
            if (!stats.isFile() || stats.isSymbolicLink() || Date.now() - stats.mtimeMs < ABANDONED_ATOMIC_TEMP_MIN_AGE_MS) continue;
            validateDirectories();
            rmSync(candidate, { force: true });
            validateDirectories();
        } catch {
            // A concurrent writer may already have removed or replaced the candidate.
        }
    }
}

export function writeFileAtomically(file, value) {
    const directories = secureStateParentDirectory(file);
    const validateDirectories = () => assertStateDirectoriesUnchanged(directories);
    removeAbandonedAtomicTemporaryFiles(file, validateDirectories);
    validateDirectories();
    const temporaryFile = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
        writeFileSync(temporaryFile, value, { flag: "wx", mode: 0o600 });
        validateDirectories();
        renameReplacingFileSync(temporaryFile, file, validateDirectories);
    } finally {
        validateDirectories();
        rmSync(temporaryFile, { force: true });
        validateDirectories();
    }
}

export function writeJsonFileAtomically(file, value) {
    writeFileAtomically(file, JSON.stringify(value, null, 2));
}

export function copyFileAtomically(source, destination, options) {
    const prefix = options?.prefix || "device-lab-copy";
    const limitBytes = options?.limitBytes;
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) throw new TypeError("limitBytes must be a non-negative safe integer");
    const directories = secureStateParentDirectory(destination);
    const validateDirectories = () => assertStateDirectoriesUnchanged(directories);
    validateDirectories();
    const temporaryFile = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    let output = null;
    try {
        const copied = withDeviceLabReadableFile(source, prefix, limitBytes, (input) => {
            validateDirectories();
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
        validateDirectories();
        renameReplacingFileSync(temporaryFile, destination, validateDirectories);
        try { chmodSync(destination, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
        return copied;
    } finally {
        if (output !== null) closeSync(output);
        validateDirectories();
        rmSync(temporaryFile, { force: true });
        validateDirectories();
    }
}

function readLock(file) {
    try {
        return readDeviceLabStateFile(file, (value) => {
            if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-shared-mutation-lock");
            if (!validLockToken(value.token)
                || !Number.isInteger(value.pid) || value.pid <= 0
                || typeof value.host !== "string" || value.host.length < 1 || value.host.length > 255
                || (value.bootId !== undefined && (typeof value.bootId !== "string" || value.bootId.length > 512))
                || (value.createdAt !== undefined && (typeof value.createdAt !== "string" || value.createdAt.length > 64))
                || (value.processIdentityStatus !== undefined && !["recorded", "unavailable"].includes(value.processIdentityStatus))
                || (value.processIdentity !== undefined && !validLockProcessIdentity(value.processIdentity, value.pid))
                || (value.processIdentityStatus === "recorded" && value.processIdentity === undefined)
                || (value.processIdentity !== undefined && value.processIdentityStatus === "unavailable")) {
                throw new Error("invalid-shared-mutation-lock");
            }
            return value;
        }, "shared-mutation-lock", SHARED_MUTATION_LOCK_FILE_LIMIT_BYTES);
    } catch {
        return null;
    }
}

function validLockToken(value) {
    return typeof value === "string" && /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(value);
}

function validLockProcessIdentity(value, pid) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value)
        && value.pid === pid
        && typeof value.startToken === "string" && value.startToken.length >= 1 && value.startToken.length <= 512
        && typeof value.commandHash === "string" && /^[a-f0-9]{64}$/i.test(value.commandHash));
}

function fileAgeMs(file) {
    try {
        return Math.max(0, Date.now() - lstatSync(file).mtimeMs);
    } catch {
        return 0;
    }
}

function processIsAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error?.code === "EPERM";
    }
}

function currentBootId() {
    try {
        return readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
    } catch {
        return `${hostname()}:${Math.floor((Date.now() - uptime() * 1000) / 1000)}`;
    }
}

function sameBootIdentity(left, right) {
    if (left === right) return true;
    const leftMatch = typeof left === "string" ? left.match(/^(.*):(\d+)$/) : null;
    const rightMatch = typeof right === "string" ? right.match(/^(.*):(\d+)$/) : null;
    return Boolean(leftMatch && rightMatch
        && leftMatch[1] === rightMatch[1]
        && Math.abs(Number(leftMatch[2]) - Number(rightMatch[2])) <= 5);
}

function currentLockProcessIdentity() {
    // Keep synchronous broker paths free of PowerShell/CIM process probes.
    // Async provider locks collect the same identity without blocking Node.
    if (process.platform === "win32") return null;
    if (ownLockProcessIdentity === undefined
        || (ownLockProcessIdentity === null && Date.now() >= ownLockProcessIdentityRetryAt)) {
        ownLockProcessIdentity = readProcessIdentity(process.pid);
        ownLockProcessIdentityRetryAt = ownLockProcessIdentity ? 0 : Date.now() + PROCESS_IDENTITY_RETRY_MS;
    }
    return ownLockProcessIdentity;
}

async function currentLockProcessIdentityAsync() {
    if (ownLockProcessIdentity) return ownLockProcessIdentity;
    if (ownLockProcessIdentity === null && Date.now() < ownLockProcessIdentityRetryAt) return null;
    if (!ownLockProcessIdentityPromise) {
        ownLockProcessIdentityPromise = withProcessIdentityObservationSlot(
            () => readProcessIdentityAsync(process.pid),
        ).then((identity) => {
            ownLockProcessIdentity = identity;
            ownLockProcessIdentityRetryAt = identity ? 0 : Date.now() + PROCESS_IDENTITY_RETRY_MS;
            return identity;
        }).finally(() => {
            ownLockProcessIdentityPromise = null;
        });
    }
    return ownLockProcessIdentityPromise;
}

function lockRecord(token) {
    const processIdentity = currentLockProcessIdentity();
    return {
        token,
        pid: process.pid,
        host: hostname(),
        bootId: currentBootId(),
        createdAt: new Date().toISOString(),
        processIdentityStatus: processIdentity ? "recorded" : "unavailable",
        ...(processIdentity ? { processIdentity } : {}),
    };
}

async function lockRecordAsync(token) {
    const processIdentity = await currentLockProcessIdentityAsync();
    return {
        token,
        pid: process.pid,
        host: hostname(),
        bootId: currentBootId(),
        createdAt: new Date().toISOString(),
        processIdentityStatus: processIdentity ? "recorded" : "unavailable",
        ...(processIdentity ? { processIdentity } : {}),
    };
}

function lockProcessObservationStatus(lock) {
    const key = JSON.stringify([lock.pid, lock.processIdentity]);
    const now = Date.now();
    const cached = cachedLockProcessObservations.get(key);
    if (cached && now - cached.checkedAt < PROCESS_IDENTITY_OBSERVATION_CACHE_MS) {
        return cached.status;
    }
    const status = inspectProcessIdentity(lock.processIdentity, lock.pid).status;
    cacheLockProcessObservation(key, status);
    return status;
}

function cacheLockProcessObservation(key, status) {
    cachedLockProcessObservations.delete(key);
    cachedLockProcessObservations.set(key, { checkedAt: Date.now(), status });
    while (cachedLockProcessObservations.size > PROCESS_IDENTITY_OBSERVATION_MAP_LIMIT) {
        const oldest = cachedLockProcessObservations.keys().next().value;
        if (oldest === undefined) break;
        cachedLockProcessObservations.delete(oldest);
    }
}

async function withProcessIdentityObservationSlot(operation) {
    if (activeProcessIdentityObservations < PROCESS_IDENTITY_OBSERVATION_CONCURRENCY) {
        activeProcessIdentityObservations += 1;
    } else {
        await new Promise((resolve) => processIdentityObservationWaiters.push(resolve));
    }
    try {
        return await operation();
    } finally {
        const next = processIdentityObservationWaiters.shift();
        if (next) next();
        else activeProcessIdentityObservations -= 1;
    }
}

async function lockProcessObservationStatusAsync(lock) {
    const key = JSON.stringify([lock.pid, lock.processIdentity]);
    const now = Date.now();
    const cached = cachedLockProcessObservations.get(key);
    const cacheMs = cached?.status === "unavailable"
        ? PROCESS_IDENTITY_UNAVAILABLE_CACHE_MS
        : PROCESS_IDENTITY_OBSERVATION_CACHE_MS;
    if (cached && now - cached.checkedAt < cacheMs) {
        return cached.status;
    }
    const pending = pendingLockProcessObservations.get(key);
    if (pending) return pending;
    if (pendingLockProcessObservations.size >= PROCESS_IDENTITY_OBSERVATION_MAP_LIMIT) {
        cacheLockProcessObservation(key, "unavailable");
        return "unavailable";
    }
    const promise = (async () => {
        const current = await withProcessIdentityObservationSlot(() => readProcessIdentityAsync(lock.pid));
        const status = current
            ? (processIdentityMatches(lock.processIdentity, current) ? "match" : "mismatch")
            : (processIsAlive(lock.pid) ? "unavailable" : "exited");
        cacheLockProcessObservation(key, status);
        return status;
    })().finally(() => {
        if (pendingLockProcessObservations.get(key) === promise) pendingLockProcessObservations.delete(key);
    });
    pendingLockProcessObservations.set(key, promise);
    return promise;
}

function lockIsStale(file, lock, staleMs) {
    const ageMs = fileAgeMs(file);
    if (ageMs < 100) return false;
    if (!lock) return ageMs >= Math.min(staleMs, MALFORMED_STALE_MS);
    if (lock.bootId && !sameBootIdentity(lock.bootId, currentBootId())) return true;
    if (lock.host === hostname() && Number.isInteger(lock.pid)) {
        if (!processIsAlive(lock.pid)) return true;
        if (lock.processIdentity) {
            if (process.platform === "win32") return false;
            const status = lockProcessObservationStatus(lock);
            return status === "mismatch" || status === "exited";
        }
        return false;
    }
    return ageMs >= staleMs;
}

async function lockIsStaleAsync(file, lock, staleMs) {
    const ageMs = fileAgeMs(file);
    if (ageMs < 100) return false;
    if (!lock) return ageMs >= Math.min(staleMs, MALFORMED_STALE_MS);
    if (lock.bootId && !sameBootIdentity(lock.bootId, currentBootId())) return true;
    if (lock.host === hostname() && Number.isInteger(lock.pid)) {
        if (!processIsAlive(lock.pid)) return true;
        if (lock.processIdentity) {
            const status = await lockProcessObservationStatusAsync(lock);
            return status === "mismatch" || status === "exited";
        }
        return false;
    }
    return ageMs >= staleMs;
}

function restoreMovedLockIfPathEmpty(moved, file) {
    try {
        linkSync(moved, file);
        rmSync(moved, { force: true });
        return;
    } catch (error) {
        if (error?.code === "EEXIST") return;
    }
    try {
        copyFileSync(moved, file, fsConstants.COPYFILE_EXCL);
        rmSync(moved, { force: true });
    } catch {
        // A current lock won the path, or restoration is unsupported. Preserve the moved record for diagnostics.
    }
}

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

export function withSharedMutationLock(file, operation, options = {}) {
    const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
    const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
    const deadline = Date.now() + waitMs;
    const token = randomUUID();
    const directories = secureStateParentDirectory(file);
    const validateDirectories = () => assertStateDirectoriesUnchanged(directories);

    while (true) {
        try {
            validateDirectories();
            const fd = openSync(file, "wx", 0o600);
            try {
                writeFileSync(fd, JSON.stringify(lockRecord(token)));
            } finally {
                closeSync(fd);
            }
            validateDirectories();
            break;
        } catch (error) {
            if (error?.code !== "EEXIST") throw error;
            const existing = readLock(file);
            if (existing?.token && lockIsStale(file, existing, staleMs)) {
                if (moveIfTokenMatches(file, existing.token, "stale", validateDirectories)) continue;
            }
            if (!existing && lockIsStale(file, existing, staleMs)) {
                if (moveMalformedLock(file, token, validateDirectories)) continue;
            }
            if (Date.now() >= deadline) {
                const error = new Error(`Timed out acquiring shared mutation lock: ${file}`);
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

export async function withSharedMutationLockAsync(file, operation, options = {}) {
    const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
    const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
    const deadline = Date.now() + waitMs;
    const token = randomUUID();
    const directories = secureStateParentDirectory(file);
    const validateDirectories = () => assertStateDirectoriesUnchanged(directories);
    const record = await lockRecordAsync(token);

    while (true) {
        try {
            validateDirectories();
            const fd = openSync(file, "wx", 0o600);
            try {
                writeFileSync(fd, JSON.stringify(record));
            } finally {
                closeSync(fd);
            }
            validateDirectories();
            break;
        } catch (error) {
            if (error?.code !== "EEXIST") throw error;
            const existing = readLock(file);
            if (existing?.token && await lockIsStaleAsync(file, existing, staleMs)) {
                if (moveIfTokenMatches(file, existing.token, "stale", validateDirectories)) continue;
            }
            if (!existing && await lockIsStaleAsync(file, existing, staleMs)) {
                if (moveMalformedLock(file, token, validateDirectories)) continue;
            }
            if (Date.now() >= deadline) {
                const error = new Error(`Timed out acquiring shared mutation lock: ${file}`);
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
