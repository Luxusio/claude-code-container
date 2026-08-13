import { randomUUID } from "crypto";
import { mkdirSync, rmSync } from "fs";
import { dirname, join, resolve } from "path";
import { assertDeviceLabPathWithinRoot, readDeviceLabStateFile } from "../../../device-lab-state-file.js";
import { writeJsonFileAtomically } from "../../../device-lab-shared-state.js";
import { hyperVSnapshotName, hyperVVmName } from "../../../host-control/hyper-v/index.js";
import { hyperVBoundedErrorCode } from "./public-response.js";
import { validHyperVIncarnationId } from "./state.js";

export type HyperVSnapshotJournalTool =
    | "device_snapshot_create"
    | "device_snapshot_restore"
    | "device_snapshot_delete";

export type HyperVSnapshotJournal = {
    version: 1;
    operationId: string;
    ownerId: string;
    deviceId: string;
    incarnationId: string;
    tool: HyperVSnapshotJournalTool;
    snapshotName: string;
    providerName: string;
    snapshotId?: string;
    expectedCheckpointPolicy?: "Production" | "ProductionOnly";
    startedAt: string;
};

export type HyperVLifecycleJournalCommand =
    | "device_start"
    | "device_stop"
    | "device_reboot"
    | "device_delete";

export type HyperVOperationJournal = {
    version: 1;
    operationId: string;
    ownerId: string;
    deviceId: string;
    incarnationId: string;
    command: HyperVLifecycleJournalCommand;
    vmId: string;
    vmName: string;
    diskPath: string;
    startedAt: string;
};

export interface HyperVJournalPersistenceRuntime {
    deviceRoot(ownerId: string, backend: string, deviceId: string): string;
    ensurePrivateDeviceRoot(
        ownerId: string,
        backend: string,
        deviceId: string,
    ): string;
    readDevices(ownerId: string, stateKey: string): unknown[];
    journalLimitBytes: number;
}

export type HyperVOperationJournalWriteRequest = {
    backend: string;
    stateKey: string;
    command: string;
    deviceId: string;
};

function isHyperVBackend(
    backend: string,
): backend is "windows-vm" | "linux-vm" {
    return backend === "windows-vm" || backend === "linux-vm";
}

function isGuid(value: unknown): value is string {
    return typeof value === "string"
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function field(device: unknown, name: string): string | null {
    if (!device || typeof device !== "object" || Array.isArray(device)) return null;
    const value = (device as Record<string, unknown>)[name];
    return typeof value === "string" && value ? value : null;
}

export function hyperVSnapshotJournalPath(
    runtime: HyperVJournalPersistenceRuntime,
    ownerId: string,
    backend: string,
    deviceId: string,
): string {
    if (!isHyperVBackend(backend)) throw new Error("hyper-v-backend-invalid");
    return join(
        runtime.deviceRoot(ownerId, backend, deviceId),
        "snapshot-operation.json",
    );
}

export function readHyperVSnapshotJournal(
    runtime: HyperVJournalPersistenceRuntime,
    ownerId: string,
    backend: string,
    deviceId: string,
): HyperVSnapshotJournal | null {
    return readDeviceLabStateFile(
        hyperVSnapshotJournalPath(runtime, ownerId, backend, deviceId),
        (parsed) => {
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                throw new Error("hyper-v-snapshot-journal-invalid");
            }
            const value = parsed as Record<string, unknown>;
            if (value.version !== 1
                || !isGuid(value.operationId)
                || value.ownerId !== ownerId
                || value.deviceId !== deviceId
                || !validHyperVIncarnationId(value.incarnationId)
                || (value.tool !== "device_snapshot_create"
                    && value.tool !== "device_snapshot_restore"
                    && value.tool !== "device_snapshot_delete")
                || typeof value.snapshotName !== "string"
                || typeof value.providerName !== "string"
                || value.providerName
                    !== hyperVSnapshotName(ownerId, value.snapshotName)
                || (value.tool !== "device_snapshot_create"
                    && (typeof value.snapshotId !== "string"
                        || !isGuid(value.snapshotId)))
                || (value.expectedCheckpointPolicy !== undefined
                    && value.expectedCheckpointPolicy !== "Production"
                    && value.expectedCheckpointPolicy !== "ProductionOnly")
                || typeof value.startedAt !== "string") {
                throw new Error("hyper-v-snapshot-journal-invalid");
            }
            return value as HyperVSnapshotJournal;
        },
        "hyper-v-snapshot-journal",
        runtime.journalLimitBytes,
    );
}

export function writeHyperVSnapshotJournal(
    runtime: HyperVJournalPersistenceRuntime,
    ownerId: string,
    backend: string,
    deviceId: string,
    incarnationId: string,
    tool: HyperVSnapshotJournalTool,
    snapshotName: string,
    providerName: string,
    snapshotId?: string,
    expectedCheckpointPolicy?: "Production" | "ProductionOnly",
): void {
    if (!validHyperVIncarnationId(incarnationId)) {
        throw new Error("hyper-v-incarnation-id-invalid");
    }
    writeJsonFileAtomically(
        hyperVSnapshotJournalPath(runtime, ownerId, backend, deviceId),
        {
            version: 1,
            operationId: randomUUID(),
            ownerId,
            deviceId,
            incarnationId,
            tool,
            snapshotName,
            providerName,
            ...(snapshotId ? { snapshotId: snapshotId.toLowerCase() } : {}),
            ...(expectedCheckpointPolicy ? { expectedCheckpointPolicy } : {}),
            startedAt: new Date().toISOString(),
        } satisfies HyperVSnapshotJournal,
    );
}

