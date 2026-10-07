import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armSessionOwnership, createSessionOwnershipGuardian } from "../../application/session-ownership.js";
import {
    captureNativeSessionOwnership, nativeSessionOwnershipMatches, removeCapturedNativeSessionOwnership,
} from "../../adapters/session-ownership.js";
import {
    assertNativeSessionOwnership, cleanupCapturedNativeSessionOwnership, rollbackCapturedNativeSessionOwnership, validateNativeSessionOwnership,
} from "../../composition/session-ownership.js";
import { getProjectId } from "../../utils.js";
import { setRuntimeOverride } from "../../container-runtime.js";
import { fileSymlinkOrSkip } from "../helpers/file-symlink-fixture.js";
import type {
    SessionOwnershipBinding, SessionOwnershipChannel, SessionOwnershipGuardianPorts,
    SessionOwnershipMessage, SessionOwnershipPorts, SessionOwnershipReceipt,
} from "../../ports/session-ownership.js";

const nativeEnvironment = vi.hoisted(() => ({ home: "" }));
vi.mock("os", async original => ({ ...await original<typeof import("node:os")>(), homedir: () => nativeEnvironment.home }));

const binding: SessionOwnershipBinding = { lockFile: "/claims/project--p--work--owner.lock", projectPath: "/project", profile: "work", toolName: "claude" };
const receipt: SessionOwnershipReceipt = { path: binding.lockFile, bytes: "42", device: "1", inode: "2", birthtime: "3", ownerPid: 42 };
const containerId = "a".repeat(64);
const secondContainerId = "b".repeat(12);

function parentFixture() {
    const sent: SessionOwnershipMessage[] = [];
    const failures: Error[] = [];
    const cleanups: unknown[][] = [];
    const timers = new Map<object, () => void>();
    const messages = new Set<(message: unknown) => void>();
    const losses = new Set<(error: Error) => void>();
    let closed = 0;
    let unreferenced = 0;
    const channel: SessionOwnershipChannel = {
        pid: 70,
        async send(message) { sent.push(message); },
        onMessage(listener) { messages.add(listener); return () => { messages.delete(listener); }; },
        onLoss(listener) { losses.add(listener); return () => { losses.delete(listener); }; },
        close() { closed++; },
        unref() { unreferenced++; },
    };
    const ports: SessionOwnershipPorts = {
        launch: () => channel,
        cleanup: (ownedBinding, ownedReceipt) => { cleanups.push([ownedBinding, ownedReceipt]); },
        setTimer(callback, milliseconds) { expect(milliseconds).toBe(30); const timer = {}; timers.set(timer, callback); return timer; },
        clearTimer(timer) { timers.delete(timer as object); },
        timeoutMs: 30,
        assertOwnership: (ownedBinding, ownedReceipt) => { expect(ownedBinding).toEqual(binding); expect(ownedReceipt).toEqual(receipt); },
    };
    return {
        channel, ports, sent, failures, cleanups, timers,
        arm: () => armSessionOwnership(binding, receipt, ports, error => { failures.push(error); }),
        message: (message: unknown) => { for (const listener of messages) listener(message); },
        loss: (error: Error) => { for (const listener of losses) listener(error); },
        expire: () => { for (const callback of [...timers.values()]) callback(); },
        state: () => ({ closed, unreferenced, listeners: messages.size + losses.size }),
    };
}

