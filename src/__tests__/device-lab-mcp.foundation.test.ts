import { DEVICE_BROKER_PROTOCOL_VERSION } from "@ccc/device-lab/providers/contracts/broker-protocol.mjs";
import { TOOLS, SINGLE_BACKEND_TOOL_DEFAULTS, publicToolName, DEVICE_FLOW_TOOL_NAMES, CREATE_TOOL_BACKENDS, createToolName } from "../../device-lab-mcp/src/tools.mjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync } from "fs";
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
    ...Object.keys(CREATE_TOOL_BACKENDS),
    "status",
    "start",
    "stop",
    "delete",
    "devices",
    "record_video",
    "screenshot",
    "cursor_position",
    "window_list",
    "focus_window",
    "ui",
    "record_video",
    "record_video",
    "exec",
    "upload",
    "download",
    "reset",
    "install_app",
    "launch_app",
    "click",
    "key",
    "type",
    "scroll",
    "snapshot",
    "snapshot",
    "snapshot",
    "attach",
    "detach",
] as const;

const DEVICE_ROUTE_PORT_COLLISION_TOOLS = new Set([...Object.keys(CREATE_TOOL_BACKENDS), "attach"]);
const DEVICE_BACKEND_ENUM = ["android-emulator", "android-device", "ios-simulator", "ios-device", "windows-sandbox", "windows-vm", "macos-vm", "linux-vm"] as const;
const DEVICE_WITH_DISPLAY_BACKEND_ENUM = ["x11-current-display", "android-emulator", "android-device", "ios-simulator", "ios-device", "windows-sandbox", "windows-vm", "macos-vm", "linux-vm"] as const;
const DEVICE_STATUS_BACKEND_ENUM = ["x11-current-display", "android-emulator", "android-device", "ios-simulator", "ios-device", "windows-sandbox", "windows-vm", "macos-vm", "linux-vm"] as const;
const DEVICE_CREATE_BACKEND_ENUM = ["android-emulator", "ios-simulator", "windows-sandbox", "windows-vm", "macos-vm", "linux-vm"] as const;
const DEVICE_EXEC_BACKEND_ENUM = ["android-emulator", "android-device", "ios-simulator", "windows-sandbox", "windows-vm", "macos-vm", "linux-vm"] as const;
const MOBILE_BACKEND_ENUM = ["android-emulator", "android-device", "ios-simulator", "ios-device"] as const;
const ANDROID_BACKEND_ENUM = ["android-emulator", "android-device"] as const;
const ANDROID_EMULATOR_BACKEND_ENUM = ["android-emulator"] as const;
const PHYSICAL_BACKEND_ENUM = ["android-device", "ios-device"] as const;
const DESKTOP_BACKEND_ENUM = ["windows-sandbox", "macos-vm"] as const;
const DISPLAY_DESKTOP_BACKEND_ENUM = ["x11-current-display", "windows-sandbox", "windows-vm", "macos-vm", "linux-vm"] as const;
const SNAPSHOT_BACKEND_ENUM = ["windows-vm", "macos-vm", "linux-vm"] as const;
const RECORDING_BACKEND_ENUM = ["android-emulator", "android-device", "ios-simulator", "windows-sandbox", "macos-vm"] as const;
const FILE_TRANSFER_BACKEND_ENUM = ["android-emulator", "android-device", "ios-simulator", "windows-sandbox", "windows-vm", "macos-vm", "linux-vm"] as const;
const RESET_BACKEND_ENUM = ["android-emulator", "android-device", "ios-simulator"] as const;
const EMULATOR_SIMULATOR_BACKEND_ENUM = ["android-emulator", "ios-simulator"] as const;
const MOBILE_WITHOUT_IOS_DEVICE_BACKEND_ENUM = ["android-emulator", "android-device", "ios-simulator"] as const;
const APP_BACKEND_ENUM = ["android-emulator", "android-device", "ios-simulator", "ios-device"] as const;

const DEVICE_TOOL_BACKEND_ENUMS: Record<string, readonly string[]> = {
    delete: DEVICE_CREATE_BACKEND_ENUM,
    attach: PHYSICAL_BACKEND_ENUM,
    detach: PHYSICAL_BACKEND_ENUM,
    status: DEVICE_STATUS_BACKEND_ENUM,
    screenshot: DEVICE_WITH_DISPLAY_BACKEND_ENUM,
    exec: DEVICE_EXEC_BACKEND_ENUM,
    click: DEVICE_WITH_DISPLAY_BACKEND_ENUM,
    key: DEVICE_WITH_DISPLAY_BACKEND_ENUM,
    type: DEVICE_WITH_DISPLAY_BACKEND_ENUM,
    scroll: DISPLAY_DESKTOP_BACKEND_ENUM,
    cursor_position: DISPLAY_DESKTOP_BACKEND_ENUM,
    window_list: DESKTOP_BACKEND_ENUM,
    ui: DESKTOP_BACKEND_ENUM,
    snapshot: { ...SNAPSHOT_BACKEND_ENUM, action: "create" },
    record_video: { ...RECORDING_BACKEND_ENUM, action: "start" },
    upload: FILE_TRANSFER_BACKEND_ENUM,
    download: FILE_TRANSFER_BACKEND_ENUM,
    reset: RESET_BACKEND_ENUM,
    install_app: APP_BACKEND_ENUM,
    launch_app: APP_BACKEND_ENUM,
};

function expectedDeviceToolBackends(name: string) {
    return DEVICE_TOOL_BACKEND_ENUMS[name] || DEVICE_BACKEND_ENUM;
}

const MOBILE_TOOL_BACKEND_ENUMS: Record<string, readonly string[]> = {
    back: ANDROID_BACKEND_ENUM,
    forward: ANDROID_BACKEND_ENUM,
    recents: ANDROID_BACKEND_ENUM,
    power: ANDROID_BACKEND_ENUM,
    open_url: MOBILE_WITHOUT_IOS_DEVICE_BACKEND_ENUM,
    uninstall_app: MOBILE_WITHOUT_IOS_DEVICE_BACKEND_ENUM,
    clear_app_data: RESET_BACKEND_ENUM,
    permission: { ...MOBILE_WITHOUT_IOS_DEVICE_BACKEND_ENUM, action: "grant" },
    set_location: EMULATOR_SIMULATOR_BACKEND_ENUM,
    set_battery: ANDROID_EMULATOR_BACKEND_ENUM,
    set_network: ANDROID_EMULATOR_BACKEND_ENUM,
    clipboard: MOBILE_WITHOUT_IOS_DEVICE_BACKEND_ENUM,
};

