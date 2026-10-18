import { describe, expect, it, vi } from "vitest";
import { createBrokerOwnerCleanupApplication } from "../../../packages/device-lab/src/device-lab/application/broker-owner-cleanup.js";
import type { BrokerOwnerAuxiliaryAsyncPorts, BrokerOwnerCleanupPorts } from "../../../packages/device-lab/src/device-lab/ports/broker-owner-cleanup.js";
import type { CleanupTermination } from "../../../packages/device-lab/src/device-lab/domain/broker-owner-cleanup.js";
import { createBrokerPhysicalDevicesApplication } from "../../../packages/device-lab/src/device-lab/application/broker-physical-devices.js";
import type { BrokerPhysicalDevicesPorts } from "../../../packages/device-lab/src/device-lab/ports/broker-physical-devices.js";
import { normalizeAppleInventory, normalizePhysicalExecution, renderAppleTrustDiagnostic, renderPhysicalAttachOutcome, renderPhysicalStopOutcome } from "../../../packages/device-lab/src/device-lab/broker/physical-outcomes.js";
import { appleTrustFacts } from "../../../packages/device-lab/src/device-lab/domain/broker-physical-devices.js";

function physicalPorts(): BrokerPhysicalDevicesPorts<string, { observed: boolean }> {
    return {
        deriveDeviceId: () => "phone", read: () => [],
        androidInventory: () => ({ ok: true, devices: [{ serial: "usb", state: "device", details: {}, connection: "usb", attachable: true }] }),
        connectAndroid: () => ({ ok: true, receipt: { observed: true } }),
        appleInventory: () => ({ kind: "observed", receipt: { observed: true }, devices: [{ name: "Phone", udid: "udid", version: "18", connection: "usb", availability: "available", raw: "visible" }] }),
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
        observePhysicalStop: () => ({ ok: true, receipt: { observed: true } }), clone: value => value,
    };
}

