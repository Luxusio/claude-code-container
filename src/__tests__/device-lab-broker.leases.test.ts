import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { dirname, join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeviceBrokerServer, DEVICE_BROKER_PHYSICAL_LEASE_DIRECTORY_ENTRY_LIMIT, deviceBrokerOwnerToken, registerDeviceBrokerOwner } from "../device-lab-broker.js";
import { deviceLabOwnerId } from "../device-lab-owner.js";
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
        const ownerId = deviceLabOwnerId("/project/broker-lease-test");
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

    it("rejects malformed authoritative lease state without replacing it", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-malformed-lease-test");
        const hardwareId = "MALFORMED-LEASE";
        const leaseFile = join(homedir(), ".ccc/devices/physical-leases/android-device/locks", `${encodeURIComponent(hardwareId)}.json`);
        mkdirSync(dirname(leaseFile), { recursive: true });
        writeFileSync(leaseFile, "{not-json");
        const server = createDeviceBrokerServer({ cwd: "/project/broker-malformed-lease-test", host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        try {
            const response = await fetch(`${baseUrl}/v1/owners/${ownerId}/rpc`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-ccc-device-token": deviceBrokerOwnerToken(ownerId),
                },
                body: JSON.stringify({
                    method: "broker.lease.claim",
                    params: { backend: "android-device", hardwareId, deviceId: "replacement" },
                }),
            });
            expect(response.status).toBe(409);
            expect(await response.json()).toEqual(expect.objectContaining({ ok: false, error: "physical-lease-state-invalid" }));
            expect(readFileSync(leaseFile, "utf8")).toBe("{not-json");
        } finally {
            await close(server);
        }
    });

    it("ignores malformed and noncanonical lease filenames without blocking valid leases", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-lease-filename-test");
        const locksDir = join(homedir(), ".ccc/devices/physical-leases/android-device/locks");
        const server = createDeviceBrokerServer({ cwd: "/project/broker-lease-filename-test", host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        const endpoint = `${baseUrl}/v1/owners/${ownerId}/rpc`;
        const headers = { "content-type": "application/json", "x-ccc-device-token": deviceBrokerOwnerToken(ownerId) };
        try {
            const claim = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.lease.claim",
                    params: { backend: "android-device", hardwareId: "VALID-LEASE", deviceId: "valid-device" },
                }),
            });
            expect(claim.status).toBe(200);
            writeFileSync(join(locksDir, "%ZZ.json"), "{}");
            writeFileSync(join(locksDir, "%56ALIAS.json"), "{}");

            const list = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({ method: "broker.lease.list", params: { backend: "android-device" } }),
            });
            expect(list.status).toBe(200);
            expect(await list.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    leases: [expect.objectContaining({ hardwareId: "VALID-LEASE", deviceId: "valid-device" })],
                }),
            }));

            const prune = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({ method: "broker.lease.prune", params: { backend: "android-device" } }),
            });
            expect(prune.status).toBe(200);
        } finally {
            await close(server);
        }
    });

    it.runIf(process.platform !== "win32")("rejects linked physical lease directories", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-linked-lease-directory-test");
        const backendRoot = join(homedir(), ".ccc/devices/physical-leases/android-device");
        const external = mkdtempSync(join(tmpdir(), "ccc-external-lease-locks-"));
        mkdirSync(backendRoot, { recursive: true });
        symlinkSync(external, join(backendRoot, "locks"));
        const server = createDeviceBrokerServer({ cwd: "/project/broker-linked-lease-directory-test", host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        try {
            const response = await fetch(`${baseUrl}/v1/owners/${ownerId}/rpc`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-ccc-device-token": deviceBrokerOwnerToken(ownerId) },
                body: JSON.stringify({ method: "broker.lease.list", params: { backend: "android-device" } }),
            });
            expect(response.status).toBe(409);
            expect(await response.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "physical-lease-directory-invalid",
                detail: "physical-lease-directory-path-invalid",
            }));

            const claim = await fetch(`${baseUrl}/v1/owners/${ownerId}/rpc`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-ccc-device-token": deviceBrokerOwnerToken(ownerId) },
                body: JSON.stringify({
                    method: "broker.lease.claim",
                    params: { backend: "android-device", hardwareId: "LINKED-LEASE", deviceId: "linked-device" },
                }),
            });
            expect(claim.status).toBe(409);
            expect(await claim.json()).toEqual(expect.objectContaining({ error: "physical-lease-directory-invalid" }));
            expect(existsSync(join(external, "LINKED-LEASE.json"))).toBe(false);
        } finally {
            await close(server);
            rmSync(external, { recursive: true, force: true });
        }
    });

    it("bounds physical lease directory enumeration", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-lease-directory-limit-test");
        const locksDir = join(homedir(), ".ccc/devices/physical-leases/ios-device/locks");
        mkdirSync(locksDir, { recursive: true });
        for (let index = 0; index <= DEVICE_BROKER_PHYSICAL_LEASE_DIRECTORY_ENTRY_LIMIT; index += 1) {
            writeFileSync(join(locksDir, `${index}.noise`), "");
        }
        const server = createDeviceBrokerServer({ cwd: "/project/broker-lease-directory-limit-test", host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        try {
            const response = await fetch(`${baseUrl}/v1/owners/${ownerId}/rpc`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-ccc-device-token": deviceBrokerOwnerToken(ownerId) },
                body: JSON.stringify({ method: "broker.lease.list", params: { backend: "ios-device" } }),
            });
            expect(response.status).toBe(507);
            expect(await response.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "physical-lease-directory-entry-limit-exceeded",
                limit: DEVICE_BROKER_PHYSICAL_LEASE_DIRECTORY_ENTRY_LIMIT,
            }));
        } finally {
            await close(server);
        }
    });

    it("rejects physical lease conflicts, cross-owner release, all-owner listing, and invalid params", async () => {
        const ownerA = deviceLabOwnerId("/project/broker-lease-conflict-test");
        const ownerBPath = "/project/broker-lease-conflict-foreign-test";
        const ownerB = deviceLabOwnerId(ownerBPath);
        registerDeviceBrokerOwner(ownerBPath);
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

    it("fences same-owner attach operations and token-bound broker mutations", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-lease-operation-test");
        const hardwareId = "USB-FENCED";
        const server = createDeviceBrokerServer({ cwd: "/project/broker-lease-operation-test", host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        const endpoint = `${baseUrl}/v1/owners/${ownerId}/rpc`;
        const headers = { "content-type": "application/json", "x-ccc-device-token": deviceBrokerOwnerToken(ownerId) };
        const rpc = (method: string, params: Record<string, unknown>) => fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify({ method, params }),
        });
        try {
            const claim = await rpc("broker.lease.claim", {
                backend: "android-device",
                hardwareId,
                deviceId: "android-fenced",
                claimNonce: "attach-operation-a",
            });
            expect(claim.status).toBe(200);
            const claimBody = await claim.json() as { result: { lease: { claimId: string } } };

            const operationConflict = await rpc("broker.lease.claim", {
                backend: "android-device",
                hardwareId,
                deviceId: "android-fenced",
                claimNonce: "attach-operation-b",
            });
            expect(operationConflict.status).toBe(409);
            expect(await operationConflict.json()).toEqual(expect.objectContaining({ error: "physical-lease-operation-conflict" }));

            const deviceConflict = await rpc("broker.lease.claim", {
                backend: "android-device",
                hardwareId,
                deviceId: "android-other",
            });
            expect(deviceConflict.status).toBe(409);
            expect(await deviceConflict.json()).toEqual(expect.objectContaining({ error: "physical-lease-device-mismatch" }));

            const staleHeartbeat = await rpc("broker.lease.heartbeat", {
                backend: "android-device",
                hardwareId,
                deviceId: "android-fenced",
                claimId: "wrong-claim",
                claimNonce: "attach-operation-a",
            });
            expect(staleHeartbeat.status).toBe(409);
            expect(await staleHeartbeat.json()).toEqual(expect.objectContaining({ error: "physical-lease-claim-mismatch" }));

            const staleRelease = await rpc("broker.lease.release", {
                backend: "android-device",
                hardwareId,
                deviceId: "android-fenced",
                claimId: claimBody.result.lease.claimId,
                claimNonce: "attach-operation-b",
            });
            expect(staleRelease.status).toBe(409);
            expect(await staleRelease.json()).toEqual(expect.objectContaining({ error: "physical-lease-operation-mismatch" }));

            const release = await rpc("broker.lease.release", {
                backend: "android-device",
                hardwareId,
                deviceId: "android-fenced",
                claimId: claimBody.result.lease.claimId,
                claimNonce: "attach-operation-a",
            });
            expect(release.status).toBe(200);
        } finally {
            await close(server);
        }
    });
});
