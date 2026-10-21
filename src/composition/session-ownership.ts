import { assertNativeSessionOwnership, validateNativeSessionOwnership, withLifecycleLock, withLifecycleLockAsync } from "./session-ownership-native.js";
export { assertNativeSessionOwnership, rollbackCapturedNativeSessionOwnership, validateNativeSessionOwnership } from "./session-ownership-native.js";
import { armSessionOwnership } from "../application/session-ownership.js";
import { createSessionOwnershipPublication } from "../application/session-ownership-publication.js";
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
import type { SessionOwnershipPublicationPorts } from "../ports/session-ownership.js";
import { createNativeSessionClaimObservationStore } from "../adapters/session-claim-observation.js";
import { processStartToken } from "../session-lock-liveness.js";

function createNativeSessionPublication(
    binding: SessionOwnershipBinding, receipt: SessionOwnershipReceipt, runtimeInvocation: NativeRuntimeInvocation,
): SessionOwnershipPublicationPorts {
    const prefix = sessionClaimPrefix(getProjectId(binding.projectPath), binding.profile);
    const bound = { ...binding, prefix };
    const store = createNativeSessionClaimObservationStore();
    return createSessionOwnershipPublication(bound, receipt, runtimeInvocation, {
        store,
        guardianStartToken: pid => processStartToken(pid),
        withLifecycleLock: operation => withLifecycleLockAsync(prefix, operation),
    });
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
