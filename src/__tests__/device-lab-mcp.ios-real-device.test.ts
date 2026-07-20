import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { handleIosRealTool } from "../../device-lab-mcp/src/backends/ios-device.mjs";
import { iosRealDeviceE2ECapability } from "../../scripts/real-tests/ios-e2e.ts";
import { cleanupFakeIosMcpContext, createFakeIosMcpContext, TIMEOUT, type FakeIosMcpContext } from "./helpers/fake-ios-mcp-fixture.js";

function parseToolJson(result: { content?: unknown }) {
    return JSON.parse((((result.content as Array<{ text?: string }> | undefined) ?? [])[0]?.text ?? "{}")) as Record<string, unknown>;
}

describe("device-lab MCP iOS real-device flows with fake xctrace/Appium", () => {
    let context: FakeIosMcpContext;
    let client: FakeIosMcpContext["client"];
    let homeDir: string;
    let binDir: string;
    let logPath: string;

    beforeAll(async () => {
        context = await createFakeIosMcpContext();
        client = context.client;
        homeDir = context.homeDir;
        binDir = context.binDir;
        logPath = context.logPath;
    }, TIMEOUT);

    afterAll(async () => {
        await cleanupFakeIosMcpContext(context);
    }, TIMEOUT);

    it("attaches, inspects, and detaches iOS real devices without simctl lifecycle commands", { timeout: TIMEOUT }, async () => {
        const inventory = await client.callTool({
            name: "device_inventory",
            arguments: { backend: "ios-device" },
        });
        expect(inventory.isError).not.toBe(true);
        const inventoryPayload = JSON.parse(((inventory.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            hostDevices: { devices: Array<{ name: string; udid: string; version: string; connection: string }> };
            discovery: { available: boolean };
        };
        expect(inventoryPayload.discovery.available).toBe(true);
        expect(inventoryPayload.hostDevices.devices).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: "Real iPhone", udid: "00008110-001C195E0E91801E", version: "17.5", connection: "usb" }),
            expect.objectContaining({ name: "Network Named USB iPhone", udid: "00008111-001C195E0E91801F", version: "17.5", connection: "usb" }),
            expect.objectContaining({ name: "Network iPhone", udid: "00008120-00AA00BB00CC00DD", version: "17.5", connection: "wifi" }),
        ]));
        expect(inventoryPayload.hostDevices.devices.some((device) => device.name.includes("Simulator"))).toBe(false);
        expect(inventoryPayload.hostDevices.devices.some((device) => device.name.includes("Mac"))).toBe(false);

        const wirelessStatus = await client.callTool({
            name: "device_wireless",
            arguments: { backend: "ios-device", udid: "00008120-00AA00BB00CC00DD" },
        });
        expect(wirelessStatus.isError).not.toBe(true);
        const wirelessStatusPayload = JSON.parse(((wirelessStatus.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ok: boolean;
            provider: string;
            networkVisible: boolean;
            selected: { udid: string; connection: string };
            supportedActions: string[];
            unsupportedActions: string[];
        };
        expect(wirelessStatusPayload).toEqual(expect.objectContaining({
            ok: true,
            provider: "xcrun-xctrace",
            networkVisible: true,
            selected: expect.objectContaining({ udid: "00008120-00AA00BB00CC00DD", connection: "wifi" }),
        }));
        expect(wirelessStatusPayload.supportedActions).toEqual(["status"]);
        expect(wirelessStatusPayload.unsupportedActions).toEqual(expect.arrayContaining(["pair", "connect"]));

        const networkNamedUsbStatus = await client.callTool({
            name: "device_wireless",
            arguments: { backend: "ios-device", udid: "00008111-001C195E0E91801F" },
        });
        expect(networkNamedUsbStatus.isError).not.toBe(true);
        const networkNamedUsbStatusPayload = JSON.parse(((networkNamedUsbStatus.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            networkVisible: boolean;
            selected: { name: string; connection: string };
        };
        expect(networkNamedUsbStatusPayload).toEqual(expect.objectContaining({
            networkVisible: false,
            selected: expect.objectContaining({ name: "Network Named USB iPhone", connection: "usb" }),
        }));

        const unsupportedIosPair = await client.callTool({
            name: "device_wireless",
            arguments: { backend: "ios-device", action: "pair", udid: "00008110-001C195E0E91801E" },
        });
        expect(unsupportedIosPair.isError).toBe(true);
        const unsupportedIosPairPayload = JSON.parse((unsupportedIosPair.content as Array<{ text?: string }>)[0].text ?? "{}") as {
            ok: boolean;
            error: string;
            networkVisible: boolean;
            attachFlow: string;
        };
        expect(unsupportedIosPairPayload).toEqual(expect.objectContaining({
            ok: false,
            error: "ios-wireless-pairing-requires-xcode-trust",
            networkVisible: false,
        }));
        expect(unsupportedIosPairPayload.attachFlow).toContain("device_inventory");

        const iosLeaseDir = join(homeDir, ".ccc/devices/physical-leases/ios-device/locks");
        mkdirSync(iosLeaseDir, { recursive: true });
        writeFileSync(join(iosLeaseDir, `${encodeURIComponent("00008101-00DEADBEEFCAFE00")}.json`), JSON.stringify({
            backend: "ios-device",
            hardwareId: "00008101-00DEADBEEFCAFE00",
            ownerId: "other-owner",
            deviceId: "ios-device-foreign",
            updatedAt: new Date().toISOString(),
            heartbeatAt: new Date().toISOString(),
            ttlMs: 60 * 60 * 1000,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }));
        const rejectLeased = await client.callTool({
            name: "device_attach",
            arguments: { backend: "ios-device", name: "Already Leased iPhone", udid: "00008101-00DEADBEEFCAFE00" },
        });
        expect(rejectLeased.isError).toBe(true);
        expect((rejectLeased.content as Array<{ text?: string }>)[0].text).toContain("already attached or an attach is in progress");

        const rejectWifiNotNetworkVisible = await client.callTool({
            name: "device_attach",
            arguments: { backend: "ios-device", name: "USB As WiFi", udid: "00008110-001C195E0E91801E", connection: "wifi" },
        });
        expect(rejectWifiNotNetworkVisible.isError).toBe(true);
        expect((rejectWifiNotNetworkVisible.content as Array<{ text?: string }>)[0].text).toContain("requires the device to be paired for network use");

        const rejectNetworkNamedUsbAsWifi = await client.callTool({
            name: "device_attach",
            arguments: { backend: "ios-device", name: "Network Named USB iPhone", udid: "00008111-001C195E0E91801F", connection: "wifi" },
        });
        expect(rejectNetworkNamedUsbAsWifi.isError).toBe(true);
        expect((rejectNetworkNamedUsbAsWifi.content as Array<{ text?: string }>)[0].text).toContain("requires the device to be paired for network use");

        const attach = await client.callTool({
            name: "device_attach",
            arguments: { backend: "ios-device", name: "Real iPhone", udid: "00008110-001C195E0E91801E" },
        });
        expect(attach.isError).not.toBe(true);
        const attached = JSON.parse(((attach.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; backend: string; physical: boolean; status: string; creatable: boolean; targetStatus: { targetKind: string; leaseState: { state: string; hardwareId: string } } };
        };
        expect(attached.device).toEqual(expect.objectContaining({
            id: "ios-device-real-iphone",
            backend: "ios-device",
            physical: true,
            connection: "usb",
            status: "attached",
            creatable: false,
            targetKind: "physical-device",
            runtimeState: "attached",
            targetStatus: expect.objectContaining({
                targetKind: "physical-device",
                creatable: false,
                attachable: true,
                runtimeState: "attached",
                readiness: { state: "ready" },
                leaseState: expect.objectContaining({ state: "owned", hardwareId: "00008110-001C195E0E91801E" }),
                sessionState: expect.objectContaining({ state: "none" }),
            }),
        }));

        const wifiAttach = await client.callTool({
            name: "device_attach",
            arguments: {
                backend: "ios-device",
                name: "Network iPhone",
                udid: "00008120-00AA00BB00CC00DD",
                connection: "wifi",
                host: "network-iphone.local",
            },
        });
        expect(wifiAttach.isError).not.toBe(true);
        const wifiAttached = JSON.parse(((wifiAttach.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; connection: string; transport: { type: string; host: string; visibleVia: string } };
        };
        expect(wifiAttached.device).toEqual(expect.objectContaining({
            id: "ios-device-network-iphone",
            connection: "wifi",
            transport: expect.objectContaining({ type: "wifi", host: "network-iphone.local", visibleVia: "xctrace" }),
        }));

        const duplicate = await client.callTool({
            name: "device_attach",
            arguments: { backend: "ios-device", name: "Duplicate iPhone", udid: "00008110-001C195E0E91801E" },
        });
        expect(duplicate.isError).toBe(true);
        expect((duplicate.content as Array<{ text?: string }>)[0].text).toContain("iOS UDID already attached");

        const status = await client.callTool({
            name: "device_status",
            arguments: { deviceId: "ios-device-real-iphone" },
        });
        expect(status.isError).not.toBe(true);
        const statusPayload = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { targetStatus: { targetKind: string; leaseState: { state: string; hardwareId: string } } };
            backend: { name: string; attachable: boolean };
            hostDevice: { udid: string };
            appium: { automationName: string; physical: boolean };
        };
        expect(statusPayload.device.targetStatus).toEqual(expect.objectContaining({
            targetKind: "physical-device",
            attachable: true,
            leaseState: expect.objectContaining({ state: "owned", hardwareId: "00008110-001C195E0E91801E" }),
        }));
        expect(statusPayload.backend).toEqual(expect.objectContaining({ name: "ios-device", attachable: true }));
        expect(statusPayload.hostDevice.udid).toBe("00008110-001C195E0E91801E");
        expect(statusPayload.appium).toEqual(expect.objectContaining({ automationName: "XCUITest", physical: true }));

        const realSession = await client.callTool({
            name: "mobile_session_status",
            arguments: { deviceId: "ios-device-real-iphone" },
        });
        expect(realSession.isError).not.toBe(true);
        const realSessionPayload = JSON.parse(((realSession.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            automationName: string;
            physical: boolean;
            session: unknown;
            appium: { available: boolean; missing: string[] };
        };
        expect(realSessionPayload).toEqual(expect.objectContaining({
            automationName: "XCUITest",
            physical: true,
            session: null,
        }));
        expect(realSessionPayload.appium.available).toBe(true);
        expect(realSessionPayload.appium.missing).toEqual([]);

        const realDump = await client.callTool({
            name: "mobile_dump_ui",
            arguments: { deviceId: "ios-device-real-iphone" },
        });
        expect(realDump.isError, JSON.stringify(realDump)).not.toBe(true);
        const realDumpPayload = JSON.parse(((realDump.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            provider: string;
            physical: boolean;
            source: string;
            sessionId: string;
            serverUrl: string;
        };
        expect(realDumpPayload).toEqual(expect.objectContaining({
            provider: "appium-xcuitest",
            physical: true,
            sessionId: "IOS-SESSION-1",
        }));
        expect(realDumpPayload.source).toContain("XCUIElementTypeApplication");

        const statusAfterRealDump = await client.callTool({
            name: "mobile_session_status",
            arguments: { deviceId: "ios-device-real-iphone" },
        });
        const statusAfterRealDumpPayload = JSON.parse(((statusAfterRealDump.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            session: { sessionId: string; serverUrl: string; physical: boolean };
        };
        expect(statusAfterRealDumpPayload.session).toEqual(expect.objectContaining({
            sessionId: "IOS-SESSION-1",
            serverUrl: realDumpPayload.serverUrl,
            physical: true,
        }));

        const realScreenshot = await client.callTool({
            name: "device_screenshot",
            arguments: { deviceId: "ios-device-real-iphone" },
        });
        expect(realScreenshot.isError).not.toBe(true);
        expect((realScreenshot.content as Array<{ type: string; data: string; mimeType: string }>)[0]).toEqual({
            type: "image",
            data: Buffer.from("fake-real-ios-png").toString("base64"),
            mimeType: "image/png",
        });

        const realMobileScreenshot = await client.callTool({
            name: "mobile_screenshot",
            arguments: { deviceId: "ios-device-real-iphone" },
        });
        expect(realMobileScreenshot.isError).not.toBe(true);
        expect((realMobileScreenshot.content as Array<{ type: string; data: string; mimeType: string }>)[0]).toEqual({
            type: "image",
            data: Buffer.from("fake-real-ios-png").toString("base64"),
            mimeType: "image/png",
        });

        const realInstall = await client.callTool({
            name: "mobile_install_app",
            arguments: { deviceId: "ios-device-real-iphone", path: "/tmp/Real.app" },
        });
        expect(realInstall.isError).not.toBe(true);
        const realInstallPayload = JSON.parse(((realInstall.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            installed: string;
            udid: string;
            provider: string;
        };
        expect(realInstallPayload).toEqual(expect.objectContaining({
            installed: "/tmp/Real.app",
            udid: "00008110-001C195E0E91801E",
            provider: "xcrun-devicectl",
        }));

        const realLaunch = await client.callTool({
            name: "device_launch_app",
            arguments: { deviceId: "ios-device-real-iphone", bundleId: "com.example.Real" },
        });
        expect(realLaunch.isError).not.toBe(true);
        const realLaunchPayload = JSON.parse(((realLaunch.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            launched: string;
            udid: string;
            provider: string;
        };
        expect(realLaunchPayload).toEqual(expect.objectContaining({
            launched: "com.example.Real",
            udid: "00008110-001C195E0E91801E",
            provider: "xcrun-devicectl",
        }));

        const missingInstallPath = await client.callTool({
            name: "device_install_app",
            arguments: { deviceId: "ios-device-real-iphone" },
        });
        expect(missingInstallPath.isError).toBe(true);
        expect((missingInstallPath.content as Array<{ text?: string }>)[0].text).toContain("requires path");

        const missingLaunchBundle = await client.callTool({
            name: "mobile_launch_app",
            arguments: { deviceId: "ios-device-real-iphone" },
        });
        expect(missingLaunchBundle.isError).toBe(true);
        expect((missingLaunchBundle.content as Array<{ text?: string }>)[0].text).toContain("requires bundleId");

        writeFileSync(join(homeDir, "stale-ios-session"), "1");
        const realRecoveredDump = await client.callTool({
            name: "mobile_dump_ui",
            arguments: { deviceId: "ios-device-real-iphone" },
        });
        expect(realRecoveredDump.isError, JSON.stringify(realRecoveredDump)).not.toBe(true);
        const realRecoveredPayload = JSON.parse(((realRecoveredDump.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            sessionId: string;
        };
        expect(realRecoveredPayload.sessionId).toBe("IOS-SESSION-1");
        const recoveredSession = await client.callTool({
            name: "mobile_session_status",
            arguments: { deviceId: "ios-device-real-iphone" },
        });
        const recoveredSessionPayload = JSON.parse(((recoveredSession.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            session: { runtimeId: string; processOwner: string; startedBy: string; serverPid: number; processIdentity: { pid: number; startToken: string; commandHash: string } };
        };
        expect(recoveredSessionPayload.session.runtimeId).toMatch(/^[0-9a-f-]{36}$/);
        expect(recoveredSessionPayload.session.processOwner).toBe("device-lab-mcp");
        expect(recoveredSessionPayload.session.startedBy).toBe("direct-provider");
        expect(recoveredSessionPayload.session.processIdentity).toEqual(expect.objectContaining({
            pid: recoveredSessionPayload.session.serverPid,
            startToken: expect.any(String),
            commandHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }));
        await new Promise((resolve) => setTimeout(resolve, 100));

        const iosRealActions: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
            ["mobile_tap", { deviceId: "ios-device-real-iphone", x: 10, y: 20 }, { provider: "appium-xcuitest", physical: true, tapped: { x: 10, y: 20 } }],
            ["mobile_double_tap", { deviceId: "ios-device-real-iphone", x: 11, y: 21 }, { provider: "appium-xcuitest", physical: true, doubleTapped: { x: 11, y: 21 } }],
            ["mobile_long_press", { deviceId: "ios-device-real-iphone", x: 12, y: 22, durationMs: 900 }, { provider: "appium-xcuitest", physical: true, longPressed: { x: 12, y: 22, durationMs: 900 } }],
            ["mobile_swipe", { deviceId: "ios-device-real-iphone", x1: 10, y1: 20, x2: 30, y2: 40, durationMs: 250 }, { provider: "appium-xcuitest", physical: true, swiped: { x1: 10, y1: 20, x2: 30, y2: 40, durationMs: 250 } }],
            ["mobile_drag", { deviceId: "ios-device-real-iphone", x1: 15, y1: 25, x2: 35, y2: 45, durationMs: 800 }, { provider: "appium-xcuitest", physical: true, dragged: { x1: 15, y1: 25, x2: 35, y2: 45, durationMs: 800 } }],
            ["mobile_type_text", { deviceId: "ios-device-real-iphone", text: "hello real ios" }, { provider: "appium-xcuitest", physical: true, typed: true }],
            ["mobile_key", { deviceId: "ios-device-real-iphone", key: "Return" }, { provider: "appium-xcuitest", physical: true, key: "Return" }],
            ["mobile_home", { deviceId: "ios-device-real-iphone" }, { provider: "appium-xcuitest", physical: true, home: true }],
            ["mobile_lock", { deviceId: "ios-device-real-iphone" }, { provider: "appium-xcuitest", physical: true, locked: true }],
            ["mobile_unlock", { deviceId: "ios-device-real-iphone" }, { provider: "appium-xcuitest", physical: true, unlocked: true }],
            ["mobile_rotate_left", { deviceId: "ios-device-real-iphone" }, { provider: "appium-xcuitest", physical: true, orientation: "LANDSCAPE" }],
            ["mobile_rotate_right", { deviceId: "ios-device-real-iphone" }, { provider: "appium-xcuitest", physical: true, orientation: "PORTRAIT" }],
            ["mobile_set_orientation", { deviceId: "ios-device-real-iphone", orientation: "reverse-landscape" }, { provider: "appium-xcuitest", physical: true, orientation: "LANDSCAPE" }],
            ["mobile_wait_for_text", { deviceId: "ios-device-real-iphone", text: "Test", timeoutMs: 1000, intervalMs: 50 }, { provider: "appium-xcuitest", physical: true, found: true, text: "Test" }],
            ["mobile_wait_for_app", { deviceId: "ios-device-real-iphone", bundleId: "com.example.Real", timeoutMs: 1000, intervalMs: 50 }, { provider: "appium-xcuitest", physical: true, found: true, bundleId: "com.example.Real", activeApp: { bundleId: "com.example.Real", name: "Real" } }],
            ["mobile_stop_app", { deviceId: "ios-device-real-iphone", bundleId: "com.example.Real" }, { provider: "appium-xcuitest", physical: true, stopped: "com.example.Real" }],
        ] as const;
        for (const [name, callArgs, expectedPayload] of iosRealActions) {
            const action = await client.callTool({ name, arguments: callArgs });
            expect(action.isError, `${name}: ${(action.content as Array<{ text?: string }>)[0]?.text ?? ""}`).not.toBe(true);
            expect(parseToolJson(action)).toEqual(expect.objectContaining(expectedPayload));
        }

        const missingRealIosKey = await client.callTool({
            name: "mobile_key",
            arguments: { deviceId: "ios-device-real-iphone" },
        });
        expect(missingRealIosKey.isError).toBe(true);
        expect((missingRealIosKey.content as Array<{ text?: string }>)[0].text).toContain("mobile_key requires key or keyCode");

        const invalidRealIosOrientation = await client.callTool({
            name: "mobile_set_orientation",
            arguments: { deviceId: "ios-device-real-iphone", orientation: "upside-down" },
        });
        expect(invalidRealIosOrientation.isError).toBe(true);
        expect((invalidRealIosOrientation.content as Array<{ text?: string }>)[0].text).toContain("requires portrait, landscape, reverse-portrait, or reverse-landscape");

        const unsupportedRealIosPower = await client.callTool({
            name: "mobile_power",
            arguments: { deviceId: "ios-device-real-iphone" },
        });
        expect(unsupportedRealIosPower.isError).toBe(true);
        expect((unsupportedRealIosPower.content as Array<{ text?: string }>)[0].text).toContain("unavailable or unsafe for physical devices");

        const stop = await client.callTool({
            name: "device_stop",
            arguments: { deviceId: "ios-device-real-iphone" },
        });
        expect(stop.isError, (stop.content as Array<{ text?: string }>)[0]?.text).not.toBe(true);
        const stopped = JSON.parse(((stop.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            physicalDevicePoweredOff: boolean;
            device: { status: string };
        };
        expect(stopped.physicalDevicePoweredOff).toBe(false);
        expect(stopped.device.status).toBe("attached");

        const detach = await client.callTool({
            name: "device_detach",
            arguments: { deviceId: "ios-device-real-iphone" },
        });
        expect(detach.isError).not.toBe(true);
        const wifiDetach = await client.callTool({
            name: "device_detach",
            arguments: { deviceId: "ios-device-network-iphone" },
        });
        expect(wifiDetach.isError).not.toBe(true);
        expect(() => readFileSync(join(iosLeaseDir, `${encodeURIComponent("00008110-001C195E0E91801E")}.json`), "utf-8")).toThrow();
        expect(() => readFileSync(join(iosLeaseDir, `${encodeURIComponent("00008120-00AA00BB00CC00DD")}.json`), "utf-8")).toThrow();

        const log = readFileSync(logPath, "utf-8");
        expect(log).toContain("xcrun xctrace list devices");
        expect(log).toContain("xcrun devicectl device install app --device 00008110-001C195E0E91801E /tmp/Real.app");
        expect(log).toContain("xcrun devicectl device process launch --device 00008110-001C195E0E91801E com.example.Real");
        expect(log).toContain('"appium:udid":"00008110-001C195E0E91801E"');
        expect(log).toContain('"appium:realDevice":true');
        expect(log).toContain("appium-command-body /session/IOS-SESSION-1/actions");
        expect(log).toContain('"gesture":"tap"');
        expect(log).toContain("hello real ios");
        expect(log).toContain('"script":"mobile: pressButton"');
        expect(log).toContain('"script":"mobile: activeAppInfo"');
        expect(log).toContain('"script":"mobile: terminateApp"');
        expect(log).toContain("appium-server-sigint ");
        expect(log.split("appium-http POST /session").length - 1).toBeGreaterThanOrEqual(2);
        expect(log).not.toContain("xcrun simctl shutdown 00008110-001C195E0E91801E");
    });

    it("preserves a same-id physical iOS attachment successor during stop and detach", { timeout: TIMEOUT }, async () => {
        const deviceId = "ios-real-state-generation";
        const attachedResult = await client.callTool({
            name: "device_attach",
            arguments: {
                backend: "ios-device",
                deviceId,
                name: "Generation iPhone",
                udid: "00008111-001C195E0E91801F",
            },
        });
        expect(attachedResult.isError, (attachedResult.content as Array<{ text?: string }>)[0]?.text).not.toBe(true);
        const attached = parseToolJson(attachedResult).device as Record<string, unknown>;
        const statePath = join(homeDir, ".ccc", "devices", "owners", String(attached.ownerId), "ios-device", "devices.json");
        const ensureSession = async () => {
            const session = await client.callTool({ name: "mobile_dump_ui", arguments: { backend: "ios-device", deviceId } });
            expect(session.isError, (session.content as Array<{ text?: string }>)[0]?.text).not.toBe(true);
        };
        const armConflict = (marker: string) => {
            const currentState = JSON.parse(readFileSync(statePath, "utf-8")) as { devices: Array<Record<string, unknown>> };
            const current = currentState.devices.find((device) => device.id === deviceId);
            expect(current?.appium).toBeTruthy();
            const successor = {
                ...current,
                name: `Successor ${marker}`,
                appium: null,
                successorMarker: marker,
                updatedAt: new Date().toISOString(),
            };
            writeFileSync(join(homeDir, "fake-ios-real-state-conflict.json"), JSON.stringify({ devices: currentState.devices.map((device) => device.id === deviceId ? successor : device) }, null, 2));
            writeFileSync(join(homeDir, "fake-ios-real-state-conflict-path"), statePath);
            return successor;
        };

        await ensureSession();
        const stopSuccessor = armConflict("stop");
        const stop = await client.callTool({ name: "device_stop", arguments: { backend: "ios-device", deviceId } });
        expect(stop.isError).toBe(true);
        expect((stop.content as Array<{ text?: string }>)[0]?.text).toContain("owner-device-state-conflict");
        expect((JSON.parse(readFileSync(statePath, "utf-8")) as { devices: Array<Record<string, unknown>> }).devices.find((device) => device.id === deviceId)).toEqual(stopSuccessor);

        await ensureSession();
        const detachSuccessor = armConflict("detach");
        const detach = await client.callTool({ name: "device_detach", arguments: { backend: "ios-device", deviceId } });
        expect(detach.isError).toBe(true);
        expect((detach.content as Array<{ text?: string }>)[0]?.text).toContain("owner-device-state-conflict");
        expect((JSON.parse(readFileSync(statePath, "utf-8")) as { devices: Array<Record<string, unknown>> }).devices.find((device) => device.id === deviceId)).toEqual(detachSuccessor);

        const cleanup = await client.callTool({ name: "device_detach", arguments: { backend: "ios-device", deviceId } });
        expect(cleanup.isError).not.toBe(true);
    });
});

describe("iOS real-device backend prerequisite boundaries", () => {
    it("requires exact xctrace UDID visibility for real-device E2E capability", () => {
        const homeDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-ios-e2e-capability-home-"));
        const binDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-ios-e2e-capability-bin-"));
        const oldHome = process.env.HOME;
        const oldPath = process.env.PATH;
        const oldUdid = process.env.CCC_REAL_IOS_DEVICE_UDID;
        const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
        try {
            const xcrunPath = join(binDir, "xcrun");
            writeFileSync(xcrunPath, `#!/bin/sh
if [ "$1" = "xctrace" ] && [ "$2" = "list" ] && [ "$3" = "devices" ]; then
  echo "Devices:"
  echo "Exact iPhone (17.5) (00008155-00AA00BB00CC00DD)"
  exit 0
fi
exit 1
`);
            chmodSync(xcrunPath, 0o755);
            process.env.HOME = homeDir;
            process.env.PATH = binDir;

            process.env.CCC_REAL_IOS_DEVICE_UDID = "00008155-00AA";
            expect(iosRealDeviceE2ECapability(2)).toEqual(expect.objectContaining({
                available: false,
                reason: expect.stringContaining("not visible to xctrace"),
            }));

            process.env.CCC_REAL_IOS_DEVICE_UDID = "  00008155-00AA00BB00CC00DD  ";
            expect(iosRealDeviceE2ECapability(2)).toEqual(expect.objectContaining({
                available: true,
                udid: "00008155-00AA00BB00CC00DD",
            }));
        } finally {
            platformSpy.mockRestore();
            if (oldHome === undefined) delete process.env.HOME;
            else process.env.HOME = oldHome;
            if (oldPath === undefined) delete process.env.PATH;
            else process.env.PATH = oldPath;
            if (oldUdid === undefined) delete process.env.CCC_REAL_IOS_DEVICE_UDID;
            else process.env.CCC_REAL_IOS_DEVICE_UDID = oldUdid;
            rmSync(homeDir, { recursive: true, force: true });
            rmSync(binDir, { recursive: true, force: true });
        }
    });

    it("allows physical attach/status inventory with xctrace even when xcodebuild is absent", async () => {
        const homeDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-ios-xctrace-only-home-"));
        const binDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-ios-xctrace-only-bin-"));
        const oldHome = process.env.HOME;
        const oldPath = process.env.PATH;
        try {
            const xcrunPath = join(binDir, "xcrun");
            writeFileSync(xcrunPath, `#!/bin/sh
if [ "$1" = "xctrace" ] && [ "$2" = "list" ] && [ "$3" = "devices" ]; then
  echo "Devices:"
  echo "Xcode-Lite iPhone (17.5) (00008155-00AA00BB00CC00DD)"
  exit 0
fi
exit 1
`);
            chmodSync(xcrunPath, 0o755);
            process.env.HOME = homeDir;
            process.env.PATH = binDir;

            const inventory = await handleIosRealTool("device_inventory", { backend: "ios-device" });
            expect(inventory?.isError).not.toBe(true);
            const inventoryPayload = JSON.parse(((inventory?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                discovery: { available: boolean; xcodebuild: string | null; missing: string[] };
                hostDevices: { devices: Array<{ udid: string }> };
            };
            expect(inventoryPayload.discovery).toEqual(expect.objectContaining({
                available: true,
                xcodebuild: null,
                missing: [],
            }));
            expect(inventoryPayload.hostDevices.devices).toEqual(expect.arrayContaining([
                expect.objectContaining({ udid: "00008155-00AA00BB00CC00DD" }),
            ]));

            const attach = await handleIosRealTool("device_attach", {
                backend: "ios-device",
                name: "Xcode Lite iPhone",
                udid: "00008155-00AA00BB00CC00DD",
            });
            expect(attach?.isError).not.toBe(true);
            const attached = JSON.parse(((attach?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                device: { id: string; status: string; udid: string };
            };
            expect(attached.device).toEqual(expect.objectContaining({
                id: "ios-device-xcode-lite-iphone",
                status: "attached",
                udid: "00008155-00AA00BB00CC00DD",
            }));

            const detach = await handleIosRealTool("device_detach", { deviceId: attached.device.id });
            expect(detach?.isError).not.toBe(true);
        } finally {
            if (oldHome === undefined) delete process.env.HOME;
            else process.env.HOME = oldHome;
            if (oldPath === undefined) delete process.env.PATH;
            else process.env.PATH = oldPath;
            rmSync(homeDir, { recursive: true, force: true });
            rmSync(binDir, { recursive: true, force: true });
        }
    });

    it("rejects physical iOS effects after the exact lease is lost", async () => {
        const homeDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-ios-lease-fence-home-"));
        const binDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-ios-lease-fence-bin-"));
        const oldHome = process.env.HOME;
        const oldPath = process.env.PATH;
        const udid = "00008166-00AA00BB00CC00DD";
        try {
            const xcrunPath = join(binDir, "xcrun");
            writeFileSync(xcrunPath, `#!/bin/sh
if [ "$1" = "xctrace" ]; then
  echo "Devices:"
  echo "Lease Fence iPhone (17.5) (${udid})"
  exit 0
fi
echo "unexpected xcrun effect" >> "${join(homeDir, "effects.log")}"
exit 0
`);
            chmodSync(xcrunPath, 0o755);
            process.env.HOME = homeDir;
            process.env.PATH = binDir;

            const attach = await handleIosRealTool("device_attach", { backend: "ios-device", name: "Lease Fence iPhone", udid });
            const attached = JSON.parse(((attach?.content as Array<{ text?: string }>)[0].text ?? "{}")) as { device: { id: string } };
            const leaseFile = join(homeDir, ".ccc", "devices", "physical-leases", "ios-device", "locks", `${encodeURIComponent(udid)}.json`);
            const ownedLease = readFileSync(leaseFile, "utf8");
            writeFileSync(leaseFile, JSON.stringify({
                backend: "ios-device",
                hardwareId: udid,
                ownerId: "foreign-owner",
                deviceId: "foreign-device",
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
            }));

            const start = await handleIosRealTool("device_start", { deviceId: attached.device.id });
            expect(start?.isError).toBe(true);
            expect((start?.content as Array<{ text?: string }>)[0].text).toContain("lease is not owned");
            const install = await handleIosRealTool("device_install_app", { deviceId: attached.device.id, path: "/tmp/Foreign.app" });
            expect(install?.isError).toBe(true);
            expect((install?.content as Array<{ text?: string }>)[0].text).toContain("lease is not owned");
            expect(() => readFileSync(join(homeDir, "effects.log"), "utf8")).toThrow();

            writeFileSync(leaseFile, ownedLease);
            const detach = await handleIosRealTool("device_detach", { deviceId: attached.device.id });
            expect(detach?.isError).not.toBe(true);
        } finally {
            if (oldHome === undefined) delete process.env.HOME;
            else process.env.HOME = oldHome;
            if (oldPath === undefined) delete process.env.PATH;
            else process.env.PATH = oldPath;
            rmSync(homeDir, { recursive: true, force: true });
            rmSync(binDir, { recursive: true, force: true });
        }
    });
});
