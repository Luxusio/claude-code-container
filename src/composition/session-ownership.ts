import { assertNativeSessionOwnership, rollbackCapturedNativeSessionOwnership, validateNativeSessionOwnership, withLifecycleLock, withLifecycleLockAsync } from "./session-ownership-native.js";
export { assertNativeSessionOwnership, rollbackCapturedNativeSessionOwnership, validateNativeSessionOwnership } from "./session-ownership-native.js";
import { armSessionOwnership } from "../application/session-ownership.js";
import {
    captureNativeSessionOwnership, launchNativeSessionOwnership,
    nativeSessionOwnershipMatches, removeCapturedNativeSessionOwnership,
} from "../adapters/session-ownership.js";
import { getProjectId } from "@ccc/device-lab/project-identity.js";
import { sessionClaimPrefix } from "../domain/session-claims.js";
import { setRuntimeOverride } from "../container-runtime.js";
import { createNativeSessionClaims } from "./session-claims.js";
import { createNativeSessionCleanup } from "./session-cleanup.js";
import type {
    SessionOwnershipBinding, SessionOwnershipHandle, SessionOwnershipReceipt, SessionOwnershipRuntime,
} from "../ports/session-ownership.js";

export async function cleanupCapturedNativeSessionOwnership(
    binding: SessionOwnershipBinding, receipt: SessionOwnershipReceipt,
    containerId: string | null = null, runtime: SessionOwnershipRuntime = "docker",
): Promise<void> {
    const prefix = sessionClaimPrefix(getProjectId(binding.projectPath), binding.profile);
    await withLifecycleLockAsync(prefix, () => {
        if (!nativeSessionOwnershipMatches(receipt)) return;
        const claims = createNativeSessionClaims(withLifecycleLock);
        const cleanup = createNativeSessionCleanup(
            withLifecycleLock,
            (claimPrefix, ownPath) => claims.hasOtherReconciledSessionClaims(claimPrefix, ownPath),
            () => removeCapturedNativeSessionOwnership(receipt),
        );
        if (containerId !== null) setRuntimeOverride(runtime);
        cleanup.setSession(binding.lockFile, binding.projectPath, binding.profile, binding.toolName);
        cleanup.setSessionContainerId(containerId);
        cleanup.cleanupSessionInHeldLifecycleLock();
    });
}

export interface NativeSessionOwnershipOptions {
    onCaptured?(receipt: SessionOwnershipReceipt): void;
    rollback?(binding: SessionOwnershipBinding, receipt: SessionOwnershipReceipt): void | Promise<void>;
}

export async function armNativeSessionOwnership(
    binding: SessionOwnershipBinding, onFailure: (error: Error) => void,
    options: NativeSessionOwnershipOptions = {},
): Promise<SessionOwnershipHandle> {
    binding = Object.freeze({ ...binding });
    const receipt = Object.freeze(captureNativeSessionOwnership(binding.lockFile));
    validateNativeSessionOwnership(binding, receipt, process.pid);
    options.onCaptured?.(receipt);
    return armSessionOwnership(binding, receipt, {
        launch: launchNativeSessionOwnership,
        cleanup: options.rollback ?? rollbackCapturedNativeSessionOwnership,
        assertOwnership: () => assertNativeSessionOwnership(receipt),
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
}
