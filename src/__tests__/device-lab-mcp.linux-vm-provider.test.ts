import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileSymlinkOrSkip } from "./helpers/file-symlink-fixture.js";
import * as nativeFs from "fs";
import * as runtimeIdentity from "../../packages/device-lab/providers/state/process-identity.mjs";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { basename, dirname, join, resolve } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    createLab,
    exportArtifacts,
    guestAgentProvision,
    guestAgentStatus,
    guestExec,
    guestPull,
    guestPush,
    importImage,
    labProviderStatus,
    listImages,
    listLabs,
    listTargets,
    materializeDisk,
    openSession,
    ownerId,
    probeReadiness,
    rebootLab,
    snapshotLab,
    syncWorkspace,
    startLab,
    stopLab,
    deleteLab,
} from "@ccc/device-lab/providers/backends/linux-vm.mjs";
import { ownerId as deviceLabOwnerId } from "@ccc/device-lab/providers/context.mjs";
import { createQemuLifecycleApplication } from "@ccc/device-lab/providers/application/qemu-lifecycle.mjs";
import type { QemuLab, QemuLifecyclePorts } from "@ccc/device-lab/providers/ports/qemu-lifecycle.mjs";

// Compile-only: this function is deliberately never invoked by the runtime suite.
function requiredSynchronousLifecyclePorts(ports: QemuLifecyclePorts) {
    const { removeLabDirectory, ...missingRemoval } = ports;
    // @ts-expect-error removal authority is required
    createQemuLifecycleApplication(missingRemoval);
    // @ts-expect-error publication cannot defer settlement
    createQemuLifecycleApplication({ ...ports, writeLab: async () => undefined });
    // @ts-expect-error allocated directory mutation cannot defer settlement
    createQemuLifecycleApplication({ ...ports, ensureDirectory: async () => undefined });
    // @ts-expect-error deletion cannot defer settlement
    createQemuLifecycleApplication({ ...ports, removeLabDirectory: async () => undefined });
    // @ts-expect-error legacy signal mutation cannot defer settlement
    createQemuLifecycleApplication({ ...ports, legacyKill: async () => undefined });
    // @ts-expect-error launch must settle synchronously
    createQemuLifecycleApplication({ ...ports, launchRunner: () => async () => ({ ok: true }) });
    // @ts-expect-error provision leaves are required and synchronous
    createQemuLifecycleApplication({ ...ports, bindProvisionLeaves: async () => ({}) });
    const { inspectRuntime, ...withoutInspection } = ports;
    // @ts-expect-error owned runtime inspection is required
    createQemuLifecycleApplication(withoutInspection);
    const { waitRuntimeExit, ...withoutExitWait } = ports;
    // @ts-expect-error confirmed exit is required
    createQemuLifecycleApplication(withoutExitWait);
    // @ts-expect-error inspection must settle synchronously
    createQemuLifecycleApplication({ ...ports, inspectRuntime: async () => ({ status: "exited" as const }) });
    // @ts-expect-error exit wait must settle synchronously
    createQemuLifecycleApplication({ ...ports, waitRuntimeExit: async () => ({ exited: true }) });
    return { removeLabDirectory, inspectRuntime, waitRuntimeExit };
}
void requiredSynchronousLifecyclePorts;

vi.mock("fs", async original => ({ ...await original<typeof import("fs")>() }));

vi.mock("../../packages/device-lab/providers/state/process-identity.mjs", async original => ({
    ...await original<typeof import("../../packages/device-lab/providers/state/process-identity.mjs")>(),
}));

// Ordinary provider fixtures report one owned generation and its confirmed exit.
function runtimeExitFixture(pid: number) {
    let exited = false;
    const inspect = runtimeIdentity.inspectProcessIdentity;
    vi.spyOn(runtimeIdentity, "inspectProcessIdentity").mockImplementation((expected, observedPid, options = undefined) => {
        if (observedPid !== pid) return inspect(expected, observedPid, options);
        if (exited) return { status: "exited", current: null, liveness: "exited" };
        return { status: "match", current: { pid, startToken: "fixture-birth", commandHash: "fixture-command" }, liveness: "alive" };
    });
    return { exit: () => { exited = true; } };
}

