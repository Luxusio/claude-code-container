import { basename, dirname, join, resolve } from "path";
import { withSharedMutationLock, withSharedMutationLockAsync } from "@ccc/device-lab/device-lab-shared-state.js";
import { getProjectId } from "@ccc/device-lab/project-identity.js";
import { captureNativeSessionOwnership, nativeSessionOwnershipMatches } from "../adapters/session-ownership.js";
import { sessionClaimPrefix, sessionLockClaimsForContainer } from "../domain/session-claims.js";
import { sessionLockOwner } from "../domain/session-lock.js";
import { locksDir } from "../home-layout.js";
import { createSessionClaimsStore } from "../adapters/session-claims-store.js";
import type { SessionOwnershipBinding, SessionOwnershipReceipt } from "../ports/session-ownership.js";

const claimsStore = createSessionClaimsStore({ directory: () => locksDir(), platform: () => process.platform });

export function withLifecycleLock<T>(prefix: string, operation: () => T): T {
    claimsStore.ensureDirectory();
    return withSharedMutationLock(join(locksDir(), `${prefix}.container-lifecycle.guard`), operation, { waitMs: 180_000 });
}

export async function withLifecycleLockAsync<T>(prefix: string, operation: () => T | Promise<T>): Promise<T> {
    claimsStore.ensureDirectory();
    return withSharedMutationLockAsync(join(locksDir(), `${prefix}.container-lifecycle.guard`), operation, { waitMs: 180_000 });
}

export function validateNativeSessionOwnership(
    binding: SessionOwnershipBinding, receipt: SessionOwnershipReceipt, ownerPid: number,
): void {
    if (!binding || !receipt || typeof binding.lockFile !== "string" || typeof binding.projectPath !== "string"
        || !binding.projectPath.length || (binding.profile !== undefined && typeof binding.profile !== "string")
        || (binding.toolName !== undefined && typeof binding.toolName !== "string")
        || typeof receipt.path !== "string" || receipt.path !== binding.lockFile
        || resolve(receipt.path) !== receipt.path || dirname(receipt.path) !== resolve(locksDir())
        || typeof receipt.bytes !== "string" || receipt.bytes.length > 8192
        || typeof receipt.device !== "string" || typeof receipt.inode !== "string"
        || typeof receipt.birthtime !== "string" || receipt.ownerPid !== ownerPid) {
        throw new Error("Invalid session ownership binding.");
    }
    const prefix = sessionClaimPrefix(getProjectId(binding.projectPath), binding.profile);
    const owner = sessionLockOwner(Buffer.from(receipt.bytes, "base64").toString("utf8"));
    if (owner?.pid !== ownerPid || !sessionLockClaimsForContainer([basename(receipt.path)], prefix).length) {
        throw new Error("Session ownership record does not match its owner or project.");
    }
}

export function assertNativeSessionOwnership(receipt: SessionOwnershipReceipt): void {
    if (!nativeSessionOwnershipMatches(receipt)) throw new Error("Session ownership receipt is absent, unreadable, or replaced.");
}

/** The caller holds the lifecycle guard. Failure to observe is not proof of revocation. */
export function isNativeSessionOwnershipRevoked(receipt: SessionOwnershipReceipt): boolean {
    let current: SessionOwnershipReceipt;
    try { current = captureNativeSessionOwnership(receipt.path); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
        throw error;
    }
    return current.bytes !== receipt.bytes || current.device !== receipt.device || current.inode !== receipt.inode
        || current.birthtime !== receipt.birthtime || current.ownerPid !== receipt.ownerPid;
}

export async function rollbackCapturedNativeSessionOwnership(
    binding: SessionOwnershipBinding, receipt: SessionOwnershipReceipt,
): Promise<void> {
    const { createNativeSessionClaims } = await import("./session-claims.js");
    const prefix = sessionClaimPrefix(getProjectId(binding.projectPath), binding.profile);
    await withLifecycleLockAsync(prefix, () => {
        if (isNativeSessionOwnershipRevoked(receipt)) return;
        createNativeSessionClaims(withLifecycleLock).settleCapturedResponsibilityInHeldLifecycleLock(binding, receipt);
    });
}

