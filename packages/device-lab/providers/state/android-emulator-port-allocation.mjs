import { addAndroidEmulatorUsedPorts, selectAndroidEmulatorPort, validateAndroidEmulatorPortRequest, validAndroidEmulatorPort } from "../domain/lifecycle/android-emulator-lifecycle.mjs";
export { ANDROID_EMULATOR_PORT_MIN, ANDROID_EMULATOR_PORT_MAX, validAndroidEmulatorPort } from "../domain/lifecycle/android-emulator-lifecycle.mjs";
import { createHash } from "crypto";
import { lstatSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { readOwnerDeviceStateFile } from "./owner-device-state.mjs";
import { withSharedMutationLockAsync } from "./shared-mutation-lock.mjs";

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
    const invalid = validateAndroidEmulatorPortRequest(requestedPort);
    if (invalid) return invalid;

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
    addAndroidEmulatorUsedPorts(used, additionalUsedPorts);
    const initialSeed = requestedPort === undefined
        ? Number.parseInt(createHash("sha256").update(`${projectId}\0${deviceId}`).digest("hex").slice(0, 8), 16)
        : undefined;
    return selectAndroidEmulatorPort(used, requestedPort, initialSeed);
}

export function withAndroidEmulatorPortAllocation(operation) {
    return withSharedMutationLockAsync(androidEmulatorPortAllocationLockFile(), operation, {
        waitMs: ANDROID_EMULATOR_PORT_LOCK_WAIT_MS,
        staleMs: ANDROID_EMULATOR_PORT_LOCK_STALE_MS,
    });
}
