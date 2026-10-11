import { describe, expect, it, vi } from "vitest";
import { createBrokerOwnerCleanupApplication } from "../../../packages/device-lab/src/device-lab/application/broker-owner-cleanup.js";
import type { BrokerOwnerCleanupPorts } from "../../../packages/device-lab/src/device-lab/ports/broker-owner-cleanup.js";
import { createBrokerPhysicalDevicesApplication } from "../../../packages/device-lab/src/device-lab/application/broker-physical-devices.js";
import type { BrokerPhysicalDevicesPorts } from "../../../packages/device-lab/src/device-lab/ports/broker-physical-devices.js";

function physicalPorts(): BrokerPhysicalDevicesPorts<string, { observed: boolean }> {
    return {
        deriveDeviceId: () => "phone", read: () => [],
        androidInventory: () => ({ ok: true, devices: [{ serial: "usb", state: "device", details: {}, connection: "usb", attachable: true }] }),
        connectAndroid: () => ({ status: 0, receipt: { observed: true } }), appleInventory: () => ({ status: 0, stdout: "visible", receipt: { observed: true } }),
        appleDevices: () => [{ name: "Phone", udid: "udid", version: "18", connection: "usb", availability: "available", raw: "visible" }],
        nonce: () => "nonce", timestamp: () => "now",
        claimLease: () => ({ kind: "claimed", created: true, lease: { claimId: "claim" } }),
        releaseClaim: () => ({ kind: "released", lease: { claimId: "claim" } }),
        claimDevice: (_owner, _state, device) => ({ ok: true, device, reattached: false }), heartbeat: () => ({ active: true }),
        withDetachLease: (_owner, _parsed, _device, operation) => operation({ handle: "claim", attempted: true, admission: { kind: "exact" }, canRestore: true }),
        withLeaseGuard: (_owner, _state, _record, operation) => operation({ handle: "claim", attempted: true, admission: { kind: "exact" }, canRestore: true }),
        releaseLease: () => ({ kind: "released", attempted: true, ok: true, lease: { claimId: "claim" } }), restoreLease: () => ({ kind: "restored", attempted: true, ok: true, lease: { claimId: "claim" }, heartbeat: null }),
        removeDevice: () => undefined,
        auxiliary: (_owner, _request, expected) => ({ result: { ok: true, changed: false, appium: { cleared: false }, recording: { cleared: false }, minimizeWatchdog: { cleared: false } }, device: expected, committed: false }),
        publish: (_owner, _state, _id, _expected, replacement) => ({ found: true, matched: true, device: replacement }),
        observePhysicalStop: () => ({ status: 0, receipt: { observed: true } }), clone: value => value,
    };
}

