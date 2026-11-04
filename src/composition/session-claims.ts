import { randomBytes } from "crypto";
import { createSessionClaimsStore } from "../adapters/session-claims-store.js";
import { createNativeSessionClaimObservationStore } from "../adapters/session-claim-observation.js";
import { bindNativeRuntimeInvocation } from "../adapters/container-runtime-invocation.js";
import { createSessionClaims } from "../application/session-claims.js";
import { currentSessionClaimAuthority } from "../domain/session-claim-observation.js";
import { locksDir } from "../home-layout.js";
import type { SessionClaimsPorts } from "../ports/session-claims.js";
import { observeProcessStarts, processStartToken, sessionLockLiveness } from "../session-lock-liveness.js";
import { getProjectId } from "../utils.js";
import { createNativeSessionCleanup } from "./session-cleanup.js";

const store = createSessionClaimsStore({
    directory: () => locksDir(),
    platform: () => process.platform,
});

export function ensureNativeSessionClaimsDirectory(): undefined {
    return store.ensureDirectory();
}

export function createNativeSessionClaims(withLifecycleLock: SessionClaimsPorts["withLifecycleLock"]) {
    const observations = createNativeSessionClaimObservationStore();
    const claims = createSessionClaims({
        ...store,
        createId: () => randomBytes(16).toString("hex"),
        currentPid: () => process.pid,
        startToken: (pid) => processStartToken(pid),
        observeOwners: (pids) => observeProcessStarts(pids),
        classify: (content, observations) => sessionLockLiveness(content, observations),
        withLifecycleLock,
        responsibility: {
            captureClaim: store.captureClaim,
            matchesClaim: store.matchesClaim,
            retireClaim: store.retireClaim,
            observationStore: observations,
            projectId: (path) => getProjectId(path),
            verifyDeviceDriftContainer(candidate) {
                const authority = currentSessionClaimAuthority(candidate.observation);
                if (!authority || !/^[a-f0-9]{64}$/.test(authority.containerId) || !observations.deviceDriftRecovery) {
                    throw new Error("Session device receipt recovery has no exact native container authority.");
                }
                observations.deviceDriftRecovery.assertCurrent(candidate);
                const runner = bindNativeRuntimeInvocation(candidate.runtimeInvocation);
                const listed = runner.spawnSync(["ps", "-aq", "--no-trunc", "-f", `id=${authority.containerId}`], {
                    encoding: "utf8", stdio: "pipe", timeout: 5000, killSignal: "SIGKILL", maxBuffer: 4096,
                });
                observations.deviceDriftRecovery.assertCurrent(candidate);
                if (listed.error || listed.signal || listed.status !== 0 || typeof listed.stdout !== "string"
                    || listed.stdout.trim() !== "" && listed.stdout.trim() !== authority.containerId) {
                    throw new Error("Session device receipt recovery could not verify its exact native container.");
                }
            },
            cleanup(snapshot) {
                const { binding } = snapshot.observation;
                const authority = currentSessionClaimAuthority(snapshot.observation);
                if (!authority) throw new Error("session-cleanup-responsibility-incomplete: No current exact cleanup authority.");
                const cleanup = createNativeSessionCleanup(withLifecycleLock,
                    (prefix, ownPath, pinnedId) => {
                        observations.assertCurrent(snapshot);
                        return claims.peerVetoesInHeldLifecycleLock(prefix, ownPath, pinnedId, snapshot.runtimeInvocation);
                    },
                    (_path, settlement) => {
                        observations.assertCurrent(snapshot);
                        claims.retireOwnedClaimInHeldLifecycleLock(snapshot.receipt, binding, snapshot.runtimeInvocation, settlement);
                        return undefined;
                    },
                    () => { observations.assertCurrent(snapshot); return snapshot.runtimeInvocation; });
                cleanup.setSession(binding.lockFile, binding.projectPath, binding.profile, binding.toolName);
                cleanup.setSessionContainerId(authority.containerId);
                cleanup.setSessionCleanupEnabled(true);
                void cleanup.cleanupSessionInHeldLifecycleLock();
            },
        },
    });
    return claims;
}
