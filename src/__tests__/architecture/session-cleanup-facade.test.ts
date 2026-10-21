import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NATIVE_RUNTIME_SELECTOR_KEYS, type NativeRuntimeInvocation, type NativeRuntimeSelectors } from "../../ports/container-runtime-invocation.js";
import { createHash } from "node:crypto";
import { sessionLockOwner } from "../../domain/session-lock.js";
import type { SessionClaimObservationSnapshot, SessionClaimObservationStore } from "../../ports/session-claim-observation.js";
import type { SessionOwnershipHandle, SessionOwnershipReceipt } from "../../ports/session-ownership.js";
import { cleanupNativeSessionDevices } from "../../adapters/session-cleanup.js";

const effects = vi.hoisted(() => ({
    mkdir: vi.fn(), stat: vi.fn(), chmod: vi.fn(), list: vi.fn(), read: vi.fn(), write: vi.fn(),
    exists: vi.fn(), unlink: vi.fn(), identity: vi.fn(), lock: vi.fn(),
    runtime: vi.fn(), invocation: vi.fn(), devices: vi.fn(), spawn: vi.fn(), fork: vi.fn(), spawnAsync: vi.fn(),
    token: vi.fn(), observe: vi.fn(), classify: vi.fn(),
    arm: vi.fn(), authorize: vi.fn(), validate: vi.fn(), capture: vi.fn(), matches: vi.fn(), rollback: vi.fn(),
}));
vi.mock("fs", async original => ({ ...await original<typeof import("node:fs")>(),
    mkdirSync: effects.mkdir, lstatSync: effects.stat, chmodSync: effects.chmod,
    readdirSync: (...args: unknown[]) => [...new Set([...(effects.list(...args) as string[]),
        ...[...records.keys()].filter(path => path.startsWith(`${fixtureLocks}/`)).map(path => basename(path))])]
        .filter(name => !retiredPaths.has(join(fixtureLocks, name))),
    readFileSync: effects.read,
    writeFileSync: (path: string, content: string, ...args: unknown[]) => {
        const result = effects.write(path, content, ...args);
        persistClaim(path, content);
        return result;
    },
    existsSync: effects.exists, unlinkSync: effects.unlink,
}));
vi.mock("child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawnSync: effects.spawn, fork: effects.fork, spawn: effects.spawnAsync }));
vi.mock("../../home-layout.js", () => ({ locksDir: () => join("/", "fixture", "locks") }));
vi.mock("../../utils.js", () => ({ getProjectId: effects.identity }));
vi.mock("../../container-runtime.js", async original => ({
    ...await original<typeof import("../../container-runtime.js")>(),
    runtimeCli: effects.runtime, getRuntimeInvocation: effects.invocation,
}));
vi.mock("../../device-lab-cleanup.js", () => ({ cleanupOwnerDevices: effects.devices }));
vi.mock("../../session-lock-liveness.js", async original => ({
    ...await original<typeof import("../../session-lock-liveness.js")>(),
    processStartToken: effects.token, observeProcessStarts: effects.observe, sessionLockLiveness: effects.classify,
}));
vi.mock("@ccc/device-lab/device-lab-shared-state.js", () => ({
    withSharedMutationLock: effects.lock, withSharedMutationLockAsync: effects.lock,
}));
vi.mock("../../composition/session-ownership.js", () => ({
    armNativeSessionOwnership: (binding: Parameters<typeof import("../../composition/session-ownership.js")["armNativeSessionOwnership"]>[0], failure: unknown, options: unknown) =>
        armFixture(binding, failure, options),
    assertNativeSessionOwnership: effects.authorize,
    validateNativeSessionOwnership: effects.validate,
}));
vi.mock("../../adapters/session-ownership.js", () => ({
    captureNativeSessionOwnership: effects.capture,
    captureNativeSessionFile: effects.capture,
    nativeSessionOwnershipMatches: effects.matches,
    removeCapturedNativeSessionOwnership: effects.rollback,
}));

vi.mock("../../adapters/session-claim-observation.js", () => ({
    createNativeSessionClaimObservationStore: () => ({
        read: (...args: Parameters<SessionClaimObservationStore["read"]>) => observations.read(...args),
        matches: (...args: Parameters<SessionClaimObservationStore["matches"]>) => observations.matches(...args),
        assertCurrent: (...args: Parameters<SessionClaimObservationStore["assertCurrent"]>) => observations.assertCurrent(...args),
        begin: (...args: Parameters<SessionClaimObservationStore["begin"]>) => observations.begin(...args),
        update: (...args: Parameters<SessionClaimObservationStore["update"]>) => observations.update(...args),
        retire: (...args: Parameters<SessionClaimObservationStore["retire"]>) => observations.retire(...args),
    }),
}));
let session = await import("../../session.js");
const fixtureLocks = join("/", "fixture", "locks");
let own = join(fixtureLocks, "project--current.lock");
const project = join("/", "fixture", "project");
const invocation: NativeRuntimeInvocation = {
    version: 1, runtime: "docker", executable: join("/", "fixture", "docker-a"),
    transport: { kind: "docker", host: "unix:///fixture/engine-a.sock", configDirectory: join("/", "fixture", "config-a"),
        tls: { enabled: false, verify: false, caFile: null, certFile: null, keyFile: null } },
    selectors: Object.fromEntries(NATIVE_RUNTIME_SELECTOR_KEYS.map(key => [key, null])) as NativeRuntimeSelectors,
};
const stopArgs = (id: unknown) => ["--config", join("/", "fixture", "config-a"), "--host", "unix:///fixture/engine-a.sock",
    "--tls=false", "--tlscacert=", "--tlscert=", "--tlskey=", "stop", id];
const podmanInvocation: NativeRuntimeInvocation = {
    ...invocation, runtime: "podman", executable: join("/", "fixture", "podman-a"),
    transport: { kind: "podman-local", graphRoot: join("/", "fixture", "graph-a"), runRoot: join("/", "fixture", "run-a"),
        storageDriver: "overlay", storageOptions: [], transientStore: false },
};
const podmanStopArgs = (id: string) => ["--remote=false", "--root", join("/", "fixture", "graph-a"),
    "--runroot", join("/", "fixture", "run-a"), "--storage-driver", "overlay", "--transient-store=false", "stop", id];
const stopOptions = { stdio: "ignore", timeout: 30_000, killSignal: "SIGKILL", shell: false, env: expect.any(Object) };
const emptyContext = { lockFile: null, projectPath: null, profile: undefined, toolName: null };
let previousExitCode: typeof process.exitCode;

// Only native persistence and guardian transport are faked here. The facade,
// acquisition, claim recovery and cleanup applications remain the actual owners.
// Native bounded-file and IPC behavior is covered by their integration owners.
type RecordFixture = { receipt: SessionOwnershipReceipt; snapshot: SessionClaimObservationSnapshot | null; revision: number };
const records = new Map<string, RecordFixture>();
const retiredPaths = new Set<string>();
const armed = new Set<string>();
let identitySequence = 1;
const exactId = (label: string) => createHash("sha256").update(label).digest("hex");
const capturedId = exactId("captured-id");
const privateDeviceMarkers = ["PRIVATE_OWNER", "PRIVATE_DEVICE", "PRIVATE_PREVIOUS_STATUS", "PRIVATE_REASON", "PRIVATE_COMMAND", "PRIVATE_STDOUT", "PRIVATE_STDERR"];
const mixedDeviceReport = {
    ownerId: privateDeviceMarkers[0],
    results: (["stopped", "skipped", "failed", "failed"] as const).map((status, index) => ({
        id: `${privateDeviceMarkers[1]}_${index}`, backend: "android-emulator", previousStatus: privateDeviceMarkers[2], status,
        reason: privateDeviceMarkers[3],
        commands: [{ command: privateDeviceMarkers[4], status: 9, stdout: privateDeviceMarkers[5], stderr: privateDeviceMarkers[6] }],
    })),
};
function persistClaim(path: string, content: string): void {
    const owner = sessionLockOwner(content);
    if (!owner) throw new Error("invalid claim write");
    retiredPaths.delete(path);
    records.set(path, { receipt: { path, bytes: Buffer.from(content).toString("base64"), device: "1", inode: String(++identitySequence), birthtime: "3", ownerPid: owner.pid }, snapshot: null, revision: 0 });
}
function receiptFor(path: string): SessionOwnershipReceipt {
    const existing = records.get(path);
    if (existing) return existing.receipt;
    const receipt = { path, bytes: Buffer.from(JSON.stringify({ version: 3, pid: process.pid,
        startToken: null, ownershipKind: "monitored" })).toString("base64"), device: "1",
        inode: String(++identitySequence), birthtime: "3", ownerPid: process.pid };
    records.set(path, { receipt, snapshot: null, revision: 0 });
    return receipt;
}
function sameReceipt(left: SessionOwnershipReceipt, right: SessionOwnershipReceipt): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}
function snapshotFor(path: string, binding: { projectPath: string; profile?: string; toolName?: string }, runtime = invocation): SessionClaimObservationSnapshot {
    const record = records.get(path)!;
    const fileIdentity = { path, device: record.receipt.device, inode: record.receipt.inode,
        birthtime: record.receipt.birthtime, digest: createHash("sha256").update(Buffer.from(record.receipt.bytes, "base64")).digest("hex") };
    const runtimeReceipt = { ...record.receipt, path: `${path}.runtime.json`, bytes: Buffer.from(JSON.stringify(runtime)).toString("base64") };
    const observation = { version: 1 as const, claim: { ...fileIdentity, ownerPid: record.receipt.ownerPid },
        binding: { lockFile: path, ...binding, prefix: binding.profile ? `project--p--${binding.profile}` : "project" },
        runtime: { ...fileIdentity, path: runtimeReceipt.path, digest: createHash("sha256").update(Buffer.from(runtimeReceipt.bytes, "base64")).digest("hex") }, guardian: { pid: 321, startToken: null },
        generation: "0", registration: "ready" as const, pending: null, lastAcknowledged: null, ownStarted: null,
        recovery: { status: "active" as const, diagnostic: null } };
    const snapshot: SessionClaimObservationSnapshot = { receipt: record.receipt, runtimeReceipt,
        observationReceipt: { ...record.receipt, path: `${path}.guardian.json`, bytes: String(++record.revision) },
        observation, runtimeInvocation: runtime };
    record.snapshot = snapshot;
    return snapshot;
}
function replaceObservation(path: string, value: SessionClaimObservationSnapshot["observation"]): void {
    const record = records.get(path)!;
    record.snapshot = { ...record.snapshot!, observation: value,
        observationReceipt: { ...record.snapshot!.observationReceipt, bytes: String(++record.revision) } };
}
const observations: SessionClaimObservationStore = {
    read(receipt, binding) {
        if (!effects.matches(receipt)) throw new Error("receipt replaced");
        const snapshot = records.get(receipt.path)?.snapshot ?? null;
        if (snapshot && (snapshot.observation.binding.prefix !== binding.prefix
            || ("lockFile" in binding && (binding.lockFile !== receipt.path
                || binding.projectPath !== snapshot.observation.binding.projectPath
                || binding.profile !== snapshot.observation.binding.profile
                || binding.toolName !== snapshot.observation.binding.toolName)))) throw new Error("binding changed");
        return snapshot;
    },
    matches(snapshot) { return effects.matches(snapshot.receipt) && records.get(snapshot.receipt.path)?.snapshot === snapshot; },
    assertCurrent(snapshot) { if (!this.matches(snapshot)) throw new Error("observation replaced"); },
    begin(options) { return snapshotFor(options.receipt.path, options.binding, options.runtimeInvocation); },
    update(snapshot, value) { this.assertCurrent(snapshot); replaceObservation(snapshot.receipt.path, value); return records.get(snapshot.receipt.path)!.snapshot!; },
    retire() { /* Sidecar syscalls are native-adapter scope; main retirement is asserted below. */ },
};
function stage(path: string, id: string | null, enabled: boolean) {
    const previous = records.get(path)?.snapshot;
    if (!previous) throw new Error("observation absent");
    const generation = String(Number(previous.observation.generation) + 1);
    replaceObservation(path, { ...previous.observation, generation,
        pending: { kind: "update", generation, sequence: Number(generation), containerId: id, cleanupEnabled: enabled },
        ownStarted: enabled && previous.observation.ownStarted?.containerId === id ? previous.observation.ownStarted : null });
    return generation;
}
function acknowledge(path: string, generation: string, id: string | null, enabled: boolean): boolean {
    const current = records.get(path)?.snapshot;
    if (!current || current.observation.generation !== generation) return false;
    replaceObservation(path, { ...current.observation, pending: null,
        lastAcknowledged: { generation, sequence: Number(generation), containerId: id, cleanupEnabled: enabled } });
    return true;
}
async function armFixture(binding: { lockFile: string; projectPath: string; profile?: string; toolName?: string }, failure: unknown, options: unknown): Promise<SessionOwnershipHandle> {
    const configured = options as { runtimeInvocation: NativeRuntimeInvocation };
    if (!records.get(binding.lockFile)?.snapshot) snapshotFor(binding.lockFile, binding, configured.runtimeInvocation);
    const handle = await effects.arm(binding, failure, options) as SessionOwnershipHandle;
    armed.add(binding.lockFile);
    let closed = false;
    const prepare = (id: string | null, enabled = true) => {
        if (closed) throw new Error("guardian closed");
        const generation = stage(binding.lockFile, id, enabled);
        return async () => {
            if (closed) throw new Error("guardian closed");
            const accepted = await handle.updateContainer(id, enabled);
            return accepted && acknowledge(binding.lockFile, generation, id, enabled);
        };
    };
    return { pid: handle.pid, assertOwnership: handle.assertOwnership,
        updateContainer: (id, enabled = true) => prepare(id, enabled)(),
        updateContainerInHeldLifecycleLock: (id, enabled = true) => prepare(id, enabled)(),
        prepareContainerUpdateInHeldLifecycleLock: prepare,
        beginStartupInHeldLifecycleLock() {
            const generation = stage(binding.lockFile, null, false);
            const snapshot = records.get(binding.lockFile)!.snapshot!;
            replaceObservation(binding.lockFile, { ...snapshot.observation,
                pending: { kind: "startup", generation, sequence: Number(generation), containerId: null, cleanupEnabled: false } });
        },
        recordOwnStartInHeldLifecycleLock(id) {
            const generation = stage(binding.lockFile, id, true);
            const snapshot = records.get(binding.lockFile)!.snapshot!;
            replaceObservation(binding.lockFile, { ...snapshot.observation,
                ownStarted: { generation, containerId: id } });
        },
        async release() { closed = true; armed.delete(binding.lockFile); await handle.release(); },
    };
}
function resetNativeFixtures(): void {
    records.clear(); retiredPaths.clear(); armed.clear(); own = join(fixtureLocks, "project--current.lock");
    effects.stat.mockReturnValue({ isDirectory: () => true, isSymbolicLink: () => false });
    effects.identity.mockReturnValue("project"); effects.list.mockReturnValue([]);
    effects.exists.mockReturnValue(true); effects.runtime.mockReturnValue("docker"); effects.invocation.mockReturnValue(invocation);
    effects.lock.mockImplementation((_path, operation) => operation()); effects.spawn.mockReturnValue({ status: 0 });
    effects.devices.mockReturnValue({ ownerId: "fixture-owner", results: [] });
    effects.token.mockReturnValue(null); effects.observe.mockReturnValue(new Map()); effects.classify.mockReturnValue("active");
    effects.capture.mockImplementation(path => {
        if (retiredPaths.has(path)) throw new Error("retired fixture claim");
        const existing = records.get(path);
        if (existing) return existing.receipt;
        const content = effects.read(path, "utf-8");
        const owner = typeof content === "string" ? sessionLockOwner(content) : null;
        if (!owner) throw new Error("invalid native claim fixture");
        const receipt = { path, bytes: Buffer.from(content).toString("base64"), device: "1", inode: String(++identitySequence), birthtime: "3", ownerPid: owner.pid };
        records.set(path, { receipt, snapshot: null, revision: 0 });
        return receipt;
    });
    effects.matches.mockImplementation(receipt => !!records.get(receipt.path) && sameReceipt(records.get(receipt.path)!.receipt, receipt));
    effects.authorize.mockImplementation(receipt => { if (receipt && !effects.matches(receipt)) throw new Error("receipt replaced"); });
    effects.rollback.mockImplementation(receipt => { if (!effects.matches(receipt)) throw new Error("receipt replaced"); effects.unlink(receipt.path); records.delete(receipt.path); retiredPaths.add(receipt.path); });
}
function setQualifiedSession(lockFile: string, projectPath: string, profile?: string, toolName?: string): void {
    if (profile && lockFile === own) own = lockFile = join(fixtureLocks, `project--p--${profile}--current.lock`);
    retiredPaths.delete(lockFile);
    receiptFor(lockFile);
    session.setSession(lockFile, projectPath, profile, toolName);
    snapshotFor(lockFile, { projectPath, profile, toolName: toolName ?? "claude" }, effects.invocation.mock.results.at(-1)!.value);
}
function setContainer(id: string | null): void {
    session.setSessionContainerId(id);
    const path = session.getCurrentSession().lockFile;
    if (path && !armed.has(path) && records.get(path)?.snapshot) {
        const generation = stage(path, id, id !== null);
        acknowledge(path, generation, id, id !== null);
    }
}
function start(profile?: string): void {
    own = join(fixtureLocks, profile ? `project--p--${profile}--current.lock` : "project--current.lock");
    setQualifiedSession(own, project, profile);
    setContainer(capturedId);
}

