import { TOOLS as OPERATIONS, DEVICE_FLOW_TOOL_NAMES as FLOW_OPERATIONS, SINGLE_BACKEND_TOOL_DEFAULTS as DEFAULTS } from "./operation-tools.mjs";
import { createInputSchema, CREATE_TOOL_BACKENDS, createToolName } from "./creation-input.mjs";
export { CREATE_TOOL_BACKENDS, createToolName } from "./creation-input.mjs";

// Provider operation identities are private. MCP accepts only this action catalog.
const merged = {
    mobile_tap: "click", mobile_double_tap: "click", device_double_click: "click",
    mobile_type_text: "type", mobile_key: "key",
    mobile_rotate_left: "set_orientation", mobile_rotate_right: "set_orientation",
    device_list: "devices", device_inventory: "devices", device_backends: "devices", mobile_session_status: "status",
    device_broker_status: "devices", device_target_list: "status", device_readiness_probe: "status", device_guest_agent_status: "status",
    device_image_list: "list_images", device_image_import: "import_image",
    device_base_image_create: "create_macos_vm", device_base_image_clone: "create_macos_vm",
    device_snapshot_list: "snapshot", device_snapshot_create: "snapshot", device_snapshot_restore: "snapshot", device_snapshot_delete: "snapshot",
    device_record_video_start: "record_video", device_record_video_stop: "record_video", device_record_video_status: "record_video",
    mobile_grant_permission: "permission", mobile_revoke_permission: "permission",
    mobile_get_clipboard: "clipboard", mobile_set_clipboard: "clipboard",
    mobile_dump_ui: "ui", device_accessibility_snapshot: "ui",
};
export function publicToolName(operation, backend) {
    if (typeof operation !== "string") return operation;
    if (operation === "device_create" && typeof backend === "string") return createToolName(backend);
    if (operation === "display_current") return "status";
    if (operation === "display_double_click") return "click";
    if (operation.startsWith("display_")) return operation.slice(8);
    return Object.hasOwn(merged, operation) ? merged[operation] : operation.replace(/^(device|mobile)_/, "");
}

const omitted = new Set(["device_double_click", "device_base_image_clone", "device_broker_status", "device_backends", "device_inventory", "device_base_image_create", "mobile_toggle_airplane_mode", "device_disk_materialize", "device_session_open", "device_guest_agent_provision", "device_target_list", "device_readiness_probe", "device_guest_agent_status", "mobile_session_status", "device_snapshot_create", "device_snapshot_restore", "device_snapshot_delete", "device_record_video_start", "device_record_video_stop", "mobile_revoke_permission", "mobile_set_clipboard", "mobile_dump_ui"]);
export const DISCOVERY_OPERATIONS = Object.freeze({ owned: "device_list", available: "device_inventory", backends: "device_backends" });
export const GROUP_OPERATIONS = Object.freeze({
    snapshot: { list: "device_snapshot_list", create: "device_snapshot_create", restore: "device_snapshot_restore", delete: "device_snapshot_delete" },
    record_video: { start: "device_record_video_start", stop: "device_record_video_stop", status: "device_record_video_status" },
    permission: { grant: "mobile_grant_permission", revoke: "mobile_revoke_permission" },
});
const selected = OPERATIONS.filter(({ name }) => !name.startsWith("display_") && !omitted.has(name)
    && !["device_create", "device_workspace_sync", "device_artifacts_export"].includes(name)
    && !["mobile_tap", "mobile_double_tap", "mobile_type_text", "mobile_key"].includes(name));
