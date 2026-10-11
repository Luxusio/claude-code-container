import { randomUUID } from "crypto";
import { createPhysicalLeases } from "../application/physical-leases.mjs";
import { lstatSync, mkdirSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { ownerId } from "../context.mjs";
import { readPhysicalLeaseAggregateStateFile, readPhysicalLeaseStateFile, validatePhysicalLease, validatePhysicalLeaseAggregate } from "./ownership-state.mjs";
import { withSharedMutationLock, writeJsonFileAtomically } from "./shared-mutation-lock.mjs";
import { DeviceLabStateFileError } from "./state-file.mjs";



/** @returns {string} */
function stateRoot() {
    return join(homedir(), ".ccc/devices");
}

/** @returns {string} */
function physicalLeaseRoot() {
    return join(stateRoot(), "physical-leases");
}

/** @param {string} detail @param {unknown} [cause] @returns {DeviceLabStateFileError} */
function leaseDirectoryError(detail, cause) {
    return new DeviceLabStateFileError(detail, cause ? { cause } : undefined);
}

/** @param {string} backend @param {boolean} includeLocks @returns {string[]} */
function leaseDirectoryChain(backend, includeLocks) {
    const directories = [stateRoot(), physicalLeaseRoot()];
    if (includeLocks) directories.push(join(physicalLeaseRoot(), backend), join(physicalLeaseRoot(), backend, "locks"));
    return directories;
}

/** @param {string} backend @param {boolean} includeLocks @returns {boolean} */
function inspectLeaseDirectoryChain(backend, includeLocks) {
    for (const directory of leaseDirectoryChain(backend, includeLocks)) {
        let stat;
        try {
            stat = lstatSync(directory);
        } catch (error) {
            if (nativeErrorCode(error) === "ENOENT") return false;
            throw leaseDirectoryError("physical-lease-directory-read-failed", error);
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw leaseDirectoryError("physical-lease-directory-path-invalid");
        }
    }
    return true;
}

/** @param {string} backend @param {boolean} includeLocks @returns {undefined} */
function ensureLeaseDirectoryChain(backend, includeLocks) {
    const root = stateRoot();
    for (const directory of leaseDirectoryChain(backend, includeLocks)) {
        try {
            mkdirSync(directory, { recursive: directory === root, mode: 0o700 });
        } catch (error) {
            if (nativeErrorCode(error) !== "EEXIST") throw leaseDirectoryError("physical-lease-directory-create-failed", error);
        }
        let stat;
        try {
            stat = lstatSync(directory);
        } catch (error) {
            throw leaseDirectoryError("physical-lease-directory-read-failed", error);
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw leaseDirectoryError("physical-lease-directory-path-invalid");
        }
    }
}

/** @param {string} backend @returns {string} */
function leaseFile(backend) {
    return join(homedir(), ".ccc/devices/physical-leases", `${backend}.json`);
}

/** @param {string} backend @param {string} hardwareId @returns {string} */
function lockFile(backend, hardwareId) {
    return join(homedir(), ".ccc/devices/physical-leases", backend, "locks", `${encodeURIComponent(hardwareId)}.json`);
}

/** @param {string} backend @param {string} hardwareId @returns {string} */
function mutationLockFile(backend, hardwareId) {
    return join(homedir(), ".ccc/devices/physical-leases", backend, "locks", `${encodeURIComponent(hardwareId)}.mutation.lock`);
}

/** @param {string} backend @returns {string} */
function aggregateMutationLockFile(backend) {
    return join(homedir(), ".ccc/devices/physical-leases", `${backend}.mutation.lock`);
}

/** @param {string} backend @returns {import('../ports/physical-leases.mjs').PhysicalLease[]} */
function nativeReadPhysicalLeases(backend) {
    if (!inspectLeaseDirectoryChain(backend, false)) return [];
    return readPhysicalLeaseAggregateStateFile(leaseFile(backend), backend);
}

/** @param {string} backend @param {import('../ports/physical-leases.mjs').PhysicalLease[]} leases @returns {undefined} */
function writePhysicalLeasesUnlocked(backend, leases) {
    validatePhysicalLeaseAggregate({ leases }, backend);
    writeJsonFileAtomically(leaseFile(backend), { leases });
}







/** @param {string} lock @param {string} backend @param {string} hardwareId
 * @returns {import('../ports/physical-leases.mjs').PhysicalLease|null} */
function readLock(lock, backend, hardwareId) {
    if (!inspectLeaseDirectoryChain(backend, true)) return null;
    return readPhysicalLeaseStateFile(lock, backend, hardwareId);
}



/** @param {string} lock @param {import('../ports/physical-leases.mjs').PhysicalLease} lease @returns {undefined} */
function writeLock(lock, lease) {
    validatePhysicalLease(lease);
    writeJsonFileAtomically(lock, lease);
}







/** @template T @param {string} backend @param {string} hardwareId
 * @param {(state:import('../ports/physical-leases.mjs').PhysicalLeaseTransaction)=>T} operation
 * @param {{waitBudget?:{remaining():number}}} [options] @returns {T} */
function withLeaseTransaction(backend, hardwareId, operation, options = {}) {
    ensureLeaseDirectoryChain(backend, true);
    const lock = lockFile(backend, hardwareId);
    return withSharedMutationLock(mutationLockFile(backend, hardwareId), () =>
        withSharedMutationLock(aggregateMutationLockFile(backend), () => {
            const lease = readLock(lock, backend, hardwareId);
            const leases = nativeReadPhysicalLeases(backend);
            return operation({ lease, leases,
                writeAggregate: next => { writePhysicalLeasesUnlocked(backend, next); return undefined; },
                writeLease: next => { writeLock(lock, next); return undefined; },
                removeLease: () => {
                    try { unlinkSync(lock); } catch (error) { if (nativeErrorCode(error) !== "ENOENT") throw error; }
                    return undefined;
                },
            });
        }, options), options);
}

/** @param {unknown} error @returns {string|undefined} */
function nativeErrorCode(error) {
    return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
/** @type {import('../ports/physical-leases.mjs').PhysicalLeasePorts<ReturnType<typeof setInterval>>} */
const physicalLeasePorts = {
    owner: () => ownerId(),
    now: () => Date.now(),
    timestamp: () => new Date().toISOString(),
    iso: milliseconds => new Date(milliseconds).toISOString(),
    claimId: () => randomUUID(),
    read: nativeReadPhysicalLeases,
    ensure: backend => { ensureLeaseDirectoryChain(backend, true); return undefined; },
    withTransaction: withLeaseTransaction,
    timeout: (backend, hardwareId) => Object.assign(new Error(`Timed out acquiring physical lease observation locks: ${backend}/${hardwareId}`), { code: "shared-mutation-lock-timeout" }),
    schedule: (operation, intervalMs) => ({ handle: setInterval(operation, intervalMs) }),
    unref: timer => { timer.unref?.(); return undefined; },
    clear: timer => { clearInterval(timer); return undefined; },
};
const directLeases = createPhysicalLeases(physicalLeasePorts);

export const readPhysicalLeases = directLeases.read;
export const prunePhysicalLeases = directLeases.prune;

export const claimPhysicalLease = directLeases.claim;

export const startPhysicalLeaseHeartbeat = directLeases.startHeartbeat;

export const stopPhysicalLeaseHeartbeat = directLeases.stopHeartbeat;

export const heartbeatPhysicalLease = directLeases.heartbeat;

export const releasePhysicalLease = directLeases.release;

export const releaseOwnedPhysicalLeaseResidue = directLeases.releaseResidue;

export const releasePhysicalLeaseWithMutation = directLeases.releaseWithMutation;
