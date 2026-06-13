import { createHash } from "crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
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
import { cleanupOwner, close, listen, ownerRpcHeaders, writeBrokerDevices } from "./helpers/host-broker-test-fixture.js";

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

});
