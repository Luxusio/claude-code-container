import { join } from "path";
import { locksDir } from "./home-layout.js";
import { withSharedMutationLock, withSharedMutationLockAsync } from "@ccc/device-lab/device-lab-shared-state.js";
import { createNativeSessionClaims, ensureNativeSessionClaimsDirectory } from "./composition/session-claims.js";
import { armNativeSessionOwnership, assertNativeSessionOwnership, validateNativeSessionOwnership } from "./composition/session-ownership.js";
import { captureNativeSessionOwnership, nativeSessionOwnershipMatches, removeCapturedNativeSessionOwnership } from "./adapters/session-ownership.js";
import { createSessionAcquisition } from "./application/session-acquisition.js";
import { createSessionPublicationCoordinator } from "./application/session-publication-coordinator.js";
import type { SessionAcquisitionPorts, SessionAcquisitionRequest, SessionAcquisitionResult } from "./ports/session-acquisition.js";
import { getRuntimeInvocation, runWithNativeRuntimeInvocation } from "./container-runtime.js";
import type { NativeRuntimeInvocation } from "./ports/container-runtime-invocation.js";
import type { SessionOwnershipHandle, SessionOwnershipReceipt } from "./ports/session-ownership.js";
import { createNativeSessionClaimObservationStore } from "./adapters/session-claim-observation.js";
import { stopNativeSessionContainer } from "./adapters/session-cleanup.js";
import type { SessionClaimRecoveryScope } from "./ports/session-claims.js";
import { currentSessionClaimAuthority } from "./domain/session-claim-observation.js";
import { sessionClaimPrefix } from "./domain/session-claims.js";
import { getProjectId } from "./utils.js";
import {
    createNativeSessionCleanup,
    setupNativeSessionCleanupSignals,
} from "./composition/session-cleanup.js";

function containerLifecycleLock(containerPrefix: string): string {
    return join(locksDir(), `${containerPrefix}.container-lifecycle.guard`);
}

function containerSetupLock(containerPrefix: string): string {
    return join(locksDir(), `${containerPrefix}.container-setup.guard`);
}

function projectFamilyLifecycleLock(projectId: string): string {
    return join(locksDir(), `${projectId}.project-family-lifecycle.guard`);
}

function ensureLocksDirectory(): void {
    ensureNativeSessionClaimsDirectory();
}

export function withContainerLifecycleLock<T>(containerPrefix: string, operation: () => T): T {
    ensureLocksDirectory();
    return withSharedMutationLock(containerLifecycleLock(containerPrefix), operation, { waitMs: 180_000 });
}

export function withProjectFamilyLifecycleLock<T>(projectId: string, operation: () => T): T {
    ensureLocksDirectory();
    return withSharedMutationLock(projectFamilyLifecycleLock(projectId), operation, { waitMs: 180_000 });
}

export async function withProjectFamilyLifecycleLockAsync<T>(projectId: string, operation: () => Promise<T> | T): Promise<T> {
    ensureLocksDirectory();
    return withSharedMutationLockAsync(projectFamilyLifecycleLock(projectId), operation, { waitMs: 180_000 });
}

export async function withContainerLifecycleLockAsync<T>(containerPrefix: string, operation: () => Promise<T> | T): Promise<T> {
    ensureLocksDirectory();
    return withSharedMutationLockAsync(containerLifecycleLock(containerPrefix), operation, { waitMs: 180_000 });
}

export async function withContainerSetupLockAsync<T>(containerPrefix: string, operation: () => Promise<T> | T): Promise<T> {
    ensureLocksDirectory();
    return withSharedMutationLockAsync(containerSetupLock(containerPrefix), operation, { waitMs: 900_000 });
}

const sessionClaims = createNativeSessionClaims((prefix, operation) =>
    withContainerLifecycleLock(prefix, operation),
);
const directClaims = new Map<string, { prefix: string; receipt: SessionOwnershipReceipt }>();

function capturedRuntime(): NativeRuntimeInvocation {
    if (!capturedRuntimeInvocation) throw new Error("No captured native runtime invocation for session cleanup.");
    return capturedRuntimeInvocation;
}

