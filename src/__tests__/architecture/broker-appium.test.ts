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
        http: unexpected, launchServer: unexpected, installRuntime: unexpected,
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

    it("preserves the captured session when upstream deletion fails", async () => {
        const { ports, device } = fixture();
        const previous = { ...serverMetadata, sessionId: "session-one", sessionCapabilities: { platformName: "Android" } };
        device.appium = previous;
        ports.publish = unexpected;
        ports.http = async (url, options) => {
            expect(url).toBe("http://127.0.0.1:4723/session/session-one");
            expect(options.method).toBe("DELETE");
            return { ok: false, status: 500, body: { value: { error: "delete failed" } } };
        };
        const app = createBrokerAppiumApplication(ports);
        expect(await app.deleteSession(owner, target)).toMatchObject({ kind: "session-delete-failed", error: "appium-session-delete-failed" });
        expect(device.appium).toEqual(previous);
    });

    it("deletes only session fields while retaining the managed server generation", async () => {
        const { ports, device } = fixture();
        device.appium = { ...serverMetadata, sessionId: "session-one", sessionCapabilities: { platformName: "Android" } };
        ports.http = async () => ({ ok: true, status: 200, body: { value: null } });
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

    it("compensates only the newly created session when a successor wins publication", async () => {
        const { ports, device } = fixture();
        device.appium = serverMetadata;
        const successor = { ...serverMetadata, runtimeId: "successor", sessionId: "successor-session" };
        let compensated = false;
        ports.http = async (url, options) => {
            if (url === "http://127.0.0.1:4723/status") return { ok: true, status: 200, body: { value: { ready: true } } };
            if (url === "http://127.0.0.1:4723/session" && options.method === "POST") {
                return { ok: true, status: 200, body: { value: { sessionId: "created-session" } } };
            }
            expect(url).toBe("http://127.0.0.1:4723/session/created-session");
            expect(options.method).toBe("DELETE");
            compensated = true;
            return { ok: true, status: 200, body: { value: null } };
        };
        ports.publish = (_owner, _state, _id, expected, replacement) => {
            expect(expected).toMatchObject({ runtimeId: "runtime-one" });
            expect(replacement).toMatchObject({ sessionId: "created-session" });
            device.appium = successor;
            return { found: true, matched: false, currentAppium: successor, device };
        };
        const app = createBrokerAppiumApplication(ports);
        expect(await app.ensureSession(owner, target)).toMatchObject({ kind: "refused", reason: "conflict", error: "appium-runtime-state-conflict" });
        expect(compensated).toBe(true);
        expect(device.appium).toEqual(successor);
    });
});