describe("broker physical devices", () => {
    const stopRequest = { backend: "android-device", stateKey: "android-device", deviceId: "phone", force: false, dryRun: false };
    it("publishes detached status against the committed auxiliary replacement", () => {
        const ports = physicalPorts(), initial = { id: "phone", status: "attached", appium: { serverPid: 21 }, leaseClaimId: "claim", leaseClaimNonce: "nonce" };
        const cleaned = { ...initial, appium: null, updatedAt: "cleaned" };
        ports.auxiliary = () => ({ result: { ok: true, changed: true, appium: { cleared: true }, recording: { cleared: false }, minimizeWatchdog: { cleared: false } }, device: cleaned, committed: true });
        const publish = vi.fn(ports.publish); ports.publish = publish;
        expect(createBrokerPhysicalDevicesApplication(ports).stop("owner", stopRequest, initial, initial)).toMatchObject({ kind: "stop-observed", success: true, device: { status: "detached", appium: null, leaseClaimId: null, leaseClaimNonce: null } });
        expect(publish).toHaveBeenCalledWith("owner", "android-device", "phone", cleaned, expect.objectContaining({ status: "detached" }));
    });

    it("does not restore a released stop lease against a successor conflict", () => {
        const ports = physicalPorts(), initial = { id: "phone", status: "attached" }, successor = { ...initial, generation: "new" };
        ports.publish = () => ({ found: true, matched: false, device: successor });
        ports.restoreLease = () => { throw new Error("unexpected successor restore"); };
        expect(createBrokerPhysicalDevicesApplication(ports).stop("owner", stopRequest, initial, initial)).toMatchObject({ kind: "stop-observed", success: true, publicationMatched: false, device: successor });
    });

    it("restores the stop lease after a genuine publication exception", () => {
        const ports = physicalPorts(), initial = { id: "phone", status: "attached" };
        ports.publish = () => { throw new Error("write failed"); };
        const restore = vi.fn(ports.restoreLease); ports.restoreLease = restore;
        expect(createBrokerPhysicalDevicesApplication(ports).stop("owner", stopRequest, initial, initial)).toMatchObject({ error: "owner-state-write-failed", leaseRollback: { attempted: true, ok: true } });
        expect(restore).toHaveBeenCalledWith("owner", expect.objectContaining({ handle: "claim" }));
    });

    it("keeps dry-run stop free of auxiliary and lease effects", () => {
        const ports = physicalPorts();
        ports.auxiliary = () => { throw new Error("unexpected cleanup"); };
        ports.releaseLease = () => { throw new Error("unexpected release"); };
        expect(createBrokerPhysicalDevicesApplication(ports).stop("owner", { ...stopRequest, dryRun: true }, { id: "phone" }, { id: "phone" })).toMatchObject({ kind: "stop-preview" });
    });

    it("does not release or publish after a failed physical stop observation", () => {
        const ports = physicalPorts(), initial = { id: "phone", status: "attached" };
        ports.observePhysicalStop = () => ({ status: 7, error: "native noop refused", receipt: { observed: true } });
        ports.releaseLease = () => { throw new Error("failed-observation-must-not-release"); };
        ports.publish = () => { throw new Error("failed-observation-must-not-publish"); };
        expect(createBrokerPhysicalDevicesApplication(ports).stop("owner", stopRequest, initial, initial)).toMatchObject({
            kind: "stop-observed", success: false, device: initial, release: null, execution: { status: 7 },
        });
    });

    it("retains partial auxiliary cleanup without releasing the stop lease", () => {
        const ports = physicalPorts(), initial = { id: "phone", appium: { serverPid: 21 }, recording: { pid: 22 } };
        ports.auxiliary = () => ({ result: { ok: false, changed: true, appium: { cleared: true }, recording: { cleared: false }, minimizeWatchdog: { cleared: false } }, device: { ...initial, appium: null }, committed: true });
        ports.releaseLease = () => { throw new Error("unexpected lease release"); };
        expect(createBrokerPhysicalDevicesApplication(ports).stop("owner", stopRequest, initial, initial)).toMatchObject({ kind: "stop-refused", category: "provider-failed", error: "auxiliary-runtime-cleanup-failed", invoked: false, device: { appium: null, recording: { pid: 22 } } });
    });

    it("attaches visible Android hardware and starts its published lease heartbeat", () => {
        const ports = physicalPorts();
        const heartbeat = vi.fn(ports.heartbeat); ports.heartbeat = heartbeat;
        expect(createBrokerPhysicalDevicesApplication(ports).attach("owner", { backend: "android-device", deviceId: "phone", serial: "usb" })).toMatchObject({ kind: "attached", device: { status: "attached", serial: "usb", leaseClaimId: "claim", leaseClaimNonce: "nonce" } });
        expect(heartbeat).toHaveBeenCalledWith("owner", "android-device", "usb", "phone", expect.objectContaining({ claimId: "claim" }), "nonce");
    });

    it("releases the exact Android claim when WiFi connection fails", () => {
        const ports = physicalPorts(); ports.connectAndroid = () => ({ status: 7, receipt: { observed: true } });
        const release = vi.fn(ports.releaseClaim); ports.releaseClaim = release;
        ports.claimDevice = () => { throw new Error("unexpected publication"); };
        expect(createBrokerPhysicalDevicesApplication(ports).attach("owner", { backend: "android-device", deviceId: "phone", connection: "wifi", host: "127.0.0.1" })).toMatchObject({ error: "adb-connect-failed" });
        expect(release).toHaveBeenCalledWith("owner", expect.objectContaining({ hardwareId: "127.0.0.1:5555", claimId: "claim", claimNonce: "nonce" }));
    });

    it("refuses an invisible iOS device before claiming a lease", () => {
        const ports = physicalPorts(); ports.appleDevices = () => [];
        ports.claimLease = () => { throw new Error("unexpected lease claim"); };
        expect(createBrokerPhysicalDevicesApplication(ports).attach("owner", { backend: "ios-device", deviceId: "phone", udid: "missing" })).toMatchObject({ error: "ios-device-not-visible" });
    });

    it("attaches visible iOS hardware using its observed connection", () => {
        const ports = physicalPorts();
        expect(createBrokerPhysicalDevicesApplication(ports).attach("owner", { backend: "ios-device", deviceId: "phone", udid: "udid" })).toMatchObject({ kind: "attached", device: { udid: "udid", connection: "usb", status: "attached", leaseClaimId: "claim", leaseClaimNonce: "nonce" } });
    });

    it("allows only the exact detached record to reattach", () => {
        const ports = physicalPorts(); ports.read = () => [{ id: "phone", serial: "usb", status: "detached" }];
        const app = createBrokerPhysicalDevicesApplication(ports);
        expect(app.attach("owner", { backend: "android-device", deviceId: "phone", serial: "usb" })).toMatchObject({ kind: "attached" });
        ports.read = () => [{ id: "other", serial: "usb", status: "detached" }];
        ports.claimLease = () => { throw new Error("unexpected conflicting claim"); };
        expect(app.attach("owner", { backend: "android-device", deviceId: "phone", serial: "usb" })).toMatchObject({ error: "owner-device-already-attached" });
    });

    it("refuses a foreign detach lease without auxiliary cleanup or definition removal", () => {
        const ports = physicalPorts(); ports.read = () => [{ id: "phone", serial: "usb", status: "attached" }];
        ports.withDetachLease = (_owner, _parsed, _record, operation) => operation({ handle: "foreign", attempted: true, admission: { kind: "refused", failure: { kind: "conflict", error: "claim-mismatch" } }, canRestore: false });
        ports.auxiliary = () => { throw new Error("unexpected runtime cleanup"); };
        ports.removeDevice = () => { throw new Error("unexpected definition removal"); };
        expect(createBrokerPhysicalDevicesApplication(ports).detach("owner", { backend: "android-device", deviceId: "phone" })).toMatchObject({ error: "physical-lease-release-failed" });
    });

    it("keeps pairing manual while accepting already-visible WiFi connect", () => {
        const ports = physicalPorts(), app = createBrokerPhysicalDevicesApplication(ports);
        expect(app.trust("owner", { action: "pair", udid: "udid" })).toMatchObject({ kind: "trust-refused", error: "ios-apple-pairing-manual-required", diagnostic: { manualRequired: true } });
        ports.appleDevices = () => [{ name: "Phone", udid: "udid", version: "18", connection: "wifi", availability: "available", raw: "visible" }];
        expect(app.trust("owner", { action: "connect", udid: "udid" })).toMatchObject({ kind: "trust-observed", diagnostic: { alreadyNetworkVisible: true, manualRequired: false } });
    });

    it("restores a released lease when detach definition removal throws", () => {
        const ports = physicalPorts(); ports.read = () => [{ id: "phone", serial: "usb", status: "attached" }];
        ports.removeDevice = () => { throw new Error("write denied"); };
        const restore = vi.fn(ports.restoreLease); ports.restoreLease = restore;
        expect(createBrokerPhysicalDevicesApplication(ports).detach("owner", { backend: "android-device", deviceId: "phone" })).toMatchObject({ error: "owner-state-write-failed" });
        expect(restore).toHaveBeenCalledWith("owner", expect.objectContaining({ handle: "claim" }));
    });
});

