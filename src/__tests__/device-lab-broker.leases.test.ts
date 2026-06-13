import { mkdtempSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeviceBrokerServer, deviceBrokerOwnerToken } from "../device-lab-broker.js";
import { close, listen } from "./helpers/host-broker-test-fixture.js";

describe("device-lab host broker physical leases", () => {
    let originalHome: string | undefined;

    beforeEach(() => {
        originalHome = process.env.HOME;
        process.env.HOME = mkdtempSync(join(tmpdir(), "ccc-device-broker-test-home-"));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        if (process.env.HOME) rmSync(process.env.HOME, { recursive: true, force: true });
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
    });

    it("claims, lists, reuses, and releases owner-scoped physical leases", async () => {
        const ownerId = "2222333344445555";
        const leaseFile = join(homedir(), ".ccc/devices/physical-leases/android-device/locks", `${encodeURIComponent("192.168.1.20:5555")}.json`);
        const server = createDeviceBrokerServer({ cwd: "/project/broker-lease-test", host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        const endpoint = `${baseUrl}/v1/owners/${ownerId}/rpc`;
        const headers = {
            "content-type": "application/json",
            "x-ccc-device-token": deviceBrokerOwnerToken(ownerId),
        };
        try {
            const claim = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.lease.claim",
                    params: {
                        backend: "android-device",
                        hardwareId: "192.168.1.20:5555",
                        deviceId: "android-phone",
                        connection: "wifi",
                        transport: { host: "192.168.1.20", port: 5555 },
                    },
                }),
            });
            expect(claim.status).toBe(200);
            expect(await claim.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    created: true,
                    lease: expect.objectContaining({
                        ownerId,
                        backend: "android-device",
                        hardwareId: "192.168.1.20:5555",
                        deviceId: "android-phone",
                        connection: "wifi",
                        transport: { host: "192.168.1.20", port: 5555 },
                    }),
                }),
            }));

            const reuse = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.lease.claim",
                    params: { backend: "android-device", hardwareId: "192.168.1.20:5555" },
                }),
            });
            expect(reuse.status).toBe(200);
            expect(await reuse.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({ created: false, reused: true }),
            }));

            const list = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({ method: "broker.lease.list", params: { backend: "android-device" } }),
            });
            expect(list.status).toBe(200);
            const listBody = await list.json() as { result: { ownerId: string; leases: Array<{ hardwareId: string }> } };
            expect(listBody.result.ownerId).toBe(ownerId);
            expect(listBody.result.leases).toEqual([expect.objectContaining({ hardwareId: "192.168.1.20:5555" })]);

            const release = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.lease.release",
                    params: { backend: "android-device", hardwareId: "192.168.1.20:5555", deviceId: "android-phone" },
                }),
            });
            expect(release.status).toBe(200);
            expect(await release.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({ released: true }),
            }));

            const afterRelease = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({ method: "broker.lease.list", params: { backend: "android-device" } }),
            });
            expect(afterRelease.status).toBe(200);
            expect(await afterRelease.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({ leases: [] }),
            }));
        } finally {
            await close(server);
            rmSync(leaseFile, { force: true });
        }
    });

    it("rejects physical lease conflicts, cross-owner release, all-owner listing, and invalid params", async () => {
        const ownerA = "3333444455556666";
        const ownerB = "4444555566667777";
        const leaseFile = join(homedir(), ".ccc/devices/physical-leases/ios-device/locks", `${encodeURIComponent("00008110-001122334455801E")}.json`);
        const server = createDeviceBrokerServer({ cwd: "/project/broker-lease-conflict-test", host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        const endpointA = `${baseUrl}/v1/owners/${ownerA}/rpc`;
        const endpointB = `${baseUrl}/v1/owners/${ownerB}/rpc`;
        const headersA = { "content-type": "application/json", "x-ccc-device-token": deviceBrokerOwnerToken(ownerA) };
        const headersB = { "content-type": "application/json", "x-ccc-device-token": deviceBrokerOwnerToken(ownerB) };
        try {
            const claimA = await fetch(endpointA, {
                method: "POST",
                headers: headersA,
                body: JSON.stringify({
                    method: "broker.lease.claim",
                    params: { backend: "ios-device", hardwareId: "00008110-001122334455801E", deviceId: "iphone-a", connection: "usb" },
                }),
            });
            expect(claimA.status).toBe(200);

            const conflict = await fetch(endpointB, {
                method: "POST",
                headers: headersB,
                body: JSON.stringify({
                    method: "broker.lease.claim",
                    params: { backend: "ios-device", hardwareId: "00008110-001122334455801E", deviceId: "iphone-b", connection: "usb" },
                }),
            });
            expect(conflict.status).toBe(409);
            expect(await conflict.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "physical-lease-conflict",
                conflict: expect.objectContaining({ ownerId: ownerA, deviceId: "iphone-a" }),
            }));

            const releaseForeign = await fetch(endpointB, {
                method: "POST",
                headers: headersB,
                body: JSON.stringify({
                    method: "broker.lease.release",
                    params: { backend: "ios-device", hardwareId: "00008110-001122334455801E" },
                }),
            });
            expect(releaseForeign.status).toBe(403);
            expect(await releaseForeign.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "physical-lease-owned-by-another-owner",
            }));

            const listB = await fetch(endpointB, {
                method: "POST",
                headers: headersB,
                body: JSON.stringify({ method: "broker.lease.list", params: { backend: "ios-device" } }),
            });
            expect(listB.status).toBe(200);
            expect(await listB.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({ ownerId: ownerB, leases: [] }),
            }));

            const allOwners = await fetch(endpointA, {
                method: "POST",
                headers: headersA,
                body: JSON.stringify({ method: "broker.lease.list", params: { backend: "ios-device", all: true } }),
            });
            expect(allOwners.status).toBe(403);
            expect(await allOwners.json()).toEqual(expect.objectContaining({ ok: false, error: "all-owner-lease-list-requires-admin" }));

            const invalidBackend = await fetch(endpointA, {
                method: "POST",
                headers: headersA,
                body: JSON.stringify({ method: "broker.lease.claim", params: { backend: "windows-sandbox", hardwareId: "x" } }),
            });
            expect(invalidBackend.status).toBe(400);
            expect(await invalidBackend.json()).toEqual(expect.objectContaining({ ok: false, error: "invalid-lease-backend" }));

            const invalidHardware = await fetch(endpointA, {
                method: "POST",
                headers: headersA,
                body: JSON.stringify({ method: "broker.lease.claim", params: { backend: "ios-device", hardwareId: "" } }),
            });
            expect(invalidHardware.status).toBe(400);
            expect(await invalidHardware.json()).toEqual(expect.objectContaining({ ok: false, error: "invalid-hardware-id" }));
        } finally {
            await close(server);
            rmSync(leaseFile, { force: true });
        }
    });
});
