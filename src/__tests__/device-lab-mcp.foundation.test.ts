import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync } from "fs";
import { join } from "path";
import {
    cleanupDeviceLabMcpTestContext,
    createDeviceLabMcpTestContext,
    TIMEOUT,
    type DeviceLabMcpTestContext,
} from "./helpers/device-lab-mcp-fixture.js";

const ROUTING_SCHEMA_KEYS = [
    "broker",
    "viaBroker",
    "implicitBroker",
    "autolaunch",
    "hostCandidates",
    "launchHost",
    "brokerPort",
    "rpcTimeoutMs",
    "launchTimeoutMs",
] as const;
const HIDDEN_LEGACY_TRANSPORT_KEYS = new Set<string>([
    ...ROUTING_SCHEMA_KEYS,
    "port",
    "timeoutMs",
]);

const BROKER_CAPABLE_DEVICE_TOOLS = [
    "device_create",
    "device_status",
    "device_start",
    "device_stop",
    "device_delete",
    "device_inventory",
    "device_record_video_status",
    "device_screenshot",
    "device_cursor_position",
    "device_window_list",
    "device_accessibility_snapshot",
    "device_record_video_start",
    "device_record_video_stop",
    "device_exec",
    "device_upload",
    "device_download",
    "device_reset",
    "device_install_app",
    "device_launch_app",
    "device_click",
    "device_double_click",
    "device_key",
    "device_type",
    "device_scroll",
    "device_snapshot_create",
    "device_snapshot_restore",
    "device_snapshot_delete",
    "device_attach",
    "device_detach",
] as const;

const DEVICE_ROUTE_PORT_COLLISION_TOOLS = new Set(["device_create", "device_attach"]);
const DEVICE_BACKEND_ENUM = ["android-emulator", "android-device", "ios-simulator", "ios-device", "windows-sandbox", "windows-vm", "macos-vm", "linux-vm"] as const;
const DEVICE_WITH_DISPLAY_BACKEND_ENUM = ["x11-current-display", "android-emulator", "android-device", "ios-simulator", "ios-device", "windows-sandbox", "macos-vm"] as const;
const DEVICE_STATUS_BACKEND_ENUM = ["x11-current-display", "android-emulator", "android-device", "ios-simulator", "ios-device", "windows-sandbox", "windows-vm", "macos-vm", "linux-vm"] as const;
const DEVICE_CREATE_BACKEND_ENUM = ["android-emulator", "ios-simulator", "windows-sandbox", "windows-vm", "macos-vm", "linux-vm"] as const;
const DEVICE_EXEC_BACKEND_ENUM = ["android-emulator", "android-device", "ios-simulator", "windows-sandbox", "windows-vm", "macos-vm", "linux-vm"] as const;
const MOBILE_BACKEND_ENUM = ["android-emulator", "android-device", "ios-simulator", "ios-device"] as const;
const ANDROID_BACKEND_ENUM = ["android-emulator", "android-device"] as const;
const ANDROID_EMULATOR_BACKEND_ENUM = ["android-emulator"] as const;
const PHYSICAL_BACKEND_ENUM = ["android-device", "ios-device"] as const;
const DESKTOP_BACKEND_ENUM = ["windows-sandbox", "macos-vm"] as const;
const DISPLAY_DESKTOP_BACKEND_ENUM = ["x11-current-display", "windows-sandbox", "macos-vm"] as const;
const SNAPSHOT_BACKEND_ENUM = ["windows-vm", "macos-vm", "linux-vm"] as const;
const RECORDING_BACKEND_ENUM = ["android-emulator", "android-device", "ios-simulator", "windows-sandbox", "macos-vm"] as const;
const FILE_TRANSFER_BACKEND_ENUM = ["android-emulator", "android-device", "ios-simulator", "windows-sandbox", "windows-vm", "macos-vm", "linux-vm"] as const;
const RESET_BACKEND_ENUM = ["android-emulator", "android-device", "ios-simulator"] as const;
const EMULATOR_SIMULATOR_BACKEND_ENUM = ["android-emulator", "ios-simulator"] as const;
const MOBILE_WITHOUT_IOS_DEVICE_BACKEND_ENUM = ["android-emulator", "android-device", "ios-simulator"] as const;
const APP_BACKEND_ENUM = ["android-emulator", "android-device", "ios-simulator", "ios-device"] as const;

const DEVICE_TOOL_BACKEND_ENUMS: Record<string, readonly string[]> = {
    device_create: DEVICE_CREATE_BACKEND_ENUM,
    device_delete: DEVICE_CREATE_BACKEND_ENUM,
    device_attach: PHYSICAL_BACKEND_ENUM,
    device_detach: PHYSICAL_BACKEND_ENUM,
    device_status: DEVICE_STATUS_BACKEND_ENUM,
    device_screenshot: DEVICE_WITH_DISPLAY_BACKEND_ENUM,
    device_exec: DEVICE_EXEC_BACKEND_ENUM,
    device_click: DISPLAY_DESKTOP_BACKEND_ENUM,
    device_double_click: DISPLAY_DESKTOP_BACKEND_ENUM,
    device_key: DISPLAY_DESKTOP_BACKEND_ENUM,
    device_type: DISPLAY_DESKTOP_BACKEND_ENUM,
    device_scroll: DISPLAY_DESKTOP_BACKEND_ENUM,
    device_cursor_position: DISPLAY_DESKTOP_BACKEND_ENUM,
    device_window_list: DESKTOP_BACKEND_ENUM,
    device_accessibility_snapshot: DESKTOP_BACKEND_ENUM,
    device_snapshot_create: SNAPSHOT_BACKEND_ENUM,
    device_snapshot_restore: SNAPSHOT_BACKEND_ENUM,
    device_snapshot_delete: SNAPSHOT_BACKEND_ENUM,
    device_record_video_start: RECORDING_BACKEND_ENUM,
    device_record_video_stop: RECORDING_BACKEND_ENUM,
    device_record_video_status: RECORDING_BACKEND_ENUM,
    device_upload: FILE_TRANSFER_BACKEND_ENUM,
    device_download: FILE_TRANSFER_BACKEND_ENUM,
    device_reset: RESET_BACKEND_ENUM,
    device_install_app: APP_BACKEND_ENUM,
    device_launch_app: APP_BACKEND_ENUM,
};

function expectedDeviceToolBackends(name: string) {
    return DEVICE_TOOL_BACKEND_ENUMS[name] || DEVICE_BACKEND_ENUM;
}

const MOBILE_TOOL_BACKEND_ENUMS: Record<string, readonly string[]> = {
    mobile_back: ANDROID_BACKEND_ENUM,
    mobile_forward: ANDROID_BACKEND_ENUM,
    mobile_recents: ANDROID_BACKEND_ENUM,
    mobile_power: ANDROID_BACKEND_ENUM,
    mobile_open_url: MOBILE_WITHOUT_IOS_DEVICE_BACKEND_ENUM,
    mobile_uninstall_app: MOBILE_WITHOUT_IOS_DEVICE_BACKEND_ENUM,
    mobile_clear_app_data: RESET_BACKEND_ENUM,
    mobile_grant_permission: MOBILE_WITHOUT_IOS_DEVICE_BACKEND_ENUM,
    mobile_revoke_permission: MOBILE_WITHOUT_IOS_DEVICE_BACKEND_ENUM,
    mobile_set_location: EMULATOR_SIMULATOR_BACKEND_ENUM,
    mobile_set_battery: ANDROID_EMULATOR_BACKEND_ENUM,
    mobile_set_network: ANDROID_EMULATOR_BACKEND_ENUM,
    mobile_toggle_airplane_mode: ANDROID_EMULATOR_BACKEND_ENUM,
    mobile_set_clipboard: MOBILE_WITHOUT_IOS_DEVICE_BACKEND_ENUM,
    mobile_get_clipboard: MOBILE_WITHOUT_IOS_DEVICE_BACKEND_ENUM,
};

function expectedMobileToolBackends(name: string) {
    return MOBILE_TOOL_BACKEND_ENUMS[name] || MOBILE_BACKEND_ENUM;
}

