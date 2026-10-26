import { encodeSessionClaim, sessionClaimName, sessionClaimPrefix, sessionLockClaimsForContainer,
    sessionLockClaimsForProjectFamily } from "../domain/session-claims.js";
import { canTransferSessionClaimObligation, currentSessionClaimAuthority, selectSessionClaimRecoverySurvivor,
    sessionClaimPeerVetoes } from "../domain/session-claim-observation.js";
import { sessionLockOwner, type SessionLockLiveness, type SessionLockOwner } from "../domain/session-lock.js";
import type { NativeRuntimeInvocation } from "../ports/container-runtime-invocation.js";
import type { SessionClaimObservationSnapshot } from "../ports/session-claim-observation.js";
import type { SessionClaimsPorts, SessionClaimResponsibilityPorts, SessionClaimRecoveryScope } from "../ports/session-claims.js";
import type { SessionCleanupPeerVetoes, SessionCleanupSettlement } from "../ports/session-cleanup.js";
import type { SessionOwnershipBinding, SessionOwnershipReceipt } from "../ports/session-ownership.js";

const incomplete = (detail: string, cause?: unknown): Error => new Error(
    `session-cleanup-responsibility-incomplete: ${detail}`, { cause });

function sameRuntime(left: NativeRuntimeInvocation, right: NativeRuntimeInvocation): boolean {
    // Both values have passed the native decoder. Equality includes executable,
    // every selector and transport field, rather than just an endpoint name.
    return JSON.stringify(left) === JSON.stringify(right);
}

