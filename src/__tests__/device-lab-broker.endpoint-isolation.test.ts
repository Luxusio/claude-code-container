import { createHash } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    configuredDeviceBrokerPort,
    deviceBrokerRuntimeFilename,
} from "@ccc/device-lab/providers/contracts/broker-endpoint.mjs";
import { DEVICE_BROKER_PROTOCOL_VERSION } from "@ccc/device-lab/providers/contracts/broker-protocol.mjs";
import {
    createDeviceBrokerServer,
    deviceBrokerStatus,
    ensureHostDeviceBroker,
    type HostDeviceBrokerOptions,
} from "@ccc/device-lab/device-lab-broker.js";
import { isolateDeviceLabTestEnvironment } from "./helpers/device-lab-test-environment.js";
import { close, listen } from "./helpers/host-broker-test-fixture.js";

describe("broker endpoint configuration contract", () => {
    it.each([undefined, ""])("keeps the ordinary runtime when configuration is %j", value => {
        const env = { CCC_DEVICE_BROKER_PORT: value };
        expect(configuredDeviceBrokerPort(env)).toBeUndefined();
        expect(deviceBrokerRuntimeFilename(env)).toBe("runtime.json");
    });

    it.each([1, 17373, 17374, 65535])("accepts canonical port %i without accepting a file path", port => {
        const env = { CCC_DEVICE_BROKER_PORT: String(port) };
        expect(configuredDeviceBrokerPort(env)).toBe(port);
        expect(deviceBrokerRuntimeFilename(env)).toBe(port === 17373 ? "runtime.json" : `runtime-${port}.json`);
    });

    it.each([
        "0", "65536", "-1", "+17374", "017374", "17374.0", "17374.5", "1e4", "0x43de",
        " 17374", "17374 ", "17374\n", "../17374", "17374/runtime.json", "NaN", "Infinity",
    ])("rejects noncanonical or out-of-range configuration %j", value => {
        const env = { CCC_DEVICE_BROKER_PORT: value };
        expect(() => configuredDeviceBrokerPort(env)).toThrow();
        expect(() => deviceBrokerRuntimeFilename(env)).toThrow();
    });
});

