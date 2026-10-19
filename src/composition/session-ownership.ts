import { assertNativeSessionOwnership, validateNativeSessionOwnership, withLifecycleLock, withLifecycleLockAsync } from "./session-ownership-native.js";
export { assertNativeSessionOwnership, rollbackCapturedNativeSessionOwnership, validateNativeSessionOwnership } from "./session-ownership-native.js";
import { armSessionOwnership } from "../application/session-ownership.js";
import {
    captureNativeSessionOwnership, launchNativeSessionOwnership,
    decodeNativeSessionRuntimeInvocation,
} from "../adapters/session-ownership.js";
import { getProjectId } from "@ccc/device-lab/project-identity.js";
import { sessionClaimPrefix } from "../domain/session-claims.js";
import { getRuntimeInvocation, runWithNativeRuntimeInvocation } from "../container-runtime.js";
import { createNativeSessionClaims } from "./session-claims.js";
import type {
    SessionOwnershipBinding, SessionOwnershipHandle, SessionOwnershipReceipt,
} from "../ports/session-ownership.js";
import type { NativeRuntimeInvocation } from "../ports/container-runtime-invocation.js";
import type { SessionClaimObservationSnapshot } from "../ports/session-claim-observation.js";
import type { SessionOwnershipPublicationPorts } from "../ports/session-ownership.js";
import { createNativeSessionClaimObservationStore } from "../adapters/session-claim-observation.js";
import { processStartToken } from "../session-lock-liveness.js";

function createNativeSessionPublication(
    binding: SessionOwnershipBinding, receipt: SessionOwnershipReceipt, runtimeInvocation: NativeRuntimeInvocation,
): SessionOwnershipPublicationPorts {
    const prefix = sessionClaimPrefix(getProjectId(binding.projectPath), binding.profile);
    const bound = { ...binding, prefix };
    const store = createNativeSessionClaimObservationStore();
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
        withLifecycleLock: operation => withLifecycleLockAsync(prefix, operation),
        registerGuardian(pid) {
            if (!Number.isSafeInteger(pid) || !pid || pid <= 0) throw new Error("Session guardian process identity is unavailable.");
            snapshot = store.begin({ receipt, binding: bound, runtimeInvocation,
                guardian: { pid, startToken: processStartToken(pid) }, generation: String(generation) });
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

export async function cleanupCapturedNativeSessionOwnership(
    binding: SessionOwnershipBinding, receipt: SessionOwnershipReceipt,
    _containerId: string | null, runtimeInvocation: NativeRuntimeInvocation,
): Promise<void> {
    const captured = decodeNativeSessionRuntimeInvocation(runtimeInvocation);
    await runWithNativeRuntimeInvocation(captured, async () => {
        const prefix = sessionClaimPrefix(getProjectId(binding.projectPath), binding.profile);
        await withLifecycleLockAsync(prefix, () => {
            const claims = createNativeSessionClaims(withLifecycleLock);
            claims.settleCapturedResponsibilityInHeldLifecycleLock(binding, receipt, captured);
        });
    });
}

export interface NativeSessionOwnershipOptions {
    runtimeInvocation?: NativeRuntimeInvocation;
    onCaptured?(receipt: SessionOwnershipReceipt): void;
    rollback?(binding: SessionOwnershipBinding, receipt: SessionOwnershipReceipt): void | Promise<void>;
    lifecycleLockHeld?: boolean;
}

export async function armNativeSessionOwnership(
    binding: SessionOwnershipBinding, onFailure: (error: Error) => void,
    options: NativeSessionOwnershipOptions = {},
): Promise<SessionOwnershipHandle> {
    const runtimeInvocation = decodeNativeSessionRuntimeInvocation(options.runtimeInvocation ?? getRuntimeInvocation());
    binding = Object.freeze({ ...binding });
    const receipt = Object.freeze(captureNativeSessionOwnership(binding.lockFile));
    validateNativeSessionOwnership(binding, receipt, process.pid);
    options.onCaptured?.(receipt);
    const arm = () => armSessionOwnership(binding, receipt, runtimeInvocation, {
        decodeRuntimeInvocation: decodeNativeSessionRuntimeInvocation,
        launch: launchNativeSessionOwnership,
        cleanup: options.rollback ?? ((ownedBinding, ownedReceipt) => {
            createNativeSessionClaims(withLifecycleLock).settleCapturedResponsibilityInHeldLifecycleLock(
                ownedBinding, ownedReceipt, runtimeInvocation,
            );
        }),
        assertOwnership: () => assertNativeSessionOwnership(receipt),
        publication: createNativeSessionPublication(binding, receipt, runtimeInvocation),
        setTimer: (callback, milliseconds) => {
            const timer: { timeout?: ReturnType<typeof setTimeout>; immediate?: ReturnType<typeof setImmediate> } = {};
            // Synchronous setup can block the host loop beyond the deadline.
            // Give already-arrived IPC ACKs one I/O iteration before timeout.
            timer.timeout = setTimeout(() => { timer.immediate = setImmediate(callback); }, milliseconds);
            return timer;
        },
        clearTimer: (value) => {
            const timer = value as { timeout?: ReturnType<typeof setTimeout>; immediate?: ReturnType<typeof setImmediate> };
            clearTimeout(timer.timeout);
            if (timer.immediate) clearImmediate(timer.immediate);
        },
        timeoutMs: 5000,
    }, onFailure);
    const prefix = sessionClaimPrefix(getProjectId(binding.projectPath), binding.profile);
    return options.lifecycleLockHeld ? arm() : withLifecycleLockAsync(prefix, arm);
}
