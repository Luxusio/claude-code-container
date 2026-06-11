import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { handleMacosTool } from "../../device-lab-mcp/src/backends/macos-vm.mjs";

const repoRoot = join(__dirname, "../..");
const TIMEOUT = 30000;

describe("device-lab MCP", () => {
    let client: Client;
    let homeDir: string;

    beforeAll(async () => {
        homeDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-test-"));
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [join(repoRoot, "device-lab-mcp/server.mjs")],
            env: {
                HOME: homeDir,
                PATH: "/tmp/ccc-device-lab-empty-path",
                NODE_ENV: "test",
            },
        });

        client = new Client(
            { name: "ccc-device-lab-test-client", version: "1.0.0" },
            { capabilities: {} },
        );

        await client.connect(transport);
    }, TIMEOUT);

    afterAll(async () => {
        await client?.close();
        if (homeDir) rmSync(homeDir, { recursive: true, force: true });
    }, TIMEOUT);

    it("lists foundation device-lab and current display tools", { timeout: TIMEOUT }, async () => {
        const result = await client.listTools();
        const names = result.tools.map((tool) => tool.name);

        expect(names).toContain("device_backends");
        expect(names).toContain("device_broker_status");
        expect(names).toContain("device_list");
        expect(names).toContain("device_inventory");
        expect(names).toContain("display_current");
        expect(names).toContain("display_screenshot");
        expect(names).toContain("display_click");
        expect(names).toContain("device_create");
        expect(names).toContain("device_attach");
        expect(names).toContain("device_detach");
        expect(names).toContain("device_delete");
        expect(names).toContain("device_start");
        expect(names).toContain("device_stop");
        expect(names).toContain("device_status");
        expect(names).toContain("device_exec");
        expect(names).toContain("device_screenshot");
        expect(names).toContain("device_image_create");
        expect(names).toContain("device_image_clone");
        expect(names).toContain("device_snapshot_create");
        expect(names).toContain("device_snapshot_restore");
        expect(names).toContain("device_snapshot_delete");
        expect(names).toContain("device_record_video_start");
        expect(names).toContain("device_record_video_stop");
        expect(names).toContain("device_record_video_status");
        expect(names).toContain("device_upload");
        expect(names).toContain("device_download");
        expect(names).toContain("device_reset");
        expect(names).toContain("device_install_app");
        expect(names).toContain("device_launch_app");
        expect(names).toContain("mobile_session_status");
        expect(names).toContain("mobile_dump_ui");
        expect(names).toContain("mobile_tap");
        expect(names).toContain("mobile_double_tap");
        expect(names).toContain("mobile_long_press");
        expect(names).toContain("mobile_swipe");
        expect(names).toContain("mobile_drag");
        expect(names).toContain("mobile_type_text");
        expect(names).toContain("mobile_key");
        expect(names).toContain("mobile_home");
        expect(names).toContain("mobile_back");
        expect(names).toContain("mobile_forward");
        expect(names).toContain("mobile_recents");
        expect(names).toContain("mobile_power");
        expect(names).toContain("mobile_lock");
        expect(names).toContain("mobile_unlock");
        expect(names).toContain("mobile_rotate_left");
        expect(names).toContain("mobile_rotate_right");
        expect(names).toContain("mobile_set_orientation");
        expect(names).toContain("mobile_open_url");
        expect(names).toContain("mobile_install_app");
        expect(names).toContain("mobile_launch_app");
        expect(names).toContain("mobile_uninstall_app");
        expect(names).toContain("mobile_stop_app");
        expect(names).toContain("mobile_clear_app_data");
        expect(names).toContain("mobile_grant_permission");
        expect(names).toContain("mobile_revoke_permission");
        expect(names).toContain("mobile_set_location");
        expect(names).toContain("mobile_set_battery");
        expect(names).toContain("mobile_set_network");
        expect(names).toContain("mobile_toggle_airplane_mode");
        expect(names).toContain("mobile_set_clipboard");
        expect(names).toContain("mobile_get_clipboard");
        expect(names).toContain("mobile_wait_for_text");
        expect(names).toContain("mobile_wait_for_app");
        expect(names).toContain("mobile_screenshot");
        expect(names).toContain("mobile_run_flow");
    });

    it("reports backends without starting heavyweight devices", { timeout: TIMEOUT }, async () => {
        const result = await client.callTool({ name: "device_backends", arguments: {} });
        expect(result.isError).not.toBe(true);

        const content = result.content as Array<{ type: string; text?: string }>;
        const payload = JSON.parse(content[0].text ?? "{}") as {
            ownerId?: string;
            broker?: { mode: string; lazy: boolean; transport: { environmentRequired: boolean }; deferred: string[] };
            backends?: Array<{ name: string; available: boolean; status?: string; capabilities?: string[] }>;
        };

        expect(payload.ownerId).toMatch(/^[a-f0-9]{16}$/);
        expect(payload.broker).toEqual(expect.objectContaining({
            mode: "direct-provider",
            lazy: true,
            transport: expect.objectContaining({ environmentRequired: false }),
            deferred: expect.arrayContaining(["host broker daemon launcher"]),
        }));
        expect(payload.backends?.map((backend) => backend.name)).toEqual([
            "x11-current-display",
            "android-emulator",
            "android-device",
            "ios-simulator",
            "ios-device",
            "windows-sandbox",
            "macos-vm",
        ]);
        expect(payload.backends?.find((backend) => backend.name === "android-emulator")?.status).toBe("missing-prerequisites");
        expect(payload.backends?.find((backend) => backend.name === "android-device")?.status).toBe("missing-prerequisites");
        const iosSimulatorBackend = payload.backends?.find((backend) => backend.name === "ios-simulator");
        expect(iosSimulatorBackend?.status).toBe("missing-prerequisites");
        expect(iosSimulatorBackend?.capabilities).toEqual(expect.arrayContaining([
            "mobile_tap",
            "mobile_double_tap",
            "mobile_long_press",
            "mobile_swipe",
            "mobile_drag",
            "mobile_type_text",
            "mobile_key",
            "mobile_home",
            "mobile_lock",
            "mobile_unlock",
            "mobile_set_orientation",
            "mobile_wait_for_text",
        ]));
        expect(payload.backends?.find((backend) => backend.name === "ios-device")?.status).toBe("missing-prerequisites");
        const windowsBackend = payload.backends?.find((backend) => backend.name === "windows-sandbox");
        expect(windowsBackend?.status).toBe("missing-prerequisites");
        expect(windowsBackend?.capabilities).toContain("device_inventory");
        const macosBackend = payload.backends?.find((backend) => backend.name === "macos-vm");
        expect(macosBackend?.status).toBe("missing-prerequisites");
        expect(macosBackend?.capabilities).toContain("device_inventory");
    });

    it("reports zero-config broker contract without starting host providers", { timeout: TIMEOUT }, async () => {
        const result = await client.callTool({
            name: "device_broker_status",
            arguments: {},
        });
        expect(result.isError).not.toBe(true);
        const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ownerId: string;
            mode: string;
            lazy: boolean;
            available: boolean;
            transport: { hostCandidates: string[]; defaultPort: number; zeroConfig: boolean; environmentRequired: boolean };
            state: { root: string; ownerRoot: string; locksRoot: string; logsRoot: string };
            implemented: string[];
            deferred: string[];
        };

        expect(payload.ownerId).toMatch(/^[a-f0-9]{16}$/);
        expect(payload.mode).toBe("direct-provider");
        expect(payload.lazy).toBe(true);
        expect(payload.available).toBe(false);
        expect(payload.transport).toEqual(expect.objectContaining({
            hostCandidates: expect.arrayContaining(["host.docker.internal", "172.17.0.1"]),
            defaultPort: 17373,
            zeroConfig: true,
            environmentRequired: false,
        }));
        expect(payload.state.ownerRoot).toContain(payload.ownerId);
        expect(payload.state.locksRoot).toContain(".ccc/devices/broker/locks");
        expect(payload.implemented).toContain("broker contract inspection");
        expect(payload.deferred).toContain("host broker daemon launcher");
    });

    it("lists only the current non-creatable X11 display in the foundation slice", { timeout: TIMEOUT }, async () => {
        const result = await client.callTool({ name: "device_list", arguments: {} });
        expect(result.isError).not.toBe(true);

        const content = result.content as Array<{ type: string; text?: string }>;
        const payload = JSON.parse(content[0].text ?? "{}") as {
            devices?: Array<{ id: string; kind: string; creatable: boolean; lifecycle: string }>;
        };

        expect(payload.devices).toEqual([
            expect.objectContaining({
                id: "x11-current-display",
                kind: "display",
                creatable: false,
                lifecycle: "current",
            }),
        ]);
    });

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
                    deferred: ["guest-helper-auto-provisioning"],
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

