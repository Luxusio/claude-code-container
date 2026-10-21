import type { SessionClaimObservationBinding } from "../domain/session-claim-observation.js";
import type { NativeRuntimeInvocation } from "../ports/container-runtime-invocation.js";
import type { SessionClaimObservationSnapshot } from "../ports/session-claim-observation.js";
import type {
    SessionOwnershipPublicationEffects, SessionOwnershipPublicationPorts, SessionOwnershipReceipt,
} from "../ports/session-ownership.js";

export function createSessionOwnershipPublication(
    binding: SessionClaimObservationBinding, receipt: SessionOwnershipReceipt, runtimeInvocation: NativeRuntimeInvocation,
    ports: SessionOwnershipPublicationEffects,
): SessionOwnershipPublicationPorts {
    const store = ports.store;
    let snapshot: SessionClaimObservationSnapshot | null = null;
    let generation = 0;
    const current = () => {
        if (!snapshot) throw new Error("Session guardian responsibility was not registered.");
        store.assertCurrent(snapshot);
        return snapshot;
    };
    const write = (next: SessionClaimObservationSnapshot["observation"]) => {
        snapshot = store.update(current(), next);
    };
    return {
        withLifecycleLock: operation => ports.withLifecycleLock(operation),
        registerGuardian(pid) {
            if (!Number.isSafeInteger(pid) || !pid || pid <= 0) throw new Error("Session guardian process identity is unavailable.");
            snapshot = store.begin({ receipt, binding, runtimeInvocation,
                guardian: { pid, startToken: ports.guardianStartToken(pid) }, generation: String(generation) });
        },
        ready() {
            const previous = current().observation;
            write({ ...previous, registration: "ready" });
        },
        stageUpdate(sequence, containerId, cleanupEnabled) {
            const previous = current().observation;
            const nextGeneration = String(++generation);
            const ownStarted = cleanupEnabled && previous.ownStarted?.containerId === containerId
                ? { generation: nextGeneration, containerId } : null;
            write({ ...previous, generation: nextGeneration,
                pending: { kind: "update", generation: nextGeneration, sequence, containerId, cleanupEnabled }, ownStarted });
            return { generation: nextGeneration, sequence };
        },
        acknowledgeUpdate(publication) {
            const previous = current().observation;
            const pending = previous.pending;
            if (!pending || pending.kind !== "update" || pending.generation !== publication.generation
                || pending.sequence !== publication.sequence || previous.generation !== publication.generation) return false;
            write({ ...previous, pending: null,
                lastAcknowledged: { generation: pending.generation, sequence: pending.sequence,
                    containerId: pending.containerId, cleanupEnabled: pending.cleanupEnabled } });
            return true;
        },
        beginStartup() {
            const previous = current().observation;
            const nextGeneration = String(++generation);
            write({ ...previous, generation: nextGeneration,
                pending: { kind: "startup", generation: nextGeneration, sequence: previous.pending?.sequence
                    ?? previous.lastAcknowledged?.sequence ?? 0, containerId: null, cleanupEnabled: false }, ownStarted: null });
        },
        recordOwnStart(containerId) {
            const previous = current().observation;
            const nextGeneration = String(++generation);
            write({ ...previous, generation: nextGeneration,
                pending: { kind: "startup", generation: nextGeneration, sequence: previous.pending?.sequence
                    ?? previous.lastAcknowledged?.sequence ?? 0, containerId, cleanupEnabled: true },
                ownStarted: { generation: nextGeneration, containerId } });
        },
    };
}
