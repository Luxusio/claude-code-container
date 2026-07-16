import { randomUUID } from "crypto";
import { lstatSync, mkdirSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { ownerId } from "../context.mjs";
import { readPhysicalLeaseAggregateStateFile, readPhysicalLeaseStateFile, validatePhysicalLease, validatePhysicalLeaseAggregate } from "./ownership-state.mjs";
import { withSharedMutationLock, writeJsonFileAtomically } from "./shared-mutation-lock.mjs";
import { DeviceLabStateFileError } from "./state-file.mjs";

const DEFAULT_PHYSICAL_LEASE_TTL_MS = 60 * 60 * 1000;
const MIN_PHYSICAL_LEASE_TTL_MS = 30 * 1000;
const MAX_PHYSICAL_LEASE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PHYSICAL_LEASE_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

const heartbeatTimers = new Map();

function stateRoot() {
    return join(homedir(), ".ccc/devices");
}

function physicalLeaseRoot() {
    return join(stateRoot(), "physical-leases");
}

function leaseDirectoryError(detail, cause) {
    return new DeviceLabStateFileError(detail, cause ? { cause } : undefined);
}

function leaseDirectoryChain(backend, includeLocks) {
    const directories = [stateRoot(), physicalLeaseRoot()];
    if (includeLocks) directories.push(join(physicalLeaseRoot(), backend), join(physicalLeaseRoot(), backend, "locks"));
    return directories;
}

function inspectLeaseDirectoryChain(backend, includeLocks) {
    for (const directory of leaseDirectoryChain(backend, includeLocks)) {
        let stat;
        try {
            stat = lstatSync(directory);
        } catch (error) {
            if (error?.code === "ENOENT") return false;
            throw leaseDirectoryError("physical-lease-directory-read-failed", error);
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw leaseDirectoryError("physical-lease-directory-path-invalid");
        }
    }
    return true;
}

function ensureLeaseDirectoryChain(backend, includeLocks) {
    const root = stateRoot();
    for (const directory of leaseDirectoryChain(backend, includeLocks)) {
        try {
            mkdirSync(directory, { recursive: directory === root, mode: 0o700 });
        } catch (error) {
            if (error?.code !== "EEXIST") throw leaseDirectoryError("physical-lease-directory-create-failed", error);
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

function leaseFile(backend) {
    return join(homedir(), ".ccc/devices/physical-leases", `${backend}.json`);
}

function lockFile(backend, hardwareId) {
    return join(homedir(), ".ccc/devices/physical-leases", backend, "locks", `${encodeURIComponent(hardwareId)}.json`);
}

function mutationLockFile(backend, hardwareId) {
    return join(homedir(), ".ccc/devices/physical-leases", backend, "locks", `${encodeURIComponent(hardwareId)}.mutation.lock`);
}

function aggregateMutationLockFile(backend) {
    return join(homedir(), ".ccc/devices/physical-leases", `${backend}.mutation.lock`);
}

export function readPhysicalLeases(backend) {
    if (!inspectLeaseDirectoryChain(backend, false)) return [];
    return readPhysicalLeaseAggregateStateFile(leaseFile(backend), backend);
}

function writePhysicalLeasesUnlocked(backend, leases) {
    validatePhysicalLeaseAggregate({ leases }, backend);
    writeJsonFileAtomically(leaseFile(backend), { leases });
}

function normalizedTtlMs(ttlMs) {
    if (ttlMs === undefined || ttlMs === null) return DEFAULT_PHYSICAL_LEASE_TTL_MS;
    if (!Number.isInteger(ttlMs) || ttlMs < MIN_PHYSICAL_LEASE_TTL_MS || ttlMs > MAX_PHYSICAL_LEASE_TTL_MS) return null;
    return ttlMs;
}

function expiresAt(updatedAt, ttlMs) {
    return new Date(new Date(updatedAt).getTime() + ttlMs).toISOString();
}

function leaseTtlMs(lease) {
    return Number.isInteger(lease?.ttlMs) && lease.ttlMs > 0 ? lease.ttlMs : DEFAULT_PHYSICAL_LEASE_TTL_MS;
}

function leaseExpiresAt(lease) {
    if (typeof lease?.expiresAt === "string" && !Number.isNaN(Date.parse(lease.expiresAt))) return lease.expiresAt;
    const updatedAt = typeof lease?.updatedAt === "string" && !Number.isNaN(Date.parse(lease.updatedAt)) ? lease.updatedAt : new Date(0).toISOString();
    return expiresAt(updatedAt, leaseTtlMs(lease));
}

function leaseExpired(lease, nowMs = Date.now()) {
    return Date.parse(leaseExpiresAt(lease)) <= nowMs;
}

function withExpiry(lease, ttlMs = leaseTtlMs(lease), now = new Date().toISOString()) {
    return {
        ...lease,
        ttlMs,
        heartbeatAt: now,
        updatedAt: now,
        expiresAt: expiresAt(now, ttlMs),
    };
}

function readLock(lock, backend, hardwareId) {
    if (!inspectLeaseDirectoryChain(backend, true)) return null;
    return readPhysicalLeaseStateFile(lock, backend, hardwareId);
}

function heartbeatKey(backend, hardwareId, deviceId) {
    return `${backend}\0${hardwareId}\0${deviceId || ""}`;
}

function heartbeatIntervalMs(ttlMs, intervalMs) {
    if (Number.isInteger(intervalMs) && intervalMs > 0) return intervalMs;
    return Math.max(10 * 1000, Math.min(DEFAULT_PHYSICAL_LEASE_HEARTBEAT_INTERVAL_MS, Math.floor(ttlMs / 3)));
}

function writeLock(lock, lease) {
    validatePhysicalLease(lease);
    writeJsonFileAtomically(lock, lease);
}

function removeAggregateLease(backend, owner, hardwareId, deviceId) {
    try {
        return withSharedMutationLock(aggregateMutationLockFile(backend), () => {
            const leases = readPhysicalLeases(backend);
            const remaining = leases.filter((lease) => {
                if (lease.hardwareId !== hardwareId) return true;
                if (lease.ownerId !== owner) return true;
                if (deviceId && lease.deviceId !== deviceId) return true;
                return false;
            });
            if (remaining.length !== leases.length) writePhysicalLeasesUnlocked(backend, remaining);
            return remaining.length !== leases.length;
        });
    } catch (error) {
        if (error instanceof DeviceLabStateFileError) return false;
        throw error;
    }
}

function upsertAggregateLease(backend, lease) {
    try {
        withSharedMutationLock(aggregateMutationLockFile(backend), () => {
            const leases = readPhysicalLeases(backend)
                .filter((entry) => !(entry.hardwareId === lease.hardwareId && entry.ownerId === lease.ownerId));
            writePhysicalLeasesUnlocked(backend, [...leases, lease]);
        });
        return true;
    } catch (error) {
        if (error instanceof DeviceLabStateFileError) return false;
        throw error;
    }
}

export function prunePhysicalLeases(backend) {
    const owner = ownerId();
    const leases = readPhysicalLeases(backend);
    const pruned = [];
    if (leases.length > 0) ensureLeaseDirectoryChain(backend, true);
    for (const lease of leases) {
        if (lease.ownerId !== owner || !leaseExpired(lease)) continue;
        withSharedMutationLock(mutationLockFile(backend, lease.hardwareId), () => {
            const current = readLock(lockFile(backend, lease.hardwareId), backend, lease.hardwareId);
            if (current?.ownerId === owner && leaseExpired(current)) {
                try { unlinkSync(lockFile(backend, lease.hardwareId)); } catch { /* ignore missing lock */ }
                pruned.push({ ...current, expired: true, expiresAt: leaseExpiresAt(current) });
            }
            if (!current || current.ownerId !== owner || leaseExpired(current)) {
                removeAggregateLease(backend, owner, lease.hardwareId, lease.deviceId);
            } else {
                upsertAggregateLease(backend, current);
            }
        });
    }
    return pruned;
}

export function claimPhysicalLease(backend, hardwareId, deviceId, options = {}) {
    const owner = ownerId();
    const ttlMs = normalizedTtlMs(options.ttlMs);
    if (ttlMs === null) return { ok: false, error: "invalid-lease-ttl-ms" };
    ensureLeaseDirectoryChain(backend, true);
    const lock = lockFile(backend, hardwareId);
    const now = new Date().toISOString();
    return withSharedMutationLock(mutationLockFile(backend, hardwareId), () => {
        const existing = readLock(lock, backend, hardwareId);
        if (existing && !leaseExpired(existing)) {
            if (existing.ownerId !== owner) return { ok: false, conflict: existing };
            if (deviceId && existing.deviceId && existing.deviceId !== deviceId) {
                return { ok: false, error: "physical-lease-device-mismatch", conflict: existing };
            }
            if (options.claimNonce && existing.claimNonce !== options.claimNonce) {
                return { ok: false, error: "physical-lease-operation-conflict", conflict: existing };
            }
            const refreshed = withExpiry(existing, ttlMs, now);
            writeLock(lock, refreshed);
            upsertAggregateLease(backend, refreshed);
            return { ok: true, lease: refreshed, reused: true, heartbeat: true };
        }
        if (existing) removeAggregateLease(backend, existing.ownerId, hardwareId, existing.deviceId);
        const expiringLease = withExpiry({
            backend,
            hardwareId,
            ownerId: owner,
            deviceId,
            claimId: randomUUID(),
            ...(options.claimNonce ? { claimNonce: options.claimNonce } : {}),
            claimedAt: now,
        }, ttlMs, now);
        writeLock(lock, expiringLease);
        upsertAggregateLease(backend, expiringLease);
        return { ok: true, lease: expiringLease };
    });
}

export function startPhysicalLeaseHeartbeat(backend, hardwareId, deviceId, options = {}) {
    const ttlMs = normalizedTtlMs(options.ttlMs);
    if (ttlMs === null) return { ok: false, error: "invalid-lease-ttl-ms" };
    const key = heartbeatKey(backend, hardwareId, deviceId);
    stopPhysicalLeaseHeartbeat(backend, hardwareId, deviceId);
    const timer = setInterval(() => {
        const result = heartbeatPhysicalLease(backend, hardwareId, deviceId, {
            ttlMs,
            claimId: options.claimId,
            claimNonce: options.claimNonce,
        });
        if (!result.ok) stopPhysicalLeaseHeartbeat(backend, hardwareId, deviceId);
    }, heartbeatIntervalMs(ttlMs, options.intervalMs));
    timer.unref?.();
    heartbeatTimers.set(key, timer);
    return { ok: true, heartbeatManaged: true, intervalMs: heartbeatIntervalMs(ttlMs, options.intervalMs), ttlMs };
}

export function stopPhysicalLeaseHeartbeat(backend, hardwareId, deviceId) {
    const key = heartbeatKey(backend, hardwareId, deviceId);
    const timer = heartbeatTimers.get(key);
    if (!timer) return false;
    clearInterval(timer);
    heartbeatTimers.delete(key);
    return true;
}

export function heartbeatPhysicalLease(backend, hardwareId, deviceId, options = {}) {
    const owner = ownerId();
    const ttlMs = normalizedTtlMs(options.ttlMs);
    if (ttlMs === null) return { ok: false, error: "invalid-lease-ttl-ms" };
    ensureLeaseDirectoryChain(backend, true);
    const lock = lockFile(backend, hardwareId);
    return withSharedMutationLock(mutationLockFile(backend, hardwareId), () => {
        const existing = readLock(lock, backend, hardwareId);
        if (!existing) return { ok: false, error: "physical-lease-not-found" };
        if (existing.ownerId !== owner) {
            if (leaseExpired(existing)) {
                try { unlinkSync(lock); } catch { /* ignore */ }
                removeAggregateLease(backend, existing.ownerId, hardwareId, existing.deviceId);
                return { ok: false, error: "physical-lease-expired", pruned: true, lease: existing };
            }
            return { ok: false, conflict: existing };
        }
        if (deviceId && existing.deviceId && existing.deviceId !== deviceId) {
            return { ok: false, error: "physical-lease-device-mismatch", lease: existing };
        }
        if (options.claimId && existing.claimId !== options.claimId) {
            return { ok: false, error: "physical-lease-claim-mismatch", lease: existing };
        }
        if (options.claimNonce && existing.claimNonce !== options.claimNonce) {
            return { ok: false, error: "physical-lease-operation-mismatch", lease: existing };
        }
        if (leaseExpired(existing)) {
            try { unlinkSync(lock); } catch { /* ignore */ }
            removeAggregateLease(backend, owner, hardwareId, deviceId);
            return { ok: false, error: "physical-lease-expired", pruned: true, lease: existing };
        }
        const refreshed = withExpiry(existing, ttlMs);
        writeLock(lock, refreshed);
        upsertAggregateLease(backend, refreshed);
        return { ok: true, lease: refreshed, heartbeat: true };
    });
}

export function releasePhysicalLease(backend, hardwareId, deviceId, options = {}) {
    const owner = ownerId();
    ensureLeaseDirectoryChain(backend, true);
    const lock = lockFile(backend, hardwareId);
    return withSharedMutationLock(mutationLockFile(backend, hardwareId), () => {
        const existing = readLock(lock, backend, hardwareId);
        if (existing?.ownerId !== owner || (deviceId && existing.deviceId !== deviceId)) return false;
        if (options.claimId && existing.claimId !== options.claimId) return false;
        if (options.claimNonce && existing.claimNonce !== options.claimNonce) return false;
        stopPhysicalLeaseHeartbeat(backend, hardwareId, deviceId);
        try { unlinkSync(lock); } catch { /* ignore missing lock */ }
        removeAggregateLease(backend, owner, hardwareId, deviceId);
        return true;
    });
}