const sessionCleanup = createNativeSessionCleanup(
    (prefix, operation) => withContainerLifecycleLock(prefix, () => {
        ownershipAuthorization?.();
        return operation();
    }),
    (prefix, ownPath, pinnedId) => sessionClaims.peerVetoesInHeldLifecycleLock(prefix, ownPath, pinnedId, capturedRuntime()),
    (path, settlement) => {
        const current = sessionCleanup.getCurrentSession();
        const receipt = capturedOwnership?.path === path ? capturedOwnership : directClaims.get(path)?.receipt;
        if (!receipt || !current.projectPath) throw new Error("Session cleanup lacks its captured ownership receipt.");
        sessionClaims.retireOwnedClaimInHeldLifecycleLock(receipt, {
            lockFile: path, projectPath: current.projectPath, profile: current.profile, toolName: current.toolName ?? undefined,
        }, capturedRuntime(), settlement);
        directClaims.delete(path);
        return undefined;
    },
    capturedRuntime,
);

let ownership: SessionOwnershipHandle | null = null;
let armingOwnership = false;
let acquiringOwnership = false;
let acquisitionFailure: Error | null = null;
let acquisitionCancellation: Error | null = null;
type AcquisitionOutcome = { kind: "completed" } | { kind: "failed"; error: unknown; cancellation: Error | null };
let acquisitionSettled: Promise<AcquisitionOutcome> = Promise.resolve({ kind: "completed" });
let ownershipAuthorization: (() => void) | null = null;
let capturedOwnership: SessionOwnershipReceipt | null = null;
let capturedRuntimeInvocation: NativeRuntimeInvocation | null = null;
let disposeSessionCleanupSignals: (() => void) | null = null;

const sessionPublication = createSessionPublicationCoordinator({
    currentOwnership: () => ownership,
    prepareStandaloneUpdate(activeOwnership, containerId, enabled) {
        const current = sessionCleanup.getCurrentSession();
        // Cleanup may already have retired this claim while its outer guard returns.
        if (!current.lockFile) return;
        if (!current.projectPath) throw new Error("Session update lacks its captured project binding.");
        const prefix = sessionClaimPrefix(getProjectId(current.projectPath), current.profile);
        return withContainerLifecycleLock(prefix, () =>
            activeOwnership.prepareContainerUpdateInHeldLifecycleLock(containerId, enabled));
    },
    setCleanupEnabled: enabled => sessionCleanup.setSessionCleanupEnabled(enabled),
    setContainerId: containerId => sessionCleanup.setSessionContainerId(containerId),
});

function ownershipFailed(error: Error): void {
    if (acquiringOwnership) { acquisitionFailure = error; return; }
    console.error("[ccc] Host session ownership monitor failed; ending this session.");
    process.exitCode = 1;
    // Run the existing owned command interruption and session cleanup handlers.
    process.emit("SIGTERM");
}

async function armOwnershipInContext(rollback?: (binding: unknown, receipt: SessionOwnershipReceipt) => void, lifecycleLockHeld = false): Promise<number | undefined> {
    const current = sessionCleanup.getCurrentSession();
    if (!current.lockFile || !current.projectPath || ownership || armingOwnership) {
        throw new Error("Cannot arm host session ownership without a unique current session.");
    }
    if (!capturedRuntimeInvocation) throw new Error("Cannot arm host session ownership without a captured native runtime invocation.");
    armingOwnership = true;
    if (!ownershipAuthorization) {
        ownershipAuthorization = () => { throw new Error("Host session ownership was not established."); };
    }
    try {
        if (capturedOwnership) ownershipAuthorization();
        ownership = await armNativeSessionOwnership({
            lockFile: current.lockFile, projectPath: current.projectPath,
            profile: current.profile, toolName: current.toolName ?? undefined,
        }, ownershipFailed, {
            runtimeInvocation: capturedRuntimeInvocation,
            onCaptured: (receipt) => {
                if (capturedOwnership) ownershipAuthorization!();
                else {
                    const captured = Object.freeze({ ...receipt });
                    capturedOwnership = captured;
                    ownershipAuthorization = () => assertNativeSessionOwnership(captured);
                }
            },
            rollback,
            lifecycleLockHeld,
        });
        return ownership.pid;
    } catch (error) {
        ownershipAuthorization = () => { throw error; };
        throw error;
    } finally {
        armingOwnership = false;
    }
}

