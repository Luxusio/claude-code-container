import { isolateDeviceLabTestEnvironment } from "./helpers/device-lab-test-environment.js";
import { createHash } from "crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createServer } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEVICE_BROKER_PROTOCOL_VERSION, isCompatibleBrokerProtocol } from "@ccc/device-lab/providers/contracts/broker-protocol.mjs";
import { probeCccHostBrokerProtocolForTest } from "../../device-lab-mcp/src/broker.mjs";
import { createDeviceBrokerServer, ensureHostDeviceBroker, hostBrokerRuntimeFromPortProcessForTest, invokeHostDeviceBrokerOwnerRpc, type HostDeviceBrokerOptions } from "@ccc/device-lab/device-lab-broker.js";
import { ownerId as deviceLabOwnerId } from "@ccc/device-lab/providers/context.mjs";
import { readDeviceRuntimeProcessStartToken } from "@ccc/device-lab/device-lab-process-identity.js";
import { close, listen } from "./helpers/host-broker-test-fixture.js";

describe("one broker protocol", () => {
    it.each([undefined, null, String(DEVICE_BROKER_PROTOCOL_VERSION), true, 0, DEVICE_BROKER_PROTOCOL_VERSION - 1, DEVICE_BROKER_PROTOCOL_VERSION + 1, NaN, {}, []])("rejects absent, malformed or different protocol %s", (value) => {
        expect(isCompatibleBrokerProtocol(value)).toBe(false);
    });
    it.each([undefined, 0, 1, 2, "1"])("checks protocol over actual HTTP: %s", async (protocolVersion) => {
        const server = createServer((_req, res) => {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ok: true, broker: {protocolVersion, version: "999.0.0"}}));
        });
        const url = await listen(server);
        try {
            const result = await probeCccHostBrokerProtocolForTest("127.0.0.1", Number(new URL(url).port), 3000);
            expect(result.ok).toBe(protocolVersion === DEVICE_BROKER_PROTOCOL_VERSION);
            expect(result.expectedProtocolVersion).toBe(DEVICE_BROKER_PROTOCOL_VERSION);
            expect(result).not.toHaveProperty("missingCapabilities");
        } finally { await close(server); }
    });
});

