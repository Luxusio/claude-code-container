import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProjectId } from "@ccc/device-lab/project-identity.js";
import { encodeSessionClaim, sessionClaimPrefix } from "../../domain/session-claims.js";
import {
    canTransferSessionClaimObligation, currentSessionClaimAuthority, decodeSessionClaimObservation,
    selectSessionClaimRecoverySurvivor, sessionClaimPeerVetoes, type SessionClaimObservation,
} from "../../domain/session-claim-observation.js";
import { createNativeSessionClaimObservationStore } from "../../adapters/session-claim-observation.js";
import { validateNativeRuntimeInvocation } from "../../adapters/container-runtime-invocation.js";
import { captureNativeSessionOwnership, removeCapturedNativeSessionOwnership } from "../../adapters/session-ownership.js";
import { NATIVE_RUNTIME_SELECTOR_KEYS, type NativeRuntimeSelectors } from "../../ports/container-runtime-invocation.js";
import { fileSymlinkOrSkip } from "../helpers/file-symlink-fixture.js";

const fullId = "a".repeat(64);
const otherId = "b".repeat(64);
const generation = "guardian-generation-1";

function observation(path = "/claims/project--owner.lock"): SessionClaimObservation {
    return {
        version: 1,
        claim: { path, device: "1", inode: "2", birthtime: "3", digest: "c".repeat(64), ownerPid: 42 },
        binding: { lockFile: path, projectPath: "/project", prefix: "project" },
        runtime: { path: `${path}.runtime.json`, device: "1", inode: "4", birthtime: "5", digest: "d".repeat(64) },
        guardian: { pid: 43, startToken: "guardian-start" },
        registration: "ready", generation, pending: null,
        lastAcknowledged: { generation, sequence: 1, containerId: fullId, cleanupEnabled: true },
        ownStarted: null,
        recovery: { status: "active", diagnostic: null },
    };
}

