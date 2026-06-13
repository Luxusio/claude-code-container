import { createHash } from "crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    createDeviceBrokerServer,
    DEVICE_BROKER_INVENTORY_DEVICE_LIMIT,
    DEVICE_BROKER_INVENTORY_FILE_LIMIT,
    deviceBrokerAuthSecretFile,
    deviceBrokerOwnerToken,
    deviceBrokerStatus,
} from "../device-lab-broker.js";
import { backendRoot, cleanupOwner, close, listen, ownerRoot, ownerRpcEndpoint, ownerRpcHeaders, writeBrokerDevices } from "./helpers/host-broker-test-fixture.js";

describe("device-lab host broker daemon", () => {
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

    it("builds zero-config status metadata without side effects", () => {
        const status = deviceBrokerStatus({
            cwd: "/project/broker-status-test",
            host: "127.0.0.1",
            port: 17373,
            startedAt: "2026-01-01T00:00:00.000Z",
        });

        expect(status).toEqual(expect.objectContaining({
            name: "ccc-device-broker",
            host: "127.0.0.1",
            port: 17373,
            url: "http://127.0.0.1:17373",
            mode: "host-broker-daemon",
            lazy: true,
            startupPolicy: expect.stringContaining("explicit MCP autolaunch"),
            implemented: expect.arrayContaining(["http-health", "http-status", "owner-state-path-reporting", "secret-backed-owner-token-auth"]),
            deferred: expect.arrayContaining(["full-provider-routing-parity"]),
        }));
        expect(status.deferred).not.toContain("strong-authentication-token-handshake");
        expect(status.implemented).toContain("explicit-mcp-autolaunch-compatible");
        expect(status.ownerId).toMatch(/^[a-f0-9]{16}$/);
        expect(status.state.ownerRoot).toContain(status.ownerId);
        expect(status.state.locksRoot).toContain(".ccc/devices/broker/locks");
    });

    it("creates and reuses per-owner broker auth secrets with private file permissions", () => {
        const ownerId = "0a0b0c0d0e0f1112";
        const secretFile = deviceBrokerAuthSecretFile(ownerId);
        const token = deviceBrokerOwnerToken(ownerId);
        expect(token).toMatch(/^[a-f0-9]{64}$/);
        expect(existsSync(secretFile)).toBe(true);
        const stat = statSync(secretFile);
        expect(stat.mode & 0o777).toBe(0o600);
        const firstSecret = JSON.parse(readFileSync(secretFile, "utf8")) as { ownerId: string; secret: string; version: number };
        expect(firstSecret).toEqual(expect.objectContaining({
            ownerId,
            version: 1,
            secret: expect.stringMatching(/^[a-f0-9]{64}$/),
        }));
        expect(deviceBrokerOwnerToken(ownerId)).toBe(token);
        expect(JSON.parse(readFileSync(secretFile, "utf8")).secret).toBe(firstSecret.secret);

        chmodSync(secretFile, 0o644);
        expect(deviceBrokerOwnerToken(ownerId)).toBe(token);
        expect(statSync(secretFile).mode & 0o777).toBe(0o600);
    });

    it("serves health, status, method errors, and 404 JSON", async () => {
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-http-test",
            host: "127.0.0.1",
            port: 0,
            startedAt: new Date().toISOString(),
        });
        const baseUrl = await listen(server);
        try {
            const health = await fetch(`${baseUrl}/health`);
            expect(health.status).toBe(200);
            expect(await health.json()).toEqual(expect.objectContaining({
                ok: true,
                name: "ccc-device-broker",
                mode: "host-broker-daemon",
            }));

            const status = await fetch(`${baseUrl}/status`);
            expect(status.status).toBe(200);
            const statusPayload = await status.json() as { ok: boolean; broker: { ownerId: string; deferred: string[] } };
            expect(statusPayload.ok).toBe(true);
            expect(statusPayload.broker.ownerId).toMatch(/^[a-f0-9]{16}$/);
            expect(statusPayload.broker.deferred).toContain("full-provider-routing-parity");

            const post = await fetch(`${baseUrl}/status`, { method: "POST" });
            expect(post.status).toBe(405);
            expect(post.headers.get("allow")).toBe("GET");
            expect(await post.json()).toEqual(expect.objectContaining({ ok: false, error: "method-not-allowed" }));

            const missing = await fetch(`${baseUrl}/missing`);
            expect(missing.status).toBe(404);
            expect(await missing.json()).toEqual(expect.objectContaining({ ok: false, error: "not-found", path: "/missing" }));
        } finally {
            await close(server);
        }
    });

    it("serves owner-scoped read-only RPC with secret-backed local owner token", async () => {
        const ownerId = "0123456789abcdef";
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-rpc-test",
            host: "127.0.0.1",
            port: 0,
            startedAt: "2026-01-01T00:00:00.000Z",
        });
        const baseUrl = await listen(server);
        try {
            const response = await fetch(`${baseUrl}/v1/owners/${ownerId}/rpc`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-ccc-device-token": deviceBrokerOwnerToken(ownerId),
                },
                body: JSON.stringify({ ownerId, method: "broker.echo", params: { hello: "world" } }),
            });
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({
                ok: true,
                result: { ownerId, params: { hello: "world" } },
            });

            const status = await fetch(`${baseUrl}/v1/owners/${ownerId}/rpc`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-ccc-device-token": deviceBrokerOwnerToken(ownerId),
                },
                body: JSON.stringify({ method: "broker.status" }),
            });
            expect(status.status).toBe(200);
            const statusBody = await status.json() as { ok: boolean; result: { ownerId: string; state: { ownerRoot: string }; implemented: string[]; deferred: string[] } };
            expect(statusBody.ok).toBe(true);
            expect(statusBody.result.ownerId).toBe(ownerId);
            expect(statusBody.result.state.ownerRoot).toContain(ownerId);
            expect(statusBody.result.implemented).toContain("http-owner-rpc");
            expect(statusBody.result.deferred).toContain("full-provider-routing-parity");
        } finally {
            await close(server);
        }
    });

    it("guards broker RPC auth, owner mismatches, methods, and body parsing", async () => {
        const ownerId = "fedcba9876543210";
        const server = createDeviceBrokerServer({ cwd: "/project/broker-rpc-guard-test", host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        const endpoint = `${baseUrl}/v1/owners/${ownerId}/rpc`;
        const token = deviceBrokerOwnerToken(ownerId);
        const oldDeterministicToken = createHash("sha256").update(`ccc-device-broker:owner:${ownerId}`).digest("hex");
        try {
            const missingToken = await fetch(endpoint, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ method: "broker.echo" }),
            });
            expect(missingToken.status).toBe(401);
            expect(await missingToken.json()).toEqual(expect.objectContaining({ ok: false, error: "invalid-owner-token" }));

            const oldToken = await fetch(endpoint, {
                method: "POST",
                headers: { "content-type": "application/json", "x-ccc-device-token": oldDeterministicToken },
                body: JSON.stringify({ method: "broker.echo" }),
            });
            expect(oldToken.status).toBe(401);
            expect(await oldToken.json()).toEqual(expect.objectContaining({ ok: false, error: "invalid-owner-token" }));

            const ownerMismatch = await fetch(endpoint, {
                method: "POST",
                headers: { "content-type": "application/json", "x-ccc-device-token": token },
                body: JSON.stringify({ ownerId: "0123456789abcdef", method: "broker.echo" }),
            });
            expect(ownerMismatch.status).toBe(403);
            expect(await ownerMismatch.json()).toEqual(expect.objectContaining({ ok: false, error: "owner-mismatch" }));

            const lifecycle = await fetch(endpoint, {
                method: "POST",
                headers: { "content-type": "application/json", "x-ccc-device-token": token },
                body: JSON.stringify({ method: "device.start" }),
            });
            expect(lifecycle.status).toBe(501);
            expect(await lifecycle.json()).toEqual(expect.objectContaining({ ok: false, error: "method-not-implemented" }));

            const unknown = await fetch(endpoint, {
                method: "POST",
                headers: { "content-type": "application/json", "x-ccc-device-token": token },
                body: JSON.stringify({ method: "broker.missing" }),
            });
            expect(unknown.status).toBe(404);
            expect(await unknown.json()).toEqual(expect.objectContaining({ ok: false, error: "unknown-method" }));

            const invalidJson = await fetch(endpoint, {
                method: "POST",
                headers: { "content-type": "application/json", "x-ccc-device-token": token },
                body: "{not-json",
            });
            expect(invalidJson.status).toBe(400);
            expect(await invalidJson.json()).toEqual(expect.objectContaining({ ok: false, error: "invalid-json" }));

            const oversized = await fetch(endpoint, {
                method: "POST",
                headers: { "content-type": "application/json", "x-ccc-device-token": token },
                body: JSON.stringify({ method: "broker.echo", params: { payload: "x".repeat(70 * 1024) } }),
            });
            expect(oversized.status).toBe(413);
            expect(await oversized.json()).toEqual(expect.objectContaining({ ok: false, error: "request-too-large" }));

            const get = await fetch(endpoint);
            expect(get.status).toBe(405);
            expect(get.headers.get("allow")).toBe("POST");
        } finally {
            await close(server);
        }
    });

    it("bounds owner inventory state reads and returned device arrays", async () => {
        const ownerId = "1111222233334444";
        const server = createDeviceBrokerServer({ cwd: "/project/broker-inventory-bound-test", host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        try {
            writeBrokerDevices(ownerId, "android", Array.from({ length: DEVICE_BROKER_INVENTORY_DEVICE_LIMIT + 5 }, (_, index) => ({ id: `android-${index}` })));
            writeBrokerDevices(ownerId, "ios", [{ id: "ios-large", payload: "x".repeat(DEVICE_BROKER_INVENTORY_FILE_LIMIT + 1) }]);

            const response = await fetch(`${baseUrl}/v1/owners/${ownerId}/rpc`, {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.inventory" }),
            });
            expect(response.status).toBe(200);
            const body = await response.json() as {
                ok: boolean;
                result: { backends: Array<{ stateKey: string; devices: unknown[]; truncated?: boolean; error?: string; maxBytes?: number; maxDevices?: number; totalDevices?: number }> };
            };
            expect(body.ok).toBe(true);
            const android = body.result.backends.find((backend) => backend.stateKey === "android");
            expect(android).toEqual(expect.objectContaining({
                truncated: true,
                maxDevices: DEVICE_BROKER_INVENTORY_DEVICE_LIMIT,
                totalDevices: DEVICE_BROKER_INVENTORY_DEVICE_LIMIT + 5,
            }));
            expect(android?.devices).toHaveLength(DEVICE_BROKER_INVENTORY_DEVICE_LIMIT);

            const ios = body.result.backends.find((backend) => backend.stateKey === "ios");
            expect(ios).toEqual(expect.objectContaining({
                truncated: true,
                error: "inventory-file-too-large",
                maxBytes: DEVICE_BROKER_INVENTORY_FILE_LIMIT,
            }));
            expect(ios?.devices).toEqual([]);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
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

    it("plans lifecycle commands and dry-run invokes without provider execution", async () => {
        const ownerId = "5555666677778888";
        const commandRunner = vi.fn((command) => ({
            mode: command.mode,
            provider: command.provider,
            executable: command.executable,
            args: command.args,
            status: 0,
            pid: command.mode === "detached" ? 12345 : undefined,
            stdout: "started",
            stderr: "",
        }));
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-command-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { emulator: "/fake/emulator" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        try {
            writeBrokerDevices(ownerId, "android", [{ id: "android-owned", status: "stopped", backend: "android-emulator", avdName: "ccc-test-pixel", port: 5580 }]);

            const plan = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.plan",
                    params: { backend: "android-emulator", command: "device_start", deviceId: "android-owned" },
                }),
            });
            expect(plan.status).toBe(200);
            expect(await plan.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    ownerId,
                    backend: "android-emulator",
                    stateKey: "android",
                    command: "device_start",
                    deviceId: "android-owned",
                    execution: expect.objectContaining({
                        mode: "planned",
                        providerExecution: "available",
                        mutatesHost: false,
                    }),
                }),
            }));

            const invoke = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "android-emulator", command: "device_start", deviceId: "android-owned", dryRun: true },
                }),
            });
            expect(invoke.status).toBe(200);
            expect(await invoke.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    invoked: false,
                    dryRun: true,
                    execution: expect.objectContaining({ mode: "dry-run", mutatesHost: false }),
                }),
            }));

            const realInvoke = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "android-emulator", command: "device_start", deviceId: "android-owned", dryRun: false },
                }),
            });
            expect(realInvoke.status).toBe(200);
            expect(await realInvoke.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    invoked: true,
                    dryRun: false,
                    device: expect.objectContaining({ status: "running" }),
                    execution: expect.objectContaining({
                        mode: "detached",
                        providerExecution: "executed",
                        mutatesHost: true,
                        command: expect.objectContaining({
                            provider: "emulator",
                            executable: "/fake/emulator",
                            args: ["-avd", "ccc-test-pixel", "-port", "5580"],
                            pid: 12345,
                        }),
                    }),
                }),
            }));
            expect(commandRunner).toHaveBeenCalledWith(expect.objectContaining({
                mode: "detached",
                provider: "emulator",
                executable: "/fake/emulator",
                args: ["-avd", "ccc-test-pixel", "-port", "5580"],
            }), expect.objectContaining({ timeoutMs: 5000, outputLimit: 32768 }));
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("validates lifecycle command params and keeps plans owner scoped", async () => {
        const ownerA = "6666777788889999";
        const ownerB = "777788889999aaaa";
        const server = createDeviceBrokerServer({ cwd: "/project/broker-command-guard-test", host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        const endpointA = ownerRpcEndpoint(baseUrl, ownerA);
        const endpointB = ownerRpcEndpoint(baseUrl, ownerB);
        const headersA = ownerRpcHeaders(ownerA);
        const headersB = ownerRpcHeaders(ownerB);
        try {
            writeBrokerDevices(ownerA, "windows", [{ id: "win-owned", status: "stopped", backend: "windows-sandbox" }]);

            const foreignPlan = await fetch(endpointB, {
                method: "POST",
                headers: headersB,
                body: JSON.stringify({
                    method: "broker.command.plan",
                    params: { backend: "windows-sandbox", command: "device_delete", deviceId: "win-owned" },
                }),
            });
            expect(foreignPlan.status).toBe(404);
            expect(await foreignPlan.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "owner-device-not-found",
                ownerId: ownerB,
            }));

            const invalidBackend = await fetch(endpointA, {
                method: "POST",
                headers: headersA,
                body: JSON.stringify({
                    method: "broker.command.plan",
                    params: { backend: "unknown", command: "device_start", deviceId: "win-owned" },
                }),
            });
            expect(invalidBackend.status).toBe(400);
            expect(await invalidBackend.json()).toEqual(expect.objectContaining({ ok: false, error: "invalid-command-backend" }));

            const invalidCommand = await fetch(endpointA, {
                method: "POST",
                headers: headersA,
                body: JSON.stringify({
                    method: "broker.command.plan",
                    params: { backend: "windows-sandbox", command: "device_exec", deviceId: "win-owned" },
                }),
            });
            expect(invalidCommand.status).toBe(400);
            expect(await invalidCommand.json()).toEqual(expect.objectContaining({ ok: false, error: "unsupported-lifecycle-command" }));

            const invalidDeviceId = await fetch(endpointA, {
                method: "POST",
                headers: headersA,
                body: JSON.stringify({
                    method: "broker.command.plan",
                    params: { backend: "windows-sandbox", command: "device_start", deviceId: "../win-owned" },
                }),
            });
            expect(invalidDeviceId.status).toBe(400);
            expect(await invalidDeviceId.json()).toEqual(expect.objectContaining({ ok: false, error: "invalid-device-id" }));
        } finally {
            await close(server);
            cleanupOwner(ownerA);
            cleanupOwner(ownerB);
        }
    });

    it("builds provider command plans for each device backend and reports missing metadata", async () => {
        const ownerId = "88889999aaaabbbb";
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-provider-plan-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: {
                adb: "/fake/adb",
                xcrun: "/fake/xcrun",
                wsb: "/fake/wsb",
                tart: "/fake/tart",
            },
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        try {
            writeBrokerDevices(ownerId, "android-device", [{ id: "android-real", serial: "real-serial" }]);
            writeBrokerDevices(ownerId, "ios", [{ id: "ios-sim", udid: "SIM-UDID" }]);
            writeBrokerDevices(ownerId, "ios-device", [{ id: "ios-real", udid: "REAL-UDID" }]);
            writeBrokerDevices(ownerId, "windows", [{ id: "win", configPath: "C:/ccc/win.wsb" }]);
            writeBrokerDevices(ownerId, "macos", [
                { id: "mac", provider: "tart", providerInstance: "ccc-mac" },
                { id: "mac-missing", provider: "tart" },
                { id: "mac-unsafe", provider: "/tmp/unsafe-provider", providerInstance: "ccc-mac" },
            ]);

            const cases = [
                { backend: "android-device", command: "device_status", deviceId: "android-real", provider: "adb", args: ["-s", "real-serial", "get-state"] },
                { backend: "ios-simulator", command: "device_stop", deviceId: "ios-sim", provider: "xcrun", args: ["simctl", "shutdown", "SIM-UDID"] },
                { backend: "ios-device", command: "device_status", deviceId: "ios-real", provider: "xcrun", args: ["devicectl", "device", "info", "details", "--device", "REAL-UDID"] },
                { backend: "windows-sandbox", command: "device_start", deviceId: "win", provider: "wsb", args: ["start", "C:/ccc/win.wsb"] },
                { backend: "macos-vm", command: "device_stop", deviceId: "mac", provider: "tart", args: ["stop", "ccc-mac"] },
            ];
            for (const item of cases) {
                const response = await fetch(endpoint, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({ method: "broker.command.plan", params: item }),
                });
                expect(response.status).toBe(200);
                const body = await response.json() as { result: { providerCommand: { provider: string; executable: string; args: string[] } } };
                expect(body.result.providerCommand).toEqual(expect.objectContaining({
                    provider: item.provider,
                    executable: `/fake/${item.provider}`,
                    args: item.args,
                }));
            }

            const missing = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.plan",
                    params: { backend: "macos-vm", command: "device_start", deviceId: "android-real" },
                }),
            });
            expect(missing.status).toBe(404);
            expect(await missing.json()).toEqual(expect.objectContaining({ ok: false, error: "owner-device-not-found" }));

            const missingMetadata = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "macos-vm", command: "device_start", deviceId: "mac-missing", dryRun: false },
                }),
            });
            expect(missingMetadata.status).toBe(400);
            expect(await missingMetadata.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "missing-provider-metadata",
                missing: ["providerInstance"],
            }));

            const unsafeProvider = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "macos-vm", command: "device_start", deviceId: "mac-unsafe", dryRun: false },
                }),
            });
            expect(unsafeProvider.status).toBe(400);
            expect(await unsafeProvider.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "unsupported-provider-command",
                missing: ["provider"],
            }));
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("bounds default provider execution output, reports timeouts, and preserves state on failures", async () => {
        const ownerId = "9999aaaabbbbcccc";
        const ownerStateRoot = ownerRoot(ownerId);
        const windowsRoot = backendRoot(ownerId, "windows");
        const fakeWsb = join(ownerStateRoot, "fake-wsb");
        mkdirSync(windowsRoot, { recursive: true });
        writeFileSync(fakeWsb, [
            "#!/bin/sh",
            "case \"$2\" in",
            "  *slow*) sleep 1; exit 0 ;;",
            "  *loud*) head -c 40000 /dev/zero | tr \"\\0\" x; exit 7 ;;",
            "  *) echo provider failed >&2; exit 9 ;;",
            "esac",
            "",
        ].join("\n"));
        chmodSync(fakeWsb, 0o755);
        writeBrokerDevices(ownerId, "windows", [
            { id: "win-fail", backend: "windows-sandbox", status: "stopped", configPath: "C:/ccc/fail.wsb" },
            { id: "win-loud", backend: "windows-sandbox", status: "stopped", configPath: "C:/ccc/loud.wsb" },
            { id: "win-slow", backend: "windows-sandbox", status: "stopped", configPath: "C:/ccc/slow.wsb" },
        ]);

        const server = createDeviceBrokerServer({
            cwd: "/project/broker-provider-failure-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { wsb: fakeWsb },
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        try {
            const failed = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "windows-sandbox", command: "device_start", deviceId: "win-fail", dryRun: false },
                }),
            });
            expect(failed.status).toBe(502);
            expect(await failed.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "provider-command-failed",
                result: expect.objectContaining({
                    device: expect.objectContaining({ id: "win-fail", status: "stopped" }),
                    execution: expect.objectContaining({
                        mutatesHost: false,
                        command: expect.objectContaining({
                            status: 9,
                            stderr: expect.stringContaining("provider failed"),
                        }),
                    }),
                }),
            }));

            const loudServer = createDeviceBrokerServer({
                cwd: "/project/broker-provider-output-test",
                host: "127.0.0.1",
                port: 0,
                providerPaths: { wsb: fakeWsb },
            });
            const loudBaseUrl = await listen(loudServer);
            try {
                const loud = await fetch(`${loudBaseUrl}/v1/owners/${ownerId}/rpc`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({
                        method: "broker.command.invoke",
                        params: { backend: "windows-sandbox", command: "device_start", deviceId: "win-loud", dryRun: false },
                    }),
                });
                expect(loud.status).toBe(502);
                const loudBody = await loud.json() as { result: { execution: { command: { stdout: string; error?: string; timedOut?: boolean } } } };
                expect(loudBody.result.execution.command.stdout).toHaveLength(32768);
                expect(loudBody.result.execution.command.error).toContain("ENOBUFS");
                expect(loudBody.result.execution.command.timedOut).toBe(false);
            } finally {
                await close(loudServer);
            }

            const slowServer = createDeviceBrokerServer({
                cwd: "/project/broker-provider-timeout-test",
                host: "127.0.0.1",
                port: 0,
                providerPaths: { wsb: fakeWsb },
                commandTimeoutMs: 1,
            });
            const slowBaseUrl = await listen(slowServer);
            try {
                const timedOut = await fetch(`${slowBaseUrl}/v1/owners/${ownerId}/rpc`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({
                        method: "broker.command.invoke",
                        params: { backend: "windows-sandbox", command: "device_start", deviceId: "win-slow", dryRun: false },
                    }),
                });
                expect(timedOut.status).toBe(502);
                expect(await timedOut.json()).toEqual(expect.objectContaining({
                    ok: false,
                    error: "provider-command-failed",
                    result: expect.objectContaining({
                        execution: expect.objectContaining({
                            command: expect.objectContaining({ timedOut: true }),
                        }),
                    }),
                }));
            } finally {
                await close(slowServer);
            }

            const state = JSON.parse(readFileSync(join(windowsRoot, "devices.json"), "utf8")) as { devices: Array<{ id: string; status: string }> };
            expect(state.devices).toEqual(expect.arrayContaining([
                expect.objectContaining({ id: "win-fail", status: "stopped" }),
                expect.objectContaining({ id: "win-loud", status: "stopped" }),
                expect.objectContaining({ id: "win-slow", status: "stopped" }),
            ]));
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("reports detached provider startup failures before mutating owner state", async () => {
        const ownerId = "aaaabbbbccccdddd";
        const ownerStateRoot = ownerRoot(ownerId);
        const androidRoot = writeBrokerDevices(ownerId, "android", [{ id: "android-detached-missing", backend: "android-emulator", status: "stopped", avdName: "ccc-missing-provider", port: 5592 }]);
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-detached-failure-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { emulator: join(ownerStateRoot, "missing-emulator") },
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        try {
            const response = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "android-emulator", command: "device_start", deviceId: "android-detached-missing", dryRun: false },
                }),
            });
            expect(response.status).toBe(502);
            expect(await response.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "provider-command-failed",
                result: expect.objectContaining({
                    device: expect.objectContaining({ id: "android-detached-missing", status: "stopped" }),
                    execution: expect.objectContaining({
                        mode: "detached",
                        mutatesHost: false,
                        command: expect.objectContaining({
                            provider: "emulator",
                            error: "executable-not-found",
                            status: null,
                        }),
                    }),
                }),
            }));
            const state = JSON.parse(readFileSync(join(androidRoot, "devices.json"), "utf8")) as { devices: Array<{ id: string; status: string }> };
            expect(state.devices).toEqual([expect.objectContaining({ id: "android-detached-missing", status: "stopped" })]);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

});