const operationByName = new Map(selected.map(({ name }) => [publicToolName(name), name]));
operationByName.set("drag", "device_drag");
operationByName.set("move", "device_cursor_position");
for (const name of Object.keys(CREATE_TOOL_BACKENDS)) operationByName.set(name, "device_create");
export function toolOperation(name, args = {}) {
    if (name === "click") return args?.count === 2 ? "device_double_click" : "device_click";
    if (name === "create_macos_vm" && Object.hasOwn(args || {}, "sourceDeviceId")) return "device_base_image_clone";
    if (name === "devices") return DISCOVERY_OPERATIONS[args?.view ?? "owned"];
    if (Object.hasOwn(GROUP_OPERATIONS, name)) return typeof args?.action === "string" && Object.hasOwn(GROUP_OPERATIONS[name], args.action) ? GROUP_OPERATIONS[name][args.action] : undefined;
    if (name === "clipboard") return Object.hasOwn(args || {}, "text") ? "mobile_set_clipboard" : "mobile_get_clipboard";
    return operationByName.get(name);
}
export function flowOperationAllowed(name, args = {}) { return name === "devices" ? Boolean(toolOperation(name, args)) : FLOW_OPERATIONS.includes(toolOperation(name, args)); }
export function isSimpleAction(name, operation) { return SIMPLE_ACTIONS.has(name) || (name === "clipboard" && operation === "mobile_set_clipboard"); }
export const SINGLE_BACKEND_TOOL_DEFAULTS = Object.freeze(Object.fromEntries(
    Object.entries(DEFAULTS).filter(([name]) => selected.some((tool) => tool.name === name)).map(([name, backend]) => [publicToolName(name), backend])));
export const DEVICE_FLOW_TOOL_NAMES = [...new Set(FLOW_OPERATIONS
    .filter((name) => !name.startsWith("display_"))
    .map(publicToolName).filter((name) => operationByName.has(name))), "move"];

