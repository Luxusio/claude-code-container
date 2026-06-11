import { AddressInfo } from "net";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    createDeviceBrokerServer,
    DEVICE_BROKER_INVENTORY_DEVICE_LIMIT,
    DEVICE_BROKER_INVENTORY_FILE_LIMIT,
    deviceBrokerCli,
    deviceBrokerOwnerToken,
    deviceBrokerStatus,
    formatDeviceBrokerStatus,
    parseBrokerServeArgs,
    startDeviceBrokerServe,
} from "../device-lab-broker.js";
import { devicesCli } from "../device-lab-admin.js";

async function listen(server: ReturnType<typeof createDeviceBrokerServer>): Promise<string> {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
}

async function close(server: ReturnType<typeof createDeviceBrokerServer>): Promise<void> {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

describe("device-lab host broker daemon", () => {
    afterEach(() => {
        vi.restoreAllMocks();
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
            startupPolicy: expect.stringContaining("MCP auto-launch remains deferred"),
            implemented: expect.arrayContaining(["http-health", "http-status", "owner-state-path-reporting"]),
            deferred: expect.arrayContaining(["mcp-auto-launch", "mutating-backend-command-proxy", "strong-authentication-token-handshake"]),
        }));
        expect(status.ownerId).toMatch(/^[a-f0-9]{16}$/);
        expect(status.state.ownerRoot).toContain(status.ownerId);
        expect(status.state.locksRoot).toContain(".ccc/devices/broker/locks");
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
            expect(statusPayload.broker.deferred).toContain("mutating-backend-command-proxy");

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

    it("serves owner-scoped read-only RPC with deterministic local owner token", async () => {
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
            expect(statusBody.result.deferred).toContain("mutating-backend-command-proxy");
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
        try {
            const missingToken = await fetch(endpoint, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ method: "broker.echo" }),
            });
            expect(missingToken.status).toBe(401);
            expect(await missingToken.json()).toEqual(expect.objectContaining({ ok: false, error: "invalid-owner-token" }));

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
        const ownerRoot = join(homedir(), ".ccc/devices/owners", ownerId);
        const androidRoot = join(ownerRoot, "android");
        const iosRoot = join(ownerRoot, "ios");
        const server = createDeviceBrokerServer({ cwd: "/project/broker-inventory-bound-test", host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        try {
            mkdirSync(androidRoot, { recursive: true });
            mkdirSync(iosRoot, { recursive: true });
            writeFileSync(join(androidRoot, "devices.json"), JSON.stringify({
                devices: Array.from({ length: DEVICE_BROKER_INVENTORY_DEVICE_LIMIT + 5 }, (_, index) => ({ id: `android-${index}` })),
            }));
            writeFileSync(join(iosRoot, "devices.json"), JSON.stringify({
                devices: [{ id: "ios-large", payload: "x".repeat(DEVICE_BROKER_INVENTORY_FILE_LIMIT + 1) }],
            }));

            const response = await fetch(`${baseUrl}/v1/owners/${ownerId}/rpc`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-ccc-device-token": deviceBrokerOwnerToken(ownerId),
                },
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
            rmSync(ownerRoot, { recursive: true, force: true });
        }
    });

    it("formats broker status and routes through ccc devices broker status", () => {
        const direct = formatDeviceBrokerStatus({ cwd: "/project/broker-cli-test" });
        expect(direct).toContain("=== CCC Device Broker ===");
        expect(direct).toContain("mode: host-broker-daemon");
        expect(direct).toContain("deferred: mcp-auto-launch");

        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const exitCode = deviceBrokerCli(["status"], "/project/broker-cli-test");
        expect(exitCode).toBe(0);
        expect(log).toHaveBeenCalledWith(expect.stringContaining("=== CCC Device Broker ==="));

        log.mockClear();
        const routedExitCode = devicesCli(["broker", "status"], "/project/broker-cli-test");
        expect(routedExitCode).toBe(0);
        expect(log).toHaveBeenCalledWith(expect.stringContaining("mode: host-broker-daemon"));
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

    it("rejects unknown broker CLI subcommands", () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        expect(deviceBrokerCli(["unknown"], "/project/broker-cli-test")).toBe(1);
        expect(error).toHaveBeenCalledWith(expect.stringContaining("Usage: ccc devices broker"));
    });
});
