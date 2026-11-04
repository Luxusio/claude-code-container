import { encodeSessionClaim, sessionClaimName, sessionClaimPrefix, sessionLockClaimsForContainer,
    sessionLockClaimsForProjectFamily } from "../domain/session-claims.js";
import { canTransferSessionClaimObligation, currentSessionClaimAuthority, sessionClaimPeerVetoes } from "../domain/session-claim-observation.js";
import type { SessionClaimRuntimeEquality } from "../domain/session-claim-observation.js";
import { sessionLockOwner, type SessionLockLiveness, type SessionLockOwner } from "../domain/session-lock.js";
import type { NativeRuntimeInvocation } from "../ports/container-runtime-invocation.js";
import type { SessionClaimObservationSnapshot } from "../ports/session-claim-observation.js";
import type { SessionClaimsPorts, SessionClaimResponsibilityPorts, SessionClaimRecoveryScope } from "../ports/session-claims.js";
import type { SessionCleanupPeerVetoes, SessionCleanupSettlement } from "../ports/session-cleanup.js";
import type { SessionOwnershipBinding, SessionOwnershipReceipt } from "../ports/session-ownership.js";

const incomplete = (detail: string, cause?: unknown): Error => new Error(
    `session-cleanup-responsibility-incomplete: ${detail}`, { cause });