describe("host broker endpoint and runtime isolation", () => {
    let home: string;
    let restoreEnvironment: () => void;

    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), "ccc-broker-endpoint-home-"));
        restoreEnvironment = isolateDeviceLabTestEnvironment(home);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        restoreEnvironment();
        rmSync(home, { recursive: true, force: true });
    });

    const runtimeFile = (filename = "runtime.json") => join(home, ".ccc", "devices", "broker", filename);
    function writeRuntime(filename: string, record: Record<string, unknown>): string {
        const bytes = JSON.stringify(record, null, 2) + "\n";
        mkdirSync(dirname(runtimeFile(filename)), { recursive: true });
        writeFileSync(runtimeFile(filename), bytes, { mode: 0o600 });
        return bytes;
    }
    function defaultRuntimeSentinel(): string {
        return writeRuntime("runtime.json", {
            name: "ccc-device-broker", managedBy: "ccc-host", pid: process.pid,
            host: "127.0.0.1", port: 17373, command: process.execPath,
            args: [join(home, "global-installation", "broker-entry.js"), "devices", "broker", "serve", "--port", "17373"],
            retainedGlobalEvidence: "must remain byte-for-byte unchanged",
        });
    }

    async function withBroker(test: (fixture: {
        port: number;
        status: { broker: { startedAt: string; process: { pid: number; startToken: string } } };
        cliPath: string;
        options: HostDeviceBrokerOptions;
        spawnImpl: ReturnType<typeof vi.fn>;
        terminateProcess: ReturnType<typeof vi.fn>;
    }) => Promise<void>) {
        const cwd = join(home, "checkout");
        const cliPath = join(home, "trusted", "broker-entry.js");
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0, cliPath });
        const baseUrl = await listen(server);
        const port = Number(new URL(baseUrl).port);
        try {
            const status = await (await fetch(`${baseUrl}/status`)).json() as {
                broker: { startedAt: string; process: { pid: number; startToken: string } };
            };
            expect(status.broker.process.pid).toBe(process.pid);
            expect(status.broker.process.startToken).toEqual(expect.any(String));
            const commandLine = `node "${cliPath}" devices broker serve --host 127.0.0.1 --port ${port}`;
            const processIdentity = { pid: process.pid, startToken: status.broker.process.startToken,
                commandHash: createHash("sha256").update(commandLine).digest("hex") };
            const spawnImpl = vi.fn(() => { throw new Error("reachable broker must not launch a replacement"); });
            const terminateProcess = vi.fn(() => { throw new Error("matching broker must not be terminated"); });
            const realFetch = fetch;
            vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
                // A regression must fail here, before it can probe a shared host port.
                expect(Number(new URL(String(input)).port)).toBe(port);
                return realFetch(input, init);
            });
            await test({ port, status, cliPath, spawnImpl, terminateProcess,
                options: { cwd, cliPath, timeoutMs: 10000, bindHost: "127.0.0.1", probeHost: "127.0.0.1",
                    env: { CCC_DEVICE_BROKER_PORT: String(port) }, spawnImpl: spawnImpl as any, terminateProcess,
                    portProcessResolver: requestedPort => {
                        expect(requestedPort).toBe(port);
                        return { pid: process.pid, commandLine, processIdentity, processStartToken: processIdentity.startToken };
                    } },
            });
        } finally {
            await close(server);
        }
    }

    it("uses options.env for reuse and publishes only the selected runtime", async () => {
        const sentinel = defaultRuntimeSentinel();
        await withBroker(async ({ port, options, spawnImpl, terminateProcess }) => {
            process.env.CCC_DEVICE_BROKER_PORT = "1";
            const result = await ensureHostDeviceBroker(options);
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true, reused: true, launched: false, port,
                verifiedBrokerPid: process.pid, verifiedProtocolVersion: DEVICE_BROKER_PROTOCOL_VERSION });
            expect(JSON.parse(readFileSync(runtimeFile(`runtime-${port}.json`), "utf8"))).toMatchObject({
                name: "ccc-device-broker", managedBy: "ccc-host", port, pid: process.pid,
            });
            const selectedRuntimeFile = runtimeFile(`runtime-${port}.json`);
            expect(deviceBrokerStatus({ cwd: home, env: options.env })).toMatchObject({
                host: "127.0.0.1", port, url: `http://127.0.0.1:${port}`,
                state: { runtimeFile: selectedRuntimeFile },
                runtime: { file: selectedRuntimeFile, present: true, metadata: { port, pid: process.pid } },
                persistence: { brokerScoped: { runtimeFile: selectedRuntimeFile } },
            });
            expect(readFileSync(runtimeFile(), "utf8")).toBe(sentinel);
            expect(spawnImpl).not.toHaveBeenCalled();
            expect(terminateProcess).not.toHaveBeenCalled();
        });
    });

    it("keeps legacy omitted-port discovery in the ordinary runtime namespace", async () => {
        await withBroker(async ({ port, status, options, spawnImpl }) => {
            delete options.env;
            writeRuntime("runtime.json", { name: "ccc-device-broker", managedBy: "ccc-host", pid: process.pid,
                port, host: "127.0.0.1", platform: process.platform, startedAt: status.broker.startedAt,
                processStartToken: status.broker.process.startToken });
            expect(await ensureHostDeviceBroker(options)).toMatchObject({ ok: true, reused: true, port });
            expect(JSON.parse(readFileSync(runtimeFile(), "utf8"))).toMatchObject({ port, pid: process.pid });
            expect(existsSync(runtimeFile(`runtime-${port}.json`))).toBe(false);
            expect(spawnImpl).not.toHaveBeenCalled();
        });
    });

    it("lets an explicit numeric API port override the configured endpoint and namespace", async () => {
        const sentinel = defaultRuntimeSentinel();
        await withBroker(async ({ port, options }) => {
            const configuredPort = port === 65535 ? port - 1 : port + 1;
            options.env = { CCC_DEVICE_BROKER_PORT: String(configuredPort) };
            options.port = port;
            expect(await ensureHostDeviceBroker(options)).toMatchObject({ ok: true, reused: true, port });
            expect(JSON.parse(readFileSync(runtimeFile(`runtime-${port}.json`), "utf8"))).toMatchObject({ port, pid: process.pid });
            expect(existsSync(runtimeFile(`runtime-${configuredPort}.json`))).toBe(false);
            expect(readFileSync(runtimeFile(), "utf8")).toBe(sentinel);
        });
    });

    it("refuses a foreign entry on the selected port without replacing either runtime", async () => {
        const sentinel = defaultRuntimeSentinel();
        await withBroker(async ({ port, status, options, spawnImpl, terminateProcess }) => {
            const scopedBytes = writeRuntime(`runtime-${port}.json`, { name: "ccc-device-broker", managedBy: "ccc-host",
                pid: process.pid, port, host: "127.0.0.1", platform: process.platform,
                startedAt: status.broker.startedAt, processStartToken: status.broker.process.startToken });
            options.cliPath = join(home, "different-checkout", "broker-entry.js");
            expect(await ensureHostDeviceBroker(options)).toMatchObject({ ok: false, error: "host-broker-incompatible",
                reused: false, launched: false, port });
            expect(readFileSync(runtimeFile(), "utf8")).toBe(sentinel);
            expect(readFileSync(runtimeFile(`runtime-${port}.json`), "utf8")).toBe(scopedBytes);
            expect(spawnImpl).not.toHaveBeenCalled();
            expect(terminateProcess).not.toHaveBeenCalled();
        });
    });

    it("propagates the actual configured endpoint to a failed launch and preserves ordinary metadata", async () => {
        const sentinel = defaultRuntimeSentinel();
        await withBroker(async ({ port, options }) => {
            const configuredPort = port === 65535 ? port - 1 : port + 1;
            options.port = port;
            options.env = { CCC_DEVICE_BROKER_PORT: String(configuredPort), CCC_ISOLATION_TEST_MARKER: "child-marker" };
            options.portProcessResolver = requestedPort => { expect(requestedPort).toBe(port); return null; };
            vi.mocked(fetch).mockImplementation(async input => {
                expect(Number(new URL(String(input)).port)).toBe(port);
                throw new Error("controlled private endpoint unavailable");
            });
            const spawnImpl = vi.fn((_command, args, spawnOptions) => {
                expect(args.slice(-2)).toEqual(["--port", String(port)]);
                expect(spawnOptions.env).toMatchObject({ HOME: home, CCC_DEVICE_BROKER_PORT: String(port),
                    CCC_ISOLATION_TEST_MARKER: "child-marker" });
                throw new Error("controlled spawn refusal");
            });
            const result = await ensureHostDeviceBroker({ ...options, spawnImpl: spawnImpl as any });
            expect(result).toMatchObject({ ok: false, error: "host-broker-launch-failed", port });
            expect(spawnImpl).toHaveBeenCalledOnce();
            expect(readFileSync(runtimeFile(), "utf8")).toBe(sentinel);
            expect(existsSync(runtimeFile(`runtime-${port}.json`))).toBe(false);
            expect(existsSync(runtimeFile(`runtime-${configuredPort}.json`))).toBe(false);
        });
    });

    it("removes only the selected runtime during verified recovery before a failed replacement", async () => {
        const sentinel = defaultRuntimeSentinel();
        await withBroker(async ({ port, status, options }) => {
            writeRuntime(`runtime-${port}.json`, { name: "ccc-device-broker", managedBy: "ccc-host", pid: process.pid,
                port, host: "127.0.0.1", platform: process.platform, startedAt: status.broker.startedAt,
                processStartToken: status.broker.process.startToken });
            const forwardingFetch = vi.mocked(fetch).getMockImplementation()!;
            vi.mocked(fetch).mockImplementation(async (input, init) => {
                const response = await forwardingFetch(input, init);
                if (new URL(String(input)).pathname !== "/status") return response;
                const body = await response.json();
                body.broker.protocolVersion = DEVICE_BROKER_PROTOCOL_VERSION - 1;
                return new Response(JSON.stringify(body), { status: response.status, headers: { "content-type": "application/json" } });
            });
            const terminateProcess = vi.fn((pid: number) => {
                expect(pid).toBe(process.pid);
                return { ok: true };
            });
            const spawnImpl = vi.fn(() => { throw new Error("controlled replacement refusal"); });
            expect(await ensureHostDeviceBroker({ ...options, terminateProcess, spawnImpl: spawnImpl as any }))
                .toMatchObject({ ok: false, error: "host-broker-launch-failed", port });
            expect(terminateProcess).toHaveBeenCalledOnce();
            expect(spawnImpl).toHaveBeenCalledOnce();
            expect(existsSync(runtimeFile(`runtime-${port}.json`))).toBe(false);
            expect(readFileSync(runtimeFile(), "utf8")).toBe(sentinel);
        });
    });

    it("rejects an invalid override before probing, spawning or touching broker metadata", async () => {
        const sentinel = defaultRuntimeSentinel();
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("invalid config must not probe"); });
        const spawnImpl = vi.fn(() => { throw new Error("invalid config must not spawn"); });
        const portProcessResolver = vi.fn(() => { throw new Error("invalid config must not inspect a listener"); });
        await expect(ensureHostDeviceBroker({ cwd: home, env: { CCC_DEVICE_BROKER_PORT: "../17374" },
            spawnImpl: spawnImpl as any, portProcessResolver })).rejects.toThrow();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(spawnImpl).not.toHaveBeenCalled();
        expect(portProcessResolver).not.toHaveBeenCalled();
        expect(readFileSync(runtimeFile(), "utf8")).toBe(sentinel);
    });
});
