import { readDeviceLabStateFile } from "./device-lab-state-file.js";

export type PhysicalLeaseRecord = Record<string, unknown>;

function objectRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("expected object");
    return value as Record<string, unknown>;
}

function validDate(value: unknown): value is string {
    return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export function validatePhysicalLease(value: unknown, backend?: string, hardwareId?: string): PhysicalLeaseRecord {
    const lease = objectRecord(value);
    if (typeof lease.backend !== "string" || !lease.backend
        || typeof lease.hardwareId !== "string" || !lease.hardwareId
        || typeof lease.ownerId !== "string" || !lease.ownerId
        || (lease.deviceId !== null && lease.deviceId !== undefined && (typeof lease.deviceId !== "string" || !lease.deviceId))
        || (lease.ttlMs !== undefined && (!Number.isInteger(lease.ttlMs) || Number(lease.ttlMs) <= 0))
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

export function readPhysicalLeaseStateFile(file: string, backend?: string, hardwareId?: string): PhysicalLeaseRecord | null {
    return readDeviceLabStateFile(file, (value) => validatePhysicalLease(value, backend, hardwareId), "physical-lease");
}

export function validateWindowsSandboxLock(value: unknown): Record<string, unknown> {
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

export function readWindowsSandboxLockStateFile(file: string): Record<string, unknown> | null {
    return readDeviceLabStateFile(file, validateWindowsSandboxLock, "windows-sandbox-lock");
}
