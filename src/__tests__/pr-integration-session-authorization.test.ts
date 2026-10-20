import { describe, expect, it } from "vitest";
import { createSessionCleanup } from "../application/session-cleanup.js";
import { createSessionOwnershipGuardian } from "../application/session-ownership.js";
import type { SessionCleanupPorts } from "../ports/session-cleanup.js";
import type { SessionOwnershipGuardianPorts, SessionOwnershipMessage } from "../ports/session-ownership.js";

import { validateNativeRuntimeInvocation } from "../adapters/container-runtime-invocation.js";
import { NATIVE_RUNTIME_SELECTOR_KEYS, type NativeRuntimeInvocation, type NativeRuntimeSelectors } from "../ports/container-runtime-invocation.js";

const runtimeInvocation: NativeRuntimeInvocation = validateNativeRuntimeInvocation({
    version: 1, runtime: "docker", executable: process.execPath,
    transport: { kind: "docker", host: "unix:///fixture/engine-a.sock", configDirectory: "/fixture/config-a",
        tls: { enabled: false, verify: false, caFile: null, certFile: null, keyFile: null } },
    selectors: Object.fromEntries(NATIVE_RUNTIME_SELECTOR_KEYS.map(key => [key, null])) as NativeRuntimeSelectors,
});

const id = "a".repeat(64);
const successorId = "b".repeat(64);
const binding = { lockFile: "/fixture/owner.lock", projectPath: "/fixture/project", toolName: "codex" };
const receipt = { path: binding.lockFile, bytes: "NDI=", device: "1", inode: "2", birthtime: "3", ownerPid: 42 };

function cleanupFixture() {
    const trace: unknown[][] = [];
    let other = false;
    const ports: SessionCleanupPorts = {
        projectId: () => "fixture-project",
        withLifecycleLock: (_prefix, run) => run(),
        peerVetoes: () => ({ sharedDeviceCleanupBlocked: other, exactContainerStopBlocked: other, responsibilityTransferred: false }),
        removeClaim: path => { trace.push(["remove", path]); return undefined; },
        cleanupDevices: path => { trace.push(["devices", path]); return { stopped: 1, skipped: 0, failed: 0 }; },
        reportDeviceCleanupFailure: error => { trace.push(["failure", error]); return undefined; },
        stopContainer: read => { trace.push(["stop", read()]); return undefined; },
    };
    const app = createSessionCleanup(ports);
    app.setSession(binding.lockFile, binding.projectPath);
    app.setSessionContainerId(id);
    return { app, trace, foreign: () => { other = true; } };
}

function guardianFixture() {
    const cleanups: unknown[][] = [];
    const rollbacks: unknown[][] = [];
    const statuses: unknown[] = [];
    const frames: SessionOwnershipMessage[] = [];
    const ports: SessionOwnershipGuardianPorts = {
        decodeRuntimeInvocation: validateNativeRuntimeInvocation,
        validate: () => undefined,
        rollback: (...args) => { rollbacks.push(args); },
        cleanup: (...args) => { cleanups.push(args); },
        send: async message => { frames.push(message); },
        pause: async milliseconds => { expect(milliseconds).toBe(1000); },
        finish: status => { statuses.push(status); },
    };
    const guardian = createSessionOwnershipGuardian(ports);
    return { guardian, ports, cleanups, rollbacks, statuses,
        init: () => guardian.receive({ type: "init", binding, receipt, runtimeInvocation }) };
}