export async function armSessionOwnership(): Promise<number | undefined> {
    if (acquiringOwnership) throw new Error("Host session ownership is already being acquired.");
    return armOwnershipInContext();
}

function sessionRecoveryScope(runtimeInvocation: NativeRuntimeInvocation,
    inspect: SessionClaimRecoveryScope["inspectContainer"]): SessionClaimRecoveryScope {
    return {
        runtimeInvocation,
        inspectContainer: () => runWithNativeRuntimeInvocation(runtimeInvocation, inspect),
        stopContainer: readId => stopNativeSessionContainer(readId, runtimeInvocation),
    };
}

export async function acquireHostSessionOwnership(
    request: SessionAcquisitionRequest,
    inspectExisting: SessionAcquisitionPorts["inspectExisting"],
): Promise<SessionAcquisitionResult> {
    if (ownership || armingOwnership || acquiringOwnership || sessionCleanup.getCurrentSession().lockFile) {
        throw new Error("Host session ownership is already being acquired.");
    }
    const runtimeInvocation = getRuntimeInvocation();
    const recovery = sessionRecoveryScope(runtimeInvocation, () => {
        const inspected = inspectExisting(request);
        // Native inspection is synchronous. An asynchronous extension cannot
        // supply fresh synchronous destructive proof; preserve legacy records.
        if (inspected instanceof Promise) {
            void inspected.catch(() => undefined);
            return { known: false, containerId: null };
        }
        if (inspected.runtime !== runtimeInvocation.runtime) return { known: false, containerId: null };
        return inspected;
    });
    acquiringOwnership = true;
    acquisitionFailure = null;
    acquisitionCancellation = null;
    let settleAcquisition!: (outcome: AcquisitionOutcome) => void;
    let acquisitionOutcome: AcquisitionOutcome = { kind: "completed" };
    let acquisitionRolledBack = false;
    acquisitionSettled = new Promise<AcquisitionOutcome>((resolve) => { settleAcquisition = resolve; });
    const checkCancelled = () => {
        if (acquisitionCancellation) throw acquisitionCancellation;
    };
    // This closure is confined to acquisition, before startup can be entered.
    // It is never inferred from an absent observation during later recovery.
    const rollbackOwn = (_binding: unknown, receipt: SessionOwnershipReceipt) => {
        if (!nativeSessionOwnershipMatches(receipt)) throw new Error("Unarmed session reservation was replaced before rollback.");
        const current = sessionCleanup.getCurrentSession();
        const store = createNativeSessionClaimObservationStore();
        const prefix = sessionClaimPrefix(request.projectId, request.profile);
        let observation;
        try { observation = store.read(receipt, { prefix }); }
        catch { /* Unreferenced auxiliary files are preserved; this acquisition never entered startup. */ }
        if (observation && (currentSessionClaimAuthority(observation.observation)
            || observation.observation.pending?.kind === "startup")) {
            throw new Error("Session reservation acquired a cleanup responsibility before rollback.");
        }
        if (current.lockFile !== receipt.path) throw new Error("Session reservation changed before rollback.");
        removeCapturedNativeSessionOwnership(receipt);
        if (observation) {
            try { store.retire(observation); } catch { /* Main retirement is already complete; never reopen its claim. */ }
        }
    };
    try {
        const acquired = await runWithNativeRuntimeInvocation(runtimeInvocation, () => createSessionAcquisition({
            withLifecycleLock: withContainerLifecycleLockAsync,
            recoverPredecessors: prefix => { sessionClaims.recoverPredecessorsInHeldLifecycleLock(prefix, undefined, recovery); },
            reserve: sessionClaims.reserveSessionLockInHeldLifecycleLock,
            initializeCapture(binding, lockFile) {
                sessionCleanup.clearSession();
                capturedRuntimeInvocation = runtimeInvocation;
                sessionCleanup.setSession(lockFile, binding.projectPath, binding.profile, binding.toolName);
                sessionPublication.beginCapture(false);
                ownershipAuthorization = () => { throw new Error("Host session ownership was not established."); };
                const receipt = captureNativeSessionOwnership(lockFile);
                validateNativeSessionOwnership({ ...binding, lockFile }, receipt, process.pid);
                const captured = Object.freeze({ ...receipt });
                capturedOwnership = captured;
                ownershipAuthorization = () => assertNativeSessionOwnership(captured);
                setupSignalHandlers();
            },
            inspectExisting,
            async arm() {
                await armOwnershipInContext(rollbackOwn, true);
                if (acquisitionFailure) throw acquisitionFailure;
            },
            async acknowledge(id, runtime) {
                if (runtime !== runtimeInvocation.runtime) throw new Error("Existing session container runtime does not match its captured invocation.");
                if (!await ownership!.updateContainerInHeldLifecycleLock(id, false)) {
                    throw new Error("Existing session ownership acknowledgement was superseded.");
                }
                sessionPublication.captureAcknowledgedContainer(id);
            },
            reconcileForeign(prefix, lockFile) {
                if (acquisitionFailure) throw acquisitionFailure;
                return sessionClaims.reconcileForeignClaimsInHeldLifecycleLock(prefix, lockFile, recovery);
            },
            async rollback() {
                try {
                    if (capturedOwnership) rollbackOwn(undefined, capturedOwnership);
                } catch (error) {
                    ownershipAuthorization = () => { throw error; };
                    throw error;
                }
                const previous = ownership;
                ownership = null;
                sessionCleanup.clearSession();
                ownershipAuthorization = null;
                capturedOwnership = null;
                capturedRuntimeInvocation = null;
                sessionPublication.retire();
                if (previous) await previous.release();
                acquisitionRolledBack = true;
            },
        }).run(request, checkCancelled));
        if (acquisitionFailure) throw acquisitionFailure;
        return acquired;
    } catch (error) {
        const failure = error === acquisitionCancellation && acquisitionFailure
            ? new AggregateError([error, acquisitionFailure], "Session cancellation and ownership monitoring failed.", { cause: error })
            : error;
        acquisitionOutcome = { kind: "failed", error: failure, cancellation: acquisitionCancellation };
        throw failure;
    } finally {
        acquiringOwnership = false;
        acquisitionFailure = null;
        acquisitionCancellation = null;
        if (acquisitionRolledBack) disposeSessionCleanupSignals?.();
        settleAcquisition(acquisitionOutcome);
    }
}

