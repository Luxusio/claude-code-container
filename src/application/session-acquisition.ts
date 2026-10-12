import { sessionClaimPrefix } from "../domain/session-claims.js";
import type { SessionAcquisitionCheckpoint, SessionAcquisitionPorts, SessionAcquisitionRequest } from "../ports/session-acquisition.js";

export function createSessionAcquisition(ports: SessionAcquisitionPorts) {
    for (const name of [
        "withLifecycleLock", "reserve", "initializeCapture", "inspectExisting",
        "arm", "acknowledge", "reconcileForeign", "rollback",
    ] as const) {
        if (typeof ports?.[name] !== "function") {
            throw new TypeError(`Session acquisition requires a callable ${name} port.`);
        }
    }

    async function run(request: SessionAcquisitionRequest, checkCancelled: SessionAcquisitionCheckpoint = () => {}): Promise<{ lockFile: string; existingId: string | null }> {
        const prefix = sessionClaimPrefix(request.projectId, request.profile);
        return ports.withLifecycleLock(prefix, async () => {
            checkCancelled();
            const lockFile = ports.reserve(request.projectId, request.profile);
            let existingOwnershipAcknowledged = false;
            try {
                await ports.initializeCapture(request, lockFile);
                checkCancelled();
                const inspection = await ports.inspectExisting(request);
                checkCancelled();
                if (!inspection.known) throw new Error("Existing session container ownership could not be inspected.");
                await ports.arm();
                checkCancelled();
                if (inspection.containerId !== null) {
                    await ports.acknowledge(inspection.containerId, inspection.runtime);
                    existingOwnershipAcknowledged = true;
                    checkCancelled();
                }
                ports.reconcileForeign(prefix, lockFile);
                return { lockFile, existingId: inspection.containerId };
            } catch (error) {
                // Once transferred, the receipt must survive partial predecessor
                // reconciliation so guarded cleanup can still stop the owned ID.
                if (!existingOwnershipAcknowledged) {
                    try { await ports.rollback(lockFile); }
                    catch (rollbackError) {
                        throw new AggregateError([error, rollbackError], "Session acquisition and rollback failed.", { cause: error });
                    }
                }
                throw error;
            }
        });
    }

    return { run };
}