function cleanupPorts(): BrokerOwnerCleanupPorts<string, { deviceId: string }, { observed: boolean }> {
    return {
        stateKeys: ["android", "ios"], backendAliases: new Map([["android-emulator", "android"]]),
        stateBackends: new Map([["android", "android-emulator"], ["ios", "ios-simulator"]]),
        read: () => [], equal: (left, right) => left === right,
        publish: (_owner, _state, _id, _expected, replacement) => ({ found: true, matched: true, device: replacement }),
        withDeviceOperation: async (_owner, _state, _id, operation) => await operation(),
        withLeaseGuard: (_owner, _state, _record, operation) => operation({ handle: "claim", attempted: true, admission: { kind: "exact" }, canRestore: true }),
        releaseLease: () => ({ kind: "released", attempted: true, ok: true, lease: { claimId: "claim" } }), restoreLease: () => ({ kind: "restored", attempted: true, ok: true, lease: { claimId: "claim" }, heartbeat: null }),
        terminateAppium: () => ({ attempted: true, ok: true }), signalRecording: () => ({ attempted: true, ok: true }),
        cancelWatchdog: () => ({ ok: true }), prepareStop: (_owner, target) => ({ kind: "prepared", handle: { deviceId: target.deviceId } }),
        runPreparedStop: () => ({ ok: true, operationKind: "runtime-stop", receipt: { observed: true } }), releaseWindows: () => undefined, timestamp: () => "now",
        stateErrorCode: () => "owner-devices-state-read-failed", isDeviceLockTimeout: () => false,
    };
}

