import { AddressInfo } from "net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    createDeviceBrokerServer,
    deviceBrokerCli,
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
            deferred: expect.arrayContaining(["mcp-auto-launch", "backend-command-proxy", "authentication-token-handshake"]),
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
            expect(statusPayload.broker.deferred).toContain("backend-command-proxy");

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