function expectedMobileToolBackends(name: string) {
    if (["click", "type", "key", "screenshot", "install_app", "launch_app"].includes(name)) return expectedDeviceToolBackends(name);
    return MOBILE_TOOL_BACKEND_ENUMS[name] || MOBILE_BACKEND_ENUM;
}

const BROKER_CAPABLE_MOBILE_TOOLS = [
    "status",
    "ui",
    "click",
    "long_press",
    "swipe",
    "drag",
    "type",
    "key",
    "home",
    "back",
    "forward",
    "recents",
    "power",
    "lock",
    "unlock",


    "set_orientation",
    "open_url",
    "install_app",
    "launch_app",
    "uninstall_app",
    "stop_app",
    "clear_app_data",
    "permission",
    "permission",
    "set_location",
    "set_battery",
    "set_network",
    "set_network",
    "clipboard",
    "clipboard",
    "wait_for_text",
    "wait_for_app",
    "screenshot",
] as const;

function toolProperties(tool: { inputSchema?: unknown } | undefined) {
    const schema = tool?.inputSchema as any;
    return Object.assign({}, ...(schema?.oneOf || []).map((branch: any) => branch.properties), schema?.properties);
}

function expectNoRoutingProperties(properties: Record<string, unknown>, extraKeys: string[] = []) {
    for (const key of [...ROUTING_SCHEMA_KEYS, ...extraKeys]) expect(properties).not.toHaveProperty(key);
}

