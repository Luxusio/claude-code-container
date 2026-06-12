import { spawn } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createServer } from "http";
import { AddressInfo } from "net";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeviceBrokerServer } from "../device-lab-broker.js";
import {
    cleanupDeviceLabMcpTestContext,
    createDeviceLabMcpTestContext,
    repoRoot,
    TIMEOUT,
    type DeviceLabMcpTestContext,
} from "./helpers/device-lab-mcp-fixture.js";
import { freePort, installFakeCccBroker, installIgnoringCccBroker, pidAlive, waitForHealthUnavailable } from "./helpers/fake-broker-mcp-fixture.js";

describe("device-lab MCP", () => {
    let context: DeviceLabMcpTestContext;
    let client: DeviceLabMcpTestContext["client"];
    let homeDir: string;
    let pathDir: string;

    beforeAll(async () => {
        context = await createDeviceLabMcpTestContext();
        client = context.client;
        homeDir = context.homeDir;
        pathDir = context.pathDir;
    }, TIMEOUT);

    afterAll(async () => {
        await cleanupDeviceLabMcpTestContext(context);
    }, TIMEOUT);

    it("autolaunches, reuses, routes RPC/lease/command, and shuts down an MCP-owned broker", { timeout: TIMEOUT }, async () => {
        const port = await freePort();
        const logPath = join(homeDir, "fake-ccc-broker.log");
        installFakeCccBroker(pathDir, logPath);

        const first = await client.callTool({
            name: "device_broker_rpc",
            arguments: {
                method: "broker.echo",
                params: { hello: "broker" },
                autolaunch: true,
                hostCandidates: ["127.0.0.1"],
                port,
                timeoutMs: 300,
                launchTimeoutMs: 3000,
            },
        });
        expect(first.isError).not.toBe(true);
        const firstPayload = JSON.parse(((first.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ok: boolean;
            result: { echo: { hello: string } };
            launch: { launched: boolean; reused: boolean; runtime: { pid: number; ownerId: string; logPath: string; command: string; args: string[] } };
        };
        expect(firstPayload.ok).toBe(true);
        expect(firstPayload.result.echo).toEqual({ hello: "broker" });
        expect(firstPayload.launch).toEqual(expect.objectContaining({ launched: true, reused: false }));
        expect(firstPayload.launch.runtime).toEqual(expect.objectContaining({
            pid: expect.any(Number),
            ownerId: expect.stringMatching(/^[a-f0-9]{16}$/),
            logPath: expect.stringContaining("broker-"),
            command: "ccc",
            args: ["devices", "broker", "serve", "--host", "127.0.0.1", "--port", String(port)],
        }));

        const status = await client.callTool({
            name: "device_broker_status",
            arguments: { probe: true, hostCandidates: ["127.0.0.1"], port, timeoutMs: 300 },
        });
        const statusPayload = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            available: boolean;
            runtime: { pid: number; port: number; managedBy: string };
            state: { runtimeFile: string };
        };
        expect(statusPayload.available).toBe(true);
        expect(statusPayload.runtime).toEqual(expect.objectContaining({
            pid: firstPayload.launch.runtime.pid,
            port,
            managedBy: "device-lab-mcp",
        }));
        expect(existsSync(statusPayload.state.runtimeFile)).toBe(true);

        const second = await client.callTool({
            name: "device_broker_rpc",
            arguments: {
                method: "broker.echo",
                params: { reuse: true },
                autolaunch: true,
                hostCandidates: ["127.0.0.1"],
                port,
                timeoutMs: 300,
                launchTimeoutMs: 3000,
            },
        });
        const secondPayload = JSON.parse(((second.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ok: boolean;
            launch: { launched: boolean; reused: boolean };
        };
        expect(secondPayload.ok).toBe(true);
        expect(secondPayload.launch).toEqual(expect.objectContaining({ launched: false, reused: true }));
        let brokerLog = readFileSync(logPath, "utf8");
        expect(brokerLog.trim().split("\n").filter((line) => line.startsWith("[\"devices\",\"broker\",\"serve\""))).toHaveLength(1);
        expect(brokerLog).toContain(`auth-ok ${firstPayload.launch.runtime.ownerId}`);

        const lease = await client.callTool({
            name: "device_broker_lease",
            arguments: { action: "list", backend: "android-device", autolaunch: true, hostCandidates: ["127.0.0.1"], port, timeoutMs: 300 },
        });
        expect(JSON.parse(((lease.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: true,
            result: expect.objectContaining({ backend: "android-device", leases: [] }),
        }));

        const attach = await client.callTool({
            name: "device_broker_attach",
            arguments: {
                action: "attach",
                backend: "android-device",
                deviceId: "android-broker-real",
                serial: "USB123",
                connection: "usb",
                autolaunch: true,
                hostCandidates: ["127.0.0.1"],
                port,
                timeoutMs: 300,
            },
        });
        expect(JSON.parse(((attach.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: true,
            result: expect.objectContaining({
                device: expect.objectContaining({ id: "android-broker-real", backend: "android-device", serial: "USB123" }),
            }),
        }));

        const attachList = await client.callTool({
            name: "device_broker_attach",
            arguments: { action: "list", backend: "android-device", autolaunch: true, hostCandidates: ["127.0.0.1"], port, timeoutMs: 300 },
        });
        expect(JSON.parse(((attachList.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: true,
            result: expect.objectContaining({ backend: "android-device", devices: [], leases: [] }),
        }));

        const detach = await client.callTool({
            name: "device_broker_attach",
            arguments: { action: "detach", backend: "android-device", deviceId: "android-broker-real", autolaunch: true, hostCandidates: ["127.0.0.1"], port, timeoutMs: 300 },
        });
        expect(JSON.parse(((detach.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: true,
            result: expect.objectContaining({ detached: "android-broker-real", physicalDevicePoweredOff: false }),
        }));

        const command = await client.callTool({
            name: "device_broker_command",
            arguments: {
                action: "plan",
                backend: "windows-sandbox",
                command: "device_start",
                deviceId: "win-autolaunch",
                autolaunch: true,
                hostCandidates: ["127.0.0.1"],
                port,
                timeoutMs: 300,
            },
        });
        expect(JSON.parse(((command.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: true,
            result: expect.objectContaining({
                backend: "windows-sandbox",
                deviceId: "win-autolaunch",
                execution: expect.objectContaining({ mode: "planned" }),
            }),
        }));

        mkdirSync(join(homeDir, ".ccc/devices/owners", firstPayload.launch.runtime.ownerId, "windows"), { recursive: true });
        writeFileSync(join(homeDir, ".ccc/devices/owners", firstPayload.launch.runtime.ownerId, "windows", "devices.json"), JSON.stringify({
            devices: [{ id: "win-autolaunch", backend: "windows-sandbox", status: "stopped", configPath: "C:/ccc/win-autolaunch.wsb" }],
        }));
        const lifecycleStart = await client.callTool({
            name: "device_start",
            arguments: {
                deviceId: "win-autolaunch",
                autolaunch: true,
                hostCandidates: ["127.0.0.1"],
                port,
                timeoutMs: 300,
            },
        });
        expect(JSON.parse(((lifecycleStart.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: true,
            result: expect.objectContaining({
                backend: "windows-sandbox",
                command: "device_start",
                deviceId: "win-autolaunch",
                invoked: true,
                execution: expect.objectContaining({ mode: "exec", providerExecution: "fake" }),
            }),
        }));

        const shutdown = await client.callTool({ name: "device_broker_shutdown", arguments: {} });
        expect(JSON.parse(((shutdown.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: true,
            stopped: true,
            runtime: expect.objectContaining({ pid: firstPayload.launch.runtime.pid }),
        }));
        expect(existsSync(statusPayload.state.runtimeFile)).toBe(false);
        brokerLog = readFileSync(logPath, "utf8");
        expect(brokerLog).toContain(`auth-ok ${firstPayload.launch.runtime.ownerId}`);
        rmSync(join(homeDir, ".ccc/devices/owners", firstPayload.launch.runtime.ownerId, "windows"), { recursive: true, force: true });
    });

    it("preserves runtime metadata when explicit broker shutdown times out", { timeout: TIMEOUT }, async () => {
        const port = await freePort();
        const logPath = join(homeDir, "fake-ccc-broker-ignore.log");
        installIgnoringCccBroker(pathDir, logPath);
        const launched = await client.callTool({
            name: "device_broker_rpc",
            arguments: {
                method: "broker.echo",
                autolaunch: true,
                hostCandidates: ["127.0.0.1"],
                port,
                timeoutMs: 300,
                launchTimeoutMs: 3000,
            },
        });
        const launchedPayload = JSON.parse(((launched.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ok: boolean;
            launch: { runtime: { pid: number } };
        };
        expect(launchedPayload.ok).toBe(true);
        const status = await client.callTool({
            name: "device_broker_status",
            arguments: { probe: true, hostCandidates: ["127.0.0.1"], port, timeoutMs: 300 },
        });
        const statusPayload = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}")) as { state: { runtimeFile: string } };

        const shutdown = await client.callTool({ name: "device_broker_shutdown", arguments: {} });
        expect(JSON.parse(((shutdown.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: false,
            error: "broker-shutdown-timeout",
            stopped: false,
            runtime: expect.objectContaining({ pid: launchedPayload.launch.runtime.pid }),
        }));
        expect(existsSync(statusPayload.state.runtimeFile)).toBe(true);
        process.kill(launchedPayload.launch.runtime.pid, "SIGKILL");
        rmSync(statusPayload.state.runtimeFile, { force: true });
    });

    it("cleans an MCP-owned broker child on MCP process SIGTERM", { timeout: TIMEOUT }, async () => {
        const signalHome = mkdtempSync(join(tmpdir(), "ccc-device-lab-signal-"));
        const signalBin = join(signalHome, "bin");
        mkdirSync(signalBin, { recursive: true });
        const port = await freePort();
        const fakeCcc = join(signalBin, "ccc");
        writeFileSync(fakeCcc, `#!${process.execPath}
const http = require("http");
const args = process.argv.slice(2);
const host = args[args.indexOf("--host") + 1] || "127.0.0.1";
const port = Number(args[args.indexOf("--port") + 1] || 17373);
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  if (req.url === "/health") return res.end(JSON.stringify({ ok: true, name: "ccc-device-broker" }));
  res.end(JSON.stringify({ ok: true, result: {} }));
});
server.listen(port, host);
process.on("SIGTERM", () => {});
`);
        chmodSync(fakeCcc, 0o755);
        const script = join(signalHome, "launch-broker.mjs");
        writeFileSync(script, `
import { brokerRpc } from ${JSON.stringify(join(repoRoot, "device-lab-mcp/src/broker.mjs"))};
const result = await brokerRpc({ method: "broker.echo", autolaunch: true, hostCandidates: ["127.0.0.1"], port: ${port}, timeoutMs: 300, launchTimeoutMs: 3000 });
process.stdout.write(JSON.stringify(result.launch.runtime) + "\\n");
setInterval(() => {}, 1000);
`);
        const child = spawn(process.execPath, [script], {
            cwd: repoRoot,
            env: { ...process.env, HOME: signalHome, PATH: signalBin },
            stdio: ["ignore", "pipe", "pipe"],
        });
        try {
            let stdout = "";
            const runtime = await new Promise<{ pid: number }>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`timeout waiting for signal child stdout: ${stdout}`)), 5000);
                child.stdout?.on("data", (chunk) => {
                    stdout += chunk.toString();
                    const line = stdout.trim().split("\n").find(Boolean);
                    if (line) {
                        clearTimeout(timer);
                        resolve(JSON.parse(line));
                    }
                });
                child.once("error", reject);
                child.once("exit", (code) => {
                    if (!stdout.trim()) {
                        clearTimeout(timer);
                        reject(new Error(`signal child exited before reporting runtime: ${code}`));
                    }
                });
            });
            expect(pidAlive(runtime.pid)).toBe(true);
            child.kill("SIGTERM");
            await new Promise<void>((resolve) => child.once("exit", () => resolve()));
            expect(await waitForHealthUnavailable(port)).toBe(true);
            expect(existsSync(join(signalHome, ".ccc/devices/broker/runtime.json"))).toBe(false);
        } finally {
            if (child.exitCode === null) child.kill("SIGKILL");
            rmSync(signalHome, { recursive: true, force: true });
        }
    });

    it("cleans stale broker runtime metadata and reports launch failures", { timeout: TIMEOUT }, async () => {
        const status = await client.callTool({ name: "device_broker_status", arguments: {} });
        const statusPayload = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ownerId: string;
            state: { runtimeFile: string };
        };
        mkdirSync(join(homeDir, ".ccc/devices/broker"), { recursive: true });
        writeFileSync(statusPayload.state.runtimeFile, JSON.stringify({
            ownerId: statusPayload.ownerId,
            pid: 99999999,
            host: "127.0.0.1",
            port: 65530,
            managedBy: "device-lab-mcp",
        }));
        rmSync(join(pathDir, "ccc"), { force: true });
        const result = await client.callTool({
            name: "device_broker_rpc",
            arguments: {
                method: "broker.echo",
                autolaunch: true,
                hostCandidates: ["127.0.0.1"],
                port: 65530,
                timeoutMs: 20,
                launchTimeoutMs: 50,
            },
        });
        expect(result.isError).not.toBe(true);
        const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ok: boolean;
            error: string;
            launch: { error: string; attempts: Array<{ reason?: string }> };
        };
        expect(payload.ok).toBe(false);
        expect(payload.error).toBe("broker-launch-failed");
        expect(payload.launch.error).toBe("broker-launch-failed");
        expect(payload.launch.attempts).toEqual(expect.arrayContaining([
            expect.objectContaining({ reason: "runtime-pid-not-alive" }),
        ]));
        expect(existsSync(statusPayload.state.runtimeFile)).toBe(false);
    });

    it("refuses to autolaunch over another owner's broker runtime metadata", { timeout: TIMEOUT }, async () => {
        const status = await client.callTool({ name: "device_broker_status", arguments: {} });
        const statusPayload = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            state: { runtimeFile: string };
        };
        mkdirSync(join(homeDir, ".ccc/devices/broker"), { recursive: true });
        const foreignRuntime = {
            ownerId: "0000000000000000",
            pid: 99999999,
            host: "127.0.0.1",
            port: 65529,
            managedBy: "device-lab-mcp",
        };
        writeFileSync(statusPayload.state.runtimeFile, JSON.stringify(foreignRuntime));
        const result = await client.callTool({
            name: "device_broker_rpc",
            arguments: {
                method: "broker.echo",
                autolaunch: true,
                hostCandidates: ["127.0.0.1"],
                port: 65529,
                timeoutMs: 20,
                launchTimeoutMs: 50,
            },
        });
        const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ok: boolean;
            error: string;
            launch: { error: string; runtime: { ownerId: string } };
        };
        expect(payload.ok).toBe(false);
        expect(payload.error).toBe("runtime-owned-by-another-owner");
        expect(payload.launch).toEqual(expect.objectContaining({
            error: "runtime-owned-by-another-owner",
            runtime: expect.objectContaining({ ownerId: "0000000000000000" }),
        }));
        expect(JSON.parse(readFileSync(statusPayload.state.runtimeFile, "utf8"))).toEqual(foreignRuntime);
        rmSync(statusPayload.state.runtimeFile, { force: true });
    });

    it("refuses to shut down broker runtime metadata not managed by device-lab-mcp", { timeout: TIMEOUT }, async () => {
        const status = await client.callTool({ name: "device_broker_status", arguments: {} });
        const statusPayload = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ownerId: string;
            state: { runtimeFile: string };
        };
        mkdirSync(join(homeDir, ".ccc/devices/broker"), { recursive: true });
        const unmanagedRuntime = {
            ownerId: statusPayload.ownerId,
            pid: 99999999,
            host: "127.0.0.1",
            port: 65528,
            managedBy: "external-service-manager",
        };
        writeFileSync(statusPayload.state.runtimeFile, JSON.stringify(unmanagedRuntime));
        const shutdown = await client.callTool({ name: "device_broker_shutdown", arguments: {} });
        expect(JSON.parse(((shutdown.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: false,
            error: "runtime-not-managed-by-device-lab-mcp",
            runtime: expect.objectContaining({ managedBy: "external-service-manager" }),
        }));
        expect(JSON.parse(readFileSync(statusPayload.state.runtimeFile, "utf8"))).toEqual(unmanagedRuntime);
        rmSync(statusPayload.state.runtimeFile, { force: true });
    });

    it("clamps explicit broker probe candidate count and timeout", { timeout: TIMEOUT }, async () => {
        const candidates = Array.from({ length: 12 }, (_, index) => `127.0.0.${index + 1}`);
        const result = await client.callTool({
            name: "device_broker_status",
            arguments: { probe: false, hostCandidates: candidates, timeoutMs: 999999 },
        });
        expect(result.isError).not.toBe(true);
        const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            transport: { hostCandidates: string[]; probeTimeoutMs: number; maxProbeCandidates: number; maxProbeTimeoutMs: number };
        };
        expect(payload.transport.hostCandidates).toHaveLength(8);
        expect(payload.transport.hostCandidates).toEqual(candidates.slice(0, 8));
        expect(payload.transport.probeTimeoutMs).toBe(2000);
        expect(payload.transport.maxProbeCandidates).toBe(8);
        expect(payload.transport.maxProbeTimeoutMs).toBe(2000);
    });

    it("probes an explicitly requested running broker health endpoint without auto-starting one", { timeout: TIMEOUT }, async () => {
        const server = createServer((req, res) => {
            if (req.url === "/health") {
                const body = JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" });
                res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
                res.end(body);
                return;
            }
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false }));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        try {
            const result = await client.callTool({
                name: "device_broker_status",
                arguments: { probe: true, hostCandidates: ["127.0.0.1"], port: address.port, timeoutMs: 500 },
            });
            expect(result.isError).not.toBe(true);
            const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                mode: string;
                available: boolean;
                probe: { requested: boolean; available: boolean; selected: { endpoint: string; status: number; body: { ok: boolean; name: string } }; attempts: Array<{ ok: boolean }> };
                implemented: string[];
                deferred: string[];
            };
            expect(payload.mode).toBe("host-broker-detected");
            expect(payload.available).toBe(true);
            expect(payload.probe.requested).toBe(true);
            expect(payload.probe.available).toBe(true);
            expect(payload.probe.selected).toEqual(expect.objectContaining({
                endpoint: `http://127.0.0.1:${address.port}/health`,
                status: 200,
                body: expect.objectContaining({ ok: true, name: "ccc-device-broker" }),
            }));
            expect(payload.probe.attempts).toHaveLength(1);
            expect(payload.implemented).toContain("broker health probe");
            expect(payload.deferred).not.toContain("broker health probe");
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("reports bounded broker probe failures as diagnostics", { timeout: TIMEOUT }, async () => {
        const server = createServer((_req, res) => {
            const body = JSON.stringify({ ok: false });
            res.writeHead(503, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
            res.end(body);
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        try {
            const result = await client.callTool({
                name: "device_broker_status",
                arguments: { probe: true, hostCandidates: ["127.0.0.1"], port: address.port, timeoutMs: 500 },
            });
            expect(result.isError).not.toBe(true);
            const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                mode: string;
                available: boolean;
                probe: { requested: boolean; available: boolean; selected: null; attempts: Array<{ ok: boolean; status: number }> };
            };
            expect(payload.mode).toBe("direct-provider");
            expect(payload.available).toBe(false);
            expect(payload.probe).toEqual(expect.objectContaining({
                requested: true,
                available: false,
                selected: null,
            }));
            expect(payload.probe.attempts).toEqual([
                expect.objectContaining({ ok: false, status: 503 }),
            ]);
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("calls an explicitly supplied host broker RPC endpoint with owner token guard", { timeout: TIMEOUT }, async () => {
        const server = createDeviceBrokerServer({
            cwd: repoRoot,
            host: "127.0.0.1",
            port: 0,
            startedAt: "2026-01-01T00:00:00.000Z",
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        try {
            const result = await client.callTool({
                name: "device_broker_rpc",
                arguments: {
                    method: "broker.echo",
                    params: { wifiRealDevice: true },
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(result.isError).not.toBe(true);
            const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                ok: boolean;
                ownerId: string;
                method: string;
                selected: { endpoint: string; status: number; body: { ok: boolean } };
                result: { ownerId: string; params: { wifiRealDevice: boolean } };
                attempts: Array<{ ok: boolean; status: number }>;
            };
            expect(payload.ok).toBe(true);
            expect(payload.ownerId).toMatch(/^[a-f0-9]{16}$/);
            expect(payload.method).toBe("broker.echo");
            expect(payload.selected).toEqual(expect.objectContaining({
                endpoint: `http://127.0.0.1:${address.port}/v1/owners/${payload.ownerId}/rpc`,
                status: 200,
                body: expect.objectContaining({ ok: true }),
            }));
            expect(payload.result).toEqual({
                ownerId: payload.ownerId,
                params: { wifiRealDevice: true },
            });
            expect(payload.attempts).toEqual([expect.objectContaining({ ok: true, status: 200 })]);
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("reports broker RPC failures as structured diagnostics without starting a broker", { timeout: TIMEOUT }, async () => {
        const unavailable = await client.callTool({
            name: "device_broker_rpc",
            arguments: {
                method: "broker.echo",
                hostCandidates: ["127.0.0.1"],
                port: 9,
                timeoutMs: 50,
            },
        });
        expect(unavailable.isError).not.toBe(true);
        const unavailablePayload = JSON.parse(((unavailable.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ok: boolean;
            error: string;
            attempts: Array<{ ok: boolean; status: null; error: string }>;
        };
        expect(unavailablePayload.ok).toBe(false);
        expect(unavailablePayload.error).toBe("broker-rpc-unavailable");
        expect(unavailablePayload.attempts).toEqual([expect.objectContaining({ ok: false, status: null })]);

        const tooLarge = await client.callTool({
            name: "device_broker_rpc",
            arguments: {
                method: "broker.echo",
                params: { payload: "x".repeat(70 * 1024) },
                hostCandidates: ["127.0.0.1"],
                port: 9,
                timeoutMs: 50,
            },
        });
        expect(tooLarge.isError).not.toBe(true);
        expect(JSON.parse(((tooLarge.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: false,
            error: "request-too-large",
            attempts: [],
        }));

        const unsupportedLeaseRpc = await client.callTool({
            name: "device_broker_rpc",
            arguments: {
                method: "broker.lease.claim",
                params: { backend: "android-device", hardwareId: "x" },
                hostCandidates: ["127.0.0.1"],
                port: 9,
                timeoutMs: 50,
            },
        });
        expect(unsupportedLeaseRpc.isError).not.toBe(true);
        expect(JSON.parse(((unsupportedLeaseRpc.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: false,
            error: "unsupported-public-broker-rpc-method",
            attempts: [],
        }));
    });

    it("claims, lists, and releases a physical lease through an explicitly supplied host broker", { timeout: TIMEOUT }, async () => {
        const server = createDeviceBrokerServer({
            cwd: repoRoot,
            host: "127.0.0.1",
            port: 0,
            startedAt: "2026-01-01T00:00:00.000Z",
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        try {
            const claim = await client.callTool({
                name: "device_broker_lease",
                arguments: {
                    action: "claim",
                    backend: "android-device",
                    hardwareId: "10.0.0.8:5555",
                    deviceId: "android-wifi-phone",
                    connection: "wifi",
                    transport: { host: "10.0.0.8", port: 5555 },
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(claim.isError).not.toBe(true);
            const claimPayload = JSON.parse(((claim.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                ok: boolean;
                result: { lease: { ownerId: string; backend: string; hardwareId: string; connection: string; transport: { host: string; port: number } }; created: boolean };
            };
            expect(claimPayload.ok).toBe(true);
            expect(claimPayload.result).toEqual(expect.objectContaining({
                created: true,
                lease: expect.objectContaining({
                    backend: "android-device",
                    hardwareId: "10.0.0.8:5555",
                    connection: "wifi",
                    transport: { host: "10.0.0.8", port: 5555 },
                }),
            }));

            const list = await client.callTool({
                name: "device_broker_lease",
                arguments: {
                    action: "list",
                    backend: "android-device",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(list.isError).not.toBe(true);
            const listPayload = JSON.parse(((list.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                ok: boolean;
                result: { leases: Array<{ hardwareId: string }> };
            };
            expect(listPayload.ok).toBe(true);
            expect(listPayload.result.leases).toEqual([expect.objectContaining({ hardwareId: "10.0.0.8:5555" })]);

            const release = await client.callTool({
                name: "device_broker_lease",
                arguments: {
                    action: "release",
                    backend: "android-device",
                    hardwareId: "10.0.0.8:5555",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(release.isError).not.toBe(true);
            expect(JSON.parse(((release.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({ released: true }),
            }));
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            rmSync(join(homedir(), ".ccc/devices/physical-leases/android-device/locks", `${encodeURIComponent("10.0.0.8:5555")}.json`), { force: true });
        }
    });

    it("attaches and detaches physical devices through an explicitly supplied host broker", { timeout: TIMEOUT }, async () => {
        const commandRunner = vi.fn((command) => {
            if (command.provider === "adb" && command.args?.[0] === "connect") {
                return { mode: "exec", provider: "adb", executable: command.executable, args: command.args, status: 0, stdout: `connected to ${command.args[1]}`, stderr: "" };
            }
            if (command.provider === "adb" && command.args?.join(" ") === "devices -l") {
                return { mode: "exec", provider: "adb", executable: command.executable, args: command.args, status: 0, stdout: "List of devices attached\n10.0.0.10:5555 device product:pixel model:Pixel_Real\n", stderr: "" };
            }
            if (command.provider === "xcrun") {
                return { mode: "exec", provider: "xcrun", executable: command.executable, args: command.args, status: 0, stdout: "== Devices ==\nBroker Network iPhone (17.5) (00008130-00AA00BB00CC00EE) (Network)\n", stderr: "" };
            }
            return { mode: "exec", provider: command.provider, executable: command.executable, args: command.args, status: 1, stdout: "", stderr: "unexpected" };
        });
        const server = createDeviceBrokerServer({
            cwd: repoRoot,
            host: "127.0.0.1",
            port: 0,
            startedAt: "2026-01-01T00:00:00.000Z",
            providerPaths: { adb: "/fake/adb", xcrun: "/fake/xcrun" },
            commandRunner,
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        try {
            const androidAttach = await client.callTool({
                name: "device_broker_attach",
                arguments: {
                    action: "attach",
                    backend: "android-device",
                    deviceId: "android-broker-wifi",
                    name: "Broker WiFi Pixel",
                    connection: "wifi",
                    host: "10.0.0.10",
                    devicePort: 5555,
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(androidAttach.isError).not.toBe(true);
            expect(JSON.parse(((androidAttach.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    device: expect.objectContaining({
                        id: "android-broker-wifi",
                        serial: "10.0.0.10:5555",
                        connection: "wifi",
                    }),
                }),
            }));

            const iosAttach = await client.callTool({
                name: "device_broker_attach",
                arguments: {
                    action: "attach",
                    backend: "ios-device",
                    deviceId: "ios-broker-wifi",
                    connection: "wifi",
                    udid: "00008130-00AA00BB00CC00EE",
                    host: "network-iphone.local",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(JSON.parse(((iosAttach.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    device: expect.objectContaining({
                        id: "ios-broker-wifi",
                        udid: "00008130-00AA00BB00CC00EE",
                        connection: "wifi",
                    }),
                }),
            }));

            const list = await client.callTool({
                name: "device_broker_attach",
                arguments: { action: "list", backend: "android-device", hostCandidates: ["127.0.0.1"], port: address.port, timeoutMs: 500 },
            });
            expect(JSON.parse(((list.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({ devices: [expect.objectContaining({ id: "android-broker-wifi" })] }),
            }));

            const detach = await client.callTool({
                name: "device_broker_attach",
                arguments: { action: "detach", backend: "android-device", deviceId: "android-broker-wifi", hostCandidates: ["127.0.0.1"], port: address.port, timeoutMs: 500 },
            });
            expect(JSON.parse(((detach.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({ detached: "android-broker-wifi", physicalDevicePoweredOff: false }),
            }));
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            rmSync(join(homedir(), ".ccc/devices/physical-leases/android-device/locks", `${encodeURIComponent("10.0.0.10:5555")}.json`), { force: true });
            rmSync(join(homedir(), ".ccc/devices/physical-leases/ios-device/locks", `${encodeURIComponent("00008130-00AA00BB00CC00EE")}.json`), { force: true });
        }
    });

    it("reports broker lease validation and unavailable broker failures without autolaunch", { timeout: TIMEOUT }, async () => {
        const invalidAction = await client.callTool({
            name: "device_broker_lease",
            arguments: { action: "steal", backend: "android-device" },
        });
        expect(invalidAction.isError).not.toBe(true);
        expect(JSON.parse(((invalidAction.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: false,
            error: "invalid-lease-action",
            attempts: [],
        }));

        const unavailable = await client.callTool({
            name: "device_broker_lease",
            arguments: {
                action: "list",
                backend: "ios-device",
                hostCandidates: ["127.0.0.1"],
                port: 9,
                timeoutMs: 50,
            },
        });
        expect(unavailable.isError).not.toBe(true);
        expect(JSON.parse(((unavailable.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: false,
            error: "broker-rpc-unavailable",
            attempts: [expect.objectContaining({ ok: false, status: null })],
        }));
    });

    it("preserves live broker lease errors at the top level", { timeout: TIMEOUT }, async () => {
        const server = createDeviceBrokerServer({
            cwd: repoRoot,
            host: "127.0.0.1",
            port: 0,
            startedAt: "2026-01-01T00:00:00.000Z",
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        const serial = "10.0.0.9:5555";
        try {
            const claim = await client.callTool({
                name: "device_broker_lease",
                arguments: {
                    action: "claim",
                    backend: "android-device",
                    hardwareId: serial,
                    deviceId: "owner-device",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(claim.isError).not.toBe(true);
            expect(JSON.parse(((claim.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({ ok: true }));

            const duplicate = await client.callTool({
                name: "device_broker_lease",
                arguments: {
                    action: "release",
                    backend: "android-device",
                    hardwareId: serial,
                    deviceId: "different-device",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(duplicate.isError).not.toBe(true);
            expect(JSON.parse(((duplicate.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: false,
                error: "physical-lease-device-mismatch",
                status: 409,
                selected: expect.objectContaining({ status: 409 }),
            }));

            const invalid = await client.callTool({
                name: "device_broker_lease",
                arguments: {
                    action: "claim",
                    backend: "android-device",
                    hardwareId: "",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(invalid.isError).not.toBe(true);
            expect(JSON.parse(((invalid.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: false,
                error: "invalid-hardware-id",
                status: 400,
                selected: expect.objectContaining({ status: 400 }),
            }));
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            rmSync(join(homedir(), ".ccc/devices/physical-leases/android-device/locks", `${encodeURIComponent(serial)}.json`), { force: true });
        }
    });

    it("plans and dry-runs lifecycle commands through an explicitly supplied host broker", { timeout: TIMEOUT }, async () => {
        const status = await client.callTool({ name: "device_broker_status", arguments: {} });
        const owner = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}")) as { ownerId: string };
        const ownerRoot = join(homedir(), ".ccc/devices/owners", owner.ownerId);
        const fakeWsb = join(homeDir, "fake-wsb");
        writeFileSync(fakeWsb, "#!/bin/sh\ncase \"$2\" in\n  *fail*) echo broker failure >&2; exit 7 ;;\n  *) echo wsb \"$@\"; exit 0 ;;\nesac\n");
        chmodSync(fakeWsb, 0o755);
        mkdirSync(join(ownerRoot, "windows"), { recursive: true });
        writeFileSync(join(ownerRoot, "windows", "devices.json"), JSON.stringify({
            devices: [
                { id: "win-broker-plan", backend: "windows-sandbox", status: "stopped", configPath: "C:/ccc/win-broker-plan.wsb" },
                { id: "win-broker-fail", backend: "windows-sandbox", status: "stopped", configPath: "C:/ccc/fail.wsb" },
                { id: "win-broker-missing", backend: "windows-sandbox", status: "stopped" },
            ],
        }));
        const server = createDeviceBrokerServer({
            cwd: repoRoot,
            host: "127.0.0.1",
            port: 0,
            startedAt: "2026-01-01T00:00:00.000Z",
            providerPaths: { wsb: fakeWsb },
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        try {
            const plan = await client.callTool({
                name: "device_broker_command",
                arguments: {
                    action: "plan",
                    backend: "windows-sandbox",
                    command: "device_start",
                    deviceId: "win-broker-plan",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(plan.isError).not.toBe(true);
            expect(JSON.parse(((plan.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    ownerId: owner.ownerId,
                    backend: "windows-sandbox",
                    command: "device_start",
                    deviceId: "win-broker-plan",
                    execution: expect.objectContaining({ mode: "planned", providerExecution: "available" }),
                }),
            }));

            const dryRun = await client.callTool({
                name: "device_broker_command",
                arguments: {
                    action: "invoke",
                    backend: "windows-sandbox",
                    command: "device_start",
                    deviceId: "win-broker-plan",
                    dryRun: true,
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(dryRun.isError).not.toBe(true);
            expect(JSON.parse(((dryRun.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    invoked: false,
                    dryRun: true,
                    execution: expect.objectContaining({ mode: "dry-run", mutatesHost: false }),
                }),
            }));

            const realRun = await client.callTool({
                name: "device_broker_command",
                arguments: {
                    action: "invoke",
                    backend: "windows-sandbox",
                    command: "device_start",
                    deviceId: "win-broker-plan",
                    dryRun: false,
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(realRun.isError).not.toBe(true);
            expect(JSON.parse(((realRun.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    invoked: true,
                    dryRun: false,
                    device: expect.objectContaining({ status: "running" }),
                    execution: expect.objectContaining({
                        mode: "exec",
                        providerExecution: "executed",
                        mutatesHost: true,
                        command: expect.objectContaining({
                            provider: "wsb",
                            executable: fakeWsb,
                            args: ["start", "C:/ccc/win-broker-plan.wsb"],
                            status: 0,
                            stdout: expect.stringContaining("wsb start C:/ccc/win-broker-plan.wsb"),
                        }),
                    }),
                }),
            }));

            const lifecycleStatus = await client.callTool({
                name: "device_status",
                arguments: {
                    deviceId: "win-broker-plan",
                    backend: "windows-sandbox",
                    broker: true,
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(lifecycleStatus.isError).not.toBe(true);
            expect(JSON.parse(((lifecycleStatus.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    backend: "windows-sandbox",
                    command: "device_status",
                    deviceId: "win-broker-plan",
                    invoked: true,
                    execution: expect.objectContaining({
                        mode: "noop",
                        providerExecution: "executed",
                        mutatesHost: false,
                    }),
                }),
            }));

            const lifecycleStop = await client.callTool({
                name: "device_stop",
                arguments: {
                    deviceId: "win-broker-plan",
                    backend: "windows-sandbox",
                    viaBroker: true,
                    dryRun: true,
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(lifecycleStop.isError).not.toBe(true);
            expect(JSON.parse(((lifecycleStop.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    backend: "windows-sandbox",
                    command: "device_stop",
                    invoked: false,
                    dryRun: true,
                    execution: expect.objectContaining({ mode: "dry-run", mutatesHost: false }),
                }),
            }));

            const failedRun = await client.callTool({
                name: "device_broker_command",
                arguments: {
                    action: "invoke",
                    backend: "windows-sandbox",
                    command: "device_start",
                    deviceId: "win-broker-fail",
                    dryRun: false,
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(failedRun.isError).not.toBe(true);
            expect(JSON.parse(((failedRun.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: false,
                error: "provider-command-failed",
                status: 502,
                result: expect.objectContaining({
                    device: expect.objectContaining({ id: "win-broker-fail", status: "stopped" }),
                    execution: expect.objectContaining({
                        command: expect.objectContaining({
                            status: 7,
                            stderr: expect.stringContaining("broker failure"),
                        }),
                    }),
                }),
            }));

            const missingMetadata = await client.callTool({
                name: "device_broker_command",
                arguments: {
                    action: "invoke",
                    backend: "windows-sandbox",
                    command: "device_start",
                    deviceId: "win-broker-missing",
                    dryRun: false,
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(missingMetadata.isError).not.toBe(true);
            expect(JSON.parse(((missingMetadata.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: false,
                error: "missing-provider-metadata",
                status: 400,
                body: expect.objectContaining({ missing: ["configPath"] }),
            }));
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            rmSync(ownerRoot, { recursive: true, force: true });
        }
    });

    it("reports broker command validation and unavailable broker failures without autolaunch", { timeout: TIMEOUT }, async () => {
        const invalidAction = await client.callTool({
            name: "device_broker_command",
            arguments: { action: "run", backend: "android-emulator", command: "device_start", deviceId: "android-x" },
        });
        expect(invalidAction.isError).not.toBe(true);
        expect(JSON.parse(((invalidAction.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: false,
            error: "invalid-command-action",
            attempts: [],
        }));

        const inferenceFailure = await client.callTool({
            name: "device_status",
            arguments: { deviceId: "missing-broker-device", broker: true },
        });
        expect(inferenceFailure.isError).not.toBe(true);
        expect(JSON.parse(((inferenceFailure.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: false,
            error: "device-backend-not-found",
            deviceId: "missing-broker-device",
            routedBy: "device-lifecycle-broker",
        }));

        const unavailable = await client.callTool({
            name: "device_broker_command",
            arguments: {
                action: "plan",
                backend: "ios-simulator",
                command: "device_start",
                deviceId: "ios-x",
                hostCandidates: ["127.0.0.1"],
                port: 9,
                timeoutMs: 50,
            },
        });
        expect(unavailable.isError).not.toBe(true);
        expect(JSON.parse(((unavailable.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: false,
            error: "broker-rpc-unavailable",
            attempts: [expect.objectContaining({ ok: false, status: null })],
        }));
    });


});