describe("broker physical devices", () => {
    const stopRequest = { backend: "android-device", stateKey: "android-device", deviceId: "phone", force: false, dryRun: false };
    it.each([0, 2])("refuses %i attachable USB candidates before claiming", count => {
        const ports = physicalPorts();
        const candidates = Array.from({ length: count }, (_, index) => ({ serial: `usb-${index}`, state: "device", details: {}, connection: "usb", attachable: true }));
        ports.androidInventory = () => ({ ok: true, devices: [...candidates, { serial: "wifi:5555", state: "device", details: {}, connection: "wifi", attachable: true }] });
        const claim = vi.fn(ports.claimLease); ports.claimLease = claim;
        const outcome = createBrokerPhysicalDevicesApplication(ports).attach("owner", { backend: "android-device", deviceId: "phone" });
        expect(outcome).toMatchObject({ kind: "attach-refused", category: count ? "conflict" : "missing", selectionReason: count ? "multiple-attachable-usb" : "no-attachable-usb", candidates });
        expect(claim).not.toHaveBeenCalled();
        expect(renderPhysicalAttachOutcome({ kind: "attach-refused", category: count ? "conflict" : "missing", error: count ? "android-device-selection-required" : "android-device-not-visible", selectionReason: count ? "multiple-attachable-usb" : "no-attachable-usb", candidates })).toMatchObject({ status: count ? 409 : 404, payload: { message: count ? "Multiple attachable USB Android devices are visible; pass serial." : "No attachable USB Android device is visible to host adb." } });
    });

    it("selects the sole attachable USB candidate while ignoring WiFi and unavailable devices", () => {
        const ports = physicalPorts(), inventory = ports.androidInventory();
        ports.androidInventory = vi.fn(() => ({ ...inventory, devices: [...inventory.devices, { serial: "offline", state: "offline", details: {}, connection: "usb", attachable: false }] }));
        expect(createBrokerPhysicalDevicesApplication(ports).attach("owner", { backend: "android-device", deviceId: "phone" })).toMatchObject({ kind: "attached", device: { serial: "usb" } });
        expect(ports.androidInventory).toHaveBeenCalledTimes(1);
    });

    it("holds the exact Android claim during connect and publishes before heartbeat", () => {
        const ports = physicalPorts(); let claimed = false, published = false;
        ports.claimLease = (owner, request) => { expect(owner).toBe("owner"); expect(request).toMatchObject({ hardwareId: "host:5555", claimNonce: "nonce" }); claimed = true; return { kind: "claimed", created: true, lease: { claimId: "claim" } }; };
        ports.connectAndroid = target => { expect(claimed).toBe(true); expect(target).toBe("host:5555"); return { ok: true, receipt: { observed: true, status: 7, error: "opaque native detail" } }; };
        ports.androidInventory = () => ({ ok: true, devices: [{ serial: "host:5555", state: "device", details: {}, connection: "wifi", attachable: true }] });
        ports.claimDevice = (_owner, _state, device) => { published = true; return { ok: true, device, reattached: false }; };
        ports.heartbeat = () => { expect(published).toBe(true); return { active: true }; };
        expect(createBrokerPhysicalDevicesApplication(ports).attach("owner", { backend: "android-device", deviceId: "phone", connection: "wifi", host: "host" })).toMatchObject({ kind: "attached" });
    });

    it.each(["connect", "inventory", "stop"])("preserves thrown native %s faults without adding claim rescue", phase => {
        const ports = physicalPorts(), fault = new Error("native fault"), release = vi.fn(ports.releaseClaim), releaseStop = vi.fn(ports.releaseLease), publish = vi.fn(ports.publish);
        ports.releaseClaim = release; ports.releaseLease = releaseStop; ports.publish = publish;
        if (phase === "connect") ports.connectAndroid = () => { throw fault; };
        else if (phase === "inventory") ports.androidInventory = () => { throw fault; };
        else ports.observePhysicalStop = () => { throw fault; };
        const app = createBrokerPhysicalDevicesApplication(ports);
        expect(() => phase === "stop" ? app.stop("owner", stopRequest, { id: "phone" }, { id: "phone" }) : app.attach("owner", { backend: "android-device", deviceId: "phone", connection: "wifi", host: "host" })).toThrow(fault);
        expect(release).not.toHaveBeenCalled();
        expect(releaseStop).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
    });

    it.each(["inventory", "publication"])("compensates returned %s refusal with the exact claim and no heartbeat", phase => {
        const ports = physicalPorts(), release = vi.fn(ports.releaseClaim), heartbeat = vi.fn(ports.heartbeat);
        ports.releaseClaim = release; ports.heartbeat = heartbeat;
        if (phase === "inventory") ports.androidInventory = () => ({ ok: false, devices: [] });
        else ports.claimDevice = () => ({ ok: false, error: "owner-device-state-conflict", existing: { generation: "successor" } });
        expect(createBrokerPhysicalDevicesApplication(ports).attach("owner", { backend: "android-device", deviceId: "phone", serial: "usb" })).toMatchObject({ kind: "attach-refused" });
        expect(release).toHaveBeenCalledWith("owner", { backend: "android-device", hardwareId: "usb", deviceId: "phone", claimId: "claim", claimNonce: "nonce" });
        expect(heartbeat).not.toHaveBeenCalled();
    });

    it.each(["missing-executable", "command-failed"] as const)("keeps Apple %s failure distinct before admission", reason => {
        const ports = physicalPorts(); ports.appleInventory = () => ({ kind: "failed", reason, receipt: { observed: true } });
        const claim = vi.fn(ports.claimLease); ports.claimLease = claim;
        const app = createBrokerPhysicalDevicesApplication(ports);
        expect(app.attach("owner", { backend: "ios-device", deviceId: "phone", udid: "udid" })).toMatchObject({ error: "xctrace-inventory-failed" });
        expect(app.trust("owner", { action: "status", udid: "udid" })).toMatchObject({ error: reason === "missing-executable" ? "ios-wireless-missing-xcrun" : "xctrace-inventory-failed" });
        expect(claim).not.toHaveBeenCalled();
    });

    it.each(["unavailable", "usb"])("refuses iOS %s before the lease when WiFi attach is requested", condition => {
        const ports = physicalPorts(); ports.appleInventory = () => ({ kind: "observed", receipt: { observed: true }, devices: [{ name: "Phone", udid: "udid", version: "18", connection: "usb", availability: condition === "unavailable" ? "unavailable" : "available", raw: "visible" }] });
        const claim = vi.fn(ports.claimLease); ports.claimLease = claim;
        expect(createBrokerPhysicalDevicesApplication(ports).attach("owner", { backend: "ios-device", deviceId: "phone", udid: "udid", connection: "wifi" })).toMatchObject({ error: condition === "unavailable" ? "ios-device-not-attachable" : "ios-wifi-device-not-network-visible" });
        expect(claim).not.toHaveBeenCalled();
    });
    it("publishes detached status against the committed auxiliary replacement", () => {
        const ports = physicalPorts(), initial = { id: "phone", status: "attached", appium: { serverPid: 21 }, leaseClaimId: "claim", leaseClaimNonce: "nonce" };
        const cleaned = { ...initial, appium: null, updatedAt: "cleaned" }, receipt = { observed: true, status: 7, error: "opaque native detail" };
        ports.observePhysicalStop = () => ({ ok: true, receipt });
        ports.auxiliary = () => ({ result: { ok: true, changed: true, appium: { cleared: true }, recording: { cleared: false }, minimizeWatchdog: { cleared: false } }, device: cleaned, committed: true });
        const publish = vi.fn(ports.publish); ports.publish = publish;
        const outcome = createBrokerPhysicalDevicesApplication(ports).stop("owner", stopRequest, initial, initial);
        expect(outcome).toMatchObject({ kind: "stop-observed", success: true, device: { status: "detached", appium: null, leaseClaimId: null, leaseClaimNonce: null }, execution: { ok: true, receipt } });
        if (outcome.kind === "stop-observed") expect(outcome.execution.receipt).toBe(receipt);
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
        ports.observePhysicalStop = () => { throw new Error("unexpected physical observation"); };
        ports.releaseLease = () => { throw new Error("unexpected release"); };
        expect(createBrokerPhysicalDevicesApplication(ports).stop("owner", { ...stopRequest, dryRun: true }, { id: "phone" }, { id: "phone" })).toMatchObject({ kind: "stop-preview" });
    });

    it("does not release or publish after a failed physical stop observation", () => {
        const ports = physicalPorts(), initial = { id: "phone", status: "attached" }, receipt = { observed: true, status: 0 };
        ports.observePhysicalStop = () => ({ ok: false, receipt });
        ports.releaseLease = () => { throw new Error("failed-observation-must-not-release"); };
        ports.publish = () => { throw new Error("failed-observation-must-not-publish"); };
        expect(createBrokerPhysicalDevicesApplication(ports).stop("owner", stopRequest, initial, initial)).toMatchObject({
            kind: "stop-observed", success: false, device: initial, release: null, execution: { ok: false, receipt },
        });
    });

    it("retains partial auxiliary cleanup without releasing the stop lease", () => {
        const ports = physicalPorts(), initial = { id: "phone", appium: { serverPid: 21 }, recording: { pid: 22 } };
        ports.auxiliary = () => ({ result: { ok: false, changed: true, appium: { cleared: true }, recording: { cleared: false }, minimizeWatchdog: { cleared: false } }, device: { ...initial, appium: null }, committed: true });
        ports.observePhysicalStop = () => { throw new Error("unexpected physical observation"); };
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
        const ports = physicalPorts(), receipt = { observed: true, status: 0 };
        ports.connectAndroid = () => ({ ok: false, receipt });
        const release = vi.fn(ports.releaseClaim), heartbeat = vi.fn(ports.heartbeat); ports.releaseClaim = release; ports.heartbeat = heartbeat;
        ports.androidInventory = () => { throw new Error("unexpected inventory after refused connect"); };
        ports.claimDevice = () => { throw new Error("unexpected publication"); };
        const outcome = createBrokerPhysicalDevicesApplication(ports).attach("owner", { backend: "android-device", deviceId: "phone", connection: "wifi", host: "127.0.0.1" });
        expect(outcome).toMatchObject({ error: "adb-connect-failed", command: { ok: false, receipt } });
        if (outcome.kind === "attach-refused") expect(outcome.command?.receipt).toBe(receipt);
        expect(release).toHaveBeenCalledWith("owner", expect.objectContaining({ hardwareId: "127.0.0.1:5555", claimId: "claim", claimNonce: "nonce" }));
        expect(heartbeat).not.toHaveBeenCalled();
    });

    it("refuses an invisible iOS device before claiming a lease", () => {
        const ports = physicalPorts(); ports.appleInventory = () => ({ kind: "observed", devices: [], receipt: { observed: true } });
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
        ports.appleInventory = () => ({ kind: "observed", receipt: { observed: true }, devices: [{ name: "Phone", udid: "udid", version: "18", connection: "wifi", availability: "available", raw: "visible" }] });
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

describe("native physical observations and Apple inventory presentation", () => {
    it.each([
        { status: 1, error: "executable-not-found", reason: "missing-executable" },
        { status: 1, error: undefined, reason: "command-failed" },
        { status: 0, error: "native error", reason: "command-failed" },
        { status: null, error: undefined, reason: "command-failed" },
        { status: undefined, error: undefined, reason: "command-failed" },
    ] as const)("refuses status $status / $error before parsing and retains opaque receipt", ({ status, error, reason }) => {
        const execution = { mode: "exec", provider: "xcrun", status, error, stdout: "untrusted devices" };
        const receipt = { command: { mode: "exec" as const, provider: "xcrun" }, execution }, parse = vi.fn(() => []);
        const observation = { status, error, stdout: "untrusted devices", receipt };
        const result = normalizeAppleInventory(observation, parse), command = normalizePhysicalExecution(observation);
        expect(result).toEqual({ kind: "failed", reason, receipt });
        expect(result.receipt).toBe(receipt);
        expect(parse).not.toHaveBeenCalled();
        expect(command).toEqual({ ok: false, receipt });
        expect(command.receipt).toBe(receipt);
        expect(renderPhysicalAttachOutcome({ kind: "attach-refused", category: "provider-failed", error: "xctrace-inventory-failed", command: result })).toEqual({
            status: 502, payload: { ok: false, error: "xctrace-inventory-failed", command: execution },
        });
    });

    it("passes empty successful output to the parser and reports empty inventory", () => {
        const receipt = { native: "private" }, parse = vi.fn(() => []);
        const observation = { status: 0, receipt }, result = normalizeAppleInventory(observation, parse);
        expect(result).toEqual({ kind: "observed", devices: [], receipt });
        expect(result.receipt).toBe(receipt);
        expect(parse).toHaveBeenCalledWith("");
        expect(normalizePhysicalExecution(observation)).toEqual({ ok: true, receipt });
        const stopReceipt = { command: { mode: "noop" as const, provider: "adb" }, execution: { mode: "noop", provider: "adb", status: 0 } };
        const execution = normalizePhysicalExecution({ status: 0, receipt: stopReceipt });
        expect(execution.receipt).toBe(stopReceipt);
        const auxiliaryCleanup = { ok: true, changed: false, appium: { cleared: false }, recording: { cleared: false }, minimizeWatchdog: { cleared: false } };
        expect(renderPhysicalStopOutcome({ kind: "stop-observed", success: true, device: { status: "detached" }, auxiliaryCleanup, release: null, execution, invoked: true, dryRun: false, mutatesHost: true, publicationMatched: true }, {}, value => value)).toEqual({
            status: 200, payload: { ok: true, result: { providerCommand: stopReceipt.command, device: { status: "detached" }, auxiliaryCleanup, invoked: true, dryRun: false, execution: { mode: "noop", providerExecution: "executed", mutatesHost: true, command: stopReceipt.execution } } },
        });
    });

    it("forwards successful native inventory stdout unchanged for xctrace decoding", () => {
        const stdout = "== Devices ==\r\n  iPhone (18.0) (00008110-0011223344556677) (Network)\r\n", receipt = { native: "private" };
        const device = { name: "iPhone", udid: "00008110-0011223344556677", version: "18.0", connection: "wifi", availability: "available", raw: "visible" }, parse = vi.fn(() => [device]);
        const observation = { status: 0, error: "", stdout, receipt };
        expect(normalizeAppleInventory(observation, parse)).toEqual({ kind: "observed", devices: [device], receipt });
        expect(normalizePhysicalExecution(observation)).toEqual({ ok: true, receipt });
        expect(parse).toHaveBeenCalledWith(stdout);
        expect(parse).toHaveBeenCalledTimes(1);
    });

    it.each(["absent", "usb", "wifi", "unavailable"])("presents Apple %s visibility with the existing manual guidance", visibility => {
        const selected = visibility === "absent" ? null : { name: "Phone", udid: "udid", version: "18", connection: visibility === "wifi" ? "wifi" : "usb", availability: visibility === "unavailable" ? "unavailable" : "available", raw: "visible" };
        const diagnostic = renderAppleTrustDiagnostic(appleTrustFacts("status", "udid", selected));
        expect(diagnostic).toMatchObject({ backend: "ios-device", provider: "xcrun-xctrace", action: "status", udid: "udid", selected, visible: visibility !== "absent", networkVisible: visibility === "wifi", readyToAttach: visibility === "usb" || visibility === "wifi", manualRequired: visibility === "absent" || visibility === "unavailable", supportedActions: ["status"], unsupportedActions: ["pair", "connect"], safety: { bypassesTrustPrompt: false, powersOffDevice: false, erasesDevice: false, disconnectsDevice: false } });
        expect(diagnostic.manualSteps).toEqual([
            "Connect the iPhone or iPad to the macOS host over USB, unlock it, and accept the Trust This Computer prompt.",
            "Enable Developer Mode on the device when iOS requires it.",
            "Open Xcode Devices and Simulators on the macOS host and enable network pairing if Wi-Fi attach is needed.",
            "Re-run device_wireless with backend=ios-device and action=status, then call device_attach when xctrace reports the UDID as USB or Network.",
        ]);
        expect(diagnostic.attachFlow).toBe(visibility === "wifi" ? "Call device_attach with backend=ios-device, connection=wifi, and this UDID." : visibility === "usb" ? "Call device_attach with backend=ios-device and this UDID for USB attach, or complete Xcode network pairing first for Wi-Fi attach." : "Complete Apple trust, Developer Mode, and Xcode pairing on the macOS host, then re-run this status check.");
    });
});

function cleanupPorts(): BrokerOwnerCleanupPorts<string, { observed: boolean }> {
    return {
        stateKeys: ["android", "ios"], backendAliases: new Map([["android-emulator", "android"]]),
        stateBackends: new Map([["android", "android-emulator"], ["ios", "ios-simulator"]]),
        read: () => [], equal: (left, right) => left === right,
        publish: (_owner, _state, _id, _expected, replacement) => ({ found: true, matched: true, device: replacement }),
        withDeviceOperation: async (_owner, _state, _id, operation) => await operation(),
        withLeaseGuard: (_owner, _state, _record, operation) => operation({ handle: "claim", attempted: true, admission: { kind: "exact" }, canRestore: true }),
        releaseLease: () => ({ kind: "released", attempted: true, ok: true, lease: { claimId: "claim" } }), restoreLease: () => ({ kind: "restored", attempted: true, ok: true, lease: { claimId: "claim" }, heartbeat: null }),
        terminateAppium: () => ({ ok: true, ended: true, receipt: { attempted: true, ok: true } }),
        signalRecording: () => ({ ok: true, ended: true, receipt: { attempted: true, ok: true } }),
        cancelWatchdog: () => ({ ok: true }),
        stopLocked: async () => ({ attempted: true, ok: true, changed: true, observation: { ok: true, operationKind: "runtime-stop", receipt: { observed: true } } }),
        timestamp: () => "now",
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
        ports.stopLocked = async () => { throw new Error("unexpected provider mutation"); };
        expect(await createBrokerOwnerCleanupApplication(ports).cleanup("owner", {})).toMatchObject({ kind: "cleaned", changedDevices: 0, failed: 0, results: [{ devices: [{ skipped: true, reason: "device-no-longer-present" }] }] });
    });

    it("counts a provider failure and continues to the next device", async () => {
        const ports = cleanupPorts(), bad = { id: "bad", status: "running" }, good = { id: "good", status: "running" };
        ports.stateKeys = ["ios"]; ports.read = () => [bad, good];
        ports.stopLocked = async (_owner, target) => ({ attempted: true, ok: target.deviceId !== "bad", changed: target.deviceId !== "bad", observation: { ok: target.deviceId !== "bad", operationKind: "runtime-stop", receipt: { observed: true } } });
        expect(await createBrokerOwnerCleanupApplication(ports).cleanup("owner", {})).toMatchObject({ kind: "cleaned", changedDevices: 1, failed: 1, results: [{ devices: [
                { deviceId: "bad", stop: { attempted: true, ok: false } },
                { deviceId: "good", stop: { attempted: true, ok: true } },
            ] }] });
    });

    it("rejects an unknown backend without reading owner state", async () => {
        const ports = cleanupPorts(); ports.read = () => { throw new Error("unexpected read"); };
        expect(await createBrokerOwnerCleanupApplication(ports).cleanup("owner", { backend: "unknown" })).toMatchObject({ kind: "invalid-backend", error: "invalid-cleanup-backend" });
    });

    it("continues after a backend read failure using the healthy backend's canonical stop", async () => {
        const ports = cleanupPorts(), device = { id: "sim", status: "running" };
        ports.read = (_owner, state) => { if (state === "android") throw new Error("corrupt"); return [device]; };
        const stop = vi.fn(ports.stopLocked), publish = vi.fn(ports.publish); ports.stopLocked = stop; ports.publish = publish;
        expect(await createBrokerOwnerCleanupApplication(ports).cleanup("owner", {})).toMatchObject({ kind: "cleaned", changedDevices: 1, failed: 1, results: [
                { stateKey: "android", ok: false, error: "owner-devices-state-read-failed" },
                { stateKey: "ios", ok: true, changed: true },
            ] });
        expect(stop).toHaveBeenCalledWith("owner", { backend: "ios-simulator", stateKey: "ios", deviceId: "sim" }, device);
        expect(publish).not.toHaveBeenCalled();
    });

    it("keeps refused recording metadata while committing a confirmed Appium clear", () => {
        const ports = cleanupPorts(), recording = { pid: 22 }, appium = { serverPid: 21 };
        const initial = { id: "sim", status: "stopped", recording, appium };
        ports.read = () => [initial];
        ports.signalRecording = () => ({ ok: false, ended: false, receipt: { attempted: true, ok: false, reason: "identity-mismatch" } });
        const app = createBrokerOwnerCleanupApplication(ports);
        expect(app.auxiliary("owner", { backend: "ios-simulator", stateKey: "ios", deviceId: "sim" }, initial)).toMatchObject({
            committed: true, device: { recording, appium: null },
            result: { ok: false, changed: true, recording: { cleared: false }, appium: { cleared: true } },
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
    it("counts a refused canonical stop without publishing owner state", async () => {
        const ports = cleanupPorts(); ports.stateKeys = ["ios"]; ports.read = () => [device];
        ports.stopLocked = async () => ({ attempted: false, ok: false, changed: false, error: "provider unavailable", missing: ["provider"] });
        ports.publish = () => { throw new Error("unavailable-provider-must-not-publish"); };
        expect(await createBrokerOwnerCleanupApplication(ports).cleanup("owner", {})).toMatchObject({
            kind: "cleaned", changedDevices: 0, failed: 1, results: [{ devices: [{ stop: { attempted: false, ok: false, error: "provider unavailable", missing: ["provider"] } }] }],
        });
    });
    it("retains a failed metadata-only observation without publication", async () => {
        const ports = cleanupPorts(); ports.stateKeys = ["ios"]; ports.read = () => [device];
        ports.stopLocked = async () => ({ attempted: true, ok: false, changed: false, observation: { ok: false, operationKind: "metadata-only", receipt: { observed: true } } });
        ports.publish = () => { throw new Error("failed-noop-must-not-publish"); };
        expect(await createBrokerOwnerCleanupApplication(ports).cleanup("owner", {})).toMatchObject({
            kind: "cleaned", changedDevices: 0, failed: 1, results: [{ devices: [{ stop: { attempted: true, ok: false, observation: { operationKind: "metadata-only" } } }] }],
        });
    });
    it("propagates raw canonical stop exceptions without continuing the batch", async () => {
        const execution = cleanupPorts(); execution.stateKeys = ["ios"]; execution.read = () => [device];
        const runFault = new Error("native run"); execution.stopLocked = async () => { throw runFault; };
        await expect(createBrokerOwnerCleanupApplication(execution).cleanup("owner", {})).rejects.toBe(runFault);
    });
});

describe("owner cleanup completion proof", () => {
    const target = { backend: "ios-simulator", stateKey: "ios", deviceId: "sim" };

    it.each(["appium", "recording"] as const)("keeps %s metadata when a successful signal has no exit proof", field => {
        const ports = cleanupPorts(), runtime = field === "appium" ? { serverPid: 21 } : { pid: 22 };
        const device = { id: "sim", status: "stopped", [field]: runtime };
        const receipt = { attempted: true, ok: true, nativeDetail: "signal accepted" };
        ports.read = () => [device];
        const notEnded = () => ({ ok: true, ended: false, receipt });
        if (field === "appium") ports.terminateAppium = notEnded;
        else ports.signalRecording = notEnded;
        const publish = vi.fn(ports.publish); ports.publish = publish;
        const outcome = createBrokerOwnerCleanupApplication(ports).auxiliary("owner", target, device);
        expect(outcome).toMatchObject({ committed: false, device, result: { ok: false, changed: false, [field]: { cleared: false, signal: { attempted: true, ok: false, nativeDetail: "signal accepted" } } } });
        expect(outcome.result[field].signal).not.toHaveProperty("ended");
        expect(outcome.result[field].signal).not.toHaveProperty("receipt");
        expect(receipt.ok).toBe(true);
        expect(publish).not.toHaveBeenCalled();
    });

    it.each(["appium", "recording"] as const)("retains the physical lease when %s termination is unavailable", async field => {
        const ports = cleanupPorts(), runtime = field === "appium" ? { serverPid: 21 } : { pid: 22 };
        const device = { id: "phone", status: "attached", serial: "usb", [field]: runtime };
        ports.stateKeys = ["ios-device"]; ports.read = () => [device];
        const unavailable = () => ({ ok: false, ended: false, receipt: { attempted: false, ok: false, reason: "identity-unavailable" } });
        if (field === "appium") ports.terminateAppium = unavailable;
        else ports.signalRecording = unavailable;
        const release = vi.fn(ports.releaseLease), publish = vi.fn(ports.publish); ports.releaseLease = release; ports.publish = publish;
        const outcome = await createBrokerOwnerCleanupApplication(ports).cleanup("owner", {});
        expect(outcome).toMatchObject({ kind: "cleaned", failed: 1, changedDevices: 0, results: [{ devices: [{ [field]: { cleared: false, signal: { ok: false } } }] }] });
        expect(release).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
        expect(device[field]).toBe(runtime);
    });

    it("does not treat an unattempted successful no-op as proof that the owned Appium runtime ended", () => {
        const ports = cleanupPorts(), device = { id: "sim", appium: { serverPid: 21 } };
        ports.read = () => [device];
        ports.terminateAppium = () => ({ ok: true, ended: false, receipt: { attempted: false, ok: true } });
        ports.publish = () => { throw new Error("no-op-is-not-exit-proof"); };
        expect(createBrokerOwnerCleanupApplication(ports).auxiliary("owner", target, device)).toMatchObject({ committed: false, result: { ok: false, appium: { cleared: false, signal: { attempted: false, ok: false } } } });
    });

    it("does not signal later runtimes or publish after the predecessor changes during Appium termination", () => {
        const ports = cleanupPorts(), initial = {
            id: "sim", appium: { serverPid: 21 }, recording: { pid: 22 },
            minimizeWatchdog: { processOwner: "host-broker", startedBy: "broker.windows-sandbox.minimize-watchdog" },
        };
        const successor = { ...initial, generation: "new", recording: { pid: 32 } };
        let current = initial;
        ports.read = () => [current];
        ports.terminateAppium = (_runtime, stillCurrent) => {
            expect(stillCurrent()).toBe(true);
            current = successor;
            expect(stillCurrent()).toBe(false);
            return { ok: true, ended: true, receipt: { attempted: true, ok: true } };
        };
        const recorder = vi.fn(ports.signalRecording), watchdog = vi.fn(ports.cancelWatchdog), publish = vi.fn(ports.publish);
        ports.signalRecording = recorder; ports.cancelWatchdog = watchdog; ports.publish = publish;
        expect(createBrokerOwnerCleanupApplication(ports).auxiliary("owner", target, initial)).toMatchObject({
            committed: false, device: successor, result: { ok: false, changed: false, stateConflict: true },
        });
        expect(recorder).not.toHaveBeenCalled();
        expect(watchdog).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
        expect(current).toBe(successor);
    });

    it("does not cancel the watchdog or publish after the predecessor changes during recorder termination", () => {
        const ports = cleanupPorts(), initial = {
            id: "sim", recording: { pid: 22 },
            minimizeWatchdog: { processOwner: "host-broker", startedBy: "broker.windows-sandbox.minimize-watchdog" },
        };
        const successor = { ...initial, generation: "new" };
        let current = initial;
        ports.read = () => [current];
        ports.signalRecording = (_runtime, stillCurrent) => {
            expect(stillCurrent()).toBe(true);
            current = successor;
            expect(stillCurrent()).toBe(false);
            return { ok: true, ended: true, receipt: { attempted: true, ok: true } };
        };
        const watchdog = vi.fn(ports.cancelWatchdog), publish = vi.fn(ports.publish);
        ports.cancelWatchdog = watchdog; ports.publish = publish;
        expect(createBrokerOwnerCleanupApplication(ports).auxiliary("owner", target, initial)).toMatchObject({
            committed: false, device: successor, result: { ok: false, changed: false, stateConflict: true },
        });
        expect(watchdog).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
    });

    it("commits only a confirmed auxiliary clear while preserving the still-running recorder and physical claim", async () => {
        const ports = cleanupPorts(), device = { id: "phone", status: "attached", appium: { serverPid: 21 }, recording: { pid: 22 }, leaseClaimId: "claim" };
        ports.stateKeys = ["ios-device"]; ports.read = () => [device];
        ports.signalRecording = () => ({ ok: true, ended: false, receipt: { attempted: true, ok: true, reason: "still-running" } });
        const release = vi.fn(ports.releaseLease), publish = vi.fn(ports.publish); ports.releaseLease = release; ports.publish = publish;
        expect(await createBrokerOwnerCleanupApplication(ports).cleanup("owner", {})).toMatchObject({
            kind: "cleaned", changedDevices: 1, failed: 1, results: [{ changed: true, devices: [{ changed: true, appium: { cleared: true }, recording: { cleared: false, signal: { ok: false } } }] }],
        });
        expect(publish).toHaveBeenCalledTimes(1);
        expect(publish).toHaveBeenCalledWith("owner", "ios-device", "phone", device, { ...device, appium: null, updatedAt: "now" });
        expect(release).not.toHaveBeenCalled();
    });

    it("blocks physical release when an owned watchdog cancellation fails", async () => {
        const ports = cleanupPorts(), device = { id: "phone", status: "attached", minimizeWatchdog: { processOwner: "host-broker", startedBy: "broker.windows-sandbox.minimize-watchdog" } };
        ports.stateKeys = ["ios-device"]; ports.read = () => [device];
        ports.cancelWatchdog = () => ({ attempted: true, ok: false, reason: "write-failed" });
        const release = vi.fn(ports.releaseLease), publish = vi.fn(ports.publish); ports.releaseLease = release; ports.publish = publish;
        expect(await createBrokerOwnerCleanupApplication(ports).cleanup("owner", {})).toMatchObject({ kind: "cleaned", failed: 1, changedDevices: 0 });
        expect(release).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
    });

    it("refuses a foreign physical claim before any auxiliary effect", async () => {
        const ports = cleanupPorts(), device = { id: "phone", status: "attached", appium: { serverPid: 21 }, recording: { pid: 22 } };
        ports.stateKeys = ["ios-device"]; ports.read = () => [device];
        ports.withLeaseGuard = (_owner, _state, _record, operation) => operation({ handle: "foreign", attempted: true, admission: { kind: "refused", failure: { kind: "conflict", error: "claim-mismatch" } }, canRestore: false });
        ports.releaseLease = () => ({ kind: "refused", attempted: true, ok: false, failure: { kind: "conflict", error: "claim-mismatch" } });
        const appium = vi.fn(ports.terminateAppium), recording = vi.fn(ports.signalRecording), publish = vi.fn(ports.publish);
        ports.terminateAppium = appium; ports.signalRecording = recording; ports.publish = publish;
        expect(await createBrokerOwnerCleanupApplication(ports).cleanup("owner", {})).toMatchObject({ kind: "cleaned", failed: 1, changedDevices: 0 });
        expect(appium).not.toHaveBeenCalled();
        expect(recording).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
    });
});

function deferredCleanup<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>(settle => { resolve = settle; });
    return { promise, resolve };
}

async function awaitCleanupEffect(entered: Promise<void>, pending: Promise<unknown>, effect: string) {
    await Promise.race([
        entered,
        pending.then(() => { throw new Error(`Owner cleanup settled before ${effect} entered.`); }),
    ]);
}

describe("asynchronous owner auxiliary cleanup", () => {
    const target = { backend: "android-emulator", stateKey: "android", deviceId: "emu" };
    const ended: CleanupTermination = { ok: true, ended: true, receipt: { attempted: true, ok: true } };

    it("refuses a stale complete record before invoking either supplied native effect", async () => {
        const ports = cleanupPorts(), initial = { id: "emu", appium: { serverPid: 21 }, recording: { pid: 22 }, label: "before" };
        const successor = { ...initial, label: "successor" };
        ports.read = () => [successor];
        const appium = vi.fn(async () => ended), recording = vi.fn(async () => ended), publish = vi.fn(ports.publish);
        ports.publish = publish;
        expect(await createBrokerOwnerCleanupApplication(ports).auxiliaryAsync("owner", target, initial, {
            terminateAppium: appium, signalRecording: recording,
        })).toMatchObject({ committed: false, device: successor, result: { ok: false, changed: false, stateConflict: true } });
        expect(appium).not.toHaveBeenCalled(); expect(recording).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
    });

    it("waits for each termination before later effects and publishes only the settled replacement", async () => {
        const ports = cleanupPorts(), initial = {
            id: "emu", status: "running", appium: { serverPid: 21 }, recording: { pid: 22 },
            minimizeWatchdog: { processOwner: "host-broker", startedBy: "broker.windows-sandbox.minimize-watchdog" },
            label: "retain definition",
        };
        const appium = deferredCleanup<CleanupTermination>(), recording = deferredCleanup<CleanupTermination>();
        const appiumEntered = deferredCleanup<void>(), recordingEntered = deferredCleanup<void>(), events: string[] = [];
        ports.read = () => [initial];
        ports.terminateAppium = () => { throw new Error("async-cleanup-must-use-supplied-effects"); };
        ports.signalRecording = () => { throw new Error("async-cleanup-must-use-supplied-effects"); };
        ports.withLeaseGuard = () => { throw new Error("auxiliary-cleanup-does-not-own-a-physical-lease"); };
        const effects: BrokerOwnerAuxiliaryAsyncPorts = {
            terminateAppium: (runtime, stillCurrent) => {
                expect(runtime).toBe(initial.appium); expect(stillCurrent()).toBe(true);
                events.push("appium"); appiumEntered.resolve(undefined); return appium.promise;
            },
            signalRecording: (runtime, stillCurrent) => {
                expect(runtime).toBe(initial.recording); expect(stillCurrent()).toBe(true);
                events.push("recording"); recordingEntered.resolve(undefined); return recording.promise;
            },
        };
        const cancel = vi.fn(() => { events.push("watchdog"); return { ok: true }; });
        const publish = vi.fn(ports.publish); ports.cancelWatchdog = cancel;
        ports.publish = (...args) => { events.push("publish"); return publish(...args); };
        let settled = false;
        const pending = createBrokerOwnerCleanupApplication(ports).auxiliaryAsync("owner", target, initial, effects);
        void pending.then(() => { settled = true; }, () => { settled = true; });
        await appiumEntered.promise;
        expect(events).toEqual(["appium"]); expect(settled).toBe(false);
        expect(publish).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
        appium.resolve(ended);
        await recordingEntered.promise;
        expect(events).toEqual(["appium", "recording"]); expect(settled).toBe(false);
        expect(publish).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
        expect(initial.appium).toEqual({ serverPid: 21 }); expect(initial.recording).toEqual({ pid: 22 });
        recording.resolve(ended);
        expect(await pending).toMatchObject({ committed: true, result: { ok: true, changed: true }, device: {
            id: "emu", label: "retain definition", appium: null, recording: null, minimizeWatchdog: null, updatedAt: "now",
        } });
        expect(events).toEqual(["appium", "recording", "watchdog", "publish"]);
        expect(publish).toHaveBeenCalledExactlyOnceWith("owner", "android", "emu", initial, {
            ...initial, appium: null, recording: null, minimizeWatchdog: null, updatedAt: "now",
        });
    });

    it.each(["appium", "recording"] as const)("refuses later effects and publication after a successor arrives during awaited %s termination", async phase => {
        const ports = cleanupPorts(), initial = {
            id: "emu", appium: { serverPid: 21 }, recording: { pid: 22 },
            minimizeWatchdog: { processOwner: "host-broker", startedBy: "broker.windows-sandbox.minimize-watchdog" },
        };
        const successor = { ...initial, generation: "new", appium: { serverPid: 31 }, recording: { pid: 32 } };
        let current = initial, authorized = () => false;
        ports.read = () => [current];
        const termination = deferredCleanup<CleanupTermination>(), entered = deferredCleanup<void>();
        const waitForTermination = (_runtime: unknown, stillCurrent: () => boolean) => {
            expect(stillCurrent()).toBe(true); authorized = stillCurrent;
            entered.resolve(undefined); return termination.promise;
        };
        const recorder = vi.fn(phase === "recording" ? waitForTermination : () => ended);
        const effects: BrokerOwnerAuxiliaryAsyncPorts = {
            terminateAppium: phase === "appium" ? waitForTermination : () => ended,
            signalRecording: recorder,
        };
        const watchdog = vi.fn(ports.cancelWatchdog), publish = vi.fn(ports.publish);
        ports.cancelWatchdog = watchdog; ports.publish = publish;
        const pending = createBrokerOwnerCleanupApplication(ports).auxiliaryAsync("owner", target, initial, effects);
        await entered.promise;
        expect(publish).not.toHaveBeenCalled(); expect(watchdog).not.toHaveBeenCalled();
        current = successor;
        termination.resolve(ended);
        expect(await pending).toMatchObject({ committed: false, device: successor, result: { ok: false, changed: false, stateConflict: true } });
        expect(authorized()).toBe(false);
        expect(recorder).toHaveBeenCalledTimes(phase === "recording" ? 1 : 0);
        expect(watchdog).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
        expect(current).toBe(successor);
    });

    it.each([false, true])("preserves recoverable Android recording metadata while committing Appium cleanup (recording active=%s)", async active => {
        const ports = cleanupPorts(), recording = {
            pid: 22, provider: "adb-screenrecord", authority: "host-broker", processOwner: "host-broker",
            startedBy: "broker.device.recording.start", remotePath: "/sdcard/keep.mp4", localPath: "/artifacts/keep.mp4",
            runtimeId: "recording-generation", startedAt: "started", active,
            ...(active ? {} : { stoppedAt: "before", artifactCopyPending: true, artifactCopied: false }),
        };
        const initial = { id: "emu", appium: { serverPid: 21 }, recording, incarnationId: "device-generation" };
        const capturedRecording = structuredClone(recording);
        ports.read = () => [initial];
        const signal = vi.fn(async () => ended), publish = vi.fn(ports.publish); ports.publish = publish;
        const outcome = await createBrokerOwnerCleanupApplication(ports).auxiliaryAsync("owner", target, initial, {
            terminateAppium: async () => ended, signalRecording: signal,
        });
        expect(outcome).toMatchObject({ committed: true, device: { ...initial, appium: null }, result: {
            ok: false, changed: true, appium: { cleared: true },
            recording: { cleared: false, signal: { ok: false, reason: "recording-artifact-copy-pending" } },
        } });
        expect(signal).toHaveBeenCalledTimes(active ? 1 : 0);
        expect(publish).toHaveBeenCalledExactlyOnceWith("owner", "android", "emu", initial, { ...initial, appium: null, updatedAt: "now" });
        expect((outcome.device as typeof initial).recording).toEqual(capturedRecording);
        expect(initial.recording).toEqual(capturedRecording);
    });

    it("commits confirmed Appium cleanup while retaining the recorder whose awaited signal has no exit proof", async () => {
        const ports = cleanupPorts(), recording = { pid: 22, runtimeId: "recorder-generation" };
        const initial = { id: "emu", appium: { serverPid: 21 }, recording };
        const receipt = { attempted: true, ok: true, nativeDetail: "signal accepted" };
        ports.read = () => [initial];
        const publish = vi.fn(ports.publish); ports.publish = publish;
        const outcome = await createBrokerOwnerCleanupApplication(ports).auxiliaryAsync("owner", target, initial, {
            terminateAppium: async () => ended,
            signalRecording: async () => ({ ok: true, ended: false, receipt }),
        });
        expect(outcome).toMatchObject({ committed: true, device: { appium: null, recording }, result: {
            ok: false, changed: true, appium: { cleared: true },
            recording: { cleared: false, signal: { attempted: true, ok: false, nativeDetail: "signal accepted" } },
        } });
        expect(outcome.result.recording.signal).not.toHaveProperty("ended");
        expect(outcome.result.recording.signal).not.toHaveProperty("receipt");
        expect(receipt.ok).toBe(true);
        expect(publish).toHaveBeenCalledExactlyOnceWith("owner", "android", "emu", initial, { ...initial, appium: null, updatedAt: "now" });
    });

    it("reports the final complete-record CAS conflict without crediting or replacing a successor", async () => {
        const ports = cleanupPorts(), initial = { id: "emu", appium: { serverPid: 21 }, recording: { pid: 22 }, label: "original" };
        const successor = { ...initial, generation: "new", label: "successor", appium: { serverPid: 31 } };
        let current = initial;
        ports.read = () => [current];
        const publish = vi.fn((_owner: string, _state: string, _id: string, expected: unknown, replacement: unknown) => {
            expect(expected).toBe(initial);
            expect(replacement).toEqual({ ...initial, appium: null, recording: null, updatedAt: "now" });
            current = successor;
            return { found: true, matched: false, device: successor };
        });
        ports.publish = publish;
        const outcome = await createBrokerOwnerCleanupApplication(ports).auxiliaryAsync("owner", target, initial, {
            terminateAppium: async () => ended, signalRecording: async () => ended,
        });
        expect(outcome).toMatchObject({ committed: false, device: successor, result: {
            ok: false, changed: false, stateConflict: true, appium: { cleared: true }, recording: { cleared: true },
        } });
        expect(publish).toHaveBeenCalledOnce();
        expect(current).toBe(successor);
        expect(initial.appium).toEqual({ serverPid: 21 }); expect(initial.recording).toEqual({ pid: 22 });
    });
});

describe("asynchronous owner cleanup selection", () => {
    const target = { backend: "android-emulator", stateKey: "android", deviceId: "emu" };
    const ended: CleanupTermination = { ok: true, ended: true, receipt: { attempted: true, ok: true } };
    const selections = [
        { name: "a stopped Android device", status: "stopped", params: {} },
        { name: "stopDevices false", status: "running", params: { stopDevices: false } },
    ];

    it.each(selections)("awaits selected native effects under the device operation for $name", async ({ status, params }) => {
        const ports = cleanupPorts(), initial = { id: "emu", status, appium: { serverPid: 21 }, recording: { pid: 22 } };
        const appium = deferredCleanup<CleanupTermination>(), recording = deferredCleanup<CleanupTermination>();
        const appiumEntered = deferredCleanup<void>(), recordingEntered = deferredCleanup<void>(), events: string[] = [];
        let lockHeld = false;
        ports.stateKeys = ["android"]; ports.read = () => [initial];
        ports.withDeviceOperation = async (_owner, _state, _id, operation) => {
            expect(lockHeld).toBe(false); lockHeld = true; events.push("lock");
            try { return await operation(); } finally { lockHeld = false; events.push("unlock"); }
        };
        ports.stopLocked = async () => { throw new Error("auxiliary-only-cleanup-must-not-stop-device"); };
        ports.terminateAppium = () => { throw new Error("selected-Android-cleanup-must-not-use-sync-Appium"); };
        ports.signalRecording = () => { throw new Error("selected-Android-cleanup-must-not-use-sync-recorder"); };
        const effects: BrokerOwnerAuxiliaryAsyncPorts = {
            terminateAppium: (_runtime, stillCurrent) => {
                expect(lockHeld).toBe(true); expect(stillCurrent()).toBe(true);
                events.push("appium"); appiumEntered.resolve(undefined); return appium.promise;
            },
            signalRecording: (_runtime, stillCurrent) => {
                expect(lockHeld).toBe(true); expect(stillCurrent()).toBe(true);
                events.push("recording"); recordingEntered.resolve(undefined); return recording.promise;
            },
        };
        const select = vi.fn((selected: typeof target) => { expect(selected).toEqual(target); return effects; });
        ports.auxiliaryAsyncEffects = select;
        const publish = vi.fn(ports.publish);
        ports.publish = (...args) => { expect(lockHeld).toBe(true); events.push("publish"); return publish(...args); };
        const pending = createBrokerOwnerCleanupApplication(ports).cleanup("owner", params);
        try {
            await awaitCleanupEffect(appiumEntered.promise, pending, "Appium termination");
            expect(events).toEqual(["lock", "appium"]); expect(lockHeld).toBe(true); expect(publish).not.toHaveBeenCalled();
            appium.resolve(ended);
            await awaitCleanupEffect(recordingEntered.promise, pending, "recorder termination");
            expect(events).toEqual(["lock", "appium", "recording"]); expect(lockHeld).toBe(true); expect(publish).not.toHaveBeenCalled();
            recording.resolve(ended);
            expect(await pending).toMatchObject({ kind: "cleaned", changedDevices: 1, failed: 0, results: [{
                stateKey: "android", changed: true, devices: [{ deviceId: "emu", changed: true, appium: { cleared: true }, recording: { cleared: true } }],
            }] });
            expect(events).toEqual(["lock", "appium", "recording", "publish", "unlock"]);
            expect(lockHeld).toBe(false); expect(select).toHaveBeenCalledExactlyOnceWith(target);
            expect(publish).toHaveBeenCalledExactlyOnceWith("owner", "android", "emu", initial, { ...initial, appium: null, recording: null, updatedAt: "now" });
        } finally {
            appium.resolve(ended); recording.resolve(ended);
            await pending.catch(() => undefined);
        }
    });

    it.each(selections)("preserves the successor and withholds publication after selected cleanup waits for $name", async ({ status, params }) => {
        const ports = cleanupPorts(), initial = {
            id: "emu", status, appium: { serverPid: 21 }, recording: { pid: 22 },
            minimizeWatchdog: { processOwner: "host-broker", startedBy: "broker.windows-sandbox.minimize-watchdog" },
        };
        const successor = { ...initial, generation: "new", recording: { pid: 32 } };
        const recording = deferredCleanup<CleanupTermination>(), entered = deferredCleanup<void>();
        let current = initial, lockHeld = false;
        ports.stateKeys = ["android"]; ports.read = () => [current];
        ports.withDeviceOperation = async (_owner, _state, _id, operation) => {
            lockHeld = true;
            try { return await operation(); } finally { lockHeld = false; }
        };
        ports.stopLocked = async () => { throw new Error("auxiliary-only-cleanup-must-not-stop-device"); };
        ports.terminateAppium = () => { throw new Error("selected-Android-cleanup-must-not-use-sync-Appium"); };
        ports.signalRecording = () => { throw new Error("selected-Android-cleanup-must-not-use-sync-recorder"); };
        ports.auxiliaryAsyncEffects = () => ({
            terminateAppium: async () => ended,
            signalRecording: () => { expect(lockHeld).toBe(true); entered.resolve(undefined); return recording.promise; },
        });
        const publish = vi.fn(ports.publish), watchdog = vi.fn(ports.cancelWatchdog);
        ports.publish = publish; ports.cancelWatchdog = watchdog;
        const pending = createBrokerOwnerCleanupApplication(ports).cleanup("owner", params);
        try {
            await awaitCleanupEffect(entered.promise, pending, "recorder termination");
            expect(lockHeld).toBe(true); expect(publish).not.toHaveBeenCalled(); expect(watchdog).not.toHaveBeenCalled();
            current = successor;
            recording.resolve(ended);
            expect(await pending).toMatchObject({ kind: "cleaned", changedDevices: 0, failed: 1, results: [{
                changed: false, devices: [{ deviceId: "emu", changed: false, stateConflict: true, appium: { cleared: true }, recording: { cleared: true } }],
            }] });
            expect(lockHeld).toBe(false); expect(current).toBe(successor);
            expect(publish).not.toHaveBeenCalled(); expect(watchdog).not.toHaveBeenCalled();
        } finally {
            recording.resolve(ended);
            await pending.catch(() => undefined);
        }
    });

    it.each([false, true])("keeps physical native cleanup synchronous without consulting the async selector (detachPhysical=%s)", async detachPhysical => {
        const ports = cleanupPorts(), initial = { id: "phone", status: "attached", serial: "usb", appium: { serverPid: 21 } };
        let guardHeld = false, guardCalls = 0;
        ports.stateKeys = ["android-device"]; ports.read = () => [initial];
        ports.auxiliaryAsyncEffects = () => { throw new Error("physical-cleanup-must-not-select-async-effects"); };
        ports.withLeaseGuard = (_owner, _state, _record, operation) => {
            guardCalls += 1; guardHeld = true;
            try {
                const result = operation({ handle: "claim", attempted: true, admission: { kind: "exact" }, canRestore: true });
                expect(result).not.toBeInstanceOf(Promise);
                return result;
            } finally { guardHeld = false; }
        };
        const terminate = vi.fn(() => { expect(guardHeld).toBe(detachPhysical); return ended; });
        const release = vi.fn(ports.releaseLease), publish = vi.fn(ports.publish);
        ports.terminateAppium = terminate; ports.releaseLease = release;
        ports.publish = (...args) => { expect(guardHeld).toBe(detachPhysical); return publish(...args); };
        expect(await createBrokerOwnerCleanupApplication(ports).cleanup("owner", { detachPhysical })).toMatchObject({ kind: "cleaned", changedDevices: 1, failed: 0 });
        expect(guardCalls).toBe(detachPhysical ? 1 : 0); expect(guardHeld).toBe(false);
        expect(terminate).toHaveBeenCalledOnce(); expect(publish).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledTimes(detachPhysical ? 1 : 0);
    });
});

describe("canonical owner stop ownership", () => {
    it("delegates a running virtual device once under its held device operation without repeating auxiliary cleanup or publication", async () => {
        const ports = cleanupPorts(), device = { id: "sim", status: "running", appium: { serverPid: 21 } }, receipt = { observed: true, nativeDetail: "canonical-stop" };
        ports.stateKeys = ["ios"]; ports.read = () => [device];
        let deviceLockHeld = false;
        const operationCalls = vi.fn();
        ports.withDeviceOperation = async (_owner, _state, _id, operation) => {
            operationCalls();
            expect(deviceLockHeld).toBe(false); deviceLockHeld = true;
            try { return await operation(); } finally { deviceLockHeld = false; }
        };
        const stop = vi.fn(async (_owner: string, _target: unknown, current: unknown) => {
            expect(deviceLockHeld).toBe(true); expect(current).toBe(device);
            return { attempted: true as const, ok: true, changed: true, observation: { ok: true, operationKind: "runtime-stop" as const, receipt }, auxiliary: { ok: true, changed: true, appium: { cleared: true }, recording: { cleared: false }, minimizeWatchdog: { cleared: false } } };
        });
        ports.stopLocked = stop;
        ports.terminateAppium = () => { throw new Error("canonical-stop-owns-auxiliary"); };
        ports.publish = () => { throw new Error("canonical-stop-owns-publication"); };
        const outcome = await createBrokerOwnerCleanupApplication(ports).cleanup("owner", {});
        expect(outcome).toMatchObject({ kind: "cleaned", changedDevices: 1, failed: 0, results: [{ devices: [{ appium: { cleared: true }, stop: { attempted: true, ok: true, observation: { receipt } } }] }] });
        expect(stop).toHaveBeenCalledOnce();
        expect(operationCalls).toHaveBeenCalledOnce();
        if (outcome.kind === "cleaned") {
            const report = outcome.results[0].devices![0];
            expect(report.stop).not.toHaveProperty("changed");
            expect(report.stop).not.toHaveProperty("auxiliary");
            if (report.stop?.attempted) expect(report.stop.observation.receipt).toBe(receipt);
        }
        expect(device.status).toBe("running");
    });

    it.each([false, true])("uses the canonical committed change fact even when stop fails (changed=%s)", async changed => {
        const ports = cleanupPorts(), device = { id: "sim", status: "running" };
        ports.stateKeys = ["ios"]; ports.read = () => [device];
        ports.stopLocked = async () => ({ attempted: true, ok: false, changed, observation: { ok: false, operationKind: "runtime-stop", receipt: { observed: true } } });
        ports.publish = () => { throw new Error("failed-canonical-stop-must-not-republish"); };
        expect(await createBrokerOwnerCleanupApplication(ports).cleanup("owner", {})).toMatchObject({ kind: "cleaned", changedDevices: changed ? 1 : 0, failed: 1, results: [{ changed, devices: [{ changed, stop: { ok: false } }] }] });
    });

    it("does not credit a successor as a committed cleanup or repeat its publication", async () => {
        const ports = cleanupPorts(), device = { id: "sim", status: "running" }, successor = { ...device, generation: "new" };
        let current = device;
        ports.stateKeys = ["ios"]; ports.read = () => [current];
        ports.stopLocked = async () => { current = successor; return { attempted: true, ok: false, changed: false, stateConflict: true, observation: { ok: false, operationKind: "runtime-stop", receipt: { observed: true } } }; };
        ports.publish = () => { throw new Error("successor-must-not-be-republished"); };
        const outcome = await createBrokerOwnerCleanupApplication(ports).cleanup("owner", {});
        expect(outcome).toMatchObject({ kind: "cleaned", changedDevices: 0, failed: 1, results: [{ devices: [{ changed: false, stateConflict: true }] }] });
        expect(current).toBe(successor);
    });

    it("counts an independent auxiliary failure in addition to the same canonical state conflict", async () => {
        const ports = cleanupPorts(), device = { id: "sim", status: "running", appium: { serverPid: 21 } };
        ports.stateKeys = ["ios"]; ports.read = () => [device];
        ports.stopLocked = async () => ({
            attempted: true, ok: false, changed: false, stateConflict: true,
            observation: { ok: false, operationKind: "runtime-stop", receipt: { observed: true } },
            auxiliary: {
                ok: false, changed: false,
                appium: { cleared: false, signal: { attempted: true, ok: false, reason: "still-running" } },
                recording: { cleared: false }, minimizeWatchdog: { cleared: false },
            },
        });
        ports.publish = () => { throw new Error("failed-canonical-stop-must-not-republish"); };
        expect(await createBrokerOwnerCleanupApplication(ports).cleanup("owner", {})).toMatchObject({
            kind: "cleaned", changedDevices: 0, failed: 2,
            results: [{ devices: [{ stateConflict: true, appium: { cleared: false, signal: { ok: false } }, stop: { ok: false } }] }],
        });
    });
});