describe("broker owner cleanup", () => {
    it("refuses stale auxiliary cleanup before signaling successor runtime", () => {
        const ports = cleanupPorts(), expected = { id: "sim", appium: { serverPid: 21 } }, successor = { id: "sim", appium: { serverPid: 31 } };
        ports.read = () => [successor];
        ports.terminateAppium = () => { throw new Error("unexpected successor termination"); };
        expect(createBrokerOwnerCleanupApplication(ports).auxiliary("owner", { backend: "ios-simulator", stateKey: "ios", deviceId: "sim" }, expected)).toMatchObject({
            committed: false, device: successor, result: { ok: false, stateConflict: true, changed: false },
        });
    });
    it("skips an observed definition that disappeared before its device operation", async () => {
        const ports = cleanupPorts(), device = { id: "gone", status: "running" };
        ports.stateKeys = ["ios"]; ports.read = () => [device];
        ports.withDeviceOperation = async (_owner, _state, _id, operation) => {
            ports.read = () => [];
            return await operation();
        };
        ports.runPreparedStop = () => { throw new Error("unexpected provider mutation"); };
        expect(await createBrokerOwnerCleanupApplication(ports).cleanup("owner", {})).toMatchObject({ kind: "cleaned", changedDevices: 0, failed: 0, results: [{ devices: [{ skipped: true, reason: "device-no-longer-present" }] }] });
    });

    it("counts a provider failure and continues to the next device", async () => {
        const ports = cleanupPorts(), bad = { id: "bad", status: "running" }, good = { id: "good", status: "running" };
        ports.stateKeys = ["ios"]; ports.read = () => [bad, good];
        ports.runPreparedStop = handle => ({ ok: handle.deviceId !== "bad", operationKind: "runtime-stop", receipt: { observed: true } });
        expect(await createBrokerOwnerCleanupApplication(ports).cleanup("owner", {})).toMatchObject({ kind: "cleaned", changedDevices: 1, failed: 1, results: [{ devices: [
                { deviceId: "bad", stop: { attempted: true, ok: false } },
                { deviceId: "good", stop: { attempted: true, ok: true } },
            ] }] });
    });

    it("rejects an unknown backend without reading owner state", async () => {
        const ports = cleanupPorts(); ports.read = () => { throw new Error("unexpected read"); };
        expect(await createBrokerOwnerCleanupApplication(ports).cleanup("owner", { backend: "unknown" })).toMatchObject({ kind: "invalid-backend", error: "invalid-cleanup-backend" });
    });

    it("continues after a backend read failure and publishes the healthy backend stop", async () => {
        const ports = cleanupPorts(), device = { id: "sim", status: "running" };
        ports.read = (_owner, state) => { if (state === "android") throw new Error("corrupt"); return [device]; };
        const publish = vi.fn(ports.publish); ports.publish = publish;
        expect(await createBrokerOwnerCleanupApplication(ports).cleanup("owner", {})).toMatchObject({ kind: "cleaned", changedDevices: 1, failed: 1, results: [
                { stateKey: "android", ok: false, error: "owner-devices-state-read-failed" },
                { stateKey: "ios", ok: true, changed: true },
            ] });
        expect(publish).toHaveBeenCalledWith("owner", "ios", "sim", device, expect.objectContaining({ status: "stopped" }));
    });

    it("keeps refused recording metadata while committing a successful Appium clear", () => {
        const ports = cleanupPorts(), recording = { pid: 22 }, appium = { serverPid: 21 };
        ports.signalRecording = () => ({ attempted: true, ok: false, reason: "identity-mismatch" });
        const app = createBrokerOwnerCleanupApplication(ports);
        expect(app.cleanupDevice("owner", "ios", { id: "sim", status: "stopped", recording, appium }, { stopDevices: false, detachPhysical: false })).toMatchObject({
            changed: true, device: { recording, appium: null },
            result: { recording: { cleared: false }, appium: { cleared: true } },
        });
    });

    it("restores an exactly released physical lease only when owner publication throws", async () => {
        const ports = cleanupPorts(), device = { id: "phone", status: "attached", serial: "usb" };
        ports.stateKeys = ["android-device"]; ports.read = () => [device];
        ports.publish = () => { throw new Error("write denied"); };
        const restore = vi.fn(ports.restoreLease); ports.restoreLease = restore;
        expect(await createBrokerOwnerCleanupApplication(ports).cleanup("owner", {})).toMatchObject({ kind: "cleaned", changedDevices: 0, failed: 1, results: [{ devices: [{ stateWrite: {
                ok: false, error: "owner-state-write-failed", leaseRollback: { attempted: true, ok: true },
            } }] }] });
        expect(restore).toHaveBeenCalledWith("owner", expect.objectContaining({ handle: "claim" }));
    });

    it("reports a successor conflict without restoring against its new generation", async () => {
        const ports = cleanupPorts(), device = { id: "phone", status: "attached", serial: "usb" }, successor = { ...device, generation: "new" };
        ports.stateKeys = ["android-device"]; ports.read = () => [device];
        ports.publish = () => ({ found: true, matched: false, device: successor });
        ports.restoreLease = () => { throw new Error("unexpected successor rollback"); };
        expect(await createBrokerOwnerCleanupApplication(ports).cleanup("owner", {})).toMatchObject({ kind: "cleaned", changedDevices: 0, failed: 1, results: [{ devices: [{ stateConflict: true }] }] });
    });
});