describe("native session cleanup through the public facade", () => {
    beforeEach(() => {
        previousExitCode = process.exitCode;
        vi.resetAllMocks();
        session.clearSession();
        resetNativeFixtures();
    });
    afterEach(() => { session.clearSession(); process.exitCode = previousExitCode; vi.restoreAllMocks(); });

    it("constructs the facade and its composition without invoking native effects", async () => {
        const once = vi.spyOn(process, "once").mockImplementation(() => process);
        vi.resetModules();
        session = await import("../../session.js");
        expect(session.getCurrentSession()).toEqual(emptyContext);
        for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
        expect(once).not.toHaveBeenCalled();
    });

    it("refuses held-guard retirement without an original receipt or native effects", () => {
        expect(() => session.removeSessionLockInHeldLifecycleLock(own)).toThrow("original direct-claim receipt");
        expect(effects.unlink).not.toHaveBeenCalled();
        expect(effects.lock).not.toHaveBeenCalled();
    });

    it("keeps legacy facade usage synchronous and launches no guardian without explicit arming", async () => {
        start();
        await expect(session.confirmSessionOwnership()).resolves.toBeUndefined();
        session.cleanupSession();
        session.clearSession();
        expect(effects.fork).not.toHaveBeenCalled();
        expect(effects.spawnAsync).not.toHaveBeenCalled();
        expect(effects.spawn).toHaveBeenCalledExactlyOnceWith(invocation.executable, stopArgs(capturedId), stopOptions);
    });

    it("regression: automatic session cleanup reports failed device rows", () => {
        const warning = vi.spyOn(console, "error").mockImplementation(() => {});
        effects.devices.mockReturnValue(mixedDeviceReport);
        start();
        const capturedReceipt = records.get(own)!.receipt;
        const unrelatedPath = join(fixtureLocks, "unrelated--retained.lock");
        const unrelatedReceipt = receiptFor(unrelatedPath);
        effects.invocation.mockClear();
        effects.invocation.mockImplementation(() => { throw new Error("ambient runtime changed"); });

        expect(session.cleanupSession()).toBeUndefined();

        expect(warning).toHaveBeenCalledExactlyOnceWith("[ccc] device cleanup failed during session cleanup: one or more devices failed to clean up");
        for (const marker of privateDeviceMarkers) expect(JSON.stringify(warning.mock.calls)).not.toContain(marker);
        expect(effects.devices).toHaveBeenCalledExactlyOnceWith(project, 5000, undefined);
        expect(effects.spawn).toHaveBeenCalledExactlyOnceWith(invocation.executable, stopArgs(capturedId), stopOptions);
        expect(effects.rollback).toHaveBeenCalledExactlyOnceWith(capturedReceipt);
        expect(effects.unlink).toHaveBeenCalledExactlyOnceWith(own);
        expect(warning.mock.invocationCallOrder[0]).toBeLessThan(effects.spawn.mock.invocationCallOrder[0]);
        expect(effects.spawn.mock.invocationCallOrder[0]).toBeLessThan(effects.unlink.mock.invocationCallOrder[0]);
        expect(records.has(own)).toBe(false);
        expect(records.get(unrelatedPath)!.receipt).toBe(unrelatedReceipt);
        expect(effects.invocation).not.toHaveBeenCalled();
        expect(session.getCurrentSession().lockFile).toBeNull();

        expect(session.cleanupSession()).toBeUndefined();
        expect(warning).toHaveBeenCalledTimes(1);
        expect(effects.devices).toHaveBeenCalledTimes(1);
        expect(effects.spawn).toHaveBeenCalledTimes(1);
        expect(effects.rollback).toHaveBeenCalledTimes(1);
        expect(effects.unlink).toHaveBeenCalledTimes(1);
        expect(records.get(unrelatedPath)!.receipt).toBe(unrelatedReceipt);
    });

    it.each([
        { report: mixedDeviceReport, counts: { stopped: 1, skipped: 1, failed: 2 } },
        { report: { ownerId: "PRIVATE_OWNER", results: [] }, counts: { stopped: 0, skipped: 0, failed: 0 } },
        { report: { ...mixedDeviceReport, results: mixedDeviceReport.results.filter(row => row.status !== "failed") }, counts: { stopped: 1, skipped: 1, failed: 0 } },
    ])("native device cleanup projects only finite canonical counts: $counts", ({ report, counts }) => {
        effects.devices.mockReturnValue(report);
        const projection = cleanupNativeSessionDevices(project, 5000, "work");
        expect(projection).toEqual(counts);
        expect(Object.keys(projection).sort()).toEqual(["failed", "skipped", "stopped"]);
        expect(Object.values(projection).every(value => Number.isFinite(value) && Number.isInteger(value) && value >= 0)).toBe(true);
        for (const marker of privateDeviceMarkers) expect(JSON.stringify(projection)).not.toContain(marker);
        expect(effects.devices).toHaveBeenCalledExactlyOnceWith(project, 5000, "work");
    });

    it.each(["mismatched target", "absent grant", "acknowledged false", "pending update", "pending startup"] as const)(
        "rejects unarmed cleanup before effects with %s durable authority", mode => {
            start();
            const original = records.get(own)!.snapshot!;
            expect(observations.matches(original)).toBe(true);
            expect(original.observation.lastAcknowledged).toMatchObject({
                containerId: capturedId, cleanupEnabled: true, generation: original.observation.generation,
            });
            if (mode === "absent grant") {
                replaceObservation(own, { ...original.observation, lastAcknowledged: null });
            } else if (mode === "acknowledged false") {
                replaceObservation(own, { ...original.observation,
                    lastAcknowledged: { ...original.observation.lastAcknowledged!, cleanupEnabled: false } });
            } else if (mode === "pending update" || mode === "pending startup") {
                const generation = "unacknowledged-generation";
                replaceObservation(own, { ...original.observation, generation,
                    pending: { kind: mode === "pending update" ? "update" : "startup", generation,
                        sequence: 2, containerId: capturedId, cleanupEnabled: true }, ownStarted: null });
            }
            const qualified = records.get(own)!.snapshot!;
            expect(observations.matches(qualified)).toBe(true);
            expect(qualified.observation.ownStarted).toBeNull();
            const localTarget = mode === "mismatched target"
                ? exactId("unarmed-local-retarget-without-durable-grant") : capturedId;

            // The real public setter cannot manufacture a guardian ACK for an
            // unarmed context. Only local memory changes; durable proof stays put.
            session.setSessionContainerId(localTarget);
            expect(records.get(own)!.snapshot).toBe(qualified);
            expect(() => session.cleanupSession()).toThrow("responsibility-incomplete");

            expect(effects.devices).not.toHaveBeenCalled();
            expect(effects.spawn).not.toHaveBeenCalled();
            expect(effects.unlink).not.toHaveBeenCalled();
            expect(records.get(own)!.receipt).toEqual(original.receipt);
            expect(records.get(own)!.snapshot).toBe(qualified);
            expect(session.getCurrentSession().lockFile).toBe(own);
        },
    );

    it("retires a qualified cleanup-disabled claim without performing shared cleanup or a container stop", () => {
        start();
        const original = records.get(own)!.snapshot!;
        replaceObservation(own, { ...original.observation,
            lastAcknowledged: { ...original.observation.lastAcknowledged!, cleanupEnabled: false } });
        session.setSessionContainerId(capturedId);
        session.setSessionCleanupEnabled(false);

        expect(() => session.cleanupSession()).not.toThrow();
        expect(effects.devices).not.toHaveBeenCalled();
        expect(effects.spawn).not.toHaveBeenCalled();
        expect(effects.unlink).toHaveBeenCalledExactlyOnceWith(own);
        expect(records.has(own)).toBe(false);
        expect(session.getCurrentSession().lockFile).toBeNull();
    });

    it.each([
        [undefined, undefined, "claude"], ["", "", ""], ["work", "codex", "codex"],
    ])("shares one context and returns fresh snapshots for profile %s and tool %s", async (profile, tool, expectedTool) => {
        setQualifiedSession(own, project, profile, tool);
        setContainer(exactId("hidden-id"));
        const again = await import("../../session.js");
        const snapshot = again.getCurrentSession();
        expect(snapshot).toEqual({ lockFile: own, projectPath: project, profile, toolName: expectedTool });
        expect(snapshot).not.toBe(session.getCurrentSession());
        snapshot.lockFile = "changed-by-consumer";
        expect(session.getCurrentSession().lockFile).toBe(own);
        session.clearSession();
        expect(again.getCurrentSession()).toEqual(emptyContext);
        expect(effects.spawn).not.toHaveBeenCalled();
    });

    it("keeps cleaned-up state through setSession and resets it through clearSession", () => {
        start(); session.cleanupSession();
        expect(session.getCurrentSession()).toEqual({ ...emptyContext, toolName: "claude" });
        setQualifiedSession(own, project, "work", "codex");
        setContainer(exactId("next-id"));
        session.cleanupSession();
        expect(effects.devices).toHaveBeenCalledTimes(1);
        expect(session.getCurrentSession().lockFile).toBe(own);
        session.clearSession(); start(); session.cleanupSession();
        expect(effects.devices).toHaveBeenCalledTimes(2);
    });

    it("a fresh session does not inherit the prior target or shared-cleanup authority", () => {
        start();
        const previousClaim = records.get(own)!.snapshot!;
        session.clearSession();
        const nextLock = join(fixtureLocks, "project--fresh-no-target.lock");
        setQualifiedSession(nextLock, project);
        const nextClaim = records.get(nextLock)!.snapshot!;
        expect(observations.matches(nextClaim)).toBe(true);
        expect(nextClaim.observation.lastAcknowledged).toBeNull();
        expect(() => session.cleanupSession()).not.toThrow();

        expect(effects.devices).not.toHaveBeenCalled();
        expect(effects.runtime).not.toHaveBeenCalled();
        expect(effects.spawn).not.toHaveBeenCalled();
        expect(effects.unlink).toHaveBeenCalledExactlyOnceWith(nextLock);
        expect(records.has(nextLock)).toBe(false);
        expect(records.get(previousClaim.receipt.path)!.snapshot).toBe(previousClaim);
        expect(session.getCurrentSession().lockFile).toBeNull();
    });

    it.each(["absent", "unlink error", "present"])("requires original direct authority and preserves incomplete cleanup on unlink failure: %s", mode => {
        expect(() => session.removeSessionLock(own)).toThrow("original direct-claim receipt");
        expect(effects.unlink).not.toHaveBeenCalled();
        const direct = session.createSessionLock("project");
        const failure = Object.assign(new Error("unlink denied"), { code: mode === "absent" ? "ENOENT" : "EACCES" });
        if (mode !== "present") effects.unlink.mockImplementation(() => { throw failure; });
        if (mode === "present") expect(() => session.removeSessionLock(direct)).not.toThrow();
        else expect(() => session.removeSessionLock(direct)).toThrow(failure);
        // Stop failures and unlink failures remain distinct, retryable outcomes.
        if (mode !== "present") {
            effects.unlink.mockReset();
            session.removeSessionLock(direct);
            effects.unlink.mockImplementation(() => { throw failure; });
        }
        start();
        if (mode === "present") expect(() => session.cleanupSession()).not.toThrow();
        else expect(() => session.cleanupSession()).toThrow(failure);
        expect(effects.devices).toHaveBeenCalledExactlyOnceWith(project, 5000, undefined);
        expect(effects.spawn).toHaveBeenCalledExactlyOnceWith(invocation.executable, stopArgs(capturedId), stopOptions);
        expect(session.getCurrentSession().lockFile).toBe(mode === "present" ? null : own);
    });

    it.each([undefined, "", "work"])("holds raw query, removal, devices and exact-ID stop in the lifecycle lock for profile %s", profile => {
        const order: string[] = [];
        effects.identity.mockImplementation(path => { expect(path).toBe(project); order.push("identity"); return "project"; });
        effects.lock.mockImplementation((_path, operation) => { order.push("enter"); const result = operation(); order.push("return"); return result; });
        effects.list.mockImplementation(() => { order.push("claims"); return []; });
        effects.unlink.mockImplementation(() => { order.push("remove"); });
        effects.devices.mockImplementation(() => { order.push("devices"); return { ownerId: "fixture", results: [] }; });
        effects.invocation.mockImplementation(() => invocation);
        effects.spawn.mockImplementation(() => { order.push("stop"); return { status: 0 }; });
        start(profile); session.cleanupSession();
        expect(order.indexOf("enter")).toBeLessThan(order.indexOf("claims"));
        expect(order.indexOf("claims")).toBeLessThan(order.indexOf("devices"));
        expect(order.indexOf("devices")).toBeLessThan(order.indexOf("stop"));
        expect(order.indexOf("stop")).toBeLessThan(order.indexOf("remove"));
        expect(order.indexOf("remove")).toBeLessThan(order.indexOf("return"));
        const prefix = profile ? `project--p--${profile}` : "project";
        expect(effects.lock).toHaveBeenCalledExactlyOnceWith(join(fixtureLocks, `${prefix}.container-lifecycle.guard`), expect.any(Function), { waitMs: 180000 });
        expect(effects.devices).toHaveBeenCalledExactlyOnceWith(project, 5000, profile);
        expect(effects.spawn).toHaveBeenCalledExactlyOnceWith(invocation.executable, stopArgs(capturedId), stopOptions);
    });

    it.each(["malformed", "unreadable", "unknown"])("preserves foreign %s claims through reconciliation and fresh raw veto", record => {
        effects.list.mockReturnValue(["project--current.lock", "project--foreign.lock"]);
        if (record === "unreadable") effects.read.mockImplementation(() => { throw new Error("unreadable"); });
        else effects.read.mockReturnValue(record === "malformed" ? "broken" : "123");
        effects.classify.mockReturnValue("unknown");
        const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw new Error("no PID probe"); });
        start(); expect(() => session.cleanupSession()).toThrow("responsibility-incomplete");
        expect(effects.unlink).not.toHaveBeenCalled();
        expect(effects.read).toHaveBeenCalledWith(join(fixtureLocks, "project--foreign.lock"), "utf-8");
        for (const effect of [effects.devices, effects.runtime, effects.spawn, kill]) expect(effect).not.toHaveBeenCalled();
        expect(session.getCurrentSession().lockFile).toBe(own);
    });

    it("reconciles proven stale foreign ownership then stops the exact captured ID after a fresh empty veto", () => {
        const foreign = join(fixtureLocks, "project--foreign.lock");
        const names = ["project--current.lock", "project--foreign.lock"];
        effects.list.mockImplementation(() => [...names]);
        effects.read.mockReturnValue(JSON.stringify({ version: 3, pid: 123, startToken: null, ownershipKind: "direct" }));
        effects.classify.mockImplementation(content => sessionLockOwner(content)?.pid === process.pid ? "active" : "stale");
        effects.unlink.mockImplementation(path => { names.splice(names.indexOf(basename(path)), 1); });
        start();
        const admission = session.createSessionLock("project");
        session.removeSessionLock(admission);
        session.cleanupSession();
        expect(effects.unlink.mock.calls).toEqual([[foreign], [admission], [own]]);
        expect(effects.spawn).toHaveBeenCalledExactlyOnceWith(invocation.executable, stopArgs(capturedId), stopOptions);

        expect(effects.spawn.mock.invocationCallOrder[0]).toBeLessThan(effects.unlink.mock.invocationCallOrder[2]!);
    });

    it("keeps failed stale foreign unlink as a fresh raw veto", () => {
        const foreign = join(fixtureLocks, "project--foreign.lock");
        effects.list.mockReturnValue(["project--current.lock", "project--foreign.lock"]);
        effects.read.mockReturnValue(JSON.stringify({ version: 3, pid: 123, startToken: null, ownershipKind: "direct" })); effects.classify.mockImplementation(content => sessionLockOwner(content)?.pid === process.pid ? "active" : "stale");
        effects.unlink.mockImplementation(path => { if (path === foreign) throw new Error("denied"); });
        start();
        expect(() => session.createSessionLock("project")).toThrow("responsibility-incomplete");
        expect(() => session.cleanupSession()).toThrow("responsibility-incomplete");
        expect(effects.unlink.mock.calls).toEqual([[foreign]]);
        expect(session.getCurrentSession().lockFile).toBe(own);
        expect(effects.devices).not.toHaveBeenCalled(); expect(effects.spawn).not.toHaveBeenCalled();
    });

    it.each([["Z", true], ["X", true], ["Z", false], ["X", false]] as const)("native %s foreign ownership (versioned=%s) reconciliation permits only the captured exact-ID stop", async (state, versioned) => {
        const native = await vi.importActual<typeof import("../../session-lock-liveness.js")>("../../session-lock-liveness.js");
        const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
        Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
        const foreign = join(fixtureLocks, "project--foreign.lock");
        const names = [basename(own), basename(foreign)];
        effects.list.mockImplementation(() => [...names]);
        effects.observe.mockReturnValue(new Map());
        effects.classify.mockImplementation(native.sessionLockLiveness);
        effects.read.mockImplementation(path => path === "/proc/4242/stat"
            ? `4242 (exited owner) ${[state, ...Array(18).fill("0"), "987"].join(" ")}`
            : versioned ? JSON.stringify({ version: 3, ownershipKind: "direct", pid: 4242, startToken: "linux:987" }) : "4242");
        effects.unlink.mockImplementation(path => { names.splice(names.indexOf(basename(path)), 1); });
        try {
            start();
            if (versioned) {
                const admission = session.createSessionLock("project");
                session.removeSessionLock(admission);
                session.cleanupSession();
                expect(effects.unlink.mock.calls).toEqual([[foreign], [admission], [own]]);
                expect(effects.spawn).toHaveBeenCalledExactlyOnceWith(invocation.executable, stopArgs(capturedId), stopOptions);
            } else {
                expect(() => session.createSessionLock("project")).toThrow("responsibility-incomplete");
                expect(() => session.cleanupSession()).toThrow("responsibility-incomplete");
                expect(effects.unlink).not.toHaveBeenCalled();
                expect(effects.spawn).not.toHaveBeenCalled();
            }
            expect(effects.read).toHaveBeenCalledWith("/proc/4242/stat", "utf-8");
        } finally { Object.defineProperty(process, "platform", platform); }
    });

    it.each([exactId("replacement-id"), null, ""])("cleanup retains its captured target when ambient lookup would mutate it to %s", nextId => {
        start();
        effects.invocation.mockClear();
        effects.invocation.mockImplementation(() => { setContainer(nextId); throw new Error("ambient lookup forbidden"); });
        effects.runtime.mockImplementation(() => { throw new Error("ambient runtime lookup forbidden"); });
        session.cleanupSession();
        expect(effects.invocation).not.toHaveBeenCalled();
        expect(effects.runtime).not.toHaveBeenCalled();
        expect(effects.spawn).toHaveBeenCalledExactlyOnceWith(invocation.executable, stopArgs(capturedId), stopOptions);
    });

    it.each([
        [capturedId, exactId("device-updated-id")], [capturedId, null],
    ] as const)("interrupts device target mutation from %j to %j and permits a fresh cleanup", (before, after) => {
        start();
        setContainer(before);
        effects.invocation.mockClear();
        effects.invocation.mockReturnValue(podmanInvocation);
        effects.devices.mockImplementationOnce(() => { setContainer(after); return { ownerId: "fixture", results: [] }; });
        expect(() => session.cleanupSession()).toThrow(/cleanup.*authorization.*changed/i);
        expect(session.getCurrentSession()).toEqual({ lockFile: own, projectPath: project, profile: undefined, toolName: "claude" });
        expect(effects.spawn).not.toHaveBeenCalled();
        expect(effects.unlink).not.toHaveBeenCalled();

        session.cleanupSession();
        if (after === null) expect(effects.spawn).not.toHaveBeenCalled();
        else expect(effects.spawn).toHaveBeenCalledExactlyOnceWith(invocation.executable, stopArgs(after), stopOptions);
        expect(effects.unlink).toHaveBeenCalledExactlyOnceWith(own);
        expect(effects.invocation).not.toHaveBeenCalled();
        expect(effects.runtime).not.toHaveBeenCalled();
        expect(session.getCurrentSession()).toEqual({ ...emptyContext, toolName: "claude" });
    });

    it("retires a qualified null target without invoking a device callback that would grant a late target", () => {
        start();
        setContainer(null);
        const qualified = records.get(own)!.snapshot!;
        expect(observations.matches(qualified)).toBe(true);
        expect(qualified.observation.lastAcknowledged).toMatchObject({ containerId: null, cleanupEnabled: false });
        expect(qualified.observation.pending).toBeNull();
        expect(qualified.observation.ownStarted).toBeNull();
        effects.devices.mockImplementationOnce(() => { setContainer(exactId("late-id")); return { ownerId: "fixture", results: [] }; });
        effects.invocation.mockClear();

        expect(() => session.cleanupSession()).not.toThrow();
        expect(effects.devices).not.toHaveBeenCalled();
        expect(effects.spawn).not.toHaveBeenCalled();
        expect(effects.invocation).not.toHaveBeenCalled();
        expect(effects.runtime).not.toHaveBeenCalled();
        expect(effects.unlink).toHaveBeenCalledExactlyOnceWith(own);
        expect(records.has(own)).toBe(false);
        expect(session.getCurrentSession().lockFile).toBeNull();
    });

    it.each(["identity", "guard admission", "peer lookup", "claim removal", "guard return"] as const)("preserves a replacement session made by native %s callbacks until explicit retry", phase => {
        const replacement = {
            lockFile: join(fixtureLocks, "project--p--replacement-profile--replacement.lock"), projectPath: join("/", "fixture", "replacement"),
            profile: "replacement-profile", toolName: "updated-tool",
        };
        const claims = new Set([own, replacement.lockFile]);
        const replaceSession = () => {
            session.clearSession();
            setQualifiedSession(replacement.lockFile, replacement.projectPath, replacement.profile, replacement.toolName);
            setContainer(exactId("replacement-id"));
        };
        effects.unlink.mockImplementation(path => { claims.delete(String(path)); });
        if (phase === "identity") effects.identity.mockImplementationOnce(() => { replaceSession(); return "project"; });
        if (phase === "guard admission" || phase === "guard return") {
            effects.lock.mockImplementationOnce((_path, operation) => {
                if (phase === "guard admission") replaceSession();
                const result = operation();
                if (phase === "guard return") {
                    session.clearSession();
                    replaceSession();
                }
                return result;
            });
        }
        if (phase === "peer lookup") effects.list.mockImplementationOnce(() => { replaceSession(); return []; });
        if (phase === "claim removal") effects.unlink.mockImplementationOnce(path => {
            claims.delete(String(path));
            replaceSession();
        });
        start();
        const effectsCompletedBeforeMutation = phase === "claim removal" || phase === "guard return";
        if (effectsCompletedBeforeMutation) expect(() => session.cleanupSession()).not.toThrow();
        else expect(() => session.cleanupSession()).toThrow(/cleanup.*authorization.*changed/i);
        expect(session.getCurrentSession()).toEqual(replacement);
        expect(claims.has(replacement.lockFile)).toBe(true);
        if (effectsCompletedBeforeMutation) {
            expect(effects.spawn).toHaveBeenCalledExactlyOnceWith(invocation.executable, stopArgs(capturedId), stopOptions);
            expect(effects.unlink).toHaveBeenCalledExactlyOnceWith(own);
        } else {
            expect(effects.spawn).not.toHaveBeenCalled();
            expect(effects.unlink).not.toHaveBeenCalled();
        }
        expect(claims.has(own)).toBe(!effectsCompletedBeforeMutation);
        for (const call of effects.devices.mock.calls) expect(call).toEqual([project, 5000, undefined]);

        effects.devices.mockClear();
        effects.spawn.mockClear();
        effects.unlink.mockClear();
        effects.invocation.mockClear();
        effects.invocation.mockReturnValue(podmanInvocation);
        session.cleanupSession();
        expect(effects.devices).toHaveBeenCalledExactlyOnceWith(replacement.projectPath, 5000, replacement.profile);
        expect(effects.spawn).toHaveBeenCalledExactlyOnceWith(invocation.executable, stopArgs(exactId("replacement-id")), stopOptions);
        expect(effects.unlink).toHaveBeenCalledExactlyOnceWith(replacement.lockFile);
        expect(claims.has(replacement.lockFile)).toBe(false);
        expect(effects.invocation).not.toHaveBeenCalled();
        expect(effects.runtime).not.toHaveBeenCalled();
        expect(session.getCurrentSession()).toEqual({ ...emptyContext, toolName: replacement.toolName });
    });

    it.each([new Error("device failure"), "non-Error failure"])("reports device failure exactly and interrupts reporter retargeting: %s", failure => {
        const report = vi.spyOn(console, "error").mockImplementationOnce(() => { setContainer(exactId("reported-id")); }).mockImplementation(() => {});
        effects.devices.mockImplementation(() => { throw failure; });
        start();
        effects.invocation.mockClear();
        effects.invocation.mockReturnValue(podmanInvocation);
        expect(() => session.cleanupSession()).toThrow(/cleanup.*authorization.*changed/i);
        expect(report).toHaveBeenCalledExactlyOnceWith(`[ccc] device cleanup failed during session cleanup: ${failure instanceof Error ? failure.message : String(failure)}`);
        expect(effects.spawn).not.toHaveBeenCalled();
        expect(effects.unlink).not.toHaveBeenCalled();
        expect(session.getCurrentSession()).toEqual({ lockFile: own, projectPath: project, profile: undefined, toolName: "claude" });

        session.cleanupSession();
        expect(effects.spawn).toHaveBeenCalledExactlyOnceWith(invocation.executable, stopArgs(exactId("reported-id")), stopOptions);
        expect(effects.unlink).toHaveBeenCalledExactlyOnceWith(own);
        expect(effects.invocation).not.toHaveBeenCalled();
        expect(effects.runtime).not.toHaveBeenCalled();
        expect(session.getCurrentSession()).toEqual({ ...emptyContext, toolName: "claude" });
    });

    it("propagates reporter failure without stop or finalization and retries", () => {
        const failure = new Error("report failed");
        const report = vi.spyOn(console, "error").mockImplementationOnce(() => { throw failure; }).mockImplementation(() => {});
        effects.devices.mockImplementation(() => { throw new Error("device failure"); });
        start(); expect(() => session.cleanupSession()).toThrow(failure);
        expect(session.getCurrentSession().lockFile).toBe(own); expect(effects.spawn).not.toHaveBeenCalled();
        session.cleanupSession();
        expect(report).toHaveBeenCalledTimes(2); expect(effects.devices).toHaveBeenCalledTimes(2);
        expect(effects.spawn).toHaveBeenCalledTimes(1); expect(session.getCurrentSession().lockFile).toBeNull();
    });

    it("retries native stop with the same captured authority without another runtime lookup", () => {
        const failure = new Error("native spawn failed");
        start();
        effects.invocation.mockClear();
        effects.invocation.mockImplementation(() => { throw new Error("ambient selection changed"); });
        effects.spawn.mockImplementationOnce(() => { throw failure; }).mockReturnValue({ status: 0 });
        expect(() => session.cleanupSession()).toThrow(failure);
        expect(session.getCurrentSession().lockFile).toBe(own);
        session.cleanupSession();
        expect(effects.devices).toHaveBeenCalledTimes(2);
        expect(effects.unlink).toHaveBeenCalledTimes(1);
        expect(effects.invocation).not.toHaveBeenCalled();
        expect(effects.runtime).not.toHaveBeenCalled();
        expect(effects.spawn.mock.calls).toEqual([
            [invocation.executable, stopArgs(capturedId), stopOptions],
            [invocation.executable, stopArgs(capturedId), stopOptions],
        ]);
        expect(session.getCurrentSession().lockFile).toBeNull();
    });

    it("finalizes only after a successful native stop", () => {
        effects.spawn.mockReturnValue({ status: 0 });
        start(); session.cleanupSession(); session.cleanupSession();
        expect(effects.spawn).toHaveBeenCalledTimes(1); expect(session.getCurrentSession().lockFile).toBeNull();
    });

    it.each([
        { status: 9 }, { status: null }, { status: undefined },
        { status: null, error: Object.assign(new Error("PRIVATE_RUNTIME_DETAIL"), { code: "ENOENT" }) },
        { status: null, error: Object.assign(new Error("PRIVATE_RUNTIME_DETAIL"), { code: "ETIMEDOUT" }) },
        { status: 0, error: new Error("PRIVATE_RUNTIME_DETAIL") },
        { status: null, signal: "SIGKILL" }, { status: 0, signal: "SIGTERM" },
    ])("keeps native stop failure retryable instead of recording cleanup success: %j", result => {
        effects.spawn.mockReturnValueOnce(result).mockReturnValue({ status: 0 });
        start();
        let message = "";
        try { session.cleanupSession(); } catch (error) { message = (error as Error).message; }
        expect(message).toContain("Container shutdown failed");
        expect(message).not.toContain("PRIVATE_RUNTIME_DETAIL");
        expect(message.length).toBeLessThan(250);
        expect(session.getCurrentSession().lockFile).toBe(own);
        expect(effects.unlink).not.toHaveBeenCalled();
        expect(effects.spawn).toHaveBeenCalledExactlyOnceWith(invocation.executable, stopArgs(capturedId), stopOptions);
        session.cleanupSession();
        expect(effects.spawn).toHaveBeenCalledTimes(2);
        expect(session.getCurrentSession().lockFile).toBeNull();
    });

    it("rechecks foreign ownership before retrying a failed stop", () => {
        effects.spawn.mockReturnValue({ status: 9 });
        start();
        expect(() => session.cleanupSession()).toThrow("Container shutdown failed");
        effects.list.mockReturnValue(["project--current.lock", "project--foreign.lock"]);
        expect(() => session.cleanupSession()).toThrow("responsibility-incomplete");
        expect(effects.spawn).toHaveBeenCalledTimes(1);
        expect(effects.devices).toHaveBeenCalledTimes(1);
        expect(effects.read).toHaveBeenCalled();
        expect(session.getCurrentSession().lockFile).toBe(own);
    });

    it("retains native authority while using changed device effects on later sessions", () => {
        start(); session.cleanupSession(); session.clearSession();
        const report = vi.spyOn(console, "error").mockImplementation(() => {});
        effects.runtime.mockReturnValue("later-runtime");
        effects.devices.mockImplementation(() => { throw "later-failure"; });
        start("work"); session.cleanupSession();
        expect(effects.devices).toHaveBeenLastCalledWith(project, 5000, "work");
        expect(report).toHaveBeenCalledExactlyOnceWith("[ccc] device cleanup failed during session cleanup: later-failure");
        expect(effects.spawn).toHaveBeenLastCalledWith(invocation.executable, stopArgs(capturedId), stopOptions);
    });

    it("repeated signal setup replaces only its owned registrations and preserves foreign listeners", () => {
        const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
        const before = signals.map(signal => process.listeners(signal));
        const foreign = vi.fn();
        for (const signal of signals) process.on(signal, foreign);
        const withForeign = signals.map(signal => process.listeners(signal));
        try {
            session.setupSignalHandlers();
            const first = signals.map((signal, index) => process.listeners(signal).filter(listener => !withForeign[index]!.includes(listener)));
            expect(first.map(listeners => listeners.length)).toEqual([1, 1, 1]);
            session.setupSignalHandlers();
            for (const [index, signal] of signals.entries()) {
                const current = process.listeners(signal);
                expect(current).toHaveLength(withForeign[index]!.length + 1);
                for (const listener of withForeign[index]!) expect(current).toContain(listener);
                expect(current).not.toContain(first[index]![0]);
            }
            session.clearSession();
            expect(signals.map(signal => process.listeners(signal))).toEqual(withForeign);
            expect(foreign).not.toHaveBeenCalled();
        } finally {
            for (const [index, signal] of signals.entries()) {
                for (const listener of process.listeners(signal)) {
                    if (!before[index]!.includes(listener)) process.removeListener(signal, listener);
                }
            }
        }
    });

    it.each(["SIGINT", "SIGTERM", "SIGHUP"])("runs cleanup before exit(0) for intercepted %s", signal => {
        const previousExitCode = process.exitCode;
        process.exitCode = undefined;
        const once = vi.spyOn(process, "once").mockImplementation(() => process);
        const order: string[] = [];
        const exit = vi.spyOn(process, "exit").mockImplementation((() => { order.push("exit"); }) as () => never);
        effects.devices.mockImplementation(() => { order.push("cleanup"); return { ownerId: "fixture", results: [] }; });
        start(); session.setupSignalHandlers();
        const callback = once.mock.calls.find(([registered]) => registered === signal)![1];
        callback();
        expect(order).toEqual(["cleanup", "exit"]);
        expect(exit).toHaveBeenCalledExactlyOnceWith(0);
        expect(effects.spawn).toHaveBeenCalledTimes(1); expect(session.getCurrentSession().lockFile).toBeNull();
        process.exitCode = previousExitCode;
    });

    it.each(["SIGINT", "SIGTERM", "SIGHUP"])("retains explicit failure exitCode after %s cleanup", signal => {
        const previousExitCode = process.exitCode;
        const once = vi.spyOn(process, "once").mockImplementation(() => process);
        const exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as () => never);
        try {
            process.exitCode = 1;
            start(); session.setupSignalHandlers();
            once.mock.calls.find(([registered]) => registered === signal)![1]();
            expect(exit).toHaveBeenCalledExactlyOnceWith(1);
            expect(session.getCurrentSession().lockFile).toBeNull();
        } finally { process.exitCode = previousExitCode; }
    });

    it.each(["SIGINT", "SIGTERM", "SIGHUP", "throwing diagnostic"])("controls intercepted %s cleanup throws and completes repeated signals once", signal => {
        const once = vi.spyOn(process, "once").mockImplementation(() => process);
        const exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as () => never);
        const failure = new Error("signal cleanup failed");
        const report = vi.spyOn(console, "error").mockImplementation(() => {});
        if (signal === "throwing diagnostic") report.mockImplementation(() => { throw new Error("diagnostic unavailable"); });
        process.exitCode = undefined;
        effects.spawn.mockImplementation(() => { throw failure; });
        start(); session.setupSignalHandlers();
        const callback = once.mock.calls.find(([registered]) => registered === (signal === "throwing diagnostic" ? "SIGTERM" : signal))![1];
        expect(() => callback()).not.toThrow();
        for (const registered of ["SIGINT", "SIGTERM", "SIGHUP"]) {
            expect(() => once.mock.calls.find(([name]) => name === registered)![1]()).not.toThrow();
        }
        expect(exit).toHaveBeenCalledExactlyOnceWith(1);
        expect(report.mock.calls.some(call => call.includes(failure))).toBe(true);
        expect(effects.runtime).not.toHaveBeenCalled();
        expect(effects.spawn).toHaveBeenCalledTimes(1);
        expect(session.getCurrentSession().lockFile).toBe(own);
    });
});

