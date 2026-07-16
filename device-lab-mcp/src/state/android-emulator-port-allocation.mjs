import { createHash } from "crypto";
import { lstatSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { readOwnerDeviceStateFile } from "./owner-device-state.mjs";
import { withSharedMutationLockAsync } from "./shared-mutation-lock.mjs";

export const ANDROID_EMULATOR_PORT_MIN = 5554;
export const ANDROID_EMULATOR_PORT_MAX = 5682;

const ANDROID_EMULATOR_PORT_LOCK_WAIT_MS = 30000;
const ANDROID_EMULATOR_PORT_LOCK_STALE_MS = 15 * 60 * 1000;

export class DeviceProjectEnumerationError extends Error {
    constructor(cause) {
        super("project-namespace-read-failed", cause === undefined ? undefined : { cause });
        this.name = "DeviceProjectEnumerationError";
        this.code = "project-namespace-read-failed";
    }
}

function deviceStateRoot() {
    return join(homedir(), ".ccc", "devices");
}

export function androidEmulatorPortAllocationLockFile() {
    return join(deviceStateRoot(), "broker", "locks", "android-emulator-ports.mutation.lock");
}

function enumerateProjectIds(root) {
    let rootObserved = false;
    try {
        const before = lstatSync(root);
        rootObserved = true;
        if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("invalid-project-namespace-root");
        const entries = readdirSync(root, { withFileTypes: true });
        if (entries.some((entry) => entry.isSymbolicLink())) throw new Error("linked-project-namespace");
        const after = lstatSync(root);
        if (!after.isDirectory()
            || after.isSymbolicLink()
            || before.dev !== after.dev
            || before.ino !== after.ino
            || before.mode !== after.mode) {
            throw new Error("project-namespace-root-changed");
        }
        return entries
            .filter((entry) => entry.isDirectory() && /^[a-f0-9]{16}$/.test(entry.name))
            .map((entry) => entry.name)
            .sort();
    } catch (error) {
        if (!rootObserved && error?.code === "ENOENT") return [];
        if (error instanceof DeviceProjectEnumerationError) throw error;
        throw new DeviceProjectEnumerationError(error);
    }
}

export function validAndroidEmulatorPort(port) {
    return Number.isInteger(port)
        && port >= ANDROID_EMULATOR_PORT_MIN
        && port <= ANDROID_EMULATOR_PORT_MAX
        && port % 2 === 0;
}

function allocatedAndroidEmulatorPorts() {
    const ports = new Set();
    const ownersRoot = join(deviceStateRoot(), "owners");
    for (const projectId of enumerateProjectIds(ownersRoot)) {
        const devices = readOwnerDeviceStateFile(join(ownersRoot, projectId, "android", "devices.json"));
        for (const device of devices) {
            if (validAndroidEmulatorPort(device.port)) ports.add(device.port);
        }
    }
    return ports;
}

export function resolveAndroidEmulatorPort(projectId, deviceId, requestedPort, additionalUsedPorts = []) {
    if (requestedPort !== undefined && !validAndroidEmulatorPort(requestedPort)) {
        return {
            ok: false,
            error: "invalid-android-emulator-port",
            allowed: `even integer ${ANDROID_EMULATOR_PORT_MIN}-${ANDROID_EMULATOR_PORT_MAX}`,
        };
    }

    let used;
    try {
        used = allocatedAndroidEmulatorPorts();
    } catch (error) {
        return {
            ok: false,
            error: "android-emulator-port-inventory-unavailable",
            detail: error?.code || "android-emulator-port-inventory-read-failed",
        };
    }
    for (const port of additionalUsedPorts) {
        if (validAndroidEmulatorPort(port)) used.add(port);
    }

    if (requestedPort !== undefined) {
        return used.has(requestedPort)
            ? { ok: false, error: "android-emulator-port-conflict", detail: `port-${requestedPort}-already-allocated` }
            : { ok: true, port: requestedPort };
    }

    const slotCount = ((ANDROID_EMULATOR_PORT_MAX - ANDROID_EMULATOR_PORT_MIN) / 2) + 1;
    const initialSlot = Number.parseInt(createHash("sha256").update(`${projectId}\0${deviceId}`).digest("hex").slice(0, 8), 16) % slotCount;
    for (let offset = 0; offset < slotCount; offset += 1) {
        const port = ANDROID_EMULATOR_PORT_MIN + (((initialSlot + offset) % slotCount) * 2);
        if (!used.has(port)) return { ok: true, port };
    }
    return { ok: false, error: "android-emulator-port-pool-exhausted" };
}

export function withAndroidEmulatorPortAllocation(operation) {
    return withSharedMutationLockAsync(androidEmulatorPortAllocationLockFile(), operation, {
        waitMs: ANDROID_EMULATOR_PORT_LOCK_WAIT_MS,
        staleMs: ANDROID_EMULATOR_PORT_LOCK_STALE_MS,
    });
}