describe("parent ownership handshake", () => {
    it("waits for READY before arming, uses a bounded timer and captures the exact binding and receipt", async () => {
        const f = parentFixture();
        let armed = false;
        const pending = f.arm().then(handle => { armed = true; return handle; });
        expect(f.sent).toEqual([{ type: "init", binding, receipt }]);
        await Promise.resolve();
        expect(armed).toBe(false);
        expect(f.timers.size).toBe(1);
        expect(f.state().unreferenced).toBe(0);
        f.message({ type: "ready" });
        const handle = await pending;
        expect(handle.pid).toBe(70);
        expect(armed).toBe(true);
        expect(f.timers.size).toBe(0);
        expect(f.state().unreferenced).toBe(1);
        expect(f.cleanups).toEqual([]);
    });

    it("an ACK, malformed message or unsolicited update cannot replace READY", async () => {
        const f = parentFixture();
        let armed = false;
        const pending = f.arm().then(handle => { armed = true; return handle; });
        for (const message of [null, "ready", {}, { type: "ack", sequence: 0 }, { type: "update", sequence: 1, containerId: "untrusted", runtime: "docker" }]) f.message(message);
        await Promise.resolve();
        expect(armed).toBe(false);
        expect(f.timers.size).toBe(1);
        f.message({ type: "ready" });
        await pending;
    });

    it("a launch exception visibly fails and rolls back only the newly captured claim", async () => {
        const f = parentFixture();
        const failure = new Error("spawn unavailable");
        f.ports.launch = () => { throw failure; };
        await expect(f.arm()).rejects.toBe(failure);
        expect(f.cleanups).toEqual([[binding, receipt]]);
        expect(f.failures).toEqual([]);
        expect(f.timers.size).toBe(0);
    });

    it("caller mutation during READY cannot replace the captured binding or receipt used for rollback", async () => {
        const f = parentFixture();
        const callerBinding = { ...binding };
        const callerReceipt = { ...receipt };
        const pending = armSessionOwnership(callerBinding, callerReceipt, f.ports, error => { f.failures.push(error); });
        const rejection = expect(pending).rejects.toThrow(/timed out/i);
        callerBinding.lockFile = "/claims/successor.lock";
        callerBinding.profile = "other";
        callerReceipt.path = callerBinding.lockFile;
        callerReceipt.bytes = "successor";
        f.expire();
        await rejection;
        expect(f.sent[0]).toEqual({ type: "init", binding, receipt });
        expect(f.cleanups).toEqual([[binding, receipt]]);
    });

    it("READY timeout rejects, rolls back the owned receipt and removes all timers and listeners", async () => {
        const f = parentFixture();
        const pending = f.arm();
        const rejection = expect(pending).rejects.toThrow(/timed out/i);
        f.expire();
        await rejection;
        expect(f.cleanups).toEqual([[binding, receipt]]);
        expect(f.failures).toEqual([]);
        expect(f.timers.size).toBe(0);
        expect(f.state().listeners).toBe(0);
        expect(f.state().closed).toBeGreaterThan(0);
        f.message({ type: "ready" });
        expect(f.cleanups).toHaveLength(1);
    });

    it("IPC send failure during initialization rejects with owned rollback", async () => {
        const f = parentFixture();
        const failure = new Error("IPC closed");
        f.channel.send = async () => { throw failure; };
        await expect(f.arm()).rejects.toBe(failure);
        expect(f.cleanups).toEqual([[binding, receipt]]);
        expect(f.timers.size).toBe(0);
        expect(f.state().listeners).toBe(0);
    });

    it("unexpected guardian loss after READY surfaces through onFailure exactly once", async () => {
        const f = parentFixture();
        const pending = f.arm();
        f.message({ type: "ready" });
        const handle = await pending;
        const failure = new Error("guardian died");
        f.loss(failure);
        f.loss(failure);
        expect(f.failures).toEqual([failure]);
        expect(f.cleanups).toEqual([]);
        expect(f.state().listeners).toBe(0);
        await expect(handle.updateContainer(containerId, "docker")).rejects.toThrow();
    });

    it("the ownership handle checks the native receipt even after channel loss to guard failure cleanup", async () => {
        const f = parentFixture();
        const pending = f.arm();
        f.message({ type: "ready" });
        const handle = await pending;
        const checked: unknown[][] = [];
        f.ports.assertOwnership = (...args) => { checked.push(args); };
        handle.assertOwnership();
        f.loss(new Error("guardian loss"));
        const successor = new Error("same-path successor");
        f.ports.assertOwnership = () => { throw successor; };
        expect(() => handle.assertOwnership()).toThrow(successor);
        expect(checked).toEqual([[binding, receipt]]);
    });

    it("container handoff awaits its exact sequence ACK and timeout surfaces a live-session failure", async () => {
        const f = parentFixture();
        const pending = f.arm();
        f.message({ type: "ready" });
        const handle = await pending;
        let acknowledged = false;
        const update = handle.updateContainer(containerId, "podman").then(() => { acknowledged = true; });
        expect(f.sent.at(-1)).toEqual({ type: "update", sequence: 1, containerId, runtime: "podman", cleanupEnabled: false });
        f.message({ type: "ack", sequence: 9 });
        await Promise.resolve();
        expect(acknowledged).toBe(false);
        f.message({ type: "ack", sequence: 1 });
        await update;
        expect(f.timers.size).toBe(0);
        const next = handle.updateContainer(secondContainerId, "docker");
        const rejection = expect(next).rejects.toThrow(/timed out/i);
        f.expire();
        await rejection;
        expect(f.failures).toHaveLength(1);
        expect(f.timers.size).toBe(0);
        expect(f.state().listeners).toBe(0);
    });

    it("normal release awaits ACK, disposes the channel and ignores subsequent loss or duplicate release", async () => {
        const f = parentFixture();
        const pending = f.arm();
        f.message({ type: "ready" });
        const handle = await pending;
        const released = handle.release();
        expect(f.sent.at(-1)).toEqual({ type: "release", sequence: 1 });
        f.message({ type: "ack", sequence: 1 });
        await released;
        f.loss(new Error("normal child exit"));
        await handle.release();
        expect(f.failures).toEqual([]);
        expect(f.cleanups).toEqual([]);
        expect(f.sent.filter(message => message.type === "release")).toHaveLength(1);
        expect(f.timers.size).toBe(0);
        expect(f.state()).toEqual({ closed: 1, unreferenced: 1, listeners: 0 });
    });

    it("an already queued deadline callback cannot fail an acknowledged READY or handoff", async () => {
        const f = parentFixture();
        const pending = f.arm();
        const readyDeadline = [...f.timers.values()][0]!;
        f.message({ type: "ready" });
        const handle = await pending;
        readyDeadline();
        const update = handle.updateContainer(containerId, "docker");
        const handoffDeadline = [...f.timers.values()][0]!;
        f.message({ type: "ack", sequence: 1 });
        await update;
        handoffDeadline();
        expect(f.failures).toEqual([]);
        expect(f.state().closed).toBe(0);
        const next = handle.updateContainer(secondContainerId, "podman");
        f.message({ type: "ack", sequence: 2 });
        await next;
    });
});