describe("durable guardian authority", () => {
    it("requires a current ready acknowledged full ID and actual cleanup grant", () => {
        const current = observation();
        expect(currentSessionClaimAuthority(current)).toEqual({ containerId: fullId, source: "ack" });
        for (const changed of [
            { ...current, registration: "pending" as const },
            { ...current, generation: "superseding-generation" },
            { ...current, lastAcknowledged: { ...current.lastAcknowledged!, cleanupEnabled: false } },
            { ...current, lastAcknowledged: null },
        ]) expect(currentSessionClaimAuthority(changed)).toBeNull();
    });

    it("invalidates an old ACK synchronously while an update is pending", () => {
        const current = observation();
        const pending = { generation, sequence: 2, kind: "update" as const, containerId: fullId, cleanupEnabled: true };
        expect(currentSessionClaimAuthority({ ...current, pending })).toBeNull();
        expect(currentSessionClaimAuthority({ ...current, pending: { ...pending, cleanupEnabled: false } })).toBeNull();
        expect(currentSessionClaimAuthority({ ...current, generation: "revoked", pending: null })).toBeNull();
    });

    it("does not turn startup intent or an unacknowledged true request into shutdown authority", () => {
        const current = { ...observation(), registration: "pending" as const, lastAcknowledged: null };
        for (const kind of ["startup", "update"] as const) {
            expect(currentSessionClaimAuthority({ ...current,
                pending: { generation, sequence: 1, kind, containerId: fullId, cleanupEnabled: true },
            })).toBeNull();
        }
    });

    it("retains positive own-start compensation independently of an earlier unacknowledged request", () => {
        const current = { ...observation(), registration: "pending" as const, lastAcknowledged: null,
            pending: { generation, sequence: 2, kind: "update" as const, containerId: fullId, cleanupEnabled: true },
            ownStarted: { generation, containerId: fullId },
        };
        expect(currentSessionClaimAuthority(current)).toEqual({ containerId: fullId, source: "own-start" });
        expect(currentSessionClaimAuthority({ ...current, ownStarted: { ...current.ownStarted, generation: "old" } })).toBeNull();
        expect(currentSessionClaimAuthority({ ...current, pending: { ...current.pending, cleanupEnabled: false } })).toBeNull();
        expect(currentSessionClaimAuthority({ ...current, pending: { ...current.pending, containerId: otherId } })).toBeNull();
    });

    it("separates shared device protection from an acknowledged different container", () => {
        expect(sessionClaimPeerVetoes(fullId, [])).toEqual({ sharedDeviceCleanupBlocked: false, exactContainerStopBlocked: false });
        for (const cleanupEnabled of [false, true]) {
            const peer = { ...observation(), lastAcknowledged: { generation, sequence: 1, containerId: otherId, cleanupEnabled } };
            expect(sessionClaimPeerVetoes(fullId, [peer])).toEqual({ sharedDeviceCleanupBlocked: true, exactContainerStopBlocked: false });
        }
    });

    it("keeps same-ID, short-ID, pending, legacy and unacknowledged peers as both vetoes", () => {
        const peer = observation();
        const peers = [null, peer,
            { ...peer, registration: "pending" as const },
            { ...peer, generation: "superseding-generation" },
            { ...peer, lastAcknowledged: { ...peer.lastAcknowledged!, containerId: "b".repeat(12) } },
            { ...peer, lastAcknowledged: null, ownStarted: { generation, containerId: otherId } },
            { ...peer, pending: { generation, sequence: 2, kind: "update" as const, containerId: otherId, cleanupEnabled: true } },
        ];
        for (const uncertain of peers) {
            expect(sessionClaimPeerVetoes(fullId, [uncertain])).toEqual({ sharedDeviceCleanupBlocked: true, exactContainerStopBlocked: true });
        }
        expect(sessionClaimPeerVetoes(null, [peer])).toEqual({ sharedDeviceCleanupBlocked: true, exactContainerStopBlocked: true });
    });

    it("does not transfer a true cleanup obligation to a false join or a different captured authority", () => {
        const predecessor = observation("/claims/project--a.lock");
        const successor = observation("/claims/project--b.lock");
        expect(canTransferSessionClaimObligation(predecessor, successor)).toBe(true);
        expect(canTransferSessionClaimObligation(predecessor, { ...successor,
            lastAcknowledged: { ...successor.lastAcknowledged!, cleanupEnabled: false },
        })).toBe(false);
        expect(canTransferSessionClaimObligation(predecessor, { ...successor,
            runtime: { ...successor.runtime, digest: "e".repeat(64) },
        })).toBe(false);
        expect(canTransferSessionClaimObligation(predecessor, { ...successor,
            lastAcknowledged: { ...successor.lastAcknowledged!, containerId: otherId },
        })).toBe(false);
    });

    it("selects one stable all-dead obligation survivor without endpoint guesses or transfer cycles", () => {
        const a = observation("/claims/project--a.lock");
        const b = observation("/claims/project--b.lock");
        const c = observation("/claims/project--c.lock");
        expect(selectSessionClaimRecoverySurvivor([c, b, a])?.claim.path).toBe(a.claim.path);
        expect(selectSessionClaimRecoverySurvivor([a, c, b])?.claim.path).toBe(a.claim.path);
        expect(selectSessionClaimRecoverySurvivor([a, { ...b, runtime: { ...b.runtime, digest: "e".repeat(64) } }])).toBeNull();
    });
});

