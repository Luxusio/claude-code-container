import { describe, expect, it } from "vitest";
import { createPhysicalAttachmentApplication } from "../../../packages/device-lab/providers/application/physical-attachment.mjs";
import { createAndroidPhysicalAttachment } from "../../../packages/device-lab/providers/adapters/physical-attachment.mjs";
import type { AndroidAttachmentNative } from "../../../packages/device-lab/providers/adapters/physical-attachment.mjs";
import { createPhysicalLeases } from "../../../packages/device-lab/providers/application/physical-leases.mjs";
import { createPhysicalStopApplication } from "../../../packages/device-lab/providers/application/physical-stop.mjs";
import type { AttachmentDevice, CommonAttachmentPorts, PhysicalAttachmentPorts, AttachRequest, ConnectResult } from "../../../packages/device-lab/providers/ports/physical-attachment.mjs";
import type { PhysicalLease, PhysicalLeasePorts } from "../../../packages/device-lab/providers/ports/physical-leases.mjs";
import type { PhysicalStopPorts } from "../../../packages/device-lab/providers/ports/physical-stop.mjs";

const id = "owned-physical";
const hardware = "selected-hardware";
const wifiHardware = `${hardware}:5555`;
const instant = "2026-10-11T00:00:00.000Z";
type Backend = PhysicalAttachmentPorts["backend"];
type Options = {
    publication?: "refused" | "throws" | "successor"; removeFailure?: boolean; refuseRestoration?: boolean;
    wifi?: boolean; connect?: ConnectResult; inventory?: "missing" | { state: string; attachable: boolean };
};

