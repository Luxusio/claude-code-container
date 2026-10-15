import type { ContainerIdentity } from "./container-identity.js";
import { createLabStateOwnershipPreparation } from "./application/container/lab-state-ownership.js";
import { createNativeLabStateOwnershipPorts } from "./adapters/lab-state-ownership.js";

/** Caller holds the shared startup lock; only this exact named volume is mounted. */
export function prepareLabStateOwnership(volume: string, imageId: string, identity: ContainerIdentity, previousImage?: string): void {
    createLabStateOwnershipPreparation(createNativeLabStateOwnershipPorts()).run(volume, imageId, identity, previousImage);
}
