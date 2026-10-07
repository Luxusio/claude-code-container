import { join } from "path";
import { locksDir } from "./home-layout.js";
import { withSharedMutationLock, withSharedMutationLockAsync } from "@ccc/device-lab/device-lab-shared-state.js";
import { createNativeSessionClaims, ensureNativeSessionClaimsDirectory } from "./composition/session-claims.js";
import { armNativeSessionOwnership, assertNativeSessionOwnership, validateNativeSessionOwnership } from "./composition/session-ownership.js";
import { captureNativeSessionOwnership, nativeSessionOwnershipMatches, removeCapturedNativeSessionOwnership } from "./adapters/session-ownership.js";
import { createSessionAcquisition } from "./application/session-acquisition.js";
import type { SessionAcquisitionPorts, SessionAcquisitionRequest } from "./ports/session-acquisition.js";
import { runtimeCli } from "./container-runtime.js";
import type { SessionOwnershipHandle, SessionOwnershipReceipt } from "./ports/session-ownership.js";
import {
    createNativeSessionCleanup,
    removeNativeSessionClaim,
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

const sessionCleanup = createNativeSessionCleanup(
    (prefix, operation) => withContainerLifecycleLock(prefix, () => {
        ownershipAuthorization?.();
        return operation();
    }),
    (prefix, ownPath) => sessionClaims.hasOtherReconciledSessionClaims(prefix, ownPath),
);

let ownership: SessionOwnershipHandle | null = null;
let armingOwnership = false;
let acquiringOwnership = false;
let acquisitionFailure: Error | null = null;
let ownershipAuthorization: (() => void) | null = null;
let capturedOwnership: SessionOwnershipReceipt | null = null;
let pendingOwnershipUpdate: Promise<void> = Promise.resolve();
let capturedContainerId: string | null = null;
let sessionCleanupEnabled = true;
let cleanupAuthorizationVersion = 0;

function ownershipFailed(error: Error): void {
    if (acquiringOwnership) { acquisitionFailure = error; return; }
    console.error("[ccc] Host session ownership monitor failed; ending this session.");
    process.exitCode = 1;
    // Run the existing owned command interruption and session cleanup handlers.
    process.emit("SIGTERM");
}

async function armOwnershipInContext(rollback?: (binding: unknown, receipt: SessionOwnershipReceipt) => void): Promise<number | undefined> {
    const current = sessionCleanup.getCurrentSession();
    if (!current.lockFile || !current.projectPath || ownership || armingOwnership) {
        throw new Error("Cannot arm host session ownership without a unique current session.");
    }
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
            onCaptured: (receipt) => {
                if (capturedOwnership) ownershipAuthorization!();
                else {
                    const captured = Object.freeze({ ...receipt });
                    capturedOwnership = captured;
                    ownershipAuthorization = () => assertNativeSessionOwnership(captured);
                }
            },
            rollback,
        });
        return ownership.pid;
    } finally {
        armingOwnership = false;
    }
}

export async function armSessionOwnership(): Promise<number | undefined> {
    if (acquiringOwnership) throw new Error("Host session ownership is already being acquired.");
    return armOwnershipInContext();
}

export async function acquireHostSessionOwnership(
    request: SessionAcquisitionRequest,
    inspectExisting: SessionAcquisitionPorts["inspectExisting"],
): Promise<{ lockFile: string; existingId: string | null }> {
    if (ownership || armingOwnership || acquiringOwnership || sessionCleanup.getCurrentSession().lockFile) {
        throw new Error("Host session ownership is already being acquired.");
    }
    acquiringOwnership = true;
    acquisitionFailure = null;
    const rollbackOwn = (_binding: unknown, receipt: SessionOwnershipReceipt) => {
        if (nativeSessionOwnershipMatches(receipt)) removeCapturedNativeSessionOwnership(receipt);
    };
    try {
        const acquired = await createSessionAcquisition({
            withLifecycleLock: withContainerLifecycleLockAsync,
            reserve: sessionClaims.reserveSessionLockInHeldLifecycleLock,
            initializeCapture(binding, lockFile) {
                sessionCleanup.setSession(lockFile, binding.projectPath, binding.profile, binding.toolName);
                capturedContainerId = null;
                sessionCleanupEnabled = false;
                sessionCleanup.setSessionCleanupEnabled(false);
                cleanupAuthorizationVersion++;
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
                await armOwnershipInContext(rollbackOwn);
                if (acquisitionFailure) throw acquisitionFailure;
            },
            async acknowledge(id, runtime) {
                await ownership!.updateContainer(id, runtime, false);
                capturedContainerId = id;
                sessionCleanup.setSessionContainerId(id);
            },
            reconcileForeign(prefix, lockFile) {
                if (acquisitionFailure) throw acquisitionFailure;
                return sessionClaims.reconcileForeignClaimsInHeldLifecycleLock(prefix, lockFile);
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
                pendingOwnershipUpdate = Promise.resolve();
                capturedContainerId = null;
                sessionCleanupEnabled = true;
                cleanupAuthorizationVersion++;
                if (previous) await previous.release();
            },
        }).run(request);
        if (acquisitionFailure) throw acquisitionFailure;
        return acquired;
    } finally {
        acquiringOwnership = false;
        acquisitionFailure = null;
    }
}

