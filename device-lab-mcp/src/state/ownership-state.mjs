import { readDeviceLabStateFile } from "./state-file.mjs";

function objectRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("expected object");
    return value;
}

function validDate(value) {
    return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export function validatePhysicalLease(value, backend, hardwareId) {
    const lease = objectRecord(value);
    if (typeof lease.backend !== "string" || !lease.backend
        || typeof lease.hardwareId !== "string" || !lease.hardwareId
        || typeof lease.ownerId !== "string" || !lease.ownerId
        || (lease.deviceId !== null && lease.deviceId !== undefined && (typeof lease.deviceId !== "string" || !lease.deviceId))
        || (lease.ttlMs !== undefined && (!Number.isInteger(lease.ttlMs) || lease.ttlMs <= 0))
        || (lease.updatedAt !== undefined && !validDate(lease.updatedAt))
        || (lease.expiresAt !== undefined && !validDate(lease.expiresAt))
        || (lease.claimId !== undefined && (typeof lease.claimId !== "string" || !lease.claimId))
        || (lease.claimNonce !== undefined && (typeof lease.claimNonce !== "string" || !lease.claimNonce))
        || (backend !== undefined && lease.backend !== backend)
        || (hardwareId !== undefined && lease.hardwareId !== hardwareId)) {
        throw new TypeError("invalid physical lease");
    }
    return lease;
}

export function readPhysicalLeaseStateFile(file, backend, hardwareId) {
    return readDeviceLabStateFile(file, (value) => validatePhysicalLease(value, backend, hardwareId), "physical-lease");
}

export function validatePhysicalLeaseAggregate(value, backend) {
    const aggregate = objectRecord(value);
    if (!Array.isArray(aggregate.leases)) throw new TypeError("invalid physical lease aggregate");
    for (const lease of aggregate.leases) validatePhysicalLease(lease, backend);
    return aggregate.leases;
}

export function readPhysicalLeaseAggregateStateFile(file, backend) {
    const leases = readDeviceLabStateFile(file, (value) => validatePhysicalLeaseAggregate(value, backend), "physical-lease-aggregate");
    return leases ?? [];
}

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
    return lock;
}

export function readWindowsSandboxLockStateFile(file) {
    return readDeviceLabStateFile(file, validateWindowsSandboxLock, "windows-sandbox-lock");
}
