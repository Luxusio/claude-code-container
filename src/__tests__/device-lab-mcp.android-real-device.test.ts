import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupFakeAndroidMcpContext, createFakeAndroidMcpContext, TIMEOUT, type FakeAndroidMcpContext } from "./helpers/fake-android-mcp-fixture.js";

describe("device-lab MCP Android real-device flows with fake SDK", () => {
    let context: FakeAndroidMcpContext;
    let client: FakeAndroidMcpContext["client"];
    let homeDir: string;
    let binDir: string;
    let logPath: string;

    beforeAll(async () => {
        context = await createFakeAndroidMcpContext();
        client = context.client;
        homeDir = context.homeDir;
        binDir = context.binDir;
        logPath = context.logPath;
    }, TIMEOUT);

    afterAll(async () => {
        await cleanupFakeAndroidMcpContext(context);
    }, TIMEOUT);

    it("attaches, uses, and detaches host-connected Android real devices without emulator lifecycle commands", { timeout: TIMEOUT }, async () => {
        const inventory = await client.callTool({
            name: "device_inventory",
            arguments: { backend: "android-device" },
        });
        expect(inventory.isError).not.toBe(true);
        const inventoryPayload = JSON.parse(((inventory.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            hostDevices: { devices: Array<{ serial: string; state: string; emulator: boolean; connection: string; details: { model?: string } }> };
        };
        expect(inventoryPayload.hostDevices.devices).toEqual(expect.arrayContaining([
            expect.objectContaining({ serial: "R5CREAL123", state: "device", emulator: false, connection: "usb", details: expect.objectContaining({ model: "Pixel_6" }) }),
            expect.objectContaining({ serial: "192.168.1.50:5555", state: "device", emulator: false, connection: "wifi" }),
            expect.objectContaining({ serial: "192.168.1.60:5555", state: "device", emulator: false, connection: "wifi" }),
            expect.objectContaining({ serial: "R5LEASED999", state: "device" }),
            expect.objectContaining({ serial: "UNAUTHORIZED", state: "unauthorized" }),
            expect.objectContaining({ serial: "emulator-5554", emulator: true }),
        ]));

        const wirelessStatus = await client.callTool({
            name: "device_wireless",
            arguments: { backend: "android-device" },
        });
        expect(wirelessStatus.isError).not.toBe(true);
        const wirelessStatusPayload = JSON.parse(((wirelessStatus.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            actions: string[];
            hostDevices: { devices: Array<{ serial: string; connection: string }> };
        };
        expect(wirelessStatusPayload.actions).toEqual(expect.arrayContaining(["usb-tcpip", "pair", "connect"]));
        expect(wirelessStatusPayload.hostDevices.devices).toEqual(expect.arrayContaining([
            expect.objectContaining({ serial: "192.168.1.50:5555", connection: "wifi" }),
        ]));

        const listBeforeWirelessPrepare = await client.callTool({ name: "device_list", arguments: {} });
        const listedBeforeWirelessPrepare = JSON.parse(((listBeforeWirelessPrepare.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            devices: Array<{ backend?: string }>;
        };
        expect(listedBeforeWirelessPrepare.devices.some((device) => device.backend === "android-device")).toBe(false);

        const usbTcpip = await client.callTool({
            name: "device_wireless",
            arguments: { backend: "android-device", action: "usb-tcpip", serial: "R5CREAL123", host: "192.168.1.50", port: 5555 },
        });
        expect(usbTcpip.isError).not.toBe(true);
        const usbTcpipPayload = JSON.parse(((usbTcpip.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ok: boolean;
            action: string;
            stateMutated: boolean;
            target: string;
            attachNext: { arguments: { host: string; port: number } };
        };
        expect(usbTcpipPayload).toEqual(expect.objectContaining({
            ok: true,
            action: "usb-tcpip",
            stateMutated: false,
            target: "192.168.1.50:5555",
        }));
        expect(usbTcpipPayload.attachNext.arguments).toEqual(expect.objectContaining({ host: "192.168.1.50", port: 5555 }));

        const pairConnect = await client.callTool({
            name: "device_wireless",
            arguments: {
                backend: "android-device",
                action: "pair",
                pairHost: "192.168.1.70",
                pairPort: 37099,
                pairingCode: "123456",
                host: "192.168.1.50",
                port: 5555,
            },
        });
        expect(pairConnect.isError).not.toBe(true);
        const pairConnectPayload = JSON.parse(((pairConnect.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ok: boolean;
            pairTarget: string;
            pair: { args: string[] };
            target: string;
            stateMutated: boolean;
        };
        expect(pairConnectPayload).toEqual(expect.objectContaining({
            ok: true,
            pairTarget: "192.168.1.70:37099",
            target: "192.168.1.50:5555",
            stateMutated: false,
        }));
        expect(pairConnectPayload.pair.args).toEqual(["pair", "192.168.1.70:37099", "[redacted]"]);

        const pairMissingConnectTarget = await client.callTool({
            name: "device_wireless",
            arguments: {
                backend: "android-device",
                action: "pair",
                pairHost: "192.168.1.70",
                pairPort: 37099,
                pairingCode: "123456",
                connect: true,
            },
        });
        expect(pairMissingConnectTarget.isError).toBe(true);
        const pairMissingConnectTargetPayload = JSON.parse((pairMissingConnectTarget.content as Array<{ text?: string }>)[0].text ?? "{}") as {
            error: string;
            pair: { args: string[] };
        };
        expect(pairMissingConnectTargetPayload.error).toBe("android-wireless-connect-requires-host");
        expect(pairMissingConnectTargetPayload.pair.args).toEqual(["pair", "192.168.1.70:37099", "[redacted]"]);

        const failedPair = await client.callTool({
            name: "device_wireless",
            arguments: { backend: "android-device", action: "pair", pairHost: "192.168.1.70", pairPort: 37099, pairingCode: "000000" },
        });
        expect(failedPair.isError).toBe(true);
        const failedPairPayload = JSON.parse((failedPair.content as Array<{ text?: string }>)[0].text ?? "{}") as {
            ok: boolean;
            error: string;
            command: { args: string[]; status: number; stderr: string };
        };
        expect(failedPairPayload).toEqual(expect.objectContaining({ ok: false, error: "android-wireless-pair-failed" }));
        expect(failedPairPayload.command).toEqual(expect.objectContaining({ status: 1, stderr: expect.stringContaining("Failed to pair") }));
        expect(failedPairPayload.command.args).toEqual(["pair", "192.168.1.70:37099", "[redacted]"]);

        const listAfterWirelessPrepare = await client.callTool({ name: "device_list", arguments: {} });
        const listedAfterWirelessPrepare = JSON.parse(((listAfterWirelessPrepare.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            devices: Array<{ backend?: string }>;
        };
        expect(listedAfterWirelessPrepare.devices.some((device) => device.backend === "android-device")).toBe(false);

        const androidLeaseDir = join(homeDir, ".ccc/devices/physical-leases/android-device/locks");
        mkdirSync(androidLeaseDir, { recursive: true });
        writeFileSync(join(androidLeaseDir, `${encodeURIComponent("R5LEASED999")}.json`), JSON.stringify({
            backend: "android-device",
            hardwareId: "R5LEASED999",
            ownerId: "other-owner",
            deviceId: "android-device-foreign",
        }));
        writeFileSync(join(androidLeaseDir, `${encodeURIComponent("192.168.1.52:5555")}.json`), JSON.stringify({
            backend: "android-device",
            hardwareId: "192.168.1.52:5555",
            ownerId: "other-owner",
            deviceId: "android-device-wifi-foreign",
        }));
        const rejectLeased = await client.callTool({
            name: "device_attach",
            arguments: { backend: "android-device", name: "Already Leased", serial: "R5LEASED999" },
        });
        expect(rejectLeased.isError).toBe(true);
        expect((rejectLeased.content as Array<{ text?: string }>)[0].text).toContain("already attached by another CCC owner");
        const rejectWifiLeased = await client.callTool({
            name: "device_attach",
            arguments: { backend: "android-device", name: "Already Leased WiFi", connection: "wifi", host: "192.168.1.52" },
        });
        expect(rejectWifiLeased.isError).toBe(true);
        expect((rejectWifiLeased.content as Array<{ text?: string }>)[0].text).toContain("already attached by another CCC owner");

        const rejectEmulator = await client.callTool({
            name: "device_attach",
            arguments: { backend: "android-device", name: "Bad Emulator", serial: "emulator-5554" },
        });
        expect(rejectEmulator.isError).toBe(true);
        expect((rejectEmulator.content as Array<{ text?: string }>)[0].text).toContain("Refusing to attach emulator serial");

        const rejectUnauthorized = await client.callTool({
            name: "device_attach",
            arguments: { backend: "android-device", name: "Unauthorized", serial: "UNAUTHORIZED" },
        });
        expect(rejectUnauthorized.isError).toBe(true);
        expect((rejectUnauthorized.content as Array<{ text?: string }>)[0].text).toContain("adb state is unauthorized");

        const rejectWifiMissingHost = await client.callTool({
            name: "device_attach",
            arguments: { backend: "android-device", name: "WiFi Missing Host", connection: "wifi" },
        });
        expect(rejectWifiMissingHost.isError).toBe(true);
        expect((rejectWifiMissingHost.content as Array<{ text?: string }>)[0].text).toContain("Android Wi-Fi attach requires host");

        const rejectWifiConnect = await client.callTool({
            name: "device_attach",
            arguments: { backend: "android-device", name: "WiFi Bad", connection: "wifi", host: "192.168.1.51" },
        });
        expect(rejectWifiConnect.isError).toBe(true);
        expect((rejectWifiConnect.content as Array<{ text?: string }>)[0].text).toContain("failed to connect");

        const attach = await client.callTool({
            name: "device_attach",
            arguments: { backend: "android-device", name: "Real Pixel", serial: "R5CREAL123" },
        });
        expect(attach.isError).not.toBe(true);
        const attached = JSON.parse(((attach.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; backend: string; serial: string; status: string; creatable: boolean; physical: boolean };
        };
        expect(attached.device).toEqual(expect.objectContaining({
            id: "android-device-real-pixel",
            backend: "android-device",
            serial: "R5CREAL123",
            connection: "usb",
            status: "attached",
            creatable: false,
            physical: true,
        }));

        const wifiAttach = await client.callTool({
            name: "device_attach",
            arguments: { backend: "android-device", name: "WiFi Pixel", connection: "wifi", host: "192.168.1.50", port: 5555 },
        });
        expect(wifiAttach.isError).not.toBe(true);
        const wifiAttached = JSON.parse(((wifiAttach.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; serial: string; connection: string; transport: { type: string; host: string; port: number } };
        };
        expect(wifiAttached.device).toEqual(expect.objectContaining({
            id: "android-device-wifi-pixel",
            serial: "192.168.1.50:5555",
            connection: "wifi",
            transport: expect.objectContaining({ type: "wifi", host: "192.168.1.50", port: 5555 }),
        }));
        const wifiSerialAttach = await client.callTool({
            name: "device_attach",
            arguments: { backend: "android-device", name: "WiFi Serial Pixel", serial: "192.168.1.60:5555" },
        });
        expect(wifiSerialAttach.isError).not.toBe(true);
        const wifiSerialAttached = JSON.parse(((wifiSerialAttach.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; serial: string; connection: string; transport: { type: string; host: string; port: number } };
        };
        expect(wifiSerialAttached.device).toEqual(expect.objectContaining({
            id: "android-device-wifi-serial-pixel",
            serial: "192.168.1.60:5555",
            connection: "wifi",
            transport: expect.objectContaining({ type: "wifi", host: "192.168.1.60", port: 5555 }),
        }));

        const duplicate = await client.callTool({
            name: "device_attach",
            arguments: { backend: "android-device", name: "Real Pixel Duplicate", serial: "R5CREAL123" },
        });
        expect(duplicate.isError).toBe(true);
        expect((duplicate.content as Array<{ text?: string }>)[0].text).toContain("Android serial already attached");

        const status = await client.callTool({
            name: "device_status",
            arguments: { deviceId: "android-device-real-pixel" },
        });
        expect(status.isError).not.toBe(true);
        const statusPayload = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            hostState: { stdout: string };
            backend: { name: string; attachable: boolean };
        };
        expect(statusPayload.hostState.stdout).toBe("device");
        expect(statusPayload.backend).toEqual(expect.objectContaining({ name: "android-device", attachable: true }));

        for (const [tool, args] of [
            ["device_exec", { deviceId: "android-device-real-pixel", command: "echo ok" }],
            ["mobile_tap", { deviceId: "android-device-real-pixel", x: 10, y: 20 }],
            ["mobile_back", { deviceId: "android-device-real-pixel" }],
            ["mobile_dump_ui", { deviceId: "android-device-real-pixel" }],
            ["mobile_wait_for_text", { deviceId: "android-device-real-pixel", text: "Hello", timeoutMs: 100, intervalMs: 50 }],
            ["device_install_app", { deviceId: "android-device-real-pixel", path: "/tmp/Real.apk" }],
            ["device_launch_app", { deviceId: "android-device-real-pixel", packageName: "com.example.real" }],
            ["device_screenshot", { deviceId: "android-device-real-pixel" }],
        ] as Array<[string, Record<string, unknown>]>) {
            const result = await client.callTool({ name: tool, arguments: args });
            expect(result.isError, tool).not.toBe(true);
        }

        const unsafeBattery = await client.callTool({
            name: "mobile_set_battery",
            arguments: { deviceId: "android-device-real-pixel", level: 10 },
        });
        expect(unsafeBattery.isError).toBe(true);
        expect((unsafeBattery.content as Array<{ text?: string }>)[0].text).toContain("Android real devices do not support mobile_set_battery safely");
        const unsafeLocation = await client.callTool({
            name: "mobile_set_location",
            arguments: { deviceId: "android-device-real-pixel", latitude: 37.7749, longitude: -122.4194 },
        });
        expect(unsafeLocation.isError).toBe(true);
        expect((unsafeLocation.content as Array<{ text?: string }>)[0].text).toContain("Android real devices do not support mobile_set_location safely");

        const stop = await client.callTool({
            name: "device_stop",
            arguments: { deviceId: "android-device-real-pixel" },
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
            arguments: { deviceId: "android-device-real-pixel" },
        });
        expect(detach.isError).not.toBe(true);
        expect(() => readFileSync(join(androidLeaseDir, `${encodeURIComponent("R5CREAL123")}.json`), "utf-8")).toThrow();
        const wifiDetach = await client.callTool({
            name: "device_detach",
            arguments: { deviceId: "android-device-wifi-pixel" },
        });
        expect(wifiDetach.isError).not.toBe(true);
        expect(() => readFileSync(join(androidLeaseDir, `${encodeURIComponent("192.168.1.50:5555")}.json`), "utf-8")).toThrow();
        const wifiSerialDetach = await client.callTool({
            name: "device_detach",
            arguments: { deviceId: "android-device-wifi-serial-pixel" },
        });
        expect(wifiSerialDetach.isError).not.toBe(true);
        expect(() => readFileSync(join(androidLeaseDir, `${encodeURIComponent("192.168.1.60:5555")}.json`), "utf-8")).toThrow();

        const list = await client.callTool({ name: "device_list", arguments: {} });
        const listed = JSON.parse(((list.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            devices: Array<{ id: string }>;
        };
        expect(listed.devices.some((device) => device.id === "android-device-real-pixel")).toBe(false);

        const log = readFileSync(logPath, "utf-8");
        expect(log).toContain("adb devices -l");
        expect(log).toContain("adb -s R5CREAL123 tcpip 5555");
        expect(log).toContain("adb pair 192.168.1.70:37099 123456");
        expect(log).toContain("adb pair 192.168.1.70:37099 000000");
        expect(log).toContain("adb connect 192.168.1.50:5555");
        expect(log).toContain("adb connect 192.168.1.51:5555");
        expect(log).not.toContain("adb connect 192.168.1.52:5555");
        expect(log).not.toContain("adb connect 192.168.1.60:5555");
        expect(log).toContain("adb -s R5CREAL123 get-state");
        expect(log).toContain("adb -s R5CREAL123 shell echo ok");
        expect(log).toContain("adb -s R5CREAL123 shell input tap 10 20");
        expect(log).toContain("adb -s R5CREAL123 shell input keyevent 4");
        expect(log).toContain("adb -s R5CREAL123 install -r /tmp/Real.apk");
        expect(log).toContain("adb -s R5CREAL123 shell monkey -p com.example.real 1");
        expect(log).toContain("adb -s R5CREAL123 exec-out screencap -p");
        expect(log).not.toContain("adb -s R5CREAL123 emu kill");
    });
});