function expectRoutingProperties(properties: Record<string, unknown>, extra: { port?: boolean; mobile?: boolean } = {}) {
    expectNoRoutingProperties(properties);
    void extra.port;
    if (extra.mobile === true) {
        expectNoRoutingProperties(properties, ["appiumPort", "serverPort", "automationName", "provider", "physical"]);
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
        expect(names).toEqual(TOOLS.map((tool: { name: string }) => tool.name));
        expect(new Set(names).size).toBe(TOOLS.length);
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

        expect(names).toContain("devices");
        expect(names).toContain("devices");
        expect(names).not.toContain("device_broker_shutdown");
        expect(names).not.toContain("device_broker_service");
        expect(names).not.toContain("device_broker_rpc");
        expect(names).not.toContain("device_broker_lease");
        expect(names).not.toContain("device_broker_attach");
        expect(names).not.toContain("device_broker_apple");
        expect(names).not.toContain("device_broker_command");
        expect(names).not.toContain("device_broker_appium");
        expect(names).toContain("devices");
        expect(names).toContain("devices");
        expect(names).toContain("wireless");
        expect(names).toContain("status");
        expect(names).toContain("screenshot");
        expect(names).toContain("click");
        expect(names).not.toContain("double_click");
        expect(names).toContain("key");
        expect(names).toContain("type");
        expect(names).toContain("scroll");
        expect(names).toContain("cursor_position");
        expect(names).toEqual(expect.arrayContaining(Object.keys(CREATE_TOOL_BACKENDS)));
        expect(names).not.toContain("create");
        expect(names).toContain("attach");
        expect(names).toContain("detach");
        expect(names).toContain("delete");
        expect(names).toContain("start");
        expect(names).toContain("stop");
        expect(names).toContain("status");
        expect(names).toContain("exec");
        expect(names).toContain("screenshot");
        expect(names).toContain("click");
        expect(names).not.toContain("double_click");
        expect(names).toContain("key");
        expect(names).toContain("type");
        expect(names).toContain("scroll");
        expect(names).toContain("cursor_position");
        expect(names).toContain("window_list");
        expect(names).toContain("ui");
        expect(names).not.toContain("clone_macos_vm");
        expect(names).not.toContain("device_image_create");
        expect(names).not.toContain("device_image_clone");
        expect(names).toContain("snapshot");
        expect(names).toContain("snapshot");
        expect(names).toContain("snapshot");
        expect(names).toContain("record_video");
        expect(names).toContain("record_video");
        expect(names).toContain("record_video");
        expect(names).toContain("upload");
        expect(names).toContain("download");
        expect(names).toContain("reset");
        expect(names).toContain("install_app");
        expect(names).toContain("launch_app");
        expect(names).toContain("status");
        expect(names).toContain("ui");
        expect(names).toContain("click");
        expect(names).not.toContain("double_click");
        expect(names).toContain("long_press");
        expect(names).toContain("swipe");
        expect(names).toContain("drag");
        expect(names).toContain("type");
        expect(names).toContain("key");
        expect(names).toContain("home");
        expect(names).toContain("back");
        expect(names).toContain("forward");
        expect(names).toContain("recents");
        expect(names).toContain("power");
        expect(names).toContain("lock");
        expect(names).toContain("unlock");
        expect(names).not.toContain("mobile_rotate_left");
        expect(names).not.toContain("mobile_rotate_right");
        expect(names).toContain("set_orientation");
        expect(names).toContain("open_url");
        expect(names).toContain("install_app");
        expect(names).toContain("launch_app");
        expect(names).toContain("uninstall_app");
        expect(names).toContain("stop_app");
        expect(names).toContain("clear_app_data");
        expect(names).toContain("permission");
        expect(names).toContain("permission");
        expect(names).toContain("set_location");
        expect(names).toContain("set_battery");
        expect(names).toContain("set_network");
        expect(names).toContain("set_network");
        expect(names).toContain("clipboard");
        expect(names).toContain("clipboard");
        expect(names).toContain("wait_for_text");
        expect(names).toContain("wait_for_app");
        expect(names).toContain("screenshot");
        expect(names).toContain("run_flow");
        expect(names).toContain("run_flow");
        const backendsTool = result.tools.find((tool) => tool.name === "devices");
        expectRoutingProperties(toolProperties(backendsTool));
        const deviceRunFlowTool = result.tools.find((tool) => tool.name === "run_flow");
        expect(deviceRunFlowTool?.inputSchema).toEqual(expect.objectContaining({
            required: ["steps"],
            properties: expect.objectContaining({
                stopOnError: expect.objectContaining({ type: "boolean" }),
                steps: expect.objectContaining({ type: "array", minItems: 1, maxItems: 50 }),
            }),
        }));
        const stepSchema = ((toolProperties(deviceRunFlowTool).steps as { items?: unknown }).items || {}) as { anyOf?: unknown[]; properties?: Record<string, unknown> };
        expect(stepSchema).toEqual(expect.objectContaining({
            required: ["tool"],
            properties: expect.objectContaining({
                arguments: expect.objectContaining({ type: "object" }),
                label: expect.objectContaining({ type: "string" }),
                tool: expect.objectContaining({ type: "string" }),
            }),
        }));
        const wirelessTool = result.tools.find((tool) => tool.name === "wireless");
        expect(wirelessTool?.inputSchema).toEqual(expect.objectContaining({
            required: ["backend"],
            properties: expect.objectContaining({
                backend: expect.objectContaining({ enum: ["android-device", "ios-device"] }),
                action: expect.objectContaining({ enum: ["status", "usb-tcpip", "pair", "connect"] }),
                pairingCode: expect.objectContaining({ type: "string" }),
                timeoutMs: expect.objectContaining({ maximum: 30000 }),
            }),
        }));
        const brokerTool = result.tools.find((tool) => tool.name === "devices");
        const brokerProperties = toolProperties(brokerTool);
        expect(brokerProperties).toEqual(expect.objectContaining({
            detail: expect.objectContaining({ type: "boolean" }),
        }));
        expect(brokerProperties).not.toHaveProperty("shutdown");
        expectRoutingProperties(brokerProperties);
        for (const name of BROKER_CAPABLE_DEVICE_TOOLS) {
            const tool = TOOLS.find((candidate: { name: string }) => candidate.name === name);
            expect(tool, `${name} should remain accepted`).toBeTruthy();
            expectRoutingProperties(toolProperties(tool), { port: !DEVICE_ROUTE_PORT_COLLISION_TOOLS.has(name) });
            if (name === "devices") expectBackendProperty(toolProperties(tool), [...DEVICE_BACKEND_ENUM, "x11-current-display"]);
            else if (["create", "attach"].includes(name)) expectBackendProperty(toolProperties(tool), expectedDeviceToolBackends(name));
            else expect(toolProperties(tool)).not.toHaveProperty("backend");
        }
        for (const name of BROKER_CAPABLE_MOBILE_TOOLS) {
            const tool = TOOLS.find((candidate: { name: string }) => candidate.name === name);
            expect(tool, `${name} should remain accepted`).toBeTruthy();
            expectRoutingProperties(toolProperties(tool), { mobile: true });
            expect(toolProperties(tool)).not.toHaveProperty("backend");
        }
        const mobileDumpTool = result.tools.find((tool) => tool.name === "ui");
        const mobileDumpProperties = toolProperties(mobileDumpTool);
        expect(mobileDumpTool?.inputSchema).toEqual(expect.objectContaining({ required: ["deviceId"] }));
        expect(mobileDumpProperties).toEqual(expect.objectContaining({
            deviceId: expect.objectContaining({ type: "string" }),
        }));
        expectRoutingProperties(mobileDumpProperties, { mobile: true });
        const mobileTapTool = result.tools.find((tool) => tool.name === "click");
        const mobileTapProperties = toolProperties(mobileTapTool);
        expect(mobileTapTool?.inputSchema).toEqual(expect.objectContaining({ required: ["deviceId", "x", "y"] }));
        expect(mobileTapProperties).toEqual(expect.objectContaining({
            deviceId: expect.objectContaining({ type: "string" }),
            x: expect.objectContaining({ type: "number" }),
            y: expect.objectContaining({ type: "number" }),
        }));
        expectRoutingProperties(mobileTapProperties, { mobile: true });
        for (const name of ["forward", "recents", "power"]) {
            const mobileControlTool = TOOLS.find((tool: { name: string }) => tool.name === name);
            const mobileControlProperties = toolProperties(mobileControlTool);
            expect(mobileControlTool?.inputSchema).toEqual(expect.objectContaining({ required: ["deviceId"] }));
            expect(mobileControlProperties).toEqual(expect.objectContaining({
                deviceId: expect.objectContaining({ type: "string" }),
            }));
            expectRoutingProperties(mobileControlProperties, { mobile: true });
        }
        for (const name of ["screenshot", "open_url", "install_app", "launch_app", "uninstall_app", "stop_app", "clear_app_data", "set_location", "clipboard", "clipboard", "wait_for_app"]) {
            const mobileAppTool = TOOLS.find((tool: { name: string }) => tool.name === name);
            const mobileAppProperties = toolProperties(mobileAppTool);
            expect(mobileAppTool?.inputSchema).toEqual(expect.objectContaining({ required: expect.arrayContaining(["deviceId"]) }));
            expect(mobileAppProperties).toEqual(expect.objectContaining({
                deviceId: expect.objectContaining({ type: "string" }),
            }));
            expectRoutingProperties(mobileAppProperties, { mobile: true });
        }
        for (const name of ["set_network", "set_network"]) {
            const mobileNetworkTool = result.tools.find((tool) => tool.name === name);
            const mobileNetworkProperties = toolProperties(mobileNetworkTool);
            expect(mobileNetworkTool?.inputSchema).toEqual(expect.objectContaining({ required: expect.arrayContaining(["deviceId"]) }));
            expect(mobileNetworkProperties).toEqual(expect.objectContaining({
                confirmDestructive: expect.objectContaining({ type: "boolean" }),
                deviceId: expect.objectContaining({ type: "string" }),
            }));
            expectRoutingProperties(mobileNetworkProperties, { mobile: true });
        }
        for (const name of ["permission", "set_battery"]) {
            const brokerBackedMobileTool = result.tools.find((tool) => tool.name === name);
            const brokerBackedMobileProperties = toolProperties(brokerBackedMobileTool);
            expect(brokerBackedMobileTool?.inputSchema).toEqual(expect.objectContaining({ required: expect.arrayContaining(["deviceId"]) }));
            expectRoutingProperties(brokerBackedMobileProperties, { mobile: true });
        }
        const waitForTextTool = result.tools.find((tool) => tool.name === "wait_for_text");
        const waitForTextProperties = toolProperties(waitForTextTool);
        expect(waitForTextTool?.inputSchema).toEqual(expect.objectContaining({ required: ["deviceId", "text"] }));
        expect(waitForTextProperties).toEqual(expect.objectContaining({
            deviceId: expect.objectContaining({ type: "string" }),
            text: expect.objectContaining({ type: "string" }),
            timeoutMs: expect.objectContaining({ type: "number" }),
            intervalMs: expect.objectContaining({ type: "number" }),
        }));
        expectRoutingProperties(waitForTextProperties, { mobile: true });
        const lifecycleTool = result.tools.find((tool) => tool.name === "start");
        const lifecycleProperties = toolProperties(lifecycleTool);
        expect(lifecycleTool?.inputSchema).toEqual(expect.objectContaining({ required: ["deviceId"] }));
        expect(lifecycleProperties).toEqual(expect.objectContaining({
            deviceId: expect.objectContaining({ type: "string" }),
            minimized: expect.objectContaining({ type: "boolean" }),
        }));
        expect(lifecycleProperties).not.toHaveProperty("backend");
        expectRoutingProperties(lifecycleProperties);
        const createTool = result.tools.find((tool) => tool.name === "create_linux_vm");
        const createProperties = toolProperties(createTool);
        expect(createTool?.inputSchema).toEqual(expect.objectContaining({ required: ["name"] }));
        expect(createProperties).toEqual(expect.objectContaining({
            name: expect.objectContaining({ type: "string" }),
            provider: expect.objectContaining({ enum: ["auto", "hyper-v", "container-qemu"] }),
            image: expect.objectContaining({ type: "string" }),
            ssh: expect.objectContaining({ type: "object", additionalProperties: false, properties: expect.objectContaining({
                host: expect.objectContaining({ type: "string" }),
            }) }),
        }));
        expect(createProperties).not.toHaveProperty("backend");
        expect(createProperties).not.toHaveProperty("options");
        for (const name of Object.keys(CREATE_TOOL_BACKENDS)) {
            expect(toolProperties(TOOLS.find((tool: { name: string }) => tool.name === name))).not.toHaveProperty("options");
        }
        expectRoutingProperties(createProperties, { port: false });
        const attachTool = result.tools.find((tool) => tool.name === "attach");
        const attachProperties = toolProperties(attachTool);
        expect(attachTool?.inputSchema).toEqual(expect.objectContaining({ required: ["backend"] }));
        expect(attachProperties).toEqual(expect.objectContaining({
            port: expect.objectContaining({ type: "integer" }),
        }));
        expectBackendProperty(attachProperties, PHYSICAL_BACKEND_ENUM);
        expectRoutingProperties(attachProperties, { port: false });
        for (const name of ["detach", "delete", "stop", "status"]) {
            const routedLifecycleTool = result.tools.find((tool) => tool.name === name);
            const routedLifecycleProperties = toolProperties(routedLifecycleTool);
            expect(routedLifecycleTool?.inputSchema).toEqual(expect.objectContaining({ required: expect.arrayContaining(["deviceId"]) }));
            expect(routedLifecycleProperties).not.toHaveProperty("backend");
            expectRoutingProperties(routedLifecycleProperties);
        }
        expect(toolProperties(result.tools.find((tool) => tool.name === "delete"))).toEqual(
            expect.objectContaining({
                preserveNetwork: expect.objectContaining({ type: "boolean" }),
            }),
        );
        for (const name of ["status", "snapshot"]) {
            expect(toolProperties(result.tools.find((tool) => tool.name === name))).toEqual(expect.objectContaining({
                incarnationId: expect.objectContaining({ type: "string", pattern: "^[a-f0-9]{32}$" }),
            }));
        }
        const inventoryTool = result.tools.find((tool) => tool.name === "devices");
        const inventoryProperties = toolProperties(inventoryTool);
        expectBackendProperty(inventoryProperties, [...DEVICE_BACKEND_ENUM, "x11-current-display"]);
        expectRoutingProperties(inventoryProperties);
        const recordingStatusTool = result.tools.find((tool) => tool.name === "record_video");
        const recordingStatusProperties = toolProperties(recordingStatusTool);
        expect(recordingStatusTool?.inputSchema).toEqual(expect.objectContaining({ required: ["deviceId", "action"] }));
        expect(recordingStatusProperties).toEqual(expect.objectContaining({
            deviceId: expect.objectContaining({ type: "string" }),
        }));
        expectRoutingProperties(recordingStatusProperties);
        for (const action of ["restore", "delete"]) {
            const schema = result.tools.find(tool => tool.name === "snapshot")!.inputSchema as any;
            expect(schema.oneOf.find((variant: any) => variant.properties.action.const === action).oneOf).toEqual([{ required: ["snapshotName"] }, { required: ["snapshotId"] }]);
        }
        expectAnyOfRequired(result.tools.find((tool) => tool.name === "reset"), []);
        expect(Object.keys(toolProperties(result.tools.find(tool => tool.name === "reset"))).sort()).toEqual(["confirmDestructive", "detail", "deviceId"]);
        for (const catalog of [result.tools, TOOLS]) {
            const launch = catalog.find((tool: { name: string }) => tool.name === "launch_app")!.inputSchema as any;
            expect(launch.oneOf.map((variant: any) => variant.required)).toEqual([["appId"], ["component"]]);
        }
        for (const name of ["uninstall_app", "stop_app", "clear_app_data", "wait_for_app"]) {
            expect(result.tools.find(tool => tool.name === name)!.inputSchema.required).toContain("appId");
        }
        const permissionSchema = result.tools.find(tool => tool.name === "permission")!.inputSchema;
        expect(permissionSchema.required).toEqual(["deviceId", "action", "appId", "permission"]);
        expect(permissionSchema.oneOf).toBeUndefined();
        expectAnyOfRequired({ inputSchema: permissionSchema } as any, []);
        expectAnyOfRequired(result.tools.find((tool) => tool.name === "set_battery"), [["level"], ["status"], ["charging"]]);
        expectAnyOfRequired(result.tools.find((tool) => tool.name === "set_network"), [["airplaneMode"], ["wifi"], ["data"]]);
        const accessibilityTool = result.tools.find((tool) => tool.name === "ui");
        const accessibilityProperties = toolProperties(accessibilityTool);
        expect(accessibilityTool?.inputSchema).toEqual(expect.objectContaining({ required: ["deviceId"] }));
        expect(accessibilityProperties).toEqual(expect.objectContaining({
            deviceId: expect.objectContaining({ type: "string" }),
            maxDepth: expect.objectContaining({ maximum: 8 }),
            maxNodes: expect.objectContaining({ maximum: 1000 }),
        }));
        expectRoutingProperties(accessibilityProperties);
        const desktopExecTool = result.tools.find((tool) => tool.name === "exec");
        const desktopExecProperties = toolProperties(desktopExecTool);
        expect(desktopExecTool?.inputSchema).toEqual(expect.objectContaining({ required: ["deviceId", "command"] }));
        expect(desktopExecProperties).toEqual(expect.objectContaining({
            deviceId: expect.objectContaining({ type: "string" }),
            timeoutMs: expect.objectContaining({ type: "number" }),
        }));
        expectRoutingProperties(desktopExecProperties);
        const uploadTool = result.tools.find((tool) => tool.name === "upload");
        const uploadProperties = toolProperties(uploadTool);
        expect(uploadProperties).toEqual(expect.objectContaining({
            timeoutMs: expect.objectContaining({ type: "number" }),
        }));
        expectRoutingProperties(uploadProperties);
        const downloadTool = result.tools.find((tool) => tool.name === "download");
        const downloadProperties = toolProperties(downloadTool);
        expect(downloadProperties).toEqual(expect.objectContaining({
            timeoutMs: expect.objectContaining({ type: "number" }),
        }));
        expectRoutingProperties(downloadProperties);
        const recordStopTool = result.tools.find((tool) => tool.name === "record_video");
        const recordStopProperties = toolProperties(recordStopTool);
        expect(recordStopProperties).toEqual(expect.objectContaining({
            timeoutMs: expect.objectContaining({ type: "number" }),
        }));
        expectRoutingProperties(recordStopProperties);
        const scrollTool = result.tools.find((tool) => tool.name === "scroll");
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
            { name: "status", arguments: { deviceId: "../../outside" } },
            { name: "create_ios_simulator", arguments: {  deviceId: "..\\outside", name: "Unsafe" } },
        ]) {
            const result = await client.callTool(request);
            expect(result.isError).toBe(true);
            expect((result.content as Array<{ text?: string }>)[0].text).toContain("device-id-invalid");
            expect((result.content as Array<{ text?: string }>)[0].text).not.toContain("Unexpected error");
        }

        const flow = await client.callTool({
            name: "run_flow",
            arguments: { steps: [{ tool: "status", arguments: { deviceId: "/tmp/outside" } }] },
        });
        expect(flow.isError).toBe(true);
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
            name: "status",
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
            deviceId: "x11-current-display",
            kind: "display",
            backend: "x11",
        }));
        expect(displayStatusPayload.capabilities?.map(publicToolName)).toEqual(expect.arrayContaining([
            "status",
            "screenshot",
            "click",
            "cursor_position",
        ]));

        const flow = await client.callTool({
            name: "run_flow",
            arguments: {
                steps: [
                    { label: "current display", tool: "status", arguments: { deviceId: "x11-current-display" } },
                    { label: "devices", tool: "devices", arguments: { view: "available", backend: "windows-sandbox", implicitBroker: false } },
                ],
            },
        });
        expect(flow.isError).not.toBe(true);
        const payload = JSON.parse(((flow.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ok: boolean;
            results: Array<{ label: string; isError: boolean; content: Array<{ type: string; value?: { id?: string; backend?: string } }> }>;
        };
        expect(payload.ok).toBe(true);
        expect(payload.results.map((result) => result.label)).toEqual(["current display", "devices"]);
        expect(payload.results[0].content[0].value).toEqual(expect.objectContaining({
            deviceId: "x11-current-display",
            backend: "x11",
        }));
        expect(payload.results[1].content[0].value).toEqual(expect.objectContaining({ backend: "windows-sandbox" }));

        const stopped = await client.callTool({
            name: "run_flow",
            arguments: {
                steps: [
                    { label: "start", tool: "start", arguments: { deviceId: "win-flow" } },
                    { label: "display", tool: "status", arguments: { deviceId: "x11-current-display" } },
                ],
            },
        });
        expect(stopped.isError).toBe(true);
        const stoppedPayload = JSON.parse(((stopped.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ok: boolean;
            stoppedAt: number;
            results: Array<{ label: string; tool?: string; isError: boolean; error?: string }>;
        };
        expect(stoppedPayload).toEqual(expect.objectContaining({ ok: false, stoppedAt: 0 }));
        expect(stoppedPayload.results).toHaveLength(1);
        expect(stoppedPayload.results[0]).toEqual(expect.objectContaining({
            label: "start",
            tool: "start",
            isError: true,
            error: "device_run_flow does not allow step tool: start",
        }));

        const continued = await client.callTool({
            name: "run_flow",
            arguments: {
                stopOnError: false,
                steps: [
                    { label: "upload", tool: "upload", arguments: { deviceId: "win-flow", localPath: "/tmp/a", remotePath: "C:\\a" } },
                    { label: "display", tool: "status", arguments: { deviceId: "x11-current-display" } },
                ],
            },
        });
        expect(continued.isError).toBe(true);
        const continuedPayload = JSON.parse(((continued.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ok: boolean;
            results: Array<{ label: string; isError: boolean; error?: string; content?: Array<{ value?: { id?: string } }> }>;
        };
        expect(continuedPayload.ok).toBe(false);
        expect(continuedPayload.results).toHaveLength(2);
        expect(continuedPayload.results[0]).toEqual(expect.objectContaining({
            label: "upload",
            isError: true,
            error: "device_run_flow does not allow step tool: upload",
        }));
        expect(continuedPayload.results[1].content?.[0].value).toEqual(expect.objectContaining({ deviceId: "x11-current-display" }));

        const recordingStatus = await client.callTool({
            name: "run_flow",
            arguments: {
                steps: [
                    { label: "recording", tool: "record_video", arguments: { action: "status", deviceId: "win-flow", implicitBroker: false } },
                    { label: "display", tool: "status", arguments: { deviceId: "x11-current-display" } },
                ],
            },
        });
        expect(recordingStatus.isError).toBe(true);
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
            name: "run_flow",
            arguments: {
                stopOnError: false,
                steps: [
                    { label: "set clipboard", tool: "clipboard", arguments: { deviceId: "android-flow", text: "flow-clipboard", implicitBroker: false } },
                    { label: "get clipboard", tool: "clipboard", arguments: { deviceId: "android-flow", implicitBroker: false } },
                ],
            },
        });
        expect(clipboardFlow.isError).toBe(true);
        const clipboardFlowPayload = JSON.parse(((clipboardFlow.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            results: Array<{ label: string; error?: string }>;
        };
        expect(clipboardFlowPayload.results).toHaveLength(2);
        expect(clipboardFlowPayload.results.filter((result) => result.error?.includes("device_run_flow does not allow step tool"))).toEqual([]);

        const semanticFailure = await client.callTool({
            name: "run_flow",
            arguments: {
                steps: [
                    { label: "broker status", tool: "status", arguments: { deviceId: "unknown-flow-device", broker: true } },
                    { label: "display", tool: "status", arguments: { deviceId: "x11-current-display" } },
                ],
            },
        });
        expect(semanticFailure.isError).toBe(true);
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
            name: "run_flow",
            arguments: {
                steps: Array.from({ length: 51 }, () => ({ tool: "status", arguments: { deviceId: "x11-current-display" } })),
            },
        });
        expect(tooMany.isError).toBe(true);
        expect(((tooMany.content as Array<{ text?: string }>)[0].text ?? "")).toContain("device_run_flow supports at most 50 steps");
    });

    it("reports backends without starting heavyweight devices", { timeout: TIMEOUT }, async () => {
        const isolated = await createDeviceLabMcpTestContext();
        try {
            const client = isolated.client;
            expect(existsSync(join(isolated.homeDir, ".ccc", "devices"))).toBe(false);
            const result = await client.callTool({ name: "devices", arguments: { view: "backends", implicitBroker: false } });
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
                    protocolVersion: number;
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
                protocolVersion: DEVICE_BROKER_PROTOCOL_VERSION,
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
            for (const backend of payload.backends || []) backend.capabilities = (backend.capabilities || []).map(publicToolName);
            const acceptedTools = new Set([...TOOLS.map((tool: { name: string }) => tool.name),
                "rotate_left", "rotate_right", "install_app", "launch_app", "screenshot"]);
            const unknownCapabilities = (payload.backends || []).flatMap((backend) => (backend.capabilities || [])
                .filter((capability) => !acceptedTools.has(capability))
                .map((capability) => ({ backend: backend.name, capability })));
            expect(unknownCapabilities).toEqual([]);
            const toolBackendEnums = new Map(TOOLS.map((tool: { name: string }) => [
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
            expect(androidDeviceBackend?.capabilities).toContain("wireless");
            expect(androidDeviceBackend?.capabilities).not.toEqual(expect.arrayContaining([
                "set_location",
                "set_battery",
                "set_network",
                "set_network",
            ]));
            const iosSimulatorBackend = payload.backends?.find((backend) => backend.name === "ios-simulator");
            expect(iosSimulatorBackend?.status).toBe("missing-prerequisites");
            expect(iosSimulatorBackend?.capabilities).toEqual(expect.arrayContaining([
                "click",
                "long_press",
                "swipe",
                "drag",
                "type",
                "key",
                "home",
                "lock",
                "unlock",
                "set_orientation",
                "set_location",
                "clipboard",
                "clipboard",
                "wait_for_text",
            ]));
            expect(iosSimulatorBackend?.capabilities).not.toEqual(expect.arrayContaining([
                "set_battery",
                "set_network",
                "set_network",
            ]));
            const iosDeviceBackend = payload.backends?.find((backend) => backend.name === "ios-device");
            expect(iosDeviceBackend?.status).toBe("missing-prerequisites");
            expect(iosDeviceBackend?.capabilities).toContain("wireless");
            expect(iosDeviceBackend?.capabilities).not.toEqual(expect.arrayContaining([
                "exec",
                "open_url",
                "set_location",
                "clipboard",
                "clipboard",
                "set_battery",
            ]));
            const windowsBackend = payload.backends?.find((backend) => backend.name === "windows-sandbox");
            expect(windowsBackend?.status).toBe("missing-prerequisites");
            expect(windowsBackend?.capabilities).toContain("devices");
            expect(windowsBackend?.capabilities).toEqual(expect.arrayContaining(["window_list", "ui"]));
            const macosBackend = payload.backends?.find((backend) => backend.name === "macos-vm");
            expect(macosBackend?.status).toBe("missing-prerequisites");
            expect(macosBackend?.capabilities).toContain("devices");
            expect(macosBackend?.capabilities).toEqual(expect.arrayContaining([
                "window_list",
                "ui",
                "create_macos_vm",
            ]));
        } finally {
            await cleanupDeviceLabMcpTestContext(isolated);
        }
    });

    it("reports real-device wireless missing prerequisites without environment configuration", { timeout: TIMEOUT }, async () => {
        const android = await client.callTool({
            name: "wireless",
            arguments: { backend: "android-device", action: "status" },
        });
        expect(android.isError).toBe(true);
        expect(JSON.parse((android.content as Array<{ text?: string }>)[0].text ?? "{}")).toEqual(expect.objectContaining({
            ok: false,
            error: "android-wireless-missing-adb",
            missing: ["adb"],
        }));

        const ios = await client.callTool({
            name: "wireless",
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
        const isolated = await createDeviceLabMcpTestContext();
        try {
            const client = isolated.client;
            expect(existsSync(join(isolated.homeDir, ".ccc", "devices"))).toBe(false);
            const result = await client.callTool({
                name: "devices",
                arguments: { view: "backends", implicitBroker: false, detail: true },
            });
            expect(result.isError).not.toBe(true);
            const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}")).broker as {
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
                protocolVersion: number;
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
            expect(payload.state.locksRoot).toContain(join(".ccc", "devices", "broker", "locks"));
            expect(payload.state).toEqual(expect.objectContaining({ runtimeFile: expect.stringContaining(join(".ccc", "devices", "broker", "runtime.json")) }));
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
        } finally {
            await cleanupDeviceLabMcpTestContext(isolated);
        }
    });

    it("omits MCP broker wiring warnings when the shared state root is mounted", { timeout: TIMEOUT }, async () => {
        let wiredContext: DeviceLabMcpTestContext | undefined;
        try {
            wiredContext = await createDeviceLabMcpTestContext({
                setupHome: (homeDir) => mkdirSync(join(homeDir, ".ccc/devices"), { recursive: true }),
            });
            const result = await wiredContext.client.callTool({
                name: "devices",
                arguments: { view: "backends", implicitBroker: false, detail: true },
            });
            expect(result.isError).not.toBe(true);
            const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}")).broker as {
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
                name: "devices",
                arguments: { view: "backends",},
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
        const result = await client.callTool({ name: "devices", arguments: {} });
        expect(result.isError).not.toBe(true);

        const content = result.content as Array<{ type: string; text?: string }>;
        const payload = JSON.parse(content[0].text ?? "{}") as {
            devices?: Array<{ deviceId: string; kind: string; creatable: boolean; lifecycle: string; targetStatus: { targetKind: string; runtimeState: string; readiness: { state: string }; leaseState: { state: string }; sessionState: { state: string } } }>;
        };

        const hasDisplayTools = ["xdotool", "scrot"].every(tool =>
            existsSync(`/usr/bin/${tool}`) || existsSync(`/bin/${tool}`));

        expect(payload.devices).toEqual([
            expect.objectContaining({
                deviceId: "x11-current-display",
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
                    readiness: hasDisplayTools
                        ? { state: "ready" }
                        : { state: "unavailable", reason: "missing-prerequisites" },
                    leaseState: { state: "not-required" },
                    sessionState: expect.objectContaining({ state: "none" }),
                }),
            }),
        ]);
    });

    it("dispatches every accepted tool name from the canonical catalog through a safe MCP smoke path", { timeout: 120000 }, async () => {
        const listed = await client.listTools();
        const toolNames = TOOLS.map((tool: { name: string }) => tool.name).sort();
        const brokerProbe = { hostCandidates: ["127.0.0.1"], port: 9, timeoutMs: 1, launchTimeoutMs: 1 };
        const direct = { implicitBroker: false };
        const androidId = "android-exhaustive-smoke";
        const iosId = "ios-exhaustive-smoke";
        const windowsId = "windows-exhaustive-smoke";
        const macosId = "macos-exhaustive-smoke";
        const linuxId = "linux-exhaustive-smoke";

        for (const args of [
            { backend: "android-emulator", name: "Android exhaustive smoke", avdName: "existing-smoke", deviceId: androidId },
            { backend: "ios-simulator", name: "iOS exhaustive smoke", deviceId: iosId },
            { backend: "windows-sandbox", name: "Windows exhaustive smoke", deviceId: windowsId },
            { backend: "macos-vm", name: "macOS exhaustive smoke", deviceId: macosId, image: "missing-image" },
            { backend: "linux-vm", name: "Linux exhaustive smoke", deviceId: linuxId },
        ]) {
            const { backend, ...input } = args;
            await client.callTool({ name: createToolName(backend), arguments: { ...direct, ...input } });
        }

        const samples: Record<string, Record<string, unknown>> = {
            devices: {},
            list_files: { ...direct, deviceId: androidId, path: "/", limit: 2 },
            list_images: { },
            import_image: { name: "Missing Linux image", sourcePath: "images/missing-linux-smoke.qcow2" },
            wireless: { backend: "android-device", action: "status", timeoutMs: 1 },
            create_android_emulator: { ...direct, name: "Android exhaustive smoke", avdName: "existing-smoke", deviceId: androidId },
            create_ios_simulator: { ...direct, name: "iOS smoke", deviceType: "missing", runtime: "missing" },
            create_windows_vm: { broker: true, hostCandidates: ["127.0.0.1"], brokerPort: 9, timeoutMs: 1, launchTimeoutMs: 1, name: "Windows VM smoke", dryRun: true },
            create_windows_sandbox: { ...direct, name: "Windows sandbox smoke", deviceId: windowsId },
            create_linux_vm: { ...direct, name: "Linux smoke", deviceId: linuxId },
            create_macos_vm: { ...direct, name: "macOS smoke", image: "missing-image", deviceId: macosId },
            attach: { ...direct, backend: "android-device", name: "Android attach smoke", serial: "SERIAL-SMOKE" },
            detach: { ...brokerProbe, broker: true, deviceId: "missing-detach-smoke" },
            delete: { ...brokerProbe, broker: true, deviceId: "missing-delete-smoke", confirmDestructive: true },
            start: { ...direct, deviceId: androidId, waitForBoot: false, bootTimeoutMs: 1 },
            stop: { ...direct, deviceId: androidId },
            status: { ...direct, deviceId: androidId },
            reboot: { deviceId: linuxId },
            exec: { ...direct, deviceId: androidId, command: "true", timeoutMs: 1 },
            screenshot: { ...direct, deviceId: androidId, timeoutMs: 1 },
            scroll: { ...direct, deviceId: windowsId, x: 1, y: 1, direction: "down", amount: 1, timeoutMs: 1 },
            cursor_position: { ...direct, deviceId: windowsId, timeoutMs: 1 },
            window_list: { ...direct, deviceId: windowsId, timeoutMs: 1 },
            ui: { ...direct, deviceId: windowsId, maxDepth: 1, maxNodes: 1, timeoutMs: 1 },
            snapshot: { action: "create", ...direct, deviceId: macosId, snapshotName: "smoke" },
            record_video: { action: "start", ...direct, deviceId: androidId, remotePath: "/sdcard/smoke.mp4", timeLimitSec: 1 },
            upload: { ...direct, deviceId: androidId, localPath: "/tmp/missing-smoke.txt", remotePath: "/sdcard/missing-smoke.txt", timeoutMs: 1 },
            download: { ...direct, deviceId: androidId, remotePath: "/sdcard/missing-smoke.txt", localPath: "/tmp/device-lab-smoke-download.txt", timeoutMs: 1 },
            reset: { ...direct, deviceId: iosId, confirmDestructive: true },
            install_app: { ...direct, deviceId: androidId, path: "/tmp/missing-smoke.apk" },
            launch_app: { ...direct, deviceId: androidId, appId: "com.example.smoke" },
            click: { ...direct, deviceId: androidId, x: 1, y: 1 },
            long_press: { ...direct, deviceId: androidId, x: 1, y: 1, durationMs: 1 },
            swipe: { ...direct, deviceId: androidId, x1: 1, y1: 1, x2: 2, y2: 2, durationMs: 1 },
            drag: { ...direct, deviceId: androidId, x1: 1, y1: 1, x2: 2, y2: 2, durationMs: 1 },
            type: { ...direct, deviceId: androidId, text: "smoke" },
            key: { ...direct, deviceId: androidId, keyCode: 4 },
            home: { ...direct, deviceId: androidId },
            back: { ...direct, deviceId: androidId },
            forward: { ...direct, deviceId: androidId },
            recents: { ...direct, deviceId: androidId },
            power: { ...direct, deviceId: androidId },
            lock: { ...direct, deviceId: androidId },
            unlock: { ...direct, deviceId: androidId },
            set_orientation: { ...direct, deviceId: androidId, orientation: "portrait" },
            open_url: { ...direct, deviceId: androidId, url: "https://example.invalid" },
            uninstall_app: { ...direct, deviceId: androidId, appId: "com.example.smoke", confirmDestructive: true },
            stop_app: { ...direct, deviceId: androidId, appId: "com.example.smoke" },
            clear_app_data: { ...direct, deviceId: androidId, appId: "com.example.smoke", confirmDestructive: true },
            permission: { action: "grant", ...direct, deviceId: androidId, appId: "com.example.smoke", permission: "android.permission.CAMERA" },
            set_location: { ...direct, deviceId: androidId, latitude: 1, longitude: 2 },
            set_battery: { ...direct, deviceId: androidId, level: 50, confirmDestructive: true },
            set_network: { ...direct, deviceId: androidId, wifi: true, confirmDestructive: true },
            clipboard: { ...direct, deviceId: androidId, text: "smoke" },
            wait_for_text: { ...direct, deviceId: androidId, text: "smoke", timeoutMs: 1, intervalMs: 50 },
            wait_for_app: { ...direct, deviceId: androidId, appId: "com.example.smoke", timeoutMs: 1, intervalMs: 50 },
            run_flow: { steps: [{ tool: "status", arguments: { ...direct, deviceId: androidId } }] },
        };

        samples.focus_window = { ...direct, deviceId: windowsId, handle: "123", timeoutMs: 1 };
        samples.move = { deviceId: "x11-current-display", x: 0, y: 0 };
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
                .filter((key) => !(key in properties) && !HIDDEN_LEGACY_TRANSPORT_KEYS.has(key)
                    && !(key === "backend" && Object.hasOwn(SINGLE_BACKEND_TOOL_DEFAULTS, tool.name)))
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
            name: "run_flow",
            arguments: {
                stopOnError: false,
                steps: toolNames
                    .filter((name) => DEVICE_FLOW_TOOL_NAMES.includes(name))
                    .map((name) => ({ tool: name, arguments: samples[name] })),
            },
        });
        expect(mobileFlow.isError).toBe(true);
        const mobileFlowPayload = JSON.parse(((mobileFlow.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            results: Array<{ tool?: string; error?: string }>;
        };
        expect(mobileFlowPayload.results).toHaveLength(toolNames.filter((name) => DEVICE_FLOW_TOOL_NAMES.includes(name)).length);
        expect(mobileFlowPayload.results.filter((result) => result.error?.includes("device_run_flow does not allow step tool"))).toEqual([]);

        const deviceFlowAllowedMobileTools = [
            "install_app", "launch_app",
            "status",
            "ui",
            "click",
            "long_press",
            "swipe",
            "drag",
            "type",
            "key",
            "home",
            "back",
            "forward",
            "recents",
            "power",
            "lock",
            "unlock",


            "set_orientation",
            "open_url",
            "clipboard",
            "clipboard",
            "wait_for_text",
            "wait_for_app",
            "screenshot",
            "uninstall_app", "stop_app", "clear_app_data",
            "permission", "permission", "set_location",
            "set_battery", "set_network", "set_network",
        ];
        const deviceMobileFlow = await client.callTool({
            name: "run_flow",
            arguments: {
                stopOnError: false,
                steps: deviceFlowAllowedMobileTools.map((name) => ({ tool: name, arguments: samples[name] })),
            },
        });
        expect(deviceMobileFlow.isError).toBe(true);
        const deviceMobileFlowPayload = JSON.parse(((deviceMobileFlow.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            results: Array<{ tool?: string; error?: string }>;
        };
        expect(deviceMobileFlowPayload.results).toHaveLength(deviceFlowAllowedMobileTools.length);
        expect(deviceMobileFlowPayload.results.filter((result) => result.error?.includes("device_run_flow does not allow step tool"))).toEqual([]);

        const deviceFlowBlockedMobileTools = toolNames
            .filter((name) => BROKER_CAPABLE_MOBILE_TOOLS.includes(name as typeof BROKER_CAPABLE_MOBILE_TOOLS[number]))
            .filter((name) => name !== "run_flow")
            .filter((name) => !deviceFlowAllowedMobileTools.includes(name));
        const blockedDeviceMobileFlow = await client.callTool({
            name: "run_flow",
            arguments: {
                stopOnError: false,
                steps: deviceFlowBlockedMobileTools.map((name) => ({ tool: name, arguments: samples[name] })),
            },
        });
        expect(blockedDeviceMobileFlow.isError).toBe(true);
        expect(deviceFlowBlockedMobileTools).toEqual([]);
        expect(((blockedDeviceMobileFlow.content as Array<{ text?: string }>)[0].text ?? ""))
            .toContain("requires at least one step");

        for (const deviceId of [androidId, iosId, windowsId, macosId, linuxId]) {
            await client.callTool({ name: "delete", arguments: { ...direct, deviceId, force: true, confirmDestructive: true } });
        }
    });

});
