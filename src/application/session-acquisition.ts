import { sessionClaimPrefix } from "../domain/session-claims.js";
import type { SessionAcquisitionCheckpoint, SessionAcquisitionInspection, SessionAcquisitionPorts, SessionAcquisitionRequest, SessionAcquisitionResult } from "../ports/session-acquisition.js";

export function createSessionAcquisition(ports: SessionAcquisitionPorts) {
    for (const name of [
        "withLifecycleLock", "recoverPredecessors", "reserve", "initializeCapture", "inspectExisting",
        "arm", "acknowledge", "reconcileForeign", "rollback",
    ] as const) {
        if (typeof ports?.[name] !== "function") {
            throw new TypeError(`Session acquisition requires a callable ${name} port.`);
        }
    }

    async function run(request: SessionAcquisitionRequest, checkCancelled: SessionAcquisitionCheckpoint = () => {}): Promise<SessionAcquisitionResult> {
        const prefix = sessionClaimPrefix(request.projectId, request.profile);
        return ports.withLifecycleLock(prefix, async () => {
            checkCancelled();
            const recovery = await ports.recoverPredecessors(prefix);
            checkCancelled();
            let requiresLiveVerification = false;
            const verifyRetainedTarget = (inspection: SessionAcquisitionInspection) => {
                if (recovery && (!inspection.known || !/^[a-f0-9]{64}$/i.test(recovery.containerId)
                    || inspection.containerId !== recovery.containerId || inspection.runtime !== recovery.runtime
                    || typeof inspection.running !== "boolean" || inspection.running && inspection.requiresLiveVerification)) {
                    throw new Error("Retained predecessor recovery only permits the same identified container with a known running or stopped state; replacement and automatic cleanup remain disabled.");
                }
                if (recovery && inspection.requiresLiveVerification) requiresLiveVerification = true;
            };
            const lockFile = ports.reserve(request.projectId, request.profile);
            let existingOwnershipAcknowledged = false;
            try {
                await ports.initializeCapture(request, lockFile);
                checkCancelled();
                const inspection = await ports.inspectExisting(request);
                checkCancelled();
                if (!inspection.known) {
                    throw new Error(`Existing session container ownership could not be inspected (${inspection.reason ?? "unavailable"}; runtime: ${inspection.runtime}). The existing container was preserved.`);
                }
                verifyRetainedTarget(inspection);
                await ports.arm();
                checkCancelled();
                if (recovery) {
                    const current = await ports.inspectExisting(request);
                    checkCancelled();
                    verifyRetainedTarget(current);
                }
                if (inspection.containerId !== null) {
                    await ports.acknowledge(inspection.containerId, inspection.runtime);
                    existingOwnershipAcknowledged = true;
                    checkCancelled();
                }
                ports.reconcileForeign(prefix, lockFile);
                if (recovery) {
                    const current = await ports.inspectExisting(request);
                    checkCancelled();
                    verifyRetainedTarget(current);
                }
                return {
                    lockFile, existingId: inspection.containerId,
                    ...(inspection.requiresLiveVerification || requiresLiveVerification ? { requiresLiveVerification: true as const } : {}),
                    ...(recovery ? { existingOnly: true as const, recoveryWarning: recovery.diagnostic } : {}),
                };
            } catch (error) {
                // Ordinary acknowledged responsibility survives failed admission.
                // Restricted admission never owns startup or cleanup responsibility,
                // so its qualified no-obligation reservation can still roll back.
                if (!existingOwnershipAcknowledged || recovery) {
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