function attachmentFixture(backend: Backend, options: Options = {}) {
    let records: AttachmentDevice[] = [];
    let lease: PhysicalLease | null = null;
    let aggregate: PhysicalLease[] = [];
    const calls: unknown[][] = [];
    const publicationFault = new Error("owned record publication failed");
    const removalFault = new Error("authoritative lease removal failed");
    const leasePorts: PhysicalLeasePorts<string> = {
        owner: () => "owner", now: () => Date.parse(instant), timestamp: () => instant,
        iso: milliseconds => new Date(milliseconds).toISOString(), claimId: () => "allocated-claim",
        read: () => aggregate, ensure: () => undefined,
        withTransaction: (_backend, _hardware, operation) => operation({
            lease, leases: aggregate,
            writeAggregate(next) { aggregate = next; return undefined; },
            writeLease(next) { lease = next; return undefined; },
            removeLease() {
                if (options.removeFailure) throw removalFault;
                lease = null;
                return undefined;
            },
        }),
        timeout: () => new Error("lease transaction timed out"),
        schedule: () => ({ handle: "owned-timer" }), unref: () => undefined, clear: () => undefined,
    };
    const leases = createPhysicalLeases(leasePorts);
    const find = (deviceId: string) => records.find(record => record.id === deviceId) ?? null;
    const transition: CommonAttachmentPorts["transition"] = (deviceId, expected, replacement) => {
        const current = find(deviceId);
        const matched = current !== null && current === expected;
        if (matched) records = records.flatMap(record => record.id !== deviceId ? [record] : replacement ? [replacement] : []);
        return { matched, found: current !== null, device: matched ? replacement : current, currentDevice: current };
    };
    const stopCommon = {
        find, transition, now: () => instant, runtimeId: () => "detach-operation",
        signalRecording: () => ({ attempted: false, signaled: false, exited: true }),
    };
    const stopPorts: PhysicalStopPorts = backend === "android-device" ? {
        ...stopCommon, backend, discoverAdb: () => "/allocated/adb",
        stopAdbRecording: () => ({ ok: true, detail: "" }), waitRecordingExit: async () => true,
    } : {
        ...stopCommon, backend, waitRecordingExit: async () => true, stopOwnedAppium: async () => ({ exited: true }),
    };
    const common: CommonAttachmentPorts = {
        read: () => records, find, transition,
        claim(device) {
            calls.push(["publish", device]);
            if (device.status === "detaching" && options.refuseRestoration) return { ok: false, error: "owner-generation-changed" };
            if (options.publication === "throws") throw publicationFault;
            if (options.publication === "successor" && lease) {
                lease = { ...lease, claimNonce: "successor-nonce" };
                aggregate = [lease];
            }
            if (options.publication) return { ok: false, field: "id", value: device.id };
            if (find(device.id)) return { ok: false, error: "identity-exists" };
            records = [...records, device];
            return { ok: true };
        },
        owner: () => "owner", deriveId: () => id, appiumPort: () => 4725, now: () => instant, nonce: () => "attach-nonce",
        claimLease: (target, deviceId, leaseOptions) => {
            calls.push(["claim-lease", target, deviceId, leaseOptions]);
            return leases.claim(backend, target, deviceId, leaseOptions);
        },
        releaseLease: (target, deviceId, leaseOptions) => {
            calls.push(["release-lease", target, deviceId, leaseOptions]);
            return leases.release(backend, target, deviceId, leaseOptions);
        },
        startHeartbeat: (target, deviceId, leaseOptions) => {
            calls.push(["heartbeat", target, deviceId, leaseOptions]);
            return leases.startHeartbeat(backend, target, deviceId, leaseOptions);
        },
        releaseWithMutation: (target, deviceId, leaseOptions, mutation) => leases.releaseWithMutation(backend, String(target), deviceId, leaseOptions, mutation),
        stop: createPhysicalStopApplication(stopPorts),
    };
    const ports: PhysicalAttachmentPorts = backend === "android-device" ? {
        ...common, backend, discover: () => ({ adb: "/allocated/adb" }),
        inventory: () => {
            calls.push(["inventory"]);
            return { devices: options.inventory === "missing" ? [] : [{ serial: options.wifi ? wifiHardware : hardware,
                state: options.inventory?.state ?? "device", attachable: options.inventory?.attachable ?? true,
                connection: options.wifi ? "wifi" : "usb", details: { model: "Selected Android" } }] };
        },
        wifiSerial: (value, port) => value ? value.includes(":") ? value : `${value}:${port}` : null,
        wifiTransport: (serial, host, port) => ({ type: "wifi", serial, host, port }),
        connect: (adb, target) => {
            calls.push(["connect", adb, target]);
            return options.connect ?? { ok: true, receipt: { status: 0, stdout: "connected", stderr: "" } };
        },
    } : {
        ...common, backend, discover: () => ({ xcrun: "/allocated/xcrun" }),
        inventory: () => ({ devices: [{ udid: hardware, name: "Selected iPhone", connection: "usb" }] }),
    };
    const request: AttachRequest = { backend, deviceId: id, name: "Selected physical device", ...(backend === "android-device" ? { serial: options.wifi ? wifiHardware : hardware, ...(options.wifi ? { connection: "wifi" } : {}) } : { udid: hardware }) };
    return {
        application: createPhysicalAttachmentApplication(ports), ports, request, publicationFault, calls,
        ownerRecords: () => records, authoritativeLease: () => lease, aggregateLeases: () => aggregate,
    };
}

function nativeAndroidFixture(command: ReturnType<AndroidAttachmentNative["run"]>, options: Options = {}) {
    const fixture = attachmentFixture("android-device", { ...options, wifi: true });
    const ports = fixture.ports;
    if (ports.backend !== "android-device") throw new Error("expected Android fixture");
    const native: AndroidAttachmentNative = {
        readDevices: ports.read, findDevice: ports.find, claimDevice: ports.claim, transitionDevice: ports.transition,
        owner: ports.owner, deviceId: ports.deriveId, appiumPort: ports.appiumPort, now: ports.now, nonce: ports.nonce, stop: ports.stop,
        claimLease: (_backend, target, deviceId, leaseOptions) => ports.claimLease(target, deviceId, leaseOptions),
        releaseLease: (_backend, target, deviceId, leaseOptions) => ports.releaseLease(target, deviceId, leaseOptions),
        startHeartbeat: (_backend, target, deviceId, leaseOptions) => ports.startHeartbeat(target, deviceId, leaseOptions),
        releaseWithMutation: (_backend, target, deviceId, leaseOptions, mutation) => ports.releaseWithMutation(target, deviceId, leaseOptions, mutation),
        discover: ports.discover, wifiSerial: ports.wifiSerial, wifiTransport: ports.wifiTransport,
        inventory(discovery) {
            return { devices: ports.inventory(discovery).devices.map(device => ({ serial: device.serial, state: device.state,
                connection: device.connection, details: device.details })) };
        },
        run(executable, args) { fixture.calls.push(["native-connect", executable, args]); return command; },
    };
    return { ...fixture, application: createAndroidPhysicalAttachment(native) };
}

