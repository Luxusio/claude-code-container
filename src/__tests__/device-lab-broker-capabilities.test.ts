import { isolateDeviceLabTestEnvironment } from "./helpers/device-lab-test-environment.js";
import { createHash } from "crypto";
import { EventEmitter } from "events";
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
import * as processIdentity from "@ccc/device-lab/device-lab-process-identity.js";
import { DEVICE_LAB_VERSION } from "@ccc/device-lab/version.js";
import { close, listen } from "./helpers/host-broker-test-fixture.js";

describe("one broker protocol", () => {
    it("rejects protocol 5 brokers that retain the previous operation asset pin", () => {
        expect(isCompatibleBrokerProtocol(5)).toBe(false);
    });
    it.each([undefined, null, String(DEVICE_BROKER_PROTOCOL_VERSION), true, 0, DEVICE_BROKER_PROTOCOL_VERSION - 1, DEVICE_BROKER_PROTOCOL_VERSION + 1, NaN, {}, []])("rejects absent, malformed or different protocol %s", (value) => {
        expect(isCompatibleBrokerProtocol(value)).toBe(false);
    });
    it.each([undefined, 0, 1, 2, 5, 6, 7, 8, 9, 10, DEVICE_BROKER_PROTOCOL_VERSION, "1"])("checks protocol over actual HTTP: %s", async (protocolVersion) => {
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
        fault: "none" | "entry" | "missing-entry" | "missing-listener" | "listener-pid" | "birth" | "saved-pid" | "saved-port" | "manager",
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
                    if (fault === "missing-listener") return null;
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

    it.each([
        ["entry", "command-or-entry-unverified"], ["missing-entry", "runtime-metadata-unverified"],
        ["missing-listener", "listener-unavailable"], ["listener-pid", "status-pid-mismatch"],
        ["birth", "process-generation-mismatch"], ["saved-pid", "runtime-metadata-unverified"],
        ["saved-port", "runtime-metadata-unverified"], ["manager", "runtime-metadata-unverified"],
    ] as const)("MCP interop diagnoses %s without replacing its record", async (fault, reason) => {
        await withMcpManagedBroker(fault, async ({ runtimeFile, runtimeBytes, options, spawnImpl, terminateProcess }) => {
            const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
            const result = await ensureHostDeviceBroker(options);
            expect(result).toEqual(expect.objectContaining({
                ok: false, error: "host-broker-incompatible", launched: false, reused: false,
                diagnostics: expect.arrayContaining([`broker process verification: ${reason}`]),
            }));
            expect(JSON.stringify("diagnostics" in result ? result.diagnostics : null)).not.toContain(fixtureHome!);
            expect(readFileSync(runtimeFile, "utf8")).toBe(runtimeBytes);
            expect(spawnImpl).not.toHaveBeenCalled();
            expect(terminateProcess).not.toHaveBeenCalled();
            expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
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


// Canned control responses and mocked signals keep these recovery regressions
// independent of any broker listening on the machine running this suite.
describe("automatic broker recovery from native observations", () => {
    let home: string, restoreHome: () => void;
    const ownerId = "aaaaaaaaaaaaaaaa";
    const cachedPid = 761001, launchedPid = 761002;
    const privatePort = 47685, stablePort = 17373;
    const cliPath = "/fixture/ccc/packages/device-lab/dist/broker-entry.js";
    const startedAt = "2026-10-22T00:00:00.000Z";
    const cachedToken = "test:cached-broker-birth";
    const nativeToken = () => process.platform === "win32" ? "windows:cached-birth"
        : process.platform === "darwin" ? "ps:Thu Oct 22 00:00:00 2026" : "linux:cached-birth";
    const errno = (code: string) => Object.assign(new Error(`fixture ${code}`), { code });
    const runtimeFile = () => join(home, ".ccc", "devices", "broker", "runtime.json");
    const writeRuntime = (runtime: Record<string, unknown>) => {
        mkdirSync(join(home, ".ccc", "devices", "broker"), { recursive: true });
        const bytes = JSON.stringify(runtime, null, 2) + "\n";
        writeFileSync(runtimeFile(), bytes, { mode: 0o600 }); return bytes;
    };
    const listener = (pid: number, token: string, port: number) => {
        const commandLine = `node ${cliPath} devices broker serve --host 127.0.0.1 --port ${port}`;
        return { pid, commandLine, processStartToken: token,
            processIdentity: { pid, startToken: token, commandHash: createHash("sha256").update(commandLine).digest("hex") } };
    };
    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), "ccc-broker-auto-recovery-"));
        restoreHome = isolateDeviceLabTestEnvironment(home);
    });
    afterEach(() => {
        vi.useRealTimers(); vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); restoreHome();
    });

    const endpointCases = [
        { name: "dead local MCP record", liveness: "exited", platform: "native", token: "native", expected: "stable" },
        { name: "dead host record", manager: "ccc-host", liveness: "exited", platform: "native", token: "native", expected: "stable" },
        { name: "missing platform with native token", liveness: "exited", platform: "missing", token: "native", expected: "stable" },
        { name: "null platform with native token", liveness: "exited", platform: "null", token: "native", expected: "stable" },
        { name: "explicit local platform without token", liveness: "exited", platform: "native", token: "missing", expected: "stable" },
        { name: "explicit port", liveness: "exited", platform: "native", token: "native", explicit: true, expected: "explicit" },
        { name: "live cached process", liveness: "alive", platform: "native", token: "native", expected: "cached" },
        { name: "permission denied is not death", liveness: "EPERM", platform: "native", token: "native", expected: "cached" },
        { name: "unknown process observation", liveness: "EIO", platform: "native", token: "native", expected: "cached" },
        { name: "foreign platform cannot become native through options.platform", liveness: "exited", platform: "foreign", token: "native", expected: "cached" },
        { name: "missing platform and foreign token", liveness: "exited", platform: "missing", token: "foreign", expected: "cached" },
        { name: "missing platform and token", liveness: "exited", platform: "missing", token: "missing", expected: "cached" },
        { name: "non-numeric cached PID", liveness: "exited", platform: "native", token: "native", pid: "761001", expected: "cached" },
        { name: "zero cached PID", liveness: "exited", platform: "native", token: "native", pid: 0, expected: "cached" },
    ] as const;
    it.each(endpointCases)("selects the configured endpoint safely: $name", async entry => {
        const foreignPlatform = process.platform === "win32" ? "darwin" : "win32";
        const runtime = { name: "ccc-device-broker", managedBy: "manager" in entry ? entry.manager : "device-lab-mcp",
            ownerId, pid: "pid" in entry ? entry.pid : cachedPid, host: "127.0.0.1", port: privatePort, startedAt,
            ...(entry.platform === "native" ? { platform: process.platform }
                : entry.platform === "foreign" ? { platform: foreignPlatform }
                    : entry.platform === "null" ? { platform: null } : {}),
            ...(entry.token !== "missing" ? { processStartToken: entry.token === "native" ? nativeToken() : "foreign:cached-birth" } : {}),
        };
        const runtimeBytes = writeRuntime(runtime);
        const expectedPort = entry.expected === "stable" ? stablePort : entry.expected === "explicit" ? 47686 : privatePort;
        const requests: number[] = [];
        vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
            const url = new URL(String(input)); requests.push(Number(url.port));
            expect(Number(url.port)).toBe(expectedPort);
            expect(readFileSync(runtimeFile(), "utf8")).toBe(runtimeBytes);
            const body = url.pathname === "/health" ? { ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }
                : url.pathname === "/status" ? { ok: true, broker: {
                    name: "ccc-device-broker", mode: "host-broker-daemon", ownerId, host: "127.0.0.1", port: expectedPort,
                    version: DEVICE_LAB_VERSION, protocolVersion: DEVICE_BROKER_PROTOCOL_VERSION, startedAt,
                    process: { pid: launchedPid, startToken: "test:stable-listener-birth" },
                } } : { ok: true, result: { ownerId } };
            return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
        });
        const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
            expect(pid).toBe(cachedPid); expect(signal).toBe(0);
            if (entry.liveness === "exited") throw errno("ESRCH");
            if (entry.liveness !== "alive") throw errno(entry.liveness);
            return true;
        });
        const spawnImpl = vi.fn(() => { throw new Error("fixture must never launch a real broker"); });
        const options: HostDeviceBrokerOptions = { cwd: home, ownerId, bindHost: "127.0.0.1", probeHost: "127.0.0.1",
            cliPath, timeoutMs: 100, spawnImpl: spawnImpl as any,
            portProcessResolver: port => listener(launchedPid, "test:stable-listener-birth", port),
            ...(entry.platform === "foreign" ? { platform: foreignPlatform as NodeJS.Platform } : {}),
            ...("explicit" in entry ? { port: expectedPort } : {}),
        };
        const result = await ensureHostDeviceBroker(options);
        expect(result.port).toBe(expectedPort); expect(requests.length).toBeGreaterThan(0);
        if (entry.expected === "stable" || entry.expected === "explicit") expect(result).toMatchObject({ ok: true, reused: true });
        if (runtime.managedBy === "ccc-host" && result.ok) {
            expect(JSON.parse(readFileSync(runtimeFile(), "utf8")).pid).toBe(launchedPid);
        } else expect(readFileSync(runtimeFile(), "utf8")).toBe(runtimeBytes);
        expect(spawnImpl).not.toHaveBeenCalled();
        expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    });

    describe.skipIf(process.platform === "win32")("native POSIX signaling without an injected terminator", () => {
        type Mode = "term-exit" | "kill-exit" | "term-fails" | "kill-fails" | "exit-EPERM" | "exit-unknown"
            | "term-pid-changed" | "term-token-changed" | "term-port-lost"
            | "kill-pid-changed" | "kill-token-changed" | "kill-port-lost" | "full-identity-lost"
            | "term-full-identity-lost" | "kill-full-identity-lost";
        async function repair(mode: Mode) {
            vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
            const runtimeBytes = writeRuntime({ name: "ccc-device-broker", managedBy: "ccc-host", ownerId,
                pid: cachedPid, host: "127.0.0.1", port: privatePort, platform: process.platform, startedAt, processStartToken: cachedToken });
            let termSent = false, exited = false, launched = false, resolverReads = 0;
            const fresh = listener(launchedPid, "test:replacement-birth", privatePort);
            const captured = listener(cachedPid, cachedToken, privatePort);
            vi.spyOn(processIdentity, "readDeviceRuntimeProcessIdentity").mockReturnValue(null);
            const portProcessResolver = vi.fn((port: number) => {
                expect(port).toBe(privatePort);
                if (launched) return fresh;
                resolverReads++;
                if (mode === "full-identity-lost" || mode === "term-full-identity-lost" || mode === "kill-full-identity-lost") {
                    // Full identity survives admission and both initial identity/token
                    // checks. The later modes lose it only at the actual signal gate.
                    const lost = mode === "full-identity-lost" ? resolverReads > 1
                        : mode === "term-full-identity-lost" ? resolverReads >= 4 : termSent;
                    return lost ? { pid: cachedPid, commandLine: "", processStartToken: cachedToken, processIdentity: null } : captured;
                }
                const changed = mode.startsWith("term-") && resolverReads >= 3 || mode.startsWith("kill-") && termSent;
                if (changed && mode.endsWith("port-lost")) return null;
                return { pid: changed && mode.endsWith("pid-changed") ? cachedPid + 1 : cachedPid,
                    commandLine: "", processStartToken: changed && mode.endsWith("token-changed") ? "test:reused-pid" : cachedToken,
                    processIdentity: null };
            });
            const signals = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
                expect(pid).toBe(cachedPid);
                if (signal === 0) {
                    if (exited) throw errno("ESRCH");
                    if (termSent && mode === "exit-EPERM") throw errno("EPERM");
                    if (termSent && mode === "exit-unknown") throw errno("EIO");
                    return true;
                }
                if (signal === "SIGTERM") {
                    if (mode === "term-fails") throw errno("EPERM");
                    termSent = true; if (mode === "term-exit") exited = true; return true;
                }
                expect(signal).toBe("SIGKILL");
                if (mode === "kill-fails") throw errno("EPERM");
                if (mode === "kill-exit") exited = true;
                return true;
            });
            vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
                const url = new URL(String(input)); expect(Number(url.port)).toBe(privatePort);
                const body = url.pathname === "/health" ? { ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }
                    : url.pathname === "/status" ? { ok: true, broker: {
                        name: "ccc-device-broker", mode: "host-broker-daemon", ownerId, port: privatePort, host: "127.0.0.1",
                        version: DEVICE_LAB_VERSION, protocolVersion: launched ? DEVICE_BROKER_PROTOCOL_VERSION : DEVICE_BROKER_PROTOCOL_VERSION - 1,
                        process: { pid: launched ? launchedPid : cachedPid, startToken: launched ? fresh.processStartToken : cachedToken },
                        startedAt,
                    } } : { ok: true, result: { ownerId } };
                return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
            });
            const child = Object.assign(new EventEmitter(), { pid: launchedPid, unref: vi.fn() });
            const spawnImpl = vi.fn(() => { launched = true; return child; });
            const pending = ensureHostDeviceBroker({ cwd: home, ownerId, port: privatePort, bindHost: "127.0.0.1", probeHost: "127.0.0.1",
                cliPath, timeoutMs: 100, startupTimeoutMs: 1000, spawnImpl: spawnImpl as any, portProcessResolver,
                processIdentityReader: pid => pid === launchedPid ? fresh.processIdentity : null,
                processStartTokenReader: pid => pid === launchedPid ? fresh.processStartToken : null });
            await vi.runAllTimersAsync();
            return { result: await pending, runtimeBytes, signals, spawnImpl, resolverReads };
        }
        it.each(["term-exit", "kill-exit"] as const)("repairs an admitted metadata-only broker through %s", async mode => {
            const f = await repair(mode);
            expect(f.result).toMatchObject({ ok: true, launched: true, reused: false, port: privatePort, verifiedBrokerPid: launchedPid });
            expect(f.signals.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([
                [cachedPid, "SIGTERM"], ...(mode === "kill-exit" ? [[cachedPid, "SIGKILL"]] : []),
            ]);
            expect(f.spawnImpl).toHaveBeenCalledOnce();
            expect(JSON.parse(readFileSync(runtimeFile(), "utf8")).pid).toBe(launchedPid);
        });
        it.each(["term-pid-changed", "term-token-changed", "term-port-lost", "full-identity-lost"] as const)("refuses signaling after %s without downgrading captured authority", async mode => {
            const f = await repair(mode);
            expect(f.result).toMatchObject({ ok: false, error: "host-broker-incompatible", launched: false });
            expect(f.signals.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
            expect(readFileSync(runtimeFile(), "utf8")).toBe(f.runtimeBytes); expect(f.spawnImpl).not.toHaveBeenCalled();
        });
        it.each(["kill-pid-changed", "kill-token-changed", "kill-port-lost"] as const)("revalidates exact listener generation before escalation: %s", async mode => {
            const f = await repair(mode);
            expect(f.result).toMatchObject({ ok: false, error: "host-broker-incompatible", launched: false });
            expect(f.signals.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([[cachedPid, "SIGTERM"]]);
            expect(readFileSync(runtimeFile(), "utf8")).toBe(f.runtimeBytes); expect(f.spawnImpl).not.toHaveBeenCalled();
        });
        it.each(["term-full-identity-lost", "kill-full-identity-lost"] as const)("does not downgrade full identity to a matching token at the native signal gate: %s", async mode => {
            const f = await repair(mode);
            expect(f.result).toMatchObject({ ok: false, error: "host-broker-incompatible", launched: false });
            expect(f.resolverReads).toBe(mode === "term-full-identity-lost" ? 4 : 5);
            expect(f.signals.mock.calls.filter(([, signal]) => signal !== 0))
                .toEqual(mode === "term-full-identity-lost" ? [] : [[cachedPid, "SIGTERM"]]);
            expect(readFileSync(runtimeFile(), "utf8")).toBe(f.runtimeBytes);
            expect(f.spawnImpl).not.toHaveBeenCalled();
        });
        it.each(["term-fails", "kill-fails", "exit-EPERM", "exit-unknown"] as const)("retains recovery evidence when stop completion is not proven: %s", async mode => {
            const f = await repair(mode);
            expect(f.result).toMatchObject({ ok: false, error: "host-broker-incompatible", launched: false });
            expect(readFileSync(runtimeFile(), "utf8")).toBe(f.runtimeBytes); expect(f.spawnImpl).not.toHaveBeenCalled();
            expect(f.signals.mock.calls.filter(([, signal]) => signal !== 0)).toEqual(mode === "term-fails"
                ? [[cachedPid, "SIGTERM"]] : [[cachedPid, "SIGTERM"], [cachedPid, "SIGKILL"]]);
        });
    });
});
