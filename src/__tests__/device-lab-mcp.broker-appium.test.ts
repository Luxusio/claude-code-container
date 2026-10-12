import { toolOperation } from "../../device-lab-mcp/src/tools.mjs";
import { callInternalBroker } from "./helpers/device-lab-mcp-fixture.js";
import { createServer } from "http";
import { mkdirSync, writeFileSync } from "fs";
import { AddressInfo } from "net";
import { homedir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeviceBrokerServer } from "@ccc/device-lab/device-lab-broker.js";
import { writeBrokerDevices } from "./helpers/host-broker-test-fixture.js";
import {
    cleanupDeviceLabMcpTestContext,
    createDeviceLabMcpTestContext,
    repoRoot,
    TIMEOUT,
    type DeviceLabMcpTestContext,
} from "./helpers/device-lab-mcp-fixture.js";

async function createFakeAppiumServer(sessionId = "MCP-BROKER-SESSION-1") {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    let activeAppBody: unknown = { value: { bundleId: "com.example.Test", name: "Test" } };
    let appStateBody: unknown = { value: 4 };
    const server = createServer((req, res) => {
        let raw = "";
        req.on("data", (chunk) => { raw += chunk; });
        req.on("end", () => {
            const body = raw ? JSON.parse(raw) : null;
            requests.push({ method: req.method || "GET", url: req.url || "/", body });
            res.writeHead(200, { "content-type": "application/json" });
            if (req.method === "GET" && req.url === "/status") return res.end(JSON.stringify({ value: { ready: true } }));
            if (req.method === "POST" && req.url === "/session") return res.end(JSON.stringify({ value: { sessionId } }));
            if (req.method === "GET" && req.url === `/session/${sessionId}`) return res.end(JSON.stringify({ value: { sessionId } }));
            if (req.method === "GET" && req.url === `/session/${sessionId}/source`) return res.end(JSON.stringify({ value: "<App><Text>Welcome</Text></App>" }));
            if (req.method === "POST" && req.url === `/session/${sessionId}/actions`) return res.end(JSON.stringify({ value: null }));
            if (req.method === "POST" && req.url === `/session/${sessionId}/keys`) return res.end(JSON.stringify({ value: null }));
            if (req.method === "POST" && req.url === `/session/${sessionId}/back`) return res.end(JSON.stringify({ value: null }));
            if (req.method === "POST" && req.url === `/session/${sessionId}/orientation`) return res.end(JSON.stringify({ value: null }));
            if (req.method === "POST" && req.url === `/session/${sessionId}/execute/sync`) {
                if (body && typeof body === "object" && (body as { script?: string }).script === "mobile: activeAppInfo") {
                    return res.end(JSON.stringify(activeAppBody));
                }
                return res.end(JSON.stringify({ value: null }));
            }
            if (req.method === "POST" && req.url === `/session/${sessionId}/appium/device/press_keycode`) return res.end(JSON.stringify({ value: null }));
            if (req.method === "GET" && req.url === `/session/${sessionId}/screenshot`) return res.end(JSON.stringify({ value: "iVBORw0KGgo=" }));
            if (req.method === "POST" && req.url === `/session/${sessionId}/url`) return res.end(JSON.stringify({ value: null }));
            if (req.method === "POST" && req.url === `/session/${sessionId}/appium/device/install_app`) return res.end(JSON.stringify({ value: null }));
            if (req.method === "POST" && req.url === `/session/${sessionId}/appium/device/activate_app`) return res.end(JSON.stringify({ value: null }));
            if (req.method === "POST" && req.url === `/session/${sessionId}/appium/device/remove_app`) return res.end(JSON.stringify({ value: null }));
            if (req.method === "POST" && req.url === `/session/${sessionId}/appium/device/terminate_app`) return res.end(JSON.stringify({ value: null }));
            if (req.method === "POST" && req.url === `/session/${sessionId}/appium/device/app_state`) return res.end(JSON.stringify(appStateBody));
            if (req.method === "POST" && req.url === `/session/${sessionId}/location`) return res.end(JSON.stringify({ value: null }));
            if (req.method === "POST" && req.url === `/session/${sessionId}/appium/device/set_clipboard`) return res.end(JSON.stringify({ value: null }));
            if (req.method === "POST" && req.url === `/session/${sessionId}/appium/device/get_clipboard`) return res.end(JSON.stringify({ value: Buffer.from("hello broker", "utf8").toString("base64") }));
            if (req.method === "DELETE" && req.url === `/session/${sessionId}`) return res.end(JSON.stringify({ value: null }));
            res.end(JSON.stringify({ value: null }));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    return {
        port: address.port,
        requests,
        setActiveAppBody: (body: unknown) => { activeAppBody = body; },
        setAppStateBody: (body: unknown) => { appStateBody = body; },
        close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    };
}

function pointerActionBody(requests: Array<{ method: string; url: string; body: unknown }>, sessionId: string, id: string) {
    return requests
        .filter((entry) => entry.method === "POST" && entry.url === `/session/${sessionId}/actions`)
        .map((entry) => entry.body as { actions?: Array<{ id?: string }> })
        .find((body) => body.actions?.some((action) => action.id === id));
}

function writeIosPhysicalAttachment(ownerId: string, deviceId: string, udid: string, appiumPort?: number) {
    const claimId = `${deviceId}-claim`;
    const claimNonce = `${deviceId}-nonce`;
    writeBrokerDevices(ownerId, "ios-device", [{
        id: deviceId,
        status: "attached",
        backend: "ios-device",
        udid,
        leaseClaimId: claimId,
        leaseClaimNonce: claimNonce,
        appium: null,
        ...(appiumPort ? { appiumPort } : {}),
    }]);
    const leaseDir = join(homedir(), ".ccc", "devices", "physical-leases", "ios-device", "locks");
    mkdirSync(leaseDir, { recursive: true });
    writeFileSync(join(leaseDir, `${encodeURIComponent(udid)}.json`), JSON.stringify({
        backend: "ios-device",
        hardwareId: udid,
        ownerId,
        deviceId,
        claimId,
        claimNonce,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
}

describe("device-lab MCP broker Appium routing", () => {
    let context: DeviceLabMcpTestContext;
    let client: DeviceLabMcpTestContext["client"];

    beforeAll(async () => {
        context = await createDeviceLabMcpTestContext({ defaultImplicitBroker: true });
        client = context.client;
    }, TIMEOUT);

    afterAll(async () => {
        await cleanupDeviceLabMcpTestContext(context);
    }, TIMEOUT);

    it("routes Appium session record, status, list, and clear through an explicit host broker", { timeout: TIMEOUT }, async () => {
        const server = createDeviceBrokerServer({
            cwd: repoRoot,
            host: "127.0.0.1",
            port: 0,
            startedAt: "2026-01-01T00:00:00.000Z",
            providerPaths: { appium: "/fake/appium" },
            commandRunner: vi.fn((command) => ({
                mode: command.mode,
                provider: command.provider,
                executable: command.executable,
                args: command.args,
                status: 0,
                pid: 45678,
                stdout: "",
                stderr: "",
            })),
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        const fakeAppium = await createFakeAppiumServer();
        const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
        try {
            const echo = await callInternalBroker(client, { operation: "brokerRpc",
                arguments: {
                    method: "broker.echo",
                    params: { ownerProbe: true },
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 5000,
                },
            });
            const echoPayload = JSON.parse(((echo.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                ok: boolean;
                ownerId: string;
            };
            expect(echoPayload.ok).toBe(true);
            writeIosPhysicalAttachment(echoPayload.ownerId, "iphone-owned", "REAL-UDID-1");

            const record = await callInternalBroker(client, { operation: "brokerAppium",
                arguments: {
                    action: "record",
                    backend: "ios-device",
                    deviceId: "iphone-owned",
                    appium: {
                        serverUrl: "http://127.0.0.1:8100",
                        sessionId: "IOS-REAL-SESSION-1",
                    },
                    serverPid: 34567,
                    appiumPort: 8100,
                    automationName: "XCUITest",
                    provider: "appium-xcuitest",
                    physical: true,
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 5000,
                },
            });
            expect(record.isError, JSON.stringify(record.content)).not.toBe(true);
            expect(JSON.parse(((record.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: true,
                method: "broker.appium.record",
                result: expect.objectContaining({
                    authority: "host-broker",
                    appium: expect.objectContaining({
                        sessionId: "IOS-REAL-SESSION-1",
                        port: 8100,
                        serverPid: 34567,
                        provider: "appium-xcuitest",
                        physical: true,
                    }),
                }),
            }));

            const status = await callInternalBroker(client, { operation: "brokerAppium",
                arguments: {
                    action: "status",
                    backend: "ios-device",
                    deviceId: "iphone-owned",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 5000,
                },
            });
            expect(JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: true,
                method: "broker.appium.status",
                result: expect.objectContaining({
                    appium: expect.objectContaining({ sessionId: "IOS-REAL-SESSION-1", authority: "host-broker" }),
                }),
            }));

            const list = await callInternalBroker(client, { operation: "brokerAppium",
                arguments: {
                    action: "list",
                    backend: "ios-device",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 5000,
                },
            });
            expect(JSON.parse(((list.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: true,
                method: "broker.appium.list",
                result: expect.objectContaining({
                    sessions: [expect.objectContaining({ deviceId: "iphone-owned", appium: expect.objectContaining({ sessionId: "IOS-REAL-SESSION-1" }) })],
                }),
            }));

            const clear = await callInternalBroker(client, { operation: "brokerAppium",
                arguments: {
                    action: "clear",
                    backend: "ios-device",
                    deviceId: "iphone-owned",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 5000,
                },
            });
            expect(JSON.parse(((clear.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: true,
                method: "broker.appium.clear",
                result: expect.objectContaining({ cleared: true, authority: "host-broker" }),
            }));

            const start = await callInternalBroker(client, { operation: "brokerAppium",
                arguments: {
                    action: "start",
                    backend: "ios-device",
                    deviceId: "iphone-owned",
                    appiumPort: fakeAppium.port,
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 5000,
                },
            });
            expect(JSON.parse(((start.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: true,
                method: "broker.appium.start",
                result: expect.objectContaining({
                    started: true,
                    session: null,
                    appium: expect.objectContaining({
                        serverUrl: `http://127.0.0.1:${fakeAppium.port}`,
                        serverPid: 45678,
                        port: fakeAppium.port,
                    }),
                }),
            }));

            const ensureSession = await callInternalBroker(client, { operation: "brokerAppium",
                arguments: {
                    action: "ensure-session",
                    backend: "ios-device",
                    deviceId: "iphone-owned",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 5000,
                },
            });
            expect(JSON.parse(((ensureSession.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: true,
                method: "broker.appium.session.ensure",
                result: expect.objectContaining({
                    created: true,
                    appium: expect.objectContaining({
                        sessionId: "MCP-BROKER-SESSION-1",
                        sessionCapabilities: expect.objectContaining({
                            platformName: "iOS",
                            "appium:automationName": "XCUITest",
                            "appium:udid": "REAL-UDID-1",
                            "appium:realDevice": true,
                        }),
                    }),
                }),
            }));

            const request = await callInternalBroker(client, { operation: "brokerAppium",
                arguments: {
                    action: "request",
                    backend: "ios-device",
                    deviceId: "iphone-owned",
                    method: "POST",
                    path: "/actions",
                    body: {
                        actions: [
                            {
                                type: "pointer",
                                id: "tap",
                                parameters: { pointerType: "touch" },
                                actions: [
                                    { type: "pointerMove", duration: 0, x: 1, y: 2 },
                                    { type: "pointerDown", button: 0 },
                                    { type: "pointerUp", button: 0 },
                                ],
                            },
                        ],
                    },
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 5000,
                },
            });
            expect(JSON.parse(((request.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: true,
                method: "broker.appium.request",
                result: expect.objectContaining({
                    path: "/actions",
                    response: expect.objectContaining({ ok: true }),
                }),
            }));

            const deleteSession = await callInternalBroker(client, { operation: "brokerAppium",
                arguments: {
                    action: "delete-session",
                    backend: "ios-device",
                    deviceId: "iphone-owned",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 5000,
                },
            });
            expect(JSON.parse(((deleteSession.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: true,
                method: "broker.appium.session.delete",
                result: expect.objectContaining({ deleted: true }),
            }));
            expect(fakeAppium.requests.map((entry) => `${entry.method} ${entry.url}`)).toEqual(expect.arrayContaining([
                "POST /session",
                "POST /session/MCP-BROKER-SESSION-1/actions",
                "DELETE /session/MCP-BROKER-SESSION-1",
            ]));

            const stop = await callInternalBroker(client, { operation: "brokerAppium",
                arguments: {
                    action: "stop",
                    backend: "ios-device",
                    deviceId: "iphone-owned",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 5000,
                },
            });
            expect(JSON.parse(((stop.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: true,
                method: "broker.appium.stop",
                result: expect.objectContaining({
                    stopped: true,
                    stalePid: false,
                    signal: expect.objectContaining({ attempted: false, ok: true, simulated: true }),
                }),
            }));
            expect(killSpy).not.toHaveBeenCalled();
        } finally {
            killSpy.mockRestore();
            await fakeAppium.close();
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("reports invalid Appium tool actions before contacting the broker", { timeout: TIMEOUT }, async () => {
        const result = await callInternalBroker(client, { operation: "brokerAppium",
            arguments: {
                action: "replace",
                backend: "android-emulator",
                deviceId: "pixel-owned",
                hostCandidates: ["127.0.0.1"],
                port: 9,
                timeoutMs: 50,
            },
        });
        expect(result.isError).toBe(true);
        expect(JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: false,
            error: "invalid-appium-action",
            allowed: ["status", "list", "record", "clear", "start", "stop", "ensure-session", "delete-session", "request"],
            attempts: [],
        }));
    });

    it("routes high-level mobile actions through broker-owned Appium WebDriver sessions", { timeout: TIMEOUT }, async () => {
        const server = createDeviceBrokerServer({
            cwd: repoRoot,
            host: "127.0.0.1",
            port: 0,
            startedAt: "2026-01-01T00:00:00.000Z",
            providerPaths: { appium: "/fake/appium" },
            commandRunner: vi.fn((command) => ({
                mode: command.mode,
                provider: command.provider,
                executable: command.executable,
                args: command.args,
                status: 0,
                pid: 56789,
                stdout: "",
                stderr: "",
            })),
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        const fakeAppium = await createFakeAppiumServer("MCP-HIGH-LEVEL-SESSION-1");
        try {
            const echo = await callInternalBroker(client, { operation: "brokerRpc",
                arguments: {
                    method: "broker.echo",
                    params: { ownerProbe: true },
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 5000,
                },
            });
            const echoPayload = JSON.parse(((echo.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                ok: boolean;
                ownerId: string;
            };
            expect(echoPayload.ok).toBe(true);
            writeIosPhysicalAttachment(echoPayload.ownerId, "iphone-broker-mobile", "REAL-UDID-2", fakeAppium.port);

            const baseArgs = {
                deviceId: "iphone-broker-mobile",
                viaBroker: true,
                hostCandidates: ["127.0.0.1"],
                port: address.port,
                timeoutMs: 5000,
                rpcTimeoutMs: 750,
            };
            const dump = await client.callTool({
                name: "ui",
                arguments: baseArgs,
            });
            expect(dump.isError).not.toBe(true);
            const dumpPayload = JSON.parse(((dump.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                broker?: { selected?: { timeoutMs?: number } };
            };
            expect(dumpPayload).toEqual(expect.objectContaining({
                provider: "broker-appium",
                backend: "ios-device",
                source: "<App><Text>Welcome</Text></App>",
                broker: expect.objectContaining({
                    ok: true,
                    method: "broker.appium.request",
                }),
            }));
            expect(dumpPayload.broker?.selected?.timeoutMs).toBe(750);

            const tap = await client.callTool({
                name: "click",
                arguments: { deviceId: baseArgs.deviceId, viaBroker: baseArgs.viaBroker, hostCandidates: baseArgs.hostCandidates, port: baseArgs.port, timeoutMs: baseArgs.timeoutMs, rpcTimeoutMs: baseArgs.rpcTimeoutMs, x: 40, y: 50 },
            });
            expect(JSON.parse(((tap.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                provider: "broker-appium",
                backend: "ios-device",
                requests: 1,
            }));
            for (const [name, args] of [
                ["click", { count: 2, x: 41, y: 51 }],
                ["long_press", { x: 42, y: 52, durationMs: 900 }],
                ["swipe", { x1: 10, y1: 20, x2: 110, y2: 120, durationMs: 350 }],
                ["drag", { x1: 11, y1: 21, x2: 111, y2: 121, durationMs: 950 }],
            ] as const) {
                const result = await client.callTool({ name, arguments: { deviceId: baseArgs.deviceId, viaBroker: baseArgs.viaBroker, hostCandidates: baseArgs.hostCandidates, port: baseArgs.port, timeoutMs: baseArgs.timeoutMs, rpcTimeoutMs: baseArgs.rpcTimeoutMs, ...args } });
                expect(result.isError, `${name}: ${JSON.stringify(result)}`).not.toBe(true);
                expect(JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                    provider: "broker-appium",
                    backend: "ios-device",
                    requests: 1,
                }));
            }
            const typed = await client.callTool({
                name: "type",
                arguments: { deviceId: baseArgs.deviceId, viaBroker: baseArgs.viaBroker, hostCandidates: baseArgs.hostCandidates, port: baseArgs.port, timeoutMs: baseArgs.timeoutMs, rpcTimeoutMs: baseArgs.rpcTimeoutMs, text: "hello" },
            });
            expect(JSON.parse(((typed.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                provider: "broker-appium",
                backend: "ios-device",
                requests: 1,
            }));
            const back = await client.callTool({
                name: "back",
                arguments: baseArgs,
            });
            expect(JSON.parse(((back.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                provider: "broker-appium",
                backend: "ios-device",
                requests: 1,
            }));
            const wait = await client.callTool({
                name: "wait_for_text",
                arguments: { deviceId: baseArgs.deviceId, viaBroker: baseArgs.viaBroker, hostCandidates: baseArgs.hostCandidates, port: baseArgs.port, timeoutMs: baseArgs.timeoutMs, rpcTimeoutMs: baseArgs.rpcTimeoutMs, text: "Welcome", intervalMs: 50 },
            });
            expect(JSON.parse(((wait.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                found: true,
                provider: "broker-appium",
                backend: "ios-device",
                source: "<App><Text>Welcome</Text></App>",
            }));

            expect(fakeAppium.requests.map((entry) => `${entry.method} ${entry.url}`)).toEqual(expect.arrayContaining([
                "POST /session",
                "GET /session/MCP-HIGH-LEVEL-SESSION-1/source",
                "POST /session/MCP-HIGH-LEVEL-SESSION-1/actions",
                "POST /session/MCP-HIGH-LEVEL-SESSION-1/keys",
                "POST /session/MCP-HIGH-LEVEL-SESSION-1/back",
            ]));
            expect(fakeAppium.requests.find((entry) => entry.url === "/session/MCP-HIGH-LEVEL-SESSION-1/actions")?.body).toEqual(expect.objectContaining({
                actions: [expect.objectContaining({
                    type: "pointer",
                    parameters: { pointerType: "touch" },
                })],
            }));
            expect(pointerActionBody(fakeAppium.requests, "MCP-HIGH-LEVEL-SESSION-1", "tap")).toEqual({
                actions: [{
                    type: "pointer",
                    id: "tap",
                    parameters: { pointerType: "touch" },
                    actions: [
                        { type: "pointerMove", duration: 0, x: 40, y: 50 },
                        { type: "pointerDown", button: 0 },
                        { type: "pointerUp", button: 0 },
                    ],
                }],
            });
            expect(pointerActionBody(fakeAppium.requests, "MCP-HIGH-LEVEL-SESSION-1", "doubleTap")).toEqual({
                actions: [{
                    type: "pointer",
                    id: "doubleTap",
                    parameters: { pointerType: "touch" },
                    actions: [
                        { type: "pointerMove", duration: 0, x: 41, y: 51 },
                        { type: "pointerDown", button: 0 },
                        { type: "pointerUp", button: 0 },
                        { type: "pause", duration: 80 },
                        { type: "pointerDown", button: 0 },
                        { type: "pointerUp", button: 0 },
                    ],
                }],
            });
            expect(pointerActionBody(fakeAppium.requests, "MCP-HIGH-LEVEL-SESSION-1", "longPress")).toEqual({
                actions: [{
                    type: "pointer",
                    id: "longPress",
                    parameters: { pointerType: "touch" },
                    actions: [
                        { type: "pointerMove", duration: 0, x: 42, y: 52 },
                        { type: "pointerDown", button: 0 },
                        { type: "pause", duration: 900 },
                        { type: "pointerUp", button: 0 },
                    ],
                }],
            });
            expect(pointerActionBody(fakeAppium.requests, "MCP-HIGH-LEVEL-SESSION-1", "swipe")).toEqual({
                actions: [{
                    type: "pointer",
                    id: "swipe",
                    parameters: { pointerType: "touch" },
                    actions: [
                        { type: "pointerMove", duration: 0, x: 10, y: 20 },
                        { type: "pointerDown", button: 0 },
                        { type: "pointerMove", duration: 350, x: 110, y: 120 },
                        { type: "pointerUp", button: 0 },
                    ],
                }],
            });
            expect(pointerActionBody(fakeAppium.requests, "MCP-HIGH-LEVEL-SESSION-1", "drag")).toEqual({
                actions: [{
                    type: "pointer",
                    id: "drag",
                    parameters: { pointerType: "touch" },
                    actions: [
                        { type: "pointerMove", duration: 0, x: 11, y: 21 },
                        { type: "pointerDown", button: 0 },
                        { type: "pointerMove", duration: 950, x: 111, y: 121 },
                        { type: "pointerUp", button: 0 },
                    ],
                }],
            });
            expect(fakeAppium.requests.find((entry) => entry.url === "/session/MCP-HIGH-LEVEL-SESSION-1/keys")?.body).toEqual({
                text: "hello",
                value: ["h", "e", "l", "l", "o"],
            });
        } finally {
            await fakeAppium.close();
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("routes iOS canonical device actions through native broker and mobile actions through Appium", { timeout: TIMEOUT }, async () => {
        let simulatorName = "";
        const deviceCalls: Array<{ tool: string; deviceId: string; params: Record<string, unknown> }> = [];
        const server = createDeviceBrokerServer({
            cwd: repoRoot,
            host: "127.0.0.1",
            port: 0,
            startedAt: "2026-01-01T00:00:00.000Z",
            deviceToolRunner: async (_ownerId, parsed) => {
                deviceCalls.push({ tool: parsed.tool, deviceId: String(parsed.deviceId), params: parsed.params });
                return { status: 200, payload: { ok: true, result: { mcpResult: {
                    isError: false,
                    content: parsed.tool === "device_screenshot"
                        ? [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }]
                        : [{ type: "text", text: JSON.stringify({ ok: true, provider: "native-fixture" }) }],
                } } } };
            },
            providerPaths: { appium: "/fake/appium", xcrun: "/fake/xcrun" },
            commandRunner: vi.fn((command) => ({
                mode: command.mode,
                provider: command.provider,
                executable: command.executable,
                args: command.args,
                status: 0,
                pid: 56791,
                stdout: command.provider === "xcrun" && command.args?.join(" ") === "simctl list devices -j"
                    ? JSON.stringify({ devices: { runtime: [{ name: simulatorName, udid: "SIM-UDID-1", state: "Booted" }] } })
                    : "",
                stderr: "",
            })),
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        const fakeAppium = await createFakeAppiumServer("MCP-IOS-APP-ACTIONS-SESSION-1");
        try {
            const echo = await callInternalBroker(client, { operation: "brokerRpc",
                arguments: {
                    method: "broker.echo",
                    params: { ownerProbe: true },
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 5000,
                },
            });
            const echoPayload = JSON.parse(((echo.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                ok: boolean;
                ownerId: string;
            };
            expect(echoPayload.ok).toBe(true);
            simulatorName = `ccc-${echoPayload.ownerId}-ios-sim-broker-apps`;
            writeBrokerDevices(echoPayload.ownerId, "ios", [
                { id: "ios-sim-broker-apps", status: "booted", backend: "ios-simulator", udid: "SIM-UDID-1", simulatorName, appium: null, appiumPort: fakeAppium.port },
            ]);

            const baseArgs = {
                deviceId: "ios-sim-broker-apps",
                viaBroker: true,
                hostCandidates: ["127.0.0.1"],
                port: address.port,
                timeoutMs: 5000,
            };
            const screenshot = await client.callTool({ name: "screenshot", arguments: baseArgs });
            expect(screenshot.isError, JSON.stringify(screenshot)).not.toBe(true);
            expect(screenshot.content).toEqual([{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }]);
            // Public screenshot selects the native device-tool envelope, not the private Appium mobile_screenshot branch.
            expect(deviceCalls).toContainEqual(expect.objectContaining({ tool: "device_screenshot", deviceId: "ios-sim-broker-apps" }));
            expect(fakeAppium.requests.some(request => request.url?.endsWith("/screenshot"))).toBe(false);

            for (const [name, args] of [
                ["open_url", { url: "https://example.test" }],
                ["install_app", { path: join(repoRoot, "Test.app") }],
                ["launch_app", { appId: "com.example.Test" }],
                ["stop_app", { appId: "com.example.Test" }],
                ["uninstall_app", { appId: "com.example.Test", confirmDestructive: true }],
                ["set_location", { latitude: 37.5, longitude: 127.0, altitude: 42 }],
                ["clipboard", { text: "hello broker" }],
            ] as const) {
                const result = await client.callTool({ name, arguments: { deviceId: baseArgs.deviceId, viaBroker: baseArgs.viaBroker, hostCandidates: baseArgs.hostCandidates, port: baseArgs.port, timeoutMs: baseArgs.timeoutMs, ...args } });
                expect(result.isError, `${name}: ${JSON.stringify(result)}`).not.toBe(true);
                const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}"));
                if (["install_app", "launch_app"].includes(name)) {
                    expect(payload).toEqual({ ok: true, provider: "native-fixture" });
                    expect(deviceCalls.at(-1)).toMatchObject({ tool: toolOperation(name), deviceId: baseArgs.deviceId, params: "appId" in args ? { packageName: args.appId, bundleId: args.appId } : args });
                } else {
                    expect(payload).toMatchObject({ provider: "broker-appium", backend: "ios-simulator", requests: 1 });
                }
            }

            expect(deviceCalls.map(call => call.tool.replace(/^device_/, ""))).toEqual([
                "screenshot", "install_app", "launch_app",
            ]);
            expect(deviceCalls[0]).toMatchObject({ deviceId: baseArgs.deviceId });
            const clipboard = await client.callTool({ name: "clipboard", arguments: baseArgs });
            expect(JSON.parse(((clipboard.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                provider: "broker-appium",
                backend: "ios-simulator",
                text: "hello broker",
            }));
            const waitForApp = await client.callTool({ name: "wait_for_app", arguments: { deviceId: baseArgs.deviceId, viaBroker: baseArgs.viaBroker, hostCandidates: baseArgs.hostCandidates, port: baseArgs.port, timeoutMs: baseArgs.timeoutMs, appId: "com.example.Test", intervalMs: 50 } });
            expect(JSON.parse(((waitForApp.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                found: true,
                provider: "broker-appium",
                backend: "ios-simulator",
                appId: "com.example.Test",
                activeApp: expect.objectContaining({ appId: "com.example.Test" }),
            }));

            for (const nativeBody of [
                { value: { bundleID: "com.example.Test", name: "alternate spelling" } },
                { bundleId: "com.example.Test", name: "body fallback" },
                { value: null, bundleID: "com.example.Test", name: "null value fallback" },
            ]) {
                fakeAppium.setActiveAppBody(nativeBody);
                const result = await client.callTool({ name: "wait_for_app", arguments: { ...baseArgs, appId: "com.example.Test", intervalMs: 50 } });
                const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}"));
                expect(payload).toMatchObject({ found: true, appId: "com.example.Test", provider: "broker-appium", backend: "ios-simulator" });
                expect(payload.activeApp).toMatchObject("bundleId" in nativeBody ? { appId: "com.example.Test" } : { bundleID: "com.example.Test" });
                expect(payload.broker).toMatchObject({ ok: true, selected: { host: "127.0.0.1", port: address.port } });
            }
            fakeAppium.setActiveAppBody({ value: { bundleId: "other", bundleID: "com.example.Test" } });
            const unmatched = await client.callTool({ name: "wait_for_app", arguments: { ...baseArgs, appId: "com.example.Test", timeoutMs: 500, intervalMs: 50 } });
            const unmatchedPayload = JSON.parse(((unmatched.content as Array<{ text?: string }>)[0].text ?? "{}"));
            expect(unmatchedPayload).toMatchObject({ found: false, appState: { bundleId: "other", bundleID: "com.example.Test" }, provider: "broker-appium", backend: "ios-simulator", timeoutMs: 500 });
            expect(unmatchedPayload.activeApp).toBeUndefined();

            expect(fakeAppium.requests.map((entry) => `${entry.method} ${entry.url}`)).toEqual(expect.arrayContaining([
                "POST /session/MCP-IOS-APP-ACTIONS-SESSION-1/url",
                "POST /session/MCP-IOS-APP-ACTIONS-SESSION-1/appium/device/terminate_app",
                "POST /session/MCP-IOS-APP-ACTIONS-SESSION-1/appium/device/remove_app",
                "POST /session/MCP-IOS-APP-ACTIONS-SESSION-1/location",
                "POST /session/MCP-IOS-APP-ACTIONS-SESSION-1/appium/device/set_clipboard",
                "POST /session/MCP-IOS-APP-ACTIONS-SESSION-1/appium/device/get_clipboard",
                "POST /session/MCP-IOS-APP-ACTIONS-SESSION-1/execute/sync",
            ]));
            expect(fakeAppium.requests.find((entry) => entry.url === "/session/MCP-IOS-APP-ACTIONS-SESSION-1/url")?.body).toEqual({ url: "https://example.test" });
            expect(fakeAppium.requests.find((entry) => entry.url === "/session/MCP-IOS-APP-ACTIONS-SESSION-1/location")?.body).toEqual({ location: { latitude: 37.5, longitude: 127, altitude: 42 } });
            expect(fakeAppium.requests.find((entry) => entry.url === "/session/MCP-IOS-APP-ACTIONS-SESSION-1/appium/device/set_clipboard")?.body).toEqual({
                content: Buffer.from("hello broker", "utf8").toString("base64"),
                contentType: "plaintext",
                label: "text",
            });
            expect(fakeAppium.requests.find((entry) => entry.url === "/session/MCP-IOS-APP-ACTIONS-SESSION-1/execute/sync")?.body).toEqual({
                script: "mobile: activeAppInfo",
                args: [],
            });
        } finally {
            await fakeAppium.close();
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("routes Android broker mobile key and device controls through Appium keycode and shell requests", { timeout: TIMEOUT }, async () => {
        const deviceCalls: Array<{ tool: string; params: Record<string, unknown> }> = [];
        const server = createDeviceBrokerServer({
            cwd: repoRoot,
            host: "127.0.0.1",
            port: 0,
            startedAt: "2026-01-01T00:00:00.000Z",
            deviceToolRunner: async (_ownerId, parsed) => {
                deviceCalls.push({ tool: parsed.tool, params: parsed.params });
                return { status: 200, payload: { ok: true, result: { mcpResult: {
                    isError: false,
                    content: [{ type: "text", text: JSON.stringify({ provider: "native-network-fixture", network: {
                        airplaneMode: parsed.params.airplaneMode ?? null,
                        wifi: parsed.params.wifi ?? null,
                        data: parsed.params.data ?? null,
                    } }) }],
                } } } };
            },
            providerPaths: { appium: "/fake/appium" },
            commandRunner: vi.fn((command) => ({
                mode: command.mode,
                provider: command.provider,
                executable: command.executable,
                args: command.args,
                status: 0,
                pid: 67890,
                stdout: "",
                stderr: "",
            })),
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        const fakeAppium = await createFakeAppiumServer("MCP-ANDROID-HIGH-LEVEL-SESSION-1");
        try {
            const echo = await callInternalBroker(client, { operation: "brokerRpc",
                arguments: {
                    method: "broker.echo",
                    params: { ownerProbe: true },
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 5000,
                },
            });
            const echoPayload = JSON.parse(((echo.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                ok: boolean;
                ownerId: string;
            };
            expect(echoPayload.ok).toBe(true);
            writeBrokerDevices(echoPayload.ownerId, "android", [
                { id: "android-broker-mobile", name: "Broker Pixel", status: "running", backend: "android-emulator", serial: "emulator-5554", appium: null, appiumPort: fakeAppium.port },
            ]);

            const baseArgs = {
                deviceId: "android-broker-mobile",
                broker: true,
                hostCandidates: ["127.0.0.1"],
                port: address.port,
                timeoutMs: 5000,
            };
            for (const [name, args] of [
                ["key", { keyCode: 82 }],
                ["forward", {}],
                ["recents", {}],
                ["power", {}],
                ["lock", {}],
                ["unlock", {}],
            ] as const) {
                const result = await client.callTool({ name, arguments: { deviceId: baseArgs.deviceId, broker: baseArgs.broker, hostCandidates: baseArgs.hostCandidates, port: baseArgs.port, timeoutMs: baseArgs.timeoutMs, ...args } });
                expect(result.isError, `${name}: ${JSON.stringify(result)}`).not.toBe(true);
                expect(JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                    provider: "broker-appium",
                    backend: "android-emulator",
                    requests: 1,
                }));
            }

            const reverse = await client.callTool({
                name: "set_orientation",
                arguments: { deviceId: baseArgs.deviceId, broker: baseArgs.broker, hostCandidates: baseArgs.hostCandidates, port: baseArgs.port, timeoutMs: baseArgs.timeoutMs, orientation: "reverse-landscape" },
            });
            expect(reverse.isError).not.toBe(true);
            expect(JSON.parse(((reverse.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                provider: "broker-appium",
                backend: "android-emulator",
                requests: 2,
            }));
            const deniedNetwork = await client.callTool({
                name: "set_network",
                arguments: { deviceId: baseArgs.deviceId, broker: baseArgs.broker, hostCandidates: baseArgs.hostCandidates, port: baseArgs.port, timeoutMs: baseArgs.timeoutMs, wifi: false },
            });
            expect(deniedNetwork.isError).toBe(true);
            expect(JSON.parse(((deniedNetwork.content as Array<{ text?: string }>)[0].text ?? "{}")).policy).toEqual(expect.objectContaining({
                error: "destructive-action-confirmation-required",
                actions: ["device-network-change"],
            }));

            const network = await client.callTool({
                name: "set_network",
                arguments: { deviceId: baseArgs.deviceId, broker: baseArgs.broker, hostCandidates: baseArgs.hostCandidates, port: baseArgs.port, timeoutMs: baseArgs.timeoutMs, wifi: false, data: true, confirmDestructive: true },
            });
            expect(network.isError).not.toBe(true);
            expect(JSON.parse(((network.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                provider: "native-network-fixture",
                network: { airplaneMode: null, wifi: false, data: true },
            }));

            const airplane = await client.callTool({
                name: "set_network",
                arguments: { deviceId: baseArgs.deviceId, broker: baseArgs.broker, hostCandidates: baseArgs.hostCandidates, port: baseArgs.port, timeoutMs: baseArgs.timeoutMs, airplaneMode: true, confirmDestructive: true },
            });
            expect(airplane.isError).not.toBe(true);
            expect(JSON.parse(((airplane.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                provider: "native-network-fixture",
                network: { airplaneMode: true, wifi: null, data: null },
            }));

            expect(deviceCalls).toEqual([
                { tool: "mobile_set_network", params: expect.objectContaining({ deviceId: baseArgs.deviceId, wifi: false, data: true, confirmDestructive: true }) },
                { tool: "mobile_set_network", params: expect.objectContaining({ deviceId: baseArgs.deviceId, airplaneMode: true, confirmDestructive: true }) },
            ]);

            const pressKeycodes = fakeAppium.requests
                .filter((entry) => entry.url === "/session/MCP-ANDROID-HIGH-LEVEL-SESSION-1/appium/device/press_keycode")
                .map((entry) => (entry.body as { keycode?: number }).keycode);
            expect(pressKeycodes).toEqual(expect.arrayContaining([82, 125, 187, 26, 223, 224]));
            const shellRequests = fakeAppium.requests.filter((entry) => entry.url === "/session/MCP-ANDROID-HIGH-LEVEL-SESSION-1/execute/sync");
            expect(shellRequests).toHaveLength(2);
            expect(shellRequests).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    body: { script: "mobile: shell", args: [{ command: "settings", args: ["put", "system", "accelerometer_rotation", "0"] }] },
                }),
                expect.objectContaining({
                    body: { script: "mobile: shell", args: [{ command: "settings", args: ["put", "system", "user_rotation", "3"] }] },
                }),
            ]));
        } finally {
            await fakeAppium.close();
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("routes Android canonical device actions through native broker and mobile actions through Appium", { timeout: TIMEOUT }, async () => {
        const deviceCalls: Array<{ tool: string; deviceId: string; params: Record<string, unknown> }> = [];
        const server = createDeviceBrokerServer({
            cwd: repoRoot,
            host: "127.0.0.1",
            port: 0,
            startedAt: "2026-01-01T00:00:00.000Z",
            deviceToolRunner: async (_ownerId, parsed) => {
                deviceCalls.push({ tool: parsed.tool, deviceId: String(parsed.deviceId), params: parsed.params });
                return { status: 200, payload: { ok: true, result: { mcpResult: {
                    isError: false,
                    content: parsed.tool === "device_screenshot"
                        ? [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }]
                        : [{ type: "text", text: JSON.stringify({ ok: true, provider: "native-fixture" }) }],
                } } } };
            },
            providerPaths: { appium: "/fake/appium" },
            commandRunner: vi.fn((command) => ({
                mode: command.mode,
                provider: command.provider,
                executable: command.executable,
                args: command.args,
                status: 0,
                pid: 67891,
                stdout: "",
                stderr: "",
            })),
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        const fakeAppium = await createFakeAppiumServer("MCP-ANDROID-APP-ACTIONS-SESSION-1");
        try {
            const echo = await callInternalBroker(client, { operation: "brokerRpc",
                arguments: {
                    method: "broker.echo",
                    params: { ownerProbe: true },
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 5000,
                },
            });
            const echoPayload = JSON.parse(((echo.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                ok: boolean;
                ownerId: string;
            };
            expect(echoPayload.ok).toBe(true);
            writeBrokerDevices(echoPayload.ownerId, "android", [
                { id: "android-broker-apps", name: "Broker Pixel Apps", status: "running", backend: "android-emulator", serial: "emulator-5556", appium: null, appiumPort: fakeAppium.port },
            ]);

            const baseArgs = {
                deviceId: "android-broker-apps",
                broker: true,
                hostCandidates: ["127.0.0.1"],
                port: address.port,
                timeoutMs: 5000,
            };
            const screenshot = await client.callTool({ name: "screenshot", arguments: baseArgs });
            expect(screenshot.isError, JSON.stringify(screenshot)).not.toBe(true);
            expect(screenshot.content).toEqual([{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }]);

            for (const [name, args] of [
                ["open_url", { url: "https://android.example.test" }],
                ["install_app", { path: join(repoRoot, "test.apk") }],
                ["launch_app", { appId: "com.example.android" }],
                ["launch_app", { component: "com.example.android/.MainActivity" }],
                ["stop_app", { appId: "com.example.android" }],
                ["uninstall_app", { appId: "com.example.android", confirmDestructive: true }],
                ["set_location", { latitude: 35.1, longitude: 129.2 }],
                ["clipboard", { text: "hello broker" }],
            ] as const) {
                const result = await client.callTool({ name, arguments: { deviceId: baseArgs.deviceId, broker: baseArgs.broker, hostCandidates: baseArgs.hostCandidates, port: baseArgs.port, timeoutMs: baseArgs.timeoutMs, ...args } });
                expect(result.isError, `${name}: ${JSON.stringify(result)}`).not.toBe(true);
                const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}"));
                if (["install_app", "launch_app"].includes(name)) {
                    expect(payload).toEqual({ ok: true, provider: "native-fixture" });
                    expect(deviceCalls.at(-1)).toMatchObject({ tool: toolOperation(name), deviceId: baseArgs.deviceId, params: "appId" in args ? { packageName: args.appId, bundleId: args.appId } : args });
                } else {
                    expect(payload).toMatchObject({ provider: "broker-appium", backend: "android-emulator", requests: 1 });
                }
            }

            expect(deviceCalls.map(call => call.tool.replace(/^device_/, ""))).toEqual([
                "screenshot", "install_app", "launch_app", "launch_app",
            ]);
            expect(deviceCalls[0]).toMatchObject({ deviceId: baseArgs.deviceId });
            const clipboard = await client.callTool({ name: "clipboard", arguments: baseArgs });
            expect(JSON.parse(((clipboard.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                provider: "broker-appium",
                backend: "android-emulator",
                text: "hello broker",
            }));
            const waitForApp = await client.callTool({ name: "wait_for_app", arguments: { deviceId: baseArgs.deviceId, broker: baseArgs.broker, hostCandidates: baseArgs.hostCandidates, port: baseArgs.port, timeoutMs: baseArgs.timeoutMs, appId: "com.example.android", intervalMs: 50 } });
            expect(JSON.parse(((waitForApp.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                found: true,
                provider: "broker-appium",
                backend: "android-emulator",
                appState: 4,
            }));

            for (const state of ["3", "4"]) {
                fakeAppium.setAppStateBody({ value: state });
                const result = await client.callTool({ name: "wait_for_app", arguments: { ...baseArgs, appId: "com.example.android", intervalMs: 50 } });
                expect(JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}"))).toMatchObject({ found: true, appState: state, provider: "broker-appium", backend: "android-emulator", broker: { ok: true, selected: { host: "127.0.0.1", port: address.port } } });
            }
            fakeAppium.setAppStateBody({ value: "2" });
            const background = await client.callTool({ name: "wait_for_app", arguments: { ...baseArgs, appId: "com.example.android", timeoutMs: 500, intervalMs: 50 } });
            expect(JSON.parse(((background.content as Array<{ text?: string }>)[0].text ?? "{}"))).toMatchObject({ found: false, appState: "2", timeoutMs: 500, provider: "broker-appium", backend: "android-emulator" });

            expect(fakeAppium.requests.map((entry) => `${entry.method} ${entry.url}`)).toEqual(expect.arrayContaining([
                "POST /session/MCP-ANDROID-APP-ACTIONS-SESSION-1/url",
                "POST /session/MCP-ANDROID-APP-ACTIONS-SESSION-1/appium/device/terminate_app",
                "POST /session/MCP-ANDROID-APP-ACTIONS-SESSION-1/appium/device/remove_app",
                "POST /session/MCP-ANDROID-APP-ACTIONS-SESSION-1/location",
                "POST /session/MCP-ANDROID-APP-ACTIONS-SESSION-1/appium/device/set_clipboard",
                "POST /session/MCP-ANDROID-APP-ACTIONS-SESSION-1/appium/device/get_clipboard",
                "POST /session/MCP-ANDROID-APP-ACTIONS-SESSION-1/appium/device/app_state",
            ]));
            expect(fakeAppium.requests.find((entry) => entry.url === "/session/MCP-ANDROID-APP-ACTIONS-SESSION-1/location")?.body).toEqual({ location: { latitude: 35.1, longitude: 129.2, altitude: 0 } });
            expect(fakeAppium.requests.find((entry) => entry.url === "/session/MCP-ANDROID-APP-ACTIONS-SESSION-1/appium/device/app_state")?.body).toEqual({ appId: "com.example.android" });
        } finally {
            await fakeAppium.close();
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("rejects unsupported broker mobile controls before starting a broker Appium session", { timeout: TIMEOUT }, async () => {
        const server = createDeviceBrokerServer({ cwd: repoRoot, host: "127.0.0.1", port: 0 });
        await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as AddressInfo).port;
        const echo = await callInternalBroker(client, { operation: "brokerRpc", arguments: { method: "broker.echo", params: {}, hostCandidates: ["127.0.0.1"], port, timeoutMs: 500 } });
        const owner = JSON.parse((echo.content as Array<{text: string}>)[0].text).ownerId;
        writeIosPhysicalAttachment(owner, "iphone-broker-mobile", "REAL-UDID-2");
        writeBrokerDevices(owner, "android-device", [{ id: "android-real-owned", backend: "android-device", serial: "physical-device" }]);
        try {

        const result = await client.callTool({
            name: "power",
            arguments: {
                deviceId: "iphone-broker-mobile",
                viaBroker: true,
                hostCandidates: ["127.0.0.1"],
                port,
                timeoutMs: 5000,
            },
        });
        expect(result.isError).toBe(true);
        expect((result.content as Array<{ text?: string }>)[0].text).toContain("mobile_power is only supported by Android broker routing");

        const clearData = await client.callTool({
            name: "clear_app_data",
            arguments: {
                deviceId: "iphone-broker-mobile",
                viaBroker: true,
                appId: "com.example.Test",
                confirmDestructive: true,
                hostCandidates: ["127.0.0.1"],
                port,
                timeoutMs: 5000,
            },
        });
        expect(clearData.isError).toBe(true);
        expect((clearData.content as Array<{ text?: string }>)[0].text).toContain("mobile_clear_app_data is not supported by iOS physical devices");

        const missingAppId = await client.callTool({
            name: "wait_for_app",
            arguments: {
                deviceId: "iphone-broker-mobile",
                viaBroker: true,
                hostCandidates: ["127.0.0.1"],
                port,
                timeoutMs: 5000,
            },
        });
        expect(missingAppId.isError).toBe(true);
        expect((missingAppId.content as Array<{ text?: string }>)[0].text).toContain("wait_for_app requires appId");

        const unsafePhysicalLocation = await client.callTool({
            name: "set_location",
            arguments: {
                deviceId: "android-real-owned",
                viaBroker: true,
                latitude: 1,
                longitude: 2,
                hostCandidates: ["127.0.0.1"],
                port,
                timeoutMs: 5000,
            },
        });
        expect(unsafePhysicalLocation.isError).toBe(true);
        expect((unsafePhysicalLocation.content as Array<{ text?: string }>)[0].text).toContain("Android real devices do not support mobile_set_location safely through broker routing");

        const unsafeIosPhysicalLocation = await client.callTool({
            name: "set_location",
            arguments: {
                deviceId: "iphone-broker-mobile",
                viaBroker: true,
                latitude: 1,
                longitude: 2,
                hostCandidates: ["127.0.0.1"],
                port,
                timeoutMs: 5000,
            },
        });
        expect(unsafeIosPhysicalLocation.isError).toBe(true);
        expect((unsafeIosPhysicalLocation.content as Array<{ text?: string }>)[0].text).toContain("iOS real devices do not support mobile_set_location safely through broker routing");
        } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }

    });

    it("fails high-level broker mobile actions before Appium when broker inventory has no owned device", { timeout: TIMEOUT }, async () => {
        const server = createDeviceBrokerServer({ cwd: repoRoot, host: "127.0.0.1", port: 0 });
        await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as AddressInfo).port;
        try {

        const result = await client.callTool({
            name: "ui",
            arguments: {
                deviceId: "not-owned-by-this-container",
                viaBroker: true,
                hostCandidates: ["127.0.0.1"],
                port,
                timeoutMs: 5000,
            },
        });
        expect(result.isError).toBe(true);
        expect(JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: false,
            error: "device-not-found",
            routedBy: "device-readonly-broker-implicit",
            deviceId: "not-owned-by-this-container",
        }));
        } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }

    });
});
