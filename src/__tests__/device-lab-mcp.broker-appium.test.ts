import { createServer } from "http";
import { mkdirSync, writeFileSync } from "fs";
import { AddressInfo } from "net";
import { homedir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeviceBrokerServer } from "../device-lab-broker.js";
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
                    return res.end(JSON.stringify({ value: { bundleId: "com.example.Test", name: "Test" } }));
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
            if (req.method === "POST" && req.url === `/session/${sessionId}/appium/device/app_state`) return res.end(JSON.stringify({ value: 4 }));
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
        close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    };
}

function pointerActionBody(requests: Array<{ method: string; url: string; body: unknown }>, sessionId: string, id: string) {
    return requests
        .filter((entry) => entry.method === "POST" && entry.url === `/session/${sessionId}/actions`)
        .map((entry) => entry.body as { actions?: Array<{ id?: string }> })
        .find((body) => body.actions?.some((action) => action.id === id));
}

function writeIosPhysicalAttachment(ownerId: string, deviceId: string, udid: string) {
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
            const echo = await client.callTool({
                name: "device_broker_rpc",
                arguments: {
                    method: "broker.echo",
                    params: { ownerProbe: true },
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            const echoPayload = JSON.parse(((echo.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                ok: boolean;
                ownerId: string;
            };
            expect(echoPayload.ok).toBe(true);
            writeIosPhysicalAttachment(echoPayload.ownerId, "iphone-owned", "REAL-UDID-1");

            const record = await client.callTool({
                name: "device_broker_appium",
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
                    timeoutMs: 500,
                },
            });
            expect(record.isError).not.toBe(true);
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

            const status = await client.callTool({
                name: "device_broker_appium",
                arguments: {
                    action: "status",
                    backend: "ios-device",
                    deviceId: "iphone-owned",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: true,
                method: "broker.appium.status",
                result: expect.objectContaining({
                    appium: expect.objectContaining({ sessionId: "IOS-REAL-SESSION-1", authority: "host-broker" }),
                }),
            }));

            const list = await client.callTool({
                name: "device_broker_appium",
                arguments: {
                    action: "list",
                    backend: "ios-device",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(JSON.parse(((list.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: true,
                method: "broker.appium.list",
                result: expect.objectContaining({
                    sessions: [expect.objectContaining({ deviceId: "iphone-owned", appium: expect.objectContaining({ sessionId: "IOS-REAL-SESSION-1" }) })],
                }),
            }));

            const clear = await client.callTool({
                name: "device_broker_appium",
                arguments: {
                    action: "clear",
                    backend: "ios-device",
                    deviceId: "iphone-owned",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(JSON.parse(((clear.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: true,
                method: "broker.appium.clear",
                result: expect.objectContaining({ cleared: true, authority: "host-broker" }),
            }));

            const start = await client.callTool({
                name: "device_broker_appium",
                arguments: {
                    action: "start",
                    backend: "ios-device",
                    deviceId: "iphone-owned",
                    appiumPort: fakeAppium.port,
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
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

            const ensureSession = await client.callTool({
                name: "device_broker_appium",
                arguments: {
                    action: "ensure-session",
                    backend: "ios-device",
                    deviceId: "iphone-owned",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
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

            const request = await client.callTool({
                name: "device_broker_appium",
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
                    timeoutMs: 500,
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

            const deleteSession = await client.callTool({
                name: "device_broker_appium",
                arguments: {
                    action: "delete-session",
                    backend: "ios-device",
                    deviceId: "iphone-owned",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
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

            const stop = await client.callTool({
                name: "device_broker_appium",
                arguments: {
                    action: "stop",
                    backend: "ios-device",
                    deviceId: "iphone-owned",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
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
        const result = await client.callTool({
            name: "device_broker_appium",
            arguments: {
                action: "replace",
                backend: "android-emulator",
                deviceId: "pixel-owned",
                hostCandidates: ["127.0.0.1"],
                port: 9,
                timeoutMs: 50,
            },
        });
        expect(result.isError).not.toBe(true);
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
            const echo = await client.callTool({
                name: "device_broker_rpc",
                arguments: {
                    method: "broker.echo",
                    params: { ownerProbe: true },
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            const echoPayload = JSON.parse(((echo.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                ok: boolean;
                ownerId: string;
            };
            expect(echoPayload.ok).toBe(true);
            writeIosPhysicalAttachment(echoPayload.ownerId, "iphone-broker-mobile", "REAL-UDID-2");

            const baseArgs = {
                deviceId: "iphone-broker-mobile",
                viaBroker: true,
                backend: "ios-device",
                appiumPort: fakeAppium.port,
                hostCandidates: ["127.0.0.1"],
                port: address.port,
                timeoutMs: 500,
                rpcTimeoutMs: 750,
            };
            const dump = await client.callTool({
                name: "mobile_dump_ui",
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
                name: "mobile_tap",
                arguments: { ...baseArgs, x: 40, y: 50 },
            });
            expect(JSON.parse(((tap.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                provider: "broker-appium",
                backend: "ios-device",
                requests: 1,
            }));
            for (const [name, args] of [
                ["mobile_double_tap", { x: 41, y: 51 }],
                ["mobile_long_press", { x: 42, y: 52, durationMs: 900 }],
                ["mobile_swipe", { x1: 10, y1: 20, x2: 110, y2: 120, durationMs: 350 }],
                ["mobile_drag", { x1: 11, y1: 21, x2: 111, y2: 121, durationMs: 950 }],
            ] as const) {
                const result = await client.callTool({ name, arguments: { ...baseArgs, ...args } });
                expect(result.isError).not.toBe(true);
                expect(JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                    provider: "broker-appium",
                    backend: "ios-device",
                    requests: 1,
                }));
            }
            const typed = await client.callTool({
                name: "mobile_type_text",
                arguments: { ...baseArgs, text: "hello" },
            });
            expect(JSON.parse(((typed.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                provider: "broker-appium",
                backend: "ios-device",
                requests: 1,
            }));
            const back = await client.callTool({
                name: "mobile_back",
                arguments: baseArgs,
            });
            expect(JSON.parse(((back.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                provider: "broker-appium",
                backend: "ios-device",
                requests: 1,
            }));
            const wait = await client.callTool({
                name: "mobile_wait_for_text",
                arguments: { ...baseArgs, text: "Welcome", intervalMs: 50 },
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

    it("routes iOS broker mobile app, screenshot, location, and clipboard actions through Appium", { timeout: TIMEOUT }, async () => {
        let simulatorName = "";
        const server = createDeviceBrokerServer({
            cwd: repoRoot,
            host: "127.0.0.1",
            port: 0,
            startedAt: "2026-01-01T00:00:00.000Z",
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
            const echo = await client.callTool({
                name: "device_broker_rpc",
                arguments: {
                    method: "broker.echo",
                    params: { ownerProbe: true },
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            const echoPayload = JSON.parse(((echo.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                ok: boolean;
                ownerId: string;
            };
            expect(echoPayload.ok).toBe(true);
            simulatorName = `ccc-${echoPayload.ownerId}-ios-sim-broker-apps`;
            writeBrokerDevices(echoPayload.ownerId, "ios", [
                { id: "ios-sim-broker-apps", status: "booted", backend: "ios-simulator", udid: "SIM-UDID-1", simulatorName, appium: null },
            ]);

            const baseArgs = {
                deviceId: "ios-sim-broker-apps",
                viaBroker: true,
                backend: "ios-simulator",
                appiumPort: fakeAppium.port,
                hostCandidates: ["127.0.0.1"],
                port: address.port,
                timeoutMs: 500,
            };
            const screenshot = await client.callTool({ name: "mobile_screenshot", arguments: baseArgs });
            expect(screenshot.isError).not.toBe(true);
            expect(screenshot.content).toEqual([{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }]);

            for (const [name, args] of [
                ["mobile_open_url", { url: "https://example.test" }],
                ["mobile_install_app", { path: "/host/apps/Test.app" }],
                ["mobile_launch_app", { bundleId: "com.example.Test" }],
                ["mobile_stop_app", { bundleId: "com.example.Test" }],
                ["mobile_uninstall_app", { bundleId: "com.example.Test", confirmDestructive: true }],
                ["mobile_set_location", { latitude: 37.5, longitude: 127.0, altitude: 42 }],
                ["mobile_set_clipboard", { text: "hello broker" }],
            ] as const) {
                const result = await client.callTool({ name, arguments: { ...baseArgs, ...args } });
                expect(result.isError).not.toBe(true);
                expect(JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                    provider: "broker-appium",
                    backend: "ios-simulator",
                    requests: 1,
                }));
            }

            const clipboard = await client.callTool({ name: "mobile_get_clipboard", arguments: baseArgs });
            expect(JSON.parse(((clipboard.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                provider: "broker-appium",
                backend: "ios-simulator",
                text: "hello broker",
            }));
            const waitForApp = await client.callTool({ name: "mobile_wait_for_app", arguments: { ...baseArgs, bundleId: "com.example.Test", intervalMs: 50 } });
            expect(JSON.parse(((waitForApp.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                found: true,
                provider: "broker-appium",
                backend: "ios-simulator",
                bundleId: "com.example.Test",
                activeApp: expect.objectContaining({ bundleId: "com.example.Test" }),
            }));

            expect(fakeAppium.requests.map((entry) => `${entry.method} ${entry.url}`)).toEqual(expect.arrayContaining([
                "GET /session/MCP-IOS-APP-ACTIONS-SESSION-1/screenshot",
                "POST /session/MCP-IOS-APP-ACTIONS-SESSION-1/url",
                "POST /session/MCP-IOS-APP-ACTIONS-SESSION-1/appium/device/install_app",
                "POST /session/MCP-IOS-APP-ACTIONS-SESSION-1/appium/device/activate_app",
                "POST /session/MCP-IOS-APP-ACTIONS-SESSION-1/appium/device/terminate_app",
                "POST /session/MCP-IOS-APP-ACTIONS-SESSION-1/appium/device/remove_app",
                "POST /session/MCP-IOS-APP-ACTIONS-SESSION-1/location",
                "POST /session/MCP-IOS-APP-ACTIONS-SESSION-1/appium/device/set_clipboard",
                "POST /session/MCP-IOS-APP-ACTIONS-SESSION-1/appium/device/get_clipboard",
                "POST /session/MCP-IOS-APP-ACTIONS-SESSION-1/execute/sync",
            ]));
            expect(fakeAppium.requests.find((entry) => entry.url === "/session/MCP-IOS-APP-ACTIONS-SESSION-1/url")?.body).toEqual({ url: "https://example.test" });
            expect(fakeAppium.requests.find((entry) => entry.url === "/session/MCP-IOS-APP-ACTIONS-SESSION-1/appium/device/install_app")?.body).toEqual({ appPath: "/host/apps/Test.app" });
            expect(fakeAppium.requests.find((entry) => entry.url === "/session/MCP-IOS-APP-ACTIONS-SESSION-1/appium/device/activate_app")?.body).toEqual({ appId: "com.example.Test" });
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
                pid: 67890,
                stdout: "",
                stderr: "",
            })),
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        const fakeAppium = await createFakeAppiumServer("MCP-ANDROID-HIGH-LEVEL-SESSION-1");
        try {
            const echo = await client.callTool({
                name: "device_broker_rpc",
                arguments: {
                    method: "broker.echo",
                    params: { ownerProbe: true },
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            const echoPayload = JSON.parse(((echo.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                ok: boolean;
                ownerId: string;
            };
            expect(echoPayload.ok).toBe(true);
            writeBrokerDevices(echoPayload.ownerId, "android", [
                { id: "android-broker-mobile", name: "Broker Pixel", status: "running", backend: "android-emulator", serial: "emulator-5554", appium: null },
            ]);

            const baseArgs = {
                deviceId: "android-broker-mobile",
                broker: true,
                backend: "android-emulator",
                appiumPort: fakeAppium.port,
                hostCandidates: ["127.0.0.1"],
                port: address.port,
                timeoutMs: 500,
            };
            for (const [name, args] of [
                ["mobile_key", { keyCode: 82 }],
                ["mobile_forward", {}],
                ["mobile_recents", {}],
                ["mobile_power", {}],
                ["mobile_lock", {}],
                ["mobile_unlock", {}],
            ] as const) {
                const result = await client.callTool({ name, arguments: { ...baseArgs, ...args } });
                expect(result.isError).not.toBe(true);
                expect(JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                    provider: "broker-appium",
                    backend: "android-emulator",
                    requests: 1,
                }));
            }

            const reverse = await client.callTool({
                name: "mobile_set_orientation",
                arguments: { ...baseArgs, orientation: "reverse-landscape" },
            });
            expect(reverse.isError).not.toBe(true);
            expect(JSON.parse(((reverse.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                provider: "broker-appium",
                backend: "android-emulator",
                requests: 2,
            }));
            const rotate = await client.callTool({
                name: "mobile_rotate_right",
                arguments: baseArgs,
            });
            expect(rotate.isError).not.toBe(true);
            expect(JSON.parse(((rotate.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                provider: "broker-appium",
                backend: "android-emulator",
                requests: 2,
            }));

            const deniedNetwork = await client.callTool({
                name: "mobile_set_network",
                arguments: { ...baseArgs, wifi: false },
            });
            expect(deniedNetwork.isError).toBe(true);
            expect(JSON.parse(((deniedNetwork.content as Array<{ text?: string }>)[0].text ?? "{}")).policy).toEqual(expect.objectContaining({
                error: "destructive-action-confirmation-required",
                actions: ["device-network-change"],
            }));

            const network = await client.callTool({
                name: "mobile_set_network",
                arguments: { ...baseArgs, wifi: false, data: true, confirmDestructive: true },
            });
            expect(network.isError).not.toBe(true);
            expect(JSON.parse(((network.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                provider: "broker-appium",
                backend: "android-emulator",
                requests: 2,
            }));

            const airplane = await client.callTool({
                name: "mobile_toggle_airplane_mode",
                arguments: { ...baseArgs, enabled: true, confirmDestructive: true },
            });
            expect(airplane.isError).not.toBe(true);
            expect(JSON.parse(((airplane.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                provider: "broker-appium",
                backend: "android-emulator",
                requests: 2,
            }));

            const pressKeycodes = fakeAppium.requests
                .filter((entry) => entry.url === "/session/MCP-ANDROID-HIGH-LEVEL-SESSION-1/appium/device/press_keycode")
                .map((entry) => (entry.body as { keycode?: number }).keycode);
            expect(pressKeycodes).toEqual(expect.arrayContaining([82, 125, 187, 26, 223, 224]));
            const shellRequests = fakeAppium.requests.filter((entry) => entry.url === "/session/MCP-ANDROID-HIGH-LEVEL-SESSION-1/execute/sync");
            expect(shellRequests).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    body: { script: "mobile: shell", args: [{ command: "settings", args: ["put", "system", "accelerometer_rotation", "0"] }] },
                }),
                expect.objectContaining({
                    body: { script: "mobile: shell", args: [{ command: "settings", args: ["put", "system", "user_rotation", "3"] }] },
                }),
                expect.objectContaining({
                    body: { script: "mobile: shell", args: [{ command: "svc", args: ["wifi", "disable"] }] },
                }),
                expect.objectContaining({
                    body: { script: "mobile: shell", args: [{ command: "svc", args: ["data", "enable"] }] },
                }),
                expect.objectContaining({
                    body: { script: "mobile: shell", args: [{ command: "settings", args: ["put", "global", "airplane_mode_on", "1"] }] },
                }),
                expect.objectContaining({
                    body: { script: "mobile: shell", args: [{ command: "am", args: ["broadcast", "-a", "android.intent.action.AIRPLANE_MODE", "--ez", "state", "true"] }] },
                }),
            ]));
        } finally {
            await fakeAppium.close();
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("routes Android broker mobile app, screenshot, location, and clipboard actions through Appium", { timeout: TIMEOUT }, async () => {
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
                pid: 67891,
                stdout: "",
                stderr: "",
            })),
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        const fakeAppium = await createFakeAppiumServer("MCP-ANDROID-APP-ACTIONS-SESSION-1");
        try {
            const echo = await client.callTool({
                name: "device_broker_rpc",
                arguments: {
                    method: "broker.echo",
                    params: { ownerProbe: true },
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            const echoPayload = JSON.parse(((echo.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                ok: boolean;
                ownerId: string;
            };
            expect(echoPayload.ok).toBe(true);
            writeBrokerDevices(echoPayload.ownerId, "android", [
                { id: "android-broker-apps", name: "Broker Pixel Apps", status: "running", backend: "android-emulator", serial: "emulator-5556", appium: null },
            ]);

            const baseArgs = {
                deviceId: "android-broker-apps",
                broker: true,
                backend: "android-emulator",
                appiumPort: fakeAppium.port,
                hostCandidates: ["127.0.0.1"],
                port: address.port,
                timeoutMs: 500,
            };
            const screenshot = await client.callTool({ name: "mobile_screenshot", arguments: baseArgs });
            expect(screenshot.isError).not.toBe(true);
            expect(screenshot.content).toEqual([{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }]);

            for (const [name, args] of [
                ["mobile_open_url", { url: "https://android.example.test" }],
                ["mobile_install_app", { path: "/host/apps/test.apk" }],
                ["mobile_launch_app", { packageName: "com.example.android" }],
                ["mobile_launch_app", { component: "com.example.android/.MainActivity" }],
                ["mobile_stop_app", { packageName: "com.example.android" }],
                ["mobile_uninstall_app", { packageName: "com.example.android", confirmDestructive: true }],
                ["mobile_set_location", { latitude: 35.1, longitude: 129.2 }],
                ["mobile_set_clipboard", { text: "hello broker" }],
            ] as const) {
                const result = await client.callTool({ name, arguments: { ...baseArgs, ...args } });
                expect(result.isError).not.toBe(true);
                expect(JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                    provider: "broker-appium",
                    backend: "android-emulator",
                    requests: 1,
                }));
            }

            const clipboard = await client.callTool({ name: "mobile_get_clipboard", arguments: baseArgs });
            expect(JSON.parse(((clipboard.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                provider: "broker-appium",
                backend: "android-emulator",
                text: "hello broker",
            }));
            const waitForApp = await client.callTool({ name: "mobile_wait_for_app", arguments: { ...baseArgs, packageName: "com.example.android", intervalMs: 50 } });
            expect(JSON.parse(((waitForApp.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                found: true,
                provider: "broker-appium",
                backend: "android-emulator",
                appState: 4,
            }));

            expect(fakeAppium.requests.map((entry) => `${entry.method} ${entry.url}`)).toEqual(expect.arrayContaining([
                "GET /session/MCP-ANDROID-APP-ACTIONS-SESSION-1/screenshot",
                "POST /session/MCP-ANDROID-APP-ACTIONS-SESSION-1/url",
                "POST /session/MCP-ANDROID-APP-ACTIONS-SESSION-1/appium/device/install_app",
                "POST /session/MCP-ANDROID-APP-ACTIONS-SESSION-1/appium/device/activate_app",
                "POST /session/MCP-ANDROID-APP-ACTIONS-SESSION-1/appium/device/terminate_app",
                "POST /session/MCP-ANDROID-APP-ACTIONS-SESSION-1/appium/device/remove_app",
                "POST /session/MCP-ANDROID-APP-ACTIONS-SESSION-1/execute/sync",
                "POST /session/MCP-ANDROID-APP-ACTIONS-SESSION-1/location",
                "POST /session/MCP-ANDROID-APP-ACTIONS-SESSION-1/appium/device/set_clipboard",
                "POST /session/MCP-ANDROID-APP-ACTIONS-SESSION-1/appium/device/get_clipboard",
                "POST /session/MCP-ANDROID-APP-ACTIONS-SESSION-1/appium/device/app_state",
            ]));
            expect(fakeAppium.requests.find((entry) => entry.url === "/session/MCP-ANDROID-APP-ACTIONS-SESSION-1/appium/device/activate_app")?.body).toEqual({ appId: "com.example.android" });
            expect(fakeAppium.requests.filter((entry) => entry.url === "/session/MCP-ANDROID-APP-ACTIONS-SESSION-1/execute/sync")).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    body: {
                        script: "mobile: shell",
                        args: [{ command: "am", args: ["start", "-n", "com.example.android/.MainActivity"] }],
                    },
                }),
            ]));
            expect(fakeAppium.requests.find((entry) => entry.url === "/session/MCP-ANDROID-APP-ACTIONS-SESSION-1/location")?.body).toEqual({ location: { latitude: 35.1, longitude: 129.2, altitude: 0 } });
            expect(fakeAppium.requests.find((entry) => entry.url === "/session/MCP-ANDROID-APP-ACTIONS-SESSION-1/appium/device/app_state")?.body).toEqual({ appId: "com.example.android" });
        } finally {
            await fakeAppium.close();
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("rejects unsupported broker mobile controls before starting a broker Appium session", { timeout: TIMEOUT }, async () => {
        const result = await client.callTool({
            name: "mobile_power",
            arguments: {
                deviceId: "iphone-broker-mobile",
                viaBroker: true,
                backend: "ios-device",
                hostCandidates: ["127.0.0.1"],
                port: 9,
                timeoutMs: 50,
            },
        });
        expect(result.isError).toBe(true);
        expect((result.content as Array<{ text?: string }>)[0].text).toContain("mobile_power is only supported by Android broker routing");

        const clearData = await client.callTool({
            name: "mobile_clear_app_data",
            arguments: {
                deviceId: "iphone-broker-mobile",
                viaBroker: true,
                backend: "ios-device",
                bundleId: "com.example.Test",
                confirmDestructive: true,
                hostCandidates: ["127.0.0.1"],
                port: 9,
                timeoutMs: 50,
            },
        });
        expect(clearData.isError).toBe(true);
        expect((clearData.content as Array<{ text?: string }>)[0].text).toContain("mobile_clear_app_data is not supported by iOS physical devices");

        const missingAppId = await client.callTool({
            name: "mobile_wait_for_app",
            arguments: {
                deviceId: "iphone-broker-mobile",
                viaBroker: true,
                backend: "ios-device",
                hostCandidates: ["127.0.0.1"],
                port: 9,
                timeoutMs: 50,
            },
        });
        expect(missingAppId.isError).toBe(true);
        expect((missingAppId.content as Array<{ text?: string }>)[0].text).toContain("mobile_wait_for_app requires bundleId");

        const unsafePhysicalLocation = await client.callTool({
            name: "mobile_set_location",
            arguments: {
                deviceId: "android-real-owned",
                viaBroker: true,
                backend: "android-device",
                latitude: 1,
                longitude: 2,
                hostCandidates: ["127.0.0.1"],
                port: 9,
                timeoutMs: 50,
            },
        });
        expect(unsafePhysicalLocation.isError).toBe(true);
        expect((unsafePhysicalLocation.content as Array<{ text?: string }>)[0].text).toContain("Android real devices do not support mobile_set_location safely through broker routing");

        const unsafeIosPhysicalLocation = await client.callTool({
            name: "mobile_set_location",
            arguments: {
                deviceId: "iphone-broker-mobile",
                viaBroker: true,
                backend: "ios-device",
                latitude: 1,
                longitude: 2,
                hostCandidates: ["127.0.0.1"],
                port: 9,
                timeoutMs: 50,
            },
        });
        expect(unsafeIosPhysicalLocation.isError).toBe(true);
        expect((unsafeIosPhysicalLocation.content as Array<{ text?: string }>)[0].text).toContain("iOS real devices do not support mobile_set_location safely through broker routing");
    });

    it("fails high-level broker mobile actions before contacting the broker when the owner device is unknown", { timeout: TIMEOUT }, async () => {
        const result = await client.callTool({
            name: "mobile_dump_ui",
            arguments: {
                deviceId: "not-owned-by-this-container",
                viaBroker: true,
                hostCandidates: ["127.0.0.1"],
                port: 9,
                timeoutMs: 50,
            },
        });
        expect(result.isError).not.toBe(true);
        expect(JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: false,
            error: "device-backend-not-found",
            routedBy: "mobile-broker-appium",
            deviceId: "not-owned-by-this-container",
            matches: [],
        }));
    });
});