describe("native ownership receipt and binding", () => {
    let ownedBinding: SessionOwnershipBinding;
    let ownedReceipt: SessionOwnershipReceipt;
    let lockDirectory: string;
    beforeEach(() => {
        nativeEnvironment.home = mkdtempSync(join(tmpdir(), "ccc-ownership-unit-"));
        lockDirectory = join(nativeEnvironment.home, ".ccc", "run", "locks");
        mkdirSync(lockDirectory, { recursive: true });
        const projectPath = join(nativeEnvironment.home, "project");
        ownedBinding = {
            lockFile: join(lockDirectory, `${getProjectId(projectPath)}--p--work--owner.lock`),
            projectPath, profile: "work", toolName: "claude",
        };
        writeFileSync(ownedBinding.lockFile, ` {"version":2,"pid":${process.pid},"startToken":"fixture-start"}\n`, { flag: "wx", mode: 0o600 });
        ownedReceipt = captureNativeSessionOwnership(ownedBinding.lockFile);
    });
    afterEach(() => {
        setRuntimeOverride(null);
        rmSync(nativeEnvironment.home, { recursive: true, force: true });
        nativeEnvironment.home = "";
    });

    it("captures exact record bytes and native file identity and accepts the bound project/profile/owner", () => {
        expect(Buffer.from(ownedReceipt.bytes, "base64")).toEqual(readFileSync(ownedBinding.lockFile));
        expect(ownedReceipt).toMatchObject({ path: ownedBinding.lockFile, ownerPid: process.pid });
        expect(ownedReceipt.device).toMatch(/^\d+$/);
        expect(ownedReceipt.inode).toMatch(/^\d+$/);
        expect(ownedReceipt.birthtime).toMatch(/^\d+$/);
        expect(nativeSessionOwnershipMatches(ownedReceipt)).toBe(true);
        expect(() => assertNativeSessionOwnership(ownedReceipt)).not.toThrow();
        expect(() => validateNativeSessionOwnership(ownedBinding, ownedReceipt, process.pid)).not.toThrow();
    });

    it.each(["legacy", "versioned"])("removes only an unchanged captured %s claim", format => {
        if (format === "legacy") writeFileSync(ownedBinding.lockFile, String(process.pid));
        const captured = captureNativeSessionOwnership(ownedBinding.lockFile);
        removeCapturedNativeSessionOwnership(captured);
        expect(existsSync(ownedBinding.lockFile)).toBe(false);
        expect(nativeSessionOwnershipMatches(captured)).toBe(false);
    });

    it("startup rollback removes only the captured claim and preserves a proven stale predecessor", () => {
        const predecessor = join(lockDirectory, `${getProjectId(ownedBinding.projectPath)}--p--work--predecessor.lock`);
        writeFileSync(predecessor, "99999999", { flag: "wx" });
        rollbackCapturedNativeSessionOwnership(ownedBinding, ownedReceipt);
        expect(existsSync(ownedBinding.lockFile)).toBe(false);
        expect(readFileSync(predecessor, "utf8")).toBe("99999999");
        expect(existsSync(join(nativeEnvironment.home, ".ccc", "devices"))).toBe(false);
    });

    it("changing record bytes in the same file denies removal and all composition cleanup effects", () => {
        const replacement = String(process.pid + 1);
        writeFileSync(ownedBinding.lockFile, replacement);
        expect(nativeSessionOwnershipMatches(ownedReceipt)).toBe(false);
        expect(() => assertNativeSessionOwnership(ownedReceipt)).toThrow();
        expect(() => removeCapturedNativeSessionOwnership(ownedReceipt)).toThrow();
        cleanupCapturedNativeSessionOwnership(ownedBinding, ownedReceipt, "must-never-stop", "docker");
        expect(readFileSync(ownedBinding.lockFile, "utf8")).toBe(replacement);
    });

    it("a same-path successor with identical bytes has different identity and survives guarded cleanup", () => {
        // Retain the old inode so immediate filesystem inode reuse cannot mask the replacement.
        renameSync(ownedBinding.lockFile, join(lockDirectory, "retired-receipt"));
        writeFileSync(ownedBinding.lockFile, Buffer.from(ownedReceipt.bytes, "base64"), { flag: "wx" });
        const successor = captureNativeSessionOwnership(ownedBinding.lockFile);
        expect(successor.bytes).toBe(ownedReceipt.bytes);
        expect(successor.inode).not.toBe(ownedReceipt.inode);
        expect(nativeSessionOwnershipMatches(ownedReceipt)).toBe(false);
        expect(() => removeCapturedNativeSessionOwnership(ownedReceipt)).toThrow();
        rollbackCapturedNativeSessionOwnership(ownedBinding, ownedReceipt);
        cleanupCapturedNativeSessionOwnership(ownedBinding, ownedReceipt, "must-never-stop", "podman");
        expect(captureNativeSessionOwnership(ownedBinding.lockFile)).toEqual(successor);
    });

    it("an unreadable/non-file own path fails closed and survives guarded cleanup", () => {
        rmSync(ownedBinding.lockFile);
        mkdirSync(ownedBinding.lockFile);
        expect(() => captureNativeSessionOwnership(ownedBinding.lockFile)).toThrow();
        expect(nativeSessionOwnershipMatches(ownedReceipt)).toBe(false);
        expect(() => removeCapturedNativeSessionOwnership(ownedReceipt)).toThrow();
        cleanupCapturedNativeSessionOwnership(ownedBinding, ownedReceipt, "must-never-stop", "docker");
        expect(existsSync(ownedBinding.lockFile)).toBe(true);
    });

    it("a symlink cannot stand in for the captured owner and its target survives", context => {
        const target = join(lockDirectory, "captured-target");
        renameSync(ownedBinding.lockFile, target);
        fileSymlinkOrSkip(context, target, ownedBinding.lockFile);
        expect(() => captureNativeSessionOwnership(ownedBinding.lockFile)).toThrow();
        expect(nativeSessionOwnershipMatches(ownedReceipt)).toBe(false);
        expect(() => removeCapturedNativeSessionOwnership(ownedReceipt)).toThrow();
        cleanupCapturedNativeSessionOwnership(ownedBinding, ownedReceipt, "must-never-stop", "docker");
        expect(readFileSync(target)).toEqual(Buffer.from(ownedReceipt.bytes, "base64"));
        expect(existsSync(ownedBinding.lockFile)).toBe(true);
    });

    it.each(["missing", "malformed", "oversized"])("fails closed on a %s receipt", kind => {
        if (kind === "missing") rmSync(ownedBinding.lockFile);
        if (kind === "malformed") writeFileSync(ownedBinding.lockFile, "not an owner");
        if (kind === "oversized") writeFileSync(ownedBinding.lockFile, "1".repeat(4097));
        expect(() => captureNativeSessionOwnership(ownedBinding.lockFile)).toThrow();
        expect(nativeSessionOwnershipMatches(ownedReceipt)).toBe(false);
        expect(() => assertNativeSessionOwnership(ownedReceipt)).toThrow();
    });

    it.each(["project", "profile", "owner", "record-owner", "path", "directory"])("rejects a mismatched %s binding", mismatch => {
        let candidateBinding = { ...ownedBinding };
        let candidateReceipt = { ...ownedReceipt };
        let owner = process.pid;
        if (mismatch === "project") candidateBinding.projectPath += "-other";
        if (mismatch === "profile") candidateBinding.profile = "work--extra";
        if (mismatch === "owner") owner++;
        if (mismatch === "record-owner") candidateReceipt.bytes = Buffer.from(String(process.pid + 1)).toString("base64");
        if (mismatch === "path") candidateReceipt.path += "-other";
        if (mismatch === "directory") {
            candidateReceipt = { ...candidateReceipt, path: join(nativeEnvironment.home, "outside", ownedBinding.lockFile.split("/").at(-1)!) };
            candidateBinding = { ...candidateBinding, lockFile: candidateReceipt.path };
        }
        expect(() => validateNativeSessionOwnership(candidateBinding, candidateReceipt, owner)).toThrow();
    });
});