describe("device-lab Linux VM container-QEMU provider", () => {
    const roots: string[] = [];

    function tempRoot() {
        const root = mkdtempSync(join(tmpdir(), "ccc-lab-mcp-provider-test-"));
        roots.push(root);
        return root;
    }

    it("refuses lab creation and image import where the container cannot run nested VMs", () => {
        const root = tempRoot();
        const env = { CCC_LAB_RUNNER: "1", CCC_LAB_RUNNER_STATUS: "unsupported", CCC_LAB_RUNNER_UNSUPPORTED_REASON: "no nested VMs here" };
        const source = join(root, "..", `${basename(root)}-source.qcow2`);
        writeFileSync(source, "QFI\xfb");
        roots.push(source);

        expect(createLab({ name: "No Nested VMs" }, { env, stateRoot: root })).toEqual({
            ok: false, error: "lab-provider-unsupported", unsupportedReason: "no nested VMs here",
        });
        expect(importImage({ name: "Base", sourcePath: source }, { env, stateRoot: root })).toEqual({
            ok: false, error: "lab-provider-unsupported", unsupportedReason: "no nested VMs here",
        });
        // Nothing is written: without the lab state volume it would land in the container layer.
        expect(existsSync(join(root, "owners"))).toBe(false);
    });

    it("uses the canonical device-lab owner identity", () => {
        const env = { CCC_PROFILE: "linux-vm-owner" };
        expect(ownerId(env)).toBe(deviceLabOwnerId(env));
    });

    it("refuses forced deletion when the recorded runtime process identity is unverified", () => {
        const root = tempRoot();
        const env = { CCC_PROFILE: "unverified-runtime-delete" };
        const created = createLab({ name: "Unverified Runtime Delete" }, { env, stateRoot: root });
        const createdLab = created.lab;
        assert.ok(createdLab);
        expect(created.ok).toBe(true);
        const metadata = join(root, "owners", ownerId(env), "labs", createdLab.id, "lab.json");
        writeFileSync(metadata, `${JSON.stringify({
            ...JSON.parse(readFileSync(metadata, "utf-8")),
            runtimeState: "running",
            runtime: { pid: process.pid, processIdentity: null },
        }, null, 2)}\n`);

        const deleted = deleteLab({ labId: createdLab.id, force: true }, { env, stateRoot: root });
        expect(deleted).toEqual(expect.objectContaining({
            ok: false,
            error: "lab-delete-stop-failed",
            stop: expect.objectContaining({ error: "lab-stop-process-identity-unverified" }),
        }));
        expect(existsSync(metadata)).toBe(true);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    });

    it("keeps legacy stop ESRCH handling and failed forced-delete residue", () => {
        const root = tempRoot(), env = { CCC_PROFILE: "stop-fault", CCC_LAB_RUNNER: "1", CCC_LAB_RUNNER_STATUS: "ready" };
        const created = createLab({ name: "Stop Fault" }, { env, stateRoot: root });
        const createdLab = created.lab;
        assert.ok(createdLab);
        startLab({ labId: createdLab.id }, { env, stateRoot: root, qemuPath: "/usr/bin/qemu-system-x86_64", kvmAvailable: true, commandRunner: () => ({ ok: true, pid: 4242, processIdentity: { pid: 4242, startToken: "fixture-birth", commandHash: "fixture-command" } }) });
        const file = join(createdLab.paths.labDir, "lab.json"), before = readFileSync(file, "utf8");
        const trace: unknown[] = [], fault = Object.assign(new Error("raw legacy stop"), { code: "EPERM" });
        const runtime = runtimeExitFixture(4242);
        const killProcess = (pid: number) => { trace.push(pid); throw fault; };
        const options = { env, stateRoot: root, killProcess };
        expect(deleteLab({ labId: createdLab.id, force: "true" }, options)).toEqual({ ok: false, error: "lab-running", labId: createdLab.id });
        expect(trace).toEqual([]);
        expect(deleteLab({ labId: createdLab.id, force: true }, options)).toEqual({
            ok: false, error: "lab-delete-stop-failed", labId: createdLab.id,
            stop: { ok: false, error: "lab-stop-failed", message: "raw legacy stop" },
        });
        expect(trace).toEqual([4242]);
        expect(readFileSync(file, "utf8")).toBe(before);
        const exited = Object.assign(new Error("already exited"), { code: "ESRCH" });
        expect(stopLab({ labId: createdLab.id }, { env, stateRoot: root, killProcess: () => { runtime.exit(); throw exited; } })).toEqual(
            expect.objectContaining({ ok: true, stopped: true, lab: expect.objectContaining({ runtimeState: "stopped", runtime: null }) }),
        );
        expect(stopLab({ labId: createdLab.id }, { env, stateRoot: root, killProcess: () => { throw new Error("must not signal twice"); } }).stopped).toBe(false);
        expect(deleteLab({ labId: createdLab.id }, { env, stateRoot: root }).deleted).toBe(true);
        expect(existsSync(createdLab.paths.labDir)).toBe(false);
    });

    it("publishes stopped state before a raw application removal fault", () => {
        const root = tempRoot(), env = { CCC_PROFILE: "remove-fault" };
        const created = createLab({ name: "Remove Fault" }, { env, stateRoot: root });
        const createdLab = created.lab;
        assert.ok(createdLab);
        const lab = { ...createdLab, runtimeState: "running", runtime: { pid: 4242, processIdentity: { pid: 4242, startToken: "fixture-birth", commandHash: "fixture-command" } } };
        const scope = { env, stateRoot: root, owner: ownerId(env), ownerRoot: join(root, "owners", ownerId(env)) };
        const trace: unknown[] = [], fault = new Error("raw removal fault");
        const unexpected = (): never => { throw new Error("unreached leaf"); };
        let retained: QemuLab = lab;
        const ports: QemuLifecyclePorts = {
            providerName: "container-qemu", scope: () => scope,
            readLab: () => { trace.push("read"); return { ok: true, lab: retained }; },
            inspectRuntime: () => ({ status: "match" }),
            waitRuntimeExit: () => { trace.push("exit-confirmed"); return { exited: true }; },
            legacyKillAvailable: () => true,
            legacyKill: (pid) => { trace.push(["kill", pid]); return undefined; },
            clock: () => { trace.push("clock"); return "stopped-time"; },
            writeLab: (_scope, next) => { trace.push("publish"); retained = next; return undefined; },
            removeLabDirectory: () => { trace.push("remove"); throw fault; },
            runnerUnavailable: unexpected, metadataExists: unexpected, labDirectory: unexpected,
            allocatedPath: unexpected, ensureDirectory: unexpected, resolveBaseImage: unexpected,
            boundedSource: unexpected, resolveSshKey: unexpected, validateDisk: unexpected,
            diskExists: unexpected, imageDiskTargetApplication: unexpected, providerStatus: unexpected,
            launchRunner: unexpected, runtimeId: unexpected, signalRuntime: unexpected, bindProvisionLeaves: unexpected,
        };
        const application = createQemuLifecycleApplication(ports);
        expect(trace).toEqual([]);
        let caught: unknown;
        try { application.delete({ labId: lab.id, force: true }); } catch (error) { caught = error; }
        expect(caught).toBe(fault);
        expect(trace.filter(row => Array.isArray(row) ? row[0] === "kill" : ["exit-confirmed", "publish", "remove"].includes(String(row))))
            .toEqual([["kill", 4242], "exit-confirmed", "publish", "remove"]);
        expect(retained).toEqual(expect.objectContaining({ runtimeState: "stopped", runtime: null, updatedAt: "stopped-time" }));
        expect(existsSync(createdLab.paths.labDir)).toBe(true);
    });

    it("rejects strict force create when running metadata has no verified exit", () => {
        const root = tempRoot(), env = { CCC_PROFILE: "create-force", CCC_LAB_RUNNER: "1", CCC_LAB_RUNNER_STATUS: "ready" };
        const created = createLab({ name: "Original", labId: "same" }, { env, stateRoot: root });
        const createdLab = created.lab;
        assert.ok(createdLab);
        startLab({ labId: "same" }, { env, stateRoot: root, qemuPath: "/usr/bin/qemu-system-x86_64", kvmAvailable: true, commandRunner: () => ({ ok: true, pid: 4242, processIdentity: { pid: 4242, startToken: "fixture-birth", commandHash: "fixture-command" } }) });
        const file = join(createdLab.paths.labDir, "lab.json"), before = readFileSync(file, "utf8"), trace: unknown[] = [];
        const options = { env, stateRoot: root, killProcess: (pid: number) => { trace.push(pid); } };
        for (const force of [undefined, "true", 1]) {
            expect(createLab({ name: "Replacement", labId: "same", force }, options)).toEqual({ ok: false, error: "lab-already-exists", labId: "same" });
            expect(readFileSync(file, "utf8")).toBe(before);
        }
        runtimeExitFixture(4242);
        const overwritten = createLab({ name: "Replacement", labId: "same", force: true }, options);
        expect(overwritten).toEqual(expect.objectContaining({ ok: false, error: "lab-runtime-active-or-unverified", labId: "same" }));
        expect(readFileSync(file, "utf8")).toBe(before);
        expect(trace).toEqual([]);
    });

    it("retains native stopped metadata when forced delete removal throws the identical fault", () => {
        const root = tempRoot(), env = { CCC_PROFILE: "native-remove", CCC_LAB_RUNNER: "1", CCC_LAB_RUNNER_STATUS: "ready" };
        const created = createLab({ name: "Native Remove" }, { env, stateRoot: root });
        const createdLab = created.lab;
        assert.ok(createdLab);
        startLab({ labId: createdLab.id }, { env, stateRoot: root, qemuPath: "/usr/bin/qemu-system-x86_64", kvmAvailable: true, commandRunner: () => ({ ok: true, pid: 4242, processIdentity: { pid: 4242, startToken: "fixture-birth", commandHash: "fixture-command" } }) });
        const file = join(createdLab.paths.labDir, "lab.json"), fault = new Error("native removal fault"), trace: unknown[] = [];
        const runtime = runtimeExitFixture(4242);
        const originalRemove = nativeFs.rmSync;
        const removal = vi.spyOn(nativeFs, "rmSync").mockImplementation((path, options) => {
            if (path === createdLab.paths.labDir) {
                trace.push(["remove", JSON.parse(readFileSync(file, "utf8")).runtimeState]);
                throw fault;
            }
            return originalRemove(path, options);
        });
        let caught: unknown;
        try {
            deleteLab({ labId: createdLab.id, force: true }, { env, stateRoot: root, killProcess: (pid: number) => { trace.push(["kill", pid]); runtime.exit(); } });
        } catch (error) { caught = error; } finally { removal.mockRestore(); }
        expect(caught).toBe(fault);
        expect(trace).toEqual([["kill", 4242], ["remove", "stopped"]]);
        expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(expect.objectContaining({ runtimeState: "stopped", runtime: null }));
        expect(existsSync(createdLab.paths.labDir)).toBe(true);
    });

    it.skipIf(process.platform !== "linux")("stops its same-parent native child synchronously before deleting owned storage", async () => {
        const root = tempRoot(), env = { CCC_PROFILE: "native-child-stop", CCC_LAB_RUNNER: "1", CCC_LAB_RUNNER_STATUS: "ready" };
        const created = createLab({ name: "Native Child Stop" }, { env, stateRoot: root });
        const createdLab = created.lab;
        assert.ok(createdLab);
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        const closed = new Promise<void>((resolve, reject) => { child.once("close", () => resolve());child.once("error", reject); });
        let joinTimer: ReturnType<typeof setTimeout> | undefined;
        try {
            const identity = await runtimeIdentity.waitForProcessIdentity(child.pid, 2000);
            expect(identity).toBeTruthy();
            expect(startLab({ labId: createdLab.id }, { env, stateRoot: root, qemuPath: "/usr/bin/qemu-system-x86_64", kvmAvailable: true,
                commandRunner: () => ({ ok: true, pid: child.pid, processIdentity: identity }) }).ok).toBe(true);
            expect(stopLab({ labId: createdLab.id, timeoutMs: 2000 }, { env, stateRoot: root })).toEqual(expect.objectContaining({ ok: true, stopped: true, lab: expect.objectContaining({ runtimeState: "stopped", runtime: null }) }));
            expect(JSON.parse(readFileSync(join(createdLab.paths.labDir, "lab.json"), "utf8"))).toEqual(expect.objectContaining({ runtimeState: "stopped", runtime: null }));
            expect(deleteLab({ labId: createdLab.id }, { env, stateRoot: root }).deleted).toBe(true);
            expect(existsSync(createdLab.paths.labDir)).toBe(false);
        } finally {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            try { await Promise.race([closed, new Promise<never>((_resolve, reject) => { joinTimer = setTimeout(() => reject(new Error("owned QEMU test child join timed out")), 2000); })]); }
            finally { if (joinTimer) clearTimeout(joinTimer); }
        }
    });

    it("preserves a live owned runtime after a signal timeout and refuses forced storage removal", () => {
        const root = tempRoot(), env = { CCC_PROFILE: "live-runtime", CCC_LAB_RUNNER: "1", CCC_LAB_RUNNER_STATUS: "ready" };
        const created = createLab({ name: "Live Runtime" }, { env, stateRoot: root });
        const createdLab = created.lab;
        assert.ok(createdLab);
        startLab({ labId: createdLab.id }, { env, stateRoot: root, qemuPath: "/usr/bin/qemu-system-x86_64", kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: process.pid, processIdentity: runtimeIdentity.readProcessIdentity(process.pid) }) });
        const file = join(createdLab.paths.labDir, "lab.json"), before = readFileSync(file, "utf8"), signals: number[] = [];
        const options = { env, stateRoot: root, killProcess: (pid: number) => { signals.push(pid); } };
        expect(stopLab({ labId: createdLab.id, timeoutMs: 1 }, options)).toEqual(expect.objectContaining({ ok: false, error: "lab-stop-runtime-not-exited" }));
        expect(readFileSync(file, "utf8")).toBe(before);
        expect(deleteLab({ labId: createdLab.id, force: true, timeoutMs: 1 }, options)).toEqual(expect.objectContaining({ ok: false, error: "lab-delete-stop-failed" }));
        expect(readFileSync(file, "utf8")).toBe(before);expect(existsSync(createdLab.paths.labDir)).toBe(true);
        expect(createLab({ name: "Replacement", labId: createdLab.id, force: true }, options)).toEqual(expect.objectContaining({ ok: false, error: "lab-runtime-active-or-unverified" }));
        expect(readFileSync(file, "utf8")).toBe(before);expect(signals).toEqual([process.pid, process.pid]);
        const falseExit = Object.assign(new Error("false exit assertion"), { code: "ESRCH" });
        expect(stopLab({ labId: createdLab.id, timeoutMs: 1 }, { env, stateRoot: root, killProcess: () => { throw falseExit; } })).toEqual(expect.objectContaining({ ok: false, error: "lab-stop-runtime-not-exited" }));
        expect(readFileSync(file, "utf8")).toBe(before);
    });

    it("refuses reused and unverified native process generations before a kill override or overwrite", () => {
        const root = tempRoot(), env = { CCC_PROFILE: "reused-runtime" };
        const created = createLab({ name: "Reused Runtime" }, { env, stateRoot: root });
        const createdLab = created.lab;
        assert.ok(createdLab);
        const file = join(createdLab.paths.labDir, "lab.json"), stopped = JSON.parse(readFileSync(file, "utf8"));
        for (const processIdentity of [null, { ...runtimeIdentity.readProcessIdentity(process.pid), startToken: "wrong-birth" }]) {
            writeFileSync(file, JSON.stringify({ ...stopped, runtimeState: "running", runtime: { runtimeId: "owned", pid: process.pid, processIdentity } }));
            const before = readFileSync(file, "utf8"), kill = vi.fn();
            const options = { env, stateRoot: root, killProcess: kill };
            expect(stopLab({ labId: createdLab.id }, options)).toEqual(expect.objectContaining({ ok: false, error: "lab-stop-process-identity-unverified" }));
            expect(deleteLab({ labId: createdLab.id, force: true }, options).ok).toBe(false);
            expect(createLab({ name: "Replacement", labId: createdLab.id, force: true }, options).ok).toBe(false);
            expect(kill).not.toHaveBeenCalled();expect(readFileSync(file, "utf8")).toBe(before);
        }
    });

    it("waits for a delayed native exit before publishing stopped metadata", () => {
        const root = tempRoot(), env = { CCC_PROFILE: "delayed-runtime", CCC_LAB_RUNNER: "1", CCC_LAB_RUNNER_STATUS: "ready" };
        const created = createLab({ name: "Delayed Runtime" }, { env, stateRoot: root });
        const createdLab = created.lab;
        assert.ok(createdLab);
        startLab({ labId: createdLab.id }, { env, stateRoot: root, qemuPath: "/usr/bin/qemu-system-x86_64", kvmAvailable: true, commandRunner: () => ({ ok: true, pid: 4242, processIdentity: { pid: 4242, startToken: "fixture-birth", commandHash: "fixture-command" } }) });
        const file = join(createdLab.paths.labDir, "lab.json"), before = readFileSync(file, "utf8");
        let signaled = false, polls = 0;
        vi.spyOn(runtimeIdentity, "inspectProcessIdentity").mockImplementation(() => {
            if (signaled) { polls++;expect(readFileSync(file, "utf8")).toBe(before); }
            if (signaled && polls >= 3) return { status: "exited", current: null, liveness: "exited" };
            return { status: "match", current: { pid: 4242, startToken: "fixture-birth", commandHash: "fixture-command" }, liveness: "alive" };
        });
        expect(stopLab({ labId: createdLab.id, timeoutMs: 1000 }, { env, stateRoot: root, killProcess: () => { signaled = true; } })).toEqual(expect.objectContaining({ ok: true, stopped: true }));
        expect(polls).toBe(3);expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(expect.objectContaining({ runtimeState: "stopped", runtime: null }));
    });

    it("reports unsupported outside the lab-runner profile without requiring user configuration", () => {
        const root = tempRoot();
        const status = labProviderStatus({
            env: {},
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            qemuImgPath: "/usr/bin/qemu-img",
            kvmAvailable: true,
        });

        expect(status).toEqual(expect.objectContaining({
            ok: true,
            provider: "container-qemu",
            available: false,
            status: "unsupported",
            unsupportedReason: "CCC_LAB_RUNNER is not enabled for this container",
            stateRoot: root,
            networkMode: "user",
        }));
    });

    it("reports lab-runner VM networking diagnostics without host TUN exposure", () => {
        const root = tempRoot();
        const status = labProviderStatus({
            env: {
                CCC_LAB_RUNNER: "1",
                CCC_LAB_RUNNER_STATUS: "ready",
                CCC_LAB_NET_MODE: "user",
            },
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            qemuImgPath: "/usr/bin/qemu-img",
            kvmAvailable: true,
        });

        expect(status).toEqual(expect.objectContaining({
            ok: true,
            available: true,
            status: "ready",
            networkMode: "user",
        }));
        expect(status).not.toHaveProperty("tunPath");
    });

    it("creates and lists owner-scoped named labs under the lab state root", () => {
        const root = tempRoot();
        const env = { CCC_PROFILE: "test" };
        const created = createLab({
            name: "Ubuntu Test",
            sourceImage: "images/base.qcow2",
            memoryMb: 4096,
            cpus: 4,
        }, { env, stateRoot: root, now: "2026-06-16T00:00:00.000Z" });
        const createdLab = created.lab;
        assert.ok(createdLab);

        expect(created.ok).toBe(true);
        expect(createdLab).toEqual(expect.objectContaining({
            id: "ubuntu-test",
            ownerId: ownerId(env),
            runtimeState: "stopped",
            resources: { memoryMb: 4096, cpus: 4 },
        }));
        expect(createdLab.image.sourceImage).toBe(join(root, "images/base.qcow2"));
        expect(existsSync(join(root, "owners", ownerId(env), "labs", "ubuntu-test", "lab.json"))).toBe(true);

        const listed = listLabs({ env, stateRoot: root });
        expect(listed.labs.map((lab) => lab.id)).toEqual(["ubuntu-test"]);
    });

    it("imports owner-scoped base images and creates labs from catalog ids", () => {
        const root = tempRoot();
        const env = { CCC_PROFILE: "images" };
        mkdirSync(join(root, "incoming"), { recursive: true });
        writeFileSync(join(root, "incoming", "ubuntu.qcow2"), "base-image");

        const imported = importImage({
            name: "Ubuntu Base",
            sourcePath: "incoming/ubuntu.qcow2",
        }, {
            env,
            stateRoot: root,
            now: "2026-06-16T04:00:00.000Z",
        });
        const importedImage = imported.image;
        assert.ok(importedImage && typeof importedImage === "object");
        assert.ok("path" in importedImage && typeof importedImage.path === "string");
        const importedImagePath = importedImage.path;

        expect(imported).toEqual(expect.objectContaining({
            ok: true,
            image: expect.objectContaining({
                id: "ubuntu-base",
                format: "qcow2",
                copied: true,
                sizeBytes: 10,
            }),
        }));
        expect(importedImagePath).toBe(join(root, "owners", ownerId(env), "images", "ubuntu-base", "base.qcow2"));
        expect(readFileSync(importedImagePath, "utf8")).toBe("base-image");
        expect(listImages({ env, stateRoot: root }).images).toEqual([
            expect.objectContaining({ id: "ubuntu-base", path: importedImagePath }),
        ]);

        const lab = createLab({ name: "From Base", baseImageId: "ubuntu-base" }, { env, stateRoot: root });
        expect(lab).toEqual(expect.objectContaining({
            ok: true,
            lab: expect.objectContaining({
                id: "from-base",
                image: expect.objectContaining({
                    baseImageId: "ubuntu-base",
                    sourceImage: importedImagePath,
                    format: "qcow2",
                }),
            }),
        }));
    });

    it("keeps strict force/copy decisions and earlier format files on overwrite", () => {
        const root = tempRoot(), env = { CCC_PROFILE: "import-overwrite" };
        mkdirSync(join(root, "incoming"));
        writeFileSync(join(root, "incoming", "disk.qcow2"), "old-image");
        writeFileSync(join(root, "incoming", "disk.raw"), "new-image");
        const options = { env, stateRoot: root, now: "fixed-time" };
        const first = importImage({ name: "Base", sourcePath: "incoming/disk.qcow2", copy: 0 }, options);
        const firstImage = first.image;
        assert.ok(firstImage && typeof firstImage === "object");
        assert.ok("path" in firstImage && typeof firstImage.path === "string");
        const firstImagePath = firstImage.path;
        assert.ok("copied" in firstImage);
        expect(firstImage.copied).toBe(true);
        const refused = importImage({ name: "Base", force: "true", sourcePath: "incoming/disk.raw" }, options);
        expect(refused).toEqual({ ok: false, error: "base-image-already-exists", imageId: "base" });
        const replaced = importImage({ name: "Base", sourcePath: "incoming/disk.raw", force: true }, options);
        const replacedImage = replaced.image;
        assert.ok(replacedImage && typeof replacedImage === "object");
        assert.ok("path" in replacedImage && typeof replacedImage.path === "string");
        const replacedImagePath = replacedImage.path;
        expect(replaced.image).toEqual(expect.objectContaining({ copied: true, format: "raw", sizeBytes: 9, createdAt: "fixed-time", updatedAt: "fixed-time" }));
        expect(readFileSync(firstImagePath, "utf8")).toBe("old-image");
        expect(readFileSync(replacedImagePath, "utf8")).toBe("new-image");
        const reference = importImage({ name: "Reference", sourcePath: "incoming/disk.raw", copy: false }, options);
        const referenceImage = reference.image;
        assert.ok(referenceImage && typeof referenceImage === "object");
        assert.ok("path" in referenceImage && typeof referenceImage.path === "string");
        const referenceImagePath = referenceImage.path;
        expect(reference.image).toEqual(expect.objectContaining({ copied: false, path: join(root, "incoming", "disk.raw"), sourcePath: join(root, "incoming", "disk.raw"), format: "raw" }));
        expect(readdirSync(dirname(referenceImagePath))).toEqual(expect.arrayContaining(["disk.qcow2", "disk.raw"]));
    });

    it("preserves copy residue before atomic publication cleanup", () => {
        const root = tempRoot(), env = { CCC_PROFILE: "import-faults" };
        mkdirSync(join(root, "incoming"));
        writeFileSync(join(root, "incoming", "disk.raw"), "retained-copy");
        const publicationFault = new Error("raw serialization fault");
        const clock = { toJSON() { throw publicationFault; } };
        let caught: unknown;
        try { importImage({ name: "Failed", sourcePath: "incoming/disk.raw" }, { env, stateRoot: root, now: clock }); }
        catch (error) { caught = error; }
        expect(caught).toBe(publicationFault);
        const imageDir = join(root, "owners", ownerId(env), "images", "failed");
        expect(readFileSync(join(imageDir, "base.raw"), "utf8")).toBe("retained-copy");
        expect(readdirSync(imageDir)).toEqual(["base.raw"]);

        const blocked = join(root, "owners", ownerId(env), "images", "blocked");
        mkdirSync(join(blocked, "base.raw"), { recursive: true });
        expect(() => importImage({ name: "Blocked", sourcePath: "incoming/disk.raw" }, {
            env, stateRoot: root, now: "never",
        })).toThrow();
        expect(readdirSync(blocked)).toEqual(["base.raw"]);

        const renameBlocked = join(root, "owners", ownerId(env), "images", "rename-blocked");
        mkdirSync(join(renameBlocked, "image.json"), { recursive: true });
        expect(() => importImage({ name: "Rename Blocked", sourcePath: "incoming/disk.raw", force: true }, { env, stateRoot: root })).toThrow();
        // Publication's finally removes its temporary metadata without rolling back the copy.
        expect(readdirSync(renameBlocked).sort()).toEqual(["base.raw", "image.json"]);
        expect(readFileSync(join(renameBlocked, "base.raw"), "utf8")).toBe("retained-copy");
    });

    it("registers in-state base images without copying and validates image sources", () => {
        const root = tempRoot();
        const env = { CCC_PROFILE: "image-policy" };
        mkdirSync(join(root, "incoming"), { recursive: true });
        const raw = join(root, "incoming", "disk.raw");
        writeFileSync(raw, "raw-image");

        const registered = importImage({
            name: "Raw Base",
            imageId: "raw-base",
            sourcePath: "incoming/disk.raw",
            copy: false,
        }, { env, stateRoot: root });
        expect(registered).toEqual(expect.objectContaining({
            ok: true,
            image: expect.objectContaining({ id: "raw-base", path: raw, copied: false, format: "raw" }),
        }));

        expect(importImage({ name: "Outside", sourcePath: "/tmp/outside.qcow2" }, { env, stateRoot: root })).toEqual({
            ok: false,
            error: "source-image-outside-lab-state-root",
        });
        const otherEnv = { CCC_PROFILE: "other-owner" };
        const otherOwnerPath = join(root, "owners", ownerId(otherEnv), "images", "other.qcow2");
        mkdirSync(join(root, "owners", ownerId(otherEnv), "images"), { recursive: true });
        writeFileSync(otherOwnerPath, "other");
        expect(importImage({ name: "Other Owner", sourcePath: otherOwnerPath }, { env, stateRoot: root })).toEqual({
            ok: false,
            error: "source-image-outside-owner-scope",
            sourcePath: otherOwnerPath,
        });
        expect(importImage({ name: "Missing Parent", sourcePath: "missing/base.qcow2" }, { env, stateRoot: root })).toEqual(expect.objectContaining({
            ok: false,
            error: "source-image-not-found",
        }));
        writeFileSync(join(root, "incoming", "file-parent"), "not a directory");
        expect(importImage({ name: "File Parent", sourcePath: "incoming/file-parent/base.qcow2" }, { env, stateRoot: root })).toEqual(expect.objectContaining({
            ok: false,
            error: "source-image-ancestor-not-directory",
        }));
        const outsideDir = mkdtempSync(join(tmpdir(), "ccc-lab-outside-images-"));
        roots.push(outsideDir);
        writeFileSync(join(outsideDir, "parent-link.qcow2"), "outside");
        symlinkSync(outsideDir, join(root, "incoming", "outside-link"), process.platform === "win32" ? "junction" : "dir");
        expect(importImage({ name: "Parent Link", sourcePath: "incoming/outside-link/parent-link.qcow2" }, { env, stateRoot: root })).toEqual(expect.objectContaining({
            ok: false,
            error: "source-image-symlink-ancestor-rejected",
        }));
        mkdirSync(join(root, "incoming", "dir.qcow2"));
        expect(importImage({ name: "Directory", sourcePath: "incoming/dir.qcow2" }, { env, stateRoot: root })).toEqual(expect.objectContaining({
            ok: false,
            error: "source-image-not-file",
        }));
        expect(importImage({ name: "Bad Format", sourcePath: "incoming/disk.raw", format: "vmdk" }, { env, stateRoot: root })).toEqual({
            ok: false,
            error: "unsupported-image-format",
            format: "vmdk",
        });
        writeFileSync(join(root, "incoming", "disk.vmdk"), "vmdk");
        expect(importImage({ name: "Implicit Bad Format", sourcePath: "incoming/disk.vmdk" }, { env, stateRoot: root })).toEqual({
            ok: false,
            error: "unsupported-image-format",
            format: undefined,
        });
        expect(importImage({ name: "Raw Base", imageId: "raw-base", sourcePath: "incoming/disk.raw" }, { env, stateRoot: root })).toEqual({
            ok: false,
            error: "base-image-already-exists",
            imageId: "raw-base",
        });
        expect(importImage({ name: "Dot Dot", imageId: "..", sourcePath: "incoming/disk.raw" }, { env, stateRoot: root })).toEqual({
            ok: false,
            error: "invalid-image-id",
        });
    });

    it("rejects source images outside the lab state root", () => {
        const root = tempRoot();
        const result = createLab({ name: "Bad Image", sourceImage: "/tmp/base.qcow2" }, { env: {}, stateRoot: root });
        expect(result).toEqual({ ok: false, error: "source-image-outside-lab-state-root" });
    });

    it("rejects missing base image ids and ambiguous lab image sources", () => {
        const root = tempRoot();
        const env = { CCC_PROFILE: "lab-image-policy" };
        expect(createLab({ name: "Missing Base", baseImageId: "missing" }, { env, stateRoot: root })).toEqual({
            ok: false,
            error: "base-image-not-found",
            imageId: "missing",
        });
        expect(createLab({ name: "Ambiguous", baseImageId: "base", sourceImage: "images/base.qcow2" }, { env, stateRoot: root })).toEqual({
            ok: false,
            error: "ambiguous-source-image",
        });
        expect(createLab({ name: "Dot Dot Base", baseImageId: ".." }, { env, stateRoot: root })).toEqual({
            ok: false,
            error: "invalid-image-id",
        });
        expect(createLab({ name: "Dot Lab", labId: "." }, { env, stateRoot: root })).toEqual({
            ok: false,
            error: "invalid-lab-id",
        });
    });

    it("rejects a linked image source", (context) => {
        const root = tempRoot(), env = { CCC_PROFILE: "image-link" };
        mkdirSync(join(root, "incoming"), { recursive: true });
        const raw = join(root, "incoming", "disk.raw");
        writeFileSync(raw, "raw-image");
        fileSymlinkOrSkip(context, raw, join(root, "incoming", "link.qcow2"));
        expect(importImage({ name: "Link", sourcePath: "incoming/link.qcow2" }, { env, stateRoot: root })).toEqual(expect.objectContaining({
            ok: false,
            error: "source-image-symlink-rejected",
        }));
    });

    it("rejects a catalog backing file replaced with a link", (context) => {
        const root = tempRoot(), env = { CCC_PROFILE: "image-revalidate-link" };
        mkdirSync(join(root, "incoming"), { recursive: true });
        const source = join(root, "incoming", "base.qcow2");
        writeFileSync(source, "base");
        expect(importImage({ name: "Base", sourcePath: "incoming/base.qcow2", copy: false }, { env, stateRoot: root }).ok).toBe(true);
        rmSync(source);
        fileSymlinkOrSkip(context, join(root, "outside.qcow2"), source);
        expect(createLab({ name: "From Stale Base", baseImageId: "base" }, { env, stateRoot: root })).toEqual(expect.objectContaining({
            ok: false,
            error: "base-image-symlink-rejected",
        }));
        rmSync(source);
    });

    it("revalidates catalog backing files before creating labs from base images", () => {
        const root = tempRoot();
        const env = { CCC_PROFILE: "image-revalidate" };
        mkdirSync(join(root, "incoming"), { recursive: true });
        const source = join(root, "incoming", "base.qcow2");
        writeFileSync(source, "base");
        const imported = importImage({ name: "Base", sourcePath: "incoming/base.qcow2", copy: false }, { env, stateRoot: root });
        expect(imported.ok).toBe(true);

        rmSync(source);
        rmSync(join(root, "incoming"), { recursive: true, force: true });
        expect(createLab({ name: "From Missing Parent", baseImageId: "base" }, { env, stateRoot: root })).toEqual(expect.objectContaining({
            ok: false,
            error: "base-image-not-found",
        }));
        mkdirSync(join(root, "incoming"), { recursive: true });
        writeFileSync(join(root, "incoming", "file-parent"), "not a directory");
        const metadataPath = join(root, "owners", ownerId(env), "images", "base", "image.json");
        const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
        writeFileSync(metadataPath, `${JSON.stringify({ ...metadata, path: join(root, "incoming", "file-parent", "base.qcow2") }, null, 2)}\n`);
        expect(createLab({ name: "From File Parent", baseImageId: "base" }, { env, stateRoot: root })).toEqual(expect.objectContaining({
            ok: false,
            error: "base-image-ancestor-not-directory",
        }));
    });

    it("plans, starts, stops, and deletes a lab only when lab-runner is ready", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "ready",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        mkdirSync(join(root, "images"), { recursive: true });
        writeFileSync(join(root, "images", "ready.qcow2"), "base");
        const created = createLab({ name: "Ready VM", sourceImage: "images/ready.qcow2" }, { env, stateRoot: root });
        const createdLab = created.lab;
        assert.ok(createdLab);
        expect(created.ok).toBe(true);

        const dryRun = startLab({ labId: "ready-vm", dryRun: true }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            qemuImgPath: "/usr/bin/qemu-img",
            kvmAvailable: true,
        });
        expect(dryRun).toEqual(expect.objectContaining({
            ok: true,
            dryRun: true,
            command: "/usr/bin/qemu-system-x86_64",
            materialized: expect.objectContaining({ ok: true, dryRun: true }),
            args: expect.arrayContaining(["-machine", "q35,accel=kvm:tcg", `file=${createdLab.image.diskImage},if=virtio,format=qcow2`]),
        }));
        expect(JSON.stringify(dryRun)).not.toContain("qemu-monitor.sock");

        const calls: unknown[] = [];
        const started = startLab({ labId: "ready-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            qemuImgPath: "/usr/bin/qemu-img",
            kvmAvailable: true,
            commandRunner: (command: string, args: string[]) => {
                calls.push({ command, args });
                if (command.endsWith("qemu-img")) {
                    writeFileSync(args[args.length - 1], "overlay");
                    return { ok: true, command, args };
                }
                return { ok: true, pid: 4242, processIdentity: { pid: 4242, startToken: "fixture-birth", commandHash: "fixture-command" }, command, args };
            },
        });
        const startedLab = started.lab;
        assert.ok(startedLab);
        assert.ok(startedLab.runtime);
        expect(started.ok).toBe(true);
        expect(startedLab.runtimeState).toBe("running");
        expect(startedLab.runtime.pid).toBe(4242);
        const reused = startLab({ labId: "ready-vm" }, {
            env, stateRoot: root, qemuPath: "/usr/bin/qemu-system-x86_64", kvmAvailable: true,
            commandRunner: () => { throw new Error("running reuse must not launch"); },
        });
        expect(reused).toEqual(expect.objectContaining({ ok: true, reused: true, lab: expect.objectContaining({ runtimeState: "running", runtime: expect.objectContaining({ pid: 4242 }) }) }));
        expect(JSON.stringify(started)).not.toContain("qemu-monitor.sock");
        expect(started.materialized).toEqual(expect.objectContaining({ ok: true, materialized: true }));
        expect(calls).toHaveLength(2);
        expect(calls[0]).toEqual(expect.objectContaining({
            command: "/usr/bin/qemu-img",
            args: expect.arrayContaining(["create", "-f", "qcow2"]),
        }));
        expect(calls[1]).toEqual(expect.objectContaining({
            command: "/usr/bin/qemu-system-x86_64",
            args: expect.arrayContaining([expect.stringContaining(join("ready-vm", "disks", "root.qcow2"))]),
        }));

        const killed: number[] = [];
        const runtime = runtimeExitFixture(4242);
        const stopped = stopLab({ labId: "ready-vm" }, {
            env,
            stateRoot: root,
            killProcess: (pid: number) => { killed.push(pid); runtime.exit(); },
        });
        const stoppedLab = stopped.lab;
        assert.ok(stoppedLab);
        expect(stopped.ok).toBe(true);
        expect(killed).toEqual([4242]);
        expect(stoppedLab.runtimeState).toBe("stopped");

        const deleted = deleteLab({ labId: "ready-vm" }, { env, stateRoot: root });
        expect(deleted).toEqual(expect.objectContaining({ ok: true, labId: "ready-vm", deleted: true }));
        expect(listLabs({ env, stateRoot: root }).labs).toEqual([]);
    });

    it("materializes owner-scoped qcow2 overlay disks with qemu-img", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "materialize",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        mkdirSync(join(root, "images"), { recursive: true });
        writeFileSync(join(root, "images", "base.qcow2"), "base");
        const created = createLab({ name: "Materialize VM", sourceImage: "images/base.qcow2" }, { env, stateRoot: root });
        const createdLab = created.lab;
        assert.ok(createdLab);
        expect(created.ok).toBe(true);

        const commands: Array<{ command: string; args: string[] }> = [];
        const dryRun = materializeDisk({ labId: "materialize-vm", dryRun: true }, {
            env,
            stateRoot: root,
            qemuImgPath: "/usr/bin/qemu-img",
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
        });
        expect(dryRun).toEqual(expect.objectContaining({
            ok: true,
            dryRun: true,
            plan: expect.objectContaining({
                command: "/usr/bin/qemu-img",
                args: ["create", "-f", "qcow2", "-F", "qcow2", "-b", join(root, "images", "base.qcow2"), createdLab.image.diskImage],
            }),
        }));
        const startDryRun = startLab({ labId: "materialize-vm", dryRun: true }, {
            env,
            stateRoot: root,
            qemuImgPath: "/usr/bin/qemu-img",
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
        });
        expect(startDryRun).toEqual(expect.objectContaining({
            ok: true,
            dryRun: true,
            materialized: expect.objectContaining({
                ok: true,
                dryRun: true,
                diskImage: createdLab.image.diskImage,
            }),
            args: expect.arrayContaining([`file=${createdLab.image.diskImage},if=virtio,format=qcow2`]),
        }));

        const materialized = materializeDisk({ labId: "materialize-vm" }, {
            env,
            stateRoot: root,
            qemuImgPath: "/usr/bin/qemu-img",
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: (command: string, args: string[]) => {
                commands.push({ command, args });
                writeFileSync(args[args.length - 1], "overlay");
                return { ok: true, command, args };
            },
            now: "2026-06-16T05:00:00.000Z",
        });
        expect(materialized).toEqual(expect.objectContaining({
            ok: true,
            materialized: true,
            disk: expect.objectContaining({
                kind: "qcow2-overlay",
                backingFormat: "qcow2",
                backingPath: join(root, "images", "base.qcow2"),
            }),
        }));
        expect(commands).toEqual([
            { command: "/usr/bin/qemu-img", args: ["create", "-f", "qcow2", "-F", "qcow2", "-b", join(root, "images", "base.qcow2"), createdLab.image.diskImage] },
        ]);
        expect(readFileSync(createdLab.image.diskImage, "utf8")).toBe("overlay");

        const reused = materializeDisk({ labId: "materialize-vm" }, { env, stateRoot: root });
        expect(reused).toEqual(expect.objectContaining({ ok: true, materialized: false, reused: true }));
    });

    it("recovers missing disk directories and keeps dry-run planning zero-config", () => {
        const root = tempRoot();
        const readyEnv = {
            CCC_PROFILE: "materialize-recovery",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        mkdirSync(join(root, "images"), { recursive: true });
        writeFileSync(join(root, "images", "base.qcow2"), "base");
        const created = createLab({ name: "Recovery VM", sourceImage: "images/base.qcow2" }, { env: readyEnv, stateRoot: root });
        const createdLab = created.lab;
        assert.ok(createdLab);
        expect(created.ok).toBe(true);
        rmSync(dirname(createdLab.image.diskImage), { recursive: true, force: true });
        const recovered = materializeDisk({ labId: "recovery-vm" }, {
            env: readyEnv,
            stateRoot: root,
            qemuImgPath: "/usr/bin/qemu-img",
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: (_command: string, args: string[]) => {
                writeFileSync(args[args.length - 1], "overlay");
                return { ok: true, args };
            },
        });
        expect(recovered).toEqual(expect.objectContaining({ ok: true, materialized: true, diskImage: createdLab.image.diskImage }));
        expect(readFileSync(createdLab.image.diskImage, "utf8")).toBe("overlay");

        const unsupportedEnv = { CCC_PROFILE: "materialize-recovery" };
        rmSync(createdLab.image.diskImage, { force: true });
        const dryRun = startLab({ labId: "recovery-vm", dryRun: true }, { env: unsupportedEnv, stateRoot: root });
        expect(dryRun).toEqual(expect.objectContaining({
            ok: true,
            dryRun: true,
            providerStatus: expect.objectContaining({ available: false }),
            materialized: expect.objectContaining({
                ok: true,
                dryRun: true,
                plan: expect.objectContaining({
                    command: expect.any(String),
                    args: expect.arrayContaining([createdLab.image.diskImage]),
                }),
            }),
            args: expect.arrayContaining([`file=${createdLab.image.diskImage},if=virtio,format=qcow2`]),
        }));
    });

    it("does not boot stale disk metadata for source-less labs", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "stale-disk",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const created = createLab({ name: "Stale Disk VM" }, { env, stateRoot: root });
        const createdLab = created.lab;
        assert.ok(createdLab);
        expect(created.ok).toBe(true);
        const labPath = join(root, "owners", ownerId(env), "labs", "stale-disk-vm", "lab.json");
        const metadata = JSON.parse(readFileSync(labPath, "utf8"));
        writeFileSync(labPath, `${JSON.stringify({ ...metadata, image: { ...metadata.image, disk: { kind: "qcow2-overlay", path: createdLab.image.diskImage } } }, null, 2)}\n`);
        const commands: Array<{ command: string; args: string[] }> = [];
        const started = startLab({ labId: "stale-disk-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            qemuImgPath: "/usr/bin/qemu-img",
            kvmAvailable: true,
            commandRunner: (command: string, args: string[]) => {
                commands.push({ command, args });
                return { ok: true, pid: 2222, command, args };
            },
        });
        expect(started).toEqual(expect.objectContaining({ ok: true }));
        expect(commands).toHaveLength(1);
        expect(commands[0].args.join("\n")).not.toContain("-drive");
        expect(commands[0].args.join("\n")).not.toContain(createdLab.image.diskImage);
    });

    it("canonicalizes tampered disk metadata paths and refuses running labs", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "materialize-policy",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        mkdirSync(join(root, "images"), { recursive: true });
        writeFileSync(join(root, "images", "base.qcow2"), "base");
        const created = createLab({ name: "Materialize Policy VM", sourceImage: "images/base.qcow2" }, { env, stateRoot: root });
        const createdLab = created.lab;
        assert.ok(createdLab);
        expect(created.ok).toBe(true);

        const labPath = join(root, "owners", ownerId(env), "labs", "materialize-policy-vm", "lab.json");
        const metadata = JSON.parse(readFileSync(labPath, "utf8"));
        const outsideDisk = join(root, "outside.qcow2");
        const outsideLabDir = mkdtempSync(join(tmpdir(), "ccc-lab-outside-metadata-"));
        roots.push(outsideLabDir);
        writeFileSync(outsideDisk, "outside");
        writeFileSync(labPath, `${JSON.stringify({
            ...metadata,
            paths: { ...metadata.paths, labDir: outsideLabDir },
            image: { ...metadata.image, diskImage: join(outsideLabDir, "escape-link", "..", "root.qcow2") },
        }, null, 2)}\n`);
        const materializeCommands: Array<{ command: string; args: string[]; timeoutMs?: number }> = [];
        const materialized = materializeDisk({ labId: "materialize-policy-vm" }, {
            env,
            stateRoot: root,
            qemuImgPath: "/usr/bin/qemu-img",
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            providerCommandTimeoutMs: 999999,
            commandRunner: (command: string, args: string[], runOptions: { timeoutMs?: number }) => {
                materializeCommands.push({ command, args, timeoutMs: runOptions.timeoutMs });
                writeFileSync(args[args.length - 1], "overlay");
                return { ok: true, command, args };
            },
        });
        expect(materialized).toEqual(expect.objectContaining({ ok: true, diskImage: createdLab.image.diskImage }));
        expect(materializeCommands).toEqual([
            { command: "/usr/bin/qemu-img", args: ["create", "-f", "qcow2", "-F", "qcow2", "-b", join(root, "images", "base.qcow2"), createdLab.image.diskImage], timeoutMs: 600000 },
        ]);
        expect(readFileSync(outsideDisk, "utf8")).toBe("outside");
        expect(JSON.stringify(materialized)).not.toContain(outsideLabDir);

        const snapshotCommands: Array<{ command: string; args: string[]; timeoutMs?: number }> = [];
        expect(snapshotLab("create", { labId: "materialize-policy-vm", snapshotName: "unsafe" }, {
            env,
            stateRoot: root,
            qemuImgPath: "/usr/bin/qemu-img",
            providerCommandTimeoutMs: 1,
            commandRunner: (command: string, args: string[], runOptions: { timeoutMs?: number }) => {
                snapshotCommands.push({ command, args, timeoutMs: runOptions.timeoutMs });
                return { ok: true, command, args };
            },
        })).toEqual(expect.objectContaining({ ok: true }));
        expect(snapshotCommands).toEqual([
            { command: "/usr/bin/qemu-img", args: ["snapshot", "-c", "unsafe", createdLab.image.diskImage], timeoutMs: 1 },
        ]);

        writeFileSync(labPath, `${JSON.stringify({ ...metadata, runtimeState: "running", runtime: { pid: 1 } }, null, 2)}\n`);
        expect(materializeDisk({ labId: "materialize-policy-vm" }, { env, stateRoot: root })).toEqual({
            ok: false,
            error: "lab-running",
            labId: "materialize-policy-vm",
        });
    });

    it("rejects final disk links before start or snapshot", (context) => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "materialize-symlink",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        mkdirSync(join(root, "images"), { recursive: true });
        writeFileSync(join(root, "images", "base.qcow2"), "base");
        const created = createLab({ name: "Materialize Symlink VM", sourceImage: "images/base.qcow2" }, { env, stateRoot: root });
        const createdLab = created.lab;
        assert.ok(createdLab);
        expect(created.ok).toBe(true);
        const outsideDir = mkdtempSync(join(tmpdir(), "ccc-lab-outside-disks-"));
        roots.push(outsideDir);
        rmSync(dirname(createdLab.image.diskImage), { recursive: true, force: true });
        mkdirSync(dirname(createdLab.image.diskImage), { recursive: true });
        fileSymlinkOrSkip(context, join(outsideDir, "root.qcow2"), createdLab.image.diskImage);
        const expectedFinal = {
            ok: false,
            error: "disk-image-symlink-rejected",
            diskImage: createdLab.image.diskImage,
        };
        expect(startLab({ labId: "materialize-symlink-vm" }, {
            env,
            stateRoot: root,
            qemuImgPath: "/usr/bin/qemu-img",
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 1234 }),
        })).toEqual(expectedFinal);
        expect(snapshotLab("create", { labId: "materialize-symlink-vm", snapshotName: "unsafe" }, {
            env,
            stateRoot: root,
            qemuImgPath: "/usr/bin/qemu-img",
        })).toEqual({
            ok: false,
            error: "qemu-img-snapshot-failed",
            result: expectedFinal,
        });
    });

    it("rejects disk symlink escapes before materialize, start, or snapshot", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "materialize-symlink",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        mkdirSync(join(root, "images"), { recursive: true });
        writeFileSync(join(root, "images", "base.qcow2"), "base");
        const created = createLab({ name: "Materialize Symlink VM", sourceImage: "images/base.qcow2" }, { env, stateRoot: root });
        const createdLab = created.lab;
        assert.ok(createdLab);
        expect(created.ok).toBe(true);
        const outsideDir = mkdtempSync(join(tmpdir(), "ccc-lab-outside-disks-"));
        roots.push(outsideDir);
        rmSync(dirname(createdLab.image.diskImage), { recursive: true, force: true });
        symlinkSync(outsideDir, dirname(createdLab.image.diskImage), process.platform === "win32" ? "junction" : "dir");

        const expectedAncestor = {
            ok: false,
            error: "disk-image-symlink-ancestor-rejected",
            diskImage: createdLab.image.diskImage,
            ancestorPath: dirname(createdLab.image.diskImage),
        };
        expect(materializeDisk({ labId: "materialize-symlink-vm" }, {
            env,
            stateRoot: root,
            qemuImgPath: "/usr/bin/qemu-img",
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
        })).toEqual(expectedAncestor);
        expect(startLab({ labId: "materialize-symlink-vm" }, {
            env,
            stateRoot: root,
            qemuImgPath: "/usr/bin/qemu-img",
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 1234 }),
        })).toEqual(expectedAncestor);


    });

    it("sanitizes provider runner failure details before returning start errors", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "start-fail",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const created = createLab({ name: "Start Failure VM" }, { env, stateRoot: root });
        expect(created.ok).toBe(true);

        const failed = startLab({ labId: "start-failure-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: (_command: string, args: string[]) => ({ ok: false, args, stderr: "boom" }),
        });

        expect(failed).toEqual(expect.objectContaining({
            ok: false,
            error: "lab-start-failed",
            result: expect.objectContaining({
                args: expect.arrayContaining(["unix:<provider-internal-monitor>,server,nowait"]),
            }),
        }));
        expect(JSON.stringify(failed)).not.toContain("qemu-monitor.sock");
    });

    it("lists targets without starting labs and records bounded sessions", () => {
        const root = tempRoot();
        const env = { CCC_PROFILE: "targets" };
        const created = createLab({ name: "Target VM" }, { env, stateRoot: root, now: "2026-06-16T00:00:00.000Z" });
        expect(created.ok).toBe(true);

        const targets = listTargets({}, { env, stateRoot: root });
        expect(targets).toEqual(expect.objectContaining({
            ok: true,
            targets: [expect.objectContaining({
                id: "target-vm:vm",
                labId: "target-vm",
                targetKind: "lab-vm",
                runtimeState: "stopped",
                readiness: "stopped",
                attachable: false,
                sessionHints: expect.objectContaining({
                    monitor: "start-lab-before-opening-monitor-session",
                    metadata: "available",
                    guestSsh: "start-lab-before-opening-guest-session",
                    guestAgent: "start-lab-before-opening-agent-session",
                }),
            })],
        }));
        expect(listLabs({ env, stateRoot: root }).labs[0].runtimeState).toBe("stopped");

        const session = openSession({ labId: "target-vm", sessionId: "session-one", sessionType: "metadata" }, {
            env,
            stateRoot: root,
            now: "2026-06-16T00:05:00.000Z",
        });
        expect(session).toEqual(expect.objectContaining({
            ok: true,
            session: expect.objectContaining({
                id: "session-one",
                labId: "target-vm",
                targetKind: "lab-vm",
                state: "unavailable",
                authority: "device-lab-metadata",
                attach: expect.objectContaining({ kind: "metadata", available: true }),
            }),
        }));
        const recordedLab = listLabs({ env, stateRoot: root }).labs[0];
        assert.ok(recordedLab && "sessions" in recordedLab);
        expect(recordedLab.sessions).toEqual([
            expect.objectContaining({ id: "session-one", state: "unavailable" }),
        ]);
    });

    it("opens monitor sessions for running labs without exposing host shell authority", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "session",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const created = createLab({ name: "Session VM" }, { env, stateRoot: root });
        expect(created.ok).toBe(true);
        const started = startLab({ labId: "session-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 7777 }),
            now: "2026-06-16T01:00:00.000Z",
        });
        expect(started.ok).toBe(true);

        const session = openSession({ labId: "session-vm", sessionId: "monitor-session" }, {
            env,
            stateRoot: root,
            now: "2026-06-16T01:01:00.000Z",
        });

        expect(session).toEqual(expect.objectContaining({
            ok: true,
            target: expect.objectContaining({ attachable: true, readiness: "process-running" }),
            session: expect.objectContaining({
                id: "monitor-session",
                state: "open",
                authority: "device-lab-metadata",
                attach: expect.objectContaining({
                    kind: "bounded-monitor-proxy-required",
                    available: false,
                    requestedTargetReady: true,
                }),
            }),
        }));
        expect(JSON.stringify(listTargets({ labId: "session-vm" }, { env, stateRoot: root }))).not.toContain("qemu-monitor.sock");
        expect(JSON.stringify(session)).not.toContain("qemu-monitor.sock");
    });

    it("opens bounded guest SSH sessions for running labs without raw shell authority", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "session-ssh",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const ownerRoot = join(root, "owners", ownerId(env));
        mkdirSync(join(ownerRoot, "keys"), { recursive: true });
        const keyPath = join(ownerRoot, "keys", "id_ed25519");
        writeFileSync(keyPath, "private-key");
        const calls: Array<{ command: string; args: string[] }> = [];
        const created = createLab({
            name: "Session SSH VM",
            guestSshHost: "127.0.0.1",
            guestSshPort: 2222,
            guestSshUser: "ccc",
            guestSshKeyPath: keyPath,
        }, { env, stateRoot: root });
        const createdLab = created.lab;
        assert.ok(createdLab);
        expect(created.ok).toBe(true);
        expect(startLab({ labId: "session-ssh-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 7878 }),
        }).ok).toBe(true);
        const readiness = probeReadiness({ labId: "session-ssh-vm" }, {
            env,
            stateRoot: root,
            processExists: () => true,
            readinessProbeRunner: () => ({
                ok: true,
                ready: true,
                state: "ready",
                diagnostics: {
                    providerArgs: ["-monitor", "unix:/tmp/qemu-monitor.sock,server,nowait"],
                    sshPath: "/usr/bin/ssh",
                    keyPath,
                    labPath: createdLab.paths.labDir,
                    args: ["secret"],
                },
            }),
        });
        expect(readiness.ok).toBe(true);
        const readinessFile = join(createdLab.paths.labDir, "lab.json");
        const rawReadiness = JSON.parse(readFileSync(readinessFile, "utf8"));
        rawReadiness.readiness.latest.state = `/usr/bin/ssh ${keyPath} ${createdLab.paths.labDir} qemu-monitor.sock secret-state`;
        writeFileSync(readinessFile, JSON.stringify(rawReadiness, null, 2));

        const session = openSession({ labId: "session-ssh-vm", sessionId: "guest-ssh-session", sessionType: "guest-ssh" }, {
            env,
            stateRoot: root,
            sshPath: "/usr/bin/ssh",
            sshCommandRunner: (command: string, args: string[]) => {
                calls.push({ command, args });
                return { ok: true, status: 0 };
            },
        });
        assert.ok("target" in session && session.target);

        expect(session).toEqual(expect.objectContaining({
            ok: true,
            target: expect.objectContaining({
                attachable: true,
                sessionHints: expect.objectContaining({ guestSsh: "bounded-guest-ssh-session-available" }),
            }),
            session: expect.objectContaining({
                id: "guest-ssh-session",
                sessionType: "guest-ssh",
                state: "open",
                authority: "device-lab-bounded-guest-ssh",
                attach: expect.objectContaining({
                    kind: "bounded-guest-ssh",
                    available: true,
                    requestedTargetReady: true,
                    rawShellAvailable: false,
                    commandTool: "device_exec",
                    transferTools: ["device_upload", "device_download"],
                    capabilities: ["device_exec", "device_upload", "device_download"],
                    host: "127.0.0.1",
                    port: 2222,
                    user: "ccc",
                    keyConfigured: true,
                }),
            }),
        }));
        expect(calls).toEqual([]);
        const recordedLab = listLabs({ env, stateRoot: root }).labs[0];
        assert.ok(recordedLab && "sessions" in recordedLab);
        expect(recordedLab.sessions).toEqual([
            expect.objectContaining({ id: "guest-ssh-session", sessionType: "guest-ssh", state: "open" }),
        ]);
        expect(JSON.stringify(session)).not.toContain(keyPath);
        expect(JSON.stringify(session)).not.toContain(createdLab.paths.labDir);
        expect(JSON.stringify(session)).not.toContain("/usr/bin/ssh");
        expect(JSON.stringify(session)).not.toContain("qemu-monitor.sock");
        expect(JSON.stringify(session)).not.toContain("secret");
        expect(JSON.stringify(session)).not.toContain("secret-state");
        expect(JSON.stringify(session)).not.toContain("args");
        assert.ok(session.lab);
        expect(session.lab.readiness).toBe("process-running");
        expect(session.target.readiness).toBe("process-running");
    });

    it("reports guest SSH session unavailable without invoking command runners", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "session-ssh-unavailable",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const ownerRoot = join(root, "owners", ownerId(env));
        mkdirSync(join(ownerRoot, "keys"), { recursive: true });
        const keyPath = join(ownerRoot, "keys", "id_ed25519");
        writeFileSync(keyPath, "private-key");
        const otherEnv = { CCC_PROFILE: "session-ssh-unavailable-other" };
        const otherOwnerRoot = join(root, "owners", ownerId(otherEnv));
        mkdirSync(join(otherOwnerRoot, "keys"), { recursive: true });
        const otherKeyPath = join(otherOwnerRoot, "keys", "id_ed25519");
        writeFileSync(otherKeyPath, "other-private-key");
        const calls: Array<{ command: string; args: string[] }> = [];

        expect(createLab({ name: "Stopped SSH Session VM", guestSshHost: "127.0.0.1", guestSshUser: "ccc", guestSshKeyPath: keyPath }, { env, stateRoot: root }).ok).toBe(true);
        const stopped = openSession({ labId: "stopped-ssh-session-vm", sessionId: "stopped-guest-ssh", sessionType: "guest-ssh" }, {
            env,
            stateRoot: root,
            sshPath: "/usr/bin/ssh",
            sshCommandRunner: (command: string, args: string[]) => {
                calls.push({ command, args });
                return { ok: true, status: 0 };
            },
        });
        assert.ok("session" in stopped && stopped.session);
        expect(stopped.session).toEqual(expect.objectContaining({
            state: "unavailable",
            attach: expect.objectContaining({ available: false, reason: "lab-not-running" }),
        }));

        expect(createLab({ name: "No SSH Session VM" }, { env, stateRoot: root }).ok).toBe(true);
        expect(startLab({ labId: "no-ssh-session-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 7979 }),
        }).ok).toBe(true);
        const noSsh = openSession({ labId: "no-ssh-session-vm", sessionId: "no-ssh-guest-ssh", sessionType: "guest-ssh" }, {
            env,
            stateRoot: root,
        });
        assert.ok("session" in noSsh && noSsh.session);
        expect(noSsh.session).toEqual(expect.objectContaining({
            state: "unavailable",
            attach: expect.objectContaining({ available: false, reason: "guest-ssh-not-configured" }),
        }));

        expect(createLab({ name: "Missing SSH Tool VM", guestSshHost: "127.0.0.1", guestSshUser: "ccc", guestSshKeyPath: keyPath }, { env, stateRoot: root }).ok).toBe(true);
        expect(startLab({ labId: "missing-ssh-tool-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 8080 }),
        }).ok).toBe(true);
        const missingTool = openSession({ labId: "missing-ssh-tool-vm", sessionId: "missing-tool-guest-ssh", sessionType: "guest-ssh" }, {
            env,
            stateRoot: root,
            sshPath: null,
            sshCommandRunner: (command: string, args: string[]) => {
                calls.push({ command, args });
                return { ok: true, status: 0 };
            },
        });
        assert.ok("session" in missingTool && missingTool.session);
        expect(missingTool.session).toEqual(expect.objectContaining({
            state: "unavailable",
            attach: expect.objectContaining({ available: false, reason: "guest-ssh-command-unavailable", missing: ["ssh"] }),
        }));

        const tampered = createLab({ name: "Tampered SSH Session VM", guestSshHost: "127.0.0.1", guestSshUser: "ccc", guestSshKeyPath: keyPath }, { env, stateRoot: root });
        const tamperedLab = tampered.lab;
        assert.ok(tamperedLab);
        expect(tampered.ok).toBe(true);
        expect(startLab({ labId: "tampered-ssh-session-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 8181 }),
        }).ok).toBe(true);
        const tamperedFile = join(tamperedLab.paths.labDir, "lab.json");
        const rawTampered = JSON.parse(readFileSync(tamperedFile, "utf8"));
        rawTampered.guest.ssh.keyPath = otherKeyPath;
        writeFileSync(tamperedFile, JSON.stringify(rawTampered, null, 2));
        const tamperedSession = openSession({ labId: "tampered-ssh-session-vm", sessionId: "tampered-guest-ssh", sessionType: "guest-ssh" }, {
            env,
            stateRoot: root,
            sshPath: "/usr/bin/ssh",
            sshCommandRunner: (command: string, args: string[]) => {
                calls.push({ command, args });
                return { ok: true, status: 0 };
            },
        });
        assert.ok("session" in tamperedSession && tamperedSession.session);
        expect(tamperedSession.session).toEqual(expect.objectContaining({
            state: "unavailable",
            attach: expect.objectContaining({ available: false, reason: "guest-ssh-not-configured" }),
        }));

        expect(calls).toEqual([]);
        expect(JSON.stringify(stopped)).not.toContain(keyPath);
        expect(JSON.stringify(noSsh)).not.toContain(keyPath);
        expect(JSON.stringify(missingTool)).not.toContain(keyPath);
        expect(JSON.stringify(missingTool)).not.toContain("/usr/bin/ssh");
        expect(JSON.stringify(tamperedSession)).not.toContain(otherKeyPath);
    });

    it("records bounded guest-agent status, readiness, and sessions without raw shell authority", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "guest-agent",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const ownerRoot = join(root, "owners", ownerId(env));
        mkdirSync(join(ownerRoot, "keys"), { recursive: true });
        const keyPath = join(ownerRoot, "keys", "id_ed25519");
        writeFileSync(keyPath, "private-key");
        const healthCommand = "systemctl is-active ccc-agent";
        const created = createLab({
            name: "Guest Agent VM",
            guestSshHost: "127.0.0.1",
            guestSshPort: 2200,
            guestSshUser: "ccc",
            guestSshKeyPath: keyPath,
            guestAgentName: "ccc-agent",
            guestAgentHealthCommand: healthCommand,
        }, { env, stateRoot: root });
        const createdLab = created.lab;
        assert.ok(createdLab);
        expect(created).toEqual(expect.objectContaining({
            ok: true,
            lab: expect.objectContaining({
                guest: expect.objectContaining({
                    agent: expect.objectContaining({
                        name: "ccc-agent",
                        protocol: "bounded-ssh-health-command",
                        healthCommandConfigured: true,
                    }),
                }),
            }),
        }));
        expect(JSON.stringify(created)).not.toContain(healthCommand);
        expect(startLab({ labId: "guest-agent-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 7979 }),
        }).ok).toBe(true);

        const calls: Array<{ command: string; args: string[] }> = [];
        const options = {
            env,
            stateRoot: root,
            sshPath: "/usr/bin/ssh",
            processExists: () => true,
            sshCommandRunner: (command: string, args: string[]) => {
                calls.push({ command, args });
                return { ok: true, status: 0, stdout: `ready ${keyPath} ${healthCommand}`, stderr: createdLab.paths.labDir };
            },
        };

        const status = guestAgentStatus({ labId: "guest-agent-vm", timeoutMs: 5000 }, options);
        expect(status).toEqual(expect.objectContaining({
            ok: true,
            status: expect.objectContaining({
                state: "ready",
                ok: true,
                checks: expect.arrayContaining([
                    expect.objectContaining({ name: "guest-agent-readiness", status: "pass", agent: "ccc-agent" }),
                ]),
            }),
            lab: expect.objectContaining({
                guest: expect.objectContaining({
                    agent: expect.objectContaining({
                        lastStatus: expect.objectContaining({ state: "ready" }),
                    }),
                }),
            }),
        }));
        expect(calls[0]).toEqual(expect.objectContaining({
            command: "/usr/bin/ssh",
            args: expect.arrayContaining([healthCommand]),
        }));
        expect(JSON.stringify(status)).not.toContain(keyPath);
        expect(JSON.stringify(status)).not.toContain(healthCommand);

        const readiness = probeReadiness({ labId: "guest-agent-vm" }, options);
        expect(readiness).toEqual(expect.objectContaining({
            ok: true,
            readiness: expect.objectContaining({
                state: "ready",
                checks: expect.arrayContaining([
                    expect.objectContaining({ name: "guest-ssh-readiness", status: "pass" }),
                    expect.objectContaining({ name: "guest-agent-readiness", status: "pass", agent: "ccc-agent" }),
                ]),
            }),
        }));

        const session = openSession({ labId: "guest-agent-vm", sessionId: "agent-session", sessionType: "guest-agent" }, options);
        expect(session).toEqual(expect.objectContaining({
            ok: true,
            target: expect.objectContaining({
                sessionHints: expect.objectContaining({ guestAgent: "bounded-guest-agent-session-available" }),
            }),
            session: expect.objectContaining({
                id: "agent-session",
                sessionType: "guest-agent",
                state: "open",
                authority: "device-lab-bounded-guest-agent",
                attach: expect.objectContaining({
                    kind: "bounded-guest-agent",
                    available: true,
                    rawShellAvailable: false,
                    rawSocketAvailable: false,
                    statusTool: "device_guest_agent_status",
                    provisionTool: "device_guest_agent_provision",
                    commandTool: "device_exec",
                    transferTools: ["device_upload", "device_download"],
                    capabilities: ["device_guest_agent_status", "device_guest_agent_provision", "device_exec", "device_upload", "device_download"],
                    agent: expect.objectContaining({
                        name: "ccc-agent",
                        protocol: "bounded-ssh-health-command",
                        healthCommandConfigured: true,
                        provisionCommandConfigured: false,
                        lastStatus: expect.objectContaining({ state: "ready" }),
                    }),
                }),
            }),
        }));
        expect(JSON.stringify(session)).not.toContain(keyPath);
        expect(JSON.stringify(session)).not.toContain(createdLab.paths.labDir);
        expect(JSON.stringify(session)).not.toContain(healthCommand);
        expect(JSON.stringify(session)).not.toContain("/usr/bin/ssh");
        expect(JSON.stringify(session)).not.toContain("args");
    });

    it("runs bounded guest-agent provisioning explicitly and during opted-in start without leaking commands", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "guest-agent-provision",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const ownerRoot = join(root, "owners", ownerId(env));
        mkdirSync(join(ownerRoot, "keys"), { recursive: true });
        const keyPath = join(ownerRoot, "keys", "id_ed25519");
        writeFileSync(keyPath, "private-key");
        const healthCommand = "systemctl is-active ccc-agent";
        const provisionCommand = "install-ccc-agent --mode bounded";
        const created = createLab({
            name: "Guest Agent Provision VM",
            guestAgentAutoProvision: false,
            guestSshHost: "127.0.0.1",
            guestSshUser: "ccc",
            guestSshKeyPath: keyPath,
            guestAgentName: "ccc-agent",
            guestAgentHealthCommand: healthCommand,
            guestAgentProvisionCommand: provisionCommand,
        }, { env, stateRoot: root });
        const createdLab = created.lab;
        assert.ok(createdLab);
        expect(created).toEqual(expect.objectContaining({
            ok: true,
            lab: expect.objectContaining({
                guest: expect.objectContaining({
                    agent: expect.objectContaining({
                        provisionCommandConfigured: true,
                        autoProvision: false,
                    }),
                }),
            }),
        }));
        expect(JSON.stringify(created)).not.toContain(provisionCommand);

        expect(guestAgentProvision({ labId: "guest-agent-provision-vm" }, { env, stateRoot: root })).toEqual(expect.objectContaining({
            ok: false,
            error: "lab-not-running",
        }));
        expect(startLab({ labId: "guest-agent-provision-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 7980 }),
        }).guestAgentProvision).toBeUndefined();

        const metadataFile = join(createdLab.paths.labDir, "lab.json");
        const metadata = JSON.parse(readFileSync(metadataFile, "utf8"));
        metadata.guest.agent.provisionHistory = Array.from({ length: 50 }, (_, index) => ({ id: `prior-${index}`, state: "failed" }));
        writeFileSync(metadataFile, JSON.stringify(metadata));
        const beforeProvision = readFileSync(metadataFile, "utf8"), sshFault = new Error("raw SSH fault");
        let caughtSsh: unknown;
        try {
            guestAgentProvision({ labId: "guest-agent-provision-vm" }, {
                env, stateRoot: root, sshPath: "/usr/bin/ssh", processExists: () => true,
                sshCommandRunner: () => { throw sshFault; },
            });
        } catch (error) { caughtSsh = error; }
        expect(caughtSsh).toBe(sshFault);
        expect(readFileSync(metadataFile, "utf8")).toBe(beforeProvision);

        const calls: Array<{ command: string; args: string[] }> = [];
        const provisioned = guestAgentProvision({ labId: "guest-agent-provision-vm", timeoutMs: 7000 }, {
            env,
            stateRoot: root,
            sshPath: "/usr/bin/ssh",
            processExists: () => true,
            sshCommandRunner: (command: string, args: string[]) => {
                calls.push({ command, args });
                return { ok: true, status: 0, stdout: `installed ${keyPath} ${provisionCommand}`, stderr: createdLab.paths.labDir };
            },
        });
        expect(provisioned).toEqual(expect.objectContaining({
            ok: true,
            status: expect.objectContaining({
                state: "ready",
                provisioned: true,
                checks: expect.arrayContaining([
                    expect.objectContaining({ name: "guest-agent-provision", status: "pass", agent: "ccc-agent" }),
                ]),
            }),
            lab: expect.objectContaining({
                guest: expect.objectContaining({
                    agent: expect.objectContaining({
                        lastProvision: expect.objectContaining({ state: "ready", provisioned: true }),
                    }),
                }),
            }),
        }));
        expect(calls).toHaveLength(1);
        const persistedProvision = JSON.parse(readFileSync(metadataFile, "utf8")).guest.agent;
        expect(persistedProvision.provisionHistory).toHaveLength(50);
        expect(persistedProvision.provisionHistory[0].id).toBe("prior-1");
        expect(persistedProvision.provisionHistory[49]).toEqual(persistedProvision.lastProvision);
        expect(calls[0]).toEqual(expect.objectContaining({
            command: "/usr/bin/ssh",
            args: expect.arrayContaining([provisionCommand]),
        }));
        expect(JSON.stringify(provisioned)).not.toContain(keyPath);
        expect(JSON.stringify(provisioned)).not.toContain(provisionCommand);
        expect(JSON.stringify(provisioned)).not.toContain("/usr/bin/ssh");
        expect(JSON.stringify(provisioned)).not.toContain("args");

        const auto = createLab({
            name: "Guest Agent Auto Provision VM",
            guestSshHost: "127.0.0.1",
            guestSshUser: "ccc",
            guestSshKeyPath: keyPath,
            guestAgentName: "ccc-agent",
            guestAgentHealthCommand: healthCommand,
            guestAgentProvisionCommand: provisionCommand,
            guestAgentAutoProvision: true,
        }, { env, stateRoot: root });
        const autoLab = auto.lab;
        assert.ok(autoLab);
        expect(auto.ok).toBe(true);
        const autoCalls: Array<{ command: string; args: string[] }> = [];
        const started = startLab({ labId: "guest-agent-auto-provision-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 7981 }),
            sshPath: "/usr/bin/ssh",
            sshCommandRunner: (command: string, args: string[]) => {
                autoCalls.push({ command, args });
                return { ok: true, status: 0, stdout: `auto ${provisionCommand}`, stderr: keyPath };
            },
        });
        expect(started).toEqual(expect.objectContaining({
            ok: true,
            guestAgentProvision: expect.objectContaining({
                ok: true,
                status: expect.objectContaining({ provisioned: true }),
            }),
            lab: expect.objectContaining({
                guest: expect.objectContaining({
                    agent: expect.objectContaining({
                        autoProvision: true,
                        lastProvision: expect.objectContaining({ provisioned: true }),
                    }),
                }),
            }),
        }));
        expect(autoCalls).toHaveLength(1);
        expect(autoCalls[0].args).toEqual(expect.arrayContaining([provisionCommand]));
        const autoFile = join(autoLab.paths.labDir, "lab.json"), reuseTrace: string[] = [];
        const reuseOptions = {
            env, stateRoot: root, qemuPath: "/usr/bin/qemu-system-x86_64", kvmAvailable: true, sshPath: "/usr/bin/ssh",
            commandRunner: () => { throw new Error("reuse cannot invoke launcher"); },
            sshCommandRunner: () => { reuseTrace.push("provision"); return { ok: true, status: 0 }; },
        };
        expect(startLab({ labId: autoLab.id }, reuseOptions).reused).toBe(true);
        expect(reuseTrace).toEqual([]);
        for (const lastProvision of [undefined, { ok: false }]) {
            const stored = JSON.parse(readFileSync(autoFile, "utf8"));
            stored.guest.agent.lastProvision = lastProvision;
            writeFileSync(autoFile, JSON.stringify(stored));
            expect(startLab({ labId: autoLab.id }, reuseOptions)).toEqual(expect.objectContaining({ ok: true, reused: true }));
        }
        expect(reuseTrace).toEqual(["provision", "provision"]);

        const failedStart = createLab({
            name: "Post Launch Provision Fault", guestSshHost: "127.0.0.1", guestSshUser: "ccc", guestSshKeyPath: keyPath,
            guestAgentHealthCommand: healthCommand, guestAgentProvisionCommand: provisionCommand, guestAgentAutoProvision: true,
        }, { env, stateRoot: root });
        const failedStartLab = failedStart.lab;
        assert.ok(failedStartLab);
        expect(failedStart.ok).toBe(true);
        const startTrace: string[] = [], postLaunchFault = new Error("post-launch SSH fault");
        let rawPostLaunch: unknown;
        try {
            startLab({ labId: failedStartLab.id }, {
                env, stateRoot: root, qemuPath: "/usr/bin/qemu-system-x86_64", kvmAvailable: true, sshPath: "/usr/bin/ssh",
                commandRunner: () => { startTrace.push("launch"); return { ok: true, pid: 7982 }; },
                sshCommandRunner: () => { startTrace.push("provision"); throw postLaunchFault; },
            });
        } catch (error) { rawPostLaunch = error; }
        expect(rawPostLaunch).toBe(postLaunchFault);
        expect(startTrace).toEqual(["launch", "provision"]);
        expect(JSON.parse(readFileSync(join(failedStartLab.paths.labDir, "lab.json"), "utf8"))).toEqual(
            expect.objectContaining({ runtimeState: "running", runtime: expect.objectContaining({ pid: 7982 }) }),
        );
        expect(JSON.stringify(started)).not.toContain(keyPath);
        expect(JSON.stringify(started)).not.toContain(provisionCommand);
        expect(JSON.stringify(started)).not.toContain("/usr/bin/ssh");
        expect(JSON.stringify(started)).not.toContain("args");
    });

    it("does not auto-provision without a configured provision command and fails safely without guest SSH", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "guest-agent-provision-guards",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const ownerRoot = join(root, "owners", ownerId(env));
        mkdirSync(join(ownerRoot, "keys"), { recursive: true });
        const keyPath = join(ownerRoot, "keys", "id_ed25519");
        writeFileSync(keyPath, "private-key");
        const healthCommand = "systemctl is-active ccc-agent";
        const provisionCommand = "install-ccc-agent --mode bounded";

        const autoWithoutCommand = createLab({
            name: "Guest Agent Auto No Command VM",
            guestSshHost: "127.0.0.1",
            guestSshUser: "ccc",
            guestSshKeyPath: keyPath,
            guestAgentName: "ccc-agent",
            guestAgentHealthCommand: healthCommand,
            guestAgentAutoProvision: true,
        }, { env, stateRoot: root });
        expect(autoWithoutCommand.ok).toBe(true);
        const autoCalls: Array<{ command: string; args: string[] }> = [];
        const autoStarted = startLab({ labId: "guest-agent-auto-no-command-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 7982 }),
            sshPath: "/usr/bin/ssh",
            sshCommandRunner: (command: string, args: string[]) => {
                autoCalls.push({ command, args });
                return { ok: true, status: 0, stdout: "unexpected", stderr: "" };
            },
        });
        expect(autoStarted).toEqual(expect.objectContaining({
            ok: true,
            guestAgentProvision: undefined,
            lab: expect.objectContaining({
                guest: expect.objectContaining({
                    agent: expect.objectContaining({
                        autoProvision: true,
                        provisionCommandConfigured: false,
                    }),
                }),
            }),
        }));
        expect(autoCalls).toHaveLength(0);

        const missingSsh = createLab({
            name: "Guest Agent Provision Missing SSH VM",
            guestAgentAutoProvision: false,
            guestSshHost: "127.0.0.1",
            guestSshUser: "ccc",
            guestSshKeyPath: keyPath,
            guestAgentName: "ccc-agent",
            guestAgentHealthCommand: healthCommand,
            guestAgentProvisionCommand: provisionCommand,
        }, { env, stateRoot: root });
        const missingSshLab = missingSsh.lab;
        assert.ok(missingSshLab);
        expect(missingSsh.ok).toBe(true);
        expect(startLab({ labId: "guest-agent-provision-missing-ssh-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 7983 }),
        }).ok).toBe(true);
        const labFile = join(missingSshLab.paths.labDir, "lab.json");
        const raw = JSON.parse(readFileSync(labFile, "utf8"));
        delete raw.guest.ssh;
        writeFileSync(labFile, JSON.stringify(raw, null, 2));
        const missingSshCalls: Array<{ command: string; args: string[] }> = [];
        const provisioned = guestAgentProvision({ labId: "guest-agent-provision-missing-ssh-vm" }, {
            env,
            stateRoot: root,
            sshPath: "/usr/bin/ssh",
            processExists: () => true,
            sshCommandRunner: (command: string, args: string[]) => {
                missingSshCalls.push({ command, args });
                return { ok: true, status: 0, stdout: "unexpected", stderr: "" };
            },
        });
        expect(provisioned).toEqual(expect.objectContaining({
            ok: false,
            status: expect.objectContaining({
                state: "failed",
                provisioned: false,
                checks: expect.arrayContaining([
                    expect.objectContaining({ name: "guest-agent-provision", status: "fail", reason: "guest-ssh-not-configured" }),
                ]),
            }),
            lab: expect.objectContaining({
                guest: expect.objectContaining({
                    agent: expect.objectContaining({
                        lastProvision: expect.objectContaining({ state: "failed", provisioned: false }),
                    }),
                }),
            }),
        }));
        expect(missingSshCalls).toHaveLength(0);
        expect(JSON.stringify(provisioned)).not.toContain(provisionCommand);
        expect(JSON.stringify(provisioned)).not.toContain("/usr/bin/ssh");
        expect(JSON.stringify(provisioned)).not.toContain("args");
    });

    it("sanitizes tampered persisted guest-agent status before public responses", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "guest-agent-tamper",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const ownerRoot = join(root, "owners", ownerId(env));
        mkdirSync(join(ownerRoot, "keys"), { recursive: true });
        const keyPath = join(ownerRoot, "keys", "id_ed25519");
        writeFileSync(keyPath, "private-key");
        const healthCommand = "systemctl is-active ccc-agent";
        const provisionCommand = "install-ccc-agent --mode bounded";
        const created = createLab({
            name: "Guest Agent Tamper VM",
            guestSshHost: "127.0.0.1",
            guestSshUser: "ccc",
            guestSshKeyPath: keyPath,
            guestAgentName: "ccc-agent",
            guestAgentHealthCommand: healthCommand,
        }, { env, stateRoot: root });
        const createdLab = created.lab;
        assert.ok(createdLab);
        expect(created.ok).toBe(true);
        expect(startLab({ labId: "guest-agent-tamper-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 7978 }),
        }).ok).toBe(true);

        const labFile = join(createdLab.paths.labDir, "lab.json");
        const raw = JSON.parse(readFileSync(labFile, "utf8"));
        raw.guest.agent.provisionCommand = provisionCommand;
        raw.guest.agent.lastStatus = {
            id: "tampered",
            state: "ready",
            ok: true,
            diagnostics: {
                args: ["ssh", keyPath, healthCommand],
                stdout: `ready ${keyPath} ${healthCommand} ${createdLab.paths.labDir}`,
                stderr: `/tmp/noise ${createdLab.paths.artifactsDir}`,
            },
        };
        raw.guest.agent.statusHistory = [
            {
                id: "tampered-history",
                state: "ready",
                diagnostics: { stdout: `${keyPath} ${healthCommand} ${createdLab.paths.workspaceDir}` },
            },
        ];
        raw.guest.agent.lastProvision = {
            id: "tampered-provision",
            state: "ready",
            ok: true,
            diagnostics: {
                args: ["ssh", keyPath, provisionCommand],
                stdout: `installed ${keyPath} ${provisionCommand} ${createdLab.paths.labDir}`,
            },
        };
        raw.guest.agent.provisionHistory = [
            {
                id: "tampered-provision-history",
                state: "ready",
                diagnostics: { stdout: `${keyPath} ${provisionCommand} ${createdLab.paths.workspaceDir}` },
            },
        ];
        writeFileSync(labFile, JSON.stringify(raw, null, 2));

        const listed = listLabs({ env, stateRoot: root });
        const session = openSession({ labId: "guest-agent-tamper-vm", sessionType: "guest-agent" }, {
            env,
            stateRoot: root,
            sshPath: "/usr/bin/ssh",
            processExists: () => true,
        });
        assert.ok("session" in session && session.session);

        assert.ok(listed.labs[0].guest?.agent);
        const listedStatusJson = JSON.stringify(listed.labs[0].guest.agent.lastStatus);
        expect(listedStatusJson).not.toContain(keyPath);
        expect(listedStatusJson).not.toContain(healthCommand);
        expect(listedStatusJson).not.toContain(createdLab.paths.labDir);
        expect(listedStatusJson).not.toContain(createdLab.paths.artifactsDir);
        expect(listedStatusJson).not.toContain(createdLab.paths.workspaceDir);
        expect(listedStatusJson).not.toContain("args");
        const listedProvisionJson = JSON.stringify(listed.labs[0].guest.agent.lastProvision);
        expect(listedProvisionJson).not.toContain(keyPath);
        expect(listedProvisionJson).not.toContain(provisionCommand);
        expect(listedProvisionJson).not.toContain(createdLab.paths.labDir);
        expect(listedProvisionJson).not.toContain(createdLab.paths.workspaceDir);
        expect(listedProvisionJson).not.toContain("args");

        const sessionJson = JSON.stringify(session);
        expect(sessionJson).not.toContain(keyPath);
        expect(sessionJson).not.toContain(healthCommand);
        expect(sessionJson).not.toContain(provisionCommand);
        expect(sessionJson).not.toContain(createdLab.paths.labDir);
        expect(sessionJson).not.toContain(createdLab.paths.artifactsDir);
        expect(sessionJson).not.toContain(createdLab.paths.workspaceDir);
        expect(sessionJson).not.toContain("args");
        assert.ok("agent" in session.session.attach && session.session.attach.agent);
        expect(session.session.attach.agent.lastStatus).toEqual(expect.objectContaining({
            id: "tampered",
            state: "ready",
        }));
        expect(session.session.attach.agent.lastProvision).toEqual(expect.objectContaining({
            id: "tampered-provision",
            state: "ready",
        }));
    });

    it("probes readiness with safe process metadata and reflects latest target state", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "readiness",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const created = createLab({ name: "Readiness VM" }, { env, stateRoot: root });
        expect(created.ok).toBe(true);

        const stopped = probeReadiness({ labId: "readiness-vm" }, {
            env,
            stateRoot: root,
            now: "2026-06-16T03:00:00.000Z",
        });
        expect(stopped).toEqual(expect.objectContaining({
            ok: false,
            error: "lab-not-running",
            readiness: expect.objectContaining({ state: "stopped" }),
        }));
        expect(stopped.lab.readiness).toBeUndefined();

        const started = startLab({ labId: "readiness-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 4444 }),
            now: "2026-06-16T03:01:00.000Z",
        });
        expect(started.ok).toBe(true);

        const invalidTarget = probeReadiness({ labId: "readiness-vm", targetId: "other:vm" }, {
            env,
            stateRoot: root,
        });
        expect(invalidTarget).toEqual(expect.objectContaining({ ok: false, error: "target-not-found" }));

        const processOnly = probeReadiness({ labId: "readiness-vm" }, {
            env,
            stateRoot: root,
            processExists: (pid: number) => pid === 4444,
            now: "2026-06-16T03:02:00.000Z",
        });
        expect(processOnly).toEqual(expect.objectContaining({
            ok: true,
            readiness: expect.objectContaining({
                state: "process-running",
                checks: expect.arrayContaining([
                    expect.objectContaining({ name: "runtime-process", status: "pass", pid: 4444 }),
                    expect.objectContaining({ name: "guest-readiness", status: "skipped" }),
                ]),
            }),
            target: expect.objectContaining({ readiness: "process-running", attachable: true }),
        }));
        expect(listTargets({ labId: "readiness-vm" }, { env, stateRoot: root })).toEqual(expect.objectContaining({
            targets: [expect.objectContaining({
                readiness: "process-running",
                readinessProbe: expect.objectContaining({ state: "process-running" }),
            })],
        }));

        const ready = probeReadiness({ labId: "readiness-vm" }, {
            env,
            stateRoot: root,
            processExists: () => true,
            readinessProbeRunner: () => ({
                ok: true,
                ready: true,
                checks: [{ name: "guest-agent", status: "pass" }],
                diagnostics: {
                    kind: "bounded-probe",
                    raw: "unix:/tmp/qemu-monitor.sock,server,nowait",
                    providerArgs: ["-monitor", "unix:/tmp/qemu-monitor.sock,server,nowait", "-drive", "file=/host/private.qcow2"],
                    argv: ["-drive", "file=/host/other.qcow2"],
                    hostPath: "/host/private.qcow2",
                },
                args: ["-monitor", "unix:/tmp/qemu-monitor.sock,server,nowait"],
            }),
            now: "2026-06-16T03:03:00.000Z",
        });
        expect(ready).toEqual(expect.objectContaining({
            ok: true,
            readiness: expect.objectContaining({
                state: "ready",
                checks: expect.arrayContaining([expect.objectContaining({ name: "guest-agent", status: "pass" })]),
            }),
            target: expect.objectContaining({ readiness: "ready" }),
        }));
        expect(JSON.stringify(ready)).not.toContain("qemu-monitor.sock");
        expect(JSON.stringify(ready)).not.toContain("/host/private.qcow2");
        expect(JSON.stringify(ready)).not.toContain("/host/other.qcow2");
    });

    it("uses bounded SSH metadata for default guest readiness and transport without exposing key paths", () => {
        const root = tempRoot();
        const workspace = tempRoot();
        mkdirSync(join(workspace, "src"), { recursive: true });
        writeFileSync(join(workspace, "README.md"), "hello");
        writeFileSync(join(workspace, "src", "app.js"), "console.log('ssh');");
        const env = {
            CCC_PROFILE: "ssh-guest",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const ownerRoot = join(root, "owners", ownerId(env));
        mkdirSync(join(ownerRoot, "keys"), { recursive: true });
        const keyPath = join(ownerRoot, "keys", "id_ed25519");
        writeFileSync(keyPath, "private-key");
        const calls: Array<{ command: string; args: string[] }> = [];
        const sshCommandRunner = (command: string, args: string[]) => {
            calls.push({ command, args });
            return { ok: true, status: 0, command, args, stdout: `ok ${keyPath}`, stderr: "" };
        };

        const created = createLab({
            name: "SSH Guest VM",
            guestSshHost: "127.0.0.1",
            guestSshPort: 2222,
            guestSshUser: "ccc",
            guestSshKeyPath: keyPath,
            guestReadinessCommand: "test -f /tmp/ready",
        }, { env, stateRoot: root });
        const createdLab = created.lab;
        assert.ok(createdLab);
        expect(created).toEqual(expect.objectContaining({
            ok: true,
            lab: expect.objectContaining({
                guest: {
                    ssh: {
                        host: "127.0.0.1",
                        port: 2222,
                        user: "ccc",
                        keyConfigured: true,
                        readinessCommandConfigured: true,
                    },
                },
            }),
        }));
        expect(JSON.stringify(created)).not.toContain(keyPath);

        const started = startLab({ labId: "ssh-guest-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 6161 }),
        });
        expect(started.ok).toBe(true);

        const readiness = probeReadiness({ labId: "ssh-guest-vm" }, {
            env,
            stateRoot: root,
            processExists: () => true,
            sshPath: "/usr/bin/ssh",
            sshCommandRunner,
            now: "2026-06-17T01:00:00.000Z",
        });
        expect(readiness).toEqual(expect.objectContaining({
            ok: true,
            readiness: expect.objectContaining({
                state: "ready",
                checks: expect.arrayContaining([expect.objectContaining({ name: "guest-ssh-readiness", status: "pass" })]),
            }),
        }));
        expect(calls[0]).toEqual(expect.objectContaining({
            command: "/usr/bin/ssh",
            args: expect.arrayContaining(["-p", "2222", "-i", keyPath, "ccc@127.0.0.1", "test -f /tmp/ready"]),
        }));
        expect(JSON.stringify(readiness)).not.toContain(keyPath);
        expect(JSON.stringify(readiness)).not.toContain("private-key");
        expect(JSON.stringify(readiness)).not.toContain("test -f /tmp/ready");

        mkdirSync(createdLab.paths.workspaceDir, { recursive: true });
        writeFileSync(join(createdLab.paths.workspaceDir, "preserve-before-ssh.txt"), "keep");
        const missingSshPush = guestPush({ labId: "ssh-guest-vm", sourcePath: workspace, guestPath: "/workspace/app" }, {
            env,
            stateRoot: root,
            allowedWorkspaceRoots: [workspace],
            sshPath: null,
            scpPath: null,
        });
        expect(missingSshPush).toEqual(expect.objectContaining({
            ok: false,
            error: "guest-ssh-transport-unavailable",
            missing: ["ssh", "scp"],
        }));
        expect(readFileSync(join(createdLab.paths.workspaceDir, "preserve-before-ssh.txt"), "utf8")).toBe("keep");
        expect(existsSync(join(createdLab.paths.workspaceDir, "README.md"))).toBe(false);

        const pushed = guestPush({ labId: "ssh-guest-vm", sourcePath: workspace, guestPath: "/workspace/app" }, {
            env,
            stateRoot: root,
            allowedWorkspaceRoots: [workspace],
            sshPath: "/usr/bin/ssh",
            scpPath: "/usr/bin/scp",
            sshCommandRunner,
            now: "2026-06-17T01:01:00.000Z",
        });
        expect(pushed).toEqual(expect.objectContaining({
            ok: true,
            transport: expect.objectContaining({ guestPath: "/workspace/app", files: 2, bytes: 24 }),
        }));
        expect(calls).toEqual(expect.arrayContaining([
            expect.objectContaining({ command: "/usr/bin/ssh", args: expect.arrayContaining(["ccc@127.0.0.1", "mkdir -p /workspace/app"]) }),
            expect.objectContaining({ command: "/usr/bin/scp", args: expect.arrayContaining(["-P", "2222", "-i", keyPath, "ccc@127.0.0.1:/workspace/app/"]) }),
        ]));
        expect(JSON.stringify(pushed)).not.toContain(keyPath);
        expect(JSON.stringify(pushed)).not.toContain("/usr/bin/scp");

        const preflightPullDir = join(createdLab.paths.artifactsDir, "preflight-pull");
        mkdirSync(preflightPullDir, { recursive: true });
        writeFileSync(join(preflightPullDir, "preserve.txt"), "keep");
        const missingSshPull = guestPull({ labId: "ssh-guest-vm", guestPath: "/artifacts/run", destinationPath: "preflight-pull" }, {
            env,
            stateRoot: root,
            sshPath: null,
            scpPath: null,
        });
        expect(missingSshPull).toEqual(expect.objectContaining({
            ok: false,
            error: "guest-ssh-transport-unavailable",
            missing: ["ssh", "scp"],
        }));
        expect(readFileSync(join(preflightPullDir, "preserve.txt"), "utf8")).toBe("keep");

        const pulled = guestPull({ labId: "ssh-guest-vm", guestPath: "/artifacts/run", destinationPath: "ssh-pull" }, {
            env,
            stateRoot: root,
            sshPath: "/usr/bin/ssh",
            scpPath: "/usr/bin/scp",
            sshCommandRunner,
            now: "2026-06-17T01:02:00.000Z",
        });
        expect(pulled).toEqual(expect.objectContaining({
            ok: true,
            transport: expect.objectContaining({ guestPath: "/artifacts/run", files: 0, bytes: 0 }),
        }));
        expect(calls).toEqual(expect.arrayContaining([
            expect.objectContaining({ command: "/usr/bin/scp", args: expect.arrayContaining(["ccc@127.0.0.1:/artifacts/run/.", expect.stringContaining("ssh-pull/")]) }),
        ]));
        expect(JSON.stringify(pulled)).not.toContain(keyPath);
    });

    it("runs bounded guest commands over configured SSH without exposing provider internals", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "ssh-exec",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const ownerRoot = join(root, "owners", ownerId(env));
        mkdirSync(join(ownerRoot, "keys"), { recursive: true });
        const keyPath = join(ownerRoot, "keys", "id_ed25519");
        writeFileSync(keyPath, "private-key");
        const calls: Array<{ command: string; args: string[]; timeoutMs?: number; cwd?: string }> = [];
        let createdLabDir = "";
        let createdArtifactsDir = "";
        const sshCommandRunner = (command: string, args: string[], runOptions: { timeoutMs?: number; cwd?: string } = {}) => {
            calls.push({ command, args, timeoutMs: runOptions.timeoutMs, cwd: runOptions.cwd });
            return {
                ok: true,
                status: 0,
                command,
                args,
                stdout: `hello ${keyPath} ${createdLabDir}`,
                stderr: `spawnSync ${command} ETIMEDOUT ${createdArtifactsDir}`,
            };
        };

        const created = createLab({
            name: "SSH Exec VM",
            guestSshHost: "127.0.0.1",
            guestSshPort: 2222,
            guestSshUser: "ccc",
            guestSshKeyPath: keyPath,
        }, { env, stateRoot: root });
        const createdLab = created.lab;
        assert.ok(createdLab);
        expect(created.ok).toBe(true);
        createdLabDir = createdLab.paths.labDir;
        createdArtifactsDir = createdLab.paths.artifactsDir;
        const started = startLab({ labId: "ssh-exec-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 6262 }),
        });
        expect(started.ok).toBe(true);

        const executed = guestExec({ labId: "ssh-exec-vm", command: "uname -a", timeoutMs: 999999 }, {
            env,
            stateRoot: root,
            sshPath: "/usr/bin/ssh",
            sshCommandRunner,
        });

        expect(executed).toEqual(expect.objectContaining({
            ok: true,
            timeoutMs: 600000,
            result: {
                ok: true,
                status: 0,
                stdout: "hello <provider-internal> <provider-internal>",
                stderr: "spawnSync <provider-internal> ETIMEDOUT <provider-internal>",
            },
        }));
        expect(executed).not.toHaveProperty("lab");
        expect(calls).toEqual([expect.objectContaining({
            command: "/usr/bin/ssh",
            args: ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=5", "-p", "2222", "-i", keyPath, "ccc@127.0.0.1", "uname -a"],
            timeoutMs: 600000,
            cwd: createdLabDir,
        })]);
        expect(JSON.stringify(executed)).not.toContain(keyPath);
        expect(JSON.stringify(executed)).not.toContain(createdLabDir);
        expect(JSON.stringify(executed)).not.toContain("/usr/bin/ssh");
        expect(JSON.stringify(executed)).not.toContain("uname -a");
        expect(JSON.stringify(executed)).not.toContain("args");
    });

    it("rejects guest exec when lab state or SSH prerequisites are not available", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "ssh-exec-policy",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const ownerRoot = join(root, "owners", ownerId(env));
        mkdirSync(join(ownerRoot, "keys"), { recursive: true });
        const keyPath = join(ownerRoot, "keys", "id_ed25519");
        writeFileSync(keyPath, "private-key");
        const calls: Array<{ command: string; args: string[] }> = [];

        expect(createLab({ name: "No SSH VM" }, { env, stateRoot: root }).ok).toBe(true);
        expect(guestExec({ labId: "no-ssh-vm", command: "id" }, { env, stateRoot: root })).toEqual({
            ok: false,
            error: "lab-not-running",
            labId: "no-ssh-vm",
        });
        expect(startLab({ labId: "no-ssh-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 6363 }),
        }).ok).toBe(true);
        expect(guestExec({ labId: "no-ssh-vm", command: "id" }, { env, stateRoot: root })).toEqual(expect.objectContaining({
            ok: false,
            error: "guest-exec-unavailable",
            reason: "guest-ssh-not-configured",
        }));

        expect(createLab({
            name: "SSH Missing Binary VM",
            guestSshHost: "127.0.0.1",
            guestSshUser: "ccc",
            guestSshKeyPath: keyPath,
        }, { env, stateRoot: root }).ok).toBe(true);
        expect(startLab({ labId: "ssh-missing-binary-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 6464 }),
        }).ok).toBe(true);
        expect(guestExec({ labId: "ssh-missing-binary-vm", command: "id" }, {
            env,
            stateRoot: root,
            sshPath: null,
            sshCommandRunner: (command: string, args: string[]) => {
                calls.push({ command, args });
                return { ok: true, status: 0 };
            },
        })).toEqual(expect.objectContaining({
            ok: false,
            error: "guest-ssh-command-unavailable",
            missing: ["ssh"],
        }));
        expect(calls).toEqual([]);
    });

    it("validates guest exec commands and ignores tampered stored SSH metadata", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "ssh-exec-validation",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const ownerRoot = join(root, "owners", ownerId(env));
        mkdirSync(join(ownerRoot, "keys"), { recursive: true });
        const keyPath = join(ownerRoot, "keys", "id_ed25519");
        writeFileSync(keyPath, "private-key");
        const otherEnv = { CCC_PROFILE: "ssh-exec-other" };
        const otherOwnerRoot = join(root, "owners", ownerId(otherEnv));
        mkdirSync(join(otherOwnerRoot, "keys"), { recursive: true });
        const otherKeyPath = join(otherOwnerRoot, "keys", "id_ed25519");
        writeFileSync(otherKeyPath, "other-private-key");

        const created = createLab({
            name: "SSH Exec Validation VM",
            guestSshHost: "127.0.0.1",
            guestSshUser: "ccc",
            guestSshKeyPath: keyPath,
        }, { env, stateRoot: root });
        const createdLab = created.lab;
        assert.ok(createdLab);
        expect(created.ok).toBe(true);
        expect(startLab({ labId: "ssh-exec-validation-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 6565 }),
        }).ok).toBe(true);

        expect(guestExec({ labId: "ssh-exec-validation-vm", command: "" }, { env, stateRoot: root })).toEqual({
            ok: false,
            error: "missing-guest-command",
        });
        expect(guestExec({ labId: "ssh-exec-validation-vm", command: "echo\u0007bad" }, { env, stateRoot: root })).toEqual({
            ok: false,
            error: "invalid-guest-command",
        });
        expect(guestExec({ labId: "ssh-exec-validation-vm", command: "x".repeat(4097) }, { env, stateRoot: root })).toEqual({
            ok: false,
            error: "invalid-guest-command",
        });

        const tamperedFile = join(createdLab.paths.labDir, "lab.json");
        const rawTampered = JSON.parse(readFileSync(tamperedFile, "utf8"));
        rawTampered.guest.ssh.keyPath = otherKeyPath;
        writeFileSync(tamperedFile, JSON.stringify(rawTampered, null, 2));
        const calls: Array<{ command: string; args: string[] }> = [];
        const tampered = guestExec({ labId: "ssh-exec-validation-vm", command: "id" }, {
            env,
            stateRoot: root,
            sshPath: "/usr/bin/ssh",
            sshCommandRunner: (command: string, args: string[]) => {
                calls.push({ command, args });
                return { ok: true, status: 0, command, args };
            },
        });
        expect(tampered).toEqual(expect.objectContaining({
            ok: false,
            error: "guest-exec-unavailable",
            reason: "guest-ssh-not-configured",
        }));
        expect(calls).toEqual([]);
        expect(JSON.stringify(tampered)).not.toContain(otherKeyPath);
    });

    it("rejects a linked guest SSH key", (context) => {
        const root = tempRoot(), env = { CCC_PROFILE: "ssh-key-link" };
        const ownerRoot = join(root, "owners", ownerId(env));
        mkdirSync(join(ownerRoot, "keys"), { recursive: true });
        const keyPath = join(ownerRoot, "keys", "id_ed25519");
        writeFileSync(keyPath, "private-key");
        fileSymlinkOrSkip(context, keyPath, join(ownerRoot, "keys", "linked"));
        expect(createLab({ name: "Link Key", guestSshHost: "127.0.0.1", guestSshUser: "ccc", guestSshKeyPath: join(ownerRoot, "keys", "linked") }, { env, stateRoot: root })).toEqual(expect.objectContaining({
            ok: false,
            error: "guest-ssh-key-symlink-rejected",
        }));
    });

    it("validates bounded guest SSH metadata before creating labs", () => {
        const root = tempRoot();
        const env = { CCC_PROFILE: "ssh-policy" };
        const ownerRoot = join(root, "owners", ownerId(env));
        mkdirSync(join(ownerRoot, "keys"), { recursive: true });
        const keyPath = join(ownerRoot, "keys", "id_ed25519");
        writeFileSync(keyPath, "private-key");
        const otherEnv = { CCC_PROFILE: "ssh-other" };
        const otherOwnerRoot = join(root, "owners", ownerId(otherEnv));
        mkdirSync(join(otherOwnerRoot, "keys"), { recursive: true });
        const otherKeyPath = join(otherOwnerRoot, "keys", "id_ed25519");
        writeFileSync(otherKeyPath, "other-private-key");

        expect(createLab({ name: "Missing User", guestSshHost: "127.0.0.1" }, { env, stateRoot: root })).toEqual({
            ok: false,
            error: "guest-ssh-requires-host-and-user",
        });
        expect(createLab({ name: "Bad Port", guestSshHost: "127.0.0.1", guestSshUser: "ccc", guestSshPort: 70000 }, { env, stateRoot: root })).toEqual({
            ok: false,
            error: "invalid-guest-ssh-port",
        });
        expect(createLab({ name: "Bad Host", guestSshHost: "bad host", guestSshUser: "ccc" }, { env, stateRoot: root })).toEqual({
            ok: false,
            error: "invalid-guest-ssh-host",
        });
        expect(createLab({ name: "Outside Key", guestSshHost: "127.0.0.1", guestSshUser: "ccc", guestSshKeyPath: "/tmp/outside-key" }, { env, stateRoot: root })).toEqual(expect.objectContaining({
            ok: false,
            error: "guest-ssh-key-path-outside-allowed-roots",
        }));
        expect(createLab({ name: "Other Owner Key", guestSshHost: "127.0.0.1", guestSshUser: "ccc", guestSshKeyPath: otherKeyPath }, { env, stateRoot: root })).toEqual({
            ok: false,
            error: "guest-ssh-key-path-outside-owner-scope",
        });
        const homeStateRoot = mkdtempSync(join(homedir(), "ccc-lab-mcp-home-state-"));
        roots.push(homeStateRoot);
        const homeEnv = { CCC_PROFILE: "ssh-home-owner" };
        const homeOtherEnv = { CCC_PROFILE: "ssh-home-other" };
        const homeOtherRoot = join(homeStateRoot, "owners", ownerId(homeOtherEnv));
        mkdirSync(join(homeOtherRoot, "keys"), { recursive: true });
        const homeOtherKey = join(homeOtherRoot, "keys", "id_ed25519");
        writeFileSync(homeOtherKey, "other-private-key");
        expect(createLab({ name: "Home Other Owner Key", guestSshHost: "127.0.0.1", guestSshUser: "ccc", guestSshKeyPath: homeOtherKey }, { env: homeEnv, stateRoot: homeStateRoot })).toEqual({
            ok: false,
            error: "guest-ssh-key-path-outside-owner-scope",
        });
        const missing = createLab({ name: "Missing Key", guestSshHost: "127.0.0.1", guestSshUser: "ccc", guestSshKeyPath: join(ownerRoot, "keys", "missing") }, { env, stateRoot: root });
        expect(missing).toEqual({ ok: false, error: "guest-ssh-key-not-found" });
        expect(JSON.stringify(missing)).not.toContain(ownerRoot);

        const tampered = createLab({
            name: "Tampered SSH",
            guestSshHost: "127.0.0.1",
            guestSshUser: "ccc",
            guestSshKeyPath: keyPath,
        }, { env, stateRoot: root });
        const tamperedLab = tampered.lab;
        assert.ok(tamperedLab);
        expect(tampered.ok).toBe(true);
        const tamperedEnv = { ...env, CCC_LAB_RUNNER: "1", CCC_LAB_RUNNER_STATUS: "ready" };
        const tamperedFile = join(tamperedLab.paths.labDir, "lab.json");
        const rawTampered = JSON.parse(readFileSync(tamperedFile, "utf8"));
        rawTampered.guest.ssh.keyPath = otherKeyPath;
        writeFileSync(tamperedFile, JSON.stringify(rawTampered, null, 2));
        const startedTampered = startLab({ labId: "tampered-ssh" }, {
            env: tamperedEnv,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 7171 }),
        });
        expect(startedTampered.ok).toBe(true);
        const calls: Array<{ command: string; args: string[] }> = [];
        const tamperedReadiness = probeReadiness({ labId: "tampered-ssh" }, {
            env: tamperedEnv,
            stateRoot: root,
            processExists: () => true,
            sshPath: "/usr/bin/ssh",
            sshCommandRunner: (command: string, args: string[]) => {
                calls.push({ command, args });
                return { ok: true, status: 0, command, args };
            },
        });
        expect(tamperedReadiness).toEqual(expect.objectContaining({
            ok: true,
            readiness: expect.objectContaining({
                state: "process-running",
                checks: expect.arrayContaining([expect.objectContaining({ name: "guest-readiness", status: "skipped" })]),
            }),
        }));
        expect(calls).toEqual([]);
        expect(JSON.stringify(tamperedReadiness)).not.toContain(otherKeyPath);
    });

    it("records failed readiness when a running lab runtime process is gone", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "readiness-fail",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const created = createLab({ name: "Readiness Fail VM" }, { env, stateRoot: root });
        expect(created.ok).toBe(true);
        const started = startLab({ labId: "readiness-fail-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 5555 }),
        });
        expect(started.ok).toBe(true);

        const failed = probeReadiness({ labId: "readiness-fail-vm" }, {
            env,
            stateRoot: root,
            processExists: () => false,
            now: "2026-06-16T03:10:00.000Z",
        });

        expect(failed).toEqual(expect.objectContaining({
            ok: false,
            readiness: expect.objectContaining({
                state: "failed",
                diagnostics: { kind: "runtime-process-not-found" },
            }),
            target: expect.objectContaining({ readiness: "failed", attachable: false }),
        }));
    });

    it("does not expose stale ready probes after a lab stops", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "readiness-stop",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const created = createLab({ name: "Readiness Stop VM" }, { env, stateRoot: root });
        expect(created.ok).toBe(true);
        const started = startLab({ labId: "readiness-stop-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 6666, processIdentity: { pid: 6666, startToken: "fixture-birth", commandHash: "fixture-command" } }),
        });
        expect(started.ok).toBe(true);
        const ready = probeReadiness({ labId: "readiness-stop-vm" }, {
            env,
            stateRoot: root,
            processExists: () => true,
            readinessProbeRunner: () => ({ ready: true }),
        });
        assert.ok("target" in ready && ready.target);
        expect(ready.target).toEqual(expect.objectContaining({ readiness: "ready" }));

        const runtime = runtimeExitFixture(6666);
        const stopped = stopLab({ labId: "readiness-stop-vm" }, {
            env,
            stateRoot: root,
            killProcess: () => { runtime.exit(); },
        });
        const stoppedLab = stopped.lab;
        assert.ok(stoppedLab);
        assert.ok(stoppedLab.readiness);
        expect(stopped.ok).toBe(true);
        expect(stoppedLab.readiness.latest).toBeNull();
        const targets = listTargets({ labId: "readiness-stop-vm" }, { env, stateRoot: root });
        expect(targets).toEqual(expect.objectContaining({
            targets: [expect.objectContaining({
                runtimeState: "stopped",
                readiness: "stopped",
                attachable: false,
                readinessProbe: null,
            })],
        }));
        const session = openSession({ labId: "readiness-stop-vm", sessionId: "stopped-session" }, {
            env,
            stateRoot: root,
        });
        assert.ok("target" in session && session.target);
        expect(session.target).toEqual(expect.objectContaining({
            runtimeState: "stopped",
            readiness: "stopped",
            readinessProbe: null,
        }));
        assert.ok(session.lab?.readiness);
        expect(session.lab.readiness.latest).toBeNull();
    });

    it("reboots running labs through stop/start gates and preserves named lab state", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "reboot",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const created = createLab({ name: "Reboot VM" }, { env, stateRoot: root });
        expect(created.ok).toBe(true);
        const started = startLab({ labId: "reboot-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 1111, processIdentity: { pid: 1111, startToken: "fixture-birth", commandHash: "fixture-command" } }),
            now: "2026-06-16T02:00:00.000Z",
        });
        expect(started.ok).toBe(true);

        const killed: number[] = [];
        const starts: number[] = [];
        const runtime = runtimeExitFixture(1111);
        const rebooted = rebootLab({ labId: "reboot-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            killProcess: (pid: number) => { killed.push(pid); runtime.exit(); },
            commandRunner: () => {
                starts.push(1);
                return { ok: true, pid: 2222 };
            },
            now: "2026-06-16T02:05:00.000Z",
        });

        expect(rebooted.ok).toBe(true);
        expect(killed).toEqual([1111]);
        expect(starts).toEqual([1]);
        expect(rebooted.lab).toEqual(expect.objectContaining({
            id: "reboot-vm",
            runtimeState: "running",
            runtime: expect.objectContaining({ pid: 2222 }),
        }));
        expect(existsSync(join(root, "owners", ownerId(env), "labs", "reboot-vm", "lab.json"))).toBe(true);
    });

    it("requires explicit startIfStopped and provider readiness for stopped lab reboot", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "reboot-stopped",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const created = createLab({ name: "Stopped Reboot VM" }, { env, stateRoot: root });
        expect(created.ok).toBe(true);

        expect(rebootLab({ labId: "stopped-reboot-vm" }, { env, stateRoot: root })).toEqual(expect.objectContaining({
            ok: false,
            error: "lab-not-running",
        }));

        const unsupported = rebootLab({ labId: "stopped-reboot-vm", startIfStopped: true }, {
            env: { ...env, CCC_LAB_RUNNER_STATUS: "unsupported", CCC_LAB_RUNNER_UNSUPPORTED_REASON: "no kvm" },
            stateRoot: root,
        });
        expect(unsupported).toEqual(expect.objectContaining({
            ok: false,
            error: "lab-provider-unsupported",
            providerStatus: expect.objectContaining({ unsupportedReason: "no kvm" }),
        }));
    });

    it("preflights provider readiness before stopping a running lab for reboot", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "reboot-preflight",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const created = createLab({ name: "Preflight VM" }, { env, stateRoot: root });
        expect(created.ok).toBe(true);
        const started = startLab({ labId: "preflight-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 3333 }),
        });
        expect(started.ok).toBe(true);

        const killed: number[] = [];
        const rebooted = rebootLab({ labId: "preflight-vm" }, {
            env: { ...env, CCC_LAB_RUNNER_STATUS: "unsupported", CCC_LAB_RUNNER_UNSUPPORTED_REASON: "no kvm" },
            stateRoot: root,
            killProcess: (pid: number) => { killed.push(pid); },
        });

        expect(rebooted).toEqual(expect.objectContaining({
            ok: false,
            error: "lab-provider-unsupported",
            lab: expect.objectContaining({ runtimeState: "running", runtime: expect.objectContaining({ pid: 3333 }) }),
        }));
        expect(killed).toEqual([]);
        expect(listLabs({ env, stateRoot: root }).labs[0]).toEqual(expect.objectContaining({
            runtimeState: "running",
            runtime: expect.objectContaining({ pid: 3333 }),
        }));
    });

    it("records snapshots and invokes qemu-img snapshot commands for existing disks", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "snap",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const created = createLab({ name: "Snapshot VM" }, { env, stateRoot: root });
        const createdLab = created.lab;
        assert.ok(createdLab);
        expect(created.ok).toBe(true);
        writeFileSync(createdLab.image.diskImage, "");

        const commands: Array<{ command: string; args: string[] }> = [];
        const options = {
            env,
            stateRoot: root,
            qemuImgPath: "/usr/bin/qemu-img",
            commandRunner: (command: string, args: string[]) => {
                commands.push({ command, args });
                return { ok: true, command, args };
            },
        };

        const snap = snapshotLab("create", { labId: "snapshot-vm", snapshotName: "Clean Base" }, options);
        expect(snap.ok).toBe(true);
        expect(snap.lab.snapshots.map((snapshot: unknown) => { assert.ok(snapshot && typeof snapshot === "object" && "name" in snapshot);return snapshot.name; })).toEqual(["clean-base"]);

        const restore = snapshotLab("restore", { labId: "snapshot-vm", snapshotName: "clean-base" }, options);
        expect(restore.ok).toBe(true);
        expect(restore.lab.activeSnapshot).toBe("clean-base");

        const deleted = snapshotLab("delete", { labId: "snapshot-vm", snapshotName: "clean-base" }, options);
        expect(deleted.ok).toBe(true);
        expect(deleted.lab.snapshots).toEqual([]);
        expect(commands.map((entry) => entry.args.slice(0, 3))).toEqual([
            ["snapshot", "-c", "clean-base"],
            ["snapshot", "-a", "clean-base"],
            ["snapshot", "-d", "clean-base"],
        ]);
    });

    it("keeps snapshot metadata unchanged after a failed native snapshot command", () => {
        const root = tempRoot(), env = { CCC_PROFILE: "snapshot-failure" };
        const created = createLab({ name: "Snapshot Failure" }, { env, stateRoot: root });
        assert.ok(created.lab);
        writeFileSync(created.lab.image.diskImage, "disk");
        const metadata = join(created.lab.paths.labDir, "lab.json");
        const before = readFileSync(metadata, "utf8");
        const failed = snapshotLab("create", { labId: created.lab.id, snapshotName: "baseline" }, {
            env, stateRoot: root, qemuImgPath: "/usr/bin/qemu-img", commandRunner: () => ({ ok: false, status: 7 }),
        });
        expect(failed).toMatchObject({ ok: false, error: "qemu-img-snapshot-failed", result: { status: 7 } });
        expect(readFileSync(metadata, "utf8")).toBe(before);
    });

    it("lists snapshots while running but refuses mutation and permits stopped metadata-only snapshots", () => {
        const root = tempRoot(), env = { CCC_PROFILE: "snapshot-metadata", CCC_LAB_RUNNER: "1", CCC_LAB_RUNNER_STATUS: "ready" };
        const created = createLab({ name: "Snapshot Metadata" }, { env, stateRoot: root });
        assert.ok(created.lab);
        const options = { env, stateRoot: root, commandRunner: () => { throw new Error("unexpected disk command"); } };
        expect(snapshotLab("create", { labId: created.lab.id, snapshotName: "baseline" }, options)).toMatchObject({ ok: true, disk: { diskSnapshot: false } });
        expect(snapshotLab("create", { labId: created.lab.id, snapshotName: "baseline" }, options)).toMatchObject({ ok: false, error: "snapshot-already-exists" });
        expect(snapshotLab("restore", { labId: created.lab.id, snapshotName: "missing" }, options)).toMatchObject({ ok: false, error: "snapshot-not-found" });
        expect(snapshotLab("delete", { labId: created.lab.id, snapshotName: "missing" }, options)).toMatchObject({ ok: false, error: "snapshot-not-found" });
        expect(startLab({ labId: created.lab.id }, { env, stateRoot: root, qemuPath: "/usr/bin/qemu-system-x86_64", kvmAvailable: true, commandRunner: () => ({ ok: true, pid: 5152 }) }).ok).toBe(true);
        expect(snapshotLab("list", { labId: created.lab.id }, options)).toMatchObject({ ok: true, snapshots: [{ name: "baseline" }], activeSnapshot: null });
        expect(snapshotLab("delete", { labId: created.lab.id, snapshotName: "baseline" }, options)).toMatchObject({ ok: false, error: "lab-running" });
    });

    it("syncs an allowed workspace tree into owner-scoped lab state and records metadata", () => {
        const root = tempRoot();
        const workspace = mkdtempSync(join(tmpdir(), "ccc-lab-workspace-"));
        roots.push(workspace);
        mkdirSync(join(workspace, "src"), { recursive: true });
        writeFileSync(join(workspace, "README.md"), "hello");
        writeFileSync(join(workspace, "src", "app.js"), "console.log('ok');");
        const env = { CCC_PROFILE: "sync" };
        const created = createLab({ name: "Sync VM" }, { env, stateRoot: root });
        const createdLab = created.lab;
        assert.ok(createdLab);
        expect(created.ok).toBe(true);

        const synced = syncWorkspace({ labId: "sync-vm", sourcePath: workspace }, {
            env,
            stateRoot: root,
            allowedWorkspaceRoots: [workspace],
            now: "2026-06-16T01:00:00.000Z",
        });

        expect(synced.ok).toBe(true);
        expect(readFileSync(join(createdLab.paths.workspaceDir, "README.md"), "utf8")).toBe("hello");
        expect(readFileSync(join(createdLab.paths.workspaceDir, "src", "app.js"), "utf8")).toBe("console.log('ok');");
        expect(synced.result).toEqual(expect.objectContaining({ files: 2, bytes: 23 }));
        expect(synced.lab.fileOperations).toEqual([
            expect.objectContaining({
                type: "sync_workspace",
                sourcePath: workspace,
                destinationPath: createdLab.paths.workspaceDir,
                files: 2,
                bytes: 23,
            }),
        ]);
    });

    it("retains copied workspace bytes when native metadata publication throws", () => {
        const root = tempRoot(), env = { CCC_PROFILE: "sync-publication" };
        const source = join(root, "source"); mkdirSync(source); writeFileSync(join(source, "file.txt"), "copied");
        const created = createLab({ name: "Sync Publication" }, { env, stateRoot: root });
        assert.ok(created.lab);
        const metadata = join(created.lab.paths.labDir, "lab.json"), before = readFileSync(metadata, "utf8");
        const rename = nativeFs.renameSync, fault = new Error("native publication failed");
        const hook = vi.spyOn(nativeFs, "renameSync").mockImplementation((from, to) => {
            if (String(to) === metadata) throw fault;
            return rename(from, to);
        });
        let observed: unknown;
        try { syncWorkspace({ labId: created.lab.id, sourcePath: source }, { env, stateRoot: root, allowedWorkspaceRoots: [source] }); }
        catch (error) { observed = error; }
        finally { hook.mockRestore(); }
        expect(observed).toBe(fault);
        expect(readFileSync(join(created.lab.paths.workspaceDir, "file.txt"), "utf8")).toBe("copied");
        expect(readFileSync(metadata, "utf8")).toBe(before);
    });

    it("exports bounded lab artifacts to an owner-scoped export directory and records metadata", () => {
        const root = tempRoot();
        const env = { CCC_PROFILE: "export" };
        const created = createLab({ name: "Export VM" }, { env, stateRoot: root });
        const createdLab = created.lab;
        assert.ok(createdLab);
        expect(created.ok).toBe(true);
        mkdirSync(join(createdLab.paths.artifactsDir, "screens"), { recursive: true });
        writeFileSync(join(createdLab.paths.artifactsDir, "screens", "shot.txt"), "pixels");

        const exported = exportArtifacts({
            labId: "export-vm",
            sourcePath: "screens",
            destinationPath: "run-1",
        }, { env, stateRoot: root, now: "2026-06-16T02:00:00.000Z" });

        expect(exported.ok).toBe(true);
        expect(readFileSync(join(createdLab.paths.exportsDir, "run-1", "shot.txt"), "utf8")).toBe("pixels");
        expect(exported.lab.fileOperations).toEqual([
            expect.objectContaining({
                type: "export_artifacts",
                sourcePath: join(createdLab.paths.artifactsDir, "screens"),
                destinationPath: join(createdLab.paths.exportsDir, "run-1"),
                files: 1,
                bytes: 6,
            }),
        ]);
    });

    it("plans and invokes bounded guest push and pull through an injected runner", () => {
        const root = tempRoot();
        const workspace = mkdtempSync(join(tmpdir(), "ccc-lab-guest-workspace-"));
        roots.push(workspace);
        mkdirSync(join(workspace, "src"), { recursive: true });
        writeFileSync(join(workspace, "README.md"), "hello");
        writeFileSync(join(workspace, "src", "app.js"), "console.log('guest');");
        const env = {
            CCC_PROFILE: "guest-transport",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const created = createLab({ name: "Guest Transport VM" }, { env, stateRoot: root });
        const createdLab = created.lab;
        assert.ok(createdLab);
        expect(created.ok).toBe(true);
        const started = startLab({ labId: "guest-transport-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 5150 }),
        });
        expect(started.ok).toBe(true);

        const dryPush = guestPush({ labId: "guest-transport-vm", sourcePath: workspace, guestPath: "/workspace/app", dryRun: true }, {
            env,
            stateRoot: root,
            allowedWorkspaceRoots: [workspace],
        });
        expect(dryPush).toEqual(expect.objectContaining({
            ok: true,
            dryRun: true,
            transport: expect.objectContaining({
                action: "push",
                guestPath: "/workspace/app",
                files: 2,
                bytes: 26,
            }),
        }));

        mkdirSync(createdLab.paths.workspaceDir, { recursive: true });
        writeFileSync(join(createdLab.paths.workspaceDir, "preserve.txt"), "keep");
        const unavailable = guestPush({ labId: "guest-transport-vm", sourcePath: workspace, guestPath: "/workspace/app" }, {
            env,
            stateRoot: root,
            allowedWorkspaceRoots: [workspace],
        });
        expect(unavailable).toEqual(expect.objectContaining({
            ok: false,
            error: "guest-transport-unavailable",
        }));
        expect(readFileSync(join(createdLab.paths.workspaceDir, "preserve.txt"), "utf8")).toBe("keep");
        expect(existsSync(join(createdLab.paths.workspaceDir, "README.md"))).toBe(false);

        const existingPullDir = join(createdLab.paths.artifactsDir, "existing-pull");
        mkdirSync(existingPullDir, { recursive: true });
        writeFileSync(join(existingPullDir, "preserve.txt"), "keep");
        const unavailablePull = guestPull({ labId: "guest-transport-vm", guestPath: "/artifacts/run-1", destinationPath: "existing-pull" }, {
            env,
            stateRoot: root,
        });
        expect(unavailablePull).toEqual(expect.objectContaining({
            ok: false,
            error: "guest-transport-unavailable",
        }));
        expect(readFileSync(join(existingPullDir, "preserve.txt"), "utf8")).toBe("keep");

        const calls: unknown[] = [];
        const pushed = guestPush({ labId: "guest-transport-vm", sourcePath: workspace, guestPath: "/workspace/app" }, {
            env,
            stateRoot: root,
            allowedWorkspaceRoots: [workspace],
            guestTransportRunner: (transport: unknown) => {
                calls.push(transport);
                return { ok: true, command: "ssh", args: ["secret"], socketPath: "/tmp/socket", copied: true, message: "ssh token secret /tmp/socket" };
            },
            now: "2026-06-16T06:00:00.000Z",
        });
        expect(pushed).toEqual(expect.objectContaining({
            ok: true,
            result: expect.objectContaining({ ok: true, copied: true, message: "<provider-internal>" }),
            transport: expect.objectContaining({ guestPath: "/workspace/app", files: 2, bytes: 26 }),
        }));
        expect(readFileSync(join(createdLab.paths.workspaceDir, "README.md"), "utf8")).toBe("hello");
        expect(JSON.stringify(pushed)).not.toContain("secret");
        expect(JSON.stringify(pushed)).not.toContain("token");
        expect(JSON.stringify(pushed)).not.toContain("ssh");
        expect(JSON.stringify(pushed)).not.toContain("socket");
        expect(calls).toEqual([
            expect.objectContaining({
                action: "push",
                stagedPath: createdLab.paths.workspaceDir,
                guestPath: "/workspace/app",
                files: 2,
                bytes: 26,
            }),
        ]);
        expect(pushed.lab.fileOperations).toEqual([
            expect.objectContaining({
                type: "guest_push",
                guestPath: "/workspace/app",
                files: 2,
                bytes: 26,
            }),
        ]);

        const pulled = guestPull({ labId: "guest-transport-vm", guestPath: "/artifacts/run-1", destinationPath: "guest-run" }, {
            env,
            stateRoot: root,
            guestTransportRunner: (transport: { destinationPath: string }) => {
                mkdirSync(join(transport.destinationPath, "logs"), { recursive: true });
                writeFileSync(join(transport.destinationPath, "logs", "out.txt"), "ok");
                return { ok: true, command: "scp", args: ["hidden"], pulled: true };
            },
            now: "2026-06-16T06:01:00.000Z",
        });
        expect(pulled).toEqual(expect.objectContaining({
            ok: true,
            result: { ok: true, pulled: true },
            transport: expect.objectContaining({ guestPath: "/artifacts/run-1", files: 1, bytes: 2 }),
        }));
        expect(readFileSync(join(createdLab.paths.artifactsDir, "guest-run", "logs", "out.txt"), "utf8")).toBe("ok");
        expect(JSON.stringify(pulled)).not.toContain("hidden");
        expect(pulled.lab.fileOperations).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: "guest_pull",
                guestPath: "/artifacts/run-1",
                destinationPath: join(createdLab.paths.artifactsDir, "guest-run"),
                files: 1,
                bytes: 2,
            }),
        ]));
    });

    it("retains the current pull destination when transport throws before recording completion", () => {
        const root = tempRoot();
        const env = { CCC_PROFILE: "guest-throw", CCC_LAB_RUNNER: "1", CCC_LAB_RUNNER_STATUS: "ready" };
        const created = createLab({ name: "Guest Throw VM" }, { env, stateRoot: root });
        assert.ok(created.lab);
        const started = startLab({ labId: "guest-throw-vm" }, {
            env, stateRoot: root, qemuPath: "/usr/bin/qemu-system-x86_64", kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 5151 }),
        });
        assert.ok(started.lab);
        expect(started.ok).toBe(true);
        const destination = join(created.lab.paths.artifactsDir, "current");
        mkdirSync(destination, { recursive: true });
        writeFileSync(join(destination, "old.txt"), "old");
        const fault = new Error("transport interrupted");
        let observed: unknown;
        try { guestPull({ labId: "guest-throw-vm", guestPath: "/artifacts/run", destinationPath: "current" }, {
            env, stateRoot: root,
            guestTransportRunner: (transport: { destinationPath: string }) => {
                writeFileSync(join(transport.destinationPath, "partial.txt"), "partial");
                throw fault;
            },
        }); } catch (error) { observed = error; }
        expect(observed).toBe(fault);
        expect(existsSync(join(destination, "old.txt"))).toBe(false);
        expect(readFileSync(join(destination, "partial.txt"), "utf8")).toBe("partial");
        const persisted = JSON.parse(readFileSync(join(created.lab.paths.labDir, "lab.json"), "utf8"));
        expect(persisted.fileOperations ?? []).toEqual([]);
        expect(persisted.runtimeState).toBe("running");
    });

    it("rejects unsafe guest transport paths and stopped labs", () => {
        const root = tempRoot();
        const workspace = mkdtempSync(join(tmpdir(), "ccc-lab-guest-policy-workspace-"));
        roots.push(workspace);
        writeFileSync(join(workspace, "README.md"), "hello");
        const env = {
            CCC_PROFILE: "guest-policy",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        createLab({ name: "Guest Policy VM" }, { env, stateRoot: root });
        expect(guestPush({ labId: "guest-policy-vm", sourcePath: workspace, guestPath: "/workspace" }, {
            env,
            stateRoot: root,
            allowedWorkspaceRoots: [workspace],
        })).toEqual(expect.objectContaining({ ok: false, error: "lab-not-running" }));

        const started = startLab({ labId: "guest-policy-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 6161 }),
        });
        const startedLab = started.lab;
        assert.ok(startedLab);
        expect(started.ok).toBe(true);
        expect(guestPush({ labId: "guest-policy-vm", sourcePath: workspace, guestPath: "/etc/passwd" }, {
            env,
            stateRoot: root,
            allowedWorkspaceRoots: [workspace],
            guestTransportRunner: () => ({ ok: true }),
        })).toEqual(expect.objectContaining({
            ok: false,
            error: "guest-path-outside-allowed-roots",
            guestPath: "/etc/passwd",
        }));
        expect(guestPush({ labId: "guest-policy-vm", sourcePath: workspace, guestPath: "/workspace/../escape" }, {
            env,
            stateRoot: root,
            allowedWorkspaceRoots: [workspace],
            guestTransportRunner: () => ({ ok: true }),
        })).toEqual(expect.objectContaining({ ok: false, error: "guest-path-path-traversal-rejected" }));
        expect(guestPull({ labId: "guest-policy-vm", guestPath: "/artifacts/run", destinationPath: "/tmp/export" }, {
            env,
            stateRoot: root,
            guestTransportRunner: () => ({ ok: true }),
        })).toEqual(expect.objectContaining({
            ok: false,
            error: "guest-pull-destination-outside-artifacts",
            destinationPath: resolve("/tmp/export"),
        }));

        const failedPush = guestPush({ labId: "guest-policy-vm", sourcePath: workspace, guestPath: "/workspace/fail" }, {
            env,
            stateRoot: root,
            allowedWorkspaceRoots: [workspace],
            guestTransportRunner: () => ({ ok: false, message: "failed(path=/tmp/ccc.sock)" }),
            now: "2026-06-16T07:00:00.000Z",
        });
        expect(failedPush).toEqual(expect.objectContaining({
            ok: false,
            error: "guest-push-failed",
            cleanedStagedPath: true,
            result: { ok: false, message: "<provider-internal>" },
        }));
        expect(existsSync(startedLab.paths.workspaceDir)).toBe(false);
        expect(failedPush.lab.fileOperations).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: "guest_push_failed",
                guestPath: "/workspace/fail",
                error: "guest-push-failed",
            }),
        ]));

        const partialDestination = join(startedLab.paths.artifactsDir, "partial");
        const failedPull = guestPull({ labId: "guest-policy-vm", guestPath: "/artifacts/run", destinationPath: "partial" }, {
            env,
            stateRoot: root,
            guestTransportRunner: (transport: { destinationPath: string }) => {
                writeFileSync(join(transport.destinationPath, "partial.txt"), "partial");
                return { ok: false, message: "scp failed /tmp/partial.sock" };
            },
            now: "2026-06-16T07:01:00.000Z",
        });
        expect(failedPull).toEqual(expect.objectContaining({
            ok: false,
            error: "guest-pull-failed",
            cleanedDestination: true,
            result: { ok: false, message: "<provider-internal>" },
        }));
        expect(existsSync(partialDestination)).toBe(false);
        expect(failedPull.lab.fileOperations).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: "guest_pull_failed",
                guestPath: "/artifacts/run",
                destinationPath: partialDestination,
                error: "guest-pull-failed",
            }),
        ]));

        const outside = mkdtempSync(join(tmpdir(), "ccc-lab-guest-pull-outside-"));
        roots.push(outside);
        mkdirSync(join(startedLab.paths.artifactsDir), { recursive: true });
        symlinkSync(outside, join(startedLab.paths.artifactsDir, "link"), process.platform === "win32" ? "junction" : "dir");
        expect(guestPull({ labId: "guest-policy-vm", guestPath: "/artifacts/run", destinationPath: "link/out" }, {
            env,
            stateRoot: root,
            guestTransportRunner: (transport: { destinationPath: string }) => {
                mkdirSync(transport.destinationPath, { recursive: true });
                writeFileSync(join(transport.destinationPath, "out.txt"), "outside");
                return { ok: true };
            },
        })).toEqual(expect.objectContaining({
            ok: false,
            error: "guest-pull-destination-symlink-ancestor-rejected",
            ancestorPath: join(startedLab.paths.artifactsDir, "link"),
        }));
        expect(existsSync(join(outside, "out", "out.txt"))).toBe(false);

        const secretDestination = join(startedLab.paths.artifactsDir, "secret-pull");
        const secret = guestPull({ labId: "guest-policy-vm", guestPath: "/artifacts/run", destinationPath: "secret-pull" }, {
            env,
            stateRoot: root,
            guestTransportRunner: (transport: { destinationPath: string }) => {
                writeFileSync(join(transport.destinationPath, ".env"), "TOKEN=secret");
                return { ok: true };
            },
        });
        expect(secret).toEqual(expect.objectContaining({
            ok: false,
            error: "copy-source-secret-looking-file",
            path: ".env",
            lab: expect.objectContaining({
                fileOperations: expect.arrayContaining([
                    expect.objectContaining({
                        type: "guest_pull_failed",
                        guestPath: "/artifacts/run",
                        destinationPath: secretDestination,
                        error: "copy-source-secret-looking-file",
                    }),
                ]),
            }),
            cleanedDestination: true,
            destinationPath: secretDestination,
        }));
        expect(existsSync(secretDestination)).toBe(false);

        const secretContentDestination = join(startedLab.paths.artifactsDir, "secret-content-pull");
        const secretContent = guestPull({ labId: "guest-policy-vm", guestPath: "/artifacts/run", destinationPath: "secret-content-pull" }, {
            env,
            stateRoot: root,
            guestTransportRunner: (transport: { destinationPath: string }) => {
                writeFileSync(join(transport.destinationPath, "config.txt"), "API_KEY=guest-secret-value-12345");
                return { ok: true };
            },
        });
        expect(secretContent).toEqual(expect.objectContaining({
            ok: false,
            error: "copy-source-secret-content",
            path: "config.txt",
            pattern: "secret-assignment",
            cleanedDestination: true,
            destinationPath: secretContentDestination,
        }));
        expect(JSON.stringify(secretContent)).not.toContain("guest-secret-value-12345");
        expect(existsSync(secretContentDestination)).toBe(false);
    });

    it("rejects workspace source paths outside allowed roots before copying", () => {
        const root = tempRoot();
        const workspace = mkdtempSync(join(tmpdir(), "ccc-lab-outside-workspace-"));
        const allowed = mkdtempSync(join(tmpdir(), "ccc-lab-allowed-workspace-"));
        roots.push(workspace, allowed);
        writeFileSync(join(workspace, "file.txt"), "outside");
        const env = { CCC_PROFILE: "policy" };
        createLab({ name: "Policy VM" }, { env, stateRoot: root });

        const result = syncWorkspace({ labId: "policy-vm", sourcePath: workspace }, {
            env,
            stateRoot: root,
            allowedWorkspaceRoots: [allowed],
        });

        expect(result).toEqual(expect.objectContaining({
            ok: false,
            error: "workspace-source-outside-allowed-roots",
            sourcePath: workspace,
            allowedRoots: [allowed],
        }));
    });

    it("rejects file symlinks before workspace sync", (context) => {
        const root = tempRoot();
        const workspace = mkdtempSync(join(tmpdir(), "ccc-lab-linked-workspace-"));
        roots.push(workspace);
        const env = { CCC_PROFILE: "secret" };
        createLab({ name: "Secret VM" }, { env, stateRoot: root });
        writeFileSync(join(workspace, "target.txt"), "target");
        fileSymlinkOrSkip(context, join(workspace, "target.txt"), join(workspace, "link.txt"));
        const link = syncWorkspace({ labId: "secret-vm", sourcePath: workspace }, {
            env,
            stateRoot: root,
            allowedWorkspaceRoots: [workspace],
        });
        expect(link).toEqual(expect.objectContaining({ ok: false, error: "copy-source-symlink-rejected", path: "link.txt" }));
    });

    it("rejects secret-looking filenames before workspace sync", () => {
        const root = tempRoot();
        const workspace = mkdtempSync(join(tmpdir(), "ccc-lab-secret-workspace-"));
        roots.push(workspace);
        const env = { CCC_PROFILE: "secret" };
        createLab({ name: "Secret VM" }, { env, stateRoot: root });

        writeFileSync(join(workspace, ".env"), "TOKEN=secret");
        const secret = syncWorkspace({ labId: "secret-vm", sourcePath: workspace }, {
            env,
            stateRoot: root,
            allowedWorkspaceRoots: [workspace],
        });
        expect(secret).toEqual(expect.objectContaining({ ok: false, error: "copy-source-secret-looking-file", path: ".env" }));


    });

    it("rejects secret content before workspace sync and guest push", () => {
        const root = tempRoot();
        const workspace = mkdtempSync(join(tmpdir(), "ccc-lab-secret-content-workspace-"));
        roots.push(workspace);
        const secretValue = "ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD";
        const env = {
            CCC_PROFILE: "secret-content",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        createLab({ name: "Secret Content VM" }, { env, stateRoot: root });
        writeFileSync(join(workspace, "config.txt"), `token=${secretValue}\n`);

        const sync = syncWorkspace({ labId: "secret-content-vm", sourcePath: workspace }, {
            env,
            stateRoot: root,
            allowedWorkspaceRoots: [workspace],
        });
        expect(sync).toEqual(expect.objectContaining({
            ok: false,
            error: "copy-source-secret-content",
            path: "config.txt",
            pattern: "github-token",
        }));
        expect(JSON.stringify(sync)).not.toContain(secretValue);

        const started = startLab({ labId: "secret-content-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 6262 }),
        });
        expect(started.ok).toBe(true);

        const push = guestPush({ labId: "secret-content-vm", sourcePath: workspace, guestPath: "/workspace/app" }, {
            env,
            stateRoot: root,
            allowedWorkspaceRoots: [workspace],
            guestTransportRunner: () => ({ ok: true }),
        });
        expect(push).toEqual(expect.objectContaining({
            ok: false,
            error: "copy-source-secret-content",
            path: "config.txt",
            pattern: "github-token",
        }));
        expect(JSON.stringify(push)).not.toContain(secretValue);
    });

    it("returns a structured policy error when secret content scanning cannot read a workspace file", () => {
        const root = tempRoot();
        const workspace = mkdtempSync(join(tmpdir(), "ccc-lab-unreadable-workspace-"));
        roots.push(workspace);
        const env = { CCC_PROFILE: "unreadable-content" };
        const unreadable = join(workspace, "unreadable.txt");
        createLab({ name: "Unreadable Content VM" }, { env, stateRoot: root });
        writeFileSync(unreadable, "not-secret");
        chmodSync(unreadable, 0o000);

        try {
            try {
                readFileSync(unreadable, "utf8");
                return;
            } catch {
                // Expected on non-root test runners; root can still read 000 files.
            }

            const result = syncWorkspace({ labId: "unreadable-content-vm", sourcePath: workspace }, {
                env,
                stateRoot: root,
                allowedWorkspaceRoots: [workspace],
            });

            expect(result).toEqual(expect.objectContaining({
                ok: false,
                error: "copy-source-content-scan-failed",
                path: "unreadable.txt",
            }));
            expect(JSON.stringify(result)).not.toContain("not-secret");
        } finally {
            chmodSync(unreadable, 0o600);
        }
    });

    it("rejects oversized workspace files and excessive file counts before copying", () => {
        const root = tempRoot();
        const workspace = mkdtempSync(join(tmpdir(), "ccc-lab-limit-workspace-"));
        roots.push(workspace);
        const env = { CCC_PROFILE: "limits" };
        createLab({ name: "Limit VM" }, { env, stateRoot: root });

        writeFileSync(join(workspace, "big.txt"), "12345");
        const tooLarge = syncWorkspace({ labId: "limit-vm", sourcePath: workspace, maxFileBytes: 4 }, {
            env,
            stateRoot: root,
            allowedWorkspaceRoots: [workspace],
        });
        expect(tooLarge).toEqual(expect.objectContaining({ ok: false, error: "copy-source-file-too-large", path: "big.txt" }));

        rmSync(join(workspace, "big.txt"));
        writeFileSync(join(workspace, "a.txt"), "a");
        writeFileSync(join(workspace, "b.txt"), "b");
        const tooMany = syncWorkspace({ labId: "limit-vm", sourcePath: workspace, maxFiles: 1 }, {
            env,
            stateRoot: root,
            allowedWorkspaceRoots: [workspace],
        });
        expect(tooMany).toEqual(expect.objectContaining({ ok: false, error: "copy-source-too-many-files", maxFiles: 1 }));

        const tooLargeTree = syncWorkspace({ labId: "limit-vm", sourcePath: workspace, maxTotalBytes: 1 }, {
            env,
            stateRoot: root,
            allowedWorkspaceRoots: [workspace],
        });
        expect(tooLargeTree).toEqual(expect.objectContaining({ ok: false, error: "copy-source-too-large", maxTotalBytes: 1 }));
    });

    it("rejects artifact source and destination paths outside lab-owned roots", () => {
        const root = tempRoot();
        const outside = mkdtempSync(join(tmpdir(), "ccc-lab-outside-artifact-"));
        roots.push(outside);
        const env = { CCC_PROFILE: "artifact-policy" };
        createLab({ name: "Artifact Policy VM" }, { env, stateRoot: root });

        const source = exportArtifacts({ labId: "artifact-policy-vm", sourcePath: outside }, { env, stateRoot: root });
        expect(source).toEqual(expect.objectContaining({
            ok: false,
            error: "artifact-source-outside-lab-roots",
            sourcePath: outside,
        }));

        const traversal = exportArtifacts({ labId: "artifact-policy-vm", sourcePath: "../escape" }, { env, stateRoot: root });
        expect(traversal).toEqual(expect.objectContaining({ ok: false, error: "invalid-source-path" }));

        const destination = exportArtifacts({ labId: "artifact-policy-vm", destinationPath: "/tmp/export" }, { env, stateRoot: root });
        expect(destination).toEqual(expect.objectContaining({
            ok: false,
            error: "artifact-destination-outside-allowed-roots",
            destinationPath: resolve("/tmp/export"),
        }));

        const otherOwner = join(root, "owners", "other-owner", "exports", "artifact-policy-vm");
        const ownerEscape = exportArtifacts({ labId: "artifact-policy-vm", destinationPath: otherOwner }, { env, stateRoot: root });
        expect(ownerEscape).toEqual(expect.objectContaining({
            ok: false,
            error: "artifact-destination-outside-allowed-roots",
            destinationPath: otherOwner,
        }));
    });

    it("rejects secret content before artifact export", () => {
        const root = tempRoot();
        const env = { CCC_PROFILE: "artifact-secret-content" };
        const created = createLab({ name: "Artifact Secret Content VM" }, { env, stateRoot: root });
        const createdLab = created.lab;
        assert.ok(createdLab);
        const secretValue = "AKIA1234567890ABCDEF";
        mkdirSync(createdLab.paths.artifactsDir, { recursive: true });
        writeFileSync(join(createdLab.paths.artifactsDir, "result.txt"), `aws=${secretValue}\n`);

        const exported = exportArtifacts({ labId: "artifact-secret-content-vm" }, { env, stateRoot: root });

        expect(exported).toEqual(expect.objectContaining({
            ok: false,
            error: "copy-source-secret-content",
            path: "result.txt",
            pattern: "aws-access-key-id",
        }));
        expect(JSON.stringify(exported)).not.toContain(secretValue);
    });
});