export function confirmSessionOwnership(): Promise<void> {
    return sessionPublication.confirm();
}

export function setSession(lockFile: string, projectPath: string, profile?: string, toolName?: string): void {
    if (ownership || armingOwnership || acquiringOwnership || ownershipAuthorization) {
        throw new Error("Cannot replace an owned host session before cleanup.");
    }
    const runtimeInvocation = getRuntimeInvocation();
    const receipt = Object.freeze(captureNativeSessionOwnership(lockFile));
    validateNativeSessionOwnership({ lockFile, projectPath, profile, toolName }, receipt, process.pid);
    sessionCleanup.setSession(lockFile, projectPath, profile, toolName);
    capturedRuntimeInvocation = runtimeInvocation;
    sessionPublication.beginCapture(true);
    ownershipAuthorization = () => assertNativeSessionOwnership(receipt);
    capturedOwnership = receipt;
}

/** Capture and shutdown authorization are separate; a failed join only drops its claim. */
export function setSessionCleanupEnabled(enabled: boolean): void {
    if (typeof enabled !== "boolean") throw new TypeError("Invalid session cleanup authorization.");
    if (acquiringOwnership) throw new Error("Cannot update host session ownership during acquisition.");
    sessionPublication.setCleanupEnabled(enabled);
}

export function beginSessionStartupInHeldLifecycleLock(): void {
    if (!ownership || acquiringOwnership) throw new Error("Session startup requires an armed ownership guardian.");
    sessionPublication.beginStartupInHeldLifecycleLock(ownership);
}

