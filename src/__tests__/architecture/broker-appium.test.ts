import { describe, expect, it, vi } from "vitest";
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

function launchFixture() {
    const result = fixture();
    const runtime = { token: "captured-runtime" };
    result.ports.portSeed = () => 0;
    result.ports.portListener = () => null;
    result.ports.captureRuntime = () => ({ kind: "injected", handle: runtime });
    result.ports.ensureRuntimeDirectory = () => undefined;
    result.ports.terminatePortListener = () => ({ ok: true, receipt: Symbol("port cleanup") });
    result.ports.launchServer = async () => ({ ok: true, pid: 23456,
        processIdentity: serverMetadata.processIdentity, receipt: Symbol("native launch") });
    return result;
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

    it.each([true, false])("publishes a launched process only for semantic command success (ok=%s)", async (ok) => {
        const { ports, device } = fixture();
        const runtime = { token: "captured-runtime" };
        const processIdentity = { token: "new-process-incarnation" };
        const receipt = Symbol("opaque launch evidence");
        const execution = { ok, pid: 23456, processIdentity, receipt };
        ports.portSeed = () => 0;
        ports.portListener = () => null;
        ports.captureRuntime = () => ({ kind: "injected", handle: runtime });
        ports.ensureRuntimeDirectory = (actual) => { expect(actual).toBe(runtime); return undefined; };
        ports.terminatePortListener = (port) => {
            expect(port).toBe(20000);
            return { ok: true, receipt: Symbol("port cleanup") };
        };
        ports.launchServer = async (actual, request) => {
            expect(actual).toBe(runtime);
            expect(request).toEqual({ backend: target.backend, port: 20000, timeoutMs: 5000 });
            return execution;
        };
        if (!ok) ports.publish = unexpected;
        const outcome = await createBrokerAppiumApplication(ports).start(owner, target);
        expect(outcome).toMatchObject(ok
            ? { kind: "server-started", started: true, reused: false }
            : { kind: "refused", reason: "provider-failed", error: "appium-server-start-failed" });
        if (outcome.kind !== "server-started" && outcome.kind !== "refused") throw new Error("expected launch outcome");
        expect(outcome.execution).toBe(execution);
        expect(outcome.execution?.receipt).toBe(receipt);
        if (outcome.kind === "server-started") {
            expect(outcome.appium).toMatchObject({
                serverPid: 23456, runtimeId: "runtime-new", launchPolicy: "node-direct-hidden-v1",
                serverUrl: "http://127.0.0.1:20000", port: 20000,
            });
            expect(outcome.appium.processIdentity).toBe(processIdentity);
            expect(device.appium).toBe(outcome.appium);
        } else {
            expect(device.appium).toBeNull();
        }
    });

    it("compensates the exact newly launched process when a successor wins publication", async () => {
        const { ports, device } = fixture();
        const runtime = { token: "captured-runtime" };
        const processIdentity = { token: "new-process-incarnation" };
        const successor = { ...serverMetadata, runtimeId: "successor", serverPid: 45678 };
        const rollback = { ok: true, receipt: Symbol("exact new process termination") };
        let launched: Record<string, unknown> | null = null;
        let compensations = 0;
        ports.portSeed = () => 0;
        ports.portListener = () => null;
        ports.captureRuntime = () => ({ kind: "injected", handle: runtime });
        ports.ensureRuntimeDirectory = () => undefined;
        ports.terminatePortListener = () => ({ ok: true, receipt: Symbol("port cleanup") });
        ports.launchServer = async (actual) => {
            expect(actual).toBe(runtime);
            return { ok: true, pid: 23456, processIdentity, receipt: Symbol("new process launch") };
        };
        ports.publish = (actualOwner, stateKey, deviceId, expected, replacement) => {
            expect([actualOwner, stateKey, deviceId, expected]).toEqual([owner, "android", "pixel", null]);
            expect(replacement).toMatchObject({ serverPid: 23456, runtimeId: "runtime-new" });
            launched = replacement;
            device.appium = successor;
            return { found: true, matched: false, currentAppium: successor, device };
        };
        ports.terminateRuntime = async (actual) => {
            expect(actual).toBe(launched);
            expect(actual).toMatchObject({ serverPid: 23456, runtimeId: "runtime-new" });
            expect((actual as Record<string, unknown>).processIdentity).toBe(processIdentity);
            compensations += 1;
            return rollback;
        };
        const outcome = await createBrokerAppiumApplication(ports).start(owner, target);
        expect(outcome).toMatchObject({
            kind: "refused", reason: "conflict", error: "appium-runtime-state-conflict", currentAppium: successor, rollback,
        });
        if (outcome.kind !== "refused") throw new Error("expected publication conflict");
        expect(outcome.rollback).toBe(rollback);
        expect(compensations).toBe(1);
        expect(device.appium).toBe(successor);
    });

    it.each(["install-failed", "runtime-directory-invalid", "node-modules-invalid", "entry-invalid", "valid"] as const)(
        "validates a managed installation before publishing its marker and launching (%s)", async (scenario) => {
            const { ports, device } = fixture();
            const runtime = { token: "managed-runtime" };
            const receipt = Symbol("opaque install evidence");
            const execution = { ok: scenario !== "install-failed", receipt };
            const effects: string[] = [];
            let installed = false;
            let marker: unknown = null;
            ports.portSeed = () => 0;
            ports.portListener = () => null;
            ports.captureRuntime = () => ({ kind: "managed", handle: runtime });
            ports.runtimeReceipt = (actual) => { expect(actual).toBe(runtime); return Symbol("runtime evidence"); };
            ports.readManifest = () => "{}";
            ports.manifestDigest = () => "manifest-hash";
            ports.ensureRuntimeDirectory = () => undefined;
            ports.withInstallLock = (operation, options) => {
                expect(options).toEqual({ waitMs: 315000, staleMs: 900000 });
                return operation();
            };
            ports.inspectRuntimeDirectory = () => {
                if (installed) effects.push("inspect-directory");
                return !installed || scenario !== "runtime-directory-invalid";
            };
            ports.inspectNodeModules = () => {
                if (installed) effects.push("inspect-node-modules");
                return !installed || scenario !== "node-modules-invalid";
            };
            ports.entryIsValid = () => {
                effects.push("validate-entry");
                return scenario !== "entry-invalid";
            };
            ports.readMarker = () => null;
            ports.installAvailable = () => true;
            ports.writeManifest = () => undefined;
            ports.removeMarker = () => undefined;
            ports.installRuntime = (actual, timeoutMs) => {
                expect([actual, timeoutMs]).toEqual([runtime, 300000]);
                effects.push("install");
                installed = true;
                return execution;
            };
            ports.writeMarker = (actual, replacement) => {
                expect(actual).toBe(runtime);
                expect(effects).toEqual(["install", "inspect-directory", "inspect-node-modules", "validate-entry"]);
                marker = replacement;
                effects.push("marker");
                return undefined;
            };
            ports.terminatePortListener = () => ({ ok: true, receipt: Symbol("port cleanup") });
            ports.launchServer = async (actual, request) => {
                expect(actual).toBe(runtime);
                expect(request).toEqual({ backend: target.backend, port: 20000, timeoutMs: 5000 });
                expect(marker).toEqual({ manifestHash: "manifest-hash", installedAt: "2026-10-10T00:00:00.000Z" });
                effects.push("launch");
                return { ok: true, pid: 23456, receipt: Symbol("launch after install") };
            };
            if (scenario !== "valid") {
                ports.writeMarker = unexpected;
                ports.terminatePortListener = unexpected;
                ports.launchServer = unexpected;
                ports.publish = unexpected;
            }
            const outcome = await createBrokerAppiumApplication(ports).start(owner, target);
            if (scenario === "valid") {
                expect(outcome).toMatchObject({ kind: "server-started", runtime: { provisioned: true, source: "broker-runtime" } });
                expect(effects).toEqual([
                    "install", "inspect-directory", "inspect-node-modules", "validate-entry", "marker",
                    "inspect-directory", "validate-entry", "launch",
                ]);
                expect(device.appium).toMatchObject({ serverPid: 23456 });
            } else {
                expect(outcome).toMatchObject({
                    kind: "refused", reason: "provider-failed", error: "appium-runtime-install-failed", runtime: { execution },
                });
                if (outcome.kind !== "refused") throw new Error("expected install refusal");
                expect(outcome.runtime?.execution).toBe(execution);
                expect(outcome.runtime?.execution?.receipt).toBe(receipt);
                const validations = ["inspect-directory", "inspect-node-modules", "validate-entry"];
                const completed = ["install-failed", "runtime-directory-invalid", "node-modules-invalid", "entry-invalid"].indexOf(scenario);
                expect(effects).toEqual(["install", ...validations.slice(0, completed)]);
                expect(marker).toBeNull();
                expect(device.appium).toBeNull();
            }
        },
    );

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
        ports.monotonicNow = () => clock;
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
        ports.monotonicNow = () => clockReads++ === 0 ? 1000 : 61001;
        ports.terminateRuntime = async () => ({ ok: true, receipt: {} });
        expect(await createBrokerAppiumApplication(ports).ensureSession(owner, target)).toMatchObject({
            kind: "refused", error: "appium-server-not-ready", readiness: { ok: false, response: null },
        });
        expect(device.appium).toBeNull();
    });

    it.each([-1e12, 1e12])("ignores a wall jump of %sms during readiness polling", async wallJump => {
        const { ports, device } = fixture();
        device.appium = serverMetadata;
        let elapsed = 0, wall = 1000;
        ports.monotonicNow = () => elapsed;
        ports.now = () => wall;
        const timeouts: number[] = [];
        ports.status = async (_endpoint, timeoutMs) => {
            timeouts.push(timeoutMs);
            expect(timeouts.length).toBeLessThanOrEqual(2);
            elapsed += 10;
            wall += wallJump;
            return { ok: true, ready: timeouts.length === 2, receipt: Symbol("status") };
        };
        ports.sleep = async milliseconds => { expect(milliseconds).toBe(200); elapsed += milliseconds; };
        ports.createSession = async () => ({ ok: true, sessionId: "timely-session", instrumentationInitializationFailed: false, receipt: Symbol("created") });
        const outcome = await createBrokerAppiumApplication(ports).ensureSession(owner, target);
        expect(outcome).toMatchObject({ kind: "session-created", created: true });
        expect(timeouts).toEqual([2000, 2000]);
        expect(device.appium).toMatchObject({ sessionId: "timely-session", updatedAt: "2026-10-10T00:00:00.000Z" });
    });

    it.each([false, true])("rejects late positive readiness and preserves exact cleanup authority (successor=%s)", async successorWins => {
        const { ports, device } = fixture();
        device.appium = serverMetadata;
        let elapsed = 0;
        ports.monotonicNow = () => elapsed;
        const response = { ok: true, ready: true, receipt: Symbol("late positive status") };
        ports.status = async () => { elapsed = 60000; return response; };
        const createSession = vi.fn(unexpected);
        ports.createSession = createSession;
        const signal = { ok: true, receipt: Symbol("confirmed exact runtime termination") };
        ports.terminateRuntime = async runtime => {
            expect(runtime).toEqual(serverMetadata);
            expect((runtime as typeof serverMetadata).processIdentity).toBe(serverMetadata.processIdentity);
            return signal;
        };
        const successor = { ...serverMetadata, runtimeId: "successor", sessionId: "successor-session" };
        ports.publish = (_owner, _state, _id, expected, replacement) => {
            expect(expected).toEqual(serverMetadata);
            expect(replacement).toBeNull();
            device.appium = successorWins ? successor : null;
            return { found: true, matched: !successorWins, currentAppium: device.appium, device };
        };
        const outcome = await createBrokerAppiumApplication(ports).ensureSession(owner, target);
        expect(outcome).toMatchObject({ kind: "refused", error: successorWins ? "appium-runtime-state-conflict" : "appium-server-not-ready" });
        if (outcome.kind !== "refused") throw new Error("expected late readiness refusal");
        expect(outcome.readiness?.response).toBe(response);
        expect(outcome.signal).toBe(signal);
        expect(createSession).not.toHaveBeenCalled();
        expect(device.appium).toBe(successorWins ? successor : null);
    });

    it("shares readiness remainder between status probes and preserves the final native failure", async () => {
        const { ports, device } = fixture();
        device.appium = serverMetadata;
        let elapsed = 0;
        ports.monotonicNow = () => elapsed;
        const nativeFailure = { ok: false, ready: false, receipt: Symbol("native status failure") };
        const timeouts: number[] = [];
        ports.status = async (_endpoint, timeoutMs) => {
            timeouts.push(timeoutMs);
            expect(timeouts.length).toBeLessThanOrEqual(2);
            elapsed = timeouts.length === 1 ? 59000 : 59999.5;
            return timeouts.length === 1 ? { ok: true, ready: false, receipt: Symbol("warming") } : nativeFailure;
        };
        ports.sleep = async milliseconds => {
            expect(milliseconds).toBeGreaterThan(0);
            expect(milliseconds).toBeLessThanOrEqual(Math.min(200, 60000 - elapsed));
            elapsed += milliseconds;
        };
        ports.terminateRuntime = async () => ({ ok: false, receipt: Symbol("unconfirmed cleanup") });
        const outcome = await createBrokerAppiumApplication(ports).ensureSession(owner, target);
        expect(timeouts).toEqual([2000, 800]);
        if (outcome.kind !== "refused") throw new Error("expected native readiness failure");
        expect(outcome.readiness?.response).toBe(nativeFailure);
        expect(device.appium).toBe(serverMetadata);
    });

    it("rechecks readiness after capability preparation before admitting session creation", async () => {
        const { ports, device } = fixture();
        device.appium = serverMetadata;
        let elapsed = 0;
        ports.monotonicNow = () => elapsed;
        const response = { ok: true, ready: true, receipt: Symbol("timely readiness") };
        ports.status = async () => { elapsed = 100; return response; };
        Object.defineProperty(device, "name", { get: () => { elapsed = 60000; return "Pixel"; } });
        const createSession = vi.fn(unexpected);
        ports.createSession = createSession;
        ports.terminateRuntime = async runtime => {
            expect(runtime).toEqual(serverMetadata);
            return { ok: true, receipt: Symbol("exact runtime cleanup") };
        };
        const outcome = await createBrokerAppiumApplication(ports).ensureSession(owner, target);
        expect(outcome).toMatchObject({ kind: "refused", error: "appium-server-not-ready" });
        if (outcome.kind !== "refused") throw new Error("expected expired readiness admission");
        expect(outcome.readiness?.response).toBe(response);
        expect(createSession).not.toHaveBeenCalled();
        expect(device.appium).toBeNull();
    });

    it("retains the independent session command allowance after timely readiness admission", async () => {
        const { ports, device } = fixture();
        device.appium = serverMetadata;
        let elapsed = 0;
        ports.monotonicNow = () => elapsed;
        ports.status = async () => { elapsed = 100; return { ok: true, ready: true, receipt: Symbol("ready") }; };
        const response = { ok: true, sessionId: "independently-admitted", instrumentationInitializationFailed: false, receipt: Symbol("late session response") };
        ports.createSession = async (_endpoint, _capabilities, timeoutMs) => {
            expect(timeoutMs).toBe(240000);
            elapsed += 60000;
            return response;
        };
        const outcome = await createBrokerAppiumApplication(ports).ensureSession(owner, target);
        expect(outcome).toMatchObject({ kind: "session-created", created: true });
        expect(outcome.response).toBe(response);
        expect(device.appium).toMatchObject({ sessionId: "independently-admitted" });
    });

    it.each([0.4, 50])("caps readiness sleep at remaining %sms and dispatches no final expired status probe", async remainder => {
        const { ports, device } = fixture();
        device.appium = serverMetadata;
        let elapsed = 0, probes = 0;
        ports.monotonicNow = () => elapsed;
        ports.status = async (_endpoint, timeoutMs) => {
            expect(++probes).toBe(1);
            expect(timeoutMs).toBe(2000);
            elapsed = 60000 - remainder;
            return { ok: true, ready: false, receipt: Symbol("last status") };
        };
        const sleeps: number[] = [];
        ports.sleep = async milliseconds => { sleeps.push(milliseconds); elapsed += milliseconds; };
        ports.terminateRuntime = async () => ({ ok: true, receipt: Symbol("cleanup") });
        expect(await createBrokerAppiumApplication(ports).ensureSession(owner, target)).toMatchObject({ kind: "refused", error: "appium-server-not-ready" });
        if (remainder >= 1) expect(sleeps).toEqual([50]);
        else {
            expect(sleeps.length).toBeLessThanOrEqual(1);
            expect(sleeps.every(milliseconds => milliseconds > 0 && milliseconds <= remainder + 1e-6)).toBe(true);
        }
        expect(probes).toBe(1);
    });

    it.each(["first-positive", "retried-positive", "retried-failure"] as const)("preserves exact listener evidence for a late %s", async mode => {
        const { ports, device } = launchFixture();
        let elapsed = 0, wall = 1000, probes = 0;
        ports.monotonicNow = () => elapsed;
        ports.now = () => wall;
        const firstFailure = { ok: false as const, error: "appium-port-listener-unavailable", receipt: Symbol("last real listener failure") };
        const lateFailure = { ok: false as const, error: "appium-process-identity-mismatch", receipt: Symbol("late native identity mismatch") };
        const positive = { ok: true as const, serverUrl: "http://127.0.0.1:20000", port: 20000, receipt: Symbol("late verified listener") };
        ports.verifyListener = metadata => {
            expect(metadata).toEqual(device.appium);
            expect(++probes).toBeLessThanOrEqual(mode === "first-positive" ? 1 : 2);
            wall += 1e12;
            if (mode !== "first-positive" && probes === 1) { elapsed = 10; return firstFailure; }
            elapsed += 60000;
            return mode === "retried-failure" ? lateFailure : positive;
        };
        ports.sleep = async milliseconds => { expect(milliseconds).toBe(100); elapsed += milliseconds; };
        const outcome = await createBrokerAppiumApplication(ports).ensureSession(owner, target);
        expect(outcome).toMatchObject({ kind: "refused", error: "appium-listener-ownership-unverified" });
        expect(probes).toBe(mode === "first-positive" ? 1 : 2);
        if (outcome.kind !== "refused") throw new Error("expected listener refusal");
        if (mode === "first-positive") {
            expect(outcome.verification).toMatchObject({ ok: false, error: "appium-port-listener-unavailable" });
            expect(outcome.verification?.receipt).toBe(positive.receipt);
        } else expect(outcome.verification).toBe(mode === "retried-positive" ? firstFailure : lateFailure);
        expect(device.appium).toMatchObject({ serverPid: 23456, runtimeId: "runtime-new" });
        expect(device.appium).not.toHaveProperty("sessionId");
    });

    it.each([0.4, 50])("caps listener sleep at remaining %sms and dispatches no final expired verification", async remainder => {
        const { ports, device } = launchFixture();
        let elapsed = 0, probes = 0;
        ports.monotonicNow = () => elapsed;
        const failure = { ok: false as const, error: "appium-port-listener-unavailable", receipt: Symbol("last listener failure") };
        ports.verifyListener = () => { expect(++probes).toBe(1); elapsed = 60000 - remainder; return failure; };
        const sleeps: number[] = [];
        ports.sleep = async milliseconds => { sleeps.push(milliseconds); elapsed += milliseconds; };
        const outcome = await createBrokerAppiumApplication(ports).ensureSession(owner, target);
        if (outcome.kind !== "refused") throw new Error("expected exhausted listener phase");
        expect(outcome.verification).toBe(failure);
        if (remainder >= 1) expect(sleeps).toEqual([50]);
        else {
            expect(sleeps.length).toBeLessThanOrEqual(1);
            expect(sleeps.every(milliseconds => milliseconds > 0 && milliseconds <= remainder + 1e-6)).toBe(true);
        }
        expect(device.appium).toMatchObject({ runtimeId: "runtime-new", serverPid: 23456 });
    });

    it.each([-1e12, 1e12])("keeps separate listener/readiness phase allowances across wall jump %sms", async wallJump => {
        const { ports, device } = launchFixture();
        let elapsed = 0, wall = 1000, probes = 0;
        ports.monotonicNow = () => elapsed;
        ports.now = () => wall;
        ports.verifyListener = () => {
            wall += wallJump;
            elapsed = ++probes === 1 ? 59750 : 59900;
            return probes === 1
                ? { ok: false, error: "appium-port-listener-unavailable", receipt: Symbol("warming listener") }
                : { ok: true, serverUrl: "http://127.0.0.1:20000", port: 20000, receipt: Symbol("timely listener") };
        };
        ports.sleep = async milliseconds => { expect(milliseconds).toBe(100); elapsed += milliseconds; };
        ports.status = async (_endpoint, timeoutMs) => {
            expect(timeoutMs).toBe(2000);
            elapsed += 59900;
            wall -= wallJump;
            return { ok: true, ready: true, receipt: Symbol("timely second phase") };
        };
        ports.createSession = async () => ({ ok: true, sessionId: "two-phase-session", instrumentationInitializationFailed: false, receipt: Symbol("created") });
        expect(await createBrokerAppiumApplication(ports).ensureSession(owner, target)).toMatchObject({ kind: "session-created", created: true });
        expect(device.appium).toMatchObject({ runtimeId: "runtime-new", sessionId: "two-phase-session", updatedAt: "2026-10-10T00:00:00.000Z" });
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
        ports.monotonicNow = () => clock;
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
        ports.monotonicNow = () => clock;
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
        const recoveryResults = [
            { ok: false, receipt: Symbol("force-stop-server") },
            { ok: true, receipt: Symbol("force-stop-test") },
            { ok: false, receipt: Symbol("uninstall-server") },
            { ok: true, receipt: Symbol("uninstall-test") },
            { ok: false, receipt: Symbol("uninstall-settings") },
        ];
        let resetSteps = 0;
        ports.resetInstrumentation = (serial, step) => {
            expect(serial).toBe("emulator-5580");
            effects.push(step);
            return recoveryResults[resetSteps++];
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
            if (outcome.kind !== "refused") throw new Error("expected creation failure");
            expect(outcome.instrumentationRecovery?.results).toEqual(recoveryResults);
            outcome.instrumentationRecovery?.results.forEach((result, index) => {
                expect(result).toBe(recoveryResults[index]);
                expect(result.receipt).toBe(recoveryResults[index].receipt);
            });
            expect(device.appium).toBe(serverMetadata);
        }
    });

    it("propagates a thrown instrumentation reset without retrying creation or publishing metadata", async () => {
        const { ports, device } = fixture();
        device.appium = serverMetadata;
        ports.publish = unexpected;
        ports.status = async () => ({ ok: true, ready: true, receipt: Symbol("ready") });
        const failure = new Error("controlled reset failure");
        const effects: string[] = [];
        ports.createSession = async () => {
            effects.push("create");
            return { ok: false, sessionId: null, instrumentationInitializationFailed: true, receipt: Symbol("instrumentation failure") };
        };
        ports.instrumentationAvailable = () => true;
        ports.resetInstrumentation = (serial, step) => {
            expect(serial).toBe("emulator-5580");
            effects.push(step);
            if (step === "uninstall-server") throw failure;
            return { ok: false, receipt: Symbol(step) };
        };
        await expect(createBrokerAppiumApplication(ports).ensureSession(owner, target)).rejects.toBe(failure);
        expect(effects).toEqual(["create", "force-stop-server", "force-stop-test", "uninstall-server"]);
        expect(device.appium).toBe(serverMetadata);
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
