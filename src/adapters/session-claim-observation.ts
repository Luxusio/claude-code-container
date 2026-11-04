import { createHash, randomUUID } from "crypto";
import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { basename, dirname, resolve } from "path";
import { getProjectId } from "@ccc/device-lab/project-identity.js";
import { decodeSessionClaimObservation, type SessionClaimFileIdentity, type SessionClaimObservation,
    type SessionClaimObservationBinding } from "../domain/session-claim-observation.js";
import { sessionClaimPrefix, sessionLockClaimsForContainer } from "../domain/session-claims.js";
import { sessionLockOwner } from "../domain/session-lock.js";
import type { BeginSessionClaimObservation, NativeSessionFileReceipt, SessionClaimObservationSnapshot,
    SessionClaimObservationStore } from "../ports/session-claim-observation.js";
import type { SessionOwnershipReceipt } from "../ports/session-ownership.js";
import { validateNativeRuntimeInvocation } from "./container-runtime-invocation.js";
import { captureNativeSessionFile, nativeSessionOwnershipMatches } from "./session-ownership.js";

const OBSERVATION_LIMIT = 16384;
const RUNTIME_LIMIT = 65536;
const changed = (): never => { throw new Error("Session claim observation is absent, unreadable, or replaced."); };

function digest(bytes: string): string { return createHash("sha256").update(Buffer.from(bytes, "base64")).digest("hex"); }

function identity(receipt: NativeSessionFileReceipt): SessionClaimFileIdentity {
    return { path: receipt.path, device: receipt.device, inode: receipt.inode, birthtime: receipt.birthtime, digest: digest(receipt.bytes) };
}

function sameFile(left: NativeSessionFileReceipt, right: NativeSessionFileReceipt): boolean {
    return left.path === right.path && left.bytes === right.bytes && left.device === right.device
        && left.inode === right.inode && left.birthtime === right.birthtime;
}

function sameIdentity(left: SessionClaimFileIdentity, right: SessionClaimFileIdentity): boolean {
    return left.path === right.path && left.digest === right.digest && left.device === right.device
        && left.inode === right.inode && left.birthtime === right.birthtime;
}

function missing(path: string): boolean {
    try { lstatSync(path); return false; }
    catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return true;
        throw error;
    }
}

function privateDirectory(path: string) {
    if (resolve(path) !== path) return changed();
    const stat = lstatSync(dirname(path), { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.mode & 0o077n) !== 0n)) return changed();
    return { device: stat.dev, inode: stat.ino, birthtime: stat.birthtimeNs };
}

function privateFile(path: string, maximum: number): NativeSessionFileReceipt {
    const receipt = captureNativeSessionFile(path, maximum);
    const stat = lstatSync(path, { bigint: true });
    if (process.platform !== "win32" && (stat.mode & 0o077n) !== 0n) return changed();
    return receipt;
}

function sameDirectory(path: string, before: ReturnType<typeof privateDirectory>): void {
    const after = privateDirectory(path);
    if (before.device !== after.device || before.inode !== after.inode || before.birthtime !== after.birthtime) return changed();
}

function paths(receipt: SessionOwnershipReceipt) {
    return { observation: `${receipt.path}.guardian.json`, runtime: `${receipt.path}.runtime.json` };
}

function validateBinding(receipt: SessionOwnershipReceipt, binding: SessionClaimObservationBinding): void {
    if (binding.lockFile !== receipt.path || resolve(binding.projectPath) !== binding.projectPath
        || sessionClaimPrefix(getProjectId(binding.projectPath), binding.profile) !== binding.prefix
        || !sessionLockClaimsForContainer([basename(receipt.path)], binding.prefix).length) return changed();
}

function serialized(value: unknown, maximum: number): string {
    const text = JSON.stringify(value);
    if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > maximum) return changed();
    return text;
}

function exclusiveWrite(path: string, content: string, maximum: number): NativeSessionFileReceipt {
    const directory = privateDirectory(path);
    const fd = openSync(path, "wx", 0o600);
    try {
        const opened = fstatSync(fd, { bigint: true });
        if (!opened.isFile()) return changed();
        writeFileSync(fd, content, "utf8");
        fsyncSync(fd);
    } finally { closeSync(fd); }
    sameDirectory(path, directory);
    return privateFile(path, maximum);
}

