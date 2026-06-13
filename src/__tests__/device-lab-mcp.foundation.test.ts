import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    cleanupDeviceLabMcpTestContext,
    createDeviceLabMcpTestContext,
    TIMEOUT,
    type DeviceLabMcpTestContext,
} from "./helpers/device-lab-mcp-fixture.js";

describe("device-lab MCP foundation and definitions", () => {
    let context: DeviceLabMcpTestContext;
    let client: DeviceLabMcpTestContext["client"];

    beforeAll(async () => {
        context = await createDeviceLabMcpTestContext();
        client = context.client;
    }, TIMEOUT);

    afterAll(async () => {
        await cleanupDeviceLabMcpTestContext(context);
    }, TIMEOUT);

    it("lists foundation device-lab and current display tools", { timeout: TIMEOUT }, async () => {
        const result = await client.listTools();
        const names = result.tools.map((tool) => tool.name);

        expect(names).toContain("device_backends");
        expect(names).toContain("device_broker_status");
        expect(names).toContain("device_broker_shutdown");
        expect(names).toContain("device_broker_rpc");
        expect(names).toContain("device_broker_lease");
        expect(names).toContain("device_broker_attach");
        expect(names).toContain("device_broker_command");
        expect(names).toContain("device_list");
        expect(names).toContain("device_inventory");
        expect(names).toContain("device_wireless");
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
        expect(names).toContain("device_click");
        expect(names).toContain("device_double_click");
        expect(names).toContain("device_key");
        expect(names).toContain("device_type");
        expect(names).toContain("device_scroll");
        expect(names).toContain("device_cursor_position");
        expect(names).toContain("device_window_list");
        expect(names).toContain("device_accessibility_snapshot");
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
        const wirelessTool = result.tools.find((tool) => tool.name === "device_wireless");
        expect(wirelessTool?.inputSchema).toEqual(expect.objectContaining({
            required: ["backend"],
            properties: expect.objectContaining({
                backend: expect.objectContaining({ enum: ["android-device", "ios-device"] }),
                action: expect.objectContaining({ enum: ["status", "usb-tcpip", "pair", "connect"] }),
                pairingCode: expect.objectContaining({ type: "string" }),
                timeoutMs: expect.objectContaining({ maximum: 30000 }),
            }),
        }));
        const brokerTool = result.tools.find((tool) => tool.name === "device_broker_status");
        expect(brokerTool?.inputSchema).toEqual(expect.objectContaining({
            properties: expect.objectContaining({
                hostCandidates: expect.objectContaining({ maxItems: 8 }),
                timeoutMs: expect.objectContaining({ maximum: 2000 }),
                autolaunch: expect.objectContaining({ type: "boolean" }),
                launchTimeoutMs: expect.objectContaining({ maximum: 5000 }),
            }),
        }));
        const brokerShutdownTool = result.tools.find((tool) => tool.name === "device_broker_shutdown");
        expect(brokerShutdownTool?.inputSchema).toEqual(expect.objectContaining({
            properties: expect.objectContaining({ force: expect.objectContaining({ type: "boolean" }) }),
        }));
        const brokerRpcTool = result.tools.find((tool) => tool.name === "device_broker_rpc");
        expect(brokerRpcTool?.inputSchema).toEqual(expect.objectContaining({
            required: ["method"],
            properties: expect.objectContaining({
                method: expect.objectContaining({ enum: ["broker.status", "broker.inventory", "broker.echo"] }),
                hostCandidates: expect.objectContaining({ maxItems: 8 }),
                timeoutMs: expect.objectContaining({ maximum: 2000 }),
                autolaunch: expect.objectContaining({ type: "boolean" }),
            }),
        }));
        const brokerLeaseTool = result.tools.find((tool) => tool.name === "device_broker_lease");
        expect(brokerLeaseTool?.inputSchema).toEqual(expect.objectContaining({
            required: ["action", "backend"],
            properties: expect.objectContaining({
                action: expect.objectContaining({ enum: ["claim", "list", "release"] }),
                backend: expect.objectContaining({ enum: ["android-device", "ios-device"] }),
                hostCandidates: expect.objectContaining({ maxItems: 8 }),
                timeoutMs: expect.objectContaining({ maximum: 2000 }),
                autolaunch: expect.objectContaining({ type: "boolean" }),
            }),
        }));
        const brokerAttachTool = result.tools.find((tool) => tool.name === "device_broker_attach");
        expect(brokerAttachTool?.inputSchema).toEqual(expect.objectContaining({
            required: ["action", "backend"],
            properties: expect.objectContaining({
                action: expect.objectContaining({ enum: ["attach", "detach", "list"] }),
                backend: expect.objectContaining({ enum: ["android-device", "ios-device"] }),
                devicePort: expect.objectContaining({ type: "number" }),
                autolaunch: expect.objectContaining({ type: "boolean" }),
            }),
        }));
        const brokerCommandTool = result.tools.find((tool) => tool.name === "device_broker_command");
        expect(brokerCommandTool?.inputSchema).toEqual(expect.objectContaining({
            required: ["action", "backend", "command", "deviceId"],
            properties: expect.objectContaining({
                action: expect.objectContaining({ enum: ["plan", "invoke"] }),
                command: expect.objectContaining({ enum: ["device_status", "device_start", "device_stop", "device_delete"] }),
                hostCandidates: expect.objectContaining({ maxItems: 8 }),
                timeoutMs: expect.objectContaining({ maximum: 2000 }),
                autolaunch: expect.objectContaining({ type: "boolean" }),
            }),
        }));
        const lifecycleTool = result.tools.find((tool) => tool.name === "device_start");
        expect(lifecycleTool?.inputSchema).toEqual(expect.objectContaining({
            required: ["deviceId"],
            properties: expect.objectContaining({
                backend: expect.objectContaining({ enum: ["android-emulator", "android-device", "ios-simulator", "ios-device", "windows-sandbox", "macos-vm"] }),
                broker: expect.objectContaining({ type: "boolean" }),
                viaBroker: expect.objectContaining({ type: "boolean" }),
                autolaunch: expect.objectContaining({ type: "boolean" }),
                dryRun: expect.objectContaining({ type: "boolean" }),
            }),
        }));
        const accessibilityTool = result.tools.find((tool) => tool.name === "device_accessibility_snapshot");
        expect(accessibilityTool?.inputSchema).toEqual(expect.objectContaining({
            required: ["deviceId"],
            properties: expect.objectContaining({
                maxDepth: expect.objectContaining({ maximum: 8 }),
                maxNodes: expect.objectContaining({ maximum: 1000 }),
            }),
        }));
    });

    it("reports backends without starting heavyweight devices", { timeout: TIMEOUT }, async () => {
        const result = await client.callTool({ name: "device_backends", arguments: {} });
        expect(result.isError).not.toBe(true);

        const content = result.content as Array<{ type: string; text?: string }>;
        const payload = JSON.parse(content[0].text ?? "{}") as {
            ownerId?: string;
            broker?: { mode: string; lazy: boolean; transport: { environmentRequired: boolean }; implemented: string[]; deferred: string[] };
            backends?: Array<{ name: string; available: boolean; status?: string; capabilities?: string[] }>;
        };

        expect(payload.ownerId).toMatch(/^[a-f0-9]{16}$/);
        expect(payload.broker).toEqual(expect.objectContaining({
            mode: "direct-provider",
            lazy: true,
            transport: expect.objectContaining({ environmentRequired: false }),
            implemented: expect.arrayContaining(["lazy host broker autolaunch"]),
            deferred: expect.not.arrayContaining(["host broker daemon launcher"]),
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
        expect(payload.backends?.find((backend) => backend.name === "android-device")?.capabilities).toContain("device_wireless");
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
        expect(payload.backends?.find((backend) => backend.name === "ios-device")?.capabilities).toContain("device_wireless");
        const windowsBackend = payload.backends?.find((backend) => backend.name === "windows-sandbox");
        expect(windowsBackend?.status).toBe("missing-prerequisites");
        expect(windowsBackend?.capabilities).toContain("device_inventory");
        expect(windowsBackend?.capabilities).toEqual(expect.arrayContaining(["device_window_list", "device_accessibility_snapshot"]));
        const macosBackend = payload.backends?.find((backend) => backend.name === "macos-vm");
        expect(macosBackend?.status).toBe("missing-prerequisites");
        expect(macosBackend?.capabilities).toContain("device_inventory");
        expect(macosBackend?.capabilities).toEqual(expect.arrayContaining(["device_window_list", "device_accessibility_snapshot"]));
    });

    it("reports real-device wireless missing prerequisites without environment configuration", { timeout: TIMEOUT }, async () => {
        const android = await client.callTool({
            name: "device_wireless",
            arguments: { backend: "android-device", action: "status" },
        });
        expect(android.isError).toBe(true);
        expect(JSON.parse((android.content as Array<{ text?: string }>)[0].text ?? "{}")).toEqual(expect.objectContaining({
            ok: false,
            error: "android-wireless-missing-adb",
            missing: ["adb"],
        }));

        const ios = await client.callTool({
            name: "device_wireless",
            arguments: { backend: "ios-device", action: "status" },
        });
        expect(ios.isError).toBe(true);
        expect(JSON.parse((ios.content as Array<{ text?: string }>)[0].text ?? "{}")).toEqual(expect.objectContaining({
            ok: false,
            error: "ios-wireless-missing-xcrun",
            missing: ["xcrun"],
        }));
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
            probe: { requested: boolean; available: boolean; attempts: unknown[] };
            state: { root: string; ownerRoot: string; locksRoot: string; logsRoot: string };
            implemented: string[];
            deferred: string[];
        };

        expect(payload.ownerId).toMatch(/^[a-f0-9]{16}$/);
        expect(payload.mode).toBe("direct-provider");
        expect(payload.lazy).toBe(true);
        expect(payload.available).toBe(false);
        expect(payload.probe).toEqual(expect.objectContaining({ requested: false, available: false, attempts: [] }));
        expect(payload.transport).toEqual(expect.objectContaining({
            hostCandidates: expect.arrayContaining(["host.docker.internal", "172.17.0.1"]),
            defaultPort: 17373,
            zeroConfig: true,
            environmentRequired: false,
        }));
        expect(payload.state.ownerRoot).toContain(payload.ownerId);
        expect(payload.state.locksRoot).toContain(".ccc/devices/broker/locks");
        expect(payload.state).toEqual(expect.objectContaining({ runtimeFile: expect.stringContaining(".ccc/devices/broker/runtime.json") }));
        expect(payload.implemented).toContain("broker contract inspection");
        expect(payload.implemented).toContain("lazy host broker autolaunch");
        expect(payload.implemented).toContain("secret-backed broker owner token auth");
        expect(payload.deferred).not.toContain("host broker daemon launcher");
        expect(payload.deferred).not.toContain("strong broker authentication token handshake");
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

});
