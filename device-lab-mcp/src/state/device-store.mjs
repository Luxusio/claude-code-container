import { createHash } from "crypto";
import { AsyncLocalStorage } from "async_hooks";
import { homedir } from "os";
import { join } from "path";
import { isDeepStrictEqual } from "util";
import { ownerId } from "../context.mjs";
import { assertOwnerDeviceStateWritable, readOwnerDeviceStateFile } from "./owner-device-state.mjs";
import { withSharedMutationLock, withSharedMutationLockAsync, writeJsonFileAtomically } from "./shared-mutation-lock.mjs";

const ownerDeviceOperationContext = new AsyncLocalStorage();

export function ownerStateDir(backend) {
    return join(homedir(), ".ccc/devices/owners", ownerId(), backend);
}

export function ownerStateFile(backend) {
    return join(ownerStateDir(backend), "devices.json");
}

export function ownerStateMutationLockFile(backend) {
    return join(ownerStateDir(backend), "devices.mutation.lock");
}

export function ownerDeviceOperationLockFile(backend, deviceId) {
    if (typeof deviceId !== "string" || !deviceId) throw new TypeError("Owner device operation requires a device id");
    const key = createHash("sha256").update(deviceId).digest("hex").slice(0, 32);
    return join(ownerStateDir(backend), "operations", `${key}.lock`);
}

export function withOwnerDeviceOperation(backend, deviceId, operation, options = {}) {
    if (typeof operation !== "function") throw new TypeError("Owner device operation requires a callback");
    const lockFile = ownerDeviceOperationLockFile(backend, deviceId);
    const inherited = ownerDeviceOperationContext.getStore();
    if (inherited?.get(lockFile)?.active) return Promise.resolve().then(operation);
    return withSharedMutationLockAsync(lockFile, () => {
        const token = { active: true };
        const context = new Map(inherited || []);
        context.set(lockFile, token);
        return ownerDeviceOperationContext.run(context, async () => {
            try {
                return await operation();
            } finally {
                token.active = false;
            }
        });
    }, {
        waitMs: options.waitMs ?? 30000,
        staleMs: options.staleMs ?? 15 * 60 * 1000,
    });
}

export function withOwnerDeviceOperations(backend, deviceIds, operation, options = {}) {
    if (!Array.isArray(deviceIds) || deviceIds.some((deviceId) => typeof deviceId !== "string" || !deviceId)) {
        throw new TypeError("Owner device operations require device ids");
    }
    if (typeof operation !== "function") throw new TypeError("Owner device operations require a callback");
    const ordered = [...new Set(deviceIds)].sort();
    const acquire = (index) => index >= ordered.length
        ? Promise.resolve().then(operation)
        : withOwnerDeviceOperation(backend, ordered[index], () => acquire(index + 1), options);
    return acquire(0);
}

export function readOwnerDevices(backend) {
    return readOwnerDeviceStateFile(ownerStateFile(backend));
}

function assertUniqueOwnerDeviceIds(devices) {
    const ids = new Set();
    for (const device of devices) {
        const id = device && typeof device === "object" ? device.id : null;
        if (typeof id !== "string" || !id) continue;
        if (ids.has(id)) {
            const error = new Error(`Owner device state contains duplicate id: ${id}`);
            error.code = "owner-device-id-conflict";
            error.deviceId = id;
            throw error;
        }
        ids.add(id);
    }
}

export function writeOwnerDevices(backend, devices) {
    return withSharedMutationLock(ownerStateMutationLockFile(backend), () => {
        if (!Array.isArray(devices)) throw new TypeError("Owner device state must be an array");
        readOwnerDevices(backend);
        assertUniqueOwnerDeviceIds(devices);
        assertOwnerDeviceStateWritable(devices);
        writeJsonFileAtomically(ownerStateFile(backend), { devices });
        return devices;
    });
}

export function mutateOwnerDevices(backend, updater) {
    return withSharedMutationLock(ownerStateMutationLockFile(backend), () => {
        const current = readOwnerDevices(backend);
        const next = updater(current);
        if (!Array.isArray(next)) throw new TypeError("Owner device mutation must return an array");
        assertUniqueOwnerDeviceIds(next);
        assertOwnerDeviceStateWritable(next);
        writeJsonFileAtomically(ownerStateFile(backend), { devices: next });
        return next;
    });
}

export function claimOwnerDevice(backend, device, uniqueFields = ["id"]) {
    if (!device || typeof device !== "object" || Array.isArray(device)) {
        throw new TypeError("Owner device claim requires a device object");
    }
    if (!Array.isArray(uniqueFields) || uniqueFields.length === 0 || uniqueFields.some((selector) => {
        const fields = Array.isArray(selector) ? selector : [selector];
        return fields.length === 0 || fields.some((field) => typeof field !== "string" || !field);
    })) {
        throw new TypeError("Owner device claim requires at least one unique field");
    }
    return withSharedMutationLock(ownerStateMutationLockFile(backend), () => {
        const devices = readOwnerDevices(backend);
        for (const selector of uniqueFields) {
            const fields = Array.isArray(selector) ? selector : [selector];
            const values = fields.map((field) => device[field]);
            if (values.some((value) => value === null || value === undefined || value === "")) continue;
            const existing = devices.find((candidate) => candidate && typeof candidate === "object" && fields.every((field, index) => candidate[field] === values[index]));
            if (existing) {
                const field = fields.join("+");
                const value = fields.length === 1 ? values[0] : Object.fromEntries(fields.map((key, index) => [key, values[index]]));
                return {
                    ok: false,
                    error: field === "id" ? "owner-device-id-conflict" : "owner-device-identity-conflict",
                    field,
                    value,
                    existing,
                };
            }
        }
        const next = [...devices, device];
        assertOwnerDeviceStateWritable(next);
        writeJsonFileAtomically(ownerStateFile(backend), { devices: next });
        return { ok: true, device };
    });
}

export function findOwnerDevice(backend, id) {
    return readOwnerDevices(backend).find((device) => device.id === id);
}

export function updateOwnerDevice(backend, id, updater) {
    let updated = null;
    mutateOwnerDevices(backend, (devices) => devices.map((device) => {
        if (device.id !== id) return device;
        updated = updater(device);
        return updated;
    }));
    return updated;
}

export function transitionOwnerDeviceRecord(backend, id, expected, replacement) {
    let found = false;
    let matched = false;
    let currentDevice = null;
    let updatedDevice = null;
    mutateOwnerDevices(backend, (devices) => devices.flatMap((device) => {
        if (device.id !== id) return [device];
        found = true;
        currentDevice = device;
        if (!isDeepStrictEqual(device, expected)) return [device];
        matched = true;
        updatedDevice = typeof replacement === "function" ? replacement(device) : replacement;
        return updatedDevice === null ? [] : [updatedDevice];
    }));
    return { found, matched, currentDevice, device: updatedDevice };
}