describe("host ownership acquisition through the facade", () => {
    const request = { projectId: "project", projectPath: project, toolName: "codex" };
    const update = vi.fn<SessionOwnershipHandle["updateContainer"]>();
    const release = vi.fn<SessionOwnershipHandle["release"]>();
    const handle: SessionOwnershipHandle = { pid: 321, updateContainer: update,
        updateContainerInHeldLifecycleLock: update, prepareContainerUpdateInHeldLifecycleLock: (id, enabled) => () => update(id, enabled),
        beginStartupInHeldLifecycleLock: () => undefined, recordOwnStartInHeldLifecycleLock: () => undefined,
        release, assertOwnership: () => effects.authorize() };

    beforeEach(() => {
        session.clearSession(); vi.resetAllMocks();
        resetNativeFixtures();
        update.mockResolvedValue(true); release.mockResolvedValue(undefined);
        effects.arm.mockResolvedValue(handle);
        vi.spyOn(process, "once").mockImplementation(() => process);
    });
    afterEach(async () => {
        effects.authorize.mockImplementation(() => undefined);
        effects.unlink.mockReset();
        effects.rollback.mockImplementation(receipt => {
            if (!effects.matches(receipt)) throw new Error("receipt replaced");
            effects.unlink(receipt.path); records.delete(receipt.path); retiredPaths.add(receipt.path);
        });
        effects.matches.mockImplementation(receipt => !!records.get(receipt.path) && sameReceipt(records.get(receipt.path)!.receipt, receipt));
        effects.lock.mockImplementation((_path, operation) => operation());
        update.mockResolvedValue(true); release.mockResolvedValue(undefined);
        const path = session.getCurrentSession().lockFile;
        if (path && records.get(path)?.snapshot) {
            const snapshot = records.get(path)!.snapshot!;
            replaceObservation(path, { ...snapshot.observation, pending: null, ownStarted: null,
                lastAcknowledged: { generation: snapshot.observation.generation, sequence: 0, containerId: null, cleanupEnabled: false } });
            session.setSessionCleanupEnabled(false);
            await session.confirmSessionOwnership().catch(() => undefined);
        }
        session.clearSession(); vi.restoreAllMocks();
    });

    it("captures authority before reserving a claim and permits a fresh attempt after capture failure", async () => {
        const failure = new Error("native capture unavailable");
        effects.invocation.mockImplementationOnce(() => { throw failure; });
        const inspect = vi.fn(() => ({ known: true, containerId: null, runtime: "docker" as const }));
        await expect(session.acquireHostSessionOwnership(request, inspect)).rejects.toBe(failure);
        expect(inspect).not.toHaveBeenCalled();
        for (const effect of [effects.lock, effects.write, effects.capture, effects.arm, effects.devices, effects.spawn]) {
            expect(effect).not.toHaveBeenCalled();
        }
        expect(session.getCurrentSession()).toEqual(emptyContext);
        await expect(session.acquireHostSessionOwnership(request, inspect)).resolves.toMatchObject({ existingId: null });
        expect(inspect).toHaveBeenCalledTimes(1);
        session.cleanupSession();
    });

    it("refuses an inspection runtime that disagrees with the captured native authority before ID ACK or pruning", async () => {
        await expect(session.acquireHostSessionOwnership(request, () => ({
            known: true, containerId: exactId("untrusted-engine-id"), runtime: "podman",
        }))).rejects.toThrow();
        expect(update).not.toHaveBeenCalled();
        expect(effects.rollback).toHaveBeenCalledTimes(1);
        expect(effects.devices).not.toHaveBeenCalled();
        expect(effects.spawn).not.toHaveBeenCalled();
    });

    it("releases real signal registrations across eleven consecutive acquisition and cleanup cycles", async () => {
        vi.mocked(process.once).mockRestore();
        const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
        const before = signals.map(signal => process.listeners(signal));
        const activeCounts: number[][] = [];
        const completedCounts: number[][] = [];
        try {
            for (let index = 0; index < 11; index++) {
                await session.acquireHostSessionOwnership(request, () => ({
                    known: true, containerId: exactId(`reused-id-${index}`), runtime: "docker",
                }));
                activeCounts.push(signals.map(signal => process.listenerCount(signal)));
                session.cleanupSession();
                completedCounts.push(signals.map(signal => process.listenerCount(signal)));
            }
            expect(activeCounts).toEqual(Array.from({ length: 11 }, () => before.map(listeners => listeners.length + 1)));
            expect(completedCounts).toEqual(Array.from({ length: 11 }, () => before.map(listeners => listeners.length)));
            expect(signals.map(signal => process.listeners(signal))).toEqual(before);
            expect(effects.unlink).toHaveBeenCalledTimes(11);
            expect(release).toHaveBeenCalledTimes(11);
            expect(effects.spawn).not.toHaveBeenCalled();
        } finally {
            for (const [index, signal] of signals.entries()) {
                for (const listener of process.listeners(signal)) {
                    if (!before[index]!.includes(listener)) process.removeListener(signal, listener);
                }
            }
        }
    });

    it("keeps real signal registrations through pending ACK and removes them after complete rollback", async () => {
        vi.mocked(process.once).mockRestore();
        const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
        const before = signals.map(signal => process.listeners(signal));
        const failure = new Error("pending ACK rejected");
        let rejectAck!: (error: Error) => void;
        const pendingAck = new Promise<boolean>((_resolve, reject) => { rejectAck = reject; });
        update.mockImplementationOnce(() => pendingAck);
        const acquisition = session.acquireHostSessionOwnership(request, () => ({
            known: true, containerId: exactId("unacknowledged-id"), runtime: "docker",
        }));
        const outcome = acquisition.then(() => undefined, error => error);
        try {
            await vi.waitFor(() => expect(update).toHaveBeenCalledExactlyOnceWith(exactId("unacknowledged-id"), false));
            for (const [index, signal] of signals.entries()) {
                const current = process.listeners(signal);
                expect(current).toHaveLength(before[index]!.length + 1);
                for (const listener of before[index]!) expect(current).toContain(listener);
            }
            expect(effects.rollback).not.toHaveBeenCalled();
            expect(release).not.toHaveBeenCalled();
            rejectAck(failure);
            expect(await outcome).toBe(failure);
            expect(effects.rollback).toHaveBeenCalledExactlyOnceWith(effects.capture.mock.results[0].value);
            expect(release).toHaveBeenCalledTimes(1);
            expect(session.getCurrentSession()).toEqual(emptyContext);
            expect(signals.map(signal => process.listeners(signal))).toEqual(before);
        } finally {
            rejectAck(failure);
            await outcome;
            for (const [index, signal] of signals.entries()) {
                for (const listener of process.listeners(signal)) {
                    if (!before[index]!.includes(listener)) process.removeListener(signal, listener);
                }
            }
        }
    });

    it("retains the same real signal registrations after failed cleanup until successful retry", async () => {
        vi.mocked(process.once).mockRestore();
        const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
        const before = signals.map(signal => process.listeners(signal));
        try {
            const acquired = await session.acquireHostSessionOwnership(request, () => ({
                known: true, containerId: exactId("retry-exact-id"), runtime: "docker",
            }));
            session.setSessionCleanupEnabled(true);
            await session.confirmSessionOwnership();
            const active = signals.map(signal => process.listeners(signal));
            expect(active.map(listeners => listeners.length)).toEqual(before.map(listeners => listeners.length + 1));
            effects.spawn.mockReturnValueOnce({ status: 9 }).mockReturnValue({ status: 0 });
            expect(() => session.cleanupSession()).toThrow("Container shutdown failed");
            expect(session.getCurrentSession().lockFile).toBe(acquired.lockFile);
            expect(signals.map(signal => process.listeners(signal))).toEqual(active);
            expect(effects.unlink).not.toHaveBeenCalled();
            expect(release).not.toHaveBeenCalled();
            session.cleanupSession();
            expect(signals.map(signal => process.listeners(signal))).toEqual(before);
            expect(effects.unlink).toHaveBeenCalledExactlyOnceWith(acquired.lockFile);
            expect(release).toHaveBeenCalledTimes(1);
            expect(effects.spawn.mock.calls).toEqual([
                [invocation.executable, stopArgs(exactId("retry-exact-id")), stopOptions],
                [invocation.executable, stopArgs(exactId("retry-exact-id")), stopOptions],
            ]);
        } finally {
            for (const [index, signal] of signals.entries()) {
                for (const listener of process.listeners(signal)) {
                    if (!before[index]!.includes(listener)) process.removeListener(signal, listener);
                }
            }
        }
    });

    it.each(["inspection", "READY", "ACK"] as const)("registered signals share one completion while %s and guard release are pending", async stage => {
        const once = vi.mocked(process.once);
        const exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as () => never);
        const previous = process.exitCode;
        process.exitCode = 7;
        let held = false;
        let releaseGuard!: () => void;
        let continueStage!: () => void;
        const stagePending = new Promise<void>(resolve => { continueStage = resolve; });
        const guardPending = new Promise<void>(resolve => { releaseGuard = resolve; });
        let entered = false;
        effects.lock.mockImplementation(async (_path, operation) => {
            held = true;
            try { return await operation(); }
            finally { await guardPending; held = false; }
        });
        const retire = effects.rollback.getMockImplementation()!;
        effects.rollback.mockImplementation(receipt => { expect(held).toBe(true); retire(receipt); });
        if (stage === "READY") effects.arm.mockImplementation(async () => { entered = true; await stagePending; return handle; });
        if (stage === "ACK") update.mockImplementation(async () => { entered = true; await stagePending; return true; });
        const inspect = async () => {
            if (stage === "inspection") { entered = true; await stagePending; }
            return { known: true, containerId: exactId("captured-exact-id"), runtime: "docker" as const };
        };
        session.setupSignalHandlers();
        const acquisition = session.acquireHostSessionOwnership(request, inspect);
        const rejected = expect(acquisition).rejects.toThrow("cancelled");
        await vi.waitFor(() => expect(entered).toBe(true));
        const callbacks = ["SIGINT", "SIGTERM", "SIGHUP"].map(signal => [...once.mock.calls].reverse().find(([registered]) => registered === signal)![1]);
        for (const callback of [...callbacks, callbacks[0]]) expect(() => callback()).not.toThrow();
        expect(exit).not.toHaveBeenCalled();
        expect(effects.rollback).not.toHaveBeenCalled();
        expect(effects.unlink).not.toHaveBeenCalled();
        continueStage();
        await vi.waitFor(() => stage === "ACK"
            ? expect(session.getCurrentSession().lockFile).not.toBeNull()
            : expect(effects.rollback).toHaveBeenCalledTimes(1));
        expect(exit).not.toHaveBeenCalled();
        expect(held).toBe(true);
        effects.lock.mockImplementation((_path, operation) => {
            expect(held).toBe(false);
            held = true;
            try { return operation(); } finally { held = false; }
        });
        releaseGuard();
        await rejected;
        await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(7));
        expect(effects.spawn).not.toHaveBeenCalled();
        expect(effects.devices).not.toHaveBeenCalled();
        expect(update.mock.calls.every(call => call[1] === false)).toBe(true);
        if (stage === "ACK") {
            expect(effects.rollback).toHaveBeenCalledExactlyOnceWith(effects.capture.mock.results[0].value);
            expect(effects.unlink).toHaveBeenCalledExactlyOnceWith(effects.capture.mock.results[0].value.path);
            expect(release).toHaveBeenCalledTimes(1);
        }
        process.exitCode = previous;
    });

    it.each([false, true])("reports asynchronous signal cleanup failure without listener throw or unhandled rejection (diagnostic throws=%s)", async diagnosticThrows => {
        const once = vi.mocked(process.once);
        const exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as () => never);
        const report = vi.spyOn(console, "error").mockImplementation(() => {});
        if (diagnosticThrows) report.mockImplementation(() => { throw new Error("diagnostic unavailable"); });
        const previous = process.exitCode;
        process.exitCode = undefined;
        let inspectDone!: () => void;
        const pending = new Promise<void>(resolve => { inspectDone = resolve; });
        const failure = new Error("owned rollback failed");
        effects.rollback.mockImplementation(() => { throw failure; });
        session.setupSignalHandlers();
        const acquisition = session.acquireHostSessionOwnership(request, async () => { await pending; return { known: true, containerId: null, runtime: "docker" }; });
        const rejected = expect(acquisition).rejects.toBeInstanceOf(AggregateError);
        await vi.waitFor(() => expect(effects.capture).toHaveBeenCalledTimes(1));
        for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
            expect(() => [...once.mock.calls].reverse().find(([name]) => name === signal)![1]()).not.toThrow();
        }
        inspectDone();
        await rejected;
        await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(1));
        expect(report).toHaveBeenCalled();
        expect(effects.rollback).toHaveBeenCalledTimes(1);
        expect(effects.spawn).not.toHaveBeenCalled();
        process.exitCode = previous;
    });

    it.each(["guardian release", "guard finalizer"] as const)("signal exit preserves %s failure after successful reservation rollback", async failureStage => {
        const once = vi.mocked(process.once);
        const exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as () => never);
        const report = vi.spyOn(console, "error").mockImplementation(() => {});
        const previous = process.exitCode;
        process.exitCode = undefined;
        const failure = new Error(`${failureStage} failed after reservation removal`);
        let continueStage!: () => void;
        let entered = false;
        const pending = new Promise<void>(resolve => { continueStage = resolve; });
        if (failureStage === "guardian release") {
            effects.arm.mockImplementation(async () => { entered = true; await pending; return handle; });
            release.mockRejectedValue(failure);
        } else {
            effects.lock.mockImplementation(async (_path, operation) => {
                try { return await operation(); }
                catch (error) { throw new AggregateError([error, failure], "Acquisition and guard release failed", { cause: error }); }
            });
        }
        session.setupSignalHandlers();
        const acquisition = session.acquireHostSessionOwnership(request, async () => {
            if (failureStage === "guard finalizer") { entered = true; await pending; }
            return { known: true, containerId: exactId("unacknowledged-existing-id"), runtime: "docker" };
        });
        // Observe the public rejection immediately so the test cannot itself
        // produce an unhandled rejection while the signal completion settles.
        const outcome = acquisition.then(() => { throw new Error("Expected interrupted acquisition failure"); }, error => error);
        await vi.waitFor(() => expect(entered).toBe(true));
        expect(() => [...once.mock.calls].reverse().find(([signal]) => signal === "SIGTERM")![1]()).not.toThrow();
        expect(exit).not.toHaveBeenCalled();
        continueStage();
        const rejected = await outcome;
        expect(rejected).toBeInstanceOf(AggregateError);
        expect(rejected.errors).toEqual([expect.objectContaining({ message: expect.stringContaining("cancelled") }), failure]);
        expect(rejected.cause).toBe(rejected.errors[0]);
        expect(effects.rollback).toHaveBeenCalledExactlyOnceWith(effects.capture.mock.results[0].value);
        expect(session.getCurrentSession()).toEqual(emptyContext);
        await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(1));
        expect(report.mock.calls.some(call => call.includes(rejected))).toBe(true);
        expect(effects.lock).toHaveBeenCalledTimes(1);
        expect(update).not.toHaveBeenCalled();
        expect(effects.spawn).not.toHaveBeenCalled();
        expect(effects.devices).not.toHaveBeenCalled();
        expect(effects.unlink).toHaveBeenCalledExactlyOnceWith(effects.capture.mock.results[0].value.path);
        expect(release).toHaveBeenCalledTimes(failureStage === "guardian release" ? 1 : 0);
        process.exitCode = previous;
    });

    it("blocks generic cleanup while capture is pending and after capture fails without unlinking a replacement", async () => {
        let rejectArm!: (error: Error) => void;
        effects.arm.mockImplementation(() => new Promise((_resolve, reject) => { rejectArm = reject; }));
        start();
        const arming = session.armSessionOwnership();
        void arming.catch(() => undefined);
        expect(() => setQualifiedSession(join("/", "successor.lock"), project)).toThrow();
        expect(() => session.clearSession()).toThrow();
        expect(() => session.cleanupSession()).toThrow(/arming|ownership/i);
        expect(effects.unlink).not.toHaveBeenCalled(); expect(effects.devices).not.toHaveBeenCalled(); expect(effects.spawn).not.toHaveBeenCalled();
        const failure = new Error("capture failed"); rejectArm(failure);
        await expect(arming).rejects.toBe(failure);
        const captured = records.get(own)!.receipt;
        // A same-bytes replacement is not the failed arm attempt's claim.
        persistClaim(own, Buffer.from(captured.bytes, "base64").toString("utf8"));
        const successor = records.get(own)!.receipt;
        expect(successor.inode).not.toBe(captured.inode);
        let cleanupFailure: unknown;
        try { session.cleanupSession(); } catch (error) { cleanupFailure = error; }
        expect(cleanupFailure).toBe(failure);
        expect(records.get(own)!.receipt).toEqual(successor);
        expect(effects.unlink).not.toHaveBeenCalled(); expect(effects.spawn).not.toHaveBeenCalled();
    });

    it("blocks generic cleanup during pending inspection and preserves a successor on rollback", async () => {
        let inspected!: (value: { known: boolean; containerId: null; runtime: "docker" }) => void;
        const inspect = vi.fn(() => new Promise<{ known: boolean; containerId: null; runtime: "docker" }>(resolve => { inspected = resolve; }));
        const acquisition = session.acquireHostSessionOwnership(request, inspect);
        void acquisition.catch(() => undefined);
        await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(1));
        const captured = records.get(session.getCurrentSession().lockFile!)!.receipt;
        persistClaim(captured.path, Buffer.from(captured.bytes, "base64").toString("utf8"));
        const successor = records.get(captured.path)!.receipt;
        effects.authorize.mockImplementation(() => { throw new Error("receipt replaced"); });
        effects.matches.mockReturnValue(false);
        expect(() => session.cleanupSession()).toThrow("during acquisition");
        expect(effects.unlink).not.toHaveBeenCalled(); expect(effects.devices).not.toHaveBeenCalled();
        expect(() => setQualifiedSession(join("/", "successor.lock"), project)).toThrow();
        expect(() => setContainer(exactId("unauthorized-id"))).toThrow();
        inspected({ known: false, containerId: null, runtime: "docker" });
        const failure = await acquisition.then(() => undefined, error => error);
        expect(failure).toBeInstanceOf(AggregateError);
        expect(failure.errors).toEqual([
            expect.objectContaining({ message: expect.stringContaining("could not be inspected") }),
            expect.objectContaining({ message: expect.stringContaining("replaced before rollback") }),
        ]);
        expect(failure.cause).toBe(failure.errors[0]);
        expect(records.get(captured.path)!.receipt).toEqual(successor);
        expect(effects.rollback).not.toHaveBeenCalled(); expect(effects.spawn).not.toHaveBeenCalled();
    });

    it("checks captured receipt authorization inside the lifecycle guard before generic cleanup can touch a successor", async () => {
        const captured = receiptFor(own);
        effects.arm.mockImplementation(async (_binding, _failure, options) => { options.onCaptured(captured); return handle; });
        start(); await expect(session.armSessionOwnership()).resolves.toBe(321);
        effects.authorize.mockImplementation(receipt => { expect(receipt).toEqual(captured); throw new Error("receipt replaced"); });
        expect(() => setQualifiedSession(join("/", "successor.lock"), project)).toThrow();
        expect(() => session.cleanupSession()).toThrow("receipt replaced");
        expect(effects.lock).toHaveBeenCalledWith(join(fixtureLocks, "project.container-lifecycle.guard"), expect.any(Function), { waitMs: 180000 });
        expect(effects.unlink).not.toHaveBeenCalled();
        expect(effects.devices).not.toHaveBeenCalled(); expect(effects.spawn).not.toHaveBeenCalled();
        expect(session.getCurrentSession().lockFile).toBe(own); expect(release).not.toHaveBeenCalled();
    });

    it.each([
        ["claim removal", "revocation"], ["guard return", "revocation"],
        ["claim removal", "ID change"], ["guard return", "ID change"],
    ] as const)("settles owned cleanup after %s %s without authorizing its absent receipt again", async (phase, mutation) => {
        const captured = receiptFor(own);
        const present = new Set([own]);
        effects.write.mockImplementation(path => { present.add(String(path)); });
        effects.unlink.mockImplementation(path => {
            expect(present.delete(String(path))).toBe(true);
        });
        effects.authorize.mockImplementation((receipt: SessionOwnershipReceipt = captured) => {
            if (!present.has(receipt.path)) throw new Error("Captured ownership receipt is absent");
        });
        effects.arm.mockImplementationOnce(async (_binding, _failure, options) => {
            options.onCaptured(captured);
            return handle;
        });
        start();
        await expect(session.armSessionOwnership()).resolves.toBe(321);
        const mutate = () => {
            if (mutation === "revocation") session.setSessionCleanupEnabled(false);
            else setContainer(exactId("post-retirement-id"));
        };
        if (phase === "claim removal") {
            const unlink = effects.unlink.getMockImplementation()!;
            effects.unlink.mockImplementationOnce(path => { unlink(path); mutate(); });
        } else effects.lock.mockImplementationOnce((_path, operation) => {
            const result = operation();
            mutate();
            return result;
        });

        expect(() => session.cleanupSession()).not.toThrow();
        expect(present.has(own)).toBe(false);
        expect(effects.authorize).toHaveBeenCalledWith(captured);
        expect(effects.spawn).toHaveBeenCalledExactlyOnceWith(invocation.executable, stopArgs(capturedId), stopOptions);
        expect(effects.unlink).toHaveBeenCalledExactlyOnceWith(own);
        expect(release).toHaveBeenCalledTimes(1);
        expect(session.getCurrentSession()).toEqual({ ...emptyContext, toolName: "claude" });
        const authorizationCount = effects.authorize.mock.calls.length;

        expect(() => session.cleanupSession()).not.toThrow();
        expect(effects.authorize).toHaveBeenCalledTimes(authorizationCount);
        expect(effects.spawn).toHaveBeenCalledTimes(1);
        expect(effects.unlink).toHaveBeenCalledTimes(1);
        expect(release).toHaveBeenCalledTimes(1);
        expect(() => session.clearSession()).not.toThrow();

        const nextRelease = vi.fn<SessionOwnershipHandle["release"]>().mockResolvedValue(undefined);
        effects.arm.mockResolvedValueOnce({ ...handle, release: nextRelease });
        const next = await session.acquireHostSessionOwnership(request, () => ({
            known: true, containerId: null, runtime: "docker",
        }));
        expect(next.lockFile).not.toBe(own);
        expect(present.has(next.lockFile)).toBe(true);
        expect(session.getCurrentSession().lockFile).toBe(next.lockFile);
        session.cleanupSession();
        expect(effects.unlink.mock.calls).toEqual([[own], [next.lockFile]]);
        expect(effects.spawn).toHaveBeenCalledTimes(1);
        expect(release).toHaveBeenCalledTimes(1);
        expect(nextRelease).toHaveBeenCalledTimes(1);
    });

    it("retries only ownership settlement after guard return fails following owned claim retirement", async () => {
        const captured = receiptFor(own);
        const present = new Set([own]);
        effects.unlink.mockImplementation(path => {
            expect(present.delete(String(path))).toBe(true);
        });
        effects.authorize.mockImplementation((receipt: SessionOwnershipReceipt = captured) => {
            if (!present.has(receipt.path)) throw new Error("Captured ownership receipt is absent");
        });
        effects.arm.mockImplementationOnce(async (_binding, _failure, options) => {
            options.onCaptured(captured);
            return handle;
        });
        start();
        await expect(session.armSessionOwnership()).resolves.toBe(321);
        const failure = new Error("lifecycle guard release failed");
        effects.lock.mockImplementationOnce((_path, operation) => {
            operation();
            throw failure;
        });
        let caught: unknown;
        try { session.cleanupSession(); } catch (error) { caught = error; }
        expect(caught).toBe(failure);
        expect(present.has(own)).toBe(false);
        expect(effects.authorize).toHaveBeenCalledWith(captured);
        expect(session.getCurrentSession()).toEqual({ ...emptyContext, toolName: "claude" });
        expect(release).not.toHaveBeenCalled();
        const authorizationCount = effects.authorize.mock.calls.length;

        expect(() => session.cleanupSession()).not.toThrow();
        expect(effects.authorize).toHaveBeenCalledTimes(authorizationCount);
        expect(effects.spawn).toHaveBeenCalledExactlyOnceWith(invocation.executable, stopArgs(capturedId), stopOptions);
        expect(effects.unlink).toHaveBeenCalledExactlyOnceWith(own);
        expect(release).toHaveBeenCalledTimes(1);
        expect(() => session.clearSession()).not.toThrow();
        const nextLock = join(fixtureLocks, "project--p--next-profile--next.lock");
        expect(() => setQualifiedSession(nextLock, project, "next-profile")).not.toThrow();
        expect(session.getCurrentSession()).toEqual({ lockFile: nextLock, projectPath: project, profile: "next-profile", toolName: "claude" });
        expect(effects.spawn).toHaveBeenCalledTimes(1);
        expect(effects.unlink).toHaveBeenCalledTimes(1);
        expect(release).toHaveBeenCalledTimes(1);
    });

    it("rolls back only the captured new reservation on unknown inspection without arming or pruning foreign claims", async () => {
        const inspect = vi.fn(() => ({ known: false, containerId: null, runtime: "docker" as const }));
        await expect(session.acquireHostSessionOwnership(request, inspect)).rejects.toThrow("could not be inspected");
        expect(effects.write).toHaveBeenCalledExactlyOnceWith(
            effects.capture.mock.calls[0][0], JSON.stringify({ version: 3, pid: process.pid, startToken: null, ownershipKind: "monitored" }), { mode: 0o600, flag: "wx" },
        );
        expect(effects.rollback).toHaveBeenCalledExactlyOnceWith(effects.capture.mock.results[0].value);
        expect(effects.arm).not.toHaveBeenCalled();
        expect(effects.unlink).toHaveBeenCalledExactlyOnceWith(effects.capture.mock.results[0].value.path);
        expect(effects.devices).not.toHaveBeenCalled(); expect(effects.spawn).not.toHaveBeenCalled();
        expect(session.getCurrentSession()).toEqual(emptyContext);
    });

    it("recovers a stale direct predecessor before existing-ID ACK and blocks replacement while ACK is pending", async () => {
        effects.invocation.mockReturnValue(podmanInvocation);
        let ack!: () => void;
        update.mockImplementation(() => new Promise<boolean>(resolve => { ack = () => resolve(true); }));
        const foreign = join(fixtureLocks, "project--foreign.lock");
        effects.list.mockReturnValue([basename(foreign)]);
        effects.read.mockReturnValue(JSON.stringify({ version: 3, pid: 123, startToken: null, ownershipKind: "direct" }));
        effects.classify.mockImplementation(content => sessionLockOwner(content)?.pid === process.pid ? "active" : "stale");
        const acquisition = session.acquireHostSessionOwnership(request, () => ({ known: true, containerId: exactId("existing-exact-id"), runtime: "podman" }));
        void acquisition.catch(() => undefined);
        await vi.waitFor(() => expect(update).toHaveBeenCalledExactlyOnceWith(exactId("existing-exact-id"), false));
        expect(effects.unlink).toHaveBeenCalledExactlyOnceWith(foreign);
        expect(effects.rollback.mock.invocationCallOrder[0]).toBeLessThan(update.mock.invocationCallOrder[0]!);
        expect(() => setQualifiedSession(join("/", "other.lock"), project)).toThrow(); expect(() => session.clearSession()).toThrow();
        ack();
        const result = await acquisition;
        expect(result.existingId).toBe(exactId("existing-exact-id"));
        expect(effects.unlink).toHaveBeenCalledWith(join(fixtureLocks, "project--foreign.lock"));
        expect(() => setQualifiedSession(join("/", "other.lock"), project)).toThrow();
        expect(effects.devices).not.toHaveBeenCalled(); expect(effects.spawn).not.toHaveBeenCalled();
        effects.list.mockReturnValue([]);
        update.mockResolvedValue(true);
        session.setSessionCleanupEnabled(true);
        await session.confirmSessionOwnership();
        session.cleanupSession();
        expect(effects.spawn).toHaveBeenCalledExactlyOnceWith(podmanInvocation.executable, podmanStopArgs(exactId("existing-exact-id")), stopOptions);
        expect(release).toHaveBeenCalledTimes(1);
    });

    it("failed existing-ID ACK rolls back and releases the monitor without foreign pruning or shared effects", async () => {
        const failure = new Error("ACK failed"); update.mockRejectedValue(failure);
        await expect(session.acquireHostSessionOwnership(request, () => ({ known: true, containerId: exactId("existing-exact-id"), runtime: "docker" }))).rejects.toBe(failure);
        expect(effects.rollback).toHaveBeenCalledExactlyOnceWith(effects.capture.mock.results[0].value);
        expect(release).toHaveBeenCalledTimes(1);
        expect(effects.unlink).toHaveBeenCalledExactlyOnceWith(effects.capture.mock.results[0].value.path);
        expect(effects.devices).not.toHaveBeenCalled(); expect(effects.spawn).not.toHaveBeenCalled();
    });

    it("failed setup after joining an existing ID removes only its authorized claim", async () => {
        await session.acquireHostSessionOwnership(request, () => ({ known: true, containerId: exactId("existing-exact-id"), runtime: "docker" }));
        session.cleanupSession();
        expect(effects.spawn).not.toHaveBeenCalled();
        expect(effects.devices).not.toHaveBeenCalled();
        expect(effects.unlink).toHaveBeenCalledExactlyOnceWith(effects.capture.mock.results[0].value.path);
        expect(release).toHaveBeenCalledTimes(1);
    });

    it.each([
        { next: "failed join", authorized: false },
        { next: "authorized captured target", authorized: true },
    ])("rearms cleanup for a consecutive $next without caller context clearing", async ({ authorized }) => {
        const nextRelease = vi.fn<SessionOwnershipHandle["release"]>().mockResolvedValue(undefined);
        effects.arm.mockResolvedValueOnce(handle).mockResolvedValueOnce({ ...handle, release: nextRelease });

        const first = await session.acquireHostSessionOwnership(request, () => ({
            known: true, containerId: exactId("first-exact-id"), runtime: "docker",
        }));
        session.setSessionCleanupEnabled(true);
        await session.confirmSessionOwnership();
        session.cleanupSession();
        expect(effects.unlink).toHaveBeenCalledExactlyOnceWith(first.lockFile);
        expect(release).toHaveBeenCalledTimes(1);
        expect(effects.spawn).toHaveBeenCalledExactlyOnceWith(invocation.executable, stopArgs(exactId("first-exact-id")), stopOptions);
        expect(session.getCurrentSession().lockFile).toBeNull();

        const second = await session.acquireHostSessionOwnership(request, () => ({
            known: true, containerId: exactId("reused-exact-id"), runtime: "docker",
        }));
        expect(second.lockFile).not.toBe(first.lockFile);
        const receipts = effects.capture.mock.results.map(result => result.value as SessionOwnershipReceipt);
        const firstReceipt = receipts.find(receipt => receipt.path === first.lockFile)!;
        const secondReceipt = receipts.find(receipt => receipt.path === second.lockFile)!;
        expect(secondReceipt.path).not.toBe(firstReceipt.path);
        expect(secondReceipt.inode).not.toBe(firstReceipt.inode);
        expect(session.getCurrentSession().lockFile).toBe(second.lockFile);
        expect(update).toHaveBeenLastCalledWith(exactId("reused-exact-id"), false);
        if (authorized) {
            setContainer(exactId("replacement-exact-id"));
            await session.confirmSessionOwnership();
            session.setSessionCleanupEnabled(true);
            await session.confirmSessionOwnership();
            expect(update).toHaveBeenLastCalledWith(exactId("replacement-exact-id"), true);
        }

        session.cleanupSession();
        expect(effects.unlink.mock.calls).toEqual([[first.lockFile], [second.lockFile]]);
        expect(effects.authorize).toHaveBeenCalledWith(firstReceipt);
        expect(effects.authorize).toHaveBeenCalledWith(secondReceipt);
        expect(release).toHaveBeenCalledTimes(1);
        expect(nextRelease).toHaveBeenCalledTimes(1);
        expect(session.getCurrentSession().lockFile).toBeNull();
        expect(effects.devices).toHaveBeenCalledTimes(authorized ? 2 : 1);
        expect(effects.spawn.mock.calls).toEqual([
            [invocation.executable, stopArgs(exactId("first-exact-id")), stopOptions],
            ...(authorized ? [[invocation.executable, stopArgs(exactId("replacement-exact-id")), stopOptions]] : []),
        ]);
        session.cleanupSession();
        expect(effects.unlink).toHaveBeenCalledTimes(2);
        expect(release).toHaveBeenCalledTimes(1);
        expect(nextRelease).toHaveBeenCalledTimes(1);
        expect(effects.spawn).toHaveBeenCalledTimes(authorized ? 2 : 1);
    });

    it("confirmation waits for queued permission grants and revocations in order", async () => {
        await session.acquireHostSessionOwnership(request, () => ({ known: true, containerId: exactId("existing-exact-id"), runtime: "docker" }));
        let acknowledge!: () => void;
        update.mockImplementationOnce(() => new Promise<boolean>(resolve => { acknowledge = () => resolve(true); }));
        session.setSessionCleanupEnabled(true);
        await vi.waitFor(() => expect(update).toHaveBeenLastCalledWith(exactId("existing-exact-id"), true));
        session.setSessionCleanupEnabled(false);
        let confirmed = false;
        const confirmation = session.confirmSessionOwnership().then(() => { confirmed = true; });
        await Promise.resolve();
        expect(confirmed).toBe(false);
        expect(update).toHaveBeenCalledTimes(2);
        acknowledge();
        await confirmation;
        expect(update.mock.calls.map(call => call[1])).toEqual([false, true, false]);
        session.cleanupSession();
        expect(effects.spawn).not.toHaveBeenCalled();
        expect(effects.devices).not.toHaveBeenCalled();
        expect(effects.unlink).toHaveBeenCalledTimes(1);
    });

    it("preserves acknowledged cleanup ownership when the monitor fails before the ACK await continuation", async () => {
        const failure = new Error("monitor lost immediately after ACK");
        let monitorFailed!: (error: Error) => void;
        effects.arm.mockImplementation(async (_binding, onFailure) => { monitorFailed = onFailure; return handle; });
        update.mockImplementation(() => new Promise<boolean>(resolve => {
            resolve(true);
            monitorFailed(failure);
        }));
        await expect(session.acquireHostSessionOwnership(request, () => ({
            known: true, containerId: exactId("acknowledged-exact-id"), runtime: "docker",
        }))).rejects.toBe(failure);
        expect(update).toHaveBeenCalledExactlyOnceWith(exactId("acknowledged-exact-id"), false);
        const captured = effects.capture.mock.results[0].value as SessionOwnershipReceipt;
        expect(session.getCurrentSession()).toEqual({
            lockFile: captured.path, projectPath: project, profile: undefined, toolName: "codex",
        });
        expect(effects.rollback).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled();
        expect(effects.unlink).not.toHaveBeenCalled();
        expect(effects.devices).not.toHaveBeenCalled(); expect(effects.spawn).not.toHaveBeenCalled();
        expect(() => setQualifiedSession(join("/", "replacement.lock"), project)).toThrow();
        session.cleanupSession();
        expect(effects.authorize).toHaveBeenCalledWith(captured);
        expect(effects.spawn).not.toHaveBeenCalled();
        expect(effects.devices).not.toHaveBeenCalled();
        expect(effects.unlink).toHaveBeenCalledExactlyOnceWith(captured.path);
        expect(release).toHaveBeenCalledTimes(1);
        expect(session.getCurrentSession().lockFile).toBeNull();
    });

    it("a different captured ID first hands off false and needs its own acknowledged grant", async () => {
        await session.acquireHostSessionOwnership(request, () => ({ known: true, containerId: exactId("first-exact-id"), runtime: "docker" }));
        session.setSessionCleanupEnabled(true);
        await session.confirmSessionOwnership();
        update.mockClear();
        setContainer(exactId("replacement-exact-id"));
        await session.confirmSessionOwnership();
        expect(update).toHaveBeenCalledExactlyOnceWith(exactId("replacement-exact-id"), false);
        session.setSessionCleanupEnabled(true);
        await session.confirmSessionOwnership();
        expect(update.mock.calls).toEqual([
            [exactId("replacement-exact-id"), false], [exactId("replacement-exact-id"), true],
        ]);
        session.cleanupSession();
        expect(effects.spawn).toHaveBeenCalledExactlyOnceWith(invocation.executable, stopArgs(exactId("replacement-exact-id")), stopOptions);
    });

    it("rejected replacement-ID ACK cannot retain the previous ID's local stop authorization", async () => {
        await session.acquireHostSessionOwnership(request, () => ({ known: true, containerId: exactId("first-exact-id"), runtime: "docker" }));
        session.setSessionCleanupEnabled(true);
        await session.confirmSessionOwnership();
        const failure = new Error("fixture replacement ACK lost");
        let rejectAck!: (error: Error) => void;
        update.mockClear();
        update.mockImplementationOnce(() => new Promise<boolean>((_resolve, reject) => { rejectAck = reject; }));
        setContainer(exactId("replacement-exact-id"));
        const confirmation = session.confirmSessionOwnership();
        const rejected = expect(confirmation).rejects.toBe(failure);
        await vi.waitFor(() => expect(update).toHaveBeenCalledExactlyOnceWith(exactId("replacement-exact-id"), false));
        expect(effects.devices).not.toHaveBeenCalled();
        expect(effects.spawn).not.toHaveBeenCalled();
        rejectAck(failure);
        await rejected;
        expect(() => session.cleanupSession()).toThrow("responsibility-incomplete");
        expect(effects.devices).not.toHaveBeenCalled();
        expect(effects.spawn).not.toHaveBeenCalled();
        expect(effects.unlink).not.toHaveBeenCalled();
        expect(session.getCurrentSession().lockFile).not.toBeNull();
    });

    it("capturing the same acknowledged ID retains its own shutdown authorization", async () => {
        await session.acquireHostSessionOwnership(request, () => ({ known: true, containerId: exactId("first-exact-id"), runtime: "docker" }));
        session.setSessionCleanupEnabled(true);
        await session.confirmSessionOwnership();
        update.mockClear();
        setContainer(exactId("first-exact-id"));
        await session.confirmSessionOwnership();
        expect(update).toHaveBeenCalledExactlyOnceWith(exactId("first-exact-id"), true);
        session.cleanupSession();
        expect(effects.spawn).toHaveBeenCalledExactlyOnceWith(invocation.executable, stopArgs(exactId("first-exact-id")), stopOptions);
    });

    it("reports monitor loss during asynchronous acquisition guard release while retaining the acknowledged cleanup ID", async () => {
        const failure = new Error("monitor lost during guard release");
        let monitorFailed!: (error: Error) => void;
        effects.arm.mockImplementation(async (_binding, onFailure) => { monitorFailed = onFailure; return handle; });
        effects.lock.mockImplementation(async (_path, operation) => {
            const result = await operation();
            monitorFailed(failure);
            return result;
        });
        await expect(session.acquireHostSessionOwnership(request, () => ({
            known: true, containerId: exactId("acknowledged-exact-id"), runtime: "docker",
        }))).rejects.toBe(failure);
        const captured = effects.capture.mock.results[0].value as SessionOwnershipReceipt;
        expect(session.getCurrentSession().lockFile).toBe(captured.path);
        expect(effects.rollback).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled();
        expect(effects.unlink).not.toHaveBeenCalled(); expect(effects.spawn).not.toHaveBeenCalled();
        effects.lock.mockImplementation((_path, operation) => operation());
        session.cleanupSession();
        expect(effects.spawn).not.toHaveBeenCalled();
        expect(effects.devices).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledTimes(1);
    });
});