function freezeSnapshot(snapshot: SessionClaimObservationSnapshot): SessionClaimObservationSnapshot {
    return Object.freeze({ ...snapshot, receipt: Object.freeze({ ...snapshot.receipt }),
        runtimeReceipt: Object.freeze({ ...snapshot.runtimeReceipt }), observationReceipt: Object.freeze({ ...snapshot.observationReceipt }) });
}

/** All mutations run inside the caller's lifecycle guard; this adapter never acquires a second guard. */
export function createNativeSessionClaimObservationStore(): SessionClaimObservationStore {
    function read(receipt: SessionOwnershipReceipt,
        requested: SessionClaimObservationBinding | { readonly prefix: string }): SessionClaimObservationSnapshot | null {
        const directory = privateDirectory(receipt.path);
        if (!nativeSessionOwnershipMatches(receipt)) return changed();
        const sidecars = paths(receipt);
        if (missing(sidecars.observation)) {
            if (!missing(sidecars.runtime)) return changed();
            sameDirectory(receipt.path, directory);
            if (!nativeSessionOwnershipMatches(receipt) || !missing(sidecars.observation)
                || !missing(sidecars.runtime)) return changed();
            return null;
        }
        const observationReceipt = privateFile(sidecars.observation, OBSERVATION_LIMIT);
        const observation = decodeSessionClaimObservation(JSON.parse(Buffer.from(observationReceipt.bytes, "base64").toString("utf8")));
        const owner = sessionLockOwner(Buffer.from(receipt.bytes, "base64").toString("utf8"));
        validateBinding(receipt, observation.binding);
        if (owner?.ownershipKind !== "monitored" || observation.claim.ownerPid !== receipt.ownerPid
            || !sameIdentity(observation.claim, identity(receipt)) || observation.binding.prefix !== requested.prefix
            || observation.runtime.path !== sidecars.runtime) return changed();
        if ("lockFile" in requested && (requested.lockFile !== observation.binding.lockFile
            || requested.projectPath !== observation.binding.projectPath || requested.profile !== observation.binding.profile
            || requested.toolName !== observation.binding.toolName)) return changed();
        const runtimeReceipt = privateFile(sidecars.runtime, RUNTIME_LIMIT);
        if (!sameIdentity(observation.runtime, identity(runtimeReceipt))) return changed();
        const runtimeInvocation = validateNativeRuntimeInvocation(JSON.parse(Buffer.from(runtimeReceipt.bytes, "base64").toString("utf8")));
        if (!nativeSessionOwnershipMatches(receipt) || !sameFile(observationReceipt, privateFile(sidecars.observation, OBSERVATION_LIMIT))
            || !sameFile(runtimeReceipt, privateFile(sidecars.runtime, RUNTIME_LIMIT))) return changed();
        sameDirectory(receipt.path, directory);
        return freezeSnapshot({ observation, receipt, runtimeInvocation, runtimeReceipt, observationReceipt });
    }

    function assertCurrent(snapshot: SessionClaimObservationSnapshot): void {
        const current = read(snapshot.receipt, snapshot.observation.binding);
        if (!current || !sameFile(current.observationReceipt, snapshot.observationReceipt)
            || !sameFile(current.runtimeReceipt, snapshot.runtimeReceipt)
            || JSON.stringify(current.observation) !== JSON.stringify(snapshot.observation)) return changed();
    }

    function begin(options: BeginSessionClaimObservation): SessionClaimObservationSnapshot {
        const { receipt, binding } = options;
        privateDirectory(receipt.path);
        validateBinding(receipt, binding);
        if (!nativeSessionOwnershipMatches(receipt)
            || sessionLockOwner(Buffer.from(receipt.bytes, "base64").toString("utf8"))?.ownershipKind !== "monitored") return changed();
        const sidecars = paths(receipt);
        if (!missing(sidecars.observation) || !missing(sidecars.runtime)) return changed();
        const runtimeInvocation = validateNativeRuntimeInvocation(options.runtimeInvocation);
        const runtimeReceipt = exclusiveWrite(sidecars.runtime, serialized(runtimeInvocation, RUNTIME_LIMIT), RUNTIME_LIMIT);
        try {
            const observation = decodeSessionClaimObservation({
                version: 1, claim: { ...identity(receipt), ownerPid: receipt.ownerPid }, binding,
                runtime: identity(runtimeReceipt), guardian: options.guardian, generation: options.generation,
                registration: "pending", pending: null, lastAcknowledged: null, ownStarted: null,
                recovery: { status: "active", diagnostic: null },
            });
            if (!nativeSessionOwnershipMatches(receipt)) return changed();
            exclusiveWrite(sidecars.observation, serialized(observation, OBSERVATION_LIMIT), OBSERVATION_LIMIT);
            const snapshot = read(receipt, binding);
            if (!snapshot) return changed();
            return snapshot;
        } catch (error) {
            // An incomplete published observation is retained. Only an unreferenced,
            // unchanged runtime created by this attempt may be rolled back.
            if (missing(sidecars.observation) && nativeSessionOwnershipMatches(receipt)
                && sameFile(runtimeReceipt, privateFile(sidecars.runtime, RUNTIME_LIMIT))) unlinkSync(sidecars.runtime);
            throw error;
        }
    }

    function update(snapshot: SessionClaimObservationSnapshot, value: SessionClaimObservation): SessionClaimObservationSnapshot {
        assertCurrent(snapshot);
        const next = decodeSessionClaimObservation(value);
        const previous = snapshot.observation;
        if (!sameIdentity(next.claim, previous.claim) || next.claim.ownerPid !== previous.claim.ownerPid
            || !sameIdentity(next.runtime, previous.runtime) || JSON.stringify(next.binding) !== JSON.stringify(previous.binding)
            || next.guardian.pid !== previous.guardian.pid || next.guardian.startToken !== previous.guardian.startToken) return changed();
        const path = snapshot.observationReceipt.path;
        const directory = privateDirectory(path);
        const temporaryPath = `${path}.${randomUUID()}.tmp`;
        const temporary = exclusiveWrite(temporaryPath, serialized(next, OBSERVATION_LIMIT), OBSERVATION_LIMIT);
        try {
            assertCurrent(snapshot);
            sameDirectory(path, directory);
            if (!sameFile(temporary, privateFile(temporaryPath, OBSERVATION_LIMIT))) return changed();
            renameSync(temporaryPath, path);
            const current = read(snapshot.receipt, previous.binding);
            if (!current) return changed();
            return current;
        } finally {
            if (!missing(temporaryPath) && sameFile(temporary, privateFile(temporaryPath, OBSERVATION_LIMIT))) unlinkSync(temporaryPath);
        }
    }

    function retire(snapshot: SessionClaimObservationSnapshot): void {
        const directory = privateDirectory(snapshot.receipt.path);
        if (!missing(snapshot.receipt.path) && !nativeSessionOwnershipMatches(snapshot.receipt)) return changed();
        if (!sameFile(snapshot.observationReceipt, privateFile(snapshot.observationReceipt.path, OBSERVATION_LIMIT))
            || !sameFile(snapshot.runtimeReceipt, privateFile(snapshot.runtimeReceipt.path, RUNTIME_LIMIT))) return changed();
        sameDirectory(snapshot.receipt.path, directory);
        // Main-claim retirement is an application completion boundary. These are
        // only the two exact auxiliary files, never a successor's main claim.
        unlinkSync(snapshot.observationReceipt.path);
        if (!missing(snapshot.receipt.path) && !nativeSessionOwnershipMatches(snapshot.receipt)) return changed();
        if (!sameFile(snapshot.runtimeReceipt, privateFile(snapshot.runtimeReceipt.path, RUNTIME_LIMIT))) return changed();
        unlinkSync(snapshot.runtimeReceipt.path);
    }

    return { begin, read, assertCurrent, update, retire, matches(snapshot) {
        try { assertCurrent(snapshot); return true; } catch { return false; }
    } };
}