describe("private native guardian evidence store", () => {
    let root: string;
    beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ccc-claim-observation-")); chmodSync(root, 0o700); });
    afterEach(() => { rmSync(root, { recursive: true, force: true }); });

    function fixture(options: { longRuntime?: boolean } = {}) {
        const projectPath = join(root, "project");
        mkdirSync(projectPath);
        const prefix = sessionClaimPrefix(getProjectId(projectPath), "work");
        const lockFile = join(root, `${prefix}--owner.lock`);
        writeFileSync(lockFile, encodeSessionClaim(process.pid, "parent-start", "monitored"), { flag: "wx", mode: 0o600 });
        const receipt = captureNativeSessionOwnership(lockFile);
        const binding = { lockFile, projectPath, profile: "work", toolName: "claude", prefix };
        const runtimeInvocation = validateNativeRuntimeInvocation({
            version: 1, runtime: "docker", executable: process.execPath,
            transport: { kind: "docker", host: "unix:///fixture/engine-a.sock", configDirectory: join(root, "config"),
                tls: { enabled: false, verify: false, caFile: null, certFile: null, keyFile: null } },
            selectors: Object.fromEntries(NATIVE_RUNTIME_SELECTOR_KEYS.map(key => [key,
                options.longRuntime && key === "PATH" ? "p".repeat(5000) : null])) as NativeRuntimeSelectors,
        });
        const store = createNativeSessionClaimObservationStore();
        const begin = () => store.begin({ receipt, binding, runtimeInvocation,
            guardian: { pid: process.pid + 1, startToken: "guardian-start" }, generation });
        return { store, begin, receipt, binding, runtimeInvocation };
    }

    it.each(["4242", JSON.stringify({ version: 2, pid: 4242, startToken: "legacy-start" })])("positively distinguishes absent sidecars on a captured pre-v3 record: %s", content => {
        const f = fixture(); writeFileSync(f.binding.lockFile, content, { mode: 0o600 });
        const receipt = captureNativeSessionOwnership(f.binding.lockFile);
        expect(f.store.read(receipt, { prefix: f.binding.prefix })).toBeNull();
        expect(readFileSync(receipt.path, "utf8")).toBe(content);
    });
    it.each(["runtime", "guardian"] as const)("retains partial %s evidence on a legacy main record as incomplete", sidecar => {
        const f = fixture(); writeFileSync(f.binding.lockFile, "4242", { mode: 0o600 });
        const receipt = captureNativeSessionOwnership(f.binding.lockFile);
        writeFileSync(`${receipt.path}.${sidecar}.json`, "{}", { mode: 0o600 });
        expect(() => f.store.read(receipt, { prefix: f.binding.prefix })).toThrow();
        expect(readFileSync(receipt.path, "utf8")).toBe("4242");
    });

    it("keeps the immutable small main claim separate from bounded private runtime and observation files", () => {
        const f = fixture({ longRuntime: true });
        const original = readFileSync(f.binding.lockFile);
        const mainStat = statSync(f.binding.lockFile, { bigint: true });
        expect(f.store.read(f.receipt, f.binding)).toBeNull();
        const captured = f.begin();
        expect(Buffer.byteLength(JSON.stringify(f.runtimeInvocation), "utf8")).toBeGreaterThan(4096);
        expect(captured.runtimeInvocation).toEqual(f.runtimeInvocation);
        expect(captured.observation.runtime.path).toBe(`${f.binding.lockFile}.runtime.json`);
        expect(captured.observationReceipt.path).toBe(`${f.binding.lockFile}.guardian.json`);
        expect(statSync(captured.runtimeReceipt.path).size).toBeLessThanOrEqual(65536);
        expect(statSync(captured.observationReceipt.path).size).toBeLessThanOrEqual(16384);
        expect(readFileSync(f.binding.lockFile)).toEqual(original);
        expect(statSync(f.binding.lockFile, { bigint: true }).ino).toBe(mainStat.ino);
        expect(statSync(f.binding.lockFile, { bigint: true }).mode).toBe(mainStat.mode);
        if (process.platform !== "win32") {
            expect(Number(statSync(captured.runtimeReceipt.path).mode & 0o777)).toBe(0o600);
            expect(Number(statSync(captured.observationReceipt.path).mode & 0o777)).toBe(0o600);
        }
    });

    it("publishes a qualified new observation without rewriting the main record or accepting a stale writer", () => {
        const f = fixture();
        const initial = f.begin();
        const original = readFileSync(f.binding.lockFile);
        const published = f.store.update(initial, { ...initial.observation, registration: "ready",
            lastAcknowledged: { generation, sequence: 1, containerId: fullId, cleanupEnabled: true } });
        expect(f.store.read(f.receipt, f.binding)?.observation).toEqual(published.observation);
        expect(() => f.store.update(initial, { ...initial.observation, recovery: { status: "recovery-needed", diagnostic: "old-writer" } })).toThrow();
        expect(() => f.store.retire(initial)).toThrow();
        expect(f.store.read(f.receipt, f.binding)?.observation).toEqual(published.observation);
        expect(readFileSync(f.binding.lockFile)).toEqual(original);
    });

    it("does not overwrite an existing guardian registration on duplicate begin", () => {
        const f = fixture();
        const captured = f.begin();
        const main = readFileSync(f.binding.lockFile);
        expect(() => f.begin()).toThrow();
        expect(f.store.read(f.receipt, f.binding)?.observation).toEqual(captured.observation);
        expect(readFileSync(f.binding.lockFile)).toEqual(main);
    });

    it.each(["projectPath", "profile", "prefix", "toolName", "lockFile"] as const)("refuses a changed %s binding without changing evidence", field => {
        const f = fixture();
        const captured = f.begin();
        const original = readFileSync(captured.observationReceipt.path);
        expect(() => f.store.read(f.receipt, { ...f.binding, [field]: `${f.binding[field]}-other` })).toThrow();
        expect(readFileSync(captured.observationReceipt.path)).toEqual(original);
        expect(f.store.read(f.receipt, f.binding)?.observation).toEqual(captured.observation);
    });

    it.each(["main", "runtime", "observation"] as const)("refuses same-byte new-inode %s successors and preserves them", field => {
        const f = fixture();
        const captured = f.begin();
        const path = field === "main" ? f.binding.lockFile
            : field === "runtime" ? captured.runtimeReceipt.path : captured.observationReceipt.path;
        const original = readFileSync(path);
        const oldInode = statSync(path, { bigint: true }).ino;
        renameSync(path, `${path}.retired`);
        writeFileSync(path, original, { flag: "wx", mode: 0o600 });
        expect(statSync(path, { bigint: true }).ino).not.toBe(oldInode);
        expect(f.store.matches(captured)).toBe(false);
        if (field !== "observation") expect(() => f.store.read(f.receipt, f.binding)).toThrow();
        expect(() => f.store.update(captured, captured.observation)).toThrow();
        expect(() => f.store.retire(captured)).toThrow();
        expect(readFileSync(path)).toEqual(original);
        expect(existsSync(captured.runtimeReceipt.path)).toBe(true);
        expect(existsSync(captured.observationReceipt.path)).toBe(true);
    });

    it.each(["main", "runtime"] as const)("rejects changed %s bytes even when the existing file identity is unchanged", field => {
        const f = fixture();
        const captured = f.begin();
        const path = field === "main" ? f.binding.lockFile : captured.runtimeReceipt.path;
        const original = readFileSync(path, "utf8");
        const inode = statSync(path, { bigint: true }).ino;
        writeFileSync(path, `${original}\n`);
        expect(statSync(path, { bigint: true }).ino).toBe(inode);
        expect(f.store.matches(captured)).toBe(false);
        expect(() => f.store.read(f.receipt, f.binding)).toThrow();
        expect(() => f.store.retire(captured)).toThrow();
        expect(readFileSync(path, "utf8")).toBe(`${original}\n`);
    });

    it.for(["runtime", "observation"] as const)("refuses a symbolic %s path without touching its target", (field, context) => {
        const f = fixture();
        const captured = f.begin();
        const path = field === "runtime" ? captured.runtimeReceipt.path : captured.observationReceipt.path;
        const target = `${path}.target`;
        const original = readFileSync(path);
        renameSync(path, target);
        fileSymlinkOrSkip(context, target, path);
        expect(() => f.store.read(f.receipt, f.binding)).toThrow();
        expect(() => f.store.retire(captured)).toThrow();
        expect(readFileSync(target)).toEqual(original);
    });

    it.each(["runtime", "observation"] as const)("refuses oversized %s data even when padded JSON would otherwise parse", field => {
        const f = fixture();
        const captured = f.begin();
        const path = field === "runtime" ? captured.runtimeReceipt.path : captured.observationReceipt.path;
        const limit = field === "runtime" ? 65536 : 16384;
        const json = readFileSync(path, "utf8");
        writeFileSync(path, json + " ".repeat(limit + 1));
        expect(() => f.store.read(f.receipt, f.binding)).toThrow();
        expect(existsSync(path)).toBe(true);
    });

    it.each(["runtime", "observation"] as const)("refuses a nonregular %s path without removing it", field => {
        const f = fixture();
        const captured = f.begin();
        const path = field === "runtime" ? captured.runtimeReceipt.path : captured.observationReceipt.path;
        rmSync(path);
        mkdirSync(path);
        expect(() => f.store.read(f.receipt, f.binding)).toThrow();
        expect(() => f.store.retire(captured)).toThrow();
        expect(statSync(path).isDirectory()).toBe(true);
        expect(existsSync(f.binding.lockFile)).toBe(true);
    });

    it.each(["runtime", "observation"] as const)("treats a partially missing %s record as incomplete rather than absent", field => {
        const f = fixture();
        const captured = f.begin();
        const path = field === "runtime" ? captured.runtimeReceipt.path : captured.observationReceipt.path;
        rmSync(path);
        expect(() => f.store.read(f.receipt, f.binding)).toThrow();
        expect(existsSync(f.binding.lockFile)).toBe(true);
    });

    it("retires only its qualified sidecars after the exact main receipt has been removed", () => {
        const f = fixture();
        const captured = f.begin();
        const sibling = join(root, "other-session.lock");
        writeFileSync(sibling, "sibling-evidence", { mode: 0o600 });
        removeCapturedNativeSessionOwnership(f.receipt);
        f.store.retire(captured);
        expect(existsSync(captured.runtimeReceipt.path)).toBe(false);
        expect(existsSync(captured.observationReceipt.path)).toBe(false);
        expect(readFileSync(sibling, "utf8")).toBe("sibling-evidence");
    });
});