export function recordSessionOwnStartInHeldLifecycleLock(containerId: string): void {
    if (!ownership || acquiringOwnership) throw new Error("Session start requires an armed ownership guardian.");
    sessionPublication.recordOwnStartInHeldLifecycleLock(ownership, containerId);
}

export function publishSessionReadyInHeldLifecycleLock(containerId: string, handoff: { startedByInvocation: boolean }): void {
    if (!ownership || acquiringOwnership) throw new Error("Session readiness requires an armed ownership guardian.");
    sessionPublication.publishReadyInHeldLifecycleLock(ownership, containerId, handoff);
}

export function setSessionContainerId(containerId: string | null): void {
    if (acquiringOwnership) throw new Error("Cannot update host session ownership during acquisition.");
    sessionPublication.setContainerId(containerId);
}

/** Existing exact claim receipt; callers cannot manufacture a basename exclusion. */
export function getCurrentSessionOwnershipReceipt(): SessionOwnershipReceipt | undefined {
    return capturedOwnership ?? undefined;
}

export function getCurrentSession(): { lockFile: string | null; projectPath: string | null; profile?: string; toolName: string | null } {
    return sessionCleanup.getCurrentSession();
}

export function clearSession(): void {
    if (armingOwnership || acquiringOwnership) throw new Error("Cannot clear host session ownership during acquisition.");
    if (ownership) cleanupSession();
    sessionCleanup.clearSession();
    sessionPublication.beginCapture(true);
    ownershipAuthorization = null;
    capturedOwnership = null;
    capturedRuntimeInvocation = null;
    disposeSessionCleanupSignals?.();
}

export function createSessionLock(projectId: string, profile?: string): string {
    const prefix = sessionClaimPrefix(projectId, profile);
    return withContainerLifecycleLock(prefix, () => {
        const path = sessionClaims.createSessionLockInHeldLifecycleLock(projectId, profile);
        directClaims.set(path, { prefix, receipt: Object.freeze(captureNativeSessionOwnership(path)) });
        return path;
    });
}

export function removeSessionLock(lockFile: string): void {
    const claim = directClaims.get(lockFile);
    if (!claim) throw new Error("Session claim removal lacks its original direct-claim receipt.");
    withContainerLifecycleLock(claim.prefix, () => removeSessionLockInHeldLifecycleLock(lockFile));
}

export function removeSessionLockInHeldLifecycleLock(lockFile: string): void {
    const claim = directClaims.get(lockFile);
    if (!claim) throw new Error("Session claim removal lacks its original direct-claim receipt.");
    removeCapturedNativeSessionOwnership(claim.receipt);
    directClaims.delete(lockFile);
}

/**
 * Get active sessions for a container prefix.
 * containerPrefix is the full container name without trailing "--".
 * For non-profile containers (e.g. "projectId"), only returns files that match
 * `${containerPrefix}--<sessionId>.lock` and do NOT contain "--p--" after the prefix.
 * For profile containers (e.g. "projectId--p--work"), returns files that match
 * `${containerPrefix}--<sessionId>.lock`.
 */
export function getActiveSessionsForContainer(
    containerPrefix: string,
    currentLockFile?: string,
): string[] {
    return sessionClaims.getActiveSessionsForContainer(containerPrefix, currentLockFile);
}

export function observeActiveSessionsForContainer(
    containerPrefix: string,
    currentLockFile?: string,
): string[] {
    return sessionClaims.observeActiveSessionsForContainer(containerPrefix, currentLockFile);
}

