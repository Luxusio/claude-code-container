import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupFakeIosMcpContext, createFakeIosMcpContext, TIMEOUT, type FakeIosMcpContext } from "./helpers/fake-ios-mcp-fixture.js";

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
        }));
        const rejectLeased = await client.callTool({
            name: "device_attach",
            arguments: { backend: "ios-device", name: "Already Leased iPhone", udid: "00008101-00DEADBEEFCAFE00" },
        });
        expect(rejectLeased.isError).toBe(true);
        expect((rejectLeased.content as Array<{ text?: string }>)[0].text).toContain("already attached by another CCC owner");

        const rejectWifiNotNetworkVisible = await client.callTool({
            name: "device_attach",
            arguments: { backend: "ios-device", name: "USB As WiFi", udid: "00008110-001C195E0E91801E", connection: "wifi" },
        });
        expect(rejectWifiNotNetworkVisible.isError).toBe(true);
        expect((rejectWifiNotNetworkVisible.content as Array<{ text?: string }>)[0].text).toContain("requires the device to be paired for network use");

        const attach = await client.callTool({
            name: "device_attach",
            arguments: { backend: "ios-device", name: "Real iPhone", udid: "00008110-001C195E0E91801E" },
        });
        expect(attach.isError).not.toBe(true);
        const attached = JSON.parse(((attach.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; backend: string; physical: boolean; status: string; creatable: boolean };
        };
        expect(attached.device).toEqual(expect.objectContaining({
            id: "ios-device-real-iphone",
            backend: "ios-device",
            physical: true,
            connection: "usb",
            status: "attached",
            creatable: false,
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
            backend: { name: string; attachable: boolean };
            hostDevice: { udid: string };
            appium: { automationName: string; physical: boolean };
        };
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
        expect(realDump.isError).not.toBe(true);
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
        expect((realScreenshot.content as Array<{ type: string; mimeType: string }>)[0]).toEqual(expect.objectContaining({
            type: "image",
            mimeType: "image/png",
        }));

        const realMobileScreenshot = await client.callTool({
            name: "mobile_screenshot",
            arguments: { deviceId: "ios-device-real-iphone" },
        });
        expect(realMobileScreenshot.isError).not.toBe(true);
        expect((realMobileScreenshot.content as Array<{ type: string }>)[0].type).toBe("image");

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
        expect(realRecoveredDump.isError).not.toBe(true);
        const realRecoveredPayload = JSON.parse(((realRecoveredDump.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            sessionId: string;
        };
        expect(realRecoveredPayload.sessionId).toBe("IOS-SESSION-1");
        await new Promise((resolve) => setTimeout(resolve, 100));

        const iosRealActions = [
            ["mobile_tap", { deviceId: "ios-device-real-iphone", x: 10, y: 20 }],
            ["mobile_double_tap", { deviceId: "ios-device-real-iphone", x: 11, y: 21 }],
            ["mobile_long_press", { deviceId: "ios-device-real-iphone", x: 12, y: 22, durationMs: 900 }],
            ["mobile_swipe", { deviceId: "ios-device-real-iphone", x1: 10, y1: 20, x2: 30, y2: 40, durationMs: 250 }],
            ["mobile_drag", { deviceId: "ios-device-real-iphone", x1: 15, y1: 25, x2: 35, y2: 45, durationMs: 800 }],
            ["mobile_type_text", { deviceId: "ios-device-real-iphone", text: "hello real ios" }],
            ["mobile_key", { deviceId: "ios-device-real-iphone", key: "Return" }],
            ["mobile_home", { deviceId: "ios-device-real-iphone" }],
            ["mobile_lock", { deviceId: "ios-device-real-iphone" }],
            ["mobile_unlock", { deviceId: "ios-device-real-iphone" }],
            ["mobile_rotate_left", { deviceId: "ios-device-real-iphone" }],
            ["mobile_rotate_right", { deviceId: "ios-device-real-iphone" }],
            ["mobile_set_orientation", { deviceId: "ios-device-real-iphone", orientation: "LANDSCAPE" }],
            ["mobile_wait_for_text", { deviceId: "ios-device-real-iphone", text: "Test", timeoutMs: 1000, intervalMs: 50 }],
            ["mobile_wait_for_app", { deviceId: "ios-device-real-iphone", bundleId: "com.example.Real", timeoutMs: 1000, intervalMs: 50 }],
            ["mobile_stop_app", { deviceId: "ios-device-real-iphone", bundleId: "com.example.Real" }],
        ] as const;
        for (const [name, callArgs] of iosRealActions) {
            const action = await client.callTool({ name, arguments: callArgs });
            expect(action.isError, `${name}: ${(action.content as Array<{ text?: string }>)[0]?.text ?? ""}`).not.toBe(true);
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
        expect((invalidRealIosOrientation.content as Array<{ text?: string }>)[0].text).toContain("requires PORTRAIT or LANDSCAPE");

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
        expect(stop.isError).not.toBe(true);
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
});