describe("bounded observation decoding", () => {
    it("keeps opaque recovery diagnostics separate from authority", () => {
        const current = observation();
        expect(decodeSessionClaimObservation(current)).toEqual(current);
        const retained = { ...current, recovery: { status: "recovery-needed" as const, diagnostic: "stop-attempts-exhausted" } };
        expect(currentSessionClaimAuthority(decodeSessionClaimObservation(retained))).toEqual({ containerId: fullId, source: "ack" });
    });

    it.each(["future-version", "unknown-field", "invalid-digest", "short-container-id", "oversized-diagnostic", "invalid-pending-kind"])("rejects %s observations", reason => {
        const current = observation();
        let invalid: unknown;
        if (reason === "future-version") invalid = { ...current, version: 2 };
        if (reason === "unknown-field") invalid = { ...current, inferredCleanupSuccess: true };
        if (reason === "invalid-digest") invalid = { ...current, claim: { ...current.claim, digest: "not-a-digest" } };
        if (reason === "short-container-id") invalid = { ...current, lastAcknowledged: { ...current.lastAcknowledged!, containerId: "a".repeat(12) } };
        if (reason === "oversized-diagnostic") invalid = { ...current, recovery: { status: "recovery-needed", diagnostic: "x".repeat(16385) } };
        if (reason === "invalid-pending-kind") invalid = { ...current,
            pending: { generation, sequence: 2, kind: "inferred-start", containerId: fullId, cleanupEnabled: true } };
        expect(() => decodeSessionClaimObservation(invalid)).toThrow();
    });
});