describe("macOS VM backend with fake Tart provider", () => {
    let homeDir: string;
    let binDir: string;
    let logPath: string;
    let oldHome: string | undefined;
    let oldPath: string | undefined;
    let platformSpy: ReturnType<typeof vi.spyOn>;

    beforeAll(() => {
        homeDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-macos-home-"));
        binDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-macos-bin-"));
        logPath = join(homeDir, "fake-tart.log");
        const tartPath = join(binDir, "tart");
        writeFileSync(tartPath, `#!/bin/sh
echo "tart $*" >> "$FAKE_TART_LOG"
if [ "$1" = "clone" ]; then
  case "$2" in
    *fail-restore*) exit 8 ;;
    *restore-*fail-activate*) exit 7 ;;
  esac
  case "$3" in
    *fail-snapshot*) exit 9 ;;
  esac
fi
if [ "$1" = "delete" ]; then
  case "$2" in
    *macos-partial-delete) echo "primary delete failed" >&2; exit 6 ;;
    *fail-delete*) echo "delete failed" >&2; exit 6 ;;
  esac
fi
exit 0
`);
        chmodSync(tartPath, 0o755);
        const vzPath = join(binDir, "vz");
        writeFileSync(vzPath, `#!/bin/sh
echo "vz $*" >> "$FAKE_TART_LOG"
exit 0
`);
        chmodSync(vzPath, 0o755);
        const sshPath = join(binDir, "ssh");
writeFileSync(sshPath, `#!/bin/sh
echo "ssh $*" >> "$FAKE_TART_LOG"
case "$*" in
  *screencapture*"-v"*) exec /bin/sleep 20 ;;
  *screencapture*"-x"*) exit 0 ;;
  *pkill*) exit 0 ;;
  *rm\\ -f*) exit 0 ;;
  *fail-command*) echo "ssh failure stdout"; echo "ssh failure stderr" >&2; exit 7 ;;
  *) echo "ssh output"; exit 0 ;;
esac
`);
        chmodSync(sshPath, 0o755);
        const scpPath = join(binDir, "scp");
        writeFileSync(scpPath, `#!/bin/sh
echo "scp $*" >> "$FAKE_TART_LOG"
last=""
for arg in "$@"; do last="$arg"; done
case "$last" in
  *:*) exit 0 ;;
  *) printf 'fakepng' > "$last"; exit 0 ;;
esac
`);
        chmodSync(scpPath, 0o755);

        oldHome = process.env.HOME;
        oldPath = process.env.PATH;
        process.env.HOME = homeDir;
        process.env.PATH = binDir;
        process.env.FAKE_TART_LOG = logPath;
        platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    });

    afterAll(() => {
        platformSpy?.mockRestore();
        process.env.HOME = oldHome;
        process.env.PATH = oldPath;
        delete process.env.FAKE_TART_LOG;
        if (homeDir) rmSync(homeDir, { recursive: true, force: true });
        if (binDir) rmSync(binDir, { recursive: true, force: true });
    });

    it("plans, starts, stops, and diagnoses helper-required operations without provider calls on create", async () => {
        const create = await handleMacosTool("device_create", {
            backend: "macos-vm",
            name: "Fake Tart",
            provider: "auto",
            image: "ghcr.io/example/macos:latest",
            memoryMb: 4096,
            cpus: 2,
            sshHost: "127.0.0.1",
            sshPort: 2222,
            sshUser: "ccc",
        });
        expect(create?.isError).not.toBe(true);
        const created = JSON.parse(((create?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; providerPlan: { selectedProvider: string; providerInstance: string; startCommand: { args: string[] }; helper: { workspaceDir: string }; implemented: string[]; deferred: string[] } };
        };
        expect(created.device.id).toBe("macos-fake-tart");
        expect(created.device.providerPlan.selectedProvider).toBe("tart");
        expect(created.device.providerPlan.providerInstance).toContain("macos-fake-tart");
        expect(created.device.providerPlan.startCommand.args).toEqual(["run", created.device.providerPlan.providerInstance]);
        expect(created.device.providerPlan.helper.workspaceDir).toContain("macos-fake-tart");
        expect(created.device.providerPlan.implemented).toEqual(expect.arrayContaining(["image-clone", "snapshot-clone", "provider-delete"]));
        expect(created.device.providerPlan.deferred).toEqual(["guest-helper-auto-provisioning"]);
        expect(readFileSync(logPath, { encoding: "utf-8", flag: "a+" })).not.toContain("tart run");

        const inventory = await handleMacosTool("device_inventory", { backend: "macos-vm" });
        expect(inventory?.isError).not.toBe(true);
        const inventoryPayload = JSON.parse(((inventory?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            devices: Array<{ id: string; providerPlan: { selectedProvider: string; startCommand: { args: string[] } } }>;
            discovery: { available: boolean; providers: Array<{ name: string }> };
            hostVms: { lazy: boolean; providers: Array<{ name: string }> };
        };
        expect(inventoryPayload.discovery.available).toBe(true);
        expect(inventoryPayload.discovery.providers.map((provider) => provider.name)).toEqual(expect.arrayContaining(["tart", "vz"]));
        expect(inventoryPayload.hostVms).toEqual(expect.objectContaining({ lazy: true }));
        expect(inventoryPayload.devices).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: "macos-fake-tart",
                providerPlan: expect.objectContaining({
                    selectedProvider: "tart",
                    startCommand: expect.objectContaining({ args: ["run", created.device.providerPlan.providerInstance] }),
                }),
            }),
        ]));
        expect(readFileSync(logPath, { encoding: "utf-8", flag: "a+" })).not.toContain("tart run");

        const imageCreate = await handleMacosTool("device_image_create", {
            backend: "macos-vm",
            name: "Base Image",
            sourceImage: "ghcr.io/example/macos-base:latest",
            provider: "auto",
            memoryMb: 4096,
            cpus: 2,
        });
        expect(imageCreate?.isError).not.toBe(true);
        const imageCreated = JSON.parse(((imageCreate?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; provider: string; providerInstance: string; imageSource: string; provisioning: string };
        };
        expect(imageCreated.device).toEqual(expect.objectContaining({
            id: "macos-base-image",
            provider: "tart",
            imageSource: "ghcr.io/example/macos-base:latest",
            provisioning: "image-created",
        }));
        expect(imageCreated.device.providerInstance).toContain("macos-base-image");

        const imageClone = await handleMacosTool("device_image_clone", {
            backend: "macos-vm",
            name: "Base Clone",
            sourceDeviceId: "macos-base-image",
        });
        expect(imageClone?.isError).not.toBe(true);
        const imageCloned = JSON.parse(((imageClone?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; provider: string; providerInstance: string; clonedFrom: { deviceId: string; providerInstance: string }; provisioning: string };
        };
        expect(imageCloned.device).toEqual(expect.objectContaining({
            id: "macos-base-clone",
            provider: "tart",
            provisioning: "image-cloned",
        }));
        expect(imageCloned.device.clonedFrom.deviceId).toBe("macos-base-image");
        expect(imageCloned.device.clonedFrom.providerInstance).toBe(imageCreated.device.providerInstance);

        const imageSnapshotForCascadeDelete = await handleMacosTool("device_snapshot_create", {
            deviceId: "macos-base-image",
            snapshotName: "Delete Cascade",
        });
        expect(imageSnapshotForCascadeDelete?.isError).not.toBe(true);
        const imageSnapshotPayload = JSON.parse(((imageSnapshotForCascadeDelete?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            snapshot: { providerInstance: string };
        };

        const startBaseImage = await handleMacosTool("device_start", { deviceId: "macos-base-image" });
        expect(startBaseImage?.isError).not.toBe(true);
        const forceClone = await handleMacosTool("device_image_clone", {
            backend: "macos-vm",
            name: "Forced Clone",
            sourceDeviceId: "macos-base-image",
            force: true,
        });
        expect(forceClone?.isError).not.toBe(true);
        const baseStatusAfterForceClone = await handleMacosTool("device_status", { deviceId: "macos-base-image" });
        const baseAfterForceClone = JSON.parse(((baseStatusAfterForceClone?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { status: string };
        };
        expect(baseAfterForceClone.device.status).toBe("stopped");

        const unsupportedProvider = await handleMacosTool("device_image_create", {
            backend: "macos-vm",
            name: "Unsupported VZ Image",
            sourceImage: "ghcr.io/example/macos-base:latest",
            provider: "vz",
        });
        expect(unsupportedProvider?.isError).toBe(true);
        expect((unsupportedProvider?.content as Array<{ text?: string }>)[0].text).toContain("Tart is currently required");

        const deleteFailureCreate = await handleMacosTool("device_image_create", {
            backend: "macos-vm",
            name: "Fail Delete",
            sourceImage: "ghcr.io/example/macos-base:latest",
            provider: "auto",
        });
        expect(deleteFailureCreate?.isError).not.toBe(true);
        const deleteFailureCreated = JSON.parse(((deleteFailureCreate?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; providerInstance: string };
        };
        expect(deleteFailureCreated.device.providerInstance).toContain("fail-delete");
        const deleteFailure = await handleMacosTool("device_delete", { deviceId: "macos-fail-delete" });
        expect(deleteFailure?.isError).toBe(true);
        expect((deleteFailure?.content as Array<{ text?: string }>)[0].text).toContain("delete failed");
        const deleteFailureStillPresent = await handleMacosTool("device_status", { deviceId: "macos-fail-delete" });
        expect(deleteFailureStillPresent?.isError).not.toBe(true);

        const partialDeleteCreate = await handleMacosTool("device_image_create", {
            backend: "macos-vm",
            name: "Partial Delete",
            sourceImage: "ghcr.io/example/macos-base:latest",
            provider: "auto",
        });
        expect(partialDeleteCreate?.isError).not.toBe(true);
        const partialDeleteCreated = JSON.parse(((partialDeleteCreate?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; providerInstance: string };
        };
        const partialDeleteSnapshot = await handleMacosTool("device_snapshot_create", {
            deviceId: "macos-partial-delete",
            snapshotName: "Retry Safe",
        });
        expect(partialDeleteSnapshot?.isError).not.toBe(true);
        const partialDeleteSnapshotPayload = JSON.parse(((partialDeleteSnapshot?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            snapshot: { providerInstance: string };
        };
        const partialDelete = await handleMacosTool("device_delete", { deviceId: "macos-partial-delete" });
        expect(partialDelete?.isError).toBe(true);
        expect((partialDelete?.content as Array<{ text?: string }>)[0].text).toContain("primary delete failed");
        const partialDeleteStatus = await handleMacosTool("device_status", { deviceId: "macos-partial-delete" });
        const partialDeleteStillPresent = JSON.parse(((partialDeleteStatus?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { snapshots: unknown[] };
        };
        expect(partialDeleteStillPresent.device.snapshots).toEqual([]);
        const logBeforePartialRetry = readFileSync(logPath, "utf-8");
        const partialDeleteRetry = await handleMacosTool("device_delete", { deviceId: "macos-partial-delete" });
        expect(partialDeleteRetry?.isError).toBe(true);
        const partialRetryDelta = readFileSync(logPath, "utf-8").slice(logBeforePartialRetry.length);
        expect(partialRetryDelta).toContain(`tart delete ${partialDeleteCreated.device.providerInstance}`);
        expect(partialRetryDelta).not.toContain(partialDeleteSnapshotPayload.snapshot.providerInstance);

        const start = await handleMacosTool("device_start", { deviceId: "macos-fake-tart" });
        expect(start?.isError).not.toBe(true);
        const started = JSON.parse(((start?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { status: string; provider: string; providerInstance: string };
        };
        expect(started.device.status).toBe("running");
        expect(started.device.provider).toBe("tart");

        const snapshotWhileRunning = await handleMacosTool("device_snapshot_create", {
            deviceId: "macos-fake-tart",
            snapshotName: "Before Install",
        });
        expect(snapshotWhileRunning?.isError).toBe(true);
        expect((snapshotWhileRunning?.content as Array<{ text?: string }>)[0].text).toContain("Refusing to snapshot");

        const failingSnapshot = await handleMacosTool("device_snapshot_create", {
            deviceId: "macos-fake-tart",
            snapshotName: "Fail Snapshot",
            force: true,
        });
        expect(failingSnapshot?.isError).toBe(true);
        const statusAfterFailingSnapshot = await handleMacosTool("device_status", { deviceId: "macos-fake-tart" });
        const failingSnapshotStatus = JSON.parse(((statusAfterFailingSnapshot?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { status: string; snapshots: unknown[] };
        };
        expect(failingSnapshotStatus.device.status).toBe("stopped");
        expect(failingSnapshotStatus.device.snapshots || []).toEqual([]);

        const restartAfterFailedSnapshot = await handleMacosTool("device_start", { deviceId: "macos-fake-tart" });
        expect(restartAfterFailedSnapshot?.isError).not.toBe(true);

        const snapshotCreate = await handleMacosTool("device_snapshot_create", {
            deviceId: "macos-fake-tart",
            snapshotName: "Before Install",
            force: true,
        });
        expect(snapshotCreate?.isError).not.toBe(true);
        const snapshotCreated = JSON.parse(((snapshotCreate?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { status: string; snapshots: Array<{ id: string; name: string; providerInstance: string }> };
            snapshot: { id: string; name: string; providerInstance: string };
        };
        expect(snapshotCreated.device.status).toBe("stopped");
        expect(snapshotCreated.snapshot).toEqual(expect.objectContaining({
            id: "snapshot-before-install",
            name: "Before Install",
        }));
        expect(snapshotCreated.device.snapshots).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: "snapshot-before-install", name: "Before Install" }),
        ]));

        const restartAfterSnapshot = await handleMacosTool("device_start", { deviceId: "macos-fake-tart" });
        expect(restartAfterSnapshot?.isError).not.toBe(true);

        const restoreWhileRunning = await handleMacosTool("device_snapshot_restore", {
            deviceId: "macos-fake-tart",
            snapshotName: "Before Install",
        });
        expect(restoreWhileRunning?.isError).toBe(true);
        expect((restoreWhileRunning?.content as Array<{ text?: string }>)[0].text).toContain("Refusing to restore");

        const failingRestore = await handleMacosTool("device_snapshot_create", {
            deviceId: "macos-fake-tart",
            snapshotName: "Fail Restore",
            force: true,
        });
        expect(failingRestore?.isError).not.toBe(true);
        const restartBeforeFailRestore = await handleMacosTool("device_start", { deviceId: "macos-fake-tart" });
        expect(restartBeforeFailRestore?.isError).not.toBe(true);
        const logBeforeFailedRestore = readFileSync(logPath, "utf-8");
        const restoreCloneFailure = await handleMacosTool("device_snapshot_restore", {
            deviceId: "macos-fake-tart",
            snapshotName: "Fail Restore",
            force: true,
        });
        expect(restoreCloneFailure?.isError).toBe(true);
        const failedRestoreLogDelta = readFileSync(logPath, "utf-8").slice(logBeforeFailedRestore.length);
        expect(failedRestoreLogDelta).toContain("fail-restore");
        expect(failedRestoreLogDelta).not.toContain(`tart delete ${started.device.providerInstance}`);
        const statusAfterFailedRestore = await handleMacosTool("device_status", { deviceId: "macos-fake-tart" });
        const failedRestoreStatus = JSON.parse(((statusAfterFailedRestore?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { status: string; snapshots: Array<{ name: string }> };
        };
        expect(failedRestoreStatus.device.status).toBe("stopped");
        expect(failedRestoreStatus.device.snapshots).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: "Fail Restore" }),
        ]));

        const activationFailureSnapshot = await handleMacosTool("device_snapshot_create", {
            deviceId: "macos-fake-tart",
            snapshotName: "Fail Activate",
            force: true,
        });
        expect(activationFailureSnapshot?.isError).not.toBe(true);
        const activationSnapshotPayload = JSON.parse(((activationFailureSnapshot?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            snapshot: { providerInstance: string };
        };
        const restartBeforeActivationFailure = await handleMacosTool("device_start", { deviceId: "macos-fake-tart" });
        expect(restartBeforeActivationFailure?.isError).not.toBe(true);
        const logBeforeActivationFailure = readFileSync(logPath, "utf-8");
        const activationFailure = await handleMacosTool("device_snapshot_restore", {
            deviceId: "macos-fake-tart",
            snapshotName: "Fail Activate",
            force: true,
        });
        expect(activationFailure?.isError).toBe(true);
        expect((activationFailure?.content as Array<{ text?: string }>)[0].text).toContain("Restore candidate preserved");
        const activationFailureDelta = readFileSync(logPath, "utf-8").slice(logBeforeActivationFailure.length);
        expect(activationFailureDelta).toContain(activationSnapshotPayload.snapshot.providerInstance);
        expect(activationFailureDelta).toContain("fail-activate");
        const preservedCandidate = activationFailureDelta
            .split("\n")
            .find((line) => line.includes("fail-activate"))?.split(" ").pop() || "";
        expect(preservedCandidate).toContain("restore-");
        expect(activationFailureDelta).not.toContain(`tart delete ${preservedCandidate}`);
        const statusAfterActivationFailure = await handleMacosTool("device_status", { deviceId: "macos-fake-tart" });
        const activationFailureStatus = JSON.parse(((statusAfterActivationFailure?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { restoreRecovery: { candidateProviderInstance: string; snapshotName: string } };
        };
        expect(activationFailureStatus.device.restoreRecovery).toEqual(expect.objectContaining({
            candidateProviderInstance: preservedCandidate,
            snapshotName: "Fail Activate",
        }));

        const snapshotRestore = await handleMacosTool("device_snapshot_restore", {
            deviceId: "macos-fake-tart",
            snapshotName: "Before Install",
            force: true,
        });
        expect(snapshotRestore?.isError).not.toBe(true);
        const restored = JSON.parse(((snapshotRestore?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { status: string; restoredFrom: { id: string; name: string } };
        };
        expect(restored.device.status).toBe("stopped");
        expect(restored.device.restoredFrom).toEqual(expect.objectContaining({
            id: "snapshot-before-install",
            name: "Before Install",
        }));

        const snapshotDelete = await handleMacosTool("device_snapshot_delete", {
            deviceId: "macos-fake-tart",
            snapshotName: "Before Install",
        });
        expect(snapshotDelete?.isError).not.toBe(true);
        const snapshotDeleted = JSON.parse(((snapshotDelete?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            deleted: string;
            device: { snapshots: unknown[] };
        };
        expect(snapshotDeleted.deleted).toBe("snapshot-before-install");
        expect(snapshotDeleted.device.snapshots).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: "snapshot-fail-restore" }),
        ]));
        expect(snapshotDeleted.device.snapshots).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ id: "snapshot-before-install" }),
        ]));

        const failRestoreSnapshotDeleted = await handleMacosTool("device_snapshot_delete", {
            deviceId: "macos-fake-tart",
            snapshotName: "Fail Restore",
        });
        expect(failRestoreSnapshotDeleted?.isError).not.toBe(true);
        const failRestoreDeleted = JSON.parse(((failRestoreSnapshotDeleted?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            deleted: string;
            device: { snapshots: unknown[] };
        };
        expect(failRestoreDeleted.deleted).toBe("snapshot-fail-restore");
        expect(failRestoreDeleted.device.snapshots).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: "snapshot-fail-activate" }),
        ]));

        const failActivateSnapshotDeleted = await handleMacosTool("device_snapshot_delete", {
            deviceId: "macos-fake-tart",
            snapshotName: "Fail Activate",
        });
        expect(failActivateSnapshotDeleted?.isError).not.toBe(true);
        const failActivateDeleted = JSON.parse(((failActivateSnapshotDeleted?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            deleted: string;
            device: { snapshots: unknown[] };
        };
        expect(failActivateDeleted.deleted).toBe("snapshot-fail-activate");
        expect(failActivateDeleted.device.snapshots).toEqual([]);

        const restartAfterRestore = await handleMacosTool("device_start", { deviceId: "macos-fake-tart" });
        expect(restartAfterRestore?.isError).not.toBe(true);

        const cloneWhileRunning = await handleMacosTool("device_image_clone", {
            backend: "macos-vm",
            name: "Running Clone",
            sourceDeviceId: "macos-fake-tart",
        });
        expect(cloneWhileRunning?.isError).toBe(true);
        expect((cloneWhileRunning?.content as Array<{ text?: string }>)[0].text).toContain("Refusing to clone");

        const exec = await handleMacosTool("device_exec", { deviceId: "macos-fake-tart", command: "whoami" });
        expect(exec?.isError).not.toBe(true);
        expect((exec?.content as Array<{ text?: string }>)[0].text).toContain("ssh output");

        const failedExec = await handleMacosTool("device_exec", { deviceId: "macos-fake-tart", command: "fail-command" });
        expect(failedExec?.isError).not.toBe(true);
        const failedExecPayload = JSON.parse(((failedExec?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            stdout: string;
            stderr: string;
            status: number;
        };
        expect(failedExecPayload.stdout).toContain("ssh failure stdout");
        expect(failedExecPayload.stderr).toContain("ssh failure stderr");
        expect(failedExecPayload.status).toBe(7);

        const uploadSource = join(homeDir, "mac-upload.txt");
        writeFileSync(uploadSource, "upload");
        const upload = await handleMacosTool("device_upload", { deviceId: "macos-fake-tart", localPath: uploadSource, remotePath: "/tmp/mac-upload.txt" });
        expect(upload?.isError).not.toBe(true);

        const downloadTarget = join(homeDir, "mac-download.txt");
        const download = await handleMacosTool("device_download", { deviceId: "macos-fake-tart", remotePath: "/tmp/mac-download.txt", localPath: downloadTarget });
        expect(download?.isError).not.toBe(true);
        expect(readFileSync(downloadTarget, "utf-8")).toBe("fakepng");

        const screenshot = await handleMacosTool("device_screenshot", { deviceId: "macos-fake-tart" });
        expect(screenshot?.isError).not.toBe(true);
        expect((screenshot?.content as Array<{ type: string }>)[0].type).toBe("image");

        const initialRecordStatus = await handleMacosTool("device_record_video_status", { deviceId: "macos-fake-tart" });
        expect(initialRecordStatus?.isError).not.toBe(true);
        expect(JSON.parse(((initialRecordStatus?.content as Array<{ text?: string }>)[0].text ?? "{}")).recording).toBeNull();

        const stopWithoutRecording = await handleMacosTool("device_record_video_stop", { deviceId: "macos-fake-tart" });
        expect(stopWithoutRecording?.isError).toBe(true);
        expect((stopWithoutRecording?.content as Array<{ text?: string }>)[0].text).toContain("No macOS VM recording active");

        const recordStart = await handleMacosTool("device_record_video_start", {
            deviceId: "macos-fake-tart",
            remotePath: "/tmp/custom-macos-recording.mov",
            localPath: join(homeDir, "custom-macos-recording.mov"),
            timeLimitSec: 3,
        });
        expect(recordStart?.isError).not.toBe(true);
        const recordStartPayload = JSON.parse(((recordStart?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            recording: { active: boolean; provider: string; remotePath: string; localPath: string };
        };
        expect(recordStartPayload.recording).toEqual(expect.objectContaining({
            active: true,
            provider: "ssh-screencapture-video",
            remotePath: "/tmp/custom-macos-recording.mov",
            localPath: join(homeDir, "custom-macos-recording.mov"),
        }));

        const duplicateRecordStart = await handleMacosTool("device_record_video_start", { deviceId: "macos-fake-tart" });
        expect(duplicateRecordStart?.isError).toBe(true);
        expect((duplicateRecordStart?.content as Array<{ text?: string }>)[0].text).toContain("macOS VM recording already active");

        const activeRecordStatus = await handleMacosTool("device_record_video_status", { deviceId: "macos-fake-tart" });
        expect(activeRecordStatus?.isError).not.toBe(true);
        expect(JSON.parse(((activeRecordStatus?.content as Array<{ text?: string }>)[0].text ?? "{}")).recording).toEqual(expect.objectContaining({
            active: true,
            provider: "ssh-screencapture-video",
        }));

        const recordStop = await handleMacosTool("device_record_video_stop", { deviceId: "macos-fake-tart" });
        expect(recordStop?.isError).not.toBe(true);
        const recordStopPayload = JSON.parse(((recordStop?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            recording: { active: boolean; localPath: string };
            device: { recording: unknown };
        };
        expect(recordStopPayload.recording).toEqual(expect.objectContaining({
            active: false,
            localPath: join(homeDir, "custom-macos-recording.mov"),
        }));
        expect(recordStopPayload.device.recording).toBeNull();
        expect(readFileSync(join(homeDir, "custom-macos-recording.mov"), "utf-8")).toBe("fakepng");

        const stop = await handleMacosTool("device_stop", { deviceId: "macos-fake-tart" });
        expect(stop?.isError).not.toBe(true);
        const log = readFileSync(logPath, "utf-8");
        expect(log).toContain(`tart run ${started.device.providerInstance}`);
        expect(log).toContain(`tart stop ${started.device.providerInstance}`);
        expect(log).toContain(`tart clone ghcr.io/example/macos-base:latest ${imageCreated.device.providerInstance}`);
        expect(log).toContain(`tart clone ${imageCreated.device.providerInstance} ${imageCloned.device.providerInstance}`);
        expect(log).toContain(`tart clone ${imageCreated.device.providerInstance} `);
        expect(log).toContain(`tart clone ${started.device.providerInstance} ${snapshotCreated.snapshot.providerInstance}`);
        expect(log).toContain("tart clone ");
        expect(log).toContain("fail-snapshot");
        expect(log).toContain("fail-restore");
        expect(log).toContain(`tart delete ${started.device.providerInstance}`);
        expect(log).toContain(`tart clone ${snapshotCreated.snapshot.providerInstance} `);
        expect(log).toContain(`tart clone ${started.device.providerInstance}-restore-`);
        expect(log).toContain(`tart delete ${snapshotCreated.snapshot.providerInstance}`);
        expect(log).not.toContain("vz clone");
        expect(log).toContain("ssh -p 2222 -o BatchMode=yes -o StrictHostKeyChecking=no ccc@127.0.0.1 whoami");
        expect(log).toContain("scp -P 2222 -o BatchMode=yes -o StrictHostKeyChecking=no");
        expect(log).toContain("screencapture -x /tmp/ccc-macos-fake-tart-screenshot.png");
        expect(log).toContain("screencapture -v '/tmp/custom-macos-recording.mov'");
        expect(log).toContain("pkill -INT -f");
        expect(log).toContain("ccc@127.0.0.1:/tmp/custom-macos-recording.mov");

        const startCloneBeforeDelete = await handleMacosTool("device_start", { deviceId: "macos-base-clone" });
        expect(startCloneBeforeDelete?.isError).not.toBe(true);
        const runningCloneDelete = await handleMacosTool("device_delete", { deviceId: "macos-base-clone" });
        expect(runningCloneDelete?.isError).toBe(true);
        expect((runningCloneDelete?.content as Array<{ text?: string }>)[0].text).toContain("Refusing to delete macos-base-clone while status is running");
        const clonedDeleted = await handleMacosTool("device_delete", { deviceId: "macos-base-clone", force: true });
        expect(clonedDeleted?.isError).not.toBe(true);
        const clonedDeletedPayload = JSON.parse(((clonedDeleted?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            providerDeleted: string[];
        };
        expect(clonedDeletedPayload.providerDeleted).toContain(imageCloned.device.providerInstance);
        const forcedClonedDeleted = await handleMacosTool("device_delete", { deviceId: "macos-forced-clone" });
        expect(forcedClonedDeleted?.isError).not.toBe(true);
        const imageDeleted = await handleMacosTool("device_delete", { deviceId: "macos-base-image" });
        expect(imageDeleted?.isError).not.toBe(true);
        const imageDeletedPayload = JSON.parse(((imageDeleted?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            providerDeleted: string[];
        };
        expect(imageDeletedPayload.providerDeleted).toContain(imageSnapshotPayload.snapshot.providerInstance);
        expect(imageDeletedPayload.providerDeleted).toContain(imageCreated.device.providerInstance);

        const recoverySnapshot = await handleMacosTool("device_snapshot_create", {
            deviceId: "macos-fake-tart",
            snapshotName: "Fail Activate Delete",
        });
        expect(recoverySnapshot?.isError).not.toBe(true);
        const recoverySnapshotPayload = JSON.parse(((recoverySnapshot?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            snapshot: { providerInstance: string };
        };
        const restartBeforeRecoveryDelete = await handleMacosTool("device_start", { deviceId: "macos-fake-tart" });
        expect(restartBeforeRecoveryDelete?.isError).not.toBe(true);
        const recoveryRestoreFailure = await handleMacosTool("device_snapshot_restore", {
            deviceId: "macos-fake-tart",
            snapshotName: "Fail Activate Delete",
            force: true,
        });
        expect(recoveryRestoreFailure?.isError).toBe(true);
        const statusBeforeRecoveryDelete = await handleMacosTool("device_status", { deviceId: "macos-fake-tart" });
        const recoveryDeleteStatus = JSON.parse(((statusBeforeRecoveryDelete?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { restoreRecovery: { candidateProviderInstance: string } };
        };
        expect(recoveryDeleteStatus.device.restoreRecovery.candidateProviderInstance).toContain("restore-");
        const deleted = await handleMacosTool("device_delete", { deviceId: "macos-fake-tart" });
        expect(deleted?.isError).not.toBe(true);
        const deletedPayload = JSON.parse(((deleted?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            providerDeleted: string[];
        };
        expect(deletedPayload.providerDeleted).toEqual(expect.arrayContaining([
            recoverySnapshotPayload.snapshot.providerInstance,
            recoveryDeleteStatus.device.restoreRecovery.candidateProviderInstance,
        ]));

        const deleteLog = readFileSync(logPath, "utf-8");
        expect(deleteLog).toContain(`tart stop ${imageCloned.device.providerInstance}`);
        expect(deleteLog).toContain(`tart delete ${imageCloned.device.providerInstance}`);
        expect(deleteLog).toContain(`tart delete ${imageSnapshotPayload.snapshot.providerInstance}`);
        expect(deleteLog).toContain(`tart delete ${imageCreated.device.providerInstance}`);
        expect(deleteLog).toContain(`tart delete ${deleteFailureCreated.device.providerInstance}`);
        expect(deleteLog).toContain(`tart delete ${partialDeleteSnapshotPayload.snapshot.providerInstance}`);
        expect(deleteLog).toContain(`tart delete ${recoverySnapshotPayload.snapshot.providerInstance}`);
        expect(deleteLog).toContain(`tart delete ${recoveryDeleteStatus.device.restoreRecovery.candidateProviderInstance}`);
    });
});

describe("device-lab MCP with fake Windows Sandbox CLI", () => {
    let client: Client;
    let homeDir: string;
    let binDir: string;
    let logPath: string;
    let failStopPath: string;

    beforeAll(async () => {
        homeDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-windows-home-"));
        binDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-windows-bin-"));
        logPath = join(homeDir, "fake-windows.log");
        failStopPath = join(homeDir, "fail-stop");

        const wsbPath = join(binDir, "wsb");
        writeFileSync(wsbPath, `#!/bin/sh
echo "wsb $*" >> "$FAKE_WINDOWS_LOG"
if [ "$1" = "stop" ] && [ -f "$FAKE_WINDOWS_FAIL_STOP" ]; then
  echo "forced stop failure" >&2
  exit 7
fi
exit 0
`);
        chmodSync(wsbPath, 0o755);

        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [join(repoRoot, "device-lab-mcp/server.mjs")],
            env: {
                HOME: homeDir,
                PATH: binDir,
                NODE_ENV: "test",
                FAKE_WINDOWS_LOG: logPath,
                FAKE_WINDOWS_FAIL_STOP: failStopPath,
            },
        });

        client = new Client(
            { name: "ccc-device-lab-windows-fake-client", version: "1.0.0" },
            { capabilities: {} },
        );

        await client.connect(transport);
    }, TIMEOUT);

    afterAll(async () => {
        await client?.close();
        if (homeDir) rmSync(homeDir, { recursive: true, force: true });
        if (binDir) rmSync(binDir, { recursive: true, force: true });
    }, TIMEOUT);

    it("writes owner-scoped Windows Sandbox config with helper bootstrap only on explicit start", { timeout: TIMEOUT }, async () => {
        const create = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "windows-sandbox",
                name: "Win Helper",
                networking: false,
                clipboard: false,
                vgpu: false,
                memoryMb: 2048,
            },
        });
        expect(create.isError).not.toBe(true);
        const created = JSON.parse(((create.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; helper: { scratchDir: string; toolsDir: string; hostHelperScript: string } };
        };
        expect(created.device.id).toBe("windows-win-helper");
        expect(created.device.helper.scratchDir).toContain("windows-win-helper");

        expect(readFileSync(logPath, { encoding: "utf-8", flag: "a+" })).not.toContain("wsb start");
        const inventory = await client.callTool({
            name: "device_inventory",
            arguments: { backend: "windows-sandbox" },
        });
        expect(inventory.isError).not.toBe(true);
        const inventoryPayload = JSON.parse(((inventory.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            devices: Array<{ id: string; helper: { scratchDir: string }; configPath: string }>;
            discovery: { available: boolean; wsb: string };
            hostSandboxes: { lazy: boolean; provider: string };
        };
        expect(inventoryPayload.discovery.available).toBe(true);
        expect(inventoryPayload.hostSandboxes).toEqual(expect.objectContaining({ lazy: true, provider: "wsb" }));
        expect(inventoryPayload.devices).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: "windows-win-helper",
                helper: expect.objectContaining({ scratchDir: expect.stringContaining("windows-win-helper") }),
                configPath: expect.stringContaining("windows-win-helper.wsb"),
            }),
        ]));
        expect(readFileSync(logPath, { encoding: "utf-8", flag: "a+" })).not.toContain("wsb start");

        const start = await client.callTool({
            name: "device_start",
            arguments: { deviceId: "windows-win-helper" },
        });
        expect(start.isError).not.toBe(true);
        const started = JSON.parse(((start.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: {
                configPath: string;
                helper: {
                    hostHelperScript: string;
                    inboxDir: string;
                    outboxDir: string;
                    downloadsDir: string;
                };
            };
        };
        const config = readFileSync(started.device.configPath, "utf-8");
        expect(config).toContain("<SandboxFolder>C:\\ccc\\scratch</SandboxFolder>");
        expect(config).toContain("<SandboxFolder>C:\\ccc\\tools</SandboxFolder>");
        expect(config).toContain("<ReadOnly>true</ReadOnly>");
        expect(config).toContain("<LogonCommand>");
        expect(config).toContain("ccc-guest-helper.ps1");
        const helperScript = readFileSync(started.device.helper.hostHelperScript, "utf-8");
        expect(helperScript).toContain("Get-ChildItem -Path $Inbox");
        expect(helperScript).toContain("'exec'");
        expect(helperScript).toContain("'screenshot'");
        expect(helperScript).toContain("'upload'");
        expect(helperScript).toContain("'download'");

        const log = readFileSync(logPath, "utf-8");
        expect(log).toContain(`wsb start ${started.device.configPath}`);

        let forceInactiveRecordStatus = false;
        const responder = setInterval(() => {
            let files: string[] = [];
            try {
                files = readdirSync(started.device.helper.inboxDir).filter((name) => name.endsWith(".json"));
            } catch {
                return;
            }
            for (const file of files) {
                const requestPath = join(started.device.helper.inboxDir, file);
                const request = JSON.parse(readFileSync(requestPath, "utf-8")) as {
                    id: string;
                    type: string;
                    command?: string;
                    remotePath?: string;
                    sessionId?: string;
                    timeLimitSec?: number;
                };
                const response: Record<string, unknown> = { id: request.id, ok: true, type: request.type };
                if (request.type === "exec") {
                    response.stdout = `ran ${request.command}`;
                    response.stderr = "";
                    response.status = 0;
                }
                if (request.type === "screenshot") {
                    writeFileSync(join(started.device.helper.downloadsDir, `${request.id}.png`), "fakepng");
                    response.imagePath = `C:\\ccc\\scratch\\downloads\\${request.id}.png`;
                }
                if (request.type === "download") {
                    const remoteName = String(request.remotePath ?? "remote.txt").split(/[\\/]/).filter(Boolean).pop() ?? "remote.txt";
                    const downloadName = `${request.id}-${remoteName}`;
                    writeFileSync(join(started.device.helper.downloadsDir, downloadName), "downloaded");
                    response.downloadPath = `C:\\ccc\\scratch\\downloads\\${downloadName}`;
                }
                if (request.type === "record_start") {
                    response.recording = {
                        sessionId: request.sessionId,
                        frameDir: `C:\\ccc\\scratch\\downloads\\${request.sessionId}-frames`,
                        timeLimitSec: request.timeLimitSec,
                        provider: "windows-helper-frame-archive",
                    };
                }
                if (request.type === "record_status") {
                    if (forceInactiveRecordStatus) {
                        const archiveName = `${request.sessionId}.zip`;
                        writeFileSync(join(started.device.helper.downloadsDir, archiveName), "boundedzip");
                        response.recording = {
                            sessionId: request.sessionId,
                            active: false,
                            state: "Completed",
                            archivePath: `C:\\ccc\\scratch\\downloads\\${archiveName}`,
                            provider: "windows-helper-frame-archive",
                        };
                    } else {
                        response.recording = {
                            sessionId: request.sessionId,
                            active: true,
                            state: "Running",
                            frameDir: `C:\\ccc\\scratch\\downloads\\${request.sessionId}-frames`,
                            provider: "windows-helper-frame-archive",
                        };
                    }
                }
                if (request.type === "record_stop") {
                    const archiveName = `${request.id}.zip`;
                    writeFileSync(join(started.device.helper.downloadsDir, archiveName), "fakezip");
                    response.recording = {
                        sessionId: request.id,
                        active: false,
                        archivePath: `C:\\ccc\\scratch\\downloads\\${archiveName}`,
                        provider: "windows-helper-frame-archive",
                    };
                }
                writeFileSync(join(started.device.helper.outboxDir, `${request.id}.json`), JSON.stringify(response));
                rmSync(requestPath, { force: true });
            }
        }, 25);

        const exec = await client.callTool({
            name: "device_exec",
            arguments: { deviceId: "windows-win-helper", command: "whoami", helperTimeoutMs: 1000 },
        });
        expect(exec.isError).not.toBe(true);
        expect(((exec.content as Array<{ text?: string }>)[0].text ?? "")).toContain("ran whoami");

        const screenshot = await client.callTool({
            name: "device_screenshot",
            arguments: { deviceId: "windows-win-helper", helperTimeoutMs: 1000 },
        });
        expect(screenshot.isError).not.toBe(true);
        expect((screenshot.content as Array<{ type: string }>)[0].type).toBe("image");

        const uploadSource = join(homeDir, "upload.txt");
        writeFileSync(uploadSource, "upload");
        const upload = await client.callTool({
            name: "device_upload",
            arguments: { deviceId: "windows-win-helper", localPath: uploadSource, remotePath: "C:\\Users\\WDAGUtilityAccount\\upload.txt", helperTimeoutMs: 1000 },
        });
        expect(upload.isError).not.toBe(true);

        const downloadTarget = join(homeDir, "download.txt");
        const download = await client.callTool({
            name: "device_download",
            arguments: { deviceId: "windows-win-helper", remotePath: "C:\\Users\\WDAGUtilityAccount\\remote.txt", localPath: downloadTarget, helperTimeoutMs: 1000 },
        });
        expect(download.isError).not.toBe(true);
        expect(readFileSync(downloadTarget, "utf-8")).toBe("downloaded");

        const recordStart = await client.callTool({
            name: "device_record_video_start",
            arguments: { deviceId: "windows-win-helper", localPath: join(homeDir, "windows-recording.zip"), timeLimitSec: 2, helperTimeoutMs: 1000 },
        });
        expect(recordStart.isError).not.toBe(true);
        const recordStartPayload = JSON.parse(((recordStart.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            recording: { active: boolean; provider: string; localPath: string };
        };
        expect(recordStartPayload.recording).toEqual(expect.objectContaining({
            active: true,
            provider: "windows-helper-frame-archive",
            localPath: join(homeDir, "windows-recording.zip"),
            timeLimitSec: 2,
        }));

        const duplicateRecordStart = await client.callTool({
            name: "device_record_video_start",
            arguments: { deviceId: "windows-win-helper", helperTimeoutMs: 1000 },
        });
        expect(duplicateRecordStart.isError).toBe(true);
        expect((duplicateRecordStart.content as Array<{ text?: string }>)[0].text).toContain("Windows Sandbox recording already active");

        const activeRecordStatus = await client.callTool({
            name: "device_record_video_status",
            arguments: { deviceId: "windows-win-helper" },
        });
        expect(activeRecordStatus.isError).not.toBe(true);
        expect(JSON.parse(((activeRecordStatus.content as Array<{ text?: string }>)[0].text ?? "{}")).recording).toEqual(expect.objectContaining({
            active: true,
            provider: "windows-helper-frame-archive",
        }));

        const recordStop = await client.callTool({
            name: "device_record_video_stop",
            arguments: { deviceId: "windows-win-helper", helperTimeoutMs: 1000 },
        });
        expect(recordStop.isError).not.toBe(true);
        const recordStopPayload = JSON.parse(((recordStop.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            recording: { active: boolean; localPath: string };
            device: { recording: unknown };
        };
        expect(recordStopPayload.recording).toEqual(expect.objectContaining({
            active: false,
            localPath: join(homeDir, "windows-recording.zip"),
        }));
        expect(recordStopPayload.device.recording).toBeNull();
        expect(readFileSync(join(homeDir, "windows-recording.zip"), "utf-8")).toBe("fakezip");

        const stopWithoutRecording = await client.callTool({
            name: "device_record_video_stop",
            arguments: { deviceId: "windows-win-helper", helperTimeoutMs: 1000 },
        });
        expect(stopWithoutRecording.isError).toBe(true);
        expect((stopWithoutRecording.content as Array<{ text?: string }>)[0].text).toContain("No Windows Sandbox recording active");

        const boundedRecordStart = await client.callTool({
            name: "device_record_video_start",
            arguments: { deviceId: "windows-win-helper", localPath: join(homeDir, "bounded-windows-recording.zip"), timeLimitSec: 1, helperTimeoutMs: 1000 },
        });
        expect(boundedRecordStart.isError).not.toBe(true);
        forceInactiveRecordStatus = true;
        const inactiveRecordStatus = await client.callTool({
            name: "device_record_video_status",
            arguments: { deviceId: "windows-win-helper", helperTimeoutMs: 1000 },
        });
        expect(inactiveRecordStatus.isError).not.toBe(true);
        expect(JSON.parse(((inactiveRecordStatus.content as Array<{ text?: string }>)[0].text ?? "{}")).recording).toBeNull();
        expect(readFileSync(join(homeDir, "bounded-windows-recording.zip"), "utf-8")).toBe("boundedzip");
        const restartAfterInactiveStatus = await client.callTool({
            name: "device_record_video_start",
            arguments: { deviceId: "windows-win-helper", localPath: join(homeDir, "restart-windows-recording.zip"), helperTimeoutMs: 1000 },
        });
        expect(restartAfterInactiveStatus.isError).not.toBe(true);
        forceInactiveRecordStatus = false;
        const restartStop = await client.callTool({
            name: "device_record_video_stop",
            arguments: { deviceId: "windows-win-helper", helperTimeoutMs: 1000 },
        });
        expect(restartStop.isError).not.toBe(true);
        clearInterval(responder);

        const stop = await client.callTool({
            name: "device_stop",
            arguments: { deviceId: "windows-win-helper" },
        });
        expect(stop.isError).not.toBe(true);
    });

    it("cleans Windows Sandbox scratch on delete and preserves state when forced stop fails", { timeout: TIMEOUT }, async () => {
        const stoppedCreate = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "windows-sandbox",
                name: "Win Delete Stopped",
                deviceId: "windows-delete-stopped",
            },
        });
        expect(stoppedCreate.isError).not.toBe(true);
        const stoppedCreated = JSON.parse(((stoppedCreate.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; helper: { scratchDir: string } };
        };
        expect(existsSync(stoppedCreated.device.helper.scratchDir)).toBe(true);

        const stoppedDelete = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "windows-delete-stopped" },
        });
        expect(stoppedDelete.isError).not.toBe(true);
        expect(existsSync(stoppedCreated.device.helper.scratchDir)).toBe(false);

        const runningCreate = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "windows-sandbox",
                name: "Win Delete Running",
                deviceId: "windows-delete-running",
            },
        });
        expect(runningCreate.isError).not.toBe(true);
        const runningCreated = JSON.parse(((runningCreate.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { helper: { scratchDir: string } };
        };
        const runningStart = await client.callTool({
            name: "device_start",
            arguments: { deviceId: "windows-delete-running" },
        });
        expect(runningStart.isError).not.toBe(true);

        const logBeforeRefusal = readFileSync(logPath, "utf-8");
        const runningDeleteRefused = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "windows-delete-running" },
        });
        expect(runningDeleteRefused.isError).toBe(true);
        expect((runningDeleteRefused.content as Array<{ text?: string }>)[0].text).toContain("Refusing to delete windows-delete-running while status is running");
        expect(readFileSync(logPath, "utf-8")).toBe(logBeforeRefusal);
        expect(existsSync(runningCreated.device.helper.scratchDir)).toBe(true);
        const statusAfterRefusedDelete = await client.callTool({
            name: "device_status",
            arguments: { deviceId: "windows-delete-running" },
        });
        expect(statusAfterRefusedDelete.isError).not.toBe(true);
        expect(JSON.parse(((statusAfterRefusedDelete.content as Array<{ text?: string }>)[0].text ?? "{}")).device.status).toBe("running");

        const logBeforeForceDelete = readFileSync(logPath, "utf-8");
        const runningForceDelete = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "windows-delete-running", force: true },
        });
        expect(runningForceDelete.isError).not.toBe(true);
        const logAfterForceDelete = readFileSync(logPath, "utf-8");
        expect(logAfterForceDelete.slice(logBeforeForceDelete.length)).toContain("wsb stop");
        expect(existsSync(runningCreated.device.helper.scratchDir)).toBe(false);
        const inventoryAfterDelete = await client.callTool({
            name: "device_inventory",
            arguments: { backend: "windows-sandbox" },
        });
        expect(inventoryAfterDelete.isError).not.toBe(true);
        const inventoryAfterDeletePayload = JSON.parse(((inventoryAfterDelete.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            devices: Array<{ id: string }>;
        };
        expect(inventoryAfterDeletePayload.devices.some((device) => device.id === "windows-delete-running")).toBe(false);

        const failCreate = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "windows-sandbox",
                name: "Win Delete Stop Failure",
                deviceId: "windows-delete-stop-failure",
            },
        });
        expect(failCreate.isError).not.toBe(true);
        const failCreated = JSON.parse(((failCreate.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { helper: { scratchDir: string } };
        };
        const failStart = await client.callTool({
            name: "device_start",
            arguments: { deviceId: "windows-delete-stop-failure" },
        });
        expect(failStart.isError).not.toBe(true);

        writeFileSync(failStopPath, "fail");
        const failedForceDelete = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "windows-delete-stop-failure", force: true },
        });
        expect(failedForceDelete.isError).toBe(true);
        expect((failedForceDelete.content as Array<{ text?: string }>)[0].text).toContain("forced stop failure");
        expect(existsSync(failCreated.device.helper.scratchDir)).toBe(true);
        const statusAfterFailedDelete = await client.callTool({
            name: "device_status",
            arguments: { deviceId: "windows-delete-stop-failure" },
        });
        expect(statusAfterFailedDelete.isError).not.toBe(true);
        expect(JSON.parse(((statusAfterFailedDelete.content as Array<{ text?: string }>)[0].text ?? "{}")).device.status).toBe("running");

        rmSync(failStopPath, { force: true });
        const retryForceDelete = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "windows-delete-stop-failure", force: true },
        });
        expect(retryForceDelete.isError).not.toBe(true);
        expect(existsSync(failCreated.device.helper.scratchDir)).toBe(false);
    });
});

describe("device-lab MCP with fake Android SDK", () => {
    let client: Client;
    let homeDir: string;
    let binDir: string;
    let logPath: string;

    beforeAll(async () => {
        homeDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-android-home-"));
        binDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-android-bin-"));
        logPath = join(homeDir, "fake-android.log");

        const writeScript = (name: string, body: string) => {
            const path = join(binDir, name);
            writeFileSync(path, `#!/bin/sh\n${body}\n`);
            chmodSync(path, 0o755);
        };

        writeScript("emulator", `
echo "emulator $*" >> "$FAKE_ANDROID_LOG"
if [ "$1" = "-list-avds" ]; then
  echo "host_pixel"
  echo "ccc-external-other"
  exit 0
fi
exit 0
`);
        writeScript("adb", `
echo "adb $*" >> "$FAKE_ANDROID_LOG"
if [ "$1" = "-s" ]; then
  shift
  shift
fi
if [ "$1" = "devices" ] && [ "$2" = "-l" ]; then
  echo "List of devices attached"
  echo "R5CREAL123 device usb:1-1 product:oriole model:Pixel_6 device:oriole transport_id:7"
  echo "192.168.1.50:5555 device product:oriole model:Pixel_6 device:oriole transport_id:9"
  echo "192.168.1.60:5555 device product:oriole model:Pixel_6 device:oriole transport_id:10"
  echo "R5LEASED999 device usb:1-4 product:oriole model:Pixel_6 device:oriole transport_id:8"
  echo "UNAUTHORIZED unauthorized usb:1-2 model:Pixel_5"
  echo "OFFLINE offline usb:1-3 model:Pixel_4"
  echo "emulator-5554 device product:sdk_gphone"
  exit 0
fi
if [ "$1" = "connect" ]; then
  case "$2" in
    192.168.1.50:5555) echo "connected to $2"; exit 0 ;;
    *) echo "failed to connect to $2" >&2; exit 1 ;;
  esac
fi
if [ "$1" = "get-state" ]; then
  echo "device"
  exit 0
fi
if [ "$1" = "shell" ] && [ "$2" = "getprop" ] && [ "$3" = "sys.boot_completed" ]; then
  echo "1"
  exit 0
fi
if [ "$1" = "shell" ] && [ "$2" = "uiautomator" ] && [ "$3" = "dump" ]; then
  echo "UI hierchary dumped to: $4"
  exit 0
fi
if [ "$1" = "exec-out" ] && [ "$2" = "cat" ]; then
  printf '%s\\n' '<hierarchy><node text="Hello" resource-id="com.example:id/title"/></hierarchy>'
  exit 0
fi
if [ "$1" = "shell" ] && [ "$2" = "cat" ]; then
  printf '%s\\n' '<hierarchy><node text="Hello" resource-id="com.example:id/title"/></hierarchy>'
  exit 0
fi
if [ "$1" = "shell" ] && [ "$2" = "screenrecord" ]; then
  case "$5" in
    *fail-immediate*) exit 9 ;;
    *natural-exit*) exec /bin/sleep 0.3 ;;
    *) exec /bin/sleep 20 ;;
  esac
fi
if [ "$1" = "pull" ]; then
  case "$2" in
    *fail-pull*) exit 8 ;;
    *) exit 0 ;;
  esac
fi
if [ "$1" = "shell" ]; then
  echo "ok"
  exit 0
fi
exit 0
`);
        writeScript("avdmanager", `
echo "avdmanager $*" >> "$FAKE_ANDROID_LOG"
exit 0
`);

        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [join(repoRoot, "device-lab-mcp/server.mjs")],
            env: {
                HOME: homeDir,
                PATH: binDir,
                NODE_ENV: "test",
                FAKE_ANDROID_LOG: logPath,
            },
        });

        client = new Client(
            { name: "ccc-device-lab-android-fake-client", version: "1.0.0" },
            { capabilities: {} },
        );

        await client.connect(transport);
    }, TIMEOUT);

    afterAll(async () => {
        await client?.close();
        if (homeDir) rmSync(homeDir, { recursive: true, force: true });
        if (binDir) rmSync(binDir, { recursive: true, force: true });
    }, TIMEOUT);

    it("discovers avdmanager and reports Android host AVD inventory without starting emulators", { timeout: TIMEOUT }, async () => {
        const backends = await client.callTool({ name: "device_backends", arguments: {} });
        const backendPayload = JSON.parse(((backends.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            backends: Array<{
                name: string;
                status: string;
                tools: { adb?: string; emulator?: string; avdmanager?: string };
                provisioning: { available: boolean; missing: string[] };
            }>;
        };
        const android = backendPayload.backends.find((backend) => backend.name === "android-emulator");
        expect(android).toEqual(expect.objectContaining({
            status: "available",
            provisioning: { available: true, missing: [] },
        }));
        expect(android?.tools.avdmanager).toBe(join(binDir, "avdmanager"));

        const inventory = await client.callTool({
            name: "device_inventory",
            arguments: { backend: "android-emulator" },
        });
        expect(inventory.isError).not.toBe(true);
        const payload = JSON.parse(((inventory.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ownerId: string;
            hostAvds: { available: boolean; avds: string[] };
            devices: Array<{ id: string }>;
        };
        expect(payload.ownerId).toMatch(/^[a-f0-9]{16}$/);
        expect(payload.hostAvds).toEqual({ available: true, missing: [], avds: ["host_pixel", "ccc-external-other"] });
        expect(payload.devices).toEqual([]);

        const log = readFileSync(logPath, "utf-8");
        expect(log).toContain("emulator -list-avds");
        expect(log).not.toContain("emulator -avd");
    });

    it("creates and deletes owner-prefixed AVDs through avdmanager only when requested", { timeout: TIMEOUT }, async () => {
        const inventory = await client.callTool({
            name: "device_inventory",
            arguments: { backend: "android-emulator" },
        });
        const ownerId = (JSON.parse(((inventory.content as Array<{ text?: string }>)[0].text ?? "{}")) as { ownerId: string }).ownerId;
        const avdName = `ccc-${ownerId}-pixel-owned`;

        const create = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "android-emulator",
                name: "Pixel Owned",
                avdName,
                port: 5582,
                systemImage: "system-images;android-35;google_apis;x86_64",
                deviceProfile: "pixel_6",
                createAvd: true,
            },
        });
        expect(create.isError).not.toBe(true);
        const created = JSON.parse(((create.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; avdName: string; provisioned: boolean; status: string };
        };
        expect(created.device).toEqual(expect.objectContaining({
            id: "android-pixel-owned",
            avdName,
            provisioned: true,
            status: "stopped",
        }));

        const start = await client.callTool({
            name: "device_start",
            arguments: { deviceId: "android-pixel-owned", bootTimeoutMs: 1000 },
        });
        expect(start.isError).not.toBe(true);
        const started = JSON.parse(((start.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { status: string; bootReady: boolean };
            boot: { ready: boolean };
        };
        expect(started.boot.ready).toBe(true);
        expect(started.device.status).toBe("running");
        expect(started.device.bootReady).toBe(true);

        const primitiveCalls = [
            ["mobile_tap", { deviceId: "android-pixel-owned", x: 10, y: 20 }],
            ["mobile_double_tap", { deviceId: "android-pixel-owned", x: 11, y: 21 }],
            ["mobile_long_press", { deviceId: "android-pixel-owned", x: 12, y: 22, durationMs: 900 }],
            ["mobile_swipe", { deviceId: "android-pixel-owned", x1: 1, y1: 2, x2: 30, y2: 40, durationMs: 500 }],
            ["mobile_drag", { deviceId: "android-pixel-owned", x1: 3, y1: 4, x2: 50, y2: 60, durationMs: 800 }],
            ["mobile_type_text", { deviceId: "android-pixel-owned", text: "hello world" }],
            ["mobile_key", { deviceId: "android-pixel-owned", keyCode: 82 }],
            ["mobile_home", { deviceId: "android-pixel-owned" }],
            ["mobile_back", { deviceId: "android-pixel-owned" }],
            ["mobile_forward", { deviceId: "android-pixel-owned" }],
            ["mobile_recents", { deviceId: "android-pixel-owned" }],
            ["mobile_power", { deviceId: "android-pixel-owned" }],
            ["mobile_lock", { deviceId: "android-pixel-owned" }],
            ["mobile_unlock", { deviceId: "android-pixel-owned" }],
            ["mobile_set_orientation", { deviceId: "android-pixel-owned", orientation: "landscape" }],
            ["mobile_rotate_left", { deviceId: "android-pixel-owned" }],
            ["mobile_rotate_right", { deviceId: "android-pixel-owned" }],
            ["mobile_open_url", { deviceId: "android-pixel-owned", url: "https://example.test/path" }],
            ["mobile_grant_permission", { deviceId: "android-pixel-owned", packageName: "com.example.mobile", permission: "android.permission.CAMERA" }],
            ["mobile_revoke_permission", { deviceId: "android-pixel-owned", packageName: "com.example.mobile", permission: "android.permission.CAMERA" }],
            ["mobile_set_location", { deviceId: "android-pixel-owned", latitude: 37.7749, longitude: -122.4194, altitude: 10 }],
            ["mobile_set_battery", { deviceId: "android-pixel-owned", level: 42, charging: true }],
            ["mobile_set_network", { deviceId: "android-pixel-owned", wifi: false, data: true }],
            ["mobile_toggle_airplane_mode", { deviceId: "android-pixel-owned", enabled: true }],
            ["mobile_set_clipboard", { deviceId: "android-pixel-owned", text: "clip text" }],
            ["mobile_get_clipboard", { deviceId: "android-pixel-owned" }],
        ] as const;
        for (const [name, callArgs] of primitiveCalls) {
            const action = await client.callTool({ name, arguments: callArgs });
            expect(action.isError).not.toBe(true);
        }
        const waitText = await client.callTool({
            name: "mobile_wait_for_text",
            arguments: { deviceId: "android-pixel-owned", text: "Hello", timeoutMs: 1000, intervalMs: 50 },
        });
        expect(waitText.isError).not.toBe(true);
        const waitTextPayload = JSON.parse(((waitText.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            found: boolean;
            provider: string;
        };
        expect(waitTextPayload).toEqual(expect.objectContaining({ found: true, provider: "adb-uiautomator" }));

        const waitApp = await client.callTool({
            name: "mobile_wait_for_app",
            arguments: { deviceId: "android-pixel-owned", packageName: "com.example.mobile", timeoutMs: 1000, intervalMs: 50 },
        });
        expect(waitApp.isError).not.toBe(true);
        const waitAppPayload = JSON.parse(((waitApp.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            running: boolean;
            provider: string;
        };
        expect(waitAppPayload).toEqual(expect.objectContaining({ running: true, provider: "adb" }));

        const flow = await client.callTool({
            name: "mobile_run_flow",
            arguments: {
                steps: [
                    { label: "tap primary", tool: "mobile_tap", arguments: { deviceId: "android-pixel-owned", x: 15, y: 25 } },
                    { label: "wait title", tool: "mobile_wait_for_text", arguments: { deviceId: "android-pixel-owned", text: "Hello", timeoutMs: 1000, intervalMs: 50 } },
                    { label: "capture", tool: "mobile_screenshot", arguments: { deviceId: "android-pixel-owned" } },
                ],
            },
        });
        expect(flow.isError).not.toBe(true);
        const flowPayload = JSON.parse(((flow.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ok: boolean;
            results: Array<{ label: string; isError: boolean; content: Array<{ type: string; value?: { found?: boolean }; bytes?: number }> }>;
        };
        expect(flowPayload.ok).toBe(true);
        expect(flowPayload.results.map((result) => result.label)).toEqual(["tap primary", "wait title", "capture"]);
        expect(flowPayload.results[1].content[0].value?.found).toBe(true);
        expect(flowPayload.results[2].content[0]).toEqual(expect.objectContaining({ type: "image" }));
        expect(typeof flowPayload.results[2].content[0].bytes).toBe("number");

        const disallowedFlow = await client.callTool({
            name: "mobile_run_flow",
            arguments: {
                steps: [
                    { tool: "device_start", arguments: { deviceId: "android-pixel-owned" } },
                    { tool: "mobile_back", arguments: { deviceId: "android-pixel-owned" } },
                ],
            },
        });
        expect(disallowedFlow.isError).not.toBe(true);
        const disallowedPayload = JSON.parse(((disallowedFlow.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ok: boolean;
            stoppedAt: number;
            results: Array<{ error: string }>;
        };
        expect(disallowedPayload.ok).toBe(false);
        expect(disallowedPayload.stoppedAt).toBe(0);
        expect(disallowedPayload.results[0].error).toContain("does not allow step tool: device_start");

        const screenshot = await client.callTool({
            name: "mobile_screenshot",
            arguments: { deviceId: "android-pixel-owned" },
        });
        expect(screenshot.isError).not.toBe(true);
        expect((screenshot.content as Array<{ type: string }>)[0].type).toBe("image");

        const initialRecordStatus = await client.callTool({
            name: "device_record_video_status",
            arguments: { deviceId: "android-pixel-owned" },
        });
        expect(initialRecordStatus.isError).not.toBe(true);
        const initialRecordPayload = JSON.parse(((initialRecordStatus.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            recording: unknown;
            provider: string;
        };
        expect(initialRecordPayload.recording).toBeNull();
        expect(initialRecordPayload.provider).toBe("adb-screenrecord");

        const stopWithoutRecording = await client.callTool({
            name: "device_record_video_stop",
            arguments: { deviceId: "android-pixel-owned" },
        });
        expect(stopWithoutRecording.isError).toBe(true);
        expect((stopWithoutRecording.content as Array<{ text?: string }>)[0].text).toContain("No Android recording active");

        const recordStart = await client.callTool({
            name: "device_record_video_start",
            arguments: {
                deviceId: "android-pixel-owned",
                remotePath: "/sdcard/custom-android-recording.mp4",
                localPath: "/tmp/custom-android-recording.mp4",
                timeLimitSec: 5,
            },
        });
        expect(recordStart.isError).not.toBe(true);
        const recordStartPayload = JSON.parse(((recordStart.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            recording: { active: boolean; provider: string; remotePath: string; localPath: string; timeLimitSec: number };
        };
        expect(recordStartPayload.recording).toEqual(expect.objectContaining({
            active: true,
            provider: "adb-screenrecord",
            remotePath: "/sdcard/custom-android-recording.mp4",
            localPath: "/tmp/custom-android-recording.mp4",
            timeLimitSec: 5,
        }));

        const duplicateRecordStart = await client.callTool({
            name: "device_record_video_start",
            arguments: { deviceId: "android-pixel-owned" },
        });
        expect(duplicateRecordStart.isError).toBe(true);
        expect((duplicateRecordStart.content as Array<{ text?: string }>)[0].text).toContain("Android recording already active");

        const activeRecordStatus = await client.callTool({
            name: "device_record_video_status",
            arguments: { deviceId: "android-pixel-owned" },
        });
        const activeRecordPayload = JSON.parse(((activeRecordStatus.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            recording: { active: boolean; provider: string };
        };
        expect(activeRecordPayload.recording).toEqual(expect.objectContaining({ active: true, provider: "adb-screenrecord" }));

        const recordStop = await client.callTool({
            name: "device_record_video_stop",
            arguments: { deviceId: "android-pixel-owned" },
        });
        expect(recordStop.isError).not.toBe(true);
        const recordStopPayload = JSON.parse(((recordStop.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            stopped: boolean;
            recording: { active: boolean; localPath: string };
            device: { recording: unknown };
        };
        expect(recordStopPayload.stopped).toBe(true);
        expect(recordStopPayload.recording).toEqual(expect.objectContaining({
            active: false,
            localPath: "/tmp/custom-android-recording.mp4",
        }));
        expect(recordStopPayload.device.recording).toBeNull();

        const finalRecordStatus = await client.callTool({
            name: "device_record_video_status",
            arguments: { deviceId: "android-pixel-owned" },
        });
        expect(JSON.parse(((finalRecordStatus.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            recording: null,
            provider: "adb-screenrecord",
        }));

        const failedRecordStart = await client.callTool({
            name: "device_record_video_start",
            arguments: {
                deviceId: "android-pixel-owned",
                remotePath: "/sdcard/fail-immediate-recording.mp4",
                localPath: "/tmp/fail-immediate-android-recording.mp4",
                timeLimitSec: 5,
            },
        });
        expect(failedRecordStart.isError).toBe(true);
        expect((failedRecordStart.content as Array<{ text?: string }>)[0].text).toContain("recorder exited before it was ready");
        const statusAfterFailedStart = await client.callTool({
            name: "device_record_video_status",
            arguments: { deviceId: "android-pixel-owned" },
        });
        expect(JSON.parse(((statusAfterFailedStart.content as Array<{ text?: string }>)[0].text ?? "{}")).recording).toBeNull();

        const naturalExitStart = await client.callTool({
            name: "device_record_video_start",
            arguments: {
                deviceId: "android-pixel-owned",
                remotePath: "/sdcard/natural-exit-recording.mp4",
                localPath: "/tmp/natural-exit-android-recording.mp4",
                timeLimitSec: 5,
            },
        });
        expect(naturalExitStart.isError).not.toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 500));
        const statusAfterNaturalExit = await client.callTool({
            name: "device_record_video_status",
            arguments: { deviceId: "android-pixel-owned" },
        });
        expect(JSON.parse(((statusAfterNaturalExit.content as Array<{ text?: string }>)[0].text ?? "{}")).recording).toBeNull();

        const pullFailStart = await client.callTool({
            name: "device_record_video_start",
            arguments: {
                deviceId: "android-pixel-owned",
                remotePath: "/sdcard/fail-pull-recording.mp4",
                localPath: "/tmp/fail-pull-android-recording.mp4",
                timeLimitSec: 5,
            },
        });
        expect(pullFailStart.isError).not.toBe(true);
        const pullFailStop = await client.callTool({
            name: "device_record_video_stop",
            arguments: { deviceId: "android-pixel-owned" },
        });
        expect(pullFailStop.isError).toBe(true);
        expect((pullFailStop.content as Array<{ text?: string }>)[0].text).toContain("Android recording state cleared");
        const statusAfterPullFailure = await client.callTool({
            name: "device_record_video_status",
            arguments: { deviceId: "android-pixel-owned" },
        });
        expect(JSON.parse(((statusAfterPullFailure.content as Array<{ text?: string }>)[0].text ?? "{}")).recording).toBeNull();

        const stopCleanupRecordStart = await client.callTool({
            name: "device_record_video_start",
            arguments: {
                deviceId: "android-pixel-owned",
                remotePath: "/sdcard/stop-cleanup-recording.mp4",
                localPath: "/tmp/stop-cleanup-android-recording.mp4",
                timeLimitSec: 5,
            },
        });
        expect(stopCleanupRecordStart.isError).not.toBe(true);

        const dumpUi = await client.callTool({
            name: "mobile_dump_ui",
            arguments: { deviceId: "android-pixel-owned" },
        });
        expect(dumpUi.isError).not.toBe(true);
        const dumpPayload = JSON.parse(((dumpUi.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            provider: string;
            source: string;
            remotePath: string;
        };
        expect(dumpPayload.provider).toBe("adb-uiautomator");
        expect(dumpPayload.source).toContain("<hierarchy>");
        expect(dumpPayload.remotePath).toContain("android-pixel-owned");

        const fileAndAppCalls = [
            ["device_upload", { deviceId: "android-pixel-owned", localPath: "/tmp/local.txt", remotePath: "/sdcard/local.txt" }],
            ["device_download", { deviceId: "android-pixel-owned", remotePath: "/sdcard/remote.txt", localPath: "/tmp/remote.txt" }],
            ["device_install_app", { deviceId: "android-pixel-owned", path: "/tmp/Test.apk" }],
            ["device_launch_app", { deviceId: "android-pixel-owned", packageName: "com.example.test" }],
            ["device_launch_app", { deviceId: "android-pixel-owned", component: "com.example.test/.MainActivity" }],
            ["device_reset", { deviceId: "android-pixel-owned", packageName: "com.example.test" }],
            ["mobile_install_app", { deviceId: "android-pixel-owned", path: "/tmp/Mobile.apk" }],
            ["mobile_launch_app", { deviceId: "android-pixel-owned", packageName: "com.example.mobile" }],
            ["mobile_uninstall_app", { deviceId: "android-pixel-owned", packageName: "com.example.mobile" }],
            ["mobile_stop_app", { deviceId: "android-pixel-owned", packageName: "com.example.mobile" }],
            ["mobile_clear_app_data", { deviceId: "android-pixel-owned", packageName: "com.example.mobile" }],
        ] as const;
        for (const [name, callArgs] of fileAndAppCalls) {
            const action = await client.callTool({ name, arguments: callArgs });
            expect(action.isError).not.toBe(true);
        }

        const deleteWhileRunning = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "android-pixel-owned", deleteAvd: true },
        });
        expect(deleteWhileRunning.isError).toBe(true);

        const stop = await client.callTool({
            name: "device_stop",
            arguments: { deviceId: "android-pixel-owned" },
        });
        expect(stop.isError).not.toBe(true);
        const stoppedPayload = JSON.parse(((stop.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { recording: unknown; status: string };
        };
        expect(stoppedPayload.device.status).toBe("stopped");
        expect(stoppedPayload.device.recording).toBeNull();

        const statusAfterDeviceStop = await client.callTool({
            name: "device_record_video_status",
            arguments: { deviceId: "android-pixel-owned" },
        });
        expect(JSON.parse(((statusAfterDeviceStop.content as Array<{ text?: string }>)[0].text ?? "{}")).recording).toBeNull();

        const deleted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "android-pixel-owned", deleteAvd: true },
        });
        expect(deleted.isError).not.toBe(true);
        const deletedPayload = JSON.parse(((deleted.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            deleted: string;
            avdDeleted: boolean;
        };
        expect(deletedPayload).toEqual({ deleted: "android-pixel-owned", avdDeleted: true });

        const log = readFileSync(logPath, "utf-8");
        expect(log).toContain(`avdmanager create avd --name ${avdName} --package system-images;android-35;google_apis;x86_64 --force --device pixel_6`);
        expect(log).toContain(`emulator -avd ${avdName}`);
        expect(log).toContain("adb -s emulator-5582 shell getprop sys.boot_completed");
        expect(log).toContain("adb -s emulator-5582 shell input tap 10 20");
        expect(log).toContain("adb -s emulator-5582 shell input swipe 12 22 12 22 900");
        expect(log).toContain("adb -s emulator-5582 shell input swipe 1 2 30 40 500");
        expect(log).toContain("adb -s emulator-5582 shell input swipe 3 4 50 60 800");
        expect(log).toContain("adb -s emulator-5582 shell input text hello%sworld");
        expect(log).toContain("adb -s emulator-5582 shell input keyevent 82");
        expect(log).toContain("adb -s emulator-5582 shell input keyevent 3");
        expect(log).toContain("adb -s emulator-5582 shell input keyevent 4");
        expect(log).toContain("adb -s emulator-5582 shell input keyevent 125");
        expect(log).toContain("adb -s emulator-5582 shell input keyevent 187");
        expect(log).toContain("adb -s emulator-5582 shell input keyevent 26");
        expect(log).toContain("adb -s emulator-5582 shell input keyevent 223");
        expect(log).toContain("adb -s emulator-5582 shell input keyevent 224");
        expect(log).toContain("adb -s emulator-5582 shell settings put system accelerometer_rotation 0");
        expect(log).toContain("adb -s emulator-5582 shell settings put system user_rotation 1");
        expect(log).toContain("adb -s emulator-5582 shell settings put system user_rotation 3");
        expect(log).toContain("adb -s emulator-5582 shell am start -a android.intent.action.VIEW -d https://example.test/path");
        expect(log).toContain("adb -s emulator-5582 shell pm grant com.example.mobile android.permission.CAMERA");
        expect(log).toContain("adb -s emulator-5582 shell pm revoke com.example.mobile android.permission.CAMERA");
        expect(log).toContain("adb -s emulator-5582 emu geo fix -122.4194 37.7749 10");
        expect(log).toContain("adb -s emulator-5582 shell dumpsys battery set level 42");
        expect(log).toContain("adb -s emulator-5582 shell dumpsys battery set ac 1");
        expect(log).toContain("adb -s emulator-5582 shell svc wifi disable");
        expect(log).toContain("adb -s emulator-5582 shell svc data enable");
        expect(log).toContain("adb -s emulator-5582 shell settings put global airplane_mode_on 1");
        expect(log).toContain("adb -s emulator-5582 shell am broadcast -a android.intent.action.AIRPLANE_MODE --ez state true");
        expect(log).toContain("adb -s emulator-5582 shell cmd clipboard set clip text");
        expect(log).toContain("adb -s emulator-5582 shell cmd clipboard get");
        expect(log).toContain("adb -s emulator-5582 shell pidof com.example.mobile");
        expect(log).toContain("adb -s emulator-5582 shell input tap 15 25");
        expect(log).toContain("adb -s emulator-5582 exec-out screencap -p");
        expect(log).toContain("adb -s emulator-5582 shell screenrecord --time-limit 5 /sdcard/custom-android-recording.mp4");
        expect(log).toContain("adb -s emulator-5582 shell pkill -2 screenrecord");
        expect(log).toContain("adb -s emulator-5582 pull /sdcard/custom-android-recording.mp4 /tmp/custom-android-recording.mp4");
        expect(log).toContain("adb -s emulator-5582 shell rm -f /sdcard/custom-android-recording.mp4");
        expect(log).toContain("adb -s emulator-5582 shell screenrecord --time-limit 5 /sdcard/fail-immediate-recording.mp4");
        expect(log).toContain("adb -s emulator-5582 shell screenrecord --time-limit 5 /sdcard/natural-exit-recording.mp4");
        expect(log).toContain("adb -s emulator-5582 pull /sdcard/fail-pull-recording.mp4 /tmp/fail-pull-android-recording.mp4");
        expect(log).toContain("adb -s emulator-5582 shell screenrecord --time-limit 5 /sdcard/stop-cleanup-recording.mp4");
        expect(log).toContain("adb -s emulator-5582 shell uiautomator dump /sdcard/window-android-pixel-owned.xml");
        expect(log).toContain("adb -s emulator-5582 exec-out cat /sdcard/window-android-pixel-owned.xml");
        expect(log).toContain("adb -s emulator-5582 push /tmp/local.txt /sdcard/local.txt");
        expect(log).toContain("adb -s emulator-5582 pull /sdcard/remote.txt /tmp/remote.txt");
        expect(log).toContain("adb -s emulator-5582 install -r /tmp/Test.apk");
        expect(log).toContain("adb -s emulator-5582 shell monkey -p com.example.test 1");
        expect(log).toContain("adb -s emulator-5582 shell am start -n com.example.test/.MainActivity");
        expect(log).toContain("adb -s emulator-5582 shell pm clear com.example.test");
        expect(log).toContain("adb -s emulator-5582 install -r /tmp/Mobile.apk");
        expect(log).toContain("adb -s emulator-5582 shell monkey -p com.example.mobile 1");
        expect(log).toContain("adb -s emulator-5582 uninstall com.example.mobile");
        expect(log).toContain("adb -s emulator-5582 shell am force-stop com.example.mobile");
        expect(log).toContain("adb -s emulator-5582 shell pm clear com.example.mobile");
        expect(log).toContain(`avdmanager delete avd --name ${avdName}`);
        expect(log).not.toContain("appium");
    });

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

    it("refuses avdmanager create/delete for non-owned Android AVD names", { timeout: TIMEOUT }, async () => {
        const inventory = await client.callTool({
            name: "device_inventory",
            arguments: { backend: "android-emulator" },
        });
        const ownerId = (JSON.parse(((inventory.content as Array<{ text?: string }>)[0].text ?? "{}")) as { ownerId: string }).ownerId;
        const metadataOnlyAvd = `ccc-${ownerId}-metadata-only`;

        const metadataWithSystemImage = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "android-emulator",
                name: "Metadata System Image",
                avdName: metadataOnlyAvd,
                systemImage: "system-images;android-35;google_apis;x86_64",
            },
        });
        expect(metadataWithSystemImage.isError).not.toBe(true);
        const metadataPayload = JSON.parse(((metadataWithSystemImage.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { provisioned: boolean; systemImage: string };
        };
        expect(metadataPayload.device.provisioned).toBe(false);
        expect(metadataPayload.device.systemImage).toBe("system-images;android-35;google_apis;x86_64");

        const metadataSystemImageDeleted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "android-metadata-system-image" },
        });
        expect(metadataSystemImageDeleted.isError).not.toBe(true);

        const create = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "android-emulator",
                name: "Foreign Create",
                avdName: "foreign-avd",
                systemImage: "system-images;android-35;google_apis;x86_64",
                createAvd: true,
            },
        });
        expect(create.isError).toBe(true);
        expect((create.content as Array<{ text?: string }>)[0].text).toContain("Refusing to create non-owned Android AVD name");

        const metadataOnly = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "android-emulator",
                name: "Foreign Metadata",
                avdName: "foreign-avd",
            },
        });
        expect(metadataOnly.isError).not.toBe(true);

        const start = await client.callTool({
            name: "device_start",
            arguments: { deviceId: "android-foreign-metadata", bootTimeoutMs: 1000 },
        });
        expect(start.isError).toBe(true);
        expect((start.content as Array<{ text?: string }>)[0].text).toContain("Refusing to start non-owned Android AVD name");

        const deleted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "android-foreign-metadata", deleteAvd: true },
        });
        expect(deleted.isError).toBe(true);
        expect((deleted.content as Array<{ text?: string }>)[0].text).toContain("Refusing to delete non-owned Android AVD name");

        const metadataDeleted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "android-foreign-metadata" },
        });
        expect(metadataDeleted.isError).not.toBe(true);

        const log = readFileSync(logPath, "utf-8");
        expect(log).not.toContain(`avdmanager create avd --name ${metadataOnlyAvd}`);
        expect(log).not.toContain("emulator -avd foreign-avd");
    });
});

describe("device-lab MCP with fake iOS simctl", () => {
    let client: Client;
    let homeDir: string;
    let binDir: string;
    let logPath: string;

    beforeAll(async () => {
        homeDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-ios-home-"));
        binDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-ios-bin-"));
        logPath = join(homeDir, "fake-ios.log");
        const containerRoot = join(homeDir, "ios-app-container");

        const xcrunPath = join(binDir, "xcrun");
        writeFileSync(xcrunPath, `#!/bin/sh
echo "xcrun $*" >> "$FAKE_IOS_LOG"
if [ "$1" = "simctl" ] && [ "$2" = "list" ]; then
  printf '%s\\n' '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-17-0":[{"name":"host iPhone","udid":"HOST-UDID","state":"Shutdown"}]},"runtimes":[{"identifier":"com.apple.CoreSimulator.SimRuntime.iOS-17-0","name":"iOS 17.0","isAvailable":true}],"devicetypes":[{"identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-15","name":"iPhone 15"}]}'
  exit 0
fi
if [ "$1" = "xctrace" ] && [ "$2" = "list" ] && [ "$3" = "devices" ]; then
  echo "Devices:"
  echo "Build Mac (15.0) (AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE)"
  echo "Real iPhone (17.5) (00008110-001C195E0E91801E)"
  echo "Network iPhone (17.5) (00008120-00AA00BB00CC00DD) (Network)"
  echo "Other iPhone (16.7) (00008101-00DEADBEEFCAFE00)"
  echo "Simulators:"
  echo "iPhone 15 Simulator (17.0) (SIM-UDID)"
  exit 0
fi
if [ "$1" = "devicectl" ] && [ "$2" = "device" ] && [ "$3" = "install" ] && [ "$4" = "app" ]; then
  exit 0
fi
if [ "$1" = "devicectl" ] && [ "$2" = "device" ] && [ "$3" = "process" ] && [ "$4" = "launch" ]; then
  echo "launched $8"
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "create" ]; then
  echo "CREATED-IOS-UDID"
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "boot" ]; then
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "bootstatus" ]; then
  echo "Booted"
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "shutdown" ]; then
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "delete" ]; then
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "erase" ]; then
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "get_app_container" ]; then
  mkdir -p "$FAKE_IOS_CONTAINER_ROOT"
  echo "$FAKE_IOS_CONTAINER_ROOT"
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "spawn" ]; then
  echo "ok"
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "io" ] && [ "$4" = "screenshot" ]; then
  printf 'fakepng' > "$5"
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "io" ] && [ "$4" = "recordVideo" ]; then
  case "$5" in
    *fail-immediate*) exit 9 ;;
    *natural-exit*) exec /bin/sleep 0.3 ;;
    *) exec /bin/sleep 20 ;;
  esac
fi
if [ "$1" = "simctl" ] && [ "$2" = "openurl" ]; then
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "install" ]; then
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "launch" ]; then
  echo "$4: 123"
  exit 0
fi
exit 0
`);
        chmodSync(xcrunPath, 0o755);
        const appiumPath = join(binDir, "appium");
        writeFileSync(appiumPath, `#!/bin/sh
echo "appium $*" >> "$FAKE_IOS_LOG"
PORT=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--port" ]; then
    shift
    PORT="$1"
  fi
  shift
done
exec "${process.execPath}" - "$PORT" "$FAKE_IOS_LOG" "${join(homeDir, "stale-ios-session")}" <<'NODE'
const http = require('http');
const fs = require('fs');
const port = Number(process.argv[2]);
const log = process.argv[3];
const stalePath = process.argv[4];
let sessionCounter = 0;
let sessionId = null;
function send(res, status, payload) {
  res.writeHead(status, {'Content-Type': 'application/json'});
  res.end(JSON.stringify(payload));
}
const server = http.createServer((req, res) => {
  fs.appendFileSync(log, 'appium-http ' + req.method + ' ' + req.url + '\\n');
  if (req.method === 'GET' && req.url === '/status') return send(res, 200, {value: {ready: true}});
  if (req.method === 'POST' && req.url === '/session') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      fs.appendFileSync(log, 'appium-session-body ' + body + '\\n');
      sessionCounter += 1;
      sessionId = 'IOS-SESSION-' + sessionCounter;
      send(res, 200, {value: {sessionId}});
    });
    return;
  }
  if (req.method === 'GET' && sessionId && req.url === '/session/' + sessionId) {
    if (fs.existsSync(stalePath)) {
      fs.unlinkSync(stalePath);
      send(res, 404, {value: {error: 'stale'}});
      return;
    }
    return send(res, 200, {value: {sessionId}});
  }
  if (req.method === 'GET' && sessionId && req.url === '/session/' + sessionId + '/source') {
    if (fs.existsSync(stalePath + '-source-fail')) {
      return send(res, 500, {value: {error: 'source failed'}});
    }
    return send(res, 200, {value: '<AppiumAUT><XCUIElementTypeApplication name="Test"/></AppiumAUT>'});
  }
  if (req.method === 'GET' && sessionId && req.url === '/session/' + sessionId + '/screenshot') {
    return send(res, 200, {value: Buffer.from('fake-real-ios-png').toString('base64')});
  }
  if (req.method === 'POST' && sessionId && (
    req.url === '/session/' + sessionId + '/actions' ||
    req.url === '/session/' + sessionId + '/keys' ||
    req.url === '/session/' + sessionId + '/execute/sync' ||
    req.url === '/session/' + sessionId + '/orientation'
  )) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      fs.appendFileSync(log, 'appium-command-body ' + req.url + ' ' + body + '\\n');
      send(res, 200, {value: null});
    });
    return;
  }
  send(res, 404, {value: {error: 'unknown route'}});
});
process.on('SIGINT', () => {
  fs.appendFileSync(log, 'appium-server-sigint ' + port + '\\n');
  server.close(() => process.exit(0));
});
server.listen(port, '127.0.0.1');
NODE
`);
        chmodSync(appiumPath, 0o755);

        const xcodebuildPath = join(binDir, "xcodebuild");
        writeFileSync(xcodebuildPath, `#!/bin/sh
echo "xcodebuild $*" >> "$FAKE_IOS_LOG"
if [ "$1" = "-version" ]; then
  echo "Xcode 15.0"
  exit 0
fi
exit 0
`);
        chmodSync(xcodebuildPath, 0o755);

        for (const name of ["appium-xcuitest-driver", "xcodebuild"]) {
            const toolPath = join(binDir, name);
            writeFileSync(toolPath, `#!/bin/sh
echo "${name} $*" >> "$FAKE_IOS_LOG"
exit 0
`);
            chmodSync(toolPath, 0o755);
        }

        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [join(repoRoot, "device-lab-mcp/server.mjs")],
            env: {
                HOME: homeDir,
                PATH: binDir,
                NODE_ENV: "test",
                FAKE_IOS_LOG: logPath,
                FAKE_IOS_CONTAINER_ROOT: containerRoot,
            },
        });

        client = new Client(
            { name: "ccc-device-lab-ios-fake-client", version: "1.0.0" },
            { capabilities: {} },
        );

        await client.connect(transport);
    }, TIMEOUT);

    afterAll(async () => {
        await client?.close();
        if (homeDir) rmSync(homeDir, { recursive: true, force: true });
        if (binDir) rmSync(binDir, { recursive: true, force: true });
    }, TIMEOUT);

    it("reports iOS simctl inventory without booting simulators", { timeout: TIMEOUT }, async () => {
        const inventory = await client.callTool({
            name: "device_inventory",
            arguments: { backend: "ios-simulator" },
        });
        expect(inventory.isError).not.toBe(true);
        const payload = JSON.parse(((inventory.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ownerId: string;
            hostSimulators: {
                available: boolean;
                devices: Record<string, Array<{ name: string; udid: string; state: string }>>;
                runtimes: Array<{ identifier: string }>;
                deviceTypes: Array<{ identifier: string }>;
            };
            devices: Array<{ id: string }>;
            discovery: { available: boolean; xcrun: string };
        };
        expect(payload.ownerId).toMatch(/^[a-f0-9]{16}$/);
        expect(payload.discovery).toEqual({ available: true, missing: [], xcrun: join(binDir, "xcrun") });
        expect(payload.hostSimulators.available).toBe(true);
        expect(payload.hostSimulators.runtimes[0].identifier).toBe("com.apple.CoreSimulator.SimRuntime.iOS-17-0");
        expect(payload.hostSimulators.deviceTypes[0].identifier).toBe("com.apple.CoreSimulator.SimDeviceType.iPhone-15");
        expect(payload.devices).toEqual([]);

        const log = readFileSync(logPath, "utf-8");
        expect(log).toContain("xcrun simctl list -j");
        expect(log).not.toContain("xcrun simctl boot ");
        expect(log).not.toContain("xcrun simctl create ");
    });

    it("creates, boots, stops, and deletes owner-prefixed iOS simulators only when explicit", { timeout: TIMEOUT }, async () => {
        const inventory = await client.callTool({
            name: "device_inventory",
            arguments: { backend: "ios-simulator" },
        });
        const ownerId = (JSON.parse(((inventory.content as Array<{ text?: string }>)[0].text ?? "{}")) as { ownerId: string }).ownerId;
        const simulatorName = `ccc-${ownerId}-iphone-owned`;
        const ownedDeviceId = `ios-iphone-owned-${Date.now()}`;

        const create = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "ios-simulator",
                name: "iPhone Owned",
                deviceId: ownedDeviceId,
                simulatorName,
                deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-15",
                runtime: "com.apple.CoreSimulator.SimRuntime.iOS-17-0",
                createSimulator: true,
            },
        });
        expect(create.isError).not.toBe(true);
        const created = JSON.parse(((create.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; simulatorName: string; udid: string; provisioning: string; status: string };
        };
        expect(created.device).toEqual(expect.objectContaining({
            id: ownedDeviceId,
            simulatorName,
            udid: "CREATED-IOS-UDID",
            provisioning: "created",
            status: "stopped",
        }));

        const start = await client.callTool({
            name: "device_start",
            arguments: { deviceId: ownedDeviceId, bootTimeoutMs: 1000 },
        });
        expect(start.isError).not.toBe(true);
        const started = JSON.parse(((start.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { status: string; bootReady: boolean };
            boot: { ready: boolean };
        };
        expect(started.boot.ready).toBe(true);
        expect(started.device.status).toBe("booted");
        expect(started.device.bootReady).toBe(true);

        const openUrl = await client.callTool({
            name: "mobile_open_url",
            arguments: { deviceId: ownedDeviceId, url: "https://example.test/ios" },
        });
        expect(openUrl.isError).not.toBe(true);
        const openUrlPayload = JSON.parse(((openUrl.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            openedUrl: string;
            provider: string;
        };
        expect(openUrlPayload).toEqual(expect.objectContaining({
            openedUrl: "https://example.test/ios",
            provider: "simctl",
        }));

        const installApp = await client.callTool({
            name: "mobile_install_app",
            arguments: { deviceId: ownedDeviceId, path: "/tmp/Test.app" },
        });
        expect(installApp.isError).not.toBe(true);

        const launchApp = await client.callTool({
            name: "mobile_launch_app",
            arguments: { deviceId: ownedDeviceId, bundleId: "com.example.Test" },
        });
        expect(launchApp.isError).not.toBe(true);

        const commonInstall = await client.callTool({
            name: "device_install_app",
            arguments: { deviceId: ownedDeviceId, path: "/tmp/Common.app" },
        });
        expect(commonInstall.isError).not.toBe(true);

        const commonLaunch = await client.callTool({
            name: "device_launch_app",
            arguments: { deviceId: ownedDeviceId, bundleId: "com.example.Common" },
        });
        expect(commonLaunch.isError).not.toBe(true);

        const advancedIosCalls = [
            ["mobile_grant_permission", { deviceId: ownedDeviceId, bundleId: "com.example.Test", service: "camera" }],
            ["mobile_revoke_permission", { deviceId: ownedDeviceId, bundleId: "com.example.Test", service: "camera" }],
            ["mobile_set_location", { deviceId: ownedDeviceId, latitude: 37.7749, longitude: -122.4194 }],
            ["mobile_set_clipboard", { deviceId: ownedDeviceId, text: "ios clip" }],
            ["mobile_get_clipboard", { deviceId: ownedDeviceId }],
            ["mobile_wait_for_app", { deviceId: ownedDeviceId, bundleId: "com.example.Test", timeoutMs: 1000, intervalMs: 50 }],
        ] as const;
        for (const [name, callArgs] of advancedIosCalls) {
            const action = await client.callTool({ name, arguments: callArgs });
            expect(action.isError).not.toBe(true);
        }

        const iosContainerRoot = join(homeDir, "ios-app-container");
        const localUploadPath = join(homeDir, "ios-upload.txt");
        const localDownloadPath = join(homeDir, "ios-download.txt");
        mkdirSync(iosContainerRoot, { recursive: true });
        writeFileSync(localUploadPath, "ios upload content");
        const upload = await client.callTool({
            name: "device_upload",
            arguments: { deviceId: ownedDeviceId, localPath: localUploadPath, remotePath: "/Documents/uploaded.txt", bundleId: "com.example.Test" },
        });
        expect(upload.isError, (upload.content as Array<{ text?: string }>)[0].text).not.toBe(true);
        const uploadPayload = JSON.parse(((upload.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            uploaded: { remotePath: string; bundleId: string; containerType: string };
            containerRoot: string;
        };
        expect(uploadPayload.uploaded).toEqual(expect.objectContaining({
            remotePath: "Documents/uploaded.txt",
            bundleId: "com.example.Test",
            containerType: "data",
        }));
        expect(uploadPayload.containerRoot).toBe(iosContainerRoot);
        expect(readFileSync(join(iosContainerRoot, "Documents/uploaded.txt"), "utf-8")).toBe("ios upload content");

        const download = await client.callTool({
            name: "device_download",
            arguments: { deviceId: ownedDeviceId, remotePath: "Documents/uploaded.txt", localPath: localDownloadPath, bundleId: "com.example.Test" },
        });
        expect(download.isError).not.toBe(true);
        expect(readFileSync(localDownloadPath, "utf-8")).toBe("ios upload content");

        const missingBundleUpload = await client.callTool({
            name: "device_upload",
            arguments: { deviceId: ownedDeviceId, localPath: localUploadPath, remotePath: "Documents/missing.txt" },
        });
        expect(missingBundleUpload.isError).toBe(true);
        expect((missingBundleUpload.content as Array<{ text?: string }>)[0].text).toContain("upload requires bundleId");

        const missingLocalUpload = await client.callTool({
            name: "device_upload",
            arguments: { deviceId: ownedDeviceId, localPath: join(homeDir, "missing-upload.txt"), remotePath: "Documents/missing.txt", bundleId: "com.example.Test" },
        });
        expect(missingLocalUpload.isError).toBe(true);
        expect((missingLocalUpload.content as Array<{ text?: string }>)[0].text).toContain("localPath does not exist");

        const escapingUpload = await client.callTool({
            name: "device_upload",
            arguments: { deviceId: ownedDeviceId, localPath: localUploadPath, remotePath: "../escape.txt", bundleId: "com.example.Test" },
        });
        expect(escapingUpload.isError).toBe(true);
        expect((escapingUpload.content as Array<{ text?: string }>)[0].text).toContain("Refusing path outside iOS app container");

        const outsideContainerDir = join(homeDir, "outside-ios-container");
        mkdirSync(outsideContainerDir, { recursive: true });
        writeFileSync(join(outsideContainerDir, "outside.txt"), "outside");
        symlinkSync(outsideContainerDir, join(iosContainerRoot, "Links"));
        const symlinkUpload = await client.callTool({
            name: "device_upload",
            arguments: { deviceId: ownedDeviceId, localPath: localUploadPath, remotePath: "Links/escape.txt", bundleId: "com.example.Test" },
        });
        expect(symlinkUpload.isError).toBe(true);
        expect((symlinkUpload.content as Array<{ text?: string }>)[0].text).toContain("escapes the container");

        const symlinkDownload = await client.callTool({
            name: "device_download",
            arguments: { deviceId: ownedDeviceId, remotePath: "Links/outside.txt", localPath: join(homeDir, "symlink-download.txt"), bundleId: "com.example.Test" },
        });
        expect(symlinkDownload.isError).toBe(true);
        expect((symlinkDownload.content as Array<{ text?: string }>)[0].text).toContain("escapes the container");

        const reset = await client.callTool({
            name: "device_reset",
            arguments: { deviceId: ownedDeviceId, bundleId: "com.example.Test" },
        });
        expect(reset.isError).not.toBe(true);
        const resetPayload = JSON.parse(((reset.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            reset: { bundleId: string; containerType: string };
            containerRoot: string;
        };
        expect(resetPayload.reset).toEqual({ bundleId: "com.example.Test", containerType: "data" });
        expect(resetPayload.containerRoot).toBe(iosContainerRoot);
        expect(() => readFileSync(join(iosContainerRoot, "Documents/uploaded.txt"), "utf-8")).toThrow();

        const missingRemoteDownload = await client.callTool({
            name: "device_download",
            arguments: { deviceId: ownedDeviceId, remotePath: "Documents/uploaded.txt", localPath: join(homeDir, "missing-download.txt"), bundleId: "com.example.Test" },
        });
        expect(missingRemoteDownload.isError).toBe(true);
        expect((missingRemoteDownload.content as Array<{ text?: string }>)[0].text).toContain("remotePath does not exist");

        const screenshot = await client.callTool({
            name: "mobile_screenshot",
            arguments: { deviceId: ownedDeviceId },
        });
        expect(screenshot.isError).not.toBe(true);
        expect((screenshot.content as Array<{ type: string }>)[0].type).toBe("image");

        const initialRecordStatus = await client.callTool({
            name: "device_record_video_status",
            arguments: { deviceId: ownedDeviceId },
        });
        expect(initialRecordStatus.isError).not.toBe(true);
        const initialRecordPayload = JSON.parse(((initialRecordStatus.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            recording: unknown;
            provider: string;
        };
        expect(initialRecordPayload.recording).toBeNull();
        expect(initialRecordPayload.provider).toBe("simctl-recordVideo");

        const stopWithoutRecording = await client.callTool({
            name: "device_record_video_stop",
            arguments: { deviceId: ownedDeviceId },
        });
        expect(stopWithoutRecording.isError).toBe(true);
        expect((stopWithoutRecording.content as Array<{ text?: string }>)[0].text).toContain("No iOS Simulator recording active");

        const recordStart = await client.callTool({
            name: "device_record_video_start",
            arguments: { deviceId: ownedDeviceId, localPath: "/tmp/custom-ios-recording.mp4" },
        });
        expect(recordStart.isError).not.toBe(true);
        const recordStartPayload = JSON.parse(((recordStart.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            recording: { active: boolean; provider: string; localPath: string };
        };
        expect(recordStartPayload.recording).toEqual(expect.objectContaining({
            active: true,
            provider: "simctl-recordVideo",
            localPath: "/tmp/custom-ios-recording.mp4",
        }));

        const duplicateRecordStart = await client.callTool({
            name: "device_record_video_start",
            arguments: { deviceId: ownedDeviceId },
        });
        expect(duplicateRecordStart.isError).toBe(true);
        expect((duplicateRecordStart.content as Array<{ text?: string }>)[0].text).toContain("iOS Simulator recording already active");

        const activeRecordStatus = await client.callTool({
            name: "device_record_video_status",
            arguments: { deviceId: ownedDeviceId },
        });
        const activeRecordPayload = JSON.parse(((activeRecordStatus.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            recording: { active: boolean; provider: string };
        };
        expect(activeRecordPayload.recording).toEqual(expect.objectContaining({ active: true, provider: "simctl-recordVideo" }));

        const recordStop = await client.callTool({
            name: "device_record_video_stop",
            arguments: { deviceId: ownedDeviceId },
        });
        expect(recordStop.isError).not.toBe(true);
        const recordStopPayload = JSON.parse(((recordStop.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            stopped: boolean;
            recording: { active: boolean; localPath: string };
            device: { recording: unknown };
        };
        expect(recordStopPayload.stopped).toBe(true);
        expect(recordStopPayload.recording).toEqual(expect.objectContaining({
            active: false,
            localPath: "/tmp/custom-ios-recording.mp4",
        }));
        expect(recordStopPayload.device.recording).toBeNull();

        const failedRecordStart = await client.callTool({
            name: "device_record_video_start",
            arguments: { deviceId: ownedDeviceId, localPath: "/tmp/fail-immediate-ios-recording.mp4" },
        });
        expect(failedRecordStart.isError).toBe(true);
        expect((failedRecordStart.content as Array<{ text?: string }>)[0].text).toContain("recorder exited before it was ready");
        const statusAfterFailedStart = await client.callTool({
            name: "device_record_video_status",
            arguments: { deviceId: ownedDeviceId },
        });
        expect(JSON.parse(((statusAfterFailedStart.content as Array<{ text?: string }>)[0].text ?? "{}")).recording).toBeNull();

        const naturalExitStart = await client.callTool({
            name: "device_record_video_start",
            arguments: { deviceId: ownedDeviceId, localPath: "/tmp/natural-exit-ios-recording.mp4" },
        });
        expect(naturalExitStart.isError).not.toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 500));
        const statusAfterNaturalExit = await client.callTool({
            name: "device_record_video_status",
            arguments: { deviceId: ownedDeviceId },
        });
        expect(JSON.parse(((statusAfterNaturalExit.content as Array<{ text?: string }>)[0].text ?? "{}")).recording).toBeNull();

        const stopCleanupRecordStart = await client.callTool({
            name: "device_record_video_start",
            arguments: { deviceId: ownedDeviceId, localPath: "/tmp/stop-cleanup-ios-recording.mp4" },
        });
        expect(stopCleanupRecordStart.isError).not.toBe(true);

        const session = await client.callTool({
            name: "mobile_session_status",
            arguments: { deviceId: ownedDeviceId },
        });
        expect(session.isError).not.toBe(true);
        const sessionPayload = JSON.parse(((session.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            appium: { available: boolean; appium: string; xcuitestDriver: string; xcodebuild: string; xcrun: string; missing: string[] };
            session: unknown;
            automationName: string;
            lazy: boolean;
        };
        expect(sessionPayload.appium).toEqual({
            available: true,
            missing: [],
            appium: join(binDir, "appium"),
            xcuitestDriver: join(binDir, "appium-xcuitest-driver"),
            xcodebuild: join(binDir, "xcodebuild"),
            xcrun: join(binDir, "xcrun"),
        });
        expect(sessionPayload.session).toBeNull();
        expect(sessionPayload.automationName).toBe("XCUITest");
        expect(sessionPayload.lazy).toBe(true);

        const dumpUi = await client.callTool({
            name: "mobile_dump_ui",
            arguments: { deviceId: ownedDeviceId },
        });
        expect(dumpUi.isError).not.toBe(true);
        const dumpPayload = JSON.parse(((dumpUi.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            provider: string;
            source: string;
            sessionId: string;
            serverUrl: string;
        };
        expect(dumpPayload.provider).toBe("appium-xcuitest");
        expect(dumpPayload.source).toContain("XCUIElementTypeApplication");
        expect(dumpPayload.sessionId).toBe("IOS-SESSION-1");

        const statusAfterDump = await client.callTool({
            name: "mobile_session_status",
            arguments: { deviceId: ownedDeviceId },
        });
        const statusAfterDumpPayload = JSON.parse(((statusAfterDump.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            session: { sessionId: string; serverUrl: string };
        };
        expect(statusAfterDumpPayload.session.sessionId).toBe("IOS-SESSION-1");
        expect(statusAfterDumpPayload.session.serverUrl).toBe(dumpPayload.serverUrl);

        const reusedDump = await client.callTool({
            name: "mobile_dump_ui",
            arguments: { deviceId: ownedDeviceId },
        });
        expect(reusedDump.isError).not.toBe(true);
        expect(((reusedDump.content as Array<{ text?: string }>)[0].text ?? "")).toContain("IOS-SESSION-1");

        writeFileSync(join(homeDir, "stale-ios-session"), "1");
        const staleRecoveredDump = await client.callTool({
            name: "mobile_dump_ui",
            arguments: { deviceId: ownedDeviceId },
        });
        expect(staleRecoveredDump.isError).not.toBe(true);
        const staleRecoveredPayload = JSON.parse(((staleRecoveredDump.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            sessionId: string;
        };
        expect(staleRecoveredPayload.sessionId).toBe("IOS-SESSION-1");
        await new Promise((resolve) => setTimeout(resolve, 100));

        const iosAppiumActions = [
            ["mobile_tap", { deviceId: ownedDeviceId, x: 10, y: 20 }],
            ["mobile_double_tap", { deviceId: ownedDeviceId, x: 11, y: 21 }],
            ["mobile_long_press", { deviceId: ownedDeviceId, x: 12, y: 22, durationMs: 900 }],
            ["mobile_swipe", { deviceId: ownedDeviceId, x1: 10, y1: 20, x2: 30, y2: 40, durationMs: 250 }],
            ["mobile_drag", { deviceId: ownedDeviceId, x1: 15, y1: 25, x2: 35, y2: 45, durationMs: 800 }],
            ["mobile_type_text", { deviceId: ownedDeviceId, text: "hello ios" }],
            ["mobile_key", { deviceId: ownedDeviceId, key: "Return" }],
            ["mobile_home", { deviceId: ownedDeviceId }],
            ["mobile_lock", { deviceId: ownedDeviceId }],
            ["mobile_unlock", { deviceId: ownedDeviceId }],
            ["mobile_rotate_left", { deviceId: ownedDeviceId }],
            ["mobile_rotate_right", { deviceId: ownedDeviceId }],
            ["mobile_set_orientation", { deviceId: ownedDeviceId, orientation: "LANDSCAPE" }],
            ["mobile_wait_for_text", { deviceId: ownedDeviceId, text: "Test", timeoutMs: 1000, intervalMs: 50 }],
        ] as const;
        for (const [name, callArgs] of iosAppiumActions) {
            const action = await client.callTool({ name, arguments: callArgs });
            expect(action.isError, `${name}: ${(action.content as Array<{ text?: string }>)[0]?.text ?? ""}`).not.toBe(true);
        }

        const sourceFailMarker = join(homeDir, "stale-ios-session-source-fail");
        writeFileSync(sourceFailMarker, "1");
        const failedWaitForText = await client.callTool({
            name: "mobile_wait_for_text",
            arguments: { deviceId: ownedDeviceId, text: "Never", timeoutMs: 200, intervalMs: 50 },
        });
        expect(failedWaitForText.isError).toBe(true);
        expect((failedWaitForText.content as Array<{ text?: string }>)[0].text).toContain("Appium source request failed");
        rmSync(sourceFailMarker, { force: true });

        const missingIosKey = await client.callTool({
            name: "mobile_key",
            arguments: { deviceId: ownedDeviceId },
        });
        expect(missingIosKey.isError).toBe(true);
        expect((missingIosKey.content as Array<{ text?: string }>)[0].text).toContain("mobile_key requires key or keyCode");

        const invalidOrientation = await client.callTool({
            name: "mobile_set_orientation",
            arguments: { deviceId: ownedDeviceId, orientation: "SIDEWAYS" },
        });
        expect(invalidOrientation.isError).toBe(true);
        expect((invalidOrientation.content as Array<{ text?: string }>)[0].text).toContain("requires PORTRAIT or LANDSCAPE");

        const unsupportedBattery = await client.callTool({
            name: "mobile_set_battery",
            arguments: { deviceId: ownedDeviceId, level: 50 },
        });
        expect(unsupportedBattery.isError).toBe(true);
        expect((unsupportedBattery.content as Array<{ text?: string }>)[0].text).toContain("does not support mobile_set_battery through base simctl");

        const deleteWhileBooted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: ownedDeviceId, deleteSimulator: true },
        });
        expect(deleteWhileBooted.isError).toBe(true);

        const stop = await client.callTool({
            name: "device_stop",
            arguments: { deviceId: ownedDeviceId },
        });
        expect(stop.isError).not.toBe(true);
        const stoppedPayload = JSON.parse(((stop.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { recording: unknown; status: string };
        };
        expect(stoppedPayload.device.status).toBe("stopped");
        expect(stoppedPayload.device.recording).toBeNull();

        const statusAfterDeviceStop = await client.callTool({
            name: "device_record_video_status",
            arguments: { deviceId: ownedDeviceId },
        });
        expect(JSON.parse(((statusAfterDeviceStop.content as Array<{ text?: string }>)[0].text ?? "{}")).recording).toBeNull();

        const eraseReset = await client.callTool({
            name: "device_reset",
            arguments: { deviceId: ownedDeviceId, eraseSimulator: true },
        });
        expect(eraseReset.isError).not.toBe(true);
        const erasePayload = JSON.parse(((eraseReset.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            reset: { eraseSimulator: boolean };
            device: { status: string; bootReady: boolean };
        };
        expect(erasePayload.reset.eraseSimulator).toBe(true);
        expect(erasePayload.device.status).toBe("stopped");
        expect(erasePayload.device.bootReady).toBe(false);

        const deleted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: ownedDeviceId, deleteSimulator: true },
        });
        expect(deleted.isError).not.toBe(true);
        const deletedPayload = JSON.parse(((deleted.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            deleted: string;
            simulatorDeleted: boolean;
        };
        expect(deletedPayload).toEqual({ deleted: ownedDeviceId, simulatorDeleted: true });

        const log = readFileSync(logPath, "utf-8");
        expect(log).toContain(`xcrun simctl create ${simulatorName} com.apple.CoreSimulator.SimDeviceType.iPhone-15 com.apple.CoreSimulator.SimRuntime.iOS-17-0`);
        expect(log).toContain("xcrun simctl boot CREATED-IOS-UDID");
        expect(log).toContain("xcrun simctl bootstatus CREATED-IOS-UDID -b");
        expect(log).toContain("xcrun simctl openurl CREATED-IOS-UDID https://example.test/ios");
        expect(log).toContain("xcrun simctl install CREATED-IOS-UDID /tmp/Test.app");
        expect(log).toContain("xcrun simctl launch CREATED-IOS-UDID com.example.Test");
        expect(log).toContain("xcrun simctl install CREATED-IOS-UDID /tmp/Common.app");
        expect(log).toContain("xcrun simctl launch CREATED-IOS-UDID com.example.Common");
        expect(log).toContain("xcrun simctl privacy CREATED-IOS-UDID grant camera com.example.Test");
        expect(log).toContain("xcrun simctl privacy CREATED-IOS-UDID revoke camera com.example.Test");
        expect(log).toContain("xcrun simctl location CREATED-IOS-UDID set 37.7749,-122.4194");
        expect(log).toContain("xcrun simctl pbcopy CREATED-IOS-UDID");
        expect(log).toContain("xcrun simctl pbpaste CREATED-IOS-UDID");
        expect(log).toContain("xcrun simctl spawn CREATED-IOS-UDID pgrep -f com.example.Test");
        expect(log).toContain("xcrun simctl get_app_container CREATED-IOS-UDID com.example.Test data");
        expect(log).toContain("xcrun simctl erase CREATED-IOS-UDID");
        expect(log).toContain("xcrun simctl io CREATED-IOS-UDID screenshot ");
        expect(log).toContain("xcrun simctl io CREATED-IOS-UDID recordVideo /tmp/custom-ios-recording.mp4");
        expect(log).toContain("xcrun simctl io CREATED-IOS-UDID recordVideo /tmp/fail-immediate-ios-recording.mp4");
        expect(log).toContain("xcrun simctl io CREATED-IOS-UDID recordVideo /tmp/natural-exit-ios-recording.mp4");
        expect(log).toContain("xcrun simctl io CREATED-IOS-UDID recordVideo /tmp/stop-cleanup-ios-recording.mp4");
        expect(log).toContain("xcrun simctl delete CREATED-IOS-UDID");
        expect(log).toContain("appium server --port ");
        expect(log).toContain("appium-http POST /session");
        expect(log).toContain("appium-server-sigint ");
        expect(log).toContain("appium-command-body /session/IOS-SESSION-1/actions");
        expect(log).toContain('"gesture":"tap"');
        expect(log).toContain('"gesture":"doubleTap"');
        expect(log).toContain('"gesture":"longPress"');
        expect(log).toContain('"gesture":"swipe"');
        expect(log).toContain('"gesture":"drag"');
        expect(log).toContain("appium-command-body /session/IOS-SESSION-1/keys");
        expect(log).toContain('"text":"hello ios"');
        expect(log).toContain("mobile: pressButton");
        expect(log).toContain("mobile: lock");
        expect(log).toContain("mobile: unlock");
        expect(log).toContain("appium-command-body /session/IOS-SESSION-1/orientation");
        expect(log).toContain('"appium:automationName":"XCUITest"');
        expect(log).not.toContain("Android backend missing prerequisites");
    });

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
        expect(log).toContain("appium-server-sigint ");
        expect(log.split("appium-http POST /session").length - 1).toBeGreaterThanOrEqual(2);
        expect(log).not.toContain("xcrun simctl shutdown 00008110-001C195E0E91801E");
    });

    it("keeps metadata-only iOS definitions lazy and refuses non-owned simulator operations", { timeout: TIMEOUT }, async () => {
        const inventory = await client.callTool({
            name: "device_inventory",
            arguments: { backend: "ios-simulator" },
        });
        const ownerId = (JSON.parse(((inventory.content as Array<{ text?: string }>)[0].text ?? "{}")) as { ownerId: string }).ownerId;
        const metadataOnlyName = `ccc-${ownerId}-ios-metadata-only`;

        const metadataOnly = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "ios-simulator",
                name: "iOS Metadata Only",
                simulatorName: metadataOnlyName,
                deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-15",
                runtime: "com.apple.CoreSimulator.SimRuntime.iOS-17-0",
            },
        });
        expect(metadataOnly.isError).not.toBe(true);
        const metadataPayload = JSON.parse(((metadataOnly.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { provisioning: string; udid: string | null };
        };
        expect(metadataPayload.device.provisioning).toBe("definition-only");
        expect(metadataPayload.device.udid).toBeNull();

        const metadataDeleted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "ios-ios-metadata-only" },
        });
        expect(metadataDeleted.isError).not.toBe(true);

        const foreignCreate = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "ios-simulator",
                name: "Foreign iOS Create",
                simulatorName: "foreign-ios",
                deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-15",
                runtime: "com.apple.CoreSimulator.SimRuntime.iOS-17-0",
                createSimulator: true,
            },
        });
        expect(foreignCreate.isError).toBe(true);
        expect((foreignCreate.content as Array<{ text?: string }>)[0].text).toContain("Refusing to create non-owned iOS Simulator name");

        const foreignMetadata = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "ios-simulator",
                name: "Foreign iOS Metadata",
                simulatorName: "foreign-ios",
                udid: "FOREIGN-UDID",
            },
        });
        expect(foreignMetadata.isError).not.toBe(true);

        const start = await client.callTool({
            name: "device_start",
            arguments: { deviceId: "ios-foreign-ios-metadata", bootTimeoutMs: 1000 },
        });
        expect(start.isError).toBe(true);
        expect((start.content as Array<{ text?: string }>)[0].text).toContain("Refusing to start non-owned iOS Simulator name");

        writeFileSync(join(homeDir, "foreign-ios-upload.txt"), "foreign");
        const foreignUpload = await client.callTool({
            name: "device_upload",
            arguments: { deviceId: "ios-foreign-ios-metadata", localPath: join(homeDir, "foreign-ios-upload.txt"), remotePath: "Documents/foreign.txt", bundleId: "com.example.Test" },
        });
        expect(foreignUpload.isError).toBe(true);
        expect((foreignUpload.content as Array<{ text?: string }>)[0].text).toContain("Refusing iOS Simulator upload for non-owned simulator name");

        const foreignDownload = await client.callTool({
            name: "device_download",
            arguments: { deviceId: "ios-foreign-ios-metadata", remotePath: "Documents/foreign.txt", localPath: join(homeDir, "foreign-download.txt"), bundleId: "com.example.Test" },
        });
        expect(foreignDownload.isError).toBe(true);
        expect((foreignDownload.content as Array<{ text?: string }>)[0].text).toContain("Refusing iOS Simulator download for non-owned simulator name");

        const foreignAppReset = await client.callTool({
            name: "device_reset",
            arguments: { deviceId: "ios-foreign-ios-metadata", bundleId: "com.example.Test" },
        });
        expect(foreignAppReset.isError).toBe(true);
        expect((foreignAppReset.content as Array<{ text?: string }>)[0].text).toContain("Refusing iOS Simulator reset for non-owned simulator name");

        const eraseSimulator = await client.callTool({
            name: "device_reset",
            arguments: { deviceId: "ios-foreign-ios-metadata", eraseSimulator: true },
        });
        expect(eraseSimulator.isError).toBe(true);
        expect((eraseSimulator.content as Array<{ text?: string }>)[0].text).toContain("Refusing to erase non-owned iOS Simulator name");

        const deleteSimulator = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "ios-foreign-ios-metadata", deleteSimulator: true },
        });
        expect(deleteSimulator.isError).toBe(true);
        expect((deleteSimulator.content as Array<{ text?: string }>)[0].text).toContain("Refusing to delete non-owned iOS Simulator name");

        const foreignDeleted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "ios-foreign-ios-metadata" },
        });
        expect(foreignDeleted.isError).not.toBe(true);

        const log = readFileSync(logPath, "utf-8");
        expect(log).not.toContain(`xcrun simctl create ${metadataOnlyName}`);
        expect(log).not.toContain("xcrun simctl boot FOREIGN-UDID");
        expect(log).not.toContain("xcrun simctl get_app_container FOREIGN-UDID");
        expect(log).not.toContain("xcrun simctl erase FOREIGN-UDID");
        expect(log).not.toContain("xcrun simctl delete FOREIGN-UDID");
    });
});