const mobileKey = OPERATIONS.find(({ name }) => name === "mobile_key").inputSchema;
const renameReferences = (text) => text.replace(/\b(?:device|mobile|display)_[a-z_]+\b/g, publicToolName).replace(/\b(?:packageName|bundleId)\b/g, "appId");
export const TOOLS = selected.map((operation) => {
    const tool = structuredClone(operation);
    tool.name = publicToolName(operation.name);
    tool.description = renameReferences(tool.description);
    const schema = tool.inputSchema;
    const group = GROUP_OPERATIONS[tool.name];
    if (group) {
        const variants = Object.entries(group).map(([action, name]) => {
            const original = OPERATIONS.find((entry) => entry.name === name).inputSchema;
            Object.assign(schema.properties, structuredClone(original.properties));
            return { properties: { action: { const: action } }, required: [...new Set(["action", ...original.required])], ...(original.anyOf ? { anyOf: structuredClone(original.anyOf) } : {}),
                not: { anyOf: Object.values(group).flatMap((other) => Object.keys(OPERATIONS.find(entry => entry.name === other).inputSchema.properties))
                    .filter((key, index, keys) => keys.indexOf(key) === index && !Object.hasOwn(original.properties, key))
                    .map(key => ({ required: [key] })) } };
        });
        for (const variant of variants) if (!variant.not.anyOf.length) delete variant.not;
        schema.properties.action = { type: "string", enum: Object.keys(group) };
        schema.required = ["deviceId", "action"];
        delete schema.anyOf;
        schema.oneOf = variants;
        tool.description = `${tool.name}: ${Object.keys(group).join(", ")}. Select an explicit action for this device.`;
    }
    if (tool.name === "snapshot") {
        tool.description += " List supports Hyper-V and container QEMU; macOS VM supports create/restore/delete. List takes no selectors; create requires snapshotName; restore/delete require exactly one of snapshotName or snapshotId and confirmDestructive:true. force is available only for create/restore.";
        for (const variant of schema.oneOf) {
            const action = variant.properties.action.const;
            if (["restore", "delete"].includes(action)) {
                delete variant.anyOf;
                variant.oneOf = [{ required: ["snapshotName"] }, { required: ["snapshotId"] }];
                variant.required.push("confirmDestructive");
                variant.properties.confirmDestructive = { const: true };
            }
        }
        schema.properties.snapshotName.minLength = 1;
        schema.properties.snapshotId.minLength = 1;
    }
    if (tool.name === "attach") {
        tool.description = "Attach a physical device to this owner. iOS requires udid from devices view:available. Android defaults to USB and requires serial; connection:wifi requires host or a network serial (host:port). port defaults to 5555 for Android Wi-Fi.";
        for (const key of ["serial", "udid", "host"]) schema.properties[key].minLength = 1;
        schema.properties.serial.description = "Android adb serial from available inventory; Wi-Fi may use host:port.";
        schema.properties.udid.description = "Physical iOS device UDID from available inventory.";
        schema.properties.host.description = "Android Wi-Fi debugging host; supply host or network serial.";
        schema.allOf = [
            { if: { properties: { backend: { const: "ios-device" } }, required: ["backend"] }, then: { required: ["udid"] } },
            { if: { properties: { backend: { const: "android-device" } }, required: ["backend"] }, then: { if: { properties: { connection: { const: "wifi" } }, required: ["connection"] }, then: { anyOf: [{ required: ["host"] }, { required: ["serial"] }] }, else: { required: ["serial"] } } },
        ];
    }
    if (tool.name === "record_video") tool.description = "Record device video: start accepts remotePath, localPath and timeLimitSec; stop accepts only localPath; status accepts no recording paths or time limit. timeLimitSec is whole seconds 1..1800: Android integer 1..180 (default 180); iOS Simulator ignores it and records until stop; Windows Sandbox and macOS VM use a supplied limit, otherwise record until stop. Supported on Android emulator/device, iOS Simulator, Windows Sandbox and macOS VM; output paths vary by backend.";
    if (tool.name === "clipboard") {
        schema.properties.text = { type: "string", description: "Set clipboard when present, including an empty string. Omit to read." };
        tool.description = "Read the mobile clipboard, or write it when text is provided. Physical iOS requires broker Appium; desktop is unsupported.";
    }
    if (tool.name === "ui") tool.description = "Inspect mobile UI hierarchy or desktop accessibility for this device.";
    if (tool.name === "click") {
        schema.properties.count = { type: "integer", enum: [1, 2], description: "Clicks: 1 (default) or 2 for double-click/double-tap." };
        tool.description = "Click or tap at screenshot x,y. count:2 double-clicks/double-taps. Mobile supports only the left button.";
    }
    if (tool.name === "screenshot") {
        schema.properties.region = { type: "object", additionalProperties: false, properties: {
            x: { type: "integer", minimum: 0 }, y: { type: "integer", minimum: 0 },
            width: { type: "integer", minimum: 1 }, height: { type: "integer", minimum: 1 },
        }, required: ["x", "y", "width", "height"] };
        tool.description += " Optional region crops without resizing; input coordinates remain relative to the full screenshot. Returns crop origin and full dimensions. Region supports PNG only.";
    }
    if (tool.name === "drag") {
        schema.properties.timeoutMs = { type: "number", minimum: 1, maximum: 300000 };
        for (const key of ["x1", "y1", "x2", "y2"]) schema.properties[key] = { type: "integer", minimum: 0 };
        schema.properties.durationMs = { type: "integer", minimum: 1, maximum: 10000 };
        tool.description = "Drag from x1,y1 to x2,y2 in full screenshot pixels. Desktop uses the left button; mobile uses touch. durationMs defaults to 700. Supports mobile, X11, Sandbox, macOS and Hyper-V desktops.";
    }
    if (tool.name === "type") tool.description = "Type text into the focused device. Windows VM console typing supports ASCII only.";
    if (tool.name === "key") {
        schema.properties.key.minLength = 1;
        schema.properties.key.description = "Desktop key or combination (Enter, Ctrl+C); Android ADB key name (KEYCODE_HOME); iOS Appium key value.";
        schema.properties.keyCode = mobileKey.properties.keyCode;
        schema.required = ["deviceId"];
        delete schema.anyOf;
        schema.oneOf = [{ required: ["key"] }, { required: ["keyCode"] }];
        schema.properties.keyCode.minimum = 0;
        tool.description = "Send a key or combination. Desktop: Enter, Ctrl+C, Alt+Tab. Android also accepts numeric keyCode. Unsupported keys fail.";
    }
    if (tool.name === "cursor_position") {
        delete schema.properties.x;
        delete schema.properties.y;
        tool.description = "Read the device cursor position. Use move to move it.";
    }
    if (tool.name === "run_flow") {
        schema.properties.steps.items.properties.tool.enum = DEVICE_FLOW_TOOL_NAMES;
        tool.description = renameReferences(operation.description).replace(/backend,?\s*/g, "") + " Recording supports only status in flows. For efficient observation, finish an action sequence with a screenshot step; images are returned only when requested.";
        schema.properties.deviceId.description = "Device ID inherited by steps that omit it. Each step resolves ownership independently.";
    }
    if (["back", "forward", "recents", "power"].includes(tool.name)) tool.description += " Android only (emulator or physical device).";
    if (tool.name === "set_battery") tool.description = "Set simulated Android emulator battery state; requires confirmDestructive:true and at least one of level (integer percent 0..100), charging, or status (integer 1..5). Physical phones and other backends are unsupported.";
    if (tool.name === "window_list") tool.description = "List visible named windows on Windows Sandbox, macOS VM, Hyper-V Windows/Linux VM, or the current X11 display. Requires an active desktop; Windows Hyper-V requires the guest credential user at the console and timeoutMs >= 30000 (default). Mobile and container-QEMU are unsupported.";
    if (tool.name === "wireless") {
        tool.description = "Inspect physical-device wireless debugging (action defaults to status). iOS supports only status, optionally filtered by udid. Android usb-tcpip requires serial; pair requires pairHost, pairPort and pairingCode; connect requires host or a network serial. Supplying host/serial to pair also connects. Android port defaults to 5555; connect:true requires a connection target.";
        schema.allOf = [
            { if: { properties: { backend: { const: "ios-device" } }, required: ["backend"] }, then: { properties: { action: { const: "status" } }, not: { anyOf: ["serial", "host", "port", "pairHost", "pairPort", "pairingCode", "connect"].map(key => ({ required: [key] })) } } },
            { if: { properties: { backend: { const: "android-device" } }, required: ["backend"] }, then: { not: { required: ["udid"] } } },
            { if: { properties: { action: { const: "usb-tcpip" } }, required: ["action"] }, then: { required: ["serial"] } },
            { if: { properties: { action: { const: "pair" } }, required: ["action"] }, then: { required: ["pairHost", "pairPort", "pairingCode"] } },
            { if: { properties: { action: { const: "connect" } }, required: ["action"] }, then: { anyOf: [{ required: ["host"] }, { required: ["serial"] }] } },
            { if: { properties: { connect: { const: true } }, required: ["connect"] }, then: { anyOf: [{ required: ["host"] }, { properties: { action: { const: "pair" } }, required: ["action", "serial"] }] } },
        ];
    }
    if (schema.properties.durationMs) schema.properties.durationMs.description = `Gesture duration in milliseconds; defaults to ${tool.name === "swipe" ? 300 : 700}.`;
    if (schema.properties.amount) schema.properties.amount.description = "Scroll step count; defaults to 1.";
    if (schema.properties.latitude) schema.properties.latitude.description = "Latitude in degrees.";
    if (schema.properties.longitude) schema.properties.longitude.description = "Longitude in degrees.";
    if (schema.properties.altitude) schema.properties.altitude.description = "Altitude in meters; backend default when omitted.";
    if (tool.name === "status") tool.description = "Read device state and read-only automation diagnostics. Running container QEMU devices include live readiness; stopped devices do not run guest probes. Appium is optional and is not started by status.";
    if (tool.name === "devices") {
        tool.description = "Find owned device IDs (default), available candidates across backends, or backend readiness. backend optionally filters the results. Select view:owned, available, or backends.";
        schema.properties = {
            view: { type: "string", enum: Object.keys(DISCOVERY_OPERATIONS), description: "Defaults to owned. Available discovers all backends when backend is omitted." },
            backend: structuredClone(OPERATIONS.find(({ name }) => name === "device_inventory").inputSchema.properties.backend),
            detail: { type: "boolean" },
        };
        schema.properties.backend.enum.push("x11-current-display");
        schema.required = [];
        schema.additionalProperties = false;
        schema.allOf = [{ if: { properties: { view: { const: "available" } }, required: ["view"] }, then: { properties: { backend: { not: { const: "x11-current-display" } } } } }];
    }
    if (tool.name === "list_images") tool.description = "List owner-scoped container QEMU disk image records. These are not macOS VM clones or Hyper-V images.";
    if (tool.name === "import_image") tool.description = "Import or register a disk image for container QEMU. sourcePath is a project file; copy selects whether to copy it into managed storage.";
    if (tool.name === "set_network") {
        schema.properties.airplaneMode = { type: "boolean" };
        schema.anyOf = ["airplaneMode", "wifi", "data"].map(key => ({ required: [key] }));
        tool.description = "Set Android emulator airplaneMode, wifi or data; provide at least one. Airplane mode is applied first, then explicit wifi/data settings. Requires confirmDestructive:true.";
    }
    if (tool.name === "reset") {
        schema.properties = Object.fromEntries(Object.entries(schema.properties).filter(([key]) => ["deviceId", "confirmDestructive", "detail"].includes(key)));
        delete schema.anyOf;
        tool.description = "Erase an owned iOS Simulator completely. Requires confirmDestructive:true. To clear only one app, use clear_app_data.";
    }
    if (schema.properties.packageName || schema.properties.bundleId) {
        schema.properties.appId = { type: "string", minLength: 1, maxLength: 255, description: "Application ID: Android package or iOS bundle identifier." };
        delete schema.properties.packageName;
        delete schema.properties.bundleId;
        delete schema.anyOf;
        if (tool.name === "launch_app") schema.oneOf = [{ required: ["appId"] }, { required: ["component"] }];
        if (["uninstall_app", "stop_app", "clear_app_data", "wait_for_app"].includes(tool.name)) schema.required.push("appId");
        if (tool.name === "permission") {
            delete schema.properties.service;
            schema.properties.permission = { type: "string", minLength: 1, description: "Android permission or iOS Simulator privacy service." };
            schema.required.push("appId", "permission");
            // Grant/revoke now have identical appId/permission requirements.
            delete schema.oneOf;
        }
    }
    for (const property of Object.values(schema.properties)) if (property.description) property.description = renameReferences(property.description);
    return tool;
});
const creationDescriptions = {
    "android-emulator": "Create an Android emulator using an installed systemImage, or reuse an avdName. Then start to boot.",
    "ios-simulator": "Create an iOS Simulator from deviceType and runtime, or reuse a udid. Then start to boot.",
    "windows-vm": "Create a Hyper-V Windows VM, then start to boot.",
    "windows-sandbox": "Create a Windows Sandbox configuration, then start to launch it.",
    "linux-vm": "Create a Linux VM with Hyper-V or container QEMU, then start to boot. container-qemu requires exactly one of baseImageId or sourceImage and does not support dryRun:true. Hyper-V excludes ssh/agent; dryRun:true requires explicit provider:hyper-v.",
    "macos-vm": "Create a macOS VM from image, or clone an owned sourceDeviceId. Then start to boot. Source cloning inherits provider/CPU/memory; force:true stops the source first.",
};
for (const [name, backend] of Object.entries(CREATE_TOOL_BACKENDS)) {
    TOOLS.push({ name, description: creationDescriptions[backend], inputSchema: createInputSchema(OPERATIONS.find(t => t.name === "device_create").inputSchema, backend) });
}
const move = structuredClone(TOOLS.find(({ name }) => name === "cursor_position"));
move.name = "move";
move.description = "Move the cursor to full screenshot x,y on X11, Windows Sandbox, macOS VM or Hyper-V Windows/Linux VM. Mobile and container QEMU are unsupported.";
move.inputSchema.properties.x = { type: "integer", minimum: 0 };
move.inputSchema.properties.y = { type: "integer", minimum: 0 };
move.inputSchema.required = ["deviceId", "x", "y"];
TOOLS.push(move);

