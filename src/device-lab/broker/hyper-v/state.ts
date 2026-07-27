import { existsSync, lstatSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { assertDeviceLabPathWithinRoot, readDeviceLabStateFile } from "../../../device-lab-state-file.js";
import { quarantineAndRemoveDirectory, type QuarantinedCleanupError } from "../../../device-lab-safe-cleanup.js";
import { writeJsonFileAtomically } from "../../../device-lab-shared-state.js";

export type HyperVIncarnationRecord = {
    version: 1;
    ownerId: string;
    backend: "windows-vm" | "linux-vm";
    deviceId: string;
    incarnationId: string;
    createdAt: string;
};

function isHyperVBackend(
    backend: string,
): backend is "windows-vm" | "linux-vm" {
    return backend === "windows-vm" || backend === "linux-vm";
}

function brokerPrivateRoot(): string {
    return join(homedir(), ".ccc/device-broker-private");
}

function assertNoSymlinkPathComponents(file: string, label: string): void {
    const chain: string[] = [];
    let current = resolve(file);
    while (true) {
        chain.push(current);
        const parent = resolve(current, "..");
        if (parent === current) break;
        current = parent;
    }
    for (const component of chain.reverse()) {
        try {
            if (lstatSync(component).isSymbolicLink()) {
                throw new Error(`${label}-path-symlink-rejected`);
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === "ENOENT") break;
            throw error;
        }
    }
}

export function hyperVPrivateDeviceRoot(
    ownerId: string,
    backend: string,
    deviceId: string,
): string {
    return join(brokerPrivateRoot(), "owners", ownerId, backend, deviceId);
}

export function hyperVDeviceRoot(
    ownerId: string,
    backend: string,
    deviceId: string,
): string {
    return join(hyperVPrivateDeviceRoot(ownerId, backend, deviceId), "artifacts");
}

export function ensureHyperVPrivateDeviceRoot(
    ownerId: string,
    backend: string,
    deviceId: string,
): string {
    const root = hyperVPrivateDeviceRoot(ownerId, backend, deviceId);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    return assertHyperVPrivateDeviceRoot(ownerId, backend, deviceId, root);
}

export function assertHyperVPrivateDeviceRoot(
    ownerId: string,
    backend: string,
    deviceId: string,
    root: string,
): string {
    const expected = hyperVPrivateDeviceRoot(ownerId, backend, deviceId);
    if (resolve(root) !== resolve(expected)) {
        throw new Error("hyper-v-private-root-invalid");
    }
    assertNoSymlinkPathComponents(root, "hyper-v-private-root");
    const metadata = lstatSync(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error("hyper-v-private-root-invalid");
    }
    return root;
}

export function validHyperVIncarnationId(value: unknown): value is string {
    return typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
}

function hyperVIncarnationPath(
    ownerId: string,
    backend: string,
    deviceId: string,
): string {
    return join(
        hyperVPrivateDeviceRoot(ownerId, backend, deviceId),
        "incarnation.json",
    );
}

export function readHyperVIncarnationRecord(
    ownerId: string,
    backend: string,
    deviceId: string,
): HyperVIncarnationRecord | null {
    if (!isHyperVBackend(backend)) throw new Error("hyper-v-backend-invalid");
    return readDeviceLabStateFile(
        hyperVIncarnationPath(ownerId, backend, deviceId),
        (parsed) => {
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                throw new Error("hyper-v-incarnation-record-invalid");
            }
            const value = parsed as Record<string, unknown>;
            if (value.version !== 1
                || value.ownerId !== ownerId
                || value.backend !== backend
                || value.deviceId !== deviceId
                || !validHyperVIncarnationId(value.incarnationId)
                || typeof value.createdAt !== "string"
                || Number.isNaN(Date.parse(value.createdAt))) {
                throw new Error("hyper-v-incarnation-record-invalid");
            }
            return value as HyperVIncarnationRecord;
        },
        "hyper-v-incarnation-record",
        4096,
    );
}

export function writeHyperVIncarnationRecord(
    ownerId: string,
    backend: string,
    deviceId: string,
    incarnationId: string,
): HyperVIncarnationRecord {
    if (!isHyperVBackend(backend) || !validHyperVIncarnationId(incarnationId)) {
        throw new Error("hyper-v-incarnation-record-invalid");
    }
    ensureHyperVPrivateDeviceRoot(ownerId, backend, deviceId);
    const record: HyperVIncarnationRecord = {
        version: 1,
        ownerId,
        backend,
        deviceId,
        incarnationId,
        createdAt: new Date().toISOString(),
    };
    writeJsonFileAtomically(
        hyperVIncarnationPath(ownerId, backend, deviceId),
        record,
    );
    return record;
}

export function hyperVDeviceIncarnationId(
    device: Record<string, unknown>,
): string | null {
    return validHyperVIncarnationId(device.incarnationId)
        ? device.incarnationId
        : null;
}

export function cleanupHyperVDeviceArtifacts(
    ownerId: string,
    backend: string,
    deviceId: string,
) {
    if (!isHyperVBackend(backend)) {
        return {
            ok: false,
            removed: false,
            deviceRoot: "",
            error: "hyper-v-backend-invalid",
        };
    }
    const backendRoot = join(brokerPrivateRoot(), "owners", ownerId, backend);
    const privateRoot = hyperVPrivateDeviceRoot(ownerId, backend, deviceId);
    try {
        if (!existsSync(privateRoot)) {
            return {
                ok: true,
                removed: false,
                deviceRoot: hyperVDeviceRoot(ownerId, backend, deviceId),
                privateRoot,
            };
        }
        assertNoSymlinkPathComponents(backendRoot, "hyper-v-device-artifacts");
        assertNoSymlinkPathComponents(privateRoot, "hyper-v-device-artifacts");
        assertDeviceLabPathWithinRoot(
            backendRoot,
            privateRoot,
            "hyper-v-device-artifacts",
        );
        quarantineAndRemoveDirectory(privateRoot, (candidate) => {
            assertNoSymlinkPathComponents(
                backendRoot,
                "hyper-v-device-artifacts",
            );
            assertNoSymlinkPathComponents(
                candidate,
                "hyper-v-device-artifacts",
            );
            assertDeviceLabPathWithinRoot(
                backendRoot,
                candidate,
                "hyper-v-device-artifacts",
            );
        });
        return {
            ok: true,
            removed: true,
            deviceRoot: hyperVDeviceRoot(ownerId, backend, deviceId),
            privateRoot,
        };
    } catch (error) {
        const quarantineRoot = (error as QuarantinedCleanupError).quarantineRoot;
        return {
            ok: false,
            removed: false,
            deviceRoot: hyperVDeviceRoot(ownerId, backend, deviceId),
            privateRoot,
            ...(quarantineRoot ? { quarantineRoot } : {}),
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
