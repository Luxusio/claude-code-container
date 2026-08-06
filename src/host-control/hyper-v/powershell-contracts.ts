import type { HyperVCommandOptions } from "./contracts.js";
import { assertIdentity, ownershipMarker } from "./core.js";

export type HyperVOwnedVmContractV1 = {
    schemaVersion: 1;
    vmId: string;
    vmName: string;
    ownershipMarker: string;
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