describe("host CLI protocol reuse", () => {
    let originalHomeRestore: (() => void) | undefined;
    let fixtureHome: string | undefined;

    beforeEach(() => {
        fixtureHome = mkdtempSync(join(tmpdir(), "ccc-broker-capabilities-home-"));
        originalHomeRestore = isolateDeviceLabTestEnvironment(fixtureHome);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        if (fixtureHome) rmSync(fixtureHome, { recursive: true, force: true });
        originalHomeRestore?.();
    });

    it.each([17373, 47685])("attests matching MCP-managed native continuity at port %s", port => {
        const cliPath = "/opt/ccc/packages/device-lab/dist/broker-entry.js";
        const commandLine = `node ${cliPath} devices broker serve --port ${port} --runtime-managed-by-parent`;
        const identity = { pid: 5212, startToken: "linux:broker-generation", commandHash: createHash("sha256").update(commandLine).digest("hex") };
        const listener = { pid: identity.pid, commandLine, processIdentity: identity, processStartToken: identity.startToken };
        expect(hostBrokerRuntimeFromPortProcessForTest(
            "1111111111111111", port, {}, "linux", () => listener,
            { name: "ccc-device-broker", managedBy: "device-lab-mcp", pid: identity.pid, port, processStartToken: identity.startToken },
            { name: "ccc-device-broker", managedBy: "ccc-host-status", pid: identity.pid, port, processStartToken: identity.startToken },
            cliPath, true,
        )).toEqual(expect.objectContaining({ pid: identity.pid, port, processIdentity: identity }));
    });

    it.each([17373, 47685])("does not grant automatic replacement authority over a matching MCP runtime at port %s", port => {
        const cliPath = "/opt/ccc/packages/device-lab/dist/broker-entry.js";
        const commandLine = `node ${cliPath} devices broker serve --port ${port} --runtime-managed-by-parent`;
        const identity = { pid: 5212, startToken: "linux:broker-generation", commandHash: createHash("sha256").update(commandLine).digest("hex") };
        expect(hostBrokerRuntimeFromPortProcessForTest(
            "1111111111111111", port, {}, "linux",
            () => ({ pid: identity.pid, commandLine, processIdentity: identity, processStartToken: identity.startToken }),
            { name: "ccc-device-broker", managedBy: "device-lab-mcp", pid: identity.pid, port, processStartToken: identity.startToken },
            { name: "ccc-device-broker", managedBy: "ccc-host-status", pid: identity.pid, port, processStartToken: identity.startToken },
            cliPath,
        )).toBeNull();
    });

    async function withMcpManagedBroker(
        fault: "none" | "entry" | "missing-entry" | "listener-pid" | "birth" | "saved-pid" | "saved-port" | "manager",
        test: (fixture: { port: number; runtimeFile: string; runtimeBytes: string; options: HostDeviceBrokerOptions;
            server: ReturnType<typeof createDeviceBrokerServer>; status: { broker: { startedAt: string; process: { pid: number; startToken: string } } };
            spawnImpl: ReturnType<typeof vi.fn>; terminateProcess: ReturnType<typeof vi.fn> }) => Promise<void>,
    ) {
        const cwd = join(fixtureHome!, "host-project");
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        const port = Number(new URL(baseUrl).port);
        try {
            const status = await (await fetch(`${baseUrl}/status`)).json() as {
                broker: { startedAt: string; process: { pid: number; startToken: string } };
            };
            const token = status.broker.process.startToken;
            expect(token).toEqual(expect.any(String));
            expect(token.length).toBeGreaterThan(0);
            const cliPath = join(fixtureHome!, "trusted", "broker-entry.js");
            const commandLine = fault === "missing-entry" ? "" : `node "${fault === "entry" ? join(fixtureHome!, "foreign", "broker-entry.js") : cliPath}" devices broker serve --port ${port} --runtime-managed-by-parent`;
            const observedPid = fault === "listener-pid" ? process.pid + 100000 : process.pid;
            const observedToken = fault === "birth" ? "different-birth-generation" : token;
            const runtimeFile = join(fixtureHome!, ".ccc", "devices", "broker", "runtime.json");
            const runtime = { name: "ccc-device-broker", managedBy: fault === "manager" ? "unknown-manager" : "device-lab-mcp",
                ownerId: deviceLabOwnerId({}, cwd), pid: fault === "saved-pid" ? process.pid + 100000 : process.pid,
                host: "127.0.0.1", port: fault === "saved-port" ? (port === 65535 ? port - 1 : port + 1) : port,
                startedAt: status.broker.startedAt, processStartToken: token, command: process.execPath,
                args: [cliPath, "devices", "broker", "serve", "--port", String(port), "--runtime-managed-by-parent"],
                retainedParentEvidence: { label: "parent-owned", generation: "unchanged" } };
            const runtimeBytes = JSON.stringify(runtime, null, 2) + "\n";
            mkdirSync(join(fixtureHome!, ".ccc", "devices", "broker"), { recursive: true });
            writeFileSync(runtimeFile, runtimeBytes, { mode: 0o600 });
            const spawnImpl = vi.fn(() => { throw new Error("A reachable broker must not launch a replacement"); });
            const terminateProcess = vi.fn(() => { throw new Error("Unverified or matching broker must not be terminated"); });
            const realFetch = globalThis.fetch;
            vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
                // Omitted-port discovery must not contact the shared default port
                // when this supported record names a private ephemeral listener.
                expect(new URL(String(input)).port).toBe(String(port));
                return realFetch(input, init);
            });
            const options: HostDeviceBrokerOptions = {
                cwd, port, timeoutMs: 10000, bindHost: "127.0.0.1", probeHost: "127.0.0.1", cliPath,
                portProcessResolver: requestedPort => {
                    expect(requestedPort).toBe(port);
                    return { pid: observedPid, commandLine, processStartToken: observedToken,
                        processIdentity: { pid: observedPid, startToken: observedToken, commandHash: createHash("sha256").update(commandLine).digest("hex") } };
                },
                spawnImpl: spawnImpl as any, terminateProcess,
            };
            await test({ port, runtimeFile, runtimeBytes, options, server, status, spawnImpl, terminateProcess });
        } finally { await close(server); }
    }

    it.each(["explicit", "omitted"] as const)("host %s-port discovery reuses parent authority and authenticates owner RPC", async selectedPort => {
        await withMcpManagedBroker("none", async ({ port, runtimeFile, runtimeBytes, options, spawnImpl, terminateProcess }) => {
            const discoveryOptions = { ...options };
            if (selectedPort === "omitted") delete discoveryOptions.port;
            expect(await ensureHostDeviceBroker(discoveryOptions)).toEqual(expect.objectContaining({
                ok: true, launched: false, reused: true, port, verifiedBrokerPid: process.pid,
                verifiedProtocolVersion: DEVICE_BROKER_PROTOCOL_VERSION,
            }));
            expect(readFileSync(runtimeFile, "utf8")).toBe(runtimeBytes);
            expect(await invokeHostDeviceBrokerOwnerRpc("broker.echo", { value: "parent-authority" }, {
                ...discoveryOptions, rpcTimeoutMs: 5000,
            })).toEqual(expect.objectContaining({
                ok: true, status: 200, port, body: expect.objectContaining({
                    ok: true, result: expect.objectContaining({ params: { value: "parent-authority" } }),
                }),
            }));
            expect(readFileSync(runtimeFile, "utf8")).toBe(runtimeBytes);
            expect(spawnImpl).not.toHaveBeenCalled();
            expect(terminateProcess).not.toHaveBeenCalled();
        });
    });

    it.each(["entry", "missing-entry", "listener-pid", "birth", "saved-pid", "saved-port", "manager"] as const)("MCP interop still refuses %s mismatch without replacing its record", async fault => {
        await withMcpManagedBroker(fault, async ({ runtimeFile, runtimeBytes, options, spawnImpl, terminateProcess }) => {
            expect(await ensureHostDeviceBroker(options)).toEqual(expect.objectContaining({
                ok: false, error: "host-broker-incompatible", launched: false, reused: false,
            }));
            expect(readFileSync(runtimeFile, "utf8")).toBe(runtimeBytes);
            expect(spawnImpl).not.toHaveBeenCalled();
            expect(terminateProcess).not.toHaveBeenCalled();
        });
    });

    it.each((["protocol", "bind"] as const).flatMap(mismatch =>
        (["parent", "successor"] as const).map(record => ({ mismatch, record })),
    ))("MCP $mismatch mismatch preserves $record authority without automatic repair", async ({ mismatch, record }) => {
        await withMcpManagedBroker("none", async ({ runtimeFile, runtimeBytes, options, server, status, spawnImpl, terminateProcess }) => {
            const parent = JSON.parse(runtimeBytes);
            const successorBytes = JSON.stringify({ ...parent, pid: process.pid + 100000,
                processStartToken: "successor-birth-generation", startedAt: "successor-start",
                retainedParentEvidence: { label: "successor-owned", generation: "new" } }, null, 2) + "\n";
            const originalRequest = server.listeners("request")[0];
            server.removeListener("request", originalRequest);
            let observedStatus = false;
            server.on("request", (req, res) => {
                if (req.url === "/status") {
                    observedStatus = true;
                    if (record === "successor") writeFileSync(runtimeFile, successorBytes);
                    if (mismatch === "protocol") {
                        // The mismatch travels over the actual private HTTP wire;
                        // retain the real server's PID/birth and owner-resolve route.
                        res.setHeader("Content-Type", "application/json");
                        res.end(JSON.stringify({ ...status, broker: { ...status.broker,
                            protocolVersion: DEVICE_BROKER_PROTOCOL_VERSION - 1 } }));
                        return;
                    }
                }
                originalRequest.call(server, req, res);
            });
            const requested = mismatch === "bind" ? { ...options, bindHost: "0.0.0.0" } : options;
            expect(await ensureHostDeviceBroker(requested)).toEqual(expect.objectContaining({
                ok: false, error: "host-broker-incompatible", launched: false, reused: false,
            }));
            expect(observedStatus).toBe(true);
            expect(readFileSync(runtimeFile, "utf8")).toBe(record === "successor" ? successorBytes : runtimeBytes);
            expect(spawnImpl).not.toHaveBeenCalled();
            expect(terminateProcess).not.toHaveBeenCalled();
        });
    });

    it.each([DEVICE_BROKER_PROTOCOL_VERSION, DEVICE_BROKER_PROTOCOL_VERSION + 1])("reuses matching protocol and never downgrades newer protocol %s", async (protocolVersion) => {
        const cwd = "/project/broker-newer-family-reuse-test";
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        const port = Number(new URL(baseUrl).port);
        const realFetch = globalThis.fetch;
        vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
            const response = await realFetch(input, init);
            if (!String(input).endsWith("/status")) return response;
            const body = await response.json() as { broker: { version: string; protocolVersion: number } };
            body.broker.version = "999.0.0";
            body.broker.protocolVersion = protocolVersion;
            return new Response(JSON.stringify(body), { status: response.status, headers: { "content-type": "application/json" } });
        });
        // The listener is this test process. Were the broker judged incompatible, the CLI would
        // signal it for replacement; record that instead of letting it kill the test worker.
        const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
        const commandLine = `node /opt/ccc/dist/index.js devices broker serve --host 127.0.0.1 --port ${port}`;
        const processStartToken = readDeviceRuntimeProcessStartToken(process.pid) || `test:${process.pid}`;
        try {
            const spawnImpl = vi.fn();
            const terminateProcess = vi.fn(() => { throw new Error("compatible/newer broker must not be terminated"); });
            const result = await ensureHostDeviceBroker({
                terminateProcess,
                timeoutMs: 10000,
                cwd,
                bindHost: "127.0.0.1",
                probeHost: "127.0.0.1",
                port,
                cliPath: "/opt/ccc/dist/index.js",
                portProcessResolver: () => ({
                    pid: process.pid,
                    commandLine,
                    processIdentity: {
                        pid: process.pid,
                        startToken: processStartToken,
                        commandHash: createHash("sha256").update(commandLine).digest("hex"),
                    },
                    processStartToken,
                }),
                spawnImpl: spawnImpl as any,
            });

            if (protocolVersion === DEVICE_BROKER_PROTOCOL_VERSION) {
                expect(result, JSON.stringify(result)).toEqual(expect.objectContaining({ ok: true, launched: false, reused: true, port }));
                expect(result).toHaveProperty("verifiedProtocolVersion", DEVICE_BROKER_PROTOCOL_VERSION);
            } else {
                expect(result, JSON.stringify(result)).toEqual(expect.objectContaining({ ok: false, error: "host-broker-incompatible" }));
            }
            expect(terminateProcess).not.toHaveBeenCalled();
            expect(spawnImpl).not.toHaveBeenCalled();
            expect(killSpy).not.toHaveBeenCalledWith(process.pid, "SIGTERM");
        } finally {
            await close(server);
        }
    });
});
