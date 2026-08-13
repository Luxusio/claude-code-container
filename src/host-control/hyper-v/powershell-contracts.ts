import type { HyperVCommandOptions } from "./contracts.js";
import { assertIdentity, ownershipMarker } from "./core.js";

export type HyperVOwnedVmContractV1 = {
    schemaVersion: 1;
    vmId: string;
    vmName: string;
    ownershipMarker: string;
};

export type HyperVSnapshotCreateContractV1 = HyperVOwnedVmContractV1 & {
    snapshotName: string;
};

export type HyperVSnapshotRepairContractV1 = HyperVSnapshotCreateContractV1 & {
    expectedCheckpointPolicy: "Production" | "ProductionOnly";
};

export function hyperVOwnedVmContractV1(options: HyperVCommandOptions): HyperVOwnedVmContractV1 {
    assertIdentity(options);
    if (!options.vmId) throw new Error("hyper-v-vm-id-missing");
    return {
        schemaVersion: 1,
        vmId: options.vmId.toLowerCase(),
        vmName: options.vmName,
        ownershipMarker: ownershipMarker(options.ownerId, options.deviceId, options.incarnationId),
    };
}

export function hyperVSnapshotCreateContractV1(
    options: HyperVCommandOptions,
    snapshotName: string,
): HyperVSnapshotCreateContractV1 {
    return { ...hyperVOwnedVmContractV1(options), snapshotName };
}

export function hyperVSnapshotRepairContractV1(
    options: HyperVCommandOptions,
    snapshotName: string,
    expectedCheckpointPolicy: "Production" | "ProductionOnly",
): HyperVSnapshotRepairContractV1 {
    return { ...hyperVSnapshotCreateContractV1(options, snapshotName), expectedCheckpointPolicy };
}
