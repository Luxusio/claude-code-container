import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { ownerId } from "../context.mjs";

function leaseFile(backend) {
    return join(homedir(), ".ccc/devices/physical-leases", `${backend}.json`);
}

function lockFile(backend, hardwareId) {
    return join(homedir(), ".ccc/devices/physical-leases", backend, "locks", `${encodeURIComponent(hardwareId)}.json`);
}

export function readPhysicalLeases(backend) {
    const file = leaseFile(backend);
    if (!existsSync(file)) return [];
    try {
        const parsed = JSON.parse(readFileSync(file, "utf-8"));
        return Array.isArray(parsed.leases) ? parsed.leases : [];
    } catch {
        return [];
    }
}

export function writePhysicalLeases(backend, leases) {
    const file = leaseFile(backend);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ leases }, null, 2), { mode: 0o600 });
}

export function claimPhysicalLease(backend, hardwareId, deviceId) {
    const owner = ownerId();
    const lock = lockFile(backend, hardwareId);
    const lease = {
        backend,
        hardwareId,
        ownerId: owner,
        deviceId,
        claimedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    mkdirSync(dirname(lock), { recursive: true });
    try {
        const fd = openSync(lock, "wx", 0o600);
        try {
            writeFileSync(fd, JSON.stringify(lease, null, 2));
        } finally {
            closeSync(fd);
        }
    } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        let existing = null;
        try {
            existing = JSON.parse(readFileSync(lock, "utf-8"));
        } catch {
            existing = { backend, hardwareId, ownerId: "unknown", deviceId: null };
        }
        if (existing.ownerId !== owner) return { ok: false, conflict: existing };
        return { ok: true, lease: existing };
    }

    const leases = readPhysicalLeases(backend);
    writePhysicalLeases(backend, [...leases, lease]);
    return { ok: true, lease };
}

export function releasePhysicalLease(backend, hardwareId, deviceId) {
    const owner = ownerId();
    const lock = lockFile(backend, hardwareId);
    try {
        const existing = JSON.parse(readFileSync(lock, "utf-8"));
        if (existing.ownerId === owner && (!deviceId || existing.deviceId === deviceId)) unlinkSync(lock);
    } catch {
        /* ignore missing or unreadable lock */
    }
    const leases = readPhysicalLeases(backend);
    const remaining = leases.filter((lease) => {
        if (lease.hardwareId !== hardwareId) return true;
        if (lease.ownerId !== owner) return true;
        if (deviceId && lease.deviceId !== deviceId) return true;
        return false;
    });
    if (remaining.length !== leases.length) writePhysicalLeases(backend, remaining);
    return remaining.length !== leases.length;
}
