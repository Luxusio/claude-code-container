import { randomBytes } from "crypto";
import { createSessionClaimsStore } from "../adapters/session-claims-store.js";
import { createNativeSessionClaimObservationStore } from "../adapters/session-claim-observation.js";
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
                cleanup.cleanupSessionInHeldLifecycleLock();
            },
        },
    });
    return claims;
}
