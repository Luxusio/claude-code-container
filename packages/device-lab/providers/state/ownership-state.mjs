import { readDeviceLabStateFile } from "./state-file.mjs";

/** @typedef {import('../ports/physical-leases.mjs').PhysicalLease} PhysicalLease */
/** @typedef {{provider:'windows-sandbox',ownerId:string,deviceId:string,claimId?:string,bootId?:string,sandboxId?:string|null} & Record<string,unknown>} WindowsSandboxLock */

/** @param {unknown} value @returns {Record<string,unknown>} */
function objectRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("expected object");
    return /** @type {Record<string,unknown>} */ (value);
}

/** @param {unknown} value @returns {value is string} */
function validDate(value) {
    return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/** @param {unknown} value @param {string} [backend] @param {string} [hardwareId] @returns {PhysicalLease} */
export function validatePhysicalLease(value, backend, hardwareId) {
    const lease = objectRecord(value);
    if (typeof lease.backend !== "string" || !lease.backend
        || typeof lease.hardwareId !== "string" || !lease.hardwareId
        || typeof lease.ownerId !== "string" || !lease.ownerId
        || (lease.deviceId !== null && lease.deviceId !== undefined && (typeof lease.deviceId !== "string" || !lease.deviceId))
        || (lease.ttlMs !== undefined && (typeof lease.ttlMs !== "number" || !Number.isInteger(lease.ttlMs) || lease.ttlMs <= 0))
        || (lease.updatedAt !== undefined && !validDate(lease.updatedAt))
        || (lease.expiresAt !== undefined && !validDate(lease.expiresAt))
        || (lease.claimId !== undefined && (typeof lease.claimId !== "string" || !lease.claimId))
        || (lease.claimNonce !== undefined && (typeof lease.claimNonce !== "string" || !lease.claimNonce))
        || (backend !== undefined && lease.backend !== backend)
        || (hardwareId !== undefined && lease.hardwareId !== hardwareId)) {
        throw new TypeError("invalid physical lease");
    }
    // The checks above establish every validated field; other metadata remains unvalidated.
    return /** @type {PhysicalLease & Record<string,unknown>} */ (lease);
}

/** @param {string} file @param {string} [backend] @param {string} [hardwareId] @returns {PhysicalLease|null} */
export function readPhysicalLeaseStateFile(file, backend, hardwareId) {
    return readDeviceLabStateFile(file, (value) => validatePhysicalLease(value, backend, hardwareId), "physical-lease");
}

/** @param {unknown} value @param {string} [backend] @returns {PhysicalLease[]} */
export function validatePhysicalLeaseAggregate(value, backend) {
    const aggregate = objectRecord(value);
    if (!Array.isArray(aggregate.leases)) throw new TypeError("invalid physical lease aggregate");
    for (const lease of aggregate.leases) validatePhysicalLease(lease, backend);
    return /** @type {PhysicalLease[]} */ (aggregate.leases);
}

/** @param {string} file @param {string} [backend] @returns {PhysicalLease[]} */
export function readPhysicalLeaseAggregateStateFile(file, backend) {
    const leases = readDeviceLabStateFile(file, (value) => validatePhysicalLeaseAggregate(value, backend), "physical-lease-aggregate");
    return leases ?? [];
}

/** @param {unknown} value @returns {WindowsSandboxLock} */
export function validateWindowsSandboxLock(value) {
    const lock = objectRecord(value);
    if (lock.provider !== "windows-sandbox"
        || typeof lock.ownerId !== "string" || !lock.ownerId
        || typeof lock.deviceId !== "string" || !lock.deviceId
        || (lock.claimId !== undefined && (typeof lock.claimId !== "string" || !lock.claimId))
        || (lock.bootId !== undefined && (typeof lock.bootId !== "string" || !lock.bootId))
        || (lock.sandboxId !== null && lock.sandboxId !== undefined && (typeof lock.sandboxId !== "string" || !lock.sandboxId))) {
        throw new TypeError("invalid Windows Sandbox lock");
    }
    return /** @type {WindowsSandboxLock} */ (lock);
}

/** @param {string} file @returns {WindowsSandboxLock|null} */
export function readWindowsSandboxLockStateFile(file) {
    return readDeviceLabStateFile(file, validateWindowsSandboxLock, "windows-sandbox-lock");
}
