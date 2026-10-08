import { assertNativeSessionOwnership, rollbackCapturedNativeSessionOwnership, validateNativeSessionOwnership, withLifecycleLock } from "./session-ownership-native.js";
export { assertNativeSessionOwnership, rollbackCapturedNativeSessionOwnership, validateNativeSessionOwnership } from "./session-ownership-native.js";
import { armSessionOwnership } from "../application/session-ownership.js";
import {
    captureNativeSessionOwnership, launchNativeSessionOwnership,
    nativeSessionOwnershipMatches, removeCapturedNativeSessionOwnership,
} from "../adapters/session-ownership.js";
import { setRuntimeOverride } from "../container-runtime.js";
import { createNativeSessionClaims } from "./session-claims.js";
import { createNativeSessionCleanup } from "./session-cleanup.js";
import type {
    SessionOwnershipBinding, SessionOwnershipHandle, SessionOwnershipReceipt, SessionOwnershipRuntime,
} from "../ports/session-ownership.js";

export function cleanupCapturedNativeSessionOwnership(
    binding: SessionOwnershipBinding, receipt: SessionOwnershipReceipt,
    containerId: string | null = null, runtime: SessionOwnershipRuntime = "docker",
): void {
    const claims = createNativeSessionClaims(withLifecycleLock);
    const cleanup = createNativeSessionCleanup(
        (prefix, operation) => withLifecycleLock(prefix, () => {
            if (!nativeSessionOwnershipMatches(receipt)) return undefined as ReturnType<typeof operation>;
            return operation();
        }),
        (prefix, ownPath) => claims.hasOtherReconciledSessionClaims(prefix, ownPath),
        () => removeCapturedNativeSessionOwnership(receipt),
        "ended-owner",
    );
    if (containerId !== null) setRuntimeOverride(runtime);
    cleanup.setSession(binding.lockFile, binding.projectPath, binding.profile, binding.toolName);
    cleanup.setSessionContainerId(containerId);
    cleanup.cleanupSession();
}

export interface NativeSessionOwnershipOptions {
    onCaptured?(receipt: SessionOwnershipReceipt): void;
    rollback?(binding: SessionOwnershipBinding, receipt: SessionOwnershipReceipt): void;
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
