import { describe, expect, it } from "vitest";
import { createBrokerAppiumApplication } from "../../../packages/device-lab/src/device-lab/application/broker-appium.js";
import type { BrokerAppiumPorts } from "../../../packages/device-lab/src/device-lab/ports/broker-appium.js";

const owner = "owner";
const target = { backend: "android-emulator", deviceId: "pixel" };
const serverMetadata = {
    authority: "host-broker", processOwner: "host-broker", startedBy: "broker.appium.start",
    launchPolicy: "node-direct-hidden-v1", runtimeId: "runtime-one", serverPid: 12345,
    processIdentity: { token: "controlled-process-incarnation" },
    serverUrl: "http://127.0.0.1:4723", port: 4723,
};

function unexpected(): never { throw new Error("unexpected native effect"); }

function fixture() {
    const device: Record<string, unknown> = {
        id: "pixel", backend: "android-emulator", status: "running", name: "Pixel",
        avdName: "Pixel_API", port: 5580, appium: null,
    };
    const ports: BrokerAppiumPorts<{ token: string }> = {
        commandTimeoutMs: 5000,
        usesDefaultCommandRunner: false, strictAppiumPortOwnership: true,
        readDevices: () => [device],
        stateFailure: () => ({ kind: "refused", reason: "state-read-failed", error: "state-read-failed" }),
        notFound: () => ({ kind: "refused", reason: "missing", error: "device-not-found" }),
        publish: (_owner, _state, _id, _expected, replacement) => {
            device.appium = replacement;
            return { found: true, matched: true, currentAppium: replacement, device };
        },
        withDeviceOperation: async (_owner, _state, _id, operation) => operation(),
        heartbeat: unexpected,
        isLockTimeout: () => false, lockFailure: unexpected,
        isProcessIdentityCurrent: () => false,
        verifyListener: () => ({ ok: true, serverUrl: serverMetadata.serverUrl, port: 4723, receipt: {} }),
        terminateRuntime: unexpected, terminatePortListener: unexpected,
        portListener: unexpected, portSeed: unexpected, resolveIosTarget: unexpected,
        status: unexpected, inspectSession: unexpected, createSession: unexpected,
        deleteSession: unexpected, sessionCommand: unexpected,
        launchServer: unexpected, installRuntime: unexpected,
        captureRuntime: unexpected, runtimeReceipt: unexpected, installAvailable: unexpected,
        instrumentationAvailable: unexpected, resetInstrumentation: unexpected, instrumentationReceipt: unexpected,
        readManifest: unexpected, stateErrorCode: () => null, isMissingFile: unexpected,
        ensureRuntimeDirectory: unexpected, inspectRuntimeDirectory: unexpected,
        inspectNodeModules: unexpected, entryIsValid: unexpected, readMarker: unexpected,
        writeManifest: unexpected, removeMarker: unexpected, writeMarker: unexpected,
        manifestDigest: unexpected, withInstallLock: unexpected,
        timestamp: () => "2026-10-10T00:00:00.000Z", now: () => 1000,
        monotonicNow: () => 1000, runtimeId: () => "runtime-new", sleep: unexpected,
    };
    return { device, ports };
}