describe("owner stop native-effect refusals", () => {
    const device = { id: "sim", status: "running" };
    it("reports unavailable preparation without invoking a stop or publishing", async () => {
        const ports = cleanupPorts(); ports.stateKeys = ["ios"]; ports.read = () => [device];
        ports.prepareStop = () => ({ kind: "unavailable", error: "provider unavailable", missing: ["provider"] });
        ports.runPreparedStop = () => { throw new Error("unavailable-provider-must-not-run"); };
        ports.publish = () => { throw new Error("unavailable-provider-must-not-publish"); };
        expect(await createBrokerOwnerCleanupApplication(ports).cleanup("owner", {})).toMatchObject({
            kind: "cleaned", changedDevices: 0, results: [{ devices: [{ stop: { attempted: false, ok: false, error: "provider unavailable" } }] }],
        });
    });
    it("retains a failed metadata-only observation without publication", async () => {
        const ports = cleanupPorts(); ports.stateKeys = ["ios"]; ports.read = () => [device];
        ports.runPreparedStop = () => ({ ok: false, operationKind: "metadata-only", receipt: { observed: true } });
        ports.publish = () => { throw new Error("failed-noop-must-not-publish"); };
        expect(await createBrokerOwnerCleanupApplication(ports).cleanup("owner", {})).toMatchObject({
            kind: "cleaned", changedDevices: 0, failed: 1, results: [{ devices: [{ stop: { attempted: true, ok: false, observation: { operationKind: "metadata-only" } } }] }],
        });
    });
    it("propagates raw preparation and runner exceptions without continuing the batch", async () => {
        const preparation = cleanupPorts(); preparation.stateKeys = ["ios"]; preparation.read = () => [device];
        const prepareFault = new Error("native preparation"); preparation.prepareStop = () => { throw prepareFault; };
        await expect(createBrokerOwnerCleanupApplication(preparation).cleanup("owner", {})).rejects.toBe(prepareFault);
        const execution = cleanupPorts(); execution.stateKeys = ["ios"]; execution.read = () => [device];
        const runFault = new Error("native run"); execution.runPreparedStop = () => { throw runFault; };
        await expect(createBrokerOwnerCleanupApplication(execution).cleanup("owner", {})).rejects.toBe(runFault);
    });
});