function guardianFixture() {
    const sent: SessionOwnershipMessage[] = [];
    const cleanups: unknown[][] = [];
    const rollbacks: unknown[][] = [];
    let finishes = 0;
    const finishStatuses: Array<0 | 1 | undefined> = [];
    const ports: SessionOwnershipGuardianPorts = {
        validate: (ownedBinding, ownedReceipt) => { expect(ownedBinding).toEqual(binding); expect(ownedReceipt).toEqual(receipt); },
        cleanup: (...args) => { cleanups.push(args); },
        rollback: (...args) => { rollbacks.push(args); },
        send: async message => { sent.push(message); },
        finish: status => { finishes++; finishStatuses.push(status); },
    };
    const guardian = createSessionOwnershipGuardian(ports);
    return { guardian, ports, sent, cleanups, rollbacks, finishStatuses, finishes: () => finishes,
        init: () => guardian.receive({ type: "init", binding: { ...binding }, receipt: { ...receipt } }),
    };
}

function deferred() {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

describe("guardian ownership protocol", () => {
    it("requires a rollback port before accepting any native ownership effects", () => {
        const f = guardianFixture();
        expect(() => createSessionOwnershipGuardian({ ...f.ports, rollback: undefined } as unknown as SessionOwnershipGuardianPorts)).toThrow(TypeError);
        expect(f.cleanups).toEqual([]);
        expect(f.rollbacks).toEqual([]);
        expect(f.sent).toEqual([]);
    });

    it("validates initialization before READY and disconnect before captured ID never discovers a container by name", async () => {
        const f = guardianFixture();
        await f.init();
        expect(f.sent).toEqual([{ type: "ready" }]);
        await f.guardian.disconnect();
        await f.guardian.disconnect();
        expect(f.cleanups).toEqual([]);
        expect(f.rollbacks).toEqual([[binding, receipt]]);
        expect(f.finishes()).toBe(1);
    });

    it("disconnect passes only the exact acknowledged container ID and selected runtime to cleanup", async () => {
        const f = guardianFixture();
        await f.init();
        await f.guardian.receive({ type: "update", sequence: 1, containerId, runtime: "podman", cleanupEnabled: true });
        expect(f.sent.at(-1)).toEqual({ type: "ack", sequence: 1 });
        await f.guardian.disconnect();
        expect(f.cleanups).toEqual([[binding, receipt, containerId, "podman"]]);
        expect(f.rollbacks).toEqual([]);
        expect(f.finishes()).toBe(1);
    });

    it("normal release acknowledges once and prevents disconnect cleanup", async () => {
        const f = guardianFixture();
        await f.init();
        await f.guardian.receive({ type: "update", sequence: 1, containerId, runtime: "docker", cleanupEnabled: true });
        await f.guardian.receive({ type: "release", sequence: 2 });
        await f.guardian.disconnect();
        await f.guardian.receive({ type: "release", sequence: 3 });
        expect(f.sent).toEqual([{ type: "ready" }, { type: "ack", sequence: 1 }, { type: "ack", sequence: 2 }]);
        expect(f.cleanups).toEqual([]);
        expect(f.rollbacks).toEqual([]);
        expect(f.finishes()).toBe(1);
    });

    it("failed binding or receipt validation rejects without adopting untrusted ownership", async () => {
        const f = guardianFixture();
        f.ports.validate = () => { throw new Error("owner mismatch"); };
        await expect(f.init()).rejects.toThrow("owner mismatch");
        expect(f.sent).toEqual([{ type: "error" }]);
        expect(f.cleanups).toEqual([]);
        expect(f.finishes()).toBe(1);
    });

    it.each([null, "update", {}, { type: "update", sequence: 1, containerId: "bad", runtime: "docker", cleanupEnabled: true }])("rejects pre-init message %j without cleanup", async message => {
        const f = guardianFixture();
        await expect(f.guardian.receive(message)).rejects.toThrow();
        expect(f.sent).toEqual([{ type: "error" }]);
        expect(f.cleanups).toEqual([]);
        expect(f.finishes()).toBe(1);
    });

    it.each([
        { type: "update", sequence: 0, containerId, runtime: "docker", cleanupEnabled: true },
        { type: "update", sequence: 1.5, containerId, runtime: "docker", cleanupEnabled: true },
        { type: "update", sequence: 1, containerId: "", runtime: "docker", cleanupEnabled: true },
        { type: "update", sequence: 1, containerId, runtime: "other", cleanupEnabled: true },
        { type: "update", sequence: 1, containerId: "--all", runtime: "docker", cleanupEnabled: true },
        { type: "update", sequence: 1, containerId: "container-name", runtime: "podman", cleanupEnabled: true },
        { type: "update", sequence: 1, containerId: "a".repeat(65), runtime: "docker", cleanupEnabled: true },
        { type: "init", binding: { ...binding, lockFile: "/successor.lock" }, receipt },
        { type: "ack", sequence: 1 },
    ])("malformed post-init message %j preserves captured ownership and never adopts its ID", async message => {
        const f = guardianFixture();
        await f.init();
        await expect(f.guardian.receive(message)).rejects.toThrow();
        expect(f.sent.at(-1)).toEqual({ type: "error" });
        expect(f.cleanups).toEqual([]);
        expect(f.rollbacks).toEqual([[binding, receipt]]);
        expect(f.finishes()).toBe(1);
    });

    it("replayed handoff cannot replace the acknowledged ID", async () => {
        const f = guardianFixture();
        await f.init();
        await f.guardian.receive({ type: "update", sequence: 1, containerId, runtime: "docker", cleanupEnabled: true });
        await expect(f.guardian.receive({ type: "update", sequence: 1, containerId: secondContainerId, runtime: "podman", cleanupEnabled: true })).rejects.toThrow();
        expect(f.cleanups).toEqual([[binding, receipt, containerId, "docker"]]);
    });

    it("failed ACK delivery cannot authorize stopping an unacknowledged ID", async () => {
        const f = guardianFixture();
        await f.init();
        f.ports.send = async message => { if (message.type === "ack") throw new Error("IPC closed"); f.sent.push(message); };
        await expect(f.guardian.receive({ type: "update", sequence: 1, containerId, runtime: "podman", cleanupEnabled: true })).rejects.toThrow("IPC closed");
        expect(f.cleanups).toEqual([]);
        expect(f.rollbacks).toEqual([[binding, receipt]]);
        expect(f.finishes()).toBe(1);
    });

    it("disconnect waits for a pending ACK transport callback before stopping the acknowledged ID", async () => {
        const f = guardianFixture();
        await f.init();
        const ack = deferred();
        const sending = deferred();
        f.ports.send = async message => {
            f.sent.push(message);
            if (message.type === "ack") { sending.resolve(); await ack.promise; }
        };
        const update = f.guardian.receive({ type: "update", sequence: 1, containerId, runtime: "podman", cleanupEnabled: true });
        await sending.promise;
        const disconnected = f.guardian.disconnect();
        await Promise.resolve();
        expect(f.cleanups).toEqual([]);
        expect(f.finishes()).toBe(0);
        ack.resolve();
        await update;
        await disconnected;
        expect(f.cleanups).toEqual([[binding, receipt, containerId, "podman"]]);
        expect(f.finishes()).toBe(1);
    });

    it.each([false, true])("an asynchronously rejected ACK preserves prior acknowledged ownership (prior ID %s)", async hasPriorId => {
        const f = guardianFixture();
        await f.init();
        if (hasPriorId) await f.guardian.receive({ type: "update", sequence: 1, containerId, runtime: "docker", cleanupEnabled: true });
        const ack = deferred();
        const sending = deferred();
        f.ports.send = async message => {
            f.sent.push(message);
            if (message.type === "ack") { sending.resolve(); await ack.promise; }
        };
        const failure = new Error("native ACK write callback failed");
        const update = f.guardian.receive({ type: "update", sequence: hasPriorId ? 2 : 1, containerId: secondContainerId, runtime: "podman", cleanupEnabled: true });
        const rejected = expect(update).rejects.toBe(failure);
        await sending.promise;
        const disconnected = f.guardian.disconnect();
        await Promise.resolve();
        expect(f.cleanups).toEqual([]);
        expect(f.finishes()).toBe(0);
        ack.reject(failure);
        await rejected;
        await disconnected;
        expect(f.cleanups).toEqual(hasPriorId ? [[binding, receipt, containerId, "docker"]] : []);
        expect(f.rollbacks).toEqual(hasPriorId ? [] : [[binding, receipt]]);
        expect(f.finishStatuses).toEqual([1]);
    });

    it("asynchronous READY transport failure cleans the captured owner without adopting a container ID", async () => {
        const f = guardianFixture();
        const ready = deferred();
        const sending = deferred();
        f.ports.send = async message => {
            f.sent.push(message);
            if (message.type === "ready") { sending.resolve(); await ready.promise; }
        };
        const failure = new Error("native READY callback failed");
        const initialized = f.init();
        const rejected = expect(initialized).rejects.toBe(failure);
        await sending.promise;
        const disconnected = f.guardian.disconnect();
        expect(f.cleanups).toEqual([]);
        ready.reject(failure);
        await rejected;
        await disconnected;
        expect(f.cleanups).toEqual([]);
        expect(f.rollbacks).toEqual([[binding, receipt]]);
        expect(f.finishStatuses).toEqual([1]);
    });

    it("an owned rollback failure rejects with its exact identity and reports exit failure", async () => {
        const f = guardianFixture();
        await f.init();
        const failure = new Error("captured claim rollback failed");
        f.ports.rollback = () => { throw failure; };
        await expect(f.guardian.disconnect()).rejects.toBe(failure);
        await f.guardian.disconnect();
        expect(f.cleanups).toEqual([]);
        expect(f.finishStatuses).toEqual([1]);
    });

    it("READY callback rejection cannot hide the rollback error or invoke full cleanup", async () => {
        const f = guardianFixture();
        const ready = deferred();
        const sending = deferred();
        const rollbackFailure = new Error("rollback failed after READY loss");
        f.ports.rollback = () => { throw rollbackFailure; };
        f.ports.send = async message => {
            if (message.type === "ready") { sending.resolve(); await ready.promise; }
            if (message.type === "error") throw new Error("error callback failed");
        };
        const initialized = f.init();
        const rejected = expect(initialized).rejects.toBe(rollbackFailure);
        await sending.promise;
        ready.reject(new Error("READY callback failed"));
        await rejected;
        await f.guardian.disconnect();
        expect(f.cleanups).toEqual([]);
        expect(f.finishStatuses).toEqual([1]);
    });

    it("a rejected release ACK cleans prior ownership and cannot masquerade as successful release", async () => {
        const f = guardianFixture();
        await f.init();
        await f.guardian.receive({ type: "update", sequence: 1, containerId, runtime: "podman", cleanupEnabled: true });
        const ack = deferred();
        const sending = deferred();
        f.ports.send = async message => {
            f.sent.push(message);
            if (message.type === "ack") { sending.resolve(); await ack.promise; }
        };
        const failure = new Error("native release write callback failed");
        const released = f.guardian.receive({ type: "release", sequence: 2 });
        const rejected = expect(released).rejects.toBe(failure);
        await sending.promise;
        const disconnected = f.guardian.disconnect();
        expect(f.finishes()).toBe(0);
        ack.reject(failure);
        await rejected;
        await disconnected;
        expect(f.cleanups).toEqual([[binding, receipt, containerId, "podman"]]);
        expect(f.finishStatuses).toEqual([1]);
    });

    it("failed asynchronous error notification never hides an owned cleanup failure", async () => {
        const f = guardianFixture();
        await f.init();
        await f.guardian.receive({ type: "update", sequence: 1, containerId, runtime: "docker", cleanupEnabled: true });
        const ack = deferred();
        const sending = deferred();
        const cleanupFailure = new Error("owned stop failed");
        f.ports.cleanup = () => { throw cleanupFailure; };
        f.ports.send = async message => {
            if (message.type === "ack") { sending.resolve(); await ack.promise; }
            if (message.type === "error") throw new Error("error notification callback also failed");
        };
        const update = f.guardian.receive({ type: "update", sequence: 2, containerId: secondContainerId, runtime: "docker", cleanupEnabled: true });
        const rejected = expect(update).rejects.toBe(cleanupFailure);
        await sending.promise;
        const disconnected = f.guardian.disconnect();
        ack.reject(new Error("original ACK callback failed"));
        await rejected;
        await disconnected;
        expect(f.finishStatuses).toEqual([1]);
    });

    it("cleanup failure still finishes once and propagates for visible guardian failure", async () => {
        const f = guardianFixture();
        await f.init();
        await f.guardian.receive({ type: "update", sequence: 1, containerId, runtime: "docker", cleanupEnabled: true });
        const failure = new Error("bounded stop failed");
        f.ports.cleanup = () => { throw failure; };
        let caught: unknown;
        try { await f.guardian.disconnect(); } catch (error) { caught = error; }
        expect(caught).toBe(failure);
        expect(f.finishStatuses).toEqual([1]);
        await f.guardian.disconnect();
        expect(f.finishes()).toBe(1);
    });
});
