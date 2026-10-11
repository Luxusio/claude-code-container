import { describe, expect, it } from "vitest";
import { createPhysicalAttachmentApplication } from "../../../packages/device-lab/providers/application/physical-attachment.mjs";
import { createPhysicalLeases } from "../../../packages/device-lab/providers/application/physical-leases.mjs";
import { createPhysicalStopApplication } from "../../../packages/device-lab/providers/application/physical-stop.mjs";
import type { AttachmentDevice, CommonAttachmentPorts, PhysicalAttachmentPorts, AttachRequest } from "../../../packages/device-lab/providers/ports/physical-attachment.mjs";
import type { PhysicalLease, PhysicalLeasePorts } from "../../../packages/device-lab/providers/ports/physical-leases.mjs";
import type { PhysicalStopPorts } from "../../../packages/device-lab/providers/ports/physical-stop.mjs";

const id = "owned-physical";
const hardware = "selected-hardware";
const instant = "2026-10-11T00:00:00.000Z";
type Backend = PhysicalAttachmentPorts["backend"];
type Options = { publication?: "refused" | "throws" | "successor"; removeFailure?: boolean; refuseRestoration?: boolean };

function attachmentFixture(backend: Backend, options: Options = {}) {
    let records: AttachmentDevice[] = [];
    let lease: PhysicalLease | null = null;
    let aggregate: PhysicalLease[] = [];
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
        stopAdbRecording: () => ({ status: 0, stdout: "", stderr: "" }), waitRecordingExit: async () => true,
    } : {
        ...stopCommon, backend, waitRecordingExit: async () => true, stopOwnedAppium: async () => ({ exited: true }),
    };
    const common: CommonAttachmentPorts = {
        read: () => records, find, transition,
        claim(device) {
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
        claimLease: (target, deviceId, leaseOptions) => leases.claim(backend, target, deviceId, leaseOptions),
        releaseLease: (target, deviceId, leaseOptions) => leases.release(backend, target, deviceId, leaseOptions),
        startHeartbeat: (target, deviceId, leaseOptions) => leases.startHeartbeat(backend, target, deviceId, leaseOptions),
        releaseWithMutation: (target, deviceId, leaseOptions, mutation) => leases.releaseWithMutation(backend, String(target), deviceId, leaseOptions, mutation),
        stop: createPhysicalStopApplication(stopPorts),
    };
    const ports: PhysicalAttachmentPorts = backend === "android-device" ? {
        ...common, backend, discover: () => ({ adb: "/allocated/adb" }),
        inventory: () => ({ devices: [{ serial: hardware, state: "device", connection: "usb", details: { model: "Selected Android" } }] }),
        wifiSerial: (value, port) => value ? `${value}:${port}` : null,
        wifiTransport: (serial, host, port) => ({ type: "wifi", serial, host, port }),
        connect: () => ({ status: 0, stdout: "connected", stderr: "" }),
    } : {
        ...common, backend, discover: () => ({ xcrun: "/allocated/xcrun" }),
        inventory: () => ({ devices: [{ udid: hardware, name: "Selected iPhone", connection: "usb" }] }),
    };
    const request: AttachRequest = { backend, deviceId: id, name: "Selected physical device", ...(backend === "android-device" ? { serial: hardware } : { udid: hardware }) };
    return {
        application: createPhysicalAttachmentApplication(ports), request, publicationFault,
        ownerRecords: () => records, authoritativeLease: () => lease, aggregateLeases: () => aggregate,
    };
}

describe("direct physical attachment compensation", () => {
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