function cleanupFailureCode(error: unknown, depth = 0): string {
    if (!(error instanceof Error) || depth > 5) return "cleanup-error";
    const message = error.message;
    // Only fixed internal categories reach the public aggregate. Neither native
    // stderr nor arbitrary nested exception text is suitable for that message.
    const categories: ReadonlyArray<readonly [string, RegExp]> = [
        ["peer-veto-no-successor", /^session-cleanup-responsibility-incomplete: Exact container shutdown is blocked and no qualified successor owns its cleanup responsibility\.$/],
        ["native-state-unverified", /^Container shutdown state could not be verified;/],
        ["native-state-ambiguous", /^Container shutdown state is ambiguous;/],
        ["native-stop-failed", /^Container shutdown failed \(status=/],
        ["recovery-publication-failed", /^session-cleanup-responsibility-incomplete: Cleanup failed and its recovery diagnostic could not be published\.$/],
        ["evidence-changed", /^(?:Session claim observation is absent, unreadable, or replaced\.|Session ownership receipt changed before removal\.|session-cleanup-responsibility-incomplete: The captured (?:main claim is absent or replaced|cleanup observation or runtime is unavailable or different)\.)$/],
        ["retirement-incomplete", /^session-cleanup-responsibility-incomplete: (?:Cleanup returned without retiring the captured claim|The current exact cleanup responsibility has neither completed nor transferred)\.$/],
    ];
    for (const [code, pattern] of categories) if (pattern.test(message)) return code;
    return cleanupFailureCode(error.cause, depth + 1);
}

export interface RestrictedSessionAdmission {
    readonly containerId: string;
    revalidate(ownPath?: string): void;
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

    function recoverLegacyClaim(item: ObservedClaim, prefix: string, scope?: SessionClaimRecoveryScope): void {
        const native = responsibility();
        const receipt = item.receipt!;
        if (!scope) throw incomplete("Legacy recovery requires current project and runtime observations.");

        function qualifyRecord(): void {
            const current = observeClaims(prefix).find(peer => peer.name === item.name);
            if (!native.matchesClaim(receipt) || !current?.receipt || current.parent !== "stale"
                || !current.owner || current.owner.ownershipKind !== undefined
                || current.receipt.path !== receipt.path
                || native.observationStore.read(receipt, { prefix }) !== null
                || !native.matchesClaim(receipt)) {
                throw incomplete("Legacy process identity, receipt or sidecar absence changed.");
            }
        }
        function inspectTarget() {
            const target = scope!.inspectContainer();
            if (!target.known || target.requiresLiveVerification
                || target.containerId !== null && (!/^[a-f0-9]{64}$/i.test(target.containerId)
                    || typeof target.running !== "boolean")) {
                throw incomplete("The managed project container state or destructive identity is unconfirmed.");
            }
            return target;
        }
        function qualifyOrphanPeers(): void {
            const peers = observeClaims(prefix);
            if (peers.some(peer => !peer.receipt || !peer.owner || peer.parent !== "stale"
                || peer.owner.ownershipKind === "monitored"
                || !native.matchesClaim(peer.receipt)
                || native.observationStore.read(peer.receipt, { prefix }) !== null)) {
                throw incomplete("A live, unobservable or monitored peer prevents legacy orphan shutdown.");
            }
            qualifyRecord();
        }

        qualifyRecord();
        const target = inspectTarget();
        if (target.containerId !== null && target.running) {
            const pinnedId = target.containerId;
            const recipient = scope.runtimeInvocation && observeClaims(prefix).find(peer => peer.snapshot
                && peer.parent === "stale" && peer.guardian === "stale"
                && sameRuntime(peer.snapshot.runtimeInvocation, scope.runtimeInvocation!)
                && currentSessionClaimAuthority(peer.snapshot.observation)?.containerId === pinnedId);
            if (recipient?.snapshot) {
                // A current monitored responsibility can take over this exact
                // target. Retire the legacy veto before the normal survivor pass.
                const current = inspectTarget();
                if (current.containerId !== pinnedId || !current.running) {
                    throw incomplete("The legacy transfer target changed before retirement.");
                }
                qualifyRecord();
                const cohort = observeClaims(prefix);
                if (cohort.some(peer => !peer.receipt || !peer.owner || peer.parent !== "stale"
                    || !native.matchesClaim(peer.receipt)
                    || (peer.owner.ownershipKind === "monitored"
                        ? !peer.snapshot || peer.guardian !== "stale"
                            || !sameRuntime(peer.snapshot.runtimeInvocation, scope.runtimeInvocation!)
                            || currentSessionClaimAuthority(peer.snapshot.observation)?.containerId !== pinnedId
                            || !native.observationStore.matches(peer.snapshot)
                        : native.observationStore.read(peer.receipt, { prefix }) !== null))) {
                    throw incomplete("An uncertain peer or guardian prevents legacy responsibility transfer.");
                }
                const fresh = cohort.find(peer => peer.name === recipient.name);
                if (!fresh?.snapshot) throw incomplete("The monitored recipient disappeared before legacy transfer.");
                native.observationStore.assertCurrent(recipient.snapshot);
                if (!native.matchesClaim(receipt)
                    || native.observationStore.read(receipt, { prefix }) !== null) {
                    throw incomplete("The legacy receipt or sidecars changed before transfer.");
                }
                native.observationStore.assertCurrent(recipient.snapshot);
                native.retireClaim(receipt);
                return;
            }
            scope.stopContainer(() => {
                const current = inspectTarget();
                if (current.containerId !== pinnedId || !current.running) {
                    throw incomplete("The legacy orphan container changed before shutdown.");
                }
                // Repeat process, receipt and native sidecar absence observations
                // after the runtime probe, immediately before the exact-ID effect.
                qualifyOrphanPeers();
                return pinnedId;
            });
        }
        const settled = inspectTarget();
        if (settled.containerId !== null && (settled.running || settled.containerId !== target.containerId)) {
            throw incomplete("Legacy container shutdown is not confirmed for the observed target.");
        }
        qualifyRecord();
        native.retireClaim(receipt);
    }

    function retainedAdmission(prefix: string, claims: ObservedClaim[], scope?: SessionClaimRecoveryScope): RestrictedSessionAdmission | null {
        if (!claims.some(item => item.snapshot && item.snapshot.observation.pending !== null
            && !currentSessionClaimAuthority(item.snapshot.observation))) return null;
        if (!scope?.runtimeInvocation) {
            throw incomplete("Retained pending predecessor recovery requires a captured native runtime; the existing records were preserved.");
        }
        const native = responsibility();
        const runtime = scope.runtimeInvocation;
        const changed = () => incomplete("Retained predecessor cohort evidence changed or could not be qualified; the existing records were preserved.");
        const original = claims.map(item => ({ item, receipt: JSON.stringify(item.receipt), snapshot: JSON.stringify(item.snapshot) }));
        let ownReceipt: SessionOwnershipReceipt | undefined;

        function qualify(item: ObservedClaim): void {
            if (!item.receipt || !item.owner || item.owner.ownershipKind !== "monitored" || !item.snapshot
                || item.parent === "unknown" || item.guardian === "unknown"
                || !sameRuntime(item.snapshot.runtimeInvocation, runtime)
                || !native.matchesClaim(item.receipt) || !native.observationStore.matches(item.snapshot)
                || !currentSessionClaimAuthority(item.snapshot.observation)
                    && !noObligation(item.snapshot) && item.snapshot.observation.pending === null) throw changed();
        }
        for (const { item } of original) qualify(item);
        // An unresolved request only anchors retention when both of its process
        // generations are positively dead. Live peers remain protective peers.
        if (!original.some(({ item }) => item.parent === "stale" && item.guardian === "stale"
            && item.snapshot!.observation.pending !== null && !currentSessionClaimAuthority(item.snapshot!.observation))) {
            return null;
        }
        const target = scope.inspectContainer();
        if (!target.known || !target.containerId || !/^[a-f0-9]{64}$/i.test(target.containerId)
            || typeof target.running !== "boolean" || target.running && target.requiresLiveVerification) {
            throw incomplete("Retained predecessor recovery requires an identified managed container with a known running or stopped state; the existing records were preserved.");
        }
        const containerId = target.containerId;
        if (original.some(({ item }) => {
            const authority = currentSessionClaimAuthority(item.snapshot!.observation);
            return authority !== null && authority.containerId !== containerId;
        })) throw changed();

        function revalidate(ownPath?: string): void {
            const fresh = observeClaims(prefix);
            let peers = fresh;
            if (ownPath !== undefined) {
                if (original.some(({ item }) => item.receipt!.path === ownPath)) throw changed();
                const own = fresh.find(item => item.receipt?.path === ownPath);
                if (!own) throw changed();
                qualify(own);
                const observation = own.snapshot!.observation;
                const ack = observation.lastAcknowledged;
                if (own.parent !== "active" || own.guardian !== "active" || observation.registration !== "ready"
                    || observation.pending !== null || observation.ownStarted !== null
                    || ack?.generation !== observation.generation || ack.cleanupEnabled || ack.containerId !== containerId
                    || ownReceipt && !native.matchesClaim(ownReceipt)) throw changed();
                ownReceipt ??= { ...own.receipt! };
                peers = fresh.filter(item => item !== own);
            } else if (ownReceipt) throw changed();
            if (peers.length !== original.length || original.some(captured => {
                const current = peers.find(item => item.name === captured.item.name);
                if (!current) return true;
                qualify(current);
                return JSON.stringify(current.receipt) !== captured.receipt || JSON.stringify(current.snapshot) !== captured.snapshot
                    || captured.item.parent === "stale" && current.parent !== "stale"
                    || captured.item.guardian === "stale" && current.guardian !== "stale"
                    || !native.matchesClaim(captured.item.receipt!) || !native.observationStore.matches(captured.item.snapshot!);
            })) throw changed();
            const names = getSessionLockClaimsForContainer(prefix);
            if (names.length !== fresh.length || fresh.some(item => !names.includes(item.name))) throw changed();
        }
        // Inspection may re-enter native code. Reject drift immediately rather
        // than falling through to cleanup using a newly observed replacement.
        revalidate();
        return { containerId, revalidate };
    }

    function reconcileSessionClaimsInHeldLifecycleLock(prefix: string, ownPath?: string,
        scope?: SessionClaimRecoveryScope): { claims: string[]; error?: Error; restrictedAdmission?: RestrictedSessionAdmission } {
        const native = responsibility();
        const failures: Error[] = [];
        const failed = (name: string, reason: string, cause?: unknown) => {
            failures.push(incomplete(`${JSON.stringify(name.slice(0, 180))}: ${reason}`, cause));
        };
        try {
            const claims = observeClaims(prefix).filter(item => item.receipt?.path !== ownPath);
            const restrictedAdmission = retainedAdmission(prefix, claims, scope);
            if (restrictedAdmission) return { claims: getSessionLockClaimsForContainer(prefix), restrictedAdmission,
                error: incomplete("Predecessor cleanup is deferred because qualified pending monitored authority is retained; the original cohort remains unresolved and protective.") };
            const recoverable: SessionClaimObservationSnapshot[] = [];
            const legacy: ObservedClaim[] = [];
            for (const item of claims) {
                if (item.parent !== "stale") continue;
                if (!item.owner || !item.receipt) { failed(item.name, "dead claim receipt could not be qualified"); continue; }
                if (item.owner.ownershipKind === "direct") {
                    try { native.retireClaim(item.receipt); }
                    catch (error) { failed(item.name, "direct claim retirement failed", error); }
                } else if (item.owner.ownershipKind === undefined) {
                    legacy.push(item);
                } else if (!item.snapshot) {
                    failed(item.name, "monitored guardian responsibility is missing, unreadable or replaced");
                } else if (item.guardian === "stale") {
                    if (noObligation(item.snapshot)) {
                        try { retireSnapshot(item.snapshot); }
                        catch (error) { failed(item.name, "unencumbered monitored claim retirement failed", error); }
                    } else if (currentSessionClaimAuthority(item.snapshot.observation)) recoverable.push(item.snapshot);
                    else failed(item.name, "pending or unknown monitored cleanup authority", retainRecoveryFailure(item.snapshot,
                        incomplete("A dead session has pending or unknown cleanup authority.")));
                }
            }
            for (const item of legacy) {
                try { recoverLegacyClaim(item, prefix, scope); }
                catch (error) {
                    const marker = "session-cleanup-responsibility-incomplete: ";
                    const reason = error instanceof Error && error.message.startsWith(marker)
                        ? error.message.slice(marker.length, marker.length + 240) : "legacy process/container reconciliation failed";
                    failed(item.name, reason, error);
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
                } catch (error) { failed(ports.claimName(group[0].receipt.path), `qualified monitored cleanup failed [${cleanupFailureCode(error)}]`, error); }
            }
        } catch (error) { failed(prefix, "claim observations could not be reconciled", error); }
        // Even partial cleanup is followed by a fresh file observation. A failed
        // unlink or replacement remains a veto rather than a cached success.
        const claims = getSessionLockClaimsForContainer(prefix);
        return failures.length ? { claims, error: incomplete(
            `Predecessor recovery remains incomplete: ${failures.slice(0, 8).map(error => error.message.slice(
                "session-cleanup-responsibility-incomplete: ".length)).join("; ")}${failures.length > 8 ? "; additional records omitted" : ""}.`,
            new AggregateError(failures, "Predecessor session recovery failed.")) } : { claims };
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
