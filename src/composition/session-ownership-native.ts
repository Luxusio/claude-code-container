import { basename, dirname, join, resolve } from "path";
import { withSharedMutationLock } from "@ccc/device-lab/device-lab-shared-state.js";
import { getProjectId } from "@ccc/device-lab/project-identity.js";
import { nativeSessionOwnershipMatches, removeCapturedNativeSessionOwnership } from "../adapters/session-ownership.js";
import { sessionClaimPrefix, sessionLockClaimsForContainer } from "../domain/session-claims.js";
import { sessionLockOwner } from "../domain/session-lock.js";
import { locksDir } from "../home-layout.js";
import { ensureNativeSessionClaimsDirectory } from "./session-claims.js";
import type { SessionOwnershipBinding, SessionOwnershipReceipt } from "../ports/session-ownership.js";

export function withLifecycleLock<T>(prefix: string, operation: () => T): T {
    ensureNativeSessionClaimsDirectory();
    return withSharedMutationLock(join(locksDir(), `${prefix}.container-lifecycle.guard`), operation, { waitMs: 180_000 });
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

export function rollbackCapturedNativeSessionOwnership(
    binding: SessionOwnershipBinding, receipt: SessionOwnershipReceipt,
): void {
    const prefix = sessionClaimPrefix(getProjectId(binding.projectPath), binding.profile);
    withLifecycleLock(prefix, () => {
        if (nativeSessionOwnershipMatches(receipt)) removeCapturedNativeSessionOwnership(receipt);
    });
}