export async function confirmSessionOwnership(): Promise<void> {
    await pendingOwnershipUpdate;
    ownership?.assertOwnership();
}

export function setSession(lockFile: string, projectPath: string, profile?: string, toolName?: string): void {
    if (ownership || armingOwnership || acquiringOwnership || ownershipAuthorization) {
        throw new Error("Cannot replace an owned host session before cleanup.");
    }
    sessionCleanup.setSession(lockFile, projectPath, profile, toolName);
    capturedContainerId = null;
    sessionCleanupEnabled = true;
    cleanupAuthorizationVersion++;
    ownershipAuthorization = null;
    capturedOwnership = null;
}

/** Capture and shutdown authorization are separate; a failed join only drops its claim. */
export function setSessionCleanupEnabled(enabled: boolean): void {
    if (typeof enabled !== "boolean") throw new TypeError("Invalid session cleanup authorization.");
    if (acquiringOwnership) throw new Error("Cannot update host session ownership during acquisition.");
    sessionCleanupEnabled = enabled;
    const version = ++cleanupAuthorizationVersion;
    if (!enabled || !ownership) sessionCleanup.setSessionCleanupEnabled(enabled);
    queueOwnershipUpdate(version);
}

function queueOwnershipUpdate(version: number): void {
    if (!ownership) return;
    const activeOwnership = ownership;
    const containerId = capturedContainerId;
    const enabled = sessionCleanupEnabled;
    const runtime = runtimeCli();
    if (runtime !== "docker" && runtime !== "podman") throw new Error("Invalid session container runtime.");
    pendingOwnershipUpdate = pendingOwnershipUpdate.then(async () => {
        await activeOwnership.updateContainer(containerId, runtime, enabled);
        // A stale successful ACK must not reauthorize a subsequently revoked session.
        if (ownership === activeOwnership && cleanupAuthorizationVersion === version) {
            sessionCleanup.setSessionCleanupEnabled(enabled);
        }
    });
    // ACK failure invokes ownershipFailed; consume now while confirm retains rejection.
    void pendingOwnershipUpdate.catch(() => undefined);
}

export function setSessionContainerId(containerId: string | null): void {
    if (acquiringOwnership) throw new Error("Cannot update host session ownership during acquisition.");
    // Permission belongs to the captured identity, never its replacement. Revoke
    // before publishing a different ID so guardian EOF cannot stop a failed join.
    if (ownership && capturedContainerId !== containerId) {
        sessionCleanupEnabled = false;
        sessionCleanup.setSessionCleanupEnabled(false);
    }
    capturedContainerId = containerId;
    sessionCleanup.setSessionContainerId(containerId);
    queueOwnershipUpdate(++cleanupAuthorizationVersion);
}

export function getCurrentSession(): { lockFile: string | null; projectPath: string | null; profile?: string; toolName: string | null } {
    return sessionCleanup.getCurrentSession();
}

export function clearSession(): void {
    if (armingOwnership || acquiringOwnership) throw new Error("Cannot clear host session ownership during acquisition.");
    if (ownership) cleanupSession();
    sessionCleanup.clearSession();
    capturedContainerId = null;
    sessionCleanupEnabled = true;
    cleanupAuthorizationVersion++;
    ownershipAuthorization = null;
    capturedOwnership = null;
}

export function createSessionLock(projectId: string, profile?: string): string {
    return sessionClaims.createSessionLock(projectId, profile);
}

export function removeSessionLock(lockFile: string): void {
    removeNativeSessionClaim(lockFile);
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

/**
 * Return raw ownership claims without PID/start-token inference.
 * Automatic container shutdown must not turn an imperfect Windows process
 * observation into permission to terminate another session.
 */
export function getSessionLockClaimsForContainer(containerPrefix: string): string[] {
    return sessionClaims.getSessionLockClaimsForContainer(containerPrefix);
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
    sessionCleanup.cleanupSession();
    if (!sessionCleanup.getCurrentSession().lockFile) {
        const previous = ownership;
        ownership = null;
        pendingOwnershipUpdate = Promise.resolve();
        capturedContainerId = null;
        sessionCleanupEnabled = true;
        cleanupAuthorizationVersion++;
        ownershipAuthorization = null;
        capturedOwnership = null;
        if (previous) void previous.release().catch(() => undefined);
    }
}

// Setup signal handlers for cleanup
export function setupSignalHandlers(): void {
    setupNativeSessionCleanupSignals(() => cleanupSession());
}
