import type {
    LabOwnershipApplication,
    LabOwnershipHelperScope,
    LabPreviousPrincipal,
    LabStateOwnershipIntent,
    LabStatePrincipal,
    LabVolumePresence,
    LabVolumeUse,
} from "../../domain/container/lab-state-ownership.js";

export interface LabStateOwnershipPorts {
    normalizeImageId(imageId: string): string;
    observeVolume(volume: string): LabVolumePresence;
    observeVolumeUsers(volume: string): LabVolumeUse;
    captureHelperScope(): LabOwnershipHelperScope;
    observePreviousAccount(scope: LabOwnershipHelperScope, imageId: string): LabPreviousPrincipal;
    applyOwnership(
        scope: LabOwnershipHelperScope,
        volume: string,
        imageId: string,
        principal: LabStatePrincipal,
        intent: LabStateOwnershipIntent,
    ): LabOwnershipApplication;
}
