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
            name: "create_android_emulator",
            arguments: {

                name: "Pixel Test",
                avdName: "Pixel_Test_API_35",
                port: 5580,
            },
        });
        expect(create.isError).not.toBe(true);

        const created = JSON.parse(((create.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { deviceId: string; avdName: string; serial: string; status: string };
        };
        expect(created.device).toEqual(expect.objectContaining({
            deviceId: "android-pixel-test",
            avdName: "Pixel_Test_API_35",
            serial: "emulator-5580",
            status: "stopped",
        }));

        const list = await client.callTool({ name: "devices", arguments: {} });
        const listed = JSON.parse(((list.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            devices: Array<{ deviceId: string; backend?: string }>;
        };
        expect(listed.devices).toEqual(expect.arrayContaining([
            expect.objectContaining({ deviceId: "android-pixel-test", backend: "android-emulator" }),
        ]));

        const status = await client.callTool({
            name: "status",
            arguments: { deviceId: "android-pixel-test" },
        });
        expect(status.isError).not.toBe(true);
        const inspected = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { deviceId: string; targetKind: string; runtimeState: string; targetStatus: { readiness: { state: string }; leaseState: { state: string }; sessionState: { state: string } } };
            backend: { status: string; missing: string[] };
        };
        expect(inspected.device.deviceId).toBe("android-pixel-test");
        expect(inspected.device).toEqual(expect.objectContaining({
            targetKind: "virtual-device",
            runtimeState: "stopped",
            targetStatus: expect.objectContaining({
                targetKind: "virtual-device",
                creatable: true,
                attachable: false,
                runtimeState: "stopped",
                readiness: { state: "stopped" },
                leaseState: { state: "not-required" },
                sessionState: expect.objectContaining({ state: "none" }),
            }),
        }));
        expect(inspected.backend.status).toBe("missing-prerequisites");
        expect(inspected.backend.missing).toEqual(["adb", "emulator"]);

        const mobileStatus = await client.callTool({
            name: "status",
            arguments: { deviceId: "android-pixel-test" },
        });
        expect(mobileStatus.isError).not.toBe(true);
        const mobile = JSON.parse(((mobileStatus.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            appium: { available: boolean; missing: string[] };
            session: unknown;
            lazy: boolean;
        };
        expect(mobile.automation.lazy).toBe(true);
        expect(mobile.automation.session).toBeNull();
        expect(mobile.appium.available).toBe(false);
        expect(mobile.appium.missing).toContain("adb");

        const tap = await client.callTool({
            name: "click",
            arguments: { deviceId: "android-pixel-test", x: 10, y: 20 },
        });
        expect(tap.isError).toBe(true);
        expect((tap.content as Array<{ text?: string }>)[0].text).toContain("Android backend missing prerequisites: adb");

        const recordStatus = await client.callTool({
            name: "record_video",
            arguments: { action: "status", deviceId: "android-pixel-test" },
        });
        expect(recordStatus.isError).not.toBe(true);
        expect(JSON.parse(((recordStatus.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            recording: null,
            provider: "adb-screenrecord",
        }));

        const recordStart = await client.callTool({
            name: "record_video",
            arguments: { action: "start", deviceId: "android-pixel-test" },
        });
        expect(recordStart.isError).toBe(true);
        expect((recordStart.content as Array<{ text?: string }>)[0].text).toContain("Android backend missing prerequisites: adb");

        const start = await client.callTool({
            name: "start",
            arguments: { deviceId: "android-pixel-test" },
        });
        expect(start.isError).toBe(true);
        expect((start.content as Array<{ text?: string }>)[0].text).toContain("missing prerequisites");

        const deleted = await client.callTool({
            name: "delete",
            arguments: { deviceId: "android-pixel-test", confirmDestructive: true },
        });
        expect(deleted.isError).not.toBe(true);

        const afterDelete = await client.callTool({ name: "devices", arguments: {} });
        const finalList = JSON.parse(((afterDelete.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            devices: Array<{ deviceId: string }>;
        };
        expect(finalList.devices.map((device) => device.deviceId)).not.toContain("android-pixel-test");
    });

    it("creates, lists, inspects, starts with diagnostics, and deletes owner-scoped iOS definitions", { timeout: TIMEOUT }, async () => {
        const create = await client.callTool({
            name: "create_ios_simulator",
            arguments: {

                name: "iPhone Test",
                simulatorName: "iPhone 15",
                udid: "existing-ios-fixture",
            },
        });
        expect(create.isError).not.toBe(true);

        const created = JSON.parse(((create.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { deviceId: string; simulatorName: string; status: string; platform: string };
        };
        expect(created.device).toEqual(expect.objectContaining({
            deviceId: "ios-iphone-test",
            simulatorName: "iPhone 15",
            status: "stopped",
            platform: "ios",
        }));

        const list = await client.callTool({ name: "devices", arguments: {} });
        const listed = JSON.parse(((list.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            devices: Array<{ deviceId: string; backend?: string }>;
        };
        expect(listed.devices).toEqual(expect.arrayContaining([
            expect.objectContaining({ deviceId: "ios-iphone-test", backend: "ios-simulator" }),
        ]));

        const status = await client.callTool({
            name: "status",
            arguments: { deviceId: "ios-iphone-test" },
        });
        expect(status.isError).not.toBe(true);
        const inspected = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { deviceId: string; targetStatus: { runtimeState: string; readiness: { state: string } } };
            backend: { status: string; missing: string[] };
        };
        expect(inspected.device.deviceId).toBe("ios-iphone-test");
        expect(inspected.device.targetStatus).toEqual(expect.objectContaining({
            targetKind: "virtual-device",
            creatable: true,
            attachable: false,
            runtimeState: "stopped",
            readiness: { state: "stopped" },
            leaseState: { state: "not-required" },
        }));
        expect(inspected.backend.status).toBe("missing-prerequisites");
        expect(inspected.backend.missing).toEqual(["xcrun"]);

        const start = await client.callTool({
            name: "start",
            arguments: { deviceId: "ios-iphone-test" },
        });
        expect(start.isError).toBe(true);
        expect((start.content as Array<{ text?: string }>)[0].text).toContain("iOS Simulator backend missing prerequisites");

        const screenshot = await client.callTool({
            name: "screenshot",
            arguments: { deviceId: "ios-iphone-test" },
        });
        expect(screenshot.isError).toBe(true);
        expect((screenshot.content as Array<{ text?: string }>)[0].text).toContain("iOS Simulator backend missing prerequisites");

        const recordStatus = await client.callTool({
            name: "record_video",
            arguments: { action: "status", deviceId: "ios-iphone-test" },
        });
        expect(recordStatus.isError).not.toBe(true);
        expect(JSON.parse(((recordStatus.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            recording: null,
            provider: "simctl-recordVideo",
        }));

        const recordStart = await client.callTool({
            name: "record_video",
            arguments: { action: "start", deviceId: "ios-iphone-test" },
        });
        expect(recordStart.isError).toBe(true);
        expect((recordStart.content as Array<{ text?: string }>)[0].text).toContain("iOS Simulator backend missing prerequisites");

        const session = await client.callTool({
            name: "status",
            arguments: { deviceId: "ios-iphone-test" },
        });
        expect(session.isError).not.toBe(true);
        const sessionPayload = JSON.parse(((session.content as Array<{ text?: string }>)[0].text ?? "{}")).automation as {
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
            name: "ui",
            arguments: { deviceId: "ios-iphone-test" },
        });
        expect(dumpUi.isError).toBe(true);
        expect((dumpUi.content as Array<{ text?: string }>)[0].text).toContain("iOS Appium/XCUITest layer missing prerequisites");

        const deleted = await client.callTool({
            name: "delete",
            arguments: { deviceId: "ios-iphone-test", confirmDestructive: true },
        });
        expect(deleted.isError).not.toBe(true);
    });

    it("creates, lists, inspects, starts with diagnostics, and deletes owner-scoped Windows Sandbox definitions", { timeout: TIMEOUT }, async () => {
        const create = await client.callTool({
            name: "create_windows_sandbox",
            arguments: {

                name: "Win Test",
                networking: false,
                clipboard: false,
                vgpu: false,
                memoryMb: 4096,
            },
        });
        expect(create.isError).not.toBe(true);

        const created = JSON.parse(((create.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { deviceId: string; status: string; platform: string; networking: boolean; helper: { status: string; guestScratchDir: string } };
        };
        expect(created.device).toEqual(expect.objectContaining({
            deviceId: "windows-win-test",
            status: "stopped",
            platform: "windows",
            networking: false,
        }));
        expect(created.device.helper).toEqual(expect.objectContaining({
            status: "file-channel",
            guestScratchDir: "C:\\ccc\\scratch",
        }));

        const list = await client.callTool({ name: "devices", arguments: {} });
        const listed = JSON.parse(((list.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            devices: Array<{ deviceId: string; backend?: string }>;
        };
        expect(listed.devices).toEqual(expect.arrayContaining([
            expect.objectContaining({ deviceId: "windows-win-test", backend: "windows-sandbox" }),
        ]));

        const status = await client.callTool({
            name: "status",
            arguments: { deviceId: "windows-win-test" },
        });
        expect(status.isError).not.toBe(true);
        const inspected = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { deviceId: string; targetStatus: { targetKind: string; runtimeState: string } };
            backend: { status: string; missing: string[] };
        };
        expect(inspected.device.deviceId).toBe("windows-win-test");
        expect(inspected.device.targetStatus).toEqual(expect.objectContaining({
            targetKind: "virtual-device",
            creatable: true,
            attachable: false,
            runtimeState: "stopped",
            readiness: { state: "stopped" },
            leaseState: { state: "not-required" },
        }));
        expect(inspected.backend.status).toBe("missing-prerequisites");
        expect(inspected.backend.missing).toEqual(["wsb"]);

        const inventory = await client.callTool({
            name: "devices",
            arguments: { view: "available", backend: "windows-sandbox" },
        });
        expect(inventory.isError).not.toBe(true);
        const inventoryPayload = JSON.parse(((inventory.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            devices: Array<{ deviceId: string; helper: { status: string }; configPath: string; targetStatus: { runtimeState: string } }>;
            discovery: { available: boolean; missing: string[] };
            hostSandboxes: { lazy: boolean; missing: string[] };
        };
        expect(inventoryPayload.discovery).toEqual(expect.objectContaining({ available: false, missing: ["wsb"] }));
        expect(inventoryPayload.hostSandboxes).toEqual(expect.objectContaining({ lazy: true, missing: ["wsb"] }));
        expect(inventoryPayload.devices).toEqual(expect.arrayContaining([
            expect.objectContaining({
                deviceId: "windows-win-test",
                helper: expect.objectContaining({ status: "file-channel" }),
                configPath: expect.stringContaining("windows-win-test.wsb"),
                targetStatus: expect.objectContaining({
                    targetKind: "virtual-device",
                    runtimeState: "stopped",
                    readiness: { state: "stopped" },
                }),
            }),
        ]));

        const start = await client.callTool({
            name: "start",
            arguments: { deviceId: "windows-win-test" },
        });
        expect(start.isError).toBe(true);
        expect((start.content as Array<{ text?: string }>)[0].text).toContain("Windows Sandbox backend missing prerequisites");

        const exec = await client.callTool({
            name: "exec",
            arguments: { deviceId: "windows-win-test", command: "whoami", timeoutMs: 50 },
        });
        expect(exec.isError).toBe(true);
        expect((exec.content as Array<{ text?: string }>)[0].text).toContain("Windows Sandbox helper requires a running sandbox with a valid GUID sandboxId");

        const recordStatus = await client.callTool({
            name: "record_video",
            arguments: { action: "status", deviceId: "windows-win-test" },
        });
        expect(recordStatus.isError).not.toBe(true);
        expect(JSON.parse(((recordStatus.content as Array<{ text?: string }>)[0].text ?? "{}")).recording).toBeNull();

        const deleted = await client.callTool({
            name: "delete",
            arguments: { deviceId: "windows-win-test", confirmDestructive: true },
        });
        expect(deleted.isError).not.toBe(true);
    });

    it("rejects macOS provisioning without prerequisites and does not publish a device", { timeout: TIMEOUT }, async () => {
        const before = await client.callTool({ name: "devices", arguments: {} });
        const previous = JSON.parse((before.content[0] as { text: string }).text).devices;
        const create = await client.callTool({ name: "create_macos_vm", arguments: {
            name: "Mac Test", provider: "auto", image: "macos-restore-image", memoryMb: 8192, cpus: 4,
        } });
        expect(create.isError).toBe(true);
        const missing = process.platform === "darwin" ? "macos-vm-provider" : "macos-host";
        expect((create.content as Array<{ text?: string }>)[0].text).toContain(missing);

        const list = await client.callTool({ name: "devices", arguments: {} });
        const listed = JSON.parse(((list.content as Array<{ text?: string }>)[0].text ?? "{}"));
        expect(listed.devices).toEqual(previous);

        const inventory = await client.callTool({ name: "devices", arguments: { view: "available", backend: "macos-vm" } });
        expect(inventory.isError).not.toBe(true);
        const available = JSON.parse(((inventory.content as Array<{ text?: string }>)[0].text ?? "{}"));
        expect(available.discovery).toMatchObject({ available: false, missing: [missing] });
        expect(available.hostVms).toMatchObject({ lazy: true, missing: [missing] });
        expect(available.devices).toEqual([]);

        const start = await client.callTool({ name: "start", arguments: { deviceId: "macos-vm-missing-fixture" } });
        expect(start.isError).toBe(true);
        expect((start.content as Array<{ text?: string }>)[0].text).toMatch(/not.found|Unknown device/i);
    });
});