describe("PR integration separates captured identity from shutdown authorization", () => {
    it("failed join releases only its claim", () => {
        const f = cleanupFixture();
        f.app.setSessionCleanupEnabled(false);
        f.app.cleanupSession();
        f.app.cleanupSession();
        expect(f.trace).toEqual([["remove", binding.lockFile]]);
        expect(f.app.getCurrentSession().lockFile).toBeNull();
    });

    it("a newly started or successfully launched session cleans its exact ID", () => {
        const f = cleanupFixture();
        f.app.setSessionCleanupEnabled(false);
        f.app.setSessionCleanupEnabled(true);
        f.app.cleanupSession();
        expect(f.trace.filter(row => row[0] === "devices")).toEqual([["devices", binding.projectPath]]);
        expect(f.trace.filter(row => row[0] === "stop")).toEqual([["stop", id]]);
        expect(f.trace.filter(row => row[0] === "remove")).toEqual([["remove", binding.lockFile]]);
    });

    it("unqualified foreign claims veto cleanup without discharging its captured obligation", () => {
        const f = cleanupFixture();
        f.app.setSessionCleanupEnabled(true);
        f.foreign();
        expect(() => f.app.cleanupSession()).toThrow("session-cleanup-responsibility-incomplete");
        expect(f.trace).toEqual([]);
        expect(f.app.getCurrentSession().lockFile).toBe(binding.lockFile);
    });

    it("guardian EOF after a failed join rolls back only its owned claim despite an acknowledged ID", async () => {
        const f = guardianFixture();
        await f.init();
        await f.guardian.receive({ type: "update", sequence: 1, containerId: id, cleanupEnabled: false });
        await f.guardian.disconnect();
        await f.guardian.disconnect();
        expect(f.rollbacks).toEqual([[binding, receipt]]);
        expect(f.cleanups).toEqual([]);
        expect(f.statuses).toHaveLength(1);
    });

    it.each([undefined, null, "true", 1, {}])("malformed authorization %j never grants guardian shutdown", async permission => {
        const f = guardianFixture();
        await f.init();
        await expect(f.guardian.receive({ type: "update", sequence: 1, containerId: id,
            ...(permission === undefined ? {} : { cleanupEnabled: permission }) })).rejects.toThrow();
        await f.guardian.disconnect();
        expect(f.cleanups).toEqual([]);
        expect(f.rollbacks).toEqual([[binding, receipt]]);
    });

    it("failed permission ACK preserves the earlier acknowledged disabled permission", async () => {
        const f = guardianFixture();
        await f.init();
        await f.guardian.receive({ type: "update", sequence: 1, containerId: id, cleanupEnabled: false });
        const failure = new Error("owned fixture ACK unavailable");
        f.ports.send = async frame => { if (frame.type === "ack") throw failure; };
        await expect(f.guardian.receive({ type: "update", sequence: 2, containerId: successorId,
            cleanupEnabled: true })).rejects.toBe(failure);
        await f.guardian.disconnect();
        expect(f.cleanups).toEqual([]);
        expect(f.rollbacks).toEqual([[binding, receipt]]);
    });

    it("guardian EOF after an acknowledged replacement-ID revocation never inherits prior ID shutdown permission", async () => {
        const f = guardianFixture();
        await f.init();
        await f.guardian.receive({ type: "update", sequence: 1, containerId: id, cleanupEnabled: true });
        await f.guardian.receive({ type: "update", sequence: 2, containerId: successorId, cleanupEnabled: false });
        // The parent may die before its later explicit index revocation/grant.
        await f.guardian.disconnect();
        expect(f.cleanups).toEqual([]);
        expect(f.rollbacks).toEqual([[binding, receipt]]);
        expect(f.statuses).toHaveLength(1);
    });

    it("disconnect waits for permission ACK and then cleans only the committed ID and initialized native authority", async () => {
        const f = guardianFixture();
        await f.init();
        await f.guardian.receive({ type: "update", sequence: 1, containerId: id, cleanupEnabled: false });
        let started!: () => void;
        const sending = new Promise<void>(resolve => { started = resolve; });
        let acknowledge!: () => void;
        const ack = new Promise<void>(resolve => { acknowledge = resolve; });
        f.ports.send = async frame => { if (frame.type === "ack") { started(); await ack; } };
        const update = f.guardian.receive({ type: "update", sequence: 2, containerId: successorId,
            cleanupEnabled: true });
        await sending;
        const disconnected = f.guardian.disconnect();
        await Promise.resolve();
        expect(f.cleanups).toEqual([]);
        expect(f.rollbacks).toEqual([]);
        acknowledge();
        await update;
        await disconnected;
        expect(f.cleanups).toEqual([[binding, receipt, successorId, runtimeInvocation]]);
        expect(f.rollbacks).toEqual([]);
    });
});
