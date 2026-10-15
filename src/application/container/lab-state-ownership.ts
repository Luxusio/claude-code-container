import type { LabStatePrincipal } from "../../domain/container/lab-state-ownership.js";
import type { LabStateOwnershipPorts } from "../../ports/container/lab-state-ownership.js";

export function createLabStateOwnershipPreparation(ports: LabStateOwnershipPorts) {
    for (const name of [
        "normalizeImageId", "observeVolume", "observeVolumeUsers",
        "captureHelperScope", "observePreviousAccount", "applyOwnership",
    ] as const) {
        if (typeof ports?.[name] !== "function") {
            throw new TypeError(`Lab state ownership requires a callable ${name} port.`);
        }
    }

    function run(volume: string, imageId: string, identity: LabStatePrincipal, previousImage?: string): undefined {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(volume)) throw new Error("Invalid lab state volume name.");
        imageId = ports.normalizeImageId(imageId);
        if (previousImage) previousImage = ports.normalizeImageId(previousImage);
        const listed = ports.observeVolume(volume);
        if (listed === "unavailable") throw new Error("Unable to inspect lab state volumes.");
        if (listed === "absent") return;
        const users = ports.observeVolumeUsers(volume);
        if (users !== "idle") throw new Error(`Lab state volume ${volume} may be in use; finish its running work before retrying.`);
        const scope = ports.captureHelperScope();
        let oldUid = identity.uid;
        let oldGid = identity.gid;
        if (previousImage) {
            const old = ports.observePreviousAccount(scope, previousImage);
            if (old.kind !== "known") throw new Error(`Cannot establish previous lab state owner for ${volume}; no ownership was changed.`);
            oldUid = old.principal.uid;
            oldGid = old.principal.gid;
        }
        const intent = previousImage
            ? { kind: "migrate" as const, oldUid, oldGid }
            : { kind: "verify" as const };
        const repaired = ports.applyOwnership(scope, volume, imageId, identity, intent);
        if (repaired !== "applied") throw new Error(`Lab state ownership preparation failed for ${volume}. Existing data was retained; repair its ownership before retrying.`);
    }

    return { run };
}