const BROKER_CAPABLE_MOBILE_TOOLS = [
    "mobile_session_status",
    "mobile_dump_ui",
    "mobile_tap",
    "mobile_double_tap",
    "mobile_long_press",
    "mobile_swipe",
    "mobile_drag",
    "mobile_type_text",
    "mobile_key",
    "mobile_home",
    "mobile_back",
    "mobile_forward",
    "mobile_recents",
    "mobile_power",
    "mobile_lock",
    "mobile_unlock",
    "mobile_rotate_left",
    "mobile_rotate_right",
    "mobile_set_orientation",
    "mobile_open_url",
    "mobile_install_app",
    "mobile_launch_app",
    "mobile_uninstall_app",
    "mobile_stop_app",
    "mobile_clear_app_data",
    "mobile_grant_permission",
    "mobile_revoke_permission",
    "mobile_set_location",
    "mobile_set_battery",
    "mobile_set_network",
    "mobile_toggle_airplane_mode",
    "mobile_set_clipboard",
    "mobile_get_clipboard",
    "mobile_wait_for_text",
    "mobile_wait_for_app",
    "mobile_screenshot",
] as const;

function toolProperties(tool: { inputSchema?: unknown } | undefined) {
    return ((tool?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties || {}) as Record<string, unknown>;
}

function expectNoRoutingProperties(properties: Record<string, unknown>, extraKeys: string[] = []) {
    for (const key of [...ROUTING_SCHEMA_KEYS, ...extraKeys]) expect(properties).not.toHaveProperty(key);
}

function expectRoutingProperties(properties: Record<string, unknown>, extra: { port?: boolean; mobile?: boolean } = {}) {
    expectNoRoutingProperties(properties);
    void extra.port;
    if (extra.mobile === true) {
        expect(properties).toEqual(expect.objectContaining({
            appiumPort: expect.objectContaining({ maximum: 65535 }),
            automationName: expect.objectContaining({ type: "string" }),
            physical: expect.objectContaining({ type: "boolean" }),
            serverPort: expect.objectContaining({ maximum: 65535 }),
        }));
    }
}

function expectBackendProperty(properties: Record<string, unknown>, expectedEnum: readonly string[]) {
    expect(properties).toEqual(expect.objectContaining({
        backend: expect.objectContaining({ enum: [...expectedEnum] }),
    }));
}

function expectAnyOfRequired(tool: { inputSchema?: unknown } | undefined, expected: string[][]) {
    const anyOf = ((tool?.inputSchema as { anyOf?: unknown[] } | undefined)?.anyOf || []) as Array<{ required?: unknown[] }>;
    expect(anyOf.map((item) => (item.required || []).map(String))).toEqual(expected);
}

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
        const requiredWithoutProperties = result.tools.flatMap((tool) => {
            const schema = tool.inputSchema as { required?: unknown; properties?: Record<string, unknown> } | undefined;
            const required = Array.isArray(schema?.required) ? schema.required.map(String) : [];
            const properties = schema?.properties || {};
            return required.filter((key) => !(key in properties)).map((key) => ({ name: tool.name, missingProperty: key }));
        });
        const advertisedTransportKeys = result.tools.flatMap((tool) => {
            const properties = toolProperties(tool);
            return [...ROUTING_SCHEMA_KEYS].filter((key) => key in properties).map((key) => ({ name: tool.name, key }));
        });

        expect(requiredWithoutProperties).toEqual([]);
        expect(advertisedTransportKeys).toEqual([]);

        expect(names).toContain("device_backends");
        expect(names).toContain("device_broker_status");
        expect(names).not.toContain("device_broker_shutdown");
        expect(names).not.toContain("device_broker_service");
        expect(names).not.toContain("device_broker_rpc");
        expect(names).not.toContain("device_broker_lease");
        expect(names).not.toContain("device_broker_attach");
        expect(names).not.toContain("device_broker_apple");
        expect(names).not.toContain("device_broker_command");
        expect(names).not.toContain("device_broker_appium");
        expect(names).toContain("device_list");
        expect(names).toContain("device_inventory");
        expect(names).toContain("device_wireless");
        expect(names).toContain("display_current");
        expect(names).toContain("display_screenshot");
        expect(names).toContain("display_click");
        expect(names).toContain("display_double_click");
        expect(names).toContain("display_key");
        expect(names).toContain("display_type");
        expect(names).toContain("display_scroll");
        expect(names).toContain("display_cursor_position");
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
        expect(names).toContain("device_base_image_create");
        expect(names).toContain("device_base_image_clone");
        expect(names).not.toContain("device_image_create");
        expect(names).not.toContain("device_image_clone");
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
        expect(names).toContain("device_run_flow");
        const backendsTool = result.tools.find((tool) => tool.name === "device_backends");
        expectRoutingProperties(toolProperties(backendsTool));
        const deviceRunFlowTool = result.tools.find((tool) => tool.name === "device_run_flow");
        expect(deviceRunFlowTool?.inputSchema).toEqual(expect.objectContaining({
            required: ["steps"],
            properties: expect.objectContaining({
                stopOnError: expect.objectContaining({ type: "boolean" }),
                steps: expect.objectContaining({ type: "array", maxItems: 50 }),
            }),
        }));
        const stepSchema = ((toolProperties(deviceRunFlowTool).steps as { items?: unknown }).items || {}) as { anyOf?: unknown[]; properties?: Record<string, unknown> };
        expect(stepSchema).toEqual(expect.objectContaining({
            anyOf: [{ required: ["tool"] }, { required: ["name"] }],
            properties: expect.objectContaining({
                arguments: expect.objectContaining({ type: "object" }),
                label: expect.objectContaining({ type: "string" }),
                name: expect.objectContaining({ type: "string" }),
                tool: expect.objectContaining({ type: "string" }),
            }),
        }));
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
        const brokerProperties = toolProperties(brokerTool);
        expect(brokerProperties).toEqual(expect.objectContaining({
            probe: expect.objectContaining({ type: "boolean" }),
        }));
        expect(brokerProperties).not.toHaveProperty("shutdown");
        expectRoutingProperties(brokerProperties);
        for (const name of BROKER_CAPABLE_DEVICE_TOOLS) {
            const tool = result.tools.find((candidate) => candidate.name === name);
            expect(tool, `${name} should be advertised`).toBeTruthy();
            expectRoutingProperties(toolProperties(tool), { port: !DEVICE_ROUTE_PORT_COLLISION_TOOLS.has(name) });
            expectBackendProperty(toolProperties(tool), expectedDeviceToolBackends(name));
        }
        for (const name of BROKER_CAPABLE_MOBILE_TOOLS) {
            const tool = result.tools.find((candidate) => candidate.name === name);
            expect(tool, `${name} should be advertised`).toBeTruthy();
            expectRoutingProperties(toolProperties(tool), { mobile: true });
            expectBackendProperty(toolProperties(tool), expectedMobileToolBackends(name));
        }
        const mobileDumpTool = result.tools.find((tool) => tool.name === "mobile_dump_ui");
        const mobileDumpProperties = toolProperties(mobileDumpTool);
        expect(mobileDumpTool?.inputSchema).toEqual(expect.objectContaining({ required: ["deviceId"] }));
        expect(mobileDumpProperties).toEqual(expect.objectContaining({
            deviceId: expect.objectContaining({ type: "string" }),
        }));
        expectRoutingProperties(mobileDumpProperties, { mobile: true });
        const mobileTapTool = result.tools.find((tool) => tool.name === "mobile_tap");
        const mobileTapProperties = toolProperties(mobileTapTool);
        expect(mobileTapTool?.inputSchema).toEqual(expect.objectContaining({ required: ["deviceId", "x", "y"] }));
        expect(mobileTapProperties).toEqual(expect.objectContaining({
            deviceId: expect.objectContaining({ type: "string" }),
            x: expect.objectContaining({ type: "number" }),
            y: expect.objectContaining({ type: "number" }),
        }));
        expectRoutingProperties(mobileTapProperties, { mobile: true });
        for (const name of ["mobile_forward", "mobile_recents", "mobile_power", "mobile_rotate_left", "mobile_rotate_right"]) {
            const mobileControlTool = result.tools.find((tool) => tool.name === name);
            const mobileControlProperties = toolProperties(mobileControlTool);
            expect(mobileControlTool?.inputSchema).toEqual(expect.objectContaining({ required: ["deviceId"] }));
            expect(mobileControlProperties).toEqual(expect.objectContaining({
                deviceId: expect.objectContaining({ type: "string" }),
            }));
            expectRoutingProperties(mobileControlProperties, { mobile: true });
        }
        for (const name of ["mobile_screenshot", "mobile_open_url", "mobile_install_app", "mobile_launch_app", "mobile_uninstall_app", "mobile_stop_app", "mobile_clear_app_data", "mobile_set_location", "mobile_set_clipboard", "mobile_get_clipboard", "mobile_wait_for_app"]) {
            const mobileAppTool = result.tools.find((tool) => tool.name === name);
            const mobileAppProperties = toolProperties(mobileAppTool);
            expect(mobileAppTool?.inputSchema).toEqual(expect.objectContaining({ required: expect.arrayContaining(["deviceId"]) }));
            expect(mobileAppProperties).toEqual(expect.objectContaining({
                deviceId: expect.objectContaining({ type: "string" }),
            }));
            expectRoutingProperties(mobileAppProperties, { mobile: true });
        }
        for (const name of ["mobile_set_network", "mobile_toggle_airplane_mode"]) {
            const mobileNetworkTool = result.tools.find((tool) => tool.name === name);
            const mobileNetworkProperties = toolProperties(mobileNetworkTool);
            expect(mobileNetworkTool?.inputSchema).toEqual(expect.objectContaining({ required: expect.arrayContaining(["deviceId"]) }));
            expect(mobileNetworkProperties).toEqual(expect.objectContaining({
                confirmDestructive: expect.objectContaining({ type: "boolean" }),
                deviceId: expect.objectContaining({ type: "string" }),
            }));
            expectRoutingProperties(mobileNetworkProperties, { mobile: true });
        }
        for (const name of ["mobile_grant_permission", "mobile_revoke_permission", "mobile_set_battery"]) {
            const brokerBackedMobileTool = result.tools.find((tool) => tool.name === name);
            const brokerBackedMobileProperties = toolProperties(brokerBackedMobileTool);
            expect(brokerBackedMobileTool?.inputSchema).toEqual(expect.objectContaining({ required: expect.arrayContaining(["deviceId"]) }));
            expectRoutingProperties(brokerBackedMobileProperties, { mobile: true });
        }
        const waitForTextTool = result.tools.find((tool) => tool.name === "mobile_wait_for_text");
        const waitForTextProperties = toolProperties(waitForTextTool);
        expect(waitForTextTool?.inputSchema).toEqual(expect.objectContaining({ required: ["deviceId", "text"] }));
        expect(waitForTextProperties).toEqual(expect.objectContaining({
            deviceId: expect.objectContaining({ type: "string" }),
            text: expect.objectContaining({ type: "string" }),
            timeoutMs: expect.objectContaining({ type: "number" }),
            intervalMs: expect.objectContaining({ type: "number" }),
        }));
        expectRoutingProperties(waitForTextProperties, { mobile: true });
        const lifecycleTool = result.tools.find((tool) => tool.name === "device_start");
        const lifecycleProperties = toolProperties(lifecycleTool);
        expect(lifecycleTool?.inputSchema).toEqual(expect.objectContaining({ required: ["deviceId"] }));
        expect(lifecycleProperties).toEqual(expect.objectContaining({
            deviceId: expect.objectContaining({ type: "string" }),
            minimized: expect.objectContaining({ type: "boolean" }),
        }));
        expectBackendProperty(lifecycleProperties, DEVICE_BACKEND_ENUM);
        expectRoutingProperties(lifecycleProperties);
        const createTool = result.tools.find((tool) => tool.name === "device_create");
        const createProperties = toolProperties(createTool);
        expect(createTool?.inputSchema).toEqual(expect.objectContaining({ required: ["backend", "name"] }));
        expect(createProperties).toEqual(expect.objectContaining({
            name: expect.objectContaining({ type: "string" }),
            provider: expect.objectContaining({ enum: ["auto", "hyper-v", "tart", "vz", "utmctl", "container-qemu"] }),
            image: expect.objectContaining({ type: "string" }),
            sshHost: expect.objectContaining({ type: "string" }),
            sshUser: expect.objectContaining({ type: "string" }),
            sshPassword: expect.objectContaining({ type: "string" }),
            simulatorName: expect.objectContaining({ type: "string" }),
            deviceType: expect.objectContaining({ type: "string" }),
            avdName: expect.objectContaining({ type: "string" }),
            port: expect.objectContaining({ type: "number" }),
            options: expect.objectContaining({ type: "object" }),
        }));
        expectBackendProperty(createProperties, DEVICE_CREATE_BACKEND_ENUM);
        expectRoutingProperties(createProperties, { port: false });
        const attachTool = result.tools.find((tool) => tool.name === "device_attach");
        const attachProperties = toolProperties(attachTool);
        expect(attachTool?.inputSchema).toEqual(expect.objectContaining({ required: ["backend"] }));
        expect(attachProperties).toEqual(expect.objectContaining({
            port: expect.objectContaining({ type: "number" }),
        }));
        expectBackendProperty(attachProperties, PHYSICAL_BACKEND_ENUM);
        expectRoutingProperties(attachProperties, { port: false });
        for (const name of ["device_detach", "device_delete", "device_stop", "device_status"]) {
            const routedLifecycleTool = result.tools.find((tool) => tool.name === name);
            const routedLifecycleProperties = toolProperties(routedLifecycleTool);
            expect(routedLifecycleTool?.inputSchema).toEqual(expect.objectContaining({ required: expect.arrayContaining(["deviceId"]) }));
            expectBackendProperty(routedLifecycleProperties, expectedDeviceToolBackends(name));
            expectRoutingProperties(routedLifecycleProperties);
        }
        const inventoryTool = result.tools.find((tool) => tool.name === "device_inventory");
        const inventoryProperties = toolProperties(inventoryTool);
        expectBackendProperty(inventoryProperties, DEVICE_BACKEND_ENUM);
        expectRoutingProperties(inventoryProperties);
        const recordingStatusTool = result.tools.find((tool) => tool.name === "device_record_video_status");
        const recordingStatusProperties = toolProperties(recordingStatusTool);
        expect(recordingStatusTool?.inputSchema).toEqual(expect.objectContaining({ required: ["deviceId"] }));
        expect(recordingStatusProperties).toEqual(expect.objectContaining({
            deviceId: expect.objectContaining({ type: "string" }),
        }));
        expectRoutingProperties(recordingStatusProperties);
        expectAnyOfRequired(result.tools.find((tool) => tool.name === "device_snapshot_restore"), [["snapshotName"], ["snapshotId"]]);
        expectAnyOfRequired(result.tools.find((tool) => tool.name === "device_snapshot_delete"), [["snapshotName"], ["snapshotId"]]);
        expectAnyOfRequired(result.tools.find((tool) => tool.name === "device_reset"), [["packageName"], ["bundleId"], ["eraseSimulator"]]);
        expectAnyOfRequired(result.tools.find((tool) => tool.name === "device_launch_app"), [["packageName"], ["bundleId"], ["component"]]);
        expectAnyOfRequired(result.tools.find((tool) => tool.name === "mobile_launch_app"), [["packageName"], ["bundleId"], ["component"]]);
        expectAnyOfRequired(result.tools.find((tool) => tool.name === "mobile_uninstall_app"), [["packageName"], ["bundleId"]]);
        expectAnyOfRequired(result.tools.find((tool) => tool.name === "mobile_stop_app"), [["packageName"], ["bundleId"]]);
        expectAnyOfRequired(result.tools.find((tool) => tool.name === "mobile_clear_app_data"), [["packageName"], ["bundleId"]]);
        expectAnyOfRequired(result.tools.find((tool) => tool.name === "mobile_grant_permission"), [["packageName", "permission"], ["bundleId", "service"]]);
        expectAnyOfRequired(result.tools.find((tool) => tool.name === "mobile_revoke_permission"), [["packageName", "permission"], ["bundleId", "service"]]);
        expectAnyOfRequired(result.tools.find((tool) => tool.name === "mobile_set_battery"), [["level"], ["status"], ["charging"]]);
        expectAnyOfRequired(result.tools.find((tool) => tool.name === "mobile_set_network"), [["wifi"], ["data"]]);
        expectAnyOfRequired(result.tools.find((tool) => tool.name === "mobile_wait_for_app"), [["packageName"], ["bundleId"]]);
        const accessibilityTool = result.tools.find((tool) => tool.name === "device_accessibility_snapshot");
        const accessibilityProperties = toolProperties(accessibilityTool);
        expect(accessibilityTool?.inputSchema).toEqual(expect.objectContaining({ required: ["deviceId"] }));
        expect(accessibilityProperties).toEqual(expect.objectContaining({
            deviceId: expect.objectContaining({ type: "string" }),
            maxDepth: expect.objectContaining({ maximum: 8 }),
            maxNodes: expect.objectContaining({ maximum: 1000 }),
        }));
        expectRoutingProperties(accessibilityProperties);
        const desktopExecTool = result.tools.find((tool) => tool.name === "device_exec");
        const desktopExecProperties = toolProperties(desktopExecTool);
        expect(desktopExecTool?.inputSchema).toEqual(expect.objectContaining({ required: ["deviceId", "command"] }));
        expect(desktopExecProperties).toEqual(expect.objectContaining({
            deviceId: expect.objectContaining({ type: "string" }),
            helperTimeoutMs: expect.objectContaining({ type: "number" }),
        }));
        expectRoutingProperties(desktopExecProperties);
        const uploadTool = result.tools.find((tool) => tool.name === "device_upload");
        const uploadProperties = toolProperties(uploadTool);
        expect(uploadProperties).toEqual(expect.objectContaining({
            helperTimeoutMs: expect.objectContaining({ type: "number" }),
        }));
        expectRoutingProperties(uploadProperties);
        const downloadTool = result.tools.find((tool) => tool.name === "device_download");
        const downloadProperties = toolProperties(downloadTool);
        expect(downloadProperties).toEqual(expect.objectContaining({
            helperTimeoutMs: expect.objectContaining({ type: "number" }),
        }));
        expectRoutingProperties(downloadProperties);
        const recordStopTool = result.tools.find((tool) => tool.name === "device_record_video_stop");
        const recordStopProperties = toolProperties(recordStopTool);
        expect(recordStopProperties).toEqual(expect.objectContaining({
            helperTimeoutMs: expect.objectContaining({ type: "number" }),
        }));
        expectRoutingProperties(recordStopProperties);
        const scrollTool = result.tools.find((tool) => tool.name === "device_scroll");
        expect(scrollTool?.inputSchema).toEqual(expect.objectContaining({
            required: ["deviceId", "direction"],
            properties: expect.objectContaining({
                x: expect.objectContaining({ type: "number" }),
                y: expect.objectContaining({ type: "number" }),
                direction: expect.objectContaining({ enum: ["up", "down", "left", "right"] }),
            }),
        }));
    });

    it("rejects unsafe device ids before direct, broker, or flow routing", { timeout: TIMEOUT }, async () => {
        for (const request of [
            { name: "device_status", arguments: { deviceId: "../../outside" } },
            { name: "device_create", arguments: { backend: "ios-simulator", deviceId: "..\\outside", name: "Unsafe" } },
        ]) {
            const result = await client.callTool(request);
            expect(result.isError).toBe(true);
            expect((result.content as Array<{ text?: string }>)[0].text).toContain("device-id-invalid");
            expect((result.content as Array<{ text?: string }>)[0].text).not.toContain("Unexpected error");
        }

        const flow = await client.callTool({
            name: "device_run_flow",
            arguments: { steps: [{ tool: "device_status", arguments: { deviceId: "/tmp/outside" } }] },
        });
        expect(flow.isError).not.toBe(true);
        expect(JSON.parse((flow.content as Array<{ text?: string }>)[0].text ?? "{}")).toEqual(expect.objectContaining({
            ok: false,
            results: [expect.objectContaining({
                isError: true,
                content: [expect.objectContaining({
                    type: "json",
                    value: expect.objectContaining({ error: "device-id-invalid" }),
                })],
            })],
        }));
    });

    it("runs target-neutral display flow steps and rejects lifecycle steps", { timeout: TIMEOUT }, async () => {
        const displayStatus = await client.callTool({
            name: "device_status",
            arguments: { deviceId: "x11-current-display" },
        });
        expect(displayStatus.isError).not.toBe(true);
        const displayStatusPayload = JSON.parse(((displayStatus.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            id?: string;
            kind?: string;
            backend?: string;
            capabilities?: string[];
        };
        expect(displayStatusPayload).toEqual(expect.objectContaining({
            id: "x11-current-display",
            kind: "display",
            backend: "x11",
        }));
        expect(displayStatusPayload.capabilities).toEqual(expect.arrayContaining([
            "device_status",
            "device_screenshot",
            "device_click",
            "device_cursor_position",
        ]));

        const flow = await client.callTool({
            name: "device_run_flow",
            arguments: {
                steps: [
                    { label: "current display", tool: "display_current", arguments: {} },
                    { label: "inventory", tool: "device_inventory", arguments: { backend: "windows-sandbox", implicitBroker: false } },
                ],
            },
        });
        expect(flow.isError).not.toBe(true);
        const payload = JSON.parse(((flow.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ok: boolean;
            results: Array<{ label: string; isError: boolean; content: Array<{ type: string; value?: { id?: string; backend?: string } }> }>;
        };
        expect(payload.ok).toBe(true);
        expect(payload.results.map((result) => result.label)).toEqual(["current display", "inventory"]);
        expect(payload.results[0].content[0].value).toEqual(expect.objectContaining({
            id: "x11-current-display",
            backend: "x11",
        }));
        expect(payload.results[1].content[0].value).toEqual(expect.objectContaining({ backend: "windows-sandbox" }));

        const stopped = await client.callTool({
            name: "device_run_flow",
            arguments: {
                steps: [
                    { label: "start", tool: "device_start", arguments: { deviceId: "win-flow" } },
                    { label: "display", tool: "display_current", arguments: {} },
                ],
            },
        });
        expect(stopped.isError).not.toBe(true);
        const stoppedPayload = JSON.parse(((stopped.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ok: boolean;
            stoppedAt: number;
            results: Array<{ label: string; tool?: string; isError: boolean; error?: string }>;
        };
        expect(stoppedPayload).toEqual(expect.objectContaining({ ok: false, stoppedAt: 0 }));
        expect(stoppedPayload.results).toHaveLength(1);
        expect(stoppedPayload.results[0]).toEqual(expect.objectContaining({
            label: "start",
            tool: "device_start",
            isError: true,
            error: "device_run_flow does not allow step tool: device_start",
        }));

        const continued = await client.callTool({
            name: "device_run_flow",
            arguments: {
                stopOnError: false,
                steps: [
                    { label: "upload", tool: "device_upload", arguments: { deviceId: "win-flow", localPath: "/tmp/a", remotePath: "C:\\a" } },
                    { label: "display", name: "display_current", arguments: {} },
                ],
            },
        });
        expect(continued.isError).not.toBe(true);
        const continuedPayload = JSON.parse(((continued.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ok: boolean;
            results: Array<{ label: string; isError: boolean; error?: string; content?: Array<{ value?: { id?: string } }> }>;
        };
        expect(continuedPayload.ok).toBe(false);
        expect(continuedPayload.results).toHaveLength(2);
        expect(continuedPayload.results[0]).toEqual(expect.objectContaining({
            label: "upload",
            isError: true,
            error: "device_run_flow does not allow step tool: device_upload",
        }));
        expect(continuedPayload.results[1].content?.[0].value).toEqual(expect.objectContaining({ id: "x11-current-display" }));

        const recordingStatus = await client.callTool({
            name: "device_run_flow",
            arguments: {
                steps: [
                    { label: "recording", tool: "device_record_video_status", arguments: { backend: "windows-sandbox", deviceId: "win-flow", implicitBroker: false } },
                    { label: "display", tool: "display_current", arguments: {} },
                ],
            },
        });
        expect(recordingStatus.isError).not.toBe(true);
        const recordingStatusPayload = JSON.parse(((recordingStatus.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ok: boolean;
            stoppedAt: number;
            results: Array<{ label: string; isError: boolean; error?: string; content?: Array<{ type?: string; value?: { ok?: boolean; error?: string }; text?: string }> }>;
        };
        expect(recordingStatusPayload).toEqual(expect.objectContaining({ ok: false, stoppedAt: 0 }));
        expect(recordingStatusPayload.results).toHaveLength(1);
        expect(recordingStatusPayload.results[0]).toEqual(expect.objectContaining({
            label: "recording",
            isError: true,
        }));
        expect(recordingStatusPayload.results[0].error).toBeUndefined();
        expect(recordingStatusPayload.results[0].content?.[0]).toEqual(expect.objectContaining({ type: expect.any(String) }));

        const clipboardFlow = await client.callTool({
            name: "device_run_flow",
            arguments: {
                stopOnError: false,
                steps: [
                    { label: "set clipboard", tool: "mobile_set_clipboard", arguments: { backend: "android-emulator", deviceId: "android-flow", text: "flow-clipboard", implicitBroker: false } },
                    { label: "get clipboard", tool: "mobile_get_clipboard", arguments: { backend: "android-emulator", deviceId: "android-flow", implicitBroker: false } },
                ],
            },
        });
        expect(clipboardFlow.isError).not.toBe(true);
        const clipboardFlowPayload = JSON.parse(((clipboardFlow.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            results: Array<{ label: string; error?: string }>;
        };
        expect(clipboardFlowPayload.results).toHaveLength(2);
        expect(clipboardFlowPayload.results.filter((result) => result.error?.includes("device_run_flow does not allow step tool"))).toEqual([]);

        const semanticFailure = await client.callTool({
            name: "device_run_flow",
            arguments: {
                steps: [
                    { label: "broker status", tool: "device_status", arguments: { deviceId: "unknown-flow-device", broker: true } },
                    { label: "display", tool: "display_current", arguments: {} },
                ],
            },
        });
        expect(semanticFailure.isError).not.toBe(true);
        const semanticFailurePayload = JSON.parse(((semanticFailure.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ok: boolean;
            stoppedAt: number;
            results: Array<{ label: string; isError: boolean; content: Array<{ value?: { ok?: boolean } }> }>;
        };
        expect(semanticFailurePayload).toEqual(expect.objectContaining({ ok: false, stoppedAt: 0 }));
        expect(semanticFailurePayload.results).toHaveLength(1);
        expect(semanticFailurePayload.results[0]).toEqual(expect.objectContaining({
            label: "broker status",
            isError: true,
        }));
        expect(semanticFailurePayload.results[0].content[0].value).toEqual(expect.objectContaining({ ok: false }));

        const tooMany = await client.callTool({
            name: "device_run_flow",
            arguments: {
                steps: Array.from({ length: 51 }, () => ({ tool: "display_current", arguments: {} })),
            },
        });
        expect(tooMany.isError).toBe(true);
        expect(((tooMany.content as Array<{ text?: string }>)[0].text ?? "")).toContain("device_run_flow supports at most 50 steps");
    });

    it("reports backends without starting heavyweight devices", { timeout: TIMEOUT }, async () => {
        const result = await client.callTool({ name: "device_backends", arguments: { implicitBroker: false } });
        expect(result.isError).not.toBe(true);

        const content = result.content as Array<{ type: string; text?: string }>;
        const payload = JSON.parse(content[0].text ?? "{}") as {
            ownerId?: string;
            broker?: {
                mode: string;
                lazy: boolean;
                transport: { environmentRequired: boolean };
                containerContract: { incomplete: boolean; environmentRequired: boolean; ownerResolution: string; stateExists: boolean };
                warnings: string[];
                implemented: string[];
                deferred: string[];
            };
            backends?: Array<{ name: string; available: boolean; status?: string; capabilities?: string[] }>;
        };

        expect(payload.ownerId).toMatch(/^[a-f0-9]{16}$/);
        expect(payload.broker).toEqual(expect.objectContaining({
            mode: "broker-unavailable",
            lazy: true,
            transport: expect.objectContaining({ environmentRequired: false }),
            containerContract: expect.objectContaining({
                incomplete: true,
                environmentRequired: false,
                ownerResolution: "host-broker-resolve",
                stateExists: false,
            }),
            warnings: expect.arrayContaining([expect.stringContaining("device-lab container wiring is incomplete")]),
            implemented: expect.arrayContaining(["host ccc auto-started broker discovery"]),
            deferred: expect.not.arrayContaining(["host broker daemon launcher"]),
        }));
        expect(payload.backends?.map((backend) => backend.name)).toEqual([
            "x11-current-display",
            "android-emulator",
            "android-device",
            "ios-simulator",
            "ios-device",
            "windows-sandbox",
            "windows-vm",
            "macos-vm",
            "linux-vm",
        ]);
        const advertisedTools = new Set((await client.listTools()).tools.map((tool) => tool.name));
        const unadvertisedCapabilities = (payload.backends || []).flatMap((backend) => (backend.capabilities || [])
            .filter((capability) => !advertisedTools.has(capability))
            .map((capability) => ({ backend: backend.name, capability })));
        expect(unadvertisedCapabilities).toEqual([]);
        const toolBackendEnums = new Map((await client.listTools()).tools.map((tool) => [
            tool.name,
            ((toolProperties(tool).backend as { enum?: unknown[] } | undefined)?.enum || []).map(String),
        ]));
        const capabilitiesMissingBackendEnum = (payload.backends || []).flatMap((backend) => (backend.capabilities || [])
            .filter((capability) => {
                const backendEnum = toolBackendEnums.get(capability) || [];
                return backendEnum.length > 0 && !backendEnum.includes(backend.name);
            })
            .map((capability) => ({
                backend: backend.name,
                capability,
                advertisedBackendEnum: toolBackendEnums.get(capability) || [],
            })));
        expect(capabilitiesMissingBackendEnum).toEqual([]);
        expect(payload.backends?.find((backend) => backend.name === "android-emulator")?.status).toBe("missing-prerequisites");
        expect(payload.backends?.find((backend) => backend.name === "android-device")?.status).toBe("missing-prerequisites");
        const androidDeviceBackend = payload.backends?.find((backend) => backend.name === "android-device");
        expect(androidDeviceBackend?.capabilities).toContain("device_wireless");
        expect(androidDeviceBackend?.capabilities).not.toEqual(expect.arrayContaining([
            "mobile_set_location",
            "mobile_set_battery",
            "mobile_set_network",
            "mobile_toggle_airplane_mode",
        ]));
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
            "mobile_set_location",
            "mobile_set_clipboard",
            "mobile_get_clipboard",
            "mobile_wait_for_text",
        ]));
        expect(iosSimulatorBackend?.capabilities).not.toEqual(expect.arrayContaining([
            "mobile_set_battery",
            "mobile_set_network",
            "mobile_toggle_airplane_mode",
        ]));
        const iosDeviceBackend = payload.backends?.find((backend) => backend.name === "ios-device");
        expect(iosDeviceBackend?.status).toBe("missing-prerequisites");
        expect(iosDeviceBackend?.capabilities).toContain("device_wireless");
        expect(iosDeviceBackend?.capabilities).not.toEqual(expect.arrayContaining([
            "device_exec",
            "mobile_open_url",
            "mobile_set_location",
            "mobile_set_clipboard",
            "mobile_get_clipboard",
            "mobile_set_battery",
        ]));
        const windowsBackend = payload.backends?.find((backend) => backend.name === "windows-sandbox");
        expect(windowsBackend?.status).toBe("missing-prerequisites");
        expect(windowsBackend?.capabilities).toContain("device_inventory");
        expect(windowsBackend?.capabilities).toEqual(expect.arrayContaining(["device_window_list", "device_accessibility_snapshot"]));
        const macosBackend = payload.backends?.find((backend) => backend.name === "macos-vm");
        expect(macosBackend?.status).toBe("missing-prerequisites");
        expect(macosBackend?.capabilities).toContain("device_inventory");
        expect(macosBackend?.capabilities).toEqual(expect.arrayContaining([
            "device_window_list",
            "device_accessibility_snapshot",
            "device_base_image_create",
            "device_base_image_clone",
        ]));
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
            arguments: { probe: false, autolaunch: false },
        });
        expect(result.isError).not.toBe(true);
        const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ownerId: string;
            mode: string;
            lazy: boolean;
            available: boolean;
            transport: { hostCandidates: string[]; defaultPort: number; zeroConfig: boolean; environmentRequired: boolean };
            probe: { requested: boolean; available: boolean; attempts: unknown[] };
            state: { root: string; ownerRoot: string; locksRoot: string; logsRoot: string; rootExists: boolean };
            containerContract: { incomplete: boolean; stateExists: boolean; deviceStateMounted: boolean; environmentRequired: boolean; ownerResolution: string };
            warnings: string[];
            remedies: string[];
            implemented: string[];
            deferred: string[];
        };

        expect(payload.ownerId).toMatch(/^[a-f0-9]{16}$/);
        expect(payload.mode).toBe("broker-unavailable");
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
        expect(payload.state.rootExists).toBe(false);
        expect(payload.containerContract).toEqual(expect.objectContaining({
            incomplete: true,
            stateExists: false,
            deviceStateMounted: false,
            environmentRequired: false,
            ownerResolution: "host-broker-resolve",
        }));
        expect(payload.containerContract).not.toHaveProperty("ownerBasisEnvPresent");
        expect(payload.containerContract).not.toHaveProperty("ownerBasisMatches");
        expect(payload.warnings).toEqual(expect.arrayContaining([expect.stringContaining("device-lab container wiring is incomplete")]));
        expect(payload.remedies).toEqual(expect.arrayContaining([expect.stringContaining("Restart or recreate ccc from the host")]));
        expect(payload.implemented).toContain("broker contract inspection");
        expect(payload.implemented).toContain("host ccc auto-started broker discovery");
        expect(payload.implemented).toContain("explicit MCP broker autolaunch compatibility");
        expect(payload.implemented).toContain("secret-backed broker owner token auth");
        expect(payload.implemented).toContain("implicit broker lifecycle routing for reachable broker devices");
        expect(payload.implemented).toContain("broker read-only device inventory and recording status routing");
        expect(payload.implemented).toContain("explicit broker recording start/stop routing");
        expect(payload.implemented).toContain("explicit broker Appium process/session/request routing");
        expect(payload.implemented).toContain("opt-in high-level mobile broker Appium routing");
        expect(payload.deferred).not.toContain("host broker daemon launcher");
        expect(payload.deferred).not.toContain("strong broker authentication token handshake");
        expect(payload.deferred).not.toContain("mutating non-lifecycle direct-provider broker routes");
        expect(payload.deferred).not.toContain("full direct-provider routing parity through broker");
    });

    it("omits MCP broker wiring warnings when the shared state root is mounted", { timeout: TIMEOUT }, async () => {
        let wiredContext: DeviceLabMcpTestContext | undefined;
        try {
            wiredContext = await createDeviceLabMcpTestContext({
                setupHome: (homeDir) => mkdirSync(join(homeDir, ".ccc/devices"), { recursive: true }),
            });
            const result = await wiredContext.client.callTool({
                name: "device_broker_status",
                arguments: { probe: false, autolaunch: false },
            });
            expect(result.isError).not.toBe(true);
            const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                containerContract: { incomplete: boolean; stateExists: boolean; deviceStateMounted: boolean; environmentRequired: boolean; ownerResolution: string };
                warnings: string[];
                remedies: string[];
            };

            expect(payload.containerContract).toEqual(expect.objectContaining({
                incomplete: false,
                stateExists: true,
                deviceStateMounted: true,
                environmentRequired: false,
                ownerResolution: "host-broker-resolve",
            }));
            expect(payload.containerContract).not.toHaveProperty("ownerBasisEnvPresent");
            expect(payload.containerContract).not.toHaveProperty("ownerBasisMatches");
            expect(payload.warnings).toEqual([]);
            expect(payload.remedies).toEqual([]);
        } finally {
            await cleanupDeviceLabMcpTestContext(wiredContext);
        }
    });

    it("omits device_backends wiring warnings when the shared state root is mounted", { timeout: TIMEOUT }, async () => {
        let wiredContext: DeviceLabMcpTestContext | undefined;
        try {
            wiredContext = await createDeviceLabMcpTestContext({
                setupHome: (homeDir) => mkdirSync(join(homeDir, ".ccc/devices"), { recursive: true }),
            });
            const result = await wiredContext.client.callTool({
                name: "device_backends",
                arguments: {},
            });
            expect(result.isError).not.toBe(true);
            const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                broker?: {
                    containerContract: { incomplete: boolean; stateExists: boolean; deviceStateMounted: boolean; environmentRequired: boolean; ownerResolution: string };
                    warnings: string[];
                    remedies: string[];
                };
            };

            expect(payload.broker?.containerContract).toEqual(expect.objectContaining({
                incomplete: false,
                stateExists: true,
                deviceStateMounted: true,
                environmentRequired: false,
                ownerResolution: "host-broker-resolve",
            }));
            expect(payload.broker?.warnings).toEqual([]);
            expect(payload.broker?.remedies).toEqual([]);
        } finally {
            await cleanupDeviceLabMcpTestContext(wiredContext);
        }
    });

    it("lists only the current non-creatable X11 display in the foundation slice", { timeout: TIMEOUT }, async () => {
        const result = await client.callTool({ name: "device_list", arguments: {} });
        expect(result.isError).not.toBe(true);

        const content = result.content as Array<{ type: string; text?: string }>;
        const payload = JSON.parse(content[0].text ?? "{}") as {
            devices?: Array<{ id: string; kind: string; creatable: boolean; lifecycle: string; targetStatus: { targetKind: string; runtimeState: string; readiness: { state: string }; leaseState: { state: string }; sessionState: { state: string } } }>;
        };

        expect(payload.devices).toEqual([
            expect.objectContaining({
                id: "x11-current-display",
                kind: "display",
                creatable: false,
                lifecycle: "current",
                targetKind: "current-display",
                runtimeState: "current",
                targetStatus: expect.objectContaining({
                    targetKind: "current-display",
                    creatable: false,
                    attachable: false,
                    runtimeState: "current",
                    readiness: { state: "ready" },
                    leaseState: { state: "not-required" },
                    sessionState: expect.objectContaining({ state: "none" }),
                }),
            }),
        ]);
    });

    it("dispatches every advertised tool name through a safe MCP smoke path", { timeout: 120000 }, async () => {
        const listed = await client.listTools();
        const toolNames = listed.tools.map((tool) => tool.name).sort();
        const brokerProbe = { hostCandidates: ["127.0.0.1"], port: 9, timeoutMs: 1, launchTimeoutMs: 1 };
        const direct = { implicitBroker: false };
        const androidId = "android-exhaustive-smoke";
        const iosId = "ios-exhaustive-smoke";
        const windowsId = "windows-exhaustive-smoke";
        const macosId = "macos-exhaustive-smoke";
        const linuxId = "linux-exhaustive-smoke";

        for (const args of [
            { backend: "android-emulator", name: "Android exhaustive smoke", deviceId: androidId },
            { backend: "ios-simulator", name: "iOS exhaustive smoke", deviceId: iosId },
            { backend: "windows-sandbox", name: "Windows exhaustive smoke", deviceId: windowsId },
            { backend: "macos-vm", name: "macOS exhaustive smoke", deviceId: macosId, image: "missing-image" },
            { backend: "linux-vm", name: "Linux exhaustive smoke", deviceId: linuxId },
        ]) {
            await client.callTool({ name: "device_create", arguments: { ...direct, ...args } });
        }

        const samples: Record<string, Record<string, unknown>> = {
            device_backends: { ...direct },
            device_broker_status: { ...brokerProbe },
            device_list: {},
            device_inventory: { ...direct, backend: "android-emulator" },
            device_image_list: { backend: "linux-vm" },
            device_image_import: { backend: "linux-vm", name: "Missing Linux image", sourcePath: "images/missing-linux-smoke.qcow2" },
            device_wireless: { backend: "android-device", action: "status", timeoutMs: 1 },
            display_current: {},
            display_screenshot: {},
            display_click: { x: 1, y: 1, button: "left" },
            display_double_click: { x: 1, y: 1, button: "left" },
            display_key: { key: "Escape" },
            display_type: { text: "" },
            display_scroll: { x: 1, y: 1, direction: "down", amount: 1 },
            display_cursor_position: {},
            device_create: { ...direct, backend: "android-emulator", name: "Android exhaustive smoke", deviceId: androidId },
            device_attach: { ...direct, backend: "android-device", name: "Android attach smoke", serial: "SERIAL-SMOKE" },
            device_detach: { ...brokerProbe, broker: true, deviceId: "missing-detach-smoke" },
            device_delete: { ...brokerProbe, broker: true, backend: "android-emulator", deviceId: "missing-delete-smoke", confirmDestructive: true },
            device_start: { ...direct, backend: "android-emulator", deviceId: androidId, waitForBoot: false, bootTimeoutMs: 1 },
            device_stop: { ...direct, backend: "android-emulator", deviceId: androidId },
            device_status: { ...direct, backend: "android-emulator", deviceId: androidId },
            device_disk_materialize: { backend: "linux-vm", deviceId: linuxId, dryRun: true },
            device_reboot: { backend: "linux-vm", deviceId: linuxId },
            device_target_list: { backend: "linux-vm", deviceId: linuxId },
            device_readiness_probe: { backend: "linux-vm", deviceId: linuxId },
            device_session_open: { backend: "linux-vm", deviceId: linuxId, sessionType: "metadata" },
            device_workspace_sync: { backend: "linux-vm", deviceId: linuxId, sourcePath: "missing-workspace-smoke" },
            device_artifacts_export: { backend: "linux-vm", deviceId: linuxId },
            device_guest_agent_status: { backend: "linux-vm", deviceId: linuxId },
            device_guest_agent_provision: { backend: "linux-vm", deviceId: linuxId },
            device_exec: { ...direct, backend: "android-emulator", deviceId: androidId, command: "true", helperTimeoutMs: 1 },
            device_screenshot: { ...direct, backend: "android-emulator", deviceId: androidId, helperTimeoutMs: 1 },
            device_click: { ...direct, backend: "windows-sandbox", deviceId: windowsId, x: 1, y: 1, helperTimeoutMs: 1 },
            device_double_click: { ...direct, backend: "windows-sandbox", deviceId: windowsId, x: 1, y: 1, helperTimeoutMs: 1 },
            device_key: { ...direct, backend: "windows-sandbox", deviceId: windowsId, key: "Escape", helperTimeoutMs: 1 },
            device_type: { ...direct, backend: "windows-sandbox", deviceId: windowsId, text: "", helperTimeoutMs: 1 },
            device_scroll: { ...direct, backend: "windows-sandbox", deviceId: windowsId, x: 1, y: 1, direction: "down", amount: 1, helperTimeoutMs: 1 },
            device_cursor_position: { ...direct, backend: "windows-sandbox", deviceId: windowsId, helperTimeoutMs: 1 },
            device_window_list: { ...direct, backend: "windows-sandbox", deviceId: windowsId, helperTimeoutMs: 1 },
            device_accessibility_snapshot: { ...direct, backend: "windows-sandbox", deviceId: windowsId, maxDepth: 1, maxNodes: 1, helperTimeoutMs: 1 },
            device_base_image_create: { backend: "macos-vm", name: "Base image smoke", sourceImage: "missing-source" },
            device_base_image_clone: { backend: "macos-vm", name: "Base clone smoke", sourceDeviceId: macosId },
            device_snapshot_create: { ...direct, backend: "macos-vm", deviceId: macosId, snapshotName: "smoke" },
            device_snapshot_list: { ...brokerProbe, broker: true, backend: "windows-vm", deviceId: "missing-windows-vm-snapshot-list-smoke" },
            device_snapshot_restore: { ...direct, backend: "macos-vm", deviceId: macosId, snapshotName: "smoke", confirmDestructive: true },
            device_snapshot_delete: { ...direct, backend: "macos-vm", deviceId: macosId, snapshotName: "smoke", confirmDestructive: true },
            device_record_video_start: { ...direct, backend: "android-emulator", deviceId: androidId, remotePath: "/sdcard/smoke.mp4", timeLimitSec: 1 },
            device_record_video_stop: { ...direct, backend: "android-emulator", deviceId: androidId, helperTimeoutMs: 1 },
            device_record_video_status: { ...direct, backend: "android-emulator", deviceId: androidId, helperTimeoutMs: 1 },
            device_upload: { ...direct, backend: "android-emulator", deviceId: androidId, localPath: "/tmp/missing-smoke.txt", remotePath: "/sdcard/missing-smoke.txt", helperTimeoutMs: 1 },
            device_download: { ...direct, backend: "android-emulator", deviceId: androidId, remotePath: "/sdcard/missing-smoke.txt", localPath: "/tmp/device-lab-smoke-download.txt", helperTimeoutMs: 1 },
            device_reset: { ...direct, backend: "android-emulator", deviceId: androidId, packageName: "com.example.smoke", confirmDestructive: true },
            device_install_app: { ...direct, backend: "android-emulator", deviceId: androidId, path: "/tmp/missing-smoke.apk" },
            device_launch_app: { ...direct, backend: "android-emulator", deviceId: androidId, packageName: "com.example.smoke" },
            mobile_session_status: { ...direct, backend: "android-emulator", deviceId: androidId },
            mobile_dump_ui: { ...direct, backend: "android-emulator", deviceId: androidId },
            mobile_tap: { ...direct, backend: "android-emulator", deviceId: androidId, x: 1, y: 1 },
            mobile_double_tap: { ...direct, backend: "android-emulator", deviceId: androidId, x: 1, y: 1 },
            mobile_long_press: { ...direct, backend: "android-emulator", deviceId: androidId, x: 1, y: 1, durationMs: 1 },
            mobile_swipe: { ...direct, backend: "android-emulator", deviceId: androidId, x1: 1, y1: 1, x2: 2, y2: 2, durationMs: 1 },
            mobile_drag: { ...direct, backend: "android-emulator", deviceId: androidId, x1: 1, y1: 1, x2: 2, y2: 2, durationMs: 1 },
            mobile_type_text: { ...direct, backend: "android-emulator", deviceId: androidId, text: "smoke" },
            mobile_key: { ...direct, backend: "android-emulator", deviceId: androidId, keyCode: 4 },
            mobile_home: { ...direct, backend: "android-emulator", deviceId: androidId },
            mobile_back: { ...direct, backend: "android-emulator", deviceId: androidId },
            mobile_forward: { ...direct, backend: "android-emulator", deviceId: androidId },
            mobile_recents: { ...direct, backend: "android-emulator", deviceId: androidId },
            mobile_power: { ...direct, backend: "android-emulator", deviceId: androidId },
            mobile_lock: { ...direct, backend: "android-emulator", deviceId: androidId },
            mobile_unlock: { ...direct, backend: "android-emulator", deviceId: androidId },
            mobile_rotate_left: { ...direct, backend: "android-emulator", deviceId: androidId },
            mobile_rotate_right: { ...direct, backend: "android-emulator", deviceId: androidId },
            mobile_set_orientation: { ...direct, backend: "android-emulator", deviceId: androidId, orientation: "portrait" },
            mobile_open_url: { ...direct, backend: "android-emulator", deviceId: androidId, url: "https://example.invalid" },
            mobile_install_app: { ...direct, backend: "android-emulator", deviceId: androidId, path: "/tmp/missing-smoke.apk" },
            mobile_launch_app: { ...direct, backend: "android-emulator", deviceId: androidId, packageName: "com.example.smoke" },
            mobile_uninstall_app: { ...direct, backend: "android-emulator", deviceId: androidId, packageName: "com.example.smoke", confirmDestructive: true },
            mobile_stop_app: { ...direct, backend: "android-emulator", deviceId: androidId, packageName: "com.example.smoke" },
            mobile_clear_app_data: { ...direct, backend: "android-emulator", deviceId: androidId, packageName: "com.example.smoke", confirmDestructive: true },
            mobile_grant_permission: { ...direct, backend: "android-emulator", deviceId: androidId, packageName: "com.example.smoke", permission: "android.permission.CAMERA" },
            mobile_revoke_permission: { ...direct, backend: "android-emulator", deviceId: androidId, packageName: "com.example.smoke", permission: "android.permission.CAMERA" },
            mobile_set_location: { ...direct, backend: "android-emulator", deviceId: androidId, latitude: 1, longitude: 2 },
            mobile_set_battery: { ...direct, backend: "android-emulator", deviceId: androidId, level: 50, confirmDestructive: true },
            mobile_set_network: { ...direct, backend: "android-emulator", deviceId: androidId, wifi: true, confirmDestructive: true },
            mobile_toggle_airplane_mode: { ...direct, backend: "android-emulator", deviceId: androidId, enabled: false, confirmDestructive: true },
            mobile_set_clipboard: { ...direct, backend: "android-emulator", deviceId: androidId, text: "smoke" },
            mobile_get_clipboard: { ...direct, backend: "android-emulator", deviceId: androidId },
            mobile_wait_for_text: { ...direct, backend: "android-emulator", deviceId: androidId, text: "smoke", timeoutMs: 1, intervalMs: 50 },
            mobile_wait_for_app: { ...direct, backend: "android-emulator", deviceId: androidId, packageName: "com.example.smoke", timeoutMs: 1, intervalMs: 50 },
            mobile_screenshot: { ...direct, backend: "android-emulator", deviceId: androidId },
            mobile_run_flow: { steps: [{ tool: "mobile_session_status", arguments: { ...direct, backend: "android-emulator", deviceId: androidId } }] },
            device_run_flow: { steps: [{ tool: "display_current", arguments: {} }] },
        };

        expect(Object.keys(samples).sort()).toEqual(toolNames);
        const missingRequiredSamples = listed.tools.flatMap((tool) => {
            const required = Array.isArray((tool.inputSchema as { required?: unknown } | undefined)?.required)
                ? (tool.inputSchema as { required: unknown[] }).required.map(String)
                : [];
            const sample = samples[tool.name] || {};
            return required
                .filter((key) => !(key in sample))
                .map((key) => ({ name: tool.name, missing: key }));
        });
        expect(missingRequiredSamples).toEqual([]);
        const missingAnyOfSamples = listed.tools.flatMap((tool) => {
            const anyOf = Array.isArray((tool.inputSchema as { anyOf?: unknown } | undefined)?.anyOf)
                ? (tool.inputSchema as { anyOf: Array<{ required?: unknown[] }> }).anyOf
                    .map((item) => Array.isArray(item.required) ? item.required.map(String) : [])
                    .filter((required) => required.length > 0)
                : [];
            const sample = samples[tool.name] || {};
            if (anyOf.length === 0 || anyOf.some((required) => required.every((key) => key in sample))) return [];
            return [{ name: tool.name, anyOf }];
        });
        expect(missingAnyOfSamples).toEqual([]);

        const unknownSampleKeys = listed.tools.flatMap((tool) => {
            const properties = toolProperties(tool);
            const sample = samples[tool.name] || {};
            return Object.keys(sample)
                .filter((key) => !(key in properties) && !HIDDEN_LEGACY_TRANSPORT_KEYS.has(key))
                .map((key) => ({ name: tool.name, unknown: key }));
        });
        expect(unknownSampleKeys).toEqual([]);

        const failures: Array<{ name: string; text: string }> = [];
        for (const name of toolNames) {
            const result = await client.callTool({ name, arguments: samples[name] });
            const text = (result.content as Array<{ text?: string }> | undefined)?.map((item) => item.text || "").join("\n") || "";
            if (/Unknown tool:|Unexpected error:/.test(text)) failures.push({ name, text });
        }
        expect(failures).toEqual([]);

        const mobileFlow = await client.callTool({
            name: "mobile_run_flow",
            arguments: {
                stopOnError: false,
                steps: toolNames
                    .filter((name) => name.startsWith("mobile_") && name !== "mobile_run_flow")
                    .map((name) => ({ tool: name, arguments: samples[name] })),
            },
        });
        expect(mobileFlow.isError).not.toBe(true);
        const mobileFlowPayload = JSON.parse(((mobileFlow.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            results: Array<{ tool?: string; error?: string }>;
        };
        expect(mobileFlowPayload.results).toHaveLength(toolNames.filter((name) => name.startsWith("mobile_") && name !== "mobile_run_flow").length);
        expect(mobileFlowPayload.results.filter((result) => result.error?.includes("mobile_run_flow does not allow step tool"))).toEqual([]);

        const deviceFlowAllowedMobileTools = [
            "mobile_session_status",
            "mobile_dump_ui",
            "mobile_tap",
            "mobile_double_tap",
            "mobile_long_press",
            "mobile_swipe",
            "mobile_drag",
            "mobile_type_text",
            "mobile_key",
            "mobile_home",
            "mobile_back",
            "mobile_forward",
            "mobile_recents",
            "mobile_power",
            "mobile_lock",
            "mobile_unlock",
            "mobile_rotate_left",
            "mobile_rotate_right",
            "mobile_set_orientation",
            "mobile_open_url",
            "mobile_set_clipboard",
            "mobile_get_clipboard",
            "mobile_wait_for_text",
            "mobile_wait_for_app",
            "mobile_screenshot",
        ];
        const deviceMobileFlow = await client.callTool({
            name: "device_run_flow",
            arguments: {
                stopOnError: false,
                steps: deviceFlowAllowedMobileTools.map((name) => ({ tool: name, arguments: samples[name] })),
            },
        });
        expect(deviceMobileFlow.isError).not.toBe(true);
        const deviceMobileFlowPayload = JSON.parse(((deviceMobileFlow.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            results: Array<{ tool?: string; error?: string }>;
        };
        expect(deviceMobileFlowPayload.results).toHaveLength(deviceFlowAllowedMobileTools.length);
        expect(deviceMobileFlowPayload.results.filter((result) => result.error?.includes("device_run_flow does not allow step tool"))).toEqual([]);

        const deviceFlowBlockedMobileTools = toolNames
            .filter((name) => name.startsWith("mobile_"))
            .filter((name) => name !== "mobile_run_flow")
            .filter((name) => !deviceFlowAllowedMobileTools.includes(name));
        const blockedDeviceMobileFlow = await client.callTool({
            name: "device_run_flow",
            arguments: {
                stopOnError: false,
                steps: deviceFlowBlockedMobileTools.map((name) => ({ tool: name, arguments: samples[name] })),
            },
        });
        expect(blockedDeviceMobileFlow.isError).not.toBe(true);
        const blockedDeviceMobileFlowPayload = JSON.parse(((blockedDeviceMobileFlow.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            results: Array<{ tool?: string; error?: string }>;
        };
        expect(blockedDeviceMobileFlowPayload.results).toHaveLength(deviceFlowBlockedMobileTools.length);
        expect(blockedDeviceMobileFlowPayload.results.map((result) => result.error)).toEqual(
            deviceFlowBlockedMobileTools.map((name) => `device_run_flow does not allow step tool: ${name}`),
        );

        for (const deviceId of [androidId, iosId, windowsId, macosId, linuxId]) {
            await client.callTool({ name: "device_delete", arguments: { ...direct, deviceId, force: true, confirmDestructive: true } });
        }
    });

});
