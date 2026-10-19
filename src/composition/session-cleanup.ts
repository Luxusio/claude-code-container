import { createSessionCleanup } from "../application/session-cleanup.js";
import {
    cleanupNativeSessionDevices,
    removeNativeOwnedSessionClaim,
    reportNativeSessionDeviceCleanupFailure,
    stopNativeSessionContainer,
} from "../adapters/session-cleanup.js";
import type { SessionCleanupPorts } from "../ports/session-cleanup.js";
import type { NativeRuntimeInvocation } from "../ports/container-runtime-invocation.js";
import { getProjectId } from "../utils.js";

export { removeNativeSessionClaim, setupNativeSessionCleanupSignals } from "../adapters/session-cleanup.js";

export function createNativeSessionCleanup(
    withLifecycleLock: SessionCleanupPorts["withLifecycleLock"],
    hasOtherClaims: SessionCleanupPorts["hasOtherClaims"],
    removeClaim: SessionCleanupPorts["removeClaim"] = removeNativeOwnedSessionClaim,
    readRuntimeInvocation: () => NativeRuntimeInvocation = () => { throw new Error("No captured native runtime invocation for session cleanup."); },
) {
    return createSessionCleanup({
        projectId: (path) => getProjectId(path),
        withLifecycleLock,
        hasOtherClaims,
        removeClaim: (path) => removeClaim(path),
        cleanupDevices: (path, timeoutMs, profile) => cleanupNativeSessionDevices(path, timeoutMs, profile),
        reportDeviceCleanupFailure: (error) => reportNativeSessionDeviceCleanupFailure(error),
        stopContainer: (readContainerId) => stopNativeSessionContainer(readContainerId, readRuntimeInvocation()),
    });
}