function sameRuntime(left: NativeRuntimeInvocation, right: NativeRuntimeInvocation): boolean {
    // Both values have passed the native decoder. The absolute executable and
    // closed Docker local transport are replayed with explicit config/host/TLS
    // flags, so selector capture differences do not select a different engine.
    if (left.version !== right.version || left.runtime !== right.runtime || left.executable !== right.executable
        || JSON.stringify(left.transport) !== JSON.stringify(right.transport)) return false;
    return left.runtime === "docker" && left.transport.kind === "docker" && /^(?:unix|npipe):/i.test(left.transport.host)
        || JSON.stringify(left.selectors) === JSON.stringify(right.selectors);
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

    function observeClaims(prefix: string, names = getSessionLockClaimsForContainer(prefix), includeResponsibility = true): ObservedClaim[] {
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
            if (includeResponsibility && qualified && receipt && owner?.ownershipKind === "monitored") {
                try { snapshot = qualified.observationStore.read(receipt, { prefix }); }
                catch { /* Historical sidecars do not establish parent liveness. */ }
            }
            return { name, content, owner, receipt, snapshot, parent: "unknown" as SessionLockLiveness,
                guardian: "unknown" as SessionLockLiveness };
        });
        const owners = ports.observeOwners(claims.flatMap(item => [
            ...(item.owner ? [item.owner.pid] : []),
            ...(item.snapshot ? [item.snapshot.observation.guardian.pid] : []),
        ]));
        for (const item of claims) {
            try {
                if (item.content !== null && item.owner) item.parent = ports.classify(item.content, owners);
                if (item.snapshot) {
                    const guardian = item.snapshot.observation.guardian;
                    item.guardian = ports.classify(encodeSessionClaim(guardian.pid, guardian.startToken), owners);
                }
            } catch { /* Unknown liveness grants no retirement authority. */ }
        }
        return claims;
    }

    function pruneStaleClaimsInHeldLifecycleLock(prefix: string, ownPath?: string): Error[] {
        const native = responsibility();
        const failures: Error[] = [];
        for (const item of observeClaims(prefix, undefined, false)) {
            if (item.receipt?.path === ownPath || item.parent !== "stale" || !item.owner || !item.receipt) continue;
            try {
                // A disk record is only a hint. Capture its current main file and
                // recheck the process generation immediately before exact removal.
                // Neither old sidecars nor a still-running guardian keep a dead
                // parent's session alive, and reconciliation never stops a container.
                const current = native.captureClaim(item.name);
                const owner = sessionLockOwner(current.content);
                if (!owner || JSON.stringify(current.receipt) !== JSON.stringify(item.receipt)) continue;
                const owners = ports.observeOwners([owner.pid]);
                if (ports.classify(current.content, owners) !== "stale" || !native.matchesClaim(current.receipt)) continue;
                if (native.retireStaleClaim) native.retireStaleClaim(current.receipt);
                else native.retireClaim(current.receipt);
            } catch (error) {
                // Another participant may have completed this exact retirement.
                // Preserve real I/O failures and any replacement still at the name.
                if (getSessionLockClaimsForContainer(prefix).includes(item.name)) {
                    failures.push(incomplete(`${JSON.stringify(item.name.slice(0, 180))}: stale session record removal failed`, error));
                }
            }
        }
        return failures;
    }

    function observedActive(names: string[], prefix?: string): string[] {
        // Queries are read-only. A positively dead parent is never a live
        // session; malformed records and unobservable generations stay protective.
        return observeClaims(prefix ?? "", names, false).filter(item => item.parent !== "stale").map(item => item.name);
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
        const sameCapturedRuntime = qualifiedRuntimeEquality(claims.flatMap(peer => peer.snapshot ? [peer.snapshot] : []));
        const eligible = claims.filter(peer => peer !== own && peer.snapshot
            && sameRuntime(peer.snapshot.runtimeInvocation, runtimeInvocation)
            && canTransferSessionClaimObligation(source.observation, peer.snapshot.observation, sameCapturedRuntime));
        const continuing = eligible.find(peer => peer.parent === "active" || peer.guardian === "active");
        return continuing?.snapshot ?? null;
    }

    function qualifiedRuntimeEquality(snapshots: readonly SessionClaimObservationSnapshot[]): SessionClaimRuntimeEquality {
        const native = responsibility();
        return (from, to) => {
            const source = snapshots.find(snapshot => snapshot.observation === from);
            const target = snapshots.find(snapshot => snapshot.observation === to);
            return !!source && !!target && native.observationStore.matches(source) && native.observationStore.matches(target)
                && sameRuntime(source.runtimeInvocation, target.runtimeInvocation);
        };
    }

    function peerVetoesInHeldLifecycleLock(prefix: string, ownPath: string, pinnedId: string | null,
        runtimeInvocation: NativeRuntimeInvocation): SessionCleanupPeerVetoes {
        const native = responsibility();
        if (pruneStaleClaimsInHeldLifecycleLock(prefix, ownPath).length) {
            return { sharedDeviceCleanupBlocked: true, exactContainerStopBlocked: true, responsibilityTransferred: false };
        }
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

    function reconcileSessionClaimsInHeldLifecycleLock(prefix: string, ownPath?: string,
        _scope?: SessionClaimRecoveryScope): { claims: string[]; error?: Error } {
        let failures: Error[];
        try { failures = pruneStaleClaimsInHeldLifecycleLock(prefix, ownPath); }
        catch (error) { failures = [incomplete("Session process state could not be observed; existing records were preserved.", error)]; }
        // Always rescan after mutations. Existing live or unknown records retain
        // their ordinary peer protection; stale cleanup history is not admission.
        const claims = getSessionLockClaimsForContainer(prefix);
        return failures.length ? { claims, error: incomplete(
            `Stale session reset remains incomplete: ${failures.slice(0, 8).map(error => error.message.slice(
                "session-cleanup-responsibility-incomplete: ".length)).join("; ")}${failures.length > 8 ? "; additional records omitted" : ""}.`,
            new AggregateError(failures, "Stale session reset failed.")) } : { claims };
    }

    function recoverPredecessorsInHeldLifecycleLock(prefix: string, ownPath?: string,
        scope?: SessionClaimRecoveryScope): string[] {
        const result = reconcileSessionClaimsInHeldLifecycleLock(prefix, ownPath, scope);
        if (result.error) throw result.error;
        return result.claims;
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

    function reconcileForeignClaimsInHeldLifecycleLock(prefix: string, ownPath: string, scope?: SessionClaimRecoveryScope): boolean {
        return recoverPredecessorsInHeldLifecycleLock(prefix, ownPath, scope).some(name => name !== ports.claimName(ownPath));
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
        recreateContainerWithoutInterruptingSessions, recoverPredecessorsInHeldLifecycleLock, reconcileSessionClaimsInHeldLifecycleLock,
        peerVetoesInHeldLifecycleLock, retireOwnedClaimInHeldLifecycleLock,
        settleCapturedResponsibilityInHeldLifecycleLock };
}
