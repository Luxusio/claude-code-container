import { encodeSessionClaim, sessionClaimName, sessionClaimPrefix, sessionLockClaimsForContainer,
    sessionLockClaimsForProjectFamily } from "../domain/session-claims.js";
import { canTransferSessionClaimObligation, currentSessionClaimAuthority, selectSessionClaimRecoverySurvivor,
    sessionClaimPeerVetoes } from "../domain/session-claim-observation.js";
import { sessionLockOwner, type SessionLockLiveness, type SessionLockOwner } from "../domain/session-lock.js";
import type { NativeRuntimeInvocation } from "../ports/container-runtime-invocation.js";
import type { SessionClaimObservationSnapshot } from "../ports/session-claim-observation.js";
import type { SessionClaimsPorts, SessionClaimResponsibilityPorts } from "../ports/session-claims.js";
import type { SessionCleanupPeerVetoes, SessionCleanupSettlement } from "../ports/session-cleanup.js";
import type { SessionOwnershipBinding, SessionOwnershipReceipt } from "../ports/session-ownership.js";

const incomplete = (detail: string, cause?: unknown): Error => new Error(
    `session-cleanup-responsibility-incomplete: ${detail}`, { cause });

function sameRuntime(left: NativeRuntimeInvocation, right: NativeRuntimeInvocation): boolean {
    // Both values have passed the native decoder. Equality includes executable,
    // every selector and transport field, rather than just an endpoint name.
    return JSON.stringify(left) === JSON.stringify(right);
}

interface ObservedClaim {
    name: string;
    content: string | null;
    owner: SessionLockOwner | null;
    receipt: SessionOwnershipReceipt | null;
    snapshot: SessionClaimObservationSnapshot | null;
    parent: SessionLockLiveness;
    guardian: SessionLockLiveness;
}