/** Return raw claims, or reconcile first when an explicit project inspection is supplied. */
export function getSessionLockClaimsForContainer(containerPrefix: string, recovery?: {
    projectPath: string;
    profile?: string;
    inspectContainer: SessionClaimRecoveryScope["inspectContainer"];
}): string[] {
    if (!recovery) return sessionClaims.getSessionLockClaimsForContainer(containerPrefix);
    if (sessionClaimPrefix(getProjectId(recovery.projectPath), recovery.profile) !== containerPrefix) {
        throw new Error("Session reconciliation project/profile does not match its lifecycle guard.");
    }
    const scope = sessionRecoveryScope(getRuntimeInvocation(), recovery.inspectContainer);
    const result = sessionClaims.reconcileSessionClaimsInHeldLifecycleLock(containerPrefix, undefined, scope);
    if (result.error) console.warn(`[ccc] ${result.error.message}`);
    return result.claims;
}

export function getSessionLockClaimsForProjectFamily(projectId: string): string[] {
    return sessionClaims.getSessionLockClaimsForProjectFamily(projectId);
}

/**
 * Return every live session for one project path, including all profile
 * containers. This broader query is reserved for removing the project path.
 */
export function getActiveSessionsForProjectFamily(projectId: string): string[] {
    return sessionClaims.getActiveSessionsForProjectFamily(projectId);
}

/**
 * @deprecated Use getActiveSessionsForContainer instead.
 * Kept for backwards compatibility: recognizes old single-dash format.
 */
export function getActiveSessionsForProject(projectId: string): string[] {
    return getActiveSessionsForContainer(projectId);
}

export function hasOtherActiveSessions(
    containerPrefix: string,
    currentLockFile: string,
): boolean {
    return sessionClaims.hasOtherActiveSessions(containerPrefix, currentLockFile);
}

export function hasOtherSessionClaims(
    containerPrefix: string,
    currentLockFile: string,
): boolean {
    return sessionClaims.hasOtherSessionClaims(containerPrefix, currentLockFile);
}

/**
 * Atomically prove replacement is currently allowed, then require that no
 * foreign ownership claim exists before destructive replacement. Session
 * creation takes the same lock, so a new CCC process cannot appear between
 * the final check and stop/rm.
 */
export function recreateContainerWithoutInterruptingSessions(
    containerPrefix: string,
    currentLockFile: string,
    recreate: () => void,
    replacementAllowed: () => boolean = () => true,
): boolean {
    return sessionClaims.recreateContainerWithoutInterruptingSessions(
        containerPrefix, currentLockFile, recreate, replacementAllowed,
    );
}

export function cleanupSession(): void {
    if (acquiringOwnership) throw new Error("Cannot clean up host session ownership during acquisition.");
    if (armingOwnership) throw new Error("Cannot clean up host session ownership while its guardian is arming.");
    if (capturedRuntimeInvocation) {
        void runWithNativeRuntimeInvocation(capturedRuntimeInvocation, () => sessionCleanup.cleanupSession());
    } else {
        void sessionCleanup.cleanupSession();
    }
    if (!sessionCleanup.getCurrentSession().lockFile) {
        const previous = ownership;
        ownership = null;
        sessionPublication.retire();
        ownershipAuthorization = null;
        capturedOwnership = null;
        capturedRuntimeInvocation = null;
        disposeSessionCleanupSignals?.();
        if (previous) void previous.release().catch(() => undefined);
    }
}

// Setup signal handlers for cleanup
export function setupSignalHandlers(): void {
    disposeSessionCleanupSignals?.();
    const runtimeInvocation = capturedRuntimeInvocation;
    const cleanup = () => {
        if (!acquiringOwnership) return cleanupSession();
        acquisitionCancellation ??= new Error("Host session ownership acquisition cancelled by signal.");
        return acquisitionSettled.then((outcome) => {
            const failed = outcome.kind === "failed" && outcome.error !== outcome.cancellation;
            try { cleanupSession(); }
            catch (cleanupError) {
                if (failed && outcome.kind === "failed") {
                    throw new AggregateError([outcome.error, cleanupError], "Session acquisition and signal cleanup failed.", { cause: outcome.error });
                }
                throw cleanupError;
            }
            if (failed && outcome.kind === "failed") throw outcome.error;
        });
    };
    disposeSessionCleanupSignals = setupNativeSessionCleanupSignals(() => runtimeInvocation
        ? runWithNativeRuntimeInvocation(runtimeInvocation, cleanup)
        : cleanup());
}