describe("broker Appium application policies", () => {
    it("rejects invalid backend admission before reading or locking a device", async () => {
        const { ports } = fixture();
        ports.readDevices = unexpected;
        ports.withDeviceOperation = unexpected;
        const app = createBrokerAppiumApplication(ports);
        expect(await app.start(owner, { backend: "windows-sandbox", deviceId: "pixel" })).toMatchObject({
            kind: "refused", reason: "invalid", error: "invalid-appium-backend",
        });
    });

    it("records metadata and clears inactive metadata through publication", async () => {
        const { ports, device } = fixture();
        const app = createBrokerAppiumApplication(ports);
        const recorded = await app.record(owner, { ...target, serverUrl: "http://127.0.0.1:4810", sessionId: "manual-session" });
        expect(recorded).toMatchObject({ kind: "metadata-recorded" });
        expect(device.appium).toMatchObject({ serverUrl: "http://127.0.0.1:4810", sessionId: "manual-session" });
        expect(await app.clear(owner, target)).toMatchObject({ kind: "metadata-cleared", cleared: true });
        expect(device.appium).toBeNull();
    });

    it("refuses to replace or clear live managed metadata", async () => {
        const { ports, device } = fixture();
        device.appium = serverMetadata;
        ports.usesDefaultCommandRunner = true;
        ports.isProcessIdentityCurrent = (identity, pid) => {
            expect(identity).toEqual({ token: "controlled-process-incarnation" });
            expect(pid).toBe(12345);
            return true;
        };
        ports.publish = unexpected;
        const app = createBrokerAppiumApplication(ports);
        expect(await app.record(owner, { ...target, sessionId: "replacement" })).toMatchObject({ kind: "refused", reason: "conflict", error: "appium-runtime-active" });
        expect(await app.clear(owner, target)).toMatchObject({ kind: "refused", reason: "conflict", error: "appium-runtime-active" });
        expect(device.appium).toEqual(serverMetadata);
    });

    it("propagates an unknown publication failure without claiming metadata was recorded", async () => {
        const { ports, device } = fixture();
        const failure = new Error("controlled state publication failure");
        ports.publish = () => { throw failure; };
        const app = createBrokerAppiumApplication(ports);
        await expect(app.record(owner, { ...target, sessionId: "not-published" })).rejects.toBe(failure);
        expect(device.appium).toBeNull();
    });

    it("aborts forced server replacement when the old owned process cannot be stopped", async () => {
        const { ports, device } = fixture();
        device.appium = serverMetadata;
        ports.terminateRuntime = async () => ({ ok: false, error: "runtime-process-identity-mismatch", receipt: {} });
        const app = createBrokerAppiumApplication(ports);
        expect(await app.start(owner, { ...target, force: true })).toMatchObject({
            kind: "refused", reason: "provider-failed", error: "appium-existing-process-stop-failed",
        });
        expect(device.appium).toEqual(serverMetadata);
    });

    it.each(["delete", "replace"] as const)("preserves the captured session when upstream deletion fails during %s", async (action) => {
        const { ports, device } = fixture();
        const previous = { ...serverMetadata, sessionId: "session-one", sessionCapabilities: { platformName: "Android" } };
        const response = { ok: false, receipt: Symbol("failed session deletion") };
        device.appium = previous;
        ports.publish = unexpected;
        ports.deleteSession = async (endpoint, sessionId, timeoutMs) => {
            expect(endpoint).toBe(serverMetadata.serverUrl);
            expect(sessionId).toBe("session-one");
            expect(timeoutMs).toBe(5000);
            return response;
        };
        const app = createBrokerAppiumApplication(ports);
        const outcome = action === "delete"
            ? await app.deleteSession(owner, target)
            : await app.ensureSession(owner, { ...target, force: true });
        expect(outcome).toMatchObject({ kind: "session-delete-failed", error: "appium-session-delete-failed", response });
        expect(outcome.response).toBe(response);
        expect(device.appium).toBe(previous);
    });

    it("deletes only session fields while retaining the managed server generation", async () => {
        const { ports, device } = fixture();
        device.appium = { ...serverMetadata, sessionId: "session-one", sessionCapabilities: { platformName: "Android" } };
        ports.deleteSession = async () => ({ ok: true, receipt: {} });
        const app = createBrokerAppiumApplication(ports);
        expect(await app.deleteSession(owner, target)).toMatchObject({ kind: "session-deleted", deleted: true });
        expect(device.appium).toEqual({ ...serverMetadata, updatedAt: "2026-10-10T00:00:00.000Z" });
    });

    it("does not contact Appium after the request budget expires in the device lock", async () => {
        const { ports, device } = fixture();
        device.appium = { ...serverMetadata, sessionId: "session-one" };
        let clock = 1000;
        ports.monotonicNow = () => clock;
        ports.withDeviceOperation = async (_owner, _state, _id, operation) => {
            clock = 1011;
            return operation();
        };
        const app = createBrokerAppiumApplication(ports);
        expect(await app.request(owner, { ...target, method: "GET", path: "/source", requestTimeoutMs: 10 })).toEqual({
            kind: "refused", reason: "deadline", error: "appium-request-timeout",
        });
    });

    it.each([true, false])("passes an admitted session command and its remaining budget with semantic ok=%s", async (ok) => {
        const { ports, device } = fixture();
        device.appium = { ...serverMetadata, sessionId: "session-one" };
        let clock = 1000;
        ports.monotonicNow = () => clock;
        ports.withDeviceOperation = async (_owner, _state, _id, operation) => { clock += 3; return operation(); };
        const response = { ok, receipt: Symbol("session command") };
        ports.sessionCommand = async (endpoint, sessionId, request, timeoutMs) => {
            expect([endpoint, sessionId, request, timeoutMs]).toEqual([
                serverMetadata.serverUrl, "session-one", { method: "GET", path: "/source", body: null }, 7,
            ]);
            return response;
        };
        ports.publish = unexpected;
        const outcome = await createBrokerAppiumApplication(ports).request(owner, {
            ...target, method: "GET", path: "/source", requestTimeoutMs: 10,
        });
        expect(outcome).toMatchObject({
            kind: ok ? "request-completed" : "request-failed",
            ...(ok ? {} : { error: "appium-request-failed" }),
            response,
        });
        expect(outcome.response).toBe(response);
    });

    it.each([true, false])("compensates only the newly created session when a successor wins publication and rollback ok=%s", async (rollbackOk) => {
        const { ports, device } = fixture();
        device.appium = serverMetadata;
        const successor = { ...serverMetadata, runtimeId: "successor", sessionId: "successor-session" };
        const createdSessionId = "created/session ?#%";
        const response = { ok: true, sessionId: createdSessionId, instrumentationInitializationFailed: false, receipt: Symbol("new session") };
        const rollback = { ok: rollbackOk, receipt: Symbol("compensating session deletion") };
        let compensationCalls = 0;
        ports.status = async () => ({ ok: true, ready: true, receipt: Symbol("ready") });
        ports.createSession = async (endpoint, capabilities, timeoutMs) => {
            expect(endpoint).toBe(serverMetadata.serverUrl);
            expect(capabilities).toMatchObject({ platformName: "Android", "appium:udid": "emulator-5580" });
            expect(timeoutMs).toBe(240000);
            return response;
        };
        ports.deleteSession = async (endpoint, sessionId, timeoutMs) => {
            expect(endpoint).toBe(serverMetadata.serverUrl);
            expect(sessionId).toBe(createdSessionId);
            expect(timeoutMs).toBe(5000);
            compensationCalls += 1;
            return rollback;
        };
        ports.publish = (_owner, _state, _id, expected, replacement) => {
            expect(expected).toMatchObject({ runtimeId: "runtime-one" });
            expect(replacement).toMatchObject({ sessionId: createdSessionId });
            device.appium = successor;
            return { found: true, matched: false, currentAppium: successor, device };
        };
        const app = createBrokerAppiumApplication(ports);
        const outcome = await app.ensureSession(owner, target);
        expect(outcome).toMatchObject({
            kind: "refused", reason: "conflict", error: "appium-runtime-state-conflict", response, rollback,
        });
        if (outcome.kind !== "refused") throw new Error("expected publication conflict");
        expect(outcome.response).toBe(response);
        expect(outcome.rollback).toBe(rollback);
        expect(compensationCalls).toBe(1);
        expect(device.appium).toBe(successor);
    });

    it("reuses a successfully inspected session even when status reports not ready", async () => {
        const { ports, device } = fixture();
        const previous = { ...serverMetadata, sessionId: "session-one" };
        device.appium = previous;
        ports.publish = unexpected;
        ports.status = async (endpoint, timeoutMs) => {
            expect([endpoint, timeoutMs]).toEqual([serverMetadata.serverUrl, 5000]);
            return { ok: true, ready: false, receipt: {} };
        };
        ports.inspectSession = async (endpoint, sessionId, timeoutMs) => {
            expect([endpoint, sessionId, timeoutMs]).toEqual([serverMetadata.serverUrl, "session-one", 5000]);
            return { ok: true, receipt: {} };
        };
        expect(await createBrokerAppiumApplication(ports).ensureSession(owner, target)).toMatchObject({
            kind: "session-reused", reused: true, created: false, appium: previous,
        });
        expect(device.appium).toEqual(previous);
    });

    it.each(["status", "inspection"])("preserves successor state and opaque observations after failed reuse %s", async (failure) => {
        const { ports, device } = fixture();
        device.appium = { ...serverMetadata, sessionId: "session-one", sessionCapabilities: { platformName: "Android" } };
        const successor = { ...serverMetadata, runtimeId: "successor", sessionId: "successor-session" };
        const status = { ok: failure !== "status", ready: false, receipt: { statusEvidence: failure } };
        const inspection = { ok: false, receipt: { inspectionEvidence: failure } };
        ports.status = async () => status;
        ports.inspectSession = failure === "status" ? unexpected : async () => inspection;
        ports.publish = (_owner, _state, _id, expected, replacement) => {
            expect(expected).toMatchObject({ sessionId: "session-one" });
            expect(replacement).toMatchObject({ sessionId: null, sessionCapabilities: null });
            device.appium = successor;
            return { found: true, matched: false, currentAppium: successor, device };
        };
        const outcome = await createBrokerAppiumApplication(ports).ensureSession(owner, target);
        expect(outcome).toMatchObject({ kind: "refused", error: "appium-runtime-state-conflict", statusObservation: status,
            sessionObservation: failure === "status" ? null : inspection });
        expect(device.appium).toEqual(successor);
    });

    it.each([true, false])("retains false readiness and owned termination evidence with signal ok=%s", async (signalOk) => {
        const { ports, device } = fixture();
        device.appium = serverMetadata;
        let clock = 1000;
        ports.now = () => clock;
        const status = { ok: true, ready: false, receipt: Symbol("not ready") };
        let probes = 0;
        ports.status = async (endpoint, timeoutMs) => {
            expect([endpoint, timeoutMs]).toEqual([serverMetadata.serverUrl, 2000]);
            probes += 1;
            clock += 60001;
            return status;
        };
        const signal = { ok: signalOk, receipt: Symbol("owned process termination") };
        ports.terminateRuntime = async (runtime) => {
            expect(runtime).toEqual(serverMetadata);
            return signal;
        };
        const outcome = await createBrokerAppiumApplication(ports).ensureSession(owner, target);
        expect(outcome).toMatchObject({
            kind: "refused", error: "appium-server-not-ready", readiness: { ok: false, response: status }, signal,
        });
        if (outcome.kind !== "refused") throw new Error("expected readiness failure");
        expect(outcome.readiness?.response).toBe(status);
        expect(outcome.signal).toBe(signal);
        expect(probes).toBe(1);
        expect(device.appium).toBe(signalOk ? null : serverMetadata);
    });

    it("retains a null readiness observation when the deadline expires before a probe", async () => {
        const { ports, device } = fixture();
        device.appium = serverMetadata;
        let clockReads = 0;
        ports.now = () => clockReads++ === 0 ? 1000 : 61001;
        ports.terminateRuntime = async () => ({ ok: true, receipt: {} });
        expect(await createBrokerAppiumApplication(ports).ensureSession(owner, target)).toMatchObject({
            kind: "refused", error: "appium-server-not-ready", readiness: { ok: false, response: null },
        });
        expect(device.appium).toBeNull();
    });

    it.each([
        { commandElapsed: 1, expectedKind: "request-completed" },
        { commandElapsed: 5, expectedKind: "refused" },
    ])("shares one request budget across the device lock, physical heartbeat and command ($expectedKind)", async ({ commandElapsed, expectedKind }) => {
        const { ports, device } = fixture();
        device.backend = "android-device";
        device.appium = { ...serverMetadata, sessionId: "session-one" };
        ports.publish = unexpected;
        let clock = 1000;
        let lockBudget: unknown;
        ports.monotonicNow = () => clock;
        ports.withDeviceOperation = async (actualOwner, stateKey, deviceId, operation, budget) => {
            expect([actualOwner, stateKey, deviceId]).toEqual([owner, "android-device", "pixel"]);
            expect(budget?.remaining()).toBe(10);
            lockBudget = budget;
            clock += 3;
            return operation();
        };
        ports.heartbeat = (actualOwner, leaseTarget, deviceId, budget) => {
            expect([actualOwner, leaseTarget.backend, leaseTarget.stateKey, deviceId]).toEqual([owner, "android-device", "android-device", "pixel"]);
            expect(leaseTarget.device).toBe(device);
            expect(budget).toBe(lockBudget);
            expect(budget?.remaining()).toBe(7);
            clock += 2;
            return null;
        };
        const response = { ok: true, receipt: Symbol("physical session command") };
        let commands = 0;
        ports.sessionCommand = async (endpoint, sessionId, request, timeoutMs) => {
            expect([endpoint, sessionId, request, timeoutMs]).toEqual([
                serverMetadata.serverUrl, "session-one", { method: "GET", path: "/source", body: null }, 5,
            ]);
            commands += 1;
            clock += commandElapsed;
            return response;
        };
        const outcome = await createBrokerAppiumApplication(ports).request(owner, {
            ...target, backend: "android-device", method: "GET", path: "/source", requestTimeoutMs: 10,
        });
        expect(commands).toBe(1);
        if (expectedKind === "refused") {
            expect(outcome).toEqual({ kind: "refused", reason: "deadline", error: "appium-request-timeout" });
        } else {
            expect(outcome).toMatchObject({ kind: "request-completed", response });
            expect(outcome.response).toBe(response);
        }
    });

    it("does not verify a listener or dispatch a command after the physical heartbeat exhausts the request budget", async () => {
        const { ports, device } = fixture();
        device.backend = "android-device";
        const previous = { ...serverMetadata, sessionId: "session-one" };
        device.appium = previous;
        ports.publish = unexpected;
        ports.verifyListener = unexpected;
        let clock = 1000;
        let heartbeats = 0;
        ports.monotonicNow = () => clock;
        ports.heartbeat = (_owner, _target, _id, budget) => {
            expect(budget?.remaining()).toBe(10);
            heartbeats += 1;
            clock += 10;
            return null;
        };
        expect(await createBrokerAppiumApplication(ports).request(owner, {
            ...target, backend: "android-device", method: "GET", path: "/source", requestTimeoutMs: 10,
        })).toEqual({ kind: "refused", reason: "deadline", error: "appium-request-timeout" });
        expect(heartbeats).toBe(1);
        expect(device.appium).toBe(previous);
    });

    it("polls false readiness within the deadline and creates a session from semantic facts", async () => {
        const { ports, device } = fixture();
        device.appium = serverMetadata;
        let clock = 1000;
        let probes = 0;
        let sleeps = 0;
        ports.now = () => clock;
        ports.status = async (endpoint, timeoutMs) => {
            expect([endpoint, timeoutMs]).toEqual([serverMetadata.serverUrl, 2000]);
            probes += 1;
            return { ok: true, ready: probes > 1, receipt: Symbol("readiness probe") };
        };
        ports.sleep = async (milliseconds) => {
            expect(milliseconds).toBe(200);
            sleeps += 1;
            clock += milliseconds;
        };
        const response = { ok: true, sessionId: "semantic-session", instrumentationInitializationFailed: false, receipt: Symbol("semantic session creation") };
        ports.createSession = async (endpoint, capabilities, timeoutMs) => {
            expect([endpoint, timeoutMs]).toEqual([serverMetadata.serverUrl, 240000]);
            expect(capabilities).toMatchObject({ platformName: "Android", "appium:udid": "emulator-5580" });
            expect(capabilities).not.toHaveProperty("capabilities");
            return response;
        };
        const outcome = await createBrokerAppiumApplication(ports).ensureSession(owner, target);
        expect(outcome).toMatchObject({ kind: "session-created", created: true, reused: false, response });
        expect(outcome.response).toBe(response);
        expect(device.appium).toMatchObject({ ...serverMetadata, sessionId: "semantic-session" });
        expect([probes, sleeps]).toEqual([2, 1]);
    });

    it("retains successful creation evidence when the semantic session ID is missing", async () => {
        const { ports, device } = fixture();
        device.appium = serverMetadata;
        ports.publish = unexpected;
        ports.status = async () => ({ ok: true, ready: true, receipt: Symbol("ready") });
        const response = { ok: true, sessionId: null, instrumentationInitializationFailed: false, receipt: Symbol("missing session ID") };
        ports.createSession = async () => response;
        const outcome = await createBrokerAppiumApplication(ports).ensureSession(owner, target);
        expect(outcome).toMatchObject({ kind: "refused", reason: "provider-failed", error: "appium-session-id-missing", response });
        expect(outcome.response).toBe(response);
        expect(device.appium).toBe(serverMetadata);
    });

    it("preserves a successor when failed readiness cleanup loses publication", async () => {
        const { ports, device } = fixture();
        device.appium = serverMetadata;
        const successor = { ...serverMetadata, runtimeId: "successor", sessionId: "successor-session" };
        const status = { ok: false, ready: false, receipt: Symbol("failed readiness") };
        const signal = { ok: true, receipt: Symbol("owned process termination") };
        let clock = 1000;
        ports.now = () => clock;
        ports.status = async () => { clock += 60001; return status; };
        ports.terminateRuntime = async (runtime) => {
            expect(runtime).toEqual(serverMetadata);
            return signal;
        };
        ports.publish = (_owner, _state, _id, expected, replacement) => {
            expect(expected).toEqual(serverMetadata);
            expect(replacement).toBeNull();
            device.appium = successor;
            return { found: true, matched: false, currentAppium: successor, device };
        };
        const outcome = await createBrokerAppiumApplication(ports).ensureSession(owner, target);
        expect(outcome).toMatchObject({
            kind: "refused", reason: "conflict", error: "appium-runtime-state-conflict",
            currentAppium: successor, readiness: { ok: false, response: status }, signal,
        });
        if (outcome.kind !== "refused") throw new Error("expected publication conflict");
        expect(outcome.readiness?.response).toBe(status);
        expect(outcome.signal).toBe(signal);
        expect(device.appium).toBe(successor);
    });

    it.each([true, false])("retries a flagged Android instrumentation failure once after all five recovery steps (retry ok=%s)", async (retryOk) => {
        const { ports, device } = fixture();
        device.appium = serverMetadata;
        ports.status = async () => ({ ok: true, ready: true, receipt: Symbol("ready") });
        const first = { ok: false, sessionId: null, instrumentationInitializationFailed: true, receipt: Symbol("instrumentation failure") };
        const second = { ok: retryOk, sessionId: retryOk ? "retried-session" : null, instrumentationInitializationFailed: true, receipt: Symbol("creation retry") };
        const effects: string[] = [];
        let attempts = 0;
        ports.createSession = async (endpoint, capabilities, timeoutMs) => {
            expect([endpoint, timeoutMs]).toEqual([serverMetadata.serverUrl, 240000]);
            expect(capabilities).toMatchObject({ platformName: "Android", "appium:udid": "emulator-5580" });
            effects.push("create");
            attempts += 1;
            expect(attempts).toBeLessThanOrEqual(2);
            return attempts === 1 ? first : second;
        };
        ports.instrumentationAvailable = () => true;
        ports.resetInstrumentation = (serial, step) => {
            expect(serial).toBe("emulator-5580");
            effects.push(step);
            return { status: 0, receipt: Symbol(step) };
        };
        const recoveryReceipt = Symbol("instrumentation recovery");
        ports.instrumentationReceipt = (serial) => {
            expect(serial).toBe("emulator-5580");
            return recoveryReceipt;
        };
        const outcome = await createBrokerAppiumApplication(ports).ensureSession(owner, target);
        expect(effects).toEqual([
            "create", "force-stop-server", "force-stop-test", "uninstall-server", "uninstall-test", "uninstall-settings", "create",
        ]);
        expect(attempts).toBe(2);
        expect(outcome.response).toBe(second);
        if (retryOk) {
            expect(outcome).toMatchObject({ kind: "session-created", created: true, reused: false });
            expect(device.appium).toMatchObject({
                sessionId: "retried-session", instrumentationRecovery: { attempted: true, recovered: true },
            });
        } else {
            expect(outcome).toMatchObject({
                kind: "refused", error: "appium-session-create-failed",
                instrumentationRecovery: { attempted: true, ok: true, receipt: recoveryReceipt },
            });
            expect(device.appium).toBe(serverMetadata);
        }
    });

    it.each([
        { backend: "android-emulator", instrumentationInitializationFailed: false },
        { backend: "ios-device", instrumentationInitializationFailed: true },
    ])("does not recover an unqualified creation failure ($backend, flag=$instrumentationInitializationFailed)", async ({ backend, instrumentationInitializationFailed }) => {
        const { ports, device } = fixture();
        device.backend = backend;
        device.udid = "ios-device-one";
        device.appium = serverMetadata;
        ports.publish = unexpected;
        ports.heartbeat = () => null;
        ports.status = async () => ({ ok: true, ready: true, receipt: Symbol("ready") });
        const response = { ok: false, sessionId: null, instrumentationInitializationFailed, receipt: Symbol("unqualified creation failure") };
        let attempts = 0;
        ports.createSession = async () => {
            attempts += 1;
            return response;
        };
        const outcome = await createBrokerAppiumApplication(ports).ensureSession(owner, { ...target, backend });
        expect(outcome).toMatchObject({ kind: "refused", error: "appium-session-create-failed", response });
        expect(outcome.response).toBe(response);
        expect(attempts).toBe(1);
        expect(device.appium).toBe(serverMetadata);
    });

    it("does not retry a flagged Android creation failure when instrumentation recovery is unavailable", async () => {
        const { ports, device } = fixture();
        device.appium = serverMetadata;
        ports.publish = unexpected;
        ports.status = async () => ({ ok: true, ready: true, receipt: Symbol("ready") });
        ports.instrumentationAvailable = () => false;
        const response = { ok: false, sessionId: null, instrumentationInitializationFailed: true, receipt: Symbol("unavailable recovery") };
        let attempts = 0;
        ports.createSession = async () => {
            attempts += 1;
            return response;
        };
        const outcome = await createBrokerAppiumApplication(ports).ensureSession(owner, target);
        expect(outcome).toMatchObject({
            kind: "refused", error: "appium-session-create-failed", response,
            instrumentationRecovery: { attempted: false, ok: false, error: "missing-adb-or-serial", results: [] },
        });
        expect(outcome.response).toBe(response);
        expect(attempts).toBe(1);
        expect(device.appium).toBe(serverMetadata);
    });
});
