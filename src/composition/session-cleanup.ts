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
    peerVetoes: SessionCleanupPorts["peerVetoes"],
    removeClaim: SessionCleanupPorts["removeClaim"] = removeNativeOwnedSessionClaim,
    readRuntimeInvocation: () => NativeRuntimeInvocation = () => { throw new Error("No captured native runtime invocation for session cleanup."); },
) {
    return createSessionCleanup({
        projectId: (path) => getProjectId(path),
        withLifecycleLock,
        peerVetoes,
        removeClaim: (path, settlement) => removeClaim(path, settlement),
        cleanupDevices: (path, timeoutMs, profile) => cleanupNativeSessionDevices(path, timeoutMs, profile),
        reportDeviceCleanupFailure: (error) => reportNativeSessionDeviceCleanupFailure(error),
        stopContainer: (readContainerId) => stopNativeSessionContainer(readContainerId, readRuntimeInvocation()),
    });
}
