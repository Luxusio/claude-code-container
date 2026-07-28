import { spawn } from "child_process";
import { createHash } from "crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createServer } from "http";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    createDeviceBrokerServer,
    DEVICE_BROKER_RPC_RESPONSE_LIMIT_BYTES,
    deviceBrokerCli,
    deviceBrokerCliAsync,
    deviceBrokerService,
    deviceBrokerOwnerToken,
    formatDeviceBrokerService,
    formatDeviceBrokerStatus,
    invokeHostDeviceBrokerOwnerRpc,
    parseBrokerServiceArgs,
    parseBrokerServeArgs,
    startDeviceBrokerServe,
} from "../device-lab-broker.js";
import { deviceLabOwnerId, devicesCli, devicesCliAsync } from "../device-lab-admin.js";
import { CLI_VERSION } from "../utils.js";
import { close, listen } from "./helpers/host-broker-test-fixture.js";
import { freePort } from "./helpers/fake-broker-mcp-fixture.js";
import { withSharedMutationLockAsync } from "../../device-lab-mcp/src/state/shared-mutation-lock.mjs";

async function waitForBrokerHealth(port: number, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/health`);
            const body = await response.json() as { name?: string };
            if (response.ok && body.name === "ccc-device-broker") return true;
        } catch {
            // Retry until the CLI has had time to bind the port.
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
}

describe("device-lab host broker physical attach and CLI", () => {
    let originalHome: string | undefined;

    beforeEach(() => {
        originalHome = process.env.HOME;
        process.env.HOME = mkdtempSync(join(tmpdir(), "ccc-device-broker-attach-test-home-"));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        if (process.env.HOME) rmSync(process.env.HOME, { recursive: true, force: true });
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
    });

    it("attaches and detaches physical Android/iOS devices through broker RPC with leases", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-physical-attach-test");
        const ownerRoot = join(homedir(), ".ccc/devices/owners", ownerId);
        const androidLease = join(homedir(), ".ccc/devices/physical-leases/android-device/locks", `${encodeURIComponent("192.168.1.80:5555")}.json`);
        const androidUsbLease = join(homedir(), ".ccc/devices/physical-leases/android-device/locks", `${encodeURIComponent("USB123")}.json`);
        const iosLease = join(homedir(), ".ccc/devices/physical-leases/ios-device/locks", `${encodeURIComponent("00008120-00AA00BB00CC00DD")}.json`);
        const commandRunner = vi.fn((command) => {
            if (command.provider === "adb" && command.args?.[0] === "connect") {
                return { mode: "exec", provider: "adb", executable: command.executable, args: command.args, status: 0, stdout: `connected to ${command.args[1]}`, stderr: "" };
            }
            if (command.provider === "adb" && command.args?.join(" ") === "devices -l") {
                return { mode: "exec", provider: "adb", executable: command.executable, args: command.args, status: 0, stdout: "List of devices attached\n192.168.1.80:5555 device product:pixel model:Pixel_8\nUSB123 device product:pixel model:Pixel_USB\n", stderr: "" };
            }
            if (command.provider === "xcrun" && command.args?.join(" ") === "xctrace list devices") {
                return { mode: "exec", provider: "xcrun", executable: command.executable, args: command.args, status: 0, stdout: "== Devices ==\nReal iPhone (17.5) (00008110-001C195E0E91801E)\nNetwork iPhone (17.5) (00008120-00AA00BB00CC00DD) (Network)\n", stderr: "" };
            }
            return { mode: "exec", provider: command.provider, executable: command.executable, args: command.args, status: 1, stdout: "", stderr: "unexpected command" };
        });
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-physical-attach-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { adb: "/fake/adb", xcrun: "/fake/xcrun" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        const endpoint = `${baseUrl}/v1/owners/${ownerId}/rpc`;
        const headers = { "content-type": "application/json", "x-ccc-device-token": deviceBrokerOwnerToken(ownerId) };
        const operationLock = (backend: string, deviceId: string) => join(
            ownerRoot,
            backend,
            "operations",
            `${createHash("sha256").update(deviceId).digest("hex").slice(0, 32)}.lock`,
        );
        try {
            const missingWifiTarget = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.physical.attach",
                    params: { backend: "android-device", deviceId: "android-missing-target", connection: "wifi" },
                }),
            });
            expect(missingWifiTarget.status).toBe(400);
            expect(await missingWifiTarget.json()).toEqual(expect.objectContaining({ ok: false, error: "missing-android-wifi-target" }));
            expect(commandRunner).not.toHaveBeenCalledWith(expect.objectContaining({ provider: "adb", args: ["connect", "null:5555"] }), expect.any(Object));

            let releaseAttach!: () => void;
            let attachLockEntered!: () => void;
            const attachGate = new Promise<void>((resolve) => { releaseAttach = resolve; });
            const attachLockReady = new Promise<void>((resolve) => { attachLockEntered = resolve; });
            const attachHolder = withSharedMutationLockAsync(operationLock("android-device", "android-wifi"), async () => {
                attachLockEntered();
                await attachGate;
            });
            await attachLockReady;
            let attachSettled = false;
            const androidAttachRequest = fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.physical.attach",
                    params: { backend: "android-device", deviceId: "android-wifi", name: "WiFi Pixel", connection: "wifi", host: "192.168.1.80", port: 5555 },
                }),
            }).then((response) => {
                attachSettled = true;
                return response;
            });
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(attachSettled).toBe(false);
            expect(existsSync(androidLease)).toBe(false);
            releaseAttach();
            await attachHolder;
            const androidAttach = await androidAttachRequest;
            expect(androidAttach.status).toBe(200);
            expect(await androidAttach.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    device: expect.objectContaining({
                        id: "android-wifi",
                        serial: "192.168.1.80:5555",
                        connection: "wifi",
                        transport: { type: "wifi", host: "192.168.1.80", port: 5555 },
                    }),
                    lease: expect.objectContaining({ hardwareId: "192.168.1.80:5555", ownerId }),
                    heartbeat: expect.objectContaining({ ttlMs: expect.any(Number), intervalMs: expect.any(Number) }),
                }),
            }));
            expect(commandRunner).toHaveBeenCalledWith(expect.objectContaining({ provider: "adb", args: ["connect", "192.168.1.80:5555"] }), expect.any(Object));

            const androidUsbAutoAttach = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.physical.attach",
                    params: { backend: "android-device", deviceId: "android-usb-auto", name: "USB Pixel", connection: "usb" },
                }),
            });
            expect(androidUsbAutoAttach.status).toBe(200);
            expect(await androidUsbAutoAttach.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    device: expect.objectContaining({
                        id: "android-usb-auto",
                        serial: "USB123",
                        connection: "usb",
                        transport: expect.objectContaining({ type: "usb" }),
                    }),
                    lease: expect.objectContaining({ hardwareId: "USB123", ownerId }),
                }),
            }));

            const iosAttach = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.physical.attach",
                    params: { backend: "ios-device", deviceId: "ios-network", name: "Network iPhone", connection: "wifi", udid: "00008120-00AA00BB00CC00DD", host: "network-iphone.local" },
                }),
            });
            expect(iosAttach.status).toBe(200);
            expect(await iosAttach.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    device: expect.objectContaining({
                        id: "ios-network",
                        udid: "00008120-00AA00BB00CC00DD",
                        connection: "wifi",
                        transport: expect.objectContaining({ type: "wifi", host: "network-iphone.local", visibleVia: "xctrace" }),
                    }),
                    lease: expect.objectContaining({ hardwareId: "00008120-00AA00BB00CC00DD", ownerId }),
                    heartbeat: expect.objectContaining({ ttlMs: expect.any(Number), intervalMs: expect.any(Number) }),
                }),
            }));

            const list = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({ method: "broker.physical.list", params: { backend: "android-device" } }),
            });
            expect(list.status).toBe(200);
            expect(await list.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    devices: expect.arrayContaining([
                        expect.objectContaining({ id: "android-wifi" }),
                        expect.objectContaining({ id: "android-usb-auto", serial: "USB123" }),
                    ]),
                    leases: expect.arrayContaining([
                        expect.objectContaining({ hardwareId: "192.168.1.80:5555" }),
                        expect.objectContaining({ hardwareId: "USB123" }),
                    ]),
                    hostDevices: expect.arrayContaining([
                        expect.objectContaining({ serial: "USB123", state: "device", connection: "usb", attachable: true }),
                    ]),
                    hostInventory: expect.objectContaining({ ok: true, count: 2 }),
                }),
            }));

            const androidStateFile = join(ownerRoot, "android-device", "devices.json");
            const androidState = JSON.parse(readFileSync(androidStateFile, "utf8")) as { devices: Array<Record<string, unknown>> };
            writeFileSync(androidStateFile, JSON.stringify({
                devices: androidState.devices.map((candidate) => candidate.id === "android-wifi" ? {
                    ...candidate,
                    appium: {
                        authority: "host-broker",
                        processOwner: "host-broker",
                        startedBy: "broker.appium.start",
                        runtimeId: "detach-appium-runtime",
                        serverPid: 12345,
                    },
                    recording: {
                        authority: "host-broker",
                        processOwner: "host-broker",
                        startedBy: "broker.device.recording.start",
                        pid: 12346,
                    },
                } : candidate),
            }));

            const currentLease = JSON.parse(readFileSync(androidLease, "utf8")) as Record<string, unknown>;
            writeFileSync(androidLease, JSON.stringify({ ...currentLease, claimNonce: "successor-claim-nonce" }));
            commandRunner.mockClear();
            const staleDetach = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({ method: "broker.physical.detach", params: { backend: "android-device", deviceId: "android-wifi" } }),
            });
            expect(staleDetach.status).toBe(409);
            expect(await staleDetach.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "physical-lease-release-failed",
            }));
            expect(existsSync(androidLease)).toBe(true);
            expect(commandRunner).not.toHaveBeenCalled();
            const listAfterStaleDetach = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({ method: "broker.physical.list", params: { backend: "android-device" } }),
            });
            expect(await listAfterStaleDetach.json()).toEqual(expect.objectContaining({
                result: expect.objectContaining({
                    devices: expect.arrayContaining([expect.objectContaining({ id: "android-wifi" })]),
                }),
            }));
            writeFileSync(androidLease, JSON.stringify(currentLease));

            let releaseDetach!: () => void;
            let detachLockEntered!: () => void;
            const detachGate = new Promise<void>((resolve) => { releaseDetach = resolve; });
            const detachLockReady = new Promise<void>((resolve) => { detachLockEntered = resolve; });
            const detachHolder = withSharedMutationLockAsync(operationLock("android-device", "android-wifi"), async () => {
                detachLockEntered();
                await detachGate;
            });
            await detachLockReady;
            let detachSettled = false;
            const androidDetachRequest = fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({ method: "broker.physical.detach", params: { backend: "android-device", deviceId: "android-wifi" } }),
            }).then((response) => {
                detachSettled = true;
                return response;
            });
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(detachSettled).toBe(false);
            expect(existsSync(androidLease)).toBe(true);
            releaseDetach();
            await detachHolder;
            const androidDetach = await androidDetachRequest;
            expect(androidDetach.status).toBe(200);
            expect(await androidDetach.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    detached: "android-wifi",
                    physicalDevicePoweredOff: false,
                    disconnected: false,
                    auxiliaryCleanup: expect.objectContaining({
                        ok: true,
                        appium: expect.objectContaining({ cleared: true }),
                        recording: expect.objectContaining({ cleared: true }),
                    }),
                }),
            }));
            expect(existsSync(androidLease)).toBe(false);

            const androidUsbDetach = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({ method: "broker.physical.detach", params: { backend: "android-device", deviceId: "android-usb-auto" } }),
            });
            expect(androidUsbDetach.status).toBe(200);
            expect(await androidUsbDetach.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({ detached: "android-usb-auto", physicalDevicePoweredOff: false, disconnected: false }),
            }));
            expect(existsSync(androidUsbLease)).toBe(false);

            const iosStateFile = join(ownerRoot, "ios-device", "devices.json");
            const iosState = JSON.parse(readFileSync(iosStateFile, "utf8")) as { devices: Array<Record<string, unknown>> };
            writeFileSync(iosStateFile, JSON.stringify({
                devices: iosState.devices.map((candidate) => candidate.id === "ios-network" ? {
                    ...candidate,
                    recording: {
                        authority: "external",
                        processOwner: "external",
                        startedBy: "external-recorder",
                        pid: 12347,
                    },
                } : candidate),
            }));
            const unsafeIosDetach = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({ method: "broker.physical.detach", params: { backend: "ios-device", deviceId: "ios-network" } }),
            });
            expect(unsafeIosDetach.status).toBe(502);
            expect(await unsafeIosDetach.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "auxiliary-runtime-cleanup-failed",
                result: expect.objectContaining({ detached: false }),
            }));
            expect(existsSync(iosLease)).toBe(true);
            const iosListAfterFailedDetach = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({ method: "broker.physical.list", params: { backend: "ios-device" } }),
            });
            expect(await iosListAfterFailedDetach.json()).toEqual(expect.objectContaining({
                result: expect.objectContaining({
                    devices: expect.arrayContaining([expect.objectContaining({ id: "ios-network" })]),
                }),
            }));
        } finally {
            await close(server);
            rmSync(ownerRoot, { recursive: true, force: true });
            rmSync(androidLease, { force: true });
            rmSync(androidUsbLease, { force: true });
            rmSync(iosLease, { force: true });
        }
    });

    it("rechecks host authorization and reattaches an existing detached Android device", async () => {
        const cwd = "/project/broker-physical-reattach-test";
        const ownerId = deviceLabOwnerId(cwd);
        const deviceId = "android-usb-reattach";
        const serial = "USB-REATTACH";
        const stateRoot = join(homedir(), ".ccc/devices/owners", ownerId, "android-device");
        const stateFile = join(stateRoot, "devices.json");
        const leaseFile = join(homedir(), ".ccc/devices/physical-leases/android-device/locks", `${encodeURIComponent(serial)}.json`);
        mkdirSync(stateRoot, { recursive: true });
        writeFileSync(stateFile, JSON.stringify({
            devices: [{
                id: deviceId,
                name: "Detached USB phone",
                backend: "android-device",
                ownerId,
                serial,
                connection: "usb",
                status: "detached",
            }],
        }));
        let authorized = false;
        const commandRunner = vi.fn((command) => ({
            mode: "exec",
            provider: command.provider,
            executable: command.executable,
            args: command.args,
            status: 0,
            stdout: command.provider === "adb" && command.args?.join(" ") === "devices -l"
                ? `List of devices attached\n${serial} ${authorized ? "device product:crown model:SM_N960N" : "unauthorized"}\n`
                : "",
            stderr: "",
        }));
        const server = createDeviceBrokerServer({
            cwd,
            host: "127.0.0.1",
            port: 0,
            providerPaths: { adb: "/fake/adb" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        const endpoint = `${baseUrl}/v1/owners/${ownerId}/rpc`;
        const headers = { "content-type": "application/json", "x-ccc-device-token": deviceBrokerOwnerToken(ownerId) };
        const attach = () => fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify({
                method: "broker.physical.attach",
                params: { backend: "android-device", deviceId, name: "USB phone", connection: "usb", serial },
            }),
        });
        try {
            const unauthorized = await attach();
            expect(unauthorized.status).toBe(409);
            expect(await unauthorized.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "android-device-not-attachable",
                hardwareId: serial,
                state: "unauthorized",
            }));
            expect(existsSync(leaseFile)).toBe(false);
            expect(JSON.parse(readFileSync(stateFile, "utf8")).devices).toEqual([
                expect.objectContaining({ id: deviceId, serial, status: "detached" }),
            ]);

            authorized = true;
            const reattached = await attach();
            expect(reattached.status).toBe(200);
            expect(await reattached.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    device: expect.objectContaining({ id: deviceId, serial, status: "attached" }),
                    lease: expect.objectContaining({ ownerId, deviceId, hardwareId: serial }),
                }),
            }));
            const devices = JSON.parse(readFileSync(stateFile, "utf8")).devices as Array<Record<string, unknown>>;
            expect(devices).toHaveLength(1);
            expect(devices[0]).toEqual(expect.objectContaining({ id: deviceId, serial, status: "attached" }));
        } finally {
            await close(server);
            rmSync(leaseFile, { force: true });
        }
    });

    it("supports physical lease TTL, heartbeat, prune, and expired foreign lease recovery", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-physical-lease-ttl-test");
        const foreignOwner = "2222ffffeeee0000";
        const serial = "10.10.0.8:5555";
        const expiredSerial = "10.10.0.9:5555";
        const staleSerial = "10.10.0.10:5555";
        const leaseDir = join(homedir(), ".ccc/devices/physical-leases/android-device/locks");
        const leasePath = (hardwareId: string) => join(leaseDir, `${encodeURIComponent(hardwareId)}.json`);
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-physical-lease-ttl-test",
            host: "127.0.0.1",
            port: 0,
        });
        const baseUrl = await listen(server);
        const endpoint = `${baseUrl}/v1/owners/${ownerId}/rpc`;
        const headers = { "content-type": "application/json", "x-ccc-device-token": deviceBrokerOwnerToken(ownerId) };
        try {
            const claim = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.lease.claim",
                    params: { backend: "android-device", hardwareId: serial, deviceId: "android-ttl", ttlMs: 60000 },
                }),
            });
            expect(claim.status).toBe(200);
            const claimPayload = await claim.json();
            expect(claimPayload).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    created: true,
                    lease: expect.objectContaining({
                        hardwareId: serial,
                        ownerId,
                        ttlMs: 60000,
                        heartbeatAt: expect.any(String),
                        expiresAt: expect.any(String),
                    }),
                }),
            }));
            const firstExpires = Date.parse(claimPayload.result.lease.expiresAt);

            const heartbeat = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.lease.heartbeat",
                    params: { backend: "android-device", hardwareId: serial, deviceId: "android-ttl", ttlMs: 120000 },
                }),
            });
            expect(heartbeat.status).toBe(200);
            const heartbeatPayload = await heartbeat.json();
            expect(heartbeatPayload).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    heartbeat: true,
                    lease: expect.objectContaining({ ttlMs: 120000 }),
                }),
            }));
            expect(Date.parse(heartbeatPayload.result.lease.expiresAt)).toBeGreaterThan(firstExpires);

            mkdirSync(leaseDir, { recursive: true });
            writeFileSync(leasePath(staleSerial), JSON.stringify({
                backend: "android-device",
                hardwareId: staleSerial,
                ownerId,
                deviceId: "android-stale",
                claimedAt: "2000-01-01T00:00:00.000Z",
                updatedAt: "2000-01-01T00:00:00.000Z",
                heartbeatAt: "2000-01-01T00:00:00.000Z",
                ttlMs: 60000,
                expiresAt: "2000-01-01T00:01:00.000Z",
            }, null, 2));
            const prune = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({ method: "broker.lease.prune", params: { backend: "android-device" } }),
            });
            expect(prune.status).toBe(200);
            expect(await prune.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    pruned: [expect.objectContaining({ hardwareId: staleSerial, expired: true })],
                }),
            }));
            expect(existsSync(leasePath(staleSerial))).toBe(false);

            const sameOwnerExpired = "10.10.0.12:5555";
            writeFileSync(leasePath(sameOwnerExpired), JSON.stringify({
                backend: "android-device",
                hardwareId: sameOwnerExpired,
                ownerId,
                deviceId: "old-owner-device",
                claimedAt: "2000-01-01T00:00:00.000Z",
                updatedAt: "2000-01-01T00:00:00.000Z",
                heartbeatAt: "2000-01-01T00:00:00.000Z",
                ttlMs: 60000,
                expiresAt: "2000-01-01T00:01:00.000Z",
            }, null, 2));
            const sameOwnerRebound = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.lease.claim",
                    params: { backend: "android-device", hardwareId: sameOwnerExpired, deviceId: "new-owner-device" },
                }),
            });
            expect(sameOwnerRebound.status).toBe(200);
            expect(await sameOwnerRebound.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    created: true,
                    lease: expect.objectContaining({ hardwareId: sameOwnerExpired, ownerId, deviceId: "new-owner-device" }),
                }),
            }));

            writeFileSync(leasePath(expiredSerial), JSON.stringify({
                backend: "android-device",
                hardwareId: expiredSerial,
                ownerId: foreignOwner,
                deviceId: "foreign-expired",
                claimedAt: "2000-01-01T00:00:00.000Z",
                updatedAt: "2000-01-01T00:00:00.000Z",
                ttlMs: 60000,
                expiresAt: "2000-01-01T00:01:00.000Z",
            }, null, 2));
            const recovered = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.lease.claim",
                    params: { backend: "android-device", hardwareId: expiredSerial, deviceId: "android-recovered" },
                }),
            });
            expect(recovered.status).toBe(200);
            expect(await recovered.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    created: true,
                    lease: expect.objectContaining({ hardwareId: expiredSerial, ownerId, deviceId: "android-recovered" }),
                }),
            }));

            const activeForeign = "10.10.0.11:5555";
            writeFileSync(leasePath(activeForeign), JSON.stringify({
                backend: "android-device",
                hardwareId: activeForeign,
                ownerId: foreignOwner,
                deviceId: "foreign-active",
                claimedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                ttlMs: 60000,
                expiresAt: new Date(Date.now() + 60000).toISOString(),
            }, null, 2));
            const conflict = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.lease.claim",
                    params: { backend: "android-device", hardwareId: activeForeign, deviceId: "android-conflict" },
                }),
            });
            expect(conflict.status).toBe(409);
            expect(await conflict.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "physical-lease-conflict",
                conflict: expect.objectContaining({ ownerId: foreignOwner }),
            }));

            const foreignHeartbeat = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.lease.heartbeat",
                    params: { backend: "android-device", hardwareId: activeForeign },
                }),
            });
            expect(foreignHeartbeat.status).toBe(403);
            expect(await foreignHeartbeat.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "physical-lease-owned-by-another-owner",
            }));
        } finally {
            await close(server);
            for (const hardwareId of [serial, expiredSerial, staleSerial, "10.10.0.11:5555", "10.10.0.12:5555"]) {
                rmSync(leasePath(hardwareId), { force: true });
            }
        }
    });

    it("reports Apple trust and network-pairing diagnostics through broker RPC", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-apple-trust-test");
        const commandRunner = vi.fn((command) => {
            if (command.provider === "xcrun" && command.args?.join(" ") === "xctrace list devices") {
                return { mode: "exec", provider: "xcrun", executable: command.executable, args: command.args, status: 0, stdout: "== Devices ==\nTrusted USB iPhone (17.5) (00008110-001C195E0E91801E)\nNetwork Named USB iPhone (17.5) (00008111-001C195E0E91801F)\nNetwork iPhone (17.5) (00008120-00AA00BB00CC00DD) (Network)\nUnavailable iPhone (17.5) (00008130-00AA00BB00CC00EE) (Unavailable)\n", stderr: "" };
            }
            return { mode: "exec", provider: command.provider, executable: command.executable, args: command.args, status: 1, stdout: "", stderr: "unexpected command" };
        });
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-apple-trust-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { xcrun: "/fake/xcrun" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        const endpoint = `${baseUrl}/v1/owners/${ownerId}/rpc`;
        const headers = { "content-type": "application/json", "x-ccc-device-token": deviceBrokerOwnerToken(ownerId) };
        try {
            const status = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({ method: "broker.apple.trust", params: { action: "status", backend: "ios-device", udid: "00008120-00AA00BB00CC00DD" } }),
            });
            expect(status.status).toBe(200);
            expect(await status.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    readyToAttach: true,
                    networkVisible: true,
                    manualRequired: false,
                    trustState: "visible-to-xctrace",
                    safety: expect.objectContaining({ bypassesTrustPrompt: false, erasesDevice: false }),
                }),
            }));

            const usbNamedNetworkConnect = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({ method: "broker.apple.trust", params: { action: "connect", backend: "ios-device", udid: "00008111-001C195E0E91801F" } }),
            });
            expect(usbNamedNetworkConnect.status).toBe(409);
            expect(await usbNamedNetworkConnect.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "ios-apple-pairing-manual-required",
                result: expect.objectContaining({
                    networkVisible: false,
                    selected: expect.objectContaining({ name: "Network Named USB iPhone", connection: "usb" }),
                }),
            }));

            const pair = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({ method: "broker.apple.trust", params: { action: "pair", backend: "ios-device", udid: "00008110-001C195E0E91801E" } }),
            });
            expect(pair.status).toBe(409);
            expect(await pair.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "ios-apple-pairing-manual-required",
                result: expect.objectContaining({
                    manualRequired: true,
                    networkVisible: false,
                    manualSteps: expect.arrayContaining([expect.stringContaining("Trust This Computer")]),
                }),
            }));

            const unavailable = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({ method: "broker.apple.trust", params: { action: "status", backend: "ios-device", udid: "00008130-00AA00BB00CC00EE" } }),
            });
            expect(unavailable.status).toBe(200);
            expect(await unavailable.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    readyToAttach: false,
                    manualRequired: true,
                    trustState: "visible-unavailable",
                }),
            }));

            const missing = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({ method: "broker.apple.trust", params: { action: "status", backend: "ios-device", udid: "MISSING-UDID" } }),
            });
            expect(missing.status).toBe(200);
            expect(await missing.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    readyToAttach: false,
                    visible: false,
                    trustState: "not-visible",
                    manualRequired: true,
                }),
            }));

            const wifiAttachForUsbNamedNetwork = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.physical.attach",
                    params: { backend: "ios-device", deviceId: "ios-network-named-usb", name: "Network Named USB iPhone", connection: "wifi", udid: "00008111-001C195E0E91801F", host: "named-usb.local" },
                }),
            });
            expect(wifiAttachForUsbNamedNetwork.status).toBe(409);
            expect(await wifiAttachForUsbNamedNetwork.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "ios-wifi-device-not-network-visible",
                diagnostic: expect.objectContaining({
                    networkVisible: false,
                    selected: expect.objectContaining({ connection: "usb" }),
                }),
            }));
        } finally {
            await close(server);
        }
    });

    it("reports missing xcrun for broker Apple trust diagnostics", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-apple-missing-xcrun-test");
        const commandRunner = vi.fn((command) => ({ mode: "exec", provider: command.provider, executable: command.executable, args: command.args, status: null, stdout: "", stderr: "", error: "executable-not-found" }));
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-apple-missing-xcrun-test",
            host: "127.0.0.1",
            port: 0,
            commandRunner,
        });
        const baseUrl = await listen(server);
        try {
            const response = await fetch(`${baseUrl}/v1/owners/${ownerId}/rpc`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-ccc-device-token": deviceBrokerOwnerToken(ownerId) },
                body: JSON.stringify({ method: "broker.apple.trust", params: { action: "status", backend: "ios-device" } }),
            });
            expect(response.status).toBe(502);
            expect(await response.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "ios-wireless-missing-xcrun",
                result: expect.objectContaining({
                    manualRequired: true,
                    safety: expect.objectContaining({ bypassesTrustPrompt: false }),
                }),
            }));
        } finally {
            await close(server);
        }
    });

    it("cleans Android broker leases on adb connect failure and rejects non-network iOS Wi-Fi attach", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-physical-failure-test");
        const ownerRoot = join(homedir(), ".ccc/devices/owners", ownerId);
        const androidLease = join(homedir(), ".ccc/devices/physical-leases/android-device/locks", `${encodeURIComponent("192.168.1.81:5555")}.json`);
        const commandRunner = vi.fn((command) => {
            if (command.provider === "adb" && command.args?.[0] === "connect") {
                return { mode: "exec", provider: "adb", executable: command.executable, args: command.args, status: 1, stdout: "", stderr: "failed to connect" };
            }
            if (command.provider === "xcrun") {
                return { mode: "exec", provider: "xcrun", executable: command.executable, args: command.args, status: 0, stdout: "== Devices ==\nUSB iPhone (17.5) (00008110-001C195E0E91801E)\n", stderr: "" };
            }
            return { mode: "exec", provider: command.provider, executable: command.executable, args: command.args, status: 0, stdout: "", stderr: "" };
        });
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-physical-failure-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { adb: "/fake/adb", xcrun: "/fake/xcrun" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        const endpoint = `${baseUrl}/v1/owners/${ownerId}/rpc`;
        const headers = { "content-type": "application/json", "x-ccc-device-token": deviceBrokerOwnerToken(ownerId) };
        try {
            const androidAttach = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.physical.attach",
                    params: { backend: "android-device", deviceId: "android-fail", connection: "wifi", host: "192.168.1.81" },
                }),
            });
            expect(androidAttach.status).toBe(502);
            expect(await androidAttach.json()).toEqual(expect.objectContaining({ ok: false, error: "adb-connect-failed" }));
            expect(existsSync(androidLease)).toBe(false);

            const iosAttach = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.physical.attach",
                    params: { backend: "ios-device", deviceId: "ios-usb-as-wifi", connection: "wifi", udid: "00008110-001C195E0E91801E" },
                }),
            });
            expect(iosAttach.status).toBe(409);
            expect(await iosAttach.json()).toEqual(expect.objectContaining({ ok: false, error: "ios-wifi-device-not-network-visible" }));
        } finally {
            await close(server);
            rmSync(ownerRoot, { recursive: true, force: true });
            rmSync(androidLease, { force: true });
        }
    });

    it("releases physical leases when attached device owner state cannot be written", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-physical-write-failure-test");
        const ownerRoot = join(homedir(), ".ccc/devices/owners", ownerId);
        const androidLease = join(homedir(), ".ccc/devices/physical-leases/android-device/locks", `${encodeURIComponent("192.168.1.82:5555")}.json`);
        const iosLease = join(homedir(), ".ccc/devices/physical-leases/ios-device/locks", `${encodeURIComponent("00008140-00AA00BB00CC00FF")}.json`);
        const commandRunner = vi.fn((command) => {
            if (command.provider === "adb" && command.args?.[0] === "connect") {
                return { mode: "exec", provider: "adb", executable: command.executable, args: command.args, status: 0, stdout: `connected to ${command.args[1]}`, stderr: "" };
            }
            if (command.provider === "adb" && command.args?.join(" ") === "devices -l") {
                mkdirSync(join(ownerRoot, "android-device", "devices.json"), { recursive: true });
                return { mode: "exec", provider: "adb", executable: command.executable, args: command.args, status: 0, stdout: "List of devices attached\n192.168.1.82:5555 device product:pixel model:Pixel_8\n", stderr: "" };
            }
            if (command.provider === "xcrun") {
                mkdirSync(join(ownerRoot, "ios-device", "devices.json"), { recursive: true });
                return { mode: "exec", provider: "xcrun", executable: command.executable, args: command.args, status: 0, stdout: "== Devices ==\nNetwork iPhone (17.5) (00008140-00AA00BB00CC00FF) (Network)\n", stderr: "" };
            }
            return { mode: "exec", provider: command.provider, executable: command.executable, args: command.args, status: 1, stdout: "", stderr: "unexpected command" };
        });
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-physical-write-failure-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { adb: "/fake/adb", xcrun: "/fake/xcrun" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        const endpoint = `${baseUrl}/v1/owners/${ownerId}/rpc`;
        const headers = { "content-type": "application/json", "x-ccc-device-token": deviceBrokerOwnerToken(ownerId) };
        try {
            mkdirSync(join(ownerRoot, "android-device", "operations"), { recursive: true });
            const androidAttach = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.physical.attach",
                    params: { backend: "android-device", deviceId: "android-write-fails", connection: "wifi", host: "192.168.1.82" },
                }),
            });
            expect(androidAttach.status).toBe(500);
            expect(await androidAttach.json()).toEqual(expect.objectContaining({ ok: false, error: "owner-state-write-failed" }));
            expect(existsSync(androidLease)).toBe(false);

            rmSync(join(ownerRoot, "android-device"), { recursive: true, force: true });
            mkdirSync(join(ownerRoot, "ios-device", "operations"), { recursive: true });
            const iosAttach = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.physical.attach",
                    params: { backend: "ios-device", deviceId: "ios-write-fails", udid: "00008140-00AA00BB00CC00FF" },
                }),
            });
            expect(iosAttach.status).toBe(500);
            expect(await iosAttach.json()).toEqual(expect.objectContaining({ ok: false, error: "owner-state-write-failed" }));
            expect(existsSync(iosLease)).toBe(false);
        } finally {
            await close(server);
            rmSync(ownerRoot, { recursive: true, force: true });
            rmSync(androidLease, { force: true });
            rmSync(iosLease, { force: true });
        }
    });

    it("restores a released physical lease when detach cannot persist owner state", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-physical-detach-write-failure-test");
        const deviceId = "android-detach-write-fails";
        const serial = "USB-DETACH-WRITE-FAILS";
        const claimId = "claim-detach-write-fails";
        const claimNonce = "nonce-detach-write-fails";
        const ownerStateRoot = join(homedir(), ".ccc/devices/owners", ownerId, "android-device");
        const leaseDir = join(homedir(), ".ccc/devices/physical-leases/android-device/locks");
        const leaseFile = join(leaseDir, `${encodeURIComponent(serial)}.json`);
        mkdirSync(join(ownerStateRoot, "operations"), { recursive: true });
        writeFileSync(join(ownerStateRoot, "devices.json"), JSON.stringify({
            devices: [{
                id: deviceId,
                backend: "android-device",
                physical: true,
                serial,
                status: "attached",
                leaseClaimId: claimId,
                leaseClaimNonce: claimNonce,
            }],
        }));
        mkdirSync(leaseDir, { recursive: true });
        writeFileSync(leaseFile, JSON.stringify({
            backend: "android-device",
            hardwareId: serial,
            ownerId,
            deviceId,
            claimId,
            claimNonce,
            expiresAt: new Date(Date.now() + 10_000).toISOString(),
        }));
        const server = createDeviceBrokerServer({ cwd: "/project/broker-physical-detach-write-failure-test", host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        const endpoint = `${baseUrl}/v1/owners/${ownerId}/rpc`;
        const headers = { "content-type": "application/json", "x-ccc-device-token": deviceBrokerOwnerToken(ownerId) };
        const detach = () => fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify({
                method: "broker.physical.detach",
                params: { backend: "android-device", deviceId },
            }),
        });
        try {
            chmodSync(ownerStateRoot, 0o500);
            const failed = await detach();
            expect(failed.status).toBe(500);
            expect(await failed.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "owner-state-write-failed",
                result: expect.objectContaining({
                    detached: false,
                    leaseRollback: expect.objectContaining({ attempted: true, ok: true }),
                }),
            }));
            expect(JSON.parse(readFileSync(leaseFile, "utf8"))).toEqual(expect.objectContaining({
                ownerId,
                deviceId,
                claimId,
                claimNonce,
            }));
            const state = JSON.parse(readFileSync(join(ownerStateRoot, "devices.json"), "utf8")) as { devices: Array<Record<string, unknown>> };
            expect(state.devices[0]).toEqual(expect.objectContaining({
                status: "attached",
                leaseClaimId: claimId,
                leaseClaimNonce: claimNonce,
            }));

            chmodSync(ownerStateRoot, 0o700);
            const recovered = await detach();
            expect(recovered.status).toBe(200);
            expect(existsSync(leaseFile)).toBe(false);
        } finally {
            chmodSync(ownerStateRoot, 0o700);
            await close(server);
            rmSync(join(homedir(), ".ccc/devices/owners", ownerId), { recursive: true, force: true });
            rmSync(leaseFile, { force: true });
        }
    });

    it("formats broker status and routes through ccc devices broker status", () => {
        const direct = formatDeviceBrokerStatus({ cwd: "/project/broker-cli-test" });
        expect(direct).toContain("=== CCC Device Broker ===");
        expect(direct).toContain("mode: host-broker-daemon");
        expect(direct).toContain(`cliProcessPid: ${process.pid}`);
        expect(direct).toContain("hostSupervision: status-only");
        expect(direct).not.toContain("service: ");
        expect(direct).toContain("stateExists: false");
        expect(direct).toContain("runtimePresent: false");
        expect(direct).toContain("ownerResolution: host-broker-resolve");
        expect(direct).toContain("environmentRequired: false");
        expect(direct).not.toContain("ownerBasisEnv:");
        expect(direct).not.toContain("ownerBasisMatches:");
        expect(direct).toContain("deviceStateMounted: false");
        expect(direct).toContain("warning: device-lab container wiring is incomplete");
        expect(direct).toContain("remedy: restart or recreate ccc from the host");
        expect(direct).toContain("host-ccc-auto-start-compatible");

        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const exitCode = deviceBrokerCli(["status"], "/project/broker-cli-test");
        expect(exitCode).toBe(0);
        expect(log).toHaveBeenCalledWith(expect.stringContaining("=== CCC Device Broker ==="));

        log.mockClear();
        const routedExitCode = devicesCli(["broker", "status"], "/project/broker-cli-test");
        expect(routedExitCode).toBe(0);
        expect(log).toHaveBeenCalledWith(expect.stringContaining("mode: host-broker-daemon"));

        log.mockClear();
        const profileCwd = "/project/broker-cli-profile-test";
        const profiledExitCode = devicesCli(["broker", "status"], profileCwd, "work");
        expect(profiledExitCode).toBe(0);
        expect(log).toHaveBeenCalledWith(expect.stringContaining(`owner: ${deviceLabOwnerId(profileCwd, "work")}`));
        expect(log).not.toHaveBeenCalledWith(expect.stringContaining(`owner: ${deviceLabOwnerId(profileCwd)}`));
    });

    it("repairs broker readiness before async broker status output", async () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const ensureHostBroker = vi.fn(async () => ({
            ok: true,
            ownerId: deviceLabOwnerId("/project/broker-cli-async-test"),
            launched: true,
            reused: false,
            host: "127.0.0.1",
            probeHost: "127.0.0.1",
            port: 54321,
            verifiedCapabilities: ["hyper-v-vm-managed-auto-images-v20", "hyper-v-windows-iso-unattend-v1"],
            verifiedBrokerPid: 4321,
            verifiedBrokerStartedAt: "2026-07-28T00:00:00.000Z",
            attempts: [],
        }));

        const exitCode = await deviceBrokerCliAsync(["status"], "/project/broker-cli-async-test", undefined, { ensureHostBroker });

        expect(exitCode).toBe(0);
        expect(ensureHostBroker).toHaveBeenCalledWith({ cwd: "/project/broker-cli-async-test", profile: undefined });
        expect(log).toHaveBeenCalledWith(expect.stringContaining("port: 54321"));
        expect(log).toHaveBeenCalledWith(expect.stringContaining("url: http://127.0.0.1:54321"));
        expect(log).toHaveBeenCalledWith("brokerReady: true");
        expect(log).toHaveBeenCalledWith("brokerLaunched: true");
        expect(log).toHaveBeenCalledWith("brokerVerifiedCapabilities: hyper-v-vm-managed-auto-images-v20, hyper-v-windows-iso-unattend-v1");
        expect(log).toHaveBeenCalledWith("brokerVerifiedPid: 4321");
        expect(log).toHaveBeenCalledWith("brokerVerifiedStartedAt: 2026-07-28T00:00:00.000Z");
        expect(error).not.toHaveBeenCalled();
    });

    it("routes public ccc devices broker status through async readiness repair", async () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const ensureHostBroker = vi.fn(async () => ({
            ok: true,
            ownerId: deviceLabOwnerId("/project/devices-broker-cli-async-test", "work"),
            launched: false,
            reused: true,
            host: "127.0.0.1",
            probeHost: "127.0.0.1",
            port: 17373,
            attempts: [],
        }));

        const exitCode = await devicesCliAsync(["broker", "status"], "/project/devices-broker-cli-async-test", "work", { ensureHostBroker });

        expect(exitCode).toBe(0);
        expect(ensureHostBroker).toHaveBeenCalledWith({ cwd: "/project/devices-broker-cli-async-test", profile: "work" });
        expect(log).toHaveBeenCalledWith(expect.stringContaining(`owner: ${deviceLabOwnerId("/project/devices-broker-cli-async-test", "work")}`));
        expect(log).toHaveBeenCalledWith("brokerReady: true");
        expect(log).toHaveBeenCalledWith("brokerReused: true");
        expect(log).toHaveBeenCalledWith("brokerLaunched: false");
        expect(error).not.toHaveBeenCalled();
    });

    it("creates Windows Sandbox definitions through the public CLI with minimized mode by default", async () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const invokeOwnerRpc = vi.fn(async (_method, params) => ({
            ok: true,
            status: 200,
            ownerId: deviceLabOwnerId("/project/devices-create-cli-test"),
            host: "127.0.0.1",
            port: 17373,
            body: {
                ok: true,
                result: {
                    device: {
                        id: params.deviceId,
                        name: params.name,
                        backend: params.backend,
                        status: "stopped",
                        minimized: params.minimized,
                    },
                },
            },
        }));

        const exitCode = await devicesCliAsync(
            ["create", "windows-sandbox", "win-dev"],
            "/project/devices-create-cli-test",
            undefined,
            { invokeOwnerRpc },
        );

        expect(exitCode).toBe(0);
        expect(invokeOwnerRpc).toHaveBeenCalledWith("broker.command.invoke", expect.objectContaining({
            backend: "windows-sandbox",
            command: "device_create",
            deviceId: "win-dev",
            name: "win-dev",
            minimized: true,
        }), expect.objectContaining({ cwd: "/project/devices-create-cli-test", rpcTimeoutMs: 300000 }));
        expect(log).toHaveBeenCalledWith(expect.stringContaining("minimized: true"));
        expect(error).not.toHaveBeenCalled();
    });

    it("invokes authenticated owner RPC through a repaired host broker", async () => {
        const cwd = "/project/devices-owner-rpc-cli-test";
        const ownerId = deviceLabOwnerId(cwd);
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        const port = Number(new URL(baseUrl).port);
        const ensureHostBroker = vi.fn(async () => ({
            ok: true,
            ownerId,
            launched: false,
            reused: true,
            host: "127.0.0.1",
            probeHost: "127.0.0.1",
            port,
            attempts: [],
        }));
        try {
            const result = await invokeHostDeviceBrokerOwnerRpc("broker.echo", { value: "ccc-owner-rpc-ok" }, {
                cwd,
                rpcTimeoutMs: 5000,
                ensureHostBroker,
            });

            expect(result).toEqual(expect.objectContaining({
                ok: true,
                status: 200,
                ownerId,
                body: expect.objectContaining({
                    ok: true,
                    result: expect.objectContaining({ params: { value: "ccc-owner-rpc-ok" } }),
                }),
            }));
            expect(ensureHostBroker).toHaveBeenCalledOnce();
        } finally {
            await close(server);
        }
    });

    it("forwards typed Hyper-V Windows VM create options through the public CLI", async () => {
        const cwd = "/project/devices-hyper-v-create-cli-test";
        const ownerId = deviceLabOwnerId(cwd);
        const stateDir = join(homedir(), ".ccc/devices/owners", ownerId, "windows-vm");
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(join(stateDir, "devices.json"), JSON.stringify({ devices: [{ id: "win11-dev", backend: "windows-vm", status: "stopped" }] }));
        const invokeOwnerRpc = vi.fn(async (_method, params) => ({
            ok: true,
            status: 200,
            ownerId,
            host: "127.0.0.1",
            port: 17373,
            body: {
                ok: true,
                result: {
                    device: { id: params.deviceId, backend: params.backend, provider: "hyper-v", status: "stopped" },
                },
            },
        }));
        vi.spyOn(console, "log").mockImplementation(() => undefined);

        const exitCode = await devicesCliAsync([
            "create", "windows-vm", "win11-dev",
            "--provider", "hyper-v",
            "--image", "/images/windows-11.vhdx",
            "--vm-profile", "windows-11",
            "--memory-mb", "4096",
            "--cpus", "4",
            "--switch-name", "Default Switch",
            "--secure-boot-template", "MicrosoftWindows",
        ], cwd, undefined, { invokeOwnerRpc });

        expect(exitCode).toBe(0);
        expect(invokeOwnerRpc).toHaveBeenCalledWith("broker.command.invoke", expect.objectContaining({
            backend: "windows-vm",
            command: "device_create",
            deviceId: "win11-dev",
            name: "win11-dev",
            provider: "hyper-v",
            image: "/images/windows-11.vhdx",
            profile: "windows-11",
            memoryMb: 4096,
            cpus: 4,
            switchName: "Default Switch",
            secureBootTemplate: "MicrosoftWindows",
        }), expect.objectContaining({ cwd, rpcTimeoutMs: 21615000 }));
    });

    it("does not follow redirects from authenticated owner RPC", async () => {
        const cwd = "/project/devices-owner-rpc-redirect-test";
        const ownerId = deviceLabOwnerId(cwd);
        let redirectTargetRequests = 0;
        const redirectTarget = createServer((_req, res) => {
            redirectTargetRequests += 1;
            res.end(JSON.stringify({ ok: true, result: { value: "unexpected" } }));
        });
        await new Promise<void>((resolve) => redirectTarget.listen(0, "127.0.0.1", resolve));
        const redirectTargetPort = (redirectTarget.address() as { port: number }).port;
        const redirectSource = createServer((_req, res) => {
            res.writeHead(307, { location: `http://127.0.0.1:${redirectTargetPort}/rpc` });
            res.end();
        });
        await new Promise<void>((resolve) => redirectSource.listen(0, "127.0.0.1", resolve));
        const port = (redirectSource.address() as { port: number }).port;
        const ensureHostBroker = vi.fn(async () => ({
            ok: true,
            ownerId,
            launched: false,
            reused: true,
            probeHost: "127.0.0.1",
            port,
        }));
        try {
            const result = await invokeHostDeviceBrokerOwnerRpc("broker.echo", {}, { cwd, ensureHostBroker });
            expect(result).toEqual(expect.objectContaining({
                ok: false,
                status: 307,
                error: "broker-redirect-disallowed",
            }));
            expect(redirectTargetRequests).toBe(0);
        } finally {
            await close(redirectSource);
            await close(redirectTarget);
        }
    });

    it("rejects oversized owner RPC responses before accumulation", async () => {
        const cwd = "/project/devices-owner-rpc-oversized-test";
        const ownerId = deviceLabOwnerId(cwd);
        const server = createServer((_req, res) => {
            res.writeHead(200, {
                "content-type": "application/json",
                "content-length": String(DEVICE_BROKER_RPC_RESPONSE_LIMIT_BYTES + 1),
            });
            res.end("{}");
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as { port: number }).port;
        const ensureHostBroker = vi.fn(async () => ({
            ok: true,
            ownerId,
            launched: false,
            reused: true,
            probeHost: "127.0.0.1",
            port,
        }));
        try {
            const result = await invokeHostDeviceBrokerOwnerRpc("broker.echo", {}, { cwd, ensureHostBroker });
            expect(result).toEqual(expect.objectContaining({
                ok: false,
                status: 200,
                error: "broker-response-too-large",
                body: null,
            }));
        } finally {
            await close(server);
        }
    });

    it("starts and inspects an owner Windows Sandbox through public CLI commands", async () => {
        const cwd = "/project/devices-start-cli-test";
        const ownerId = deviceLabOwnerId(cwd);
        const stateDir = join(homedir(), ".ccc/devices/owners", ownerId, "windows");
        const stateFile = join(stateDir, "devices.json");
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(stateFile, JSON.stringify({ devices: [{ id: "win-dev", backend: "windows-sandbox", status: "stopped", minimized: true }] }));
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const invokeOwnerRpc = vi.fn(async (_method, params) => {
            const deleted = params.command === "device_delete";
            return {
                ok: true,
                status: 200,
                ownerId,
                host: "127.0.0.1",
                port: 17373,
                body: {
                    ok: true,
                    result: {
                        device: deleted ? null : {
                            id: params.deviceId,
                            backend: params.backend,
                            status: params.command === "device_stop" ? "stopped" : "running",
                            minimized: params.command === "device_start" ? params.minimized : true,
                            minimizeConfirmed: true,
                            sandboxId: "11111111-1111-4111-8111-111111111111",
                        },
                    },
                },
            };
        });

        expect(await devicesCliAsync(["start", "win-dev", "--no-minimized"], cwd, undefined, { invokeOwnerRpc })).toBe(0);
        expect(invokeOwnerRpc).toHaveBeenLastCalledWith("broker.command.invoke", expect.objectContaining({
            backend: "windows-sandbox",
            command: "device_start",
            deviceId: "win-dev",
            minimized: false,
        }), expect.any(Object));

        expect(await devicesCliAsync(["status", "win-dev"], cwd, undefined, { invokeOwnerRpc })).toBe(0);
        expect(invokeOwnerRpc).toHaveBeenLastCalledWith("broker.command.invoke", expect.objectContaining({
            backend: "windows-sandbox",
            command: "device_status",
            deviceId: "win-dev",
        }), expect.any(Object));
        expect(log).toHaveBeenCalledWith(expect.stringContaining("minimizeConfirmed: true"));

        expect(await devicesCliAsync(["stop", "win-dev"], cwd, undefined, { invokeOwnerRpc })).toBe(0);
        expect(invokeOwnerRpc).toHaveBeenLastCalledWith("broker.command.invoke", expect.objectContaining({
            backend: "windows-sandbox",
            command: "device_stop",
            deviceId: "win-dev",
        }), expect.any(Object));

        expect(await devicesCliAsync(["delete", "win-dev"], cwd, undefined, { invokeOwnerRpc })).toBe(0);
        expect(invokeOwnerRpc).toHaveBeenLastCalledWith("broker.command.invoke", expect.objectContaining({
            backend: "windows-sandbox",
            command: "device_delete",
            deviceId: "win-dev",
        }), expect.any(Object));
        expect(log).toHaveBeenCalledWith(expect.stringContaining("status: deleted"));
    });

    it("lists, creates, restores, and deletes owner Hyper-V snapshots through public CLI commands", async () => {
        const cwd = "/project/devices-snapshot-cli-test";
        const ownerId = deviceLabOwnerId(cwd);
        const stateDir = join(homedir(), ".ccc/devices/owners", ownerId, "windows-vm");
        const snapshotId = "87654321-4321-4321-8321-cba987654321";
        mkdirSync(stateDir, { recursive: true });
        const incarnationId = "1".repeat(32);
        writeFileSync(join(stateDir, "devices.json"), JSON.stringify({ devices: [{ id: "hyperv-dev", backend: "windows-vm", status: "stopped", incarnationId }] }));
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const invokeOwnerRpc = vi.fn(async (_method, params) => ({
            ok: true,
            status: 200,
            ownerId,
            host: "127.0.0.1",
            port: 17373,
            body: {
                ok: true,
                result: {
                    ...(params.tool === "device_snapshot_list" ? {
                        snapshots: [{ id: snapshotId, name: "before-install", providerName: `ccc-${ownerId}-before-install` }],
                        activeSnapshotId: snapshotId,
                    } : {}),
                    snapshot: { id: snapshotId, name: params.snapshotName || "before-install", providerName: `ccc-${ownerId}-before-install` },
                },
            },
        }));

        expect(await devicesCliAsync(["snapshot", "list", "hyperv-dev"], cwd, undefined, { invokeOwnerRpc })).toBe(0);
        expect(invokeOwnerRpc).toHaveBeenLastCalledWith("broker.device.tool.invoke", expect.objectContaining({
            tool: "device_snapshot_list",
            backend: "windows-vm",
            deviceId: "hyperv-dev",
        }), expect.objectContaining({ rpcTimeoutMs: 150000 }));
        expect(log).toHaveBeenLastCalledWith(expect.stringContaining(`* before-install (${snapshotId})`));

        expect(await devicesCliAsync(["snapshot", "create", "hyperv-dev", "before-install"], cwd, undefined, { invokeOwnerRpc })).toBe(0);
        expect(invokeOwnerRpc).toHaveBeenLastCalledWith("broker.device.tool.invoke", expect.objectContaining({
            tool: "device_snapshot_create",
            backend: "windows-vm",
            deviceId: "hyperv-dev",
            snapshotName: "before-install",
            incarnationId,
        }), expect.objectContaining({ rpcTimeoutMs: 150000 }));
        expect(log).toHaveBeenLastCalledWith(expect.stringContaining(`id: ${snapshotId}`));

        expect(await devicesCliAsync(["snapshot", "restore", "hyperv-dev", snapshotId.toUpperCase(), "--confirm-destructive", "--force"], cwd, undefined, { invokeOwnerRpc })).toBe(0);
        expect(invokeOwnerRpc).toHaveBeenLastCalledWith("broker.device.tool.invoke", expect.objectContaining({
            tool: "device_snapshot_restore",
            snapshotId,
            incarnationId,
            confirmDestructive: true,
            force: true,
        }), expect.any(Object));

        expect(await devicesCliAsync(["snapshot", "delete", "hyperv-dev", "before-install", "--confirm-destructive"], cwd, undefined, { invokeOwnerRpc })).toBe(0);
        expect(invokeOwnerRpc).toHaveBeenLastCalledWith("broker.device.tool.invoke", expect.objectContaining({
            tool: "device_snapshot_delete",
            snapshotName: "before-install",
            incarnationId,
            confirmDestructive: true,
        }), expect.any(Object));
    });

    it("rejects malformed Hyper-V snapshot list arguments", async () => {
        const cwd = "/project/devices-snapshot-list-cli-test";
        const ownerId = deviceLabOwnerId(cwd);
        const stateDir = join(homedir(), ".ccc/devices/owners", ownerId, "windows-vm");
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(join(stateDir, "devices.json"), JSON.stringify({ devices: [{ id: "hyperv-dev", backend: "windows-vm", status: "stopped" }] }));
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const invokeOwnerRpc = vi.fn();

        expect(await devicesCliAsync(["snapshot", "list", "hyperv-dev", "unexpected"], cwd, undefined, { invokeOwnerRpc })).toBe(1);
        expect(error).toHaveBeenLastCalledWith("Usage: ccc devices snapshot list <device-id>");
        expect(invokeOwnerRpc).not.toHaveBeenCalled();
    });

    it("reboots an owner Hyper-V VM through the public CLI", async () => {
        const cwd = "/project/devices-reboot-cli-test";
        const ownerId = deviceLabOwnerId(cwd);
        const stateDir = join(homedir(), ".ccc/devices/owners", ownerId, "linux-vm");
        mkdirSync(stateDir, { recursive: true });
        const statePath = join(stateDir, "devices.json");
        const incarnationId = "2".repeat(32);
        writeFileSync(statePath, JSON.stringify({ devices: [{ id: "linux-dev", backend: "linux-vm", status: "running", incarnationId }] }));
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        const invokeOwnerRpc = vi.fn(async (_method, params) => ({
            ok: true,
            status: 200,
            ownerId,
            host: "127.0.0.1",
            port: 17373,
            body: { ok: true, result: { device: { id: params.deviceId, backend: params.backend, status: "running", bootReady: true } } },
        }));

        expect(await devicesCliAsync([
            "reboot", "linux-dev", "--force", "--start-if-stopped", "--wait-for-boot", "--boot-timeout-ms", "1200000",
        ], cwd, undefined, { invokeOwnerRpc })).toBe(0);
        expect(invokeOwnerRpc).toHaveBeenCalledWith("broker.command.invoke", expect.objectContaining({
            backend: "linux-vm",
            command: "device_reboot",
            deviceId: "linux-dev",
            force: true,
            startIfStopped: true,
            waitForBoot: true,
            bootTimeoutMs: 1200000,
            incarnationId,
        }), expect.objectContaining({
            rpcTimeoutMs: 10 * 60 * 1000 + 120000 + 1200000 + 15000,
        }));

        expect(await devicesCliAsync(["stop", "linux-dev"], cwd, undefined, { invokeOwnerRpc })).toBe(0);
        expect(invokeOwnerRpc).toHaveBeenLastCalledWith("broker.command.invoke", expect.objectContaining({
            backend: "linux-vm",
            command: "device_stop",
            deviceId: "linux-dev",
            incarnationId,
        }), expect.any(Object));

        writeFileSync(statePath, JSON.stringify({ devices: [{ id: "linux-dev", backend: "linux-vm", status: "stopped", incarnationId }] }));
        expect(await devicesCliAsync(["start", "linux-dev"], cwd, undefined, { invokeOwnerRpc })).toBe(0);
        expect(invokeOwnerRpc).toHaveBeenLastCalledWith("broker.command.invoke", expect.objectContaining({
            backend: "linux-vm",
            command: "device_start",
            deviceId: "linux-dev",
            incarnationId,
        }), expect.any(Object));

        expect(await devicesCliAsync(["delete", "linux-dev"], cwd, undefined, { invokeOwnerRpc })).toBe(0);
        expect(invokeOwnerRpc).toHaveBeenLastCalledWith("broker.command.invoke", expect.objectContaining({
            backend: "linux-vm",
            command: "device_delete",
            deviceId: "linux-dev",
            incarnationId,
        }), expect.any(Object));
    });

    it("rejects unsafe or unsupported public snapshot commands before broker invocation", async () => {
        const cwd = "/project/devices-snapshot-cli-invalid-test";
        const ownerId = deviceLabOwnerId(cwd);
        const windowsVmDir = join(homedir(), ".ccc/devices/owners", ownerId, "windows-vm");
        const windowsDir = join(homedir(), ".ccc/devices/owners", ownerId, "windows");
        mkdirSync(windowsVmDir, { recursive: true });
        mkdirSync(windowsDir, { recursive: true });
        writeFileSync(join(windowsVmDir, "devices.json"), JSON.stringify({ devices: [{ id: "hyperv-dev", backend: "windows-vm", status: "stopped" }] }));
        writeFileSync(join(windowsDir, "devices.json"), JSON.stringify({ devices: [{ id: "sandbox-dev", backend: "windows-sandbox", status: "stopped" }] }));
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const invokeOwnerRpc = vi.fn();

        expect(await devicesCliAsync(["snapshot", "restore", "hyperv-dev", "before-install"], cwd, undefined, { invokeOwnerRpc })).toBe(1);
        expect(error).toHaveBeenLastCalledWith("Refusing to restore snapshot without --confirm-destructive");
        expect(await devicesCliAsync(["snapshot", "create", "sandbox-dev", "before-install"], cwd, undefined, { invokeOwnerRpc })).toBe(1);
        expect(error).toHaveBeenLastCalledWith("Device snapshots are not supported by backend: windows-sandbox");
        expect(invokeOwnerRpc).not.toHaveBeenCalled();
    });

    it("rejects invalid public lifecycle options without invoking the broker", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const invokeOwnerRpc = vi.fn();
        const cwd = "/project/devices-invalid-cli-test";

        const exitCode = await devicesCliAsync(
            ["create", "windows-sandbox", "win-dev", "--unknown"],
            cwd,
            undefined,
            { invokeOwnerRpc },
        );

        expect(exitCode).toBe(1);
        expect(invokeOwnerRpc).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledWith("Unknown device option: --unknown");

        const stateDir = join(homedir(), ".ccc/devices/owners", deviceLabOwnerId(cwd), "windows");
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(join(stateDir, "devices.json"), JSON.stringify({ devices: [{ id: "win-dev", backend: "windows-sandbox" }] }));
        error.mockClear();
        expect(await devicesCliAsync(["create", "android-emulator", "win-dev"], cwd, undefined, { invokeOwnerRpc })).toBe(1);
        expect(error).toHaveBeenCalledWith("Device id already exists for current owner: win-dev");
        expect(invokeOwnerRpc).not.toHaveBeenCalled();
    });

    it("reports async broker status repair failures", async () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const ensureHostBroker = vi.fn(async () => ({
            ok: false,
            ownerId: deviceLabOwnerId("/project/broker-cli-async-fail-test"),
            launched: false,
            reused: false,
            error: "host-broker-incompatible",
            host: "127.0.0.1",
            probeHost: "127.0.0.1",
            port: 17373,
            attempts: [],
            diagnostics: [
                `existing broker version 1.1.61 does not match CLI version ${CLI_VERSION}`,
                "existing broker does not support the current owner-resolve POST contract",
            ],
        }));

        const exitCode = await deviceBrokerCliAsync(["status"], "/project/broker-cli-async-fail-test", undefined, { ensureHostBroker });

        expect(exitCode).toBe(1);
        expect(log).toHaveBeenCalledWith(expect.stringContaining("=== CCC Device Broker ==="));
        expect(error).toHaveBeenCalledWith("brokerReady: false");
        expect(error).toHaveBeenCalledWith("brokerRepairError: host-broker-incompatible");
        expect(error).toHaveBeenCalledWith(`brokerRepairDiagnostic: existing broker version 1.1.61 does not match CLI version ${CLI_VERSION}`);
        expect(error).toHaveBeenCalledWith("brokerRepairDiagnostic: existing broker does not support the current owner-resolve POST contract");
    });

    it("omits broker wiring warning when the shared state root is present", () => {
        const cwd = "/project/broker-cli-wired-test";
        mkdirSync(join(homedir(), ".ccc/devices"), { recursive: true });

        const status = formatDeviceBrokerStatus({ cwd });

        expect(status).toContain("stateExists: true");
        expect(status).toContain("ownerResolution: host-broker-resolve");
        expect(status).toContain("environmentRequired: false");
        expect(status).not.toContain("ownerBasisEnv:");
        expect(status).not.toContain("ownerBasisMatches:");
        expect(status).toContain("deviceStateMounted: true");
        expect(status).not.toContain("warning: device-lab container wiring is incomplete");
    });

    it("omits broker wiring warning for host CLI when state root exists", () => {
        const cwd = "/project/broker-cli-host-test";
        const originalContainer = process.env.container;
        delete process.env.container;
        mkdirSync(join(homedir(), ".ccc/devices"), { recursive: true });

        try {
            const status = formatDeviceBrokerStatus({ cwd });

            expect(status).toContain("stateExists: true");
            expect(status).toContain("ownerResolution: host-broker-resolve");
            expect(status).toContain("environmentRequired: false");
            expect(status).not.toContain("ownerBasisEnv:");
            expect(status).not.toContain("ownerBasisMatches:");
            expect(status).toContain("deviceStateMounted: true");
            expect(status).not.toContain("warning: device-lab container wiring is incomplete");
        } finally {
            if (originalContainer === undefined) delete process.env.container;
            else process.env.container = originalContainer;
        }
    });

    it("parses and starts the broker serve CLI route through an injectable server", () => {
        expect(parseBrokerServeArgs(["--host", "0.0.0.0", "--port", "19001"])).toEqual({
            host: "0.0.0.0",
            port: 19001,
        });
        expect(parseBrokerServeArgs(["--port", "not-a-number"])).toEqual({
            host: "127.0.0.1",
            port: 17373,
        });

        const listen = vi.fn((_port: number, _host: string, callback: () => void) => {
            callback();
            return undefined;
        });
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const factory = vi.fn(() => ({ listen }) as unknown as ReturnType<typeof createDeviceBrokerServer>);

        const exitCode = startDeviceBrokerServe(["--host", "0.0.0.0", "--port", "19001"], "/project/broker-serve-test", factory);

        expect(exitCode).toBe(0);
        expect(factory).toHaveBeenCalledWith(expect.objectContaining({
            cwd: "/project/broker-serve-test",
            host: "0.0.0.0",
            port: 19001,
        }));
        expect(listen).toHaveBeenCalledWith(19001, "0.0.0.0", expect.any(Function));
        expect(log).toHaveBeenCalledWith("ccc-device-broker listening on http://0.0.0.0:19001");
    });

    it("keeps top-level ccc devices broker serve alive instead of exiting after dispatch", async () => {
        const port = await freePort();
        const env = { ...process.env, HOME: process.env.HOME };
        delete env.VITEST;
        const child = spawn(
            process.execPath,
            [
                join(process.cwd(), "node_modules/tsx/dist/cli.mjs"),
                join(process.cwd(), "src/index.ts"),
                "devices",
                "broker",
                "serve",
                "--host",
                "127.0.0.1",
                "--port",
                String(port),
            ],
            {
                cwd: process.cwd(),
                env,
                stdio: ["ignore", "pipe", "pipe"],
            },
        );
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
        child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
        try {
            const healthy = await waitForBrokerHealth(port);
            if (!healthy) throw new Error(`broker serve did not become healthy; exit=${child.exitCode}; stdout=${stdout}; stderr=${stderr}`);
            expect(child.exitCode).toBeNull();
        } finally {
            child.kill("SIGTERM");
            await new Promise<void>((resolve) => {
                const timer = setTimeout(() => {
                    if (child.exitCode === null) child.kill("SIGKILL");
                    resolve();
                }, 1000);
                child.once("exit", () => {
                    clearTimeout(timer);
                    resolve();
                });
            });
            expect(stderr).not.toContain("Unknown command");
        }
    }, 20000);

    it("plans broker service status diagnostics for Linux user systemd without side effects in dry-run mode", () => {
        const result = deviceBrokerService("status", {
            cwd: "/project/broker-service-linux-test",
            host: "127.0.0.1",
            port: 19002,
            platform: "linux",
            cliPath: "/opt/ccc/dist/index.js",
            providerPaths: { systemctl: "/usr/bin/systemctl" },
            dryRun: true,
        });

        expect(result.ok).toBe(true);
        expect(result.service.manager).toBe("systemd-user");
        expect(result.service.definitionPath).toContain(".config/systemd/user/ccc-device-broker.service");
        expect(result.service.command).toEqual([
            process.execPath,
            "/opt/ccc/dist/index.js",
            "devices",
            "broker",
            "serve",
            "--host",
            "127.0.0.1",
            "--port",
            "19002",
        ]);
        expect(result.service.commands.map((command) => command.args)).toEqual([
            ["--user", "is-active", "ccc-device-broker.service"],
            ["--user", "is-enabled", "ccc-device-broker.service"],
        ]);
        expect(existsSync(result.service.definitionPath || "")).toBe(false);
    });

    it("rejects mutating broker service manager actions before planning commands", () => {
        const commandRunner = vi.fn(() => ({ mode: "exec", provider: "systemctl", executable: "/usr/bin/systemctl", args: [], status: 0, stdout: "", stderr: "" }));
        for (const action of ["install", "uninstall", "start", "stop"]) {
            const result = deviceBrokerService(action, {
                cwd: `/project/broker-service-${action}-test`,
                platform: "linux",
                cliPath: "/opt/ccc/dist/index.js",
                providerPaths: { systemctl: "/usr/bin/systemctl" },
                commandRunner,
            });

            expect(result).toEqual({
                ok: false,
                error: "invalid-service-action",
                action,
                allowed: ["status"],
            });
        }
        expect(commandRunner).not.toHaveBeenCalled();
    });

    it("keeps macOS launchd and Windows scheduled-task service diagnostics status-only", () => {
        const mac = deviceBrokerService("status", {
            cwd: "/project/broker-service-macos-test",
            platform: "darwin",
            cliPath: "/opt/ccc/dist/index.js",
            providerPaths: { launchctl: "/bin/launchctl" },
            dryRun: true,
        });
        expect(mac.ok).toBe(true);
        expect(mac.service.manager).toBe("launchd-user");
        expect(mac.service.definitionPath).toContain("Library/LaunchAgents/com.ccc.device-broker.plist");
        expect(mac.service.commands[0].args).toEqual(["print", expect.stringContaining("/com.ccc.device-broker")]);

        const win = deviceBrokerService("status", {
            cwd: "C:\\project\\broker-service-windows-test",
            platform: "win32",
            cliPath: "C:\\Program Files\\CCC\\dist\\index.js",
            providerPaths: { "powershell.exe": "powershell.exe" },
            dryRun: true,
        });
        expect(win.ok).toBe(true);
        expect(win.service.manager).toBe("scheduled-task");
        expect(win.service.definitionPath).toBeNull();
        const script = win.service.commands[0].args?.join(" ") || "";
        expect(script).toContain("Get-ScheduledTask");
        expect(script).toContain("CCC Device Broker");
        expect(script).not.toContain("Register-ScheduledTask");
    });

    it("reports unsupported service-manager diagnostics and formats CLI output", () => {
        const unsupported = deviceBrokerService("status", {
            cwd: "/project/broker-service-unsupported-test",
            platform: "freebsd",
        });
        expect(unsupported.ok).toBe(false);
        expect(unsupported.error).toBe("service-manager-unsupported");
        expect(formatDeviceBrokerService(unsupported)).toContain("unsupported host platform");

        expect(parseBrokerServiceArgs(["status", "--dry-run", "--host", "0.0.0.0", "--port", "19003"])).toEqual({
            action: "status",
            host: "0.0.0.0",
            port: 19003,
            dryRun: true,
        });
    });

    it("rejects unknown broker CLI subcommands", () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        expect(deviceBrokerCli(["unknown"], "/project/broker-cli-test")).toBe(1);
        expect(error).toHaveBeenCalledWith(expect.stringContaining("Usage: ccc devices broker"));
    });

    it("keeps manual broker service verbs off the user CLI", () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        for (const action of ["install", "uninstall", "start", "stop"]) {
            error.mockClear();
            expect(deviceBrokerCli(["service", action], "/project/broker-cli-test")).toBe(1);
            expect(error).toHaveBeenCalledWith(expect.stringContaining("Broker service repair is automatic"));
        }
    });
});