export function clearHyperVSnapshotJournal(
    runtime: HyperVJournalPersistenceRuntime,
    ownerId: string,
    backend: string,
    deviceId: string,
): void {
    rmSync(hyperVSnapshotJournalPath(runtime, ownerId, backend, deviceId), {
        force: true,
    });
}

export function hyperVOperationJournalPath(
    runtime: HyperVJournalPersistenceRuntime,
    ownerId: string,
    backend: string,
    deviceId: string,
): string {
    if (!isHyperVBackend(backend)) throw new Error("hyper-v-backend-invalid");
    return join(runtime.deviceRoot(ownerId, backend, deviceId), "operation.json");
}

export function readHyperVOperationJournal(
    runtime: HyperVJournalPersistenceRuntime,
    ownerId: string,
    backend: string,
    deviceId: string,
): HyperVOperationJournal | null {
    return readDeviceLabStateFile(
        hyperVOperationJournalPath(runtime, ownerId, backend, deviceId),
        (parsed) => {
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                throw new Error("hyper-v-operation-journal-invalid");
            }
            const value = parsed as Record<string, unknown>;
            if (value.version !== 1
                || !isGuid(value.operationId)
                || value.ownerId !== ownerId
                || value.deviceId !== deviceId
                || !validHyperVIncarnationId(value.incarnationId)
                || (value.command !== "device_start"
                    && value.command !== "device_stop"
                    && value.command !== "device_reboot"
                    && value.command !== "device_delete")
                || !isGuid(value.vmId)
                || typeof value.vmName !== "string"
                || value.vmName !== hyperVVmName(
                    ownerId,
                    deviceId,
                    String(value.incarnationId),
                )
                || typeof value.diskPath !== "string"
                || typeof value.startedAt !== "string") {
                throw new Error("hyper-v-operation-journal-invalid");
            }
            const deviceRoot = runtime.deviceRoot(ownerId, backend, deviceId);
            assertDeviceLabPathWithinRoot(
                deviceRoot,
                value.diskPath,
                "hyper-v-operation-disk",
            );
            if (resolve(value.diskPath)
                !== resolve(join(deviceRoot, "disks", "root.vhdx"))) {
                throw new Error("hyper-v-operation-disk-mismatch");
            }
            return value as HyperVOperationJournal;
        },
        "hyper-v-operation-journal",
        runtime.journalLimitBytes,
    );
}

export function writeHyperVOperationJournal(
    runtime: HyperVJournalPersistenceRuntime,
    ownerId: string,
    request: HyperVOperationJournalWriteRequest,
): { ok: true; path: string } | { ok: false; error: string } {
    if (request.command !== "device_start"
        && request.command !== "device_stop"
        && request.command !== "device_reboot"
        && request.command !== "device_delete") {
        return { ok: false, error: "hyper-v-operation-command-invalid" };
    }
    try {
        const device = runtime.readDevices(ownerId, request.stateKey)
            .find((candidate) => candidate
                && typeof candidate === "object"
                && (candidate as Record<string, unknown>).id
                    === request.deviceId) as Record<string, unknown> | undefined;
        if (!device) throw new Error("hyper-v-operation-device-missing");
        const vmId = field(device, "vmId");
        const vmName = field(device, "vmName");
        const diskPath = field(device, "diskPath");
        const incarnationId = field(device, "incarnationId");
        if (!vmId
            || !isGuid(vmId)
            || !incarnationId
            || !validHyperVIncarnationId(incarnationId)
            || vmName !== hyperVVmName(
                ownerId,
                request.deviceId,
                incarnationId,
            )
            || !diskPath) {
            throw new Error("hyper-v-operation-device-metadata-invalid");
        }
        const journal: HyperVOperationJournal = {
            version: 1,
            operationId: randomUUID(),
            ownerId,
            deviceId: request.deviceId,
            incarnationId,
            command: request.command,
            vmId: vmId.toLowerCase(),
            vmName,
            diskPath,
            startedAt: new Date().toISOString(),
        };
        const path = hyperVOperationJournalPath(
            runtime,
            ownerId,
            request.backend,
            request.deviceId,
        );
        const privateRoot = runtime.ensurePrivateDeviceRoot(
            ownerId,
            request.backend,
            request.deviceId,
        );
        const journalRoot = dirname(path);
        assertDeviceLabPathWithinRoot(
            privateRoot,
            journalRoot,
            "hyper-v-operation-journal-root",
        );
        mkdirSync(journalRoot, { recursive: true, mode: 0o700 });
        writeJsonFileAtomically(path, journal);
        return { ok: true, path };
    } catch (error) {
        return {
            ok: false,
            error: hyperVBoundedErrorCode(
                error,
                "hyper-v-operation-journal-write-failed",
            ),
        };
    }
}

export function clearHyperVOperationJournal(
    runtime: HyperVJournalPersistenceRuntime,
    ownerId: string,
    backend: string,
    deviceId: string,
): void {
    rmSync(hyperVOperationJournalPath(runtime, ownerId, backend, deviceId), {
        force: true,
    });
}