// Existing devices carry their provider identity; callers never select it again.
for (const tool of TOOLS) {
    tool.inputSchema.additionalProperties = false;
    if (["delete", "uninstall_app", "clear_app_data", "set_battery", "set_network", "reset"].includes(tool.name)) {
        tool.inputSchema.required.push("confirmDestructive");
        tool.inputSchema.properties.confirmDestructive.const = true;
    }
    if (tool.inputSchema.properties.detail) tool.inputSchema.properties.detail.description = "Include diagnostics.";
    if (tool.inputSchema.properties.helperTimeoutMs) {
        tool.inputSchema.properties.timeoutMs ||= { ...tool.inputSchema.properties.helperTimeoutMs, description: "Timeout (ms); default is automatic." };
        delete tool.inputSchema.properties.helperTimeoutMs;
        for (const variant of tool.inputSchema.oneOf || []) if (variant.not?.anyOf) {
            for (const condition of variant.not.anyOf) condition.required = condition.required.map(key => key === "helperTimeoutMs" ? "timeoutMs" : key);
        }
    }
    if (tool.inputSchema.required?.includes("deviceId") || tool.name === "run_flow") {
        delete tool.inputSchema.properties.backend;
        tool.inputSchema.required = tool.inputSchema.required?.filter((key) => key !== "backend");
    }
}

export const SIMPLE_ACTIONS = new Set([
    "click", "move", "focus_window", "type", "key", "scroll", "long_press", "swipe", "drag",
    "home", "back", "forward", "recents", "power", "lock", "unlock", "set_orientation",
    "open_url", "set_location", "set_battery", "set_network",
]);