export function createSessionClaims(ports: SessionClaimsPorts) {
    for (const name of ["ensureDirectory", "listEntries", "claimPath", "claimName", "readClaim", "writeClaim",
        "removeClaim", "createId", "currentPid", "startToken", "observeOwners", "classify", "withLifecycleLock"] as const) {
        if (typeof ports?.[name] !== "function") throw new TypeError(`Session claims requires a callable ${name} port.`);
    }

    function responsibility(): SessionClaimResponsibilityPorts {
        if (!ports.responsibility) throw incomplete("Qualified claim recovery is unavailable.");
        return ports.responsibility;
    }

    function getSessionLockClaimsForContainer(prefix: string): string[] {
        ports.ensureDirectory();
        return sessionLockClaimsForContainer(ports.listEntries(), prefix);
    }

    function getSessionLockClaimsForProjectFamily(projectId: string): string[] {
        ports.ensureDirectory();
        return sessionLockClaimsForProjectFamily(ports.listEntries(), projectId);
    }

    function observeClaims(prefix: string, names = getSessionLockClaimsForContainer(prefix)): ObservedClaim[] {
        const qualified = ports.responsibility;
        const claims = names.map(name => {
            let content: string | null = null;
            let receipt: SessionOwnershipReceipt | null = null;
            let snapshot: SessionClaimObservationSnapshot | null = null;
            try {
                if (qualified) ({ content, receipt } = qualified.captureClaim(name));
                else content = ports.readClaim(name);
            } catch { /* Unreadable and replaced records remain protective. */ }
            const owner = content === null ? null : sessionLockOwner(content);
            if (qualified && receipt && owner?.ownershipKind === "monitored") {
                try { snapshot = qualified.observationStore.read(receipt, { prefix }); }
                catch { /* A main claim never proves its auxiliary evidence is current. */ }
            }
            return { name, content, owner, receipt, snapshot, parent: "unknown" as SessionLockLiveness,
                guardian: "unknown" as SessionLockLiveness };
        });
        const owners = ports.observeOwners(claims.flatMap(item => [
            ...(item.owner ? [item.owner.pid] : []), ...(item.snapshot ? [item.snapshot.observation.guardian.pid] : []),
        ]));
        for (const item of claims) {
            try {
                if (item.content !== null) item.parent = ports.classify(item.content, owners);
                if (item.snapshot) {
                    const guardian = item.snapshot.observation.guardian;
                    item.guardian = ports.classify(encodeSessionClaim(guardian.pid, guardian.startToken), owners);
                }
            } catch { /* Unknown liveness grants no retirement authority. */ }
        }
        return claims;
    }

    function observedActive(names: string[], prefix?: string): string[] {
        // Queries never unlink. Only explicitly direct claims can be classified
        // stale without settling a guardian's independent responsibility.
        return observeClaims(prefix ?? "", names).filter(item => item.owner?.ownershipKind !== "direct"
            || item.parent !== "stale").map(item => item.name);
    }

    function getActiveSessionsForContainer(prefix: string, _currentLockFile?: string): string[] {
        return observedActive(getSessionLockClaimsForContainer(prefix), prefix);
    }

    function getActiveSessionsForProjectFamily(projectId: string): string[] {
        return observedActive(getSessionLockClaimsForProjectFamily(projectId));
    }

    function hasOtherActiveSessions(prefix: string, currentLockFile: string): boolean {
        return getActiveSessionsForContainer(prefix).some(name => name !== ports.claimName(currentLockFile));
    }

    function hasOtherSessionClaims(prefix: string, currentLockFile: string): boolean {
        return getSessionLockClaimsForContainer(prefix).some(name => name !== ports.claimName(currentLockFile));
    }

    function noObligation(snapshot: SessionClaimObservationSnapshot): boolean {
        const observation = snapshot.observation;
        const acknowledged = observation.lastAcknowledged;
        if (observation.pending !== null || observation.ownStarted !== null) return false;
        if (acknowledged === null) return true;
        return observation.registration === "ready"
            && acknowledged.generation === observation.generation && !acknowledged.cleanupEnabled;
    }

    function qualifiedSnapshot(receipt: SessionOwnershipReceipt, binding: SessionOwnershipBinding,
        runtimeInvocation?: NativeRuntimeInvocation): SessionClaimObservationSnapshot {
        const native = responsibility();
        if (!native.matchesClaim(receipt)) throw incomplete("The captured main claim is absent or replaced.");
        const prefix = sessionClaimPrefix(native.projectId(binding.projectPath), binding.profile);
        const snapshot = native.observationStore.read(receipt, { ...binding, prefix });
        if (!snapshot || (runtimeInvocation && !sameRuntime(snapshot.runtimeInvocation, runtimeInvocation))) {
            throw incomplete("The captured cleanup observation or runtime is unavailable or different.");
        }
        return snapshot;
    }

    function transferRecipient(own: ObservedClaim, claims: ObservedClaim[], pinnedId: string,
        runtimeInvocation: NativeRuntimeInvocation): SessionClaimObservationSnapshot | null {
        const source = own.snapshot;
        if (!source || currentSessionClaimAuthority(source.observation)?.containerId !== pinnedId
            || !sameRuntime(source.runtimeInvocation, runtimeInvocation)) return null;
        const eligible = claims.filter(peer => peer !== own && peer.snapshot
            && sameRuntime(peer.snapshot.runtimeInvocation, runtimeInvocation)
            && canTransferSessionClaimObligation(source.observation, peer.snapshot.observation));
        const continuing = eligible.find(peer => peer.parent === "active" || peer.guardian === "active");
        if (continuing?.snapshot) return continuing.snapshot;
        if (own.parent !== "stale" || own.guardian !== "stale") return null;
        const cohort = claims.filter(peer => peer.snapshot && peer.parent === "stale" && peer.guardian === "stale"
            && currentSessionClaimAuthority(peer.snapshot.observation)?.containerId === pinnedId);
        if (cohort.some(peer => !sameRuntime(peer.snapshot!.runtimeInvocation, runtimeInvocation))) return null;
        const survivor = selectSessionClaimRecoverySurvivor(cohort.map(peer => peer.snapshot!.observation));
        return eligible.find(peer => peer.snapshot!.observation.claim.path === survivor?.claim.path)?.snapshot ?? null;
    }

    function peerVetoesInHeldLifecycleLock(prefix: string, ownPath: string, pinnedId: string | null,
        runtimeInvocation: NativeRuntimeInvocation): SessionCleanupPeerVetoes {
        const native = responsibility();
        const claims = observeClaims(prefix);
        const own = claims.find(item => item.receipt?.path === ownPath);
        if (!own?.snapshot || !native.observationStore.matches(own.snapshot)
            || !sameRuntime(own.snapshot.runtimeInvocation, runtimeInvocation)
            || currentSessionClaimAuthority(own.snapshot.observation)?.containerId !== pinnedId) {
            return { sharedDeviceCleanupBlocked: true, exactContainerStopBlocked: true, responsibilityTransferred: false };
        }
        const peers = claims.filter(item => item.name !== ports.claimName(ownPath));
        const qualifiedPeers = peers.map(peer => peer.snapshot && native.observationStore.matches(peer.snapshot)
            ? peer.snapshot.observation : null);
        const vetoes = sessionClaimPeerVetoes(pinnedId, qualifiedPeers);
        const recipient = own && pinnedId ? transferRecipient(own, claims, pinnedId, runtimeInvocation) : null;
        return { ...vetoes, responsibilityTransferred: !!recipient && !!own?.snapshot
            && native.observationStore.matches(own.snapshot) && native.observationStore.matches(recipient) };
    }

    function retireSnapshot(snapshot: SessionClaimObservationSnapshot): void {
        const native = responsibility();
        native.observationStore.assertCurrent(snapshot);
        native.retireClaim(snapshot.receipt);
        // Main retirement is irreversible. Auxiliary cleanup must never make an
        // already completed stop/retirement look retryable or delete a successor.
        try { native.observationStore.retire(snapshot); } catch { /* Only exact obsolete sidecars remain. */ }
    }

    function retireOwnedClaimInHeldLifecycleLock(receipt: SessionOwnershipReceipt, binding: SessionOwnershipBinding,
        runtimeInvocation: NativeRuntimeInvocation, settlement: SessionCleanupSettlement): void {
        const snapshot = qualifiedSnapshot(receipt, binding, runtimeInvocation);
        const authority = currentSessionClaimAuthority(snapshot.observation);
        if (authority) {
            if (!settlement.cleanupEnabled || settlement.containerId !== authority.containerId
                || (!settlement.containerStopped && !(settlement.responsibilityTransferred
                    && peerVetoesInHeldLifecycleLock(snapshot.observation.binding.prefix, receipt.path,
                        authority.containerId, runtimeInvocation).responsibilityTransferred))) {
                throw incomplete("The current exact cleanup responsibility has neither completed nor transferred.");
            }
        } else if (!noObligation(snapshot) || settlement.containerStopped || settlement.responsibilityTransferred) {
            throw incomplete("Pending or uncertain cleanup responsibility cannot be retired.");
        }
        retireSnapshot(snapshot);
    }

    function retainRecoveryFailure(snapshot: SessionClaimObservationSnapshot, cause: unknown): Error {
        const native = responsibility();
        try {
            native.observationStore.assertCurrent(snapshot);
            native.observationStore.update(snapshot, { ...snapshot.observation,
                recovery: { status: "recovery-needed", diagnostic: "session-cleanup-failed" } });
        } catch (publicationFailure) {
            return incomplete("Cleanup failed and its recovery diagnostic could not be published.",
                new AggregateError([cause, publicationFailure], "Session cleanup and recovery publication failed."));
        }
        return incomplete("Cleanup failed; its captured responsibility remains available for recovery.", cause);
    }

    function settleSnapshot(snapshot: SessionClaimObservationSnapshot): void {
        if (!currentSessionClaimAuthority(snapshot.observation)) {
            if (!noObligation(snapshot)) throw retainRecoveryFailure(snapshot,
                incomplete("A pending request or startup intent does not prove shutdown authority."));
            retireSnapshot(snapshot);
            return;
        }
        try {
            responsibility().observationStore.assertCurrent(snapshot);
            responsibility().cleanup(snapshot);
            if (responsibility().matchesClaim(snapshot.receipt)) {
                throw incomplete("Cleanup returned without retiring the captured claim.");
            }
        } catch (error) {
            // A successfully retired main claim is a completion boundary, even
            // if an outer callback subsequently fails.
            if (!responsibility().matchesClaim(snapshot.receipt)) throw error;
            throw retainRecoveryFailure(snapshot, error);
        }
    }

    function settleCapturedResponsibilityInHeldLifecycleLock(binding: SessionOwnershipBinding,
        receipt: SessionOwnershipReceipt, runtimeInvocation?: NativeRuntimeInvocation): void {
        settleSnapshot(qualifiedSnapshot(receipt, binding, runtimeInvocation));
    }

    function recoverPredecessorsInHeldLifecycleLock(prefix: string, ownPath?: string): void {
        const native = responsibility();
        const claims = observeClaims(prefix).filter(item => item.receipt?.path !== ownPath);
        const recoverable: SessionClaimObservationSnapshot[] = [];
        const failures: unknown[] = [];
        for (const item of claims) {
            if (item.parent !== "stale") continue;
            if (!item.owner || !item.receipt) { failures.push(incomplete("A dead claim could not be qualified.")); continue; }
            if (item.owner.ownershipKind === "direct") {
                try { native.retireClaim(item.receipt); } catch (error) { failures.push(error); }
            } else if (item.owner.ownershipKind !== "monitored" || !item.snapshot) {
                failures.push(incomplete("A dead legacy or monitored claim has no qualified guardian responsibility."));
            } else if (item.guardian === "stale") {
                if (noObligation(item.snapshot)) {
                    try { retireSnapshot(item.snapshot); } catch (error) { failures.push(error); }
                } else if (currentSessionClaimAuthority(item.snapshot.observation)) recoverable.push(item.snapshot);
                else failures.push(retainRecoveryFailure(item.snapshot,
                    incomplete("A dead session has pending or unknown cleanup authority.")));
            }
        }
        const groups = new Map<string, SessionClaimObservationSnapshot[]>();
        for (const snapshot of recoverable) {
            const id = currentSessionClaimAuthority(snapshot.observation)!.containerId;
            groups.set(id, [...(groups.get(id) ?? []), snapshot]);
        }
        for (const group of groups.values()) {
            try {
                if (group.some(item => !sameRuntime(item.runtimeInvocation, group[0].runtimeInvocation))) {
                    throw incomplete("The same opaque container ID has different captured native authorities.");
                }
                const selected = group.length === 1 ? group[0].observation
                    : selectSessionClaimRecoverySurvivor(group.map(item => item.observation));
                if (!selected) throw incomplete("Dead duplicate responsibilities have no qualified recovery survivor.");
                const survivor = group.find(item => item.receipt.path === selected.claim.path)!;
                for (const item of group) {
                    if (item === survivor) continue;
                    retireOwnedClaimInHeldLifecycleLock(item.receipt, item.observation.binding, item.runtimeInvocation, {
                        containerId: currentSessionClaimAuthority(item.observation)!.containerId, cleanupEnabled: true,
                        containerStopped: false, responsibilityTransferred: true,
                    });
                }
                settleSnapshot(survivor);
            } catch (error) { failures.push(error); }
        }
        if (failures.length) throw incomplete("One or more predecessor responsibilities remain incomplete.",
            failures.length === 1 ? failures[0] : new AggregateError(failures, "Predecessor session recovery failed."));
    }

    function createSessionLock(projectId: string, profile?: string): string {
        return ports.withLifecycleLock(sessionClaimPrefix(projectId, profile), () =>
            createSessionLockInHeldLifecycleLock(projectId, profile));
    }

    function createSessionLockInHeldLifecycleLock(projectId: string, profile?: string): string {
        ports.ensureDirectory();
        const prefix = sessionClaimPrefix(projectId, profile);
        const path = ports.claimPath(sessionClaimName(prefix, ports.createId()));
        if (ports.responsibility) recoverPredecessorsInHeldLifecycleLock(prefix);
        const token = ports.startToken(ports.currentPid());
        ports.writeClaim(path, encodeSessionClaim(ports.currentPid(), token, "direct"));
        return path;
    }

    function reserveSessionLockInHeldLifecycleLock(projectId: string, profile?: string): string {
        ports.ensureDirectory();
        const path = ports.claimPath(sessionClaimName(sessionClaimPrefix(projectId, profile), ports.createId()));
        const token = ports.startToken(ports.currentPid());
        ports.writeClaim(path, encodeSessionClaim(ports.currentPid(), token, "monitored"));
        return path;
    }

    function reconcileForeignClaimsInHeldLifecycleLock(prefix: string, ownPath: string): boolean {
        recoverPredecessorsInHeldLifecycleLock(prefix, ownPath);
        return hasOtherSessionClaims(prefix, ownPath);
    }

    function recreateContainerWithoutInterruptingSessions(prefix: string, ownPath: string, recreate: () => void,
        replacementAllowed: () => boolean = () => true): boolean {
        return ports.withLifecycleLock(prefix, () => {
            if (!replacementAllowed()) return false;
            if (reconcileForeignClaimsInHeldLifecycleLock(prefix, ownPath)) return false;
            recreate();
            return true;
        });
    }

    return { createSessionLock, createSessionLockInHeldLifecycleLock, reserveSessionLockInHeldLifecycleLock, getSessionLockClaimsForContainer,
        getSessionLockClaimsForProjectFamily, getActiveSessionsForContainer,
        observeActiveSessionsForContainer: getActiveSessionsForContainer, getActiveSessionsForProjectFamily,
        hasOtherActiveSessions, hasOtherSessionClaims,
        hasOtherReconciledSessionClaims: hasOtherSessionClaims,
        reconcileForeignClaimsInHeldLifecycleLock,
        recreateContainerWithoutInterruptingSessions, recoverPredecessorsInHeldLifecycleLock,
        peerVetoesInHeldLifecycleLock, retireOwnedClaimInHeldLifecycleLock,
        settleCapturedResponsibilityInHeldLifecycleLock };
}
