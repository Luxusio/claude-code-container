import type { LabStatePrincipal } from "../../domain/container/lab-state-ownership.js";
import type { LabStateOwnershipPorts } from "../../ports/container/lab-state-ownership.js";

export function createLabStateOwnershipPreparation(ports: LabStateOwnershipPorts) {
    for (const name of [
        "normalizeImageId", "listVolumeNames", "observeVolumeUsers",
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
        const listed = ports.listVolumeNames();
        if (listed.error || listed.status !== 0) throw new Error("Unable to inspect lab state volumes.");
        if (!listed.stdout.split("\n").includes(volume)) return;
        const users = ports.observeVolumeUsers(volume);
        if (users.error || users.status !== 0 || users.stdout.trim()) throw new Error(`Lab state volume ${volume} may be in use; finish its running work before retrying.`);
        const scope = ports.captureHelperScope();
        let oldUid = identity.uid;
        let oldGid = identity.gid;
        if (previousImage) {
            const old = ports.observePreviousAccount(scope, previousImage);
            const match = !old.error && old.status === 0 ? /^(\d+):(\d+)$/.exec(old.stdout.trim()) : null;
            if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0 || Number(match[1]) >= 0xffffffff || Number(match[2]) >= 0xffffffff) throw new Error(`Cannot establish previous lab state owner for ${volume}; no ownership was changed.`);
            oldUid = Number(match[1]);
            oldGid = Number(match[2]);
        }
        const intent = previousImage
            ? { kind: "migrate" as const, oldUid, oldGid }
            : { kind: "verify" as const };
        const repaired = ports.applyOwnership(scope, volume, imageId, identity, intent);
        if (repaired.error || repaired.status !== 0) throw new Error(`Lab state ownership preparation failed for ${volume}. Existing data was retained; repair its ownership before retrying.`);
    }

    return { run };
}