function expectWifiRollback(fixture: ReturnType<typeof attachmentFixture>) {
    expect(fixture.calls.find(call => call[0] === "claim-lease")).toEqual(["claim-lease", wifiHardware, id, { claimNonce: "attach-nonce" }]);
    expect(fixture.calls.find(call => call[0] === "release-lease")).toEqual(["release-lease", wifiHardware, id, { claimId: "allocated-claim", claimNonce: "attach-nonce" }]);
    expect(fixture.calls.filter(call => call[0] === "release-lease")).toHaveLength(1);
    expect(fixture.calls.some(call => call[0] === "publish" || call[0] === "heartbeat")).toBe(false);
    expect(fixture.ownerRecords()).toEqual([]);
    expect(fixture.authoritativeLease()).toBeNull();
    expect(fixture.aggregateLeases()).toEqual([]);
}

describe("direct physical attachment compensation", () => {
    it("rolls back the exact Wi-Fi lease and forwards an opaque failed-connect receipt unchanged", () => {
        const receipt = { status: 0, stdout: "opaque native evidence", stderr: "" };
        const fixture = attachmentFixture("android-device", { wifi: true, connect: { ok: false, receipt } });
        const outcome = fixture.application.attach(fixture.request);
        expect(outcome).toEqual({ kind: "command-failure", command: receipt });
        if (outcome.kind !== "command-failure") throw new Error("expected connect refusal");
        expect(outcome.command).toBe(receipt);
        expect(fixture.calls.map(call => call[0])).toEqual(["claim-lease", "connect", "release-lease"]);
        expectWifiRollback(fixture);
    });

    it.each(["missing", "offline", "device"] as const)("rolls back Wi-Fi inventory refusal while retaining native state detail: %s", state => {
        const fixture = attachmentFixture("android-device", { wifi: true,
            inventory: state === "missing" ? "missing" : { state, attachable: false } });
        expect(fixture.application.attach(fixture.request)).toEqual({ kind: "error", message: state === "missing"
            ? `Android device is not visible to adb: ${wifiHardware}`
            : `Android device ${wifiHardware} is not attachable; adb state is ${state}` });
        expect(fixture.calls.map(call => call[0])).toEqual(["claim-lease", "connect", "inventory", "release-lease"]);
        expectWifiRollback(fixture);
    });

    it("uses semantic connect and inventory success before publishing and starting its exact heartbeat", () => {
        const fixture = attachmentFixture("android-device", { wifi: true, connect: { ok: true, receipt: { status: 19 } },
            inventory: { state: "opaque native detail", attachable: true } });
        const outcome = fixture.application.attach(fixture.request);
        expect(outcome).toEqual({ kind: "attached", device: fixture.ownerRecords()[0] });
        expect(fixture.ownerRecords()[0]).toMatchObject({ serial: wifiHardware, connection: "wifi", hostDetails: { model: "Selected Android" } });
        expect(fixture.calls.map(call => call[0])).toEqual(["claim-lease", "connect", "inventory", "publish", "heartbeat"]);
        expect(fixture.calls.at(-1)).toEqual(["heartbeat", wifiHardware, id, { claimId: "allocated-claim", claimNonce: "attach-nonce" }]);
    });

    it.each([17, null])("native Android connect status %s retains its exact failure receipt and lease rollback", status => {
        const receipt = { status, stdout: "native output", stderr: "native refusal" };
        const fixture = nativeAndroidFixture(receipt);
        const outcome = fixture.application.attach(fixture.request);
        expect(outcome).toEqual({ kind: "command-failure", command: receipt });
        if (outcome.kind !== "command-failure") throw new Error("expected native connect refusal");
        expect(outcome.command).toBe(receipt);
        expect(fixture.calls.find(call => call[0] === "native-connect")).toEqual(["native-connect", "/allocated/adb", ["connect", wifiHardware]]);
        expectWifiRollback(fixture);
    });

    it("native Android inventory rejects an unauthorized device with its original state detail", () => {
        const fixture = nativeAndroidFixture({ status: 0, stdout: "connected", stderr: "" }, { inventory: { state: "unauthorized", attachable: true } });
        expect(fixture.application.attach(fixture.request)).toEqual({ kind: "error", message: `Android device ${wifiHardware} is not attachable; adb state is unauthorized` });
        expectWifiRollback(fixture);
    });

    it("native Android status zero and device inventory preserve the successful attachment projection", () => {
        const fixture = nativeAndroidFixture({ status: 0, stdout: "connected", stderr: "native warning", error: new Error("existing receipt error") },
            { inventory: { state: "device", attachable: false } });
        expect(fixture.application.attach(fixture.request)).toEqual({ kind: "attached", device: fixture.ownerRecords()[0] });
        expect(fixture.ownerRecords()[0]).toMatchObject({ id, serial: wifiHardware, connection: "wifi", hostDetails: { model: "Selected Android" } });
        expect(fixture.calls.map(call => call[0])).toEqual(["claim-lease", "native-connect", "inventory", "publish", "heartbeat"]);
        expect(fixture.calls.some(call => call[0] === "release-lease")).toBe(false);
    });

    for (const backend of ["android-device", "ios-device"] as const) {
        it(`${backend} relinquishes its exact lease when owner publication refuses`, () => {
            const fixture = attachmentFixture(backend, { publication: "refused" });
            expect(fixture.application.attach(fixture.request)).toEqual({ kind: "error", message: `Device identity already exists for this owner (id: ${id})` });
            expect(fixture.ownerRecords()).toEqual([]);
            expect(fixture.authoritativeLease()).toBeNull();
            expect(fixture.aggregateLeases()).toEqual([]);
        });
        it(`${backend} compensates its lease and propagates a raw owner publication failure`, () => {
            const fixture = attachmentFixture(backend, { publication: "throws" });
            let caught: unknown;
            try { fixture.application.attach(fixture.request); } catch (error) { caught = error; }
            expect(caught).toBe(fixture.publicationFault);
            expect(fixture.ownerRecords()).toEqual([]);
            expect(fixture.authoritativeLease()).toBeNull();
            expect(fixture.aggregateLeases()).toEqual([]);
        });
    }

    it("does not release a replacement lease generation when publication refuses", () => {
        const fixture = attachmentFixture("android-device", { publication: "successor" });
        expect(fixture.application.attach(fixture.request).kind).toBe("error");
        expect(fixture.ownerRecords()).toEqual([]);
        expect(fixture.authoritativeLease()).toMatchObject({ hardwareId: hardware, deviceId: id, claimId: "allocated-claim", claimNonce: "successor-nonce" });
        expect(fixture.aggregateLeases()).toEqual([fixture.authoritativeLease()]);
    });

    it("restores the attachment and aggregate when lease removal fails, then permits a retry", async () => {
        const options: Options = { removeFailure: true };
        const fixture = attachmentFixture("ios-device", options);
        expect(fixture.application.attach(fixture.request).kind).toBe("attached");
        const attached = fixture.ownerRecords()[0];
        const lease = fixture.authoritativeLease();

        expect(await fixture.application.detach(id)).toEqual({ kind: "error", message: "iOS physical device detach could not commit lease release; owner state and physical lease were preserved for retry: authoritative lease removal failed" });
        expect(fixture.ownerRecords()).toEqual([attached]);
        expect(fixture.authoritativeLease()).toEqual(lease);
        expect(fixture.aggregateLeases()).toEqual([lease]);

        options.removeFailure = false;
        expect(await fixture.application.detach(id)).toEqual({ kind: "detached", deviceId: id });
        expect(fixture.ownerRecords()).toEqual([]);
        expect(fixture.authoritativeLease()).toBeNull();
        expect(fixture.aggregateLeases()).toEqual([]);
    });

    it("reports refused owner restoration while retaining the authoritative lease and compensated aggregate", async () => {
        const fixture = attachmentFixture("android-device", { removeFailure: true, refuseRestoration: true });
        expect(fixture.application.attach(fixture.request).kind).toBe("attached");
        const lease = fixture.authoritativeLease();

        expect(await fixture.application.detach(id)).toEqual({ kind: "error", message: "Android physical device detach could not commit lease release; owner state and physical lease were preserved for retry: physical-lease-release-mutation-rollback-failed" });
        expect(fixture.ownerRecords()).toEqual([]);
        expect(fixture.authoritativeLease()).toEqual(lease);
        expect(fixture.aggregateLeases()).toEqual([lease]);
    });
});
