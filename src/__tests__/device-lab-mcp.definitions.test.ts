import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    cleanupDeviceLabMcpTestContext,
    createDeviceLabMcpTestContext,
    TIMEOUT,
    type DeviceLabMcpTestContext,
} from "./helpers/device-lab-mcp-fixture.js";

describe("device-lab MCP backend definitions", () => {
    let context: DeviceLabMcpTestContext;
    let client: DeviceLabMcpTestContext["client"];

    beforeAll(async () => {
        context = await createDeviceLabMcpTestContext();
        client = context.client;
    }, TIMEOUT);

    afterAll(async () => {
        await cleanupDeviceLabMcpTestContext(context);
    }, TIMEOUT);

    it("creates, lists, inspects, and deletes owner-scoped Android definitions", { timeout: TIMEOUT }, async () => {
        const create = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "android-emulator",
                name: "Pixel Test",
                avdName: "Pixel_Test_API_35",
                port: 5580,
            },
        });
        expect(create.isError).not.toBe(true);

        const created = JSON.parse(((create.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; avdName: string; serial: string; status: string };
        };
        expect(created.device).toEqual(expect.objectContaining({
            id: "android-pixel-test",
            avdName: "Pixel_Test_API_35",
            serial: "emulator-5580",
            status: "stopped",
        }));

        const list = await client.callTool({ name: "device_list", arguments: {} });
        const listed = JSON.parse(((list.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            devices: Array<{ id: string; backend?: string }>;
        };
        expect(listed.devices).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: "android-pixel-test", backend: "android-emulator" }),
        ]));

        const status = await client.callTool({
            name: "device_status",
            arguments: { deviceId: "android-pixel-test" },
        });
        expect(status.isError).not.toBe(true);
        const inspected = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string };
            backend: { status: string; missing: string[] };
        };
        expect(inspected.device.id).toBe("android-pixel-test");
        expect(inspected.backend.status).toBe("missing-prerequisites");
        expect(inspected.backend.missing).toEqual(["adb", "emulator"]);

        const mobileStatus = await client.callTool({
            name: "mobile_session_status",
            arguments: { deviceId: "android-pixel-test" },
        });
        expect(mobileStatus.isError).not.toBe(true);
        const mobile = JSON.parse(((mobileStatus.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            appium: { available: boolean; missing: string[] };
            session: unknown;
            lazy: boolean;
        };
        expect(mobile.lazy).toBe(true);
        expect(mobile.session).toBeNull();
        expect(mobile.appium.available).toBe(false);
        expect(mobile.appium.missing).toContain("adb");

        const tap = await client.callTool({
            name: "mobile_tap",
            arguments: { deviceId: "android-pixel-test", x: 10, y: 20 },
        });
        expect(tap.isError).toBe(true);
        expect((tap.content as Array<{ text?: string }>)[0].text).toContain("Android backend missing prerequisites: adb");

        const recordStatus = await client.callTool({
            name: "device_record_video_status",
            arguments: { deviceId: "android-pixel-test" },
        });
        expect(recordStatus.isError).not.toBe(true);
        expect(JSON.parse(((recordStatus.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            recording: null,
            provider: "adb-screenrecord",
        }));

        const recordStart = await client.callTool({
            name: "device_record_video_start",
            arguments: { deviceId: "android-pixel-test" },
        });
        expect(recordStart.isError).toBe(true);
        expect((recordStart.content as Array<{ text?: string }>)[0].text).toContain("Android backend missing prerequisites: adb");

        const start = await client.callTool({
            name: "device_start",
            arguments: { deviceId: "android-pixel-test" },
        });
        expect(start.isError).toBe(true);
        expect((start.content as Array<{ text?: string }>)[0].text).toContain("missing prerequisites");

        const deleted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "android-pixel-test" },
        });
        expect(deleted.isError).not.toBe(true);

        const afterDelete = await client.callTool({ name: "device_list", arguments: {} });
        const finalList = JSON.parse(((afterDelete.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            devices: Array<{ id: string }>;
        };
        expect(finalList.devices.map((device) => device.id)).not.toContain("android-pixel-test");
    });

    it("creates, lists, inspects, starts with diagnostics, and deletes owner-scoped iOS definitions", { timeout: TIMEOUT }, async () => {
        const create = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "ios-simulator",
                name: "iPhone Test",
                simulatorName: "iPhone 15",
                deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-15",
                runtime: "com.apple.CoreSimulator.SimRuntime.iOS-17-0",
            },
        });
        expect(create.isError).not.toBe(true);

        const created = JSON.parse(((create.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; simulatorName: string; status: string; platform: string };
        };
        expect(created.device).toEqual(expect.objectContaining({
            id: "ios-iphone-test",
            simulatorName: "iPhone 15",
            status: "stopped",
            platform: "ios",
        }));

        const list = await client.callTool({ name: "device_list", arguments: {} });
        const listed = JSON.parse(((list.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            devices: Array<{ id: string; backend?: string }>;
        };
        expect(listed.devices).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: "ios-iphone-test", backend: "ios-simulator" }),
        ]));

        const status = await client.callTool({
            name: "device_status",
            arguments: { deviceId: "ios-iphone-test" },
        });
        expect(status.isError).not.toBe(true);
        const inspected = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string };
            backend: { status: string; missing: string[] };
        };
        expect(inspected.device.id).toBe("ios-iphone-test");
        expect(inspected.backend.status).toBe("missing-prerequisites");
        expect(inspected.backend.missing).toEqual(["xcrun"]);

        const start = await client.callTool({
            name: "device_start",
            arguments: { deviceId: "ios-iphone-test" },
        });
        expect(start.isError).toBe(true);
        expect((start.content as Array<{ text?: string }>)[0].text).toContain("iOS Simulator backend missing prerequisites");

        const screenshot = await client.callTool({
            name: "device_screenshot",
            arguments: { deviceId: "ios-iphone-test" },
        });
        expect(screenshot.isError).toBe(true);
        expect((screenshot.content as Array<{ text?: string }>)[0].text).toContain("iOS Simulator backend missing prerequisites");

        const recordStatus = await client.callTool({
            name: "device_record_video_status",
            arguments: { deviceId: "ios-iphone-test" },
        });
        expect(recordStatus.isError).not.toBe(true);
        expect(JSON.parse(((recordStatus.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            recording: null,
            provider: "simctl-recordVideo",
        }));

        const recordStart = await client.callTool({
            name: "device_record_video_start",
            arguments: { deviceId: "ios-iphone-test" },
        });
        expect(recordStart.isError).toBe(true);
        expect((recordStart.content as Array<{ text?: string }>)[0].text).toContain("iOS Simulator backend missing prerequisites");

        const session = await client.callTool({
            name: "mobile_session_status",
            arguments: { deviceId: "ios-iphone-test" },
        });
        expect(session.isError).not.toBe(true);
        const sessionPayload = JSON.parse(((session.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            deviceId: string;
            appium: { available: boolean; missing: string[] };
            session: unknown;
            automationName: string;
            lazy: boolean;
        };
        expect(sessionPayload.deviceId).toBe("ios-iphone-test");
        expect(sessionPayload.automationName).toBe("XCUITest");
        expect(sessionPayload.session).toBeNull();
        expect(sessionPayload.lazy).toBe(true);
        expect(sessionPayload.appium.available).toBe(false);
        expect(sessionPayload.appium.missing).toEqual(expect.arrayContaining(["xcrun", "appium", "appium-xcuitest-driver", "xcodebuild"]));

        const dumpUi = await client.callTool({
            name: "mobile_dump_ui",
            arguments: { deviceId: "ios-iphone-test" },
        });
        expect(dumpUi.isError).toBe(true);
        expect((dumpUi.content as Array<{ text?: string }>)[0].text).toContain("iOS Appium/XCUITest layer missing prerequisites");

        const deleted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "ios-iphone-test" },
        });
        expect(deleted.isError).not.toBe(true);
    });

    it("creates, lists, inspects, starts with diagnostics, and deletes owner-scoped Windows Sandbox definitions", { timeout: TIMEOUT }, async () => {
        const create = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "windows-sandbox",
                name: "Win Test",
                networking: false,
                clipboard: false,
                vgpu: false,
                memoryMb: 4096,
            },
        });
        expect(create.isError).not.toBe(true);

        const created = JSON.parse(((create.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; status: string; platform: string; networking: boolean; helper: { status: string; guestScratchDir: string } };
        };
        expect(created.device).toEqual(expect.objectContaining({
            id: "windows-win-test",
            status: "stopped",
            platform: "windows",
            networking: false,
        }));
        expect(created.device.helper).toEqual(expect.objectContaining({
            status: "file-channel",
            guestScratchDir: "C:\\ccc\\scratch",
        }));

        const list = await client.callTool({ name: "device_list", arguments: {} });
        const listed = JSON.parse(((list.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            devices: Array<{ id: string; backend?: string }>;
        };
        expect(listed.devices).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: "windows-win-test", backend: "windows-sandbox" }),
        ]));

        const status = await client.callTool({
            name: "device_status",
            arguments: { deviceId: "windows-win-test" },
        });
        expect(status.isError).not.toBe(true);
        const inspected = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string };
            backend: { status: string; missing: string[] };
        };
        expect(inspected.device.id).toBe("windows-win-test");
        expect(inspected.backend.status).toBe("missing-prerequisites");
        expect(inspected.backend.missing).toEqual(["wsb"]);

        const inventory = await client.callTool({
            name: "device_inventory",
            arguments: { backend: "windows-sandbox" },
        });
        expect(inventory.isError).not.toBe(true);
        const inventoryPayload = JSON.parse(((inventory.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            devices: Array<{ id: string; helper: { status: string }; configPath: string }>;
            discovery: { available: boolean; missing: string[] };
            hostSandboxes: { lazy: boolean; missing: string[] };
        };
        expect(inventoryPayload.discovery).toEqual(expect.objectContaining({ available: false, missing: ["wsb"] }));
        expect(inventoryPayload.hostSandboxes).toEqual(expect.objectContaining({ lazy: true, missing: ["wsb"] }));
        expect(inventoryPayload.devices).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: "windows-win-test",
                helper: expect.objectContaining({ status: "file-channel" }),
                configPath: expect.stringContaining("windows-win-test.wsb"),
            }),
        ]));

        const start = await client.callTool({
            name: "device_start",
            arguments: { deviceId: "windows-win-test" },
        });
        expect(start.isError).toBe(true);
        expect((start.content as Array<{ text?: string }>)[0].text).toContain("Windows Sandbox backend missing prerequisites");

        const exec = await client.callTool({
            name: "device_exec",
            arguments: { deviceId: "windows-win-test", command: "whoami", helperTimeoutMs: 50 },
        });
        expect(exec.isError).toBe(true);
        expect((exec.content as Array<{ text?: string }>)[0].text).toContain("Windows Sandbox helper did not respond");

        const recordStatus = await client.callTool({
            name: "device_record_video_status",
            arguments: { deviceId: "windows-win-test" },
        });
        expect(recordStatus.isError).not.toBe(true);
        expect(JSON.parse(((recordStatus.content as Array<{ text?: string }>)[0].text ?? "{}")).recording).toBeNull();

        const deleted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "windows-win-test" },
        });
        expect(deleted.isError).not.toBe(true);
    });

    it("creates, lists, inspects, starts with diagnostics, and deletes owner-scoped macOS VM definitions", { timeout: TIMEOUT }, async () => {
        const create = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "macos-vm",
                name: "Mac Test",
                provider: "auto",
                image: "macos-restore-image",
                memoryMb: 8192,
                cpus: 4,
            },
        });
        expect(create.isError).not.toBe(true);

        const created = JSON.parse(((create.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: {
                id: string;
                status: string;
                platform: string;
                provider: string;
                providerPlan: { requestedProvider: string; selectedProvider: string | null; missing: string[]; helper: { status: string } };
            };
        };
        expect(created.device).toEqual(expect.objectContaining({
            id: "macos-mac-test",
            status: "stopped",
            platform: "macos",
            provider: "auto",
        }));
        expect(created.device.providerPlan).toEqual(expect.objectContaining({
            requestedProvider: "auto",
            selectedProvider: null,
            missing: ["macos-host"],
        }));
        expect(created.device.providerPlan.helper.status).toBe("planned");

        const list = await client.callTool({ name: "device_list", arguments: {} });
        const listed = JSON.parse(((list.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            devices: Array<{ id: string; backend?: string }>;
        };
        expect(listed.devices).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: "macos-mac-test", backend: "macos-vm" }),
        ]));

        const status = await client.callTool({
            name: "device_status",
            arguments: { deviceId: "macos-mac-test" },
        });
        expect(status.isError).not.toBe(true);
        const inspected = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string };
            backend: { status: string; missing: string[] };
        };
        expect(inspected.device.id).toBe("macos-mac-test");
        expect(inspected.backend.status).toBe("missing-prerequisites");
        expect(inspected.backend.missing).toEqual(["macos-host"]);

        const inventory = await client.callTool({
            name: "device_inventory",
            arguments: { backend: "macos-vm" },
        });
        expect(inventory.isError).not.toBe(true);
        const inventoryPayload = JSON.parse(((inventory.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            devices: Array<{ id: string; providerPlan: { missing: string[]; deferred: string[] } }>;
            discovery: { available: boolean; missing: string[] };
            hostVms: { lazy: boolean; missing: string[] };
        };
        expect(inventoryPayload.discovery).toEqual(expect.objectContaining({ available: false, missing: ["macos-host"] }));
        expect(inventoryPayload.hostVms).toEqual(expect.objectContaining({ lazy: true, missing: ["macos-host"] }));
        expect(inventoryPayload.devices).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: "macos-mac-test",
                providerPlan: expect.objectContaining({
                    missing: ["macos-host"],
                    deferred: ["guest-helper-auto-provisioning-requires-ssh"],
                }),
            }),
        ]));

        const start = await client.callTool({
            name: "device_start",
            arguments: { deviceId: "macos-mac-test" },
        });
        expect(start.isError).toBe(true);
        expect((start.content as Array<{ text?: string }>)[0].text).toContain("macOS VM backend missing prerequisites");

        const exec = await client.callTool({
            name: "device_exec",
            arguments: { deviceId: "macos-mac-test", command: "whoami" },
        });
        expect(exec.isError).toBe(true);
        expect((exec.content as Array<{ text?: string }>)[0].text).toContain("requires SSH bridge metadata");

        const recordStatus = await client.callTool({
            name: "device_record_video_status",
            arguments: { deviceId: "macos-mac-test" },
        });
        expect(recordStatus.isError).not.toBe(true);
        expect(JSON.parse(((recordStatus.content as Array<{ text?: string }>)[0].text ?? "{}")).recording).toBeNull();

        const deleted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "macos-mac-test" },
        });
        expect(deleted.isError).not.toBe(true);
    });
});
