import type {
    LabOwnershipHelperScope,
    LabStateCommandObservation,
    LabStateOwnershipIntent,
    LabStateOwnershipObservation,
    LabStatePrincipal,
} from "../../domain/container/lab-state-ownership.js";

export interface LabStateOwnershipPorts {
    normalizeImageId(imageId: string): string;
    listVolumeNames(): LabStateCommandObservation;
    observeVolumeUsers(volume: string): LabStateCommandObservation;
    captureHelperScope(): LabOwnershipHelperScope;
    observePreviousAccount(scope: LabOwnershipHelperScope, imageId: string): LabStateCommandObservation;
    applyOwnership(
        scope: LabOwnershipHelperScope,
        volume: string,
        imageId: string,
        principal: LabStatePrincipal,
        intent: LabStateOwnershipIntent,
    ): LabStateOwnershipObservation;
}
