import { regionInputError } from "./screenshot-region.mjs";
import { validateListFilesArgs } from "@ccc/device-lab/providers/file-listing.mjs";
import { createInputError, normalizeCreateArgs, CREATE_TOOL_BACKENDS } from "./creation-input.mjs";
import { TOOLS, SINGLE_BACKEND_TOOL_DEFAULTS, GROUP_OPERATIONS, DISCOVERY_OPERATIONS, toolOperation } from "./tools.mjs";
import { SINGLE_BACKEND_TOOL_DEFAULTS as OPERATION_DEFAULTS } from "./operation-tools.mjs";
import { sharedFlowTarget } from "@ccc/device-lab/providers/domain/device-flow.mjs";
import { iosExecInputError } from "@ccc/device-lab/providers/domain/ios-observation-access.mjs";

const DEVICE_TARGET_PROPERTIES = new Map(TOOLS
    .filter((tool) => tool.inputSchema?.required?.includes("deviceId"))
    .map((tool) => [tool.name, tool.inputSchema.properties]));

const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));
// Existing internal routing controls remain unadvertised, including fixture isolation.
const TRANSPORT_FIELDS = new Set(["broker", "viaBroker", "implicitBroker", "hostCandidates", "host", "port", "brokerPort", "autolaunch", "timeoutMs", "rpcTimeoutMs", "launchTimeoutMs", "launchHost", "probe"]);
const present = value => typeof value === "string" && value.trim().length > 0 && !value.includes("\0");

// Check the external shape before supplying internal provider defaults.
export function toolInputError(name, args = {}) {
    if (!TOOL_NAMES.has(name)) return `Unknown tool: ${name}`;
    if (!args || typeof args !== "object" || Array.isArray(args)) return "Tool arguments must be an object";
    if (Object.hasOwn(args, "helperTimeoutMs")) return "Use timeoutMs; helperTimeoutMs is an internal option";
    if (Object.hasOwn(args, "brokerProbeTimeoutMs")) return "brokerProbeTimeoutMs is an internal option";
    const schema = TOOLS.find(tool => tool.name === name).inputSchema;
    for (const [key, field] of Object.entries(schema.properties)) {
        if (field.type === "boolean" && Object.hasOwn(args, key) && typeof args[key] !== "boolean") {
            return `${name} ${key} must be a boolean`;
        }
    }
    const interval = schema.properties.intervalMs;
    if (interval && Object.hasOwn(args, "intervalMs") && (!Number.isFinite(args.intervalMs)
        || args.intervalMs < interval.minimum || args.intervalMs > interval.maximum)) return `intervalMs must be between ${interval.minimum} and ${interval.maximum}`;
    const timeout = schema.properties.timeoutMs;
    if (timeout && args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs < timeout.minimum || args.timeoutMs > timeout.maximum)) return `timeoutMs must be between ${timeout.minimum} and ${timeout.maximum}`;
    if (name === "reset" && ["appId", "packageName", "bundleId", "containerType", "eraseSimulator"].some(key => Object.hasOwn(args, key))) return "reset erases an iOS Simulator; use clear_app_data for an app";
    if (["packageName", "bundleId"].some(key => Object.hasOwn(args, key))) return "Use appId instead of packageName or bundleId";
    if (Object.hasOwn(args, "service")) return "Use permission instead of service";
    if (Object.hasOwn(args, "appId") && !schema.properties.appId) return `${name} does not support appId`;
    if (Object.hasOwn(args, "appId") && (!present(args.appId) || args.appId.length > 255)) return "appId must be a nonempty string of at most 255 characters without NUL";
    if (Object.hasOwn(args, "options")) return "Use flat tool arguments; options is not supported";
    if (Object.hasOwn(CREATE_TOOL_BACKENDS, name)) {
        if (Object.hasOwn(args, "backend")) return `${name} selects its backend automatically; omit backend`;
        const backend = CREATE_TOOL_BACKENDS[name];
        const error = createInputError({ ...args, backend });
        if (error) return error;
        if (args.dryRun === true && backend === "linux-vm" && args.provider !== "hyper-v") return "create_linux_vm dryRun requires provider:hyper-v; container QEMU does not support dryRun";
        return null;
    }
    if ((DEVICE_TARGET_PROPERTIES.has(name) || name === "run_flow") && Object.hasOwn(args, "backend")) {
        return "deviceId determines the backend; omit backend";
    }
    if (name === "exec") {
        const error = iosExecInputError(args);
        if (error) return error;
    }
    if (["devices", "set_network"].includes(name)) {
        const unknown = Object.keys(args).find(key => !Object.hasOwn(schema.properties, key) && !TRANSPORT_FIELDS.has(key));
        if (unknown) return `${name} does not support ${unknown}`;
    }
    if (name === "devices") {
        if (Object.hasOwn(args, "view") && (typeof args.view !== "string" || !Object.hasOwn(DISCOVERY_OPERATIONS, args.view))) return "devices view must be owned, available, or backends";
        if (Object.hasOwn(args, "backend") && !schema.properties.backend.enum.includes(args.backend)) return "devices backend is unsupported";
        if (args.view === "available" && args.backend === "x11-current-display") return "The current display has no available-device inventory; use devices view:owned or backends";
    }
    if (["devices", "set_network"].includes(name)) {
        for (const key of ["force", "detail"]) if (Object.hasOwn(args, key) && typeof args[key] !== "boolean") return `${name} ${key} must be a boolean`;
    }
    if (name === "click" && Object.hasOwn(args, "count") && (!Number.isInteger(args.count) || ![1, 2].includes(args.count))) return "click count must be 1 or 2";
    if (name === "launch_app") {
        if (Object.hasOwn(args, "appId") === Object.hasOwn(args, "component")) return "launch_app requires exactly one of appId or component";
        if (Object.hasOwn(args, "component") && !present(args.component)) return "launch_app component must be nonempty";
    }
    if (["uninstall_app", "stop_app", "clear_app_data", "wait_for_app"].includes(name) && !present(args.appId)) return `${name} requires appId`;
    if (Object.hasOwn(GROUP_OPERATIONS, name) && !toolOperation(name, args)) return `${name} requires action: ${Object.keys(GROUP_OPERATIONS[name]).join(", ")}`;
    if (["delete", "uninstall_app", "clear_app_data", "set_battery", "set_network", "reset"].includes(name)
        || (name === "snapshot" && ["restore", "delete"].includes(args.action))) {
        if (args.confirmDestructive !== true) return `${name} requires confirmDestructive:true`;
    }
    for (const key of ["keyCode", "port", "pairPort", "cpus", "memoryMb"]) {
        const field = schema.properties[key];
        if (field && Object.hasOwn(args, key) && (!Number.isInteger(args[key])
            || (field.minimum !== undefined && args[key] < field.minimum)
            || (field.maximum !== undefined && args[key] > field.maximum))) return `${name} ${key} must be an integer within the advertised bounds`;
    }
    if (["snapshot", "record_video"].includes(name)) {
        const branch = schema.oneOf.find(variant => variant.properties.action.const === args.action);
        const irrelevant = branch?.not?.anyOf?.flatMap(condition => condition.required).find(key => Object.hasOwn(args, key));
        if (irrelevant) return `${name} ${args.action} does not support ${irrelevant}`;
    }
    if (name === "attach") {
        if (!["android-device", "ios-device"].includes(args.backend)) return "attach requires backend:android-device or ios-device";
        if (args.connection !== undefined && !["usb", "wifi"].includes(args.connection)) return "attach connection must be usb or wifi";
        for (const key of ["serial", "udid", "host"]) if (Object.hasOwn(args, key) && !present(args[key])) return `attach ${key} must be nonempty`;
        if (args.backend === "ios-device" && !present(args.udid)) return "iOS attach requires udid";
        if (args.backend === "android-device") {
            if (args.connection === "wifi") {
                if (!present(args.host) && !present(args.serial)) return "Android Wi-Fi attach requires host or serial";
            } else if (!present(args.serial)) return "Android USB attach requires serial";
        }
    }
    if (name === "record_video" && args.action === "start" && Object.hasOwn(args, "timeLimitSec")
        && (!Number.isInteger(args.timeLimitSec) || args.timeLimitSec < 1 || args.timeLimitSec > 1800)) return "record_video timeLimitSec must be an integer from 1 to 1800";
    if (name === "wireless") {
        if (!["android-device", "ios-device"].includes(args.backend)) return "wireless requires backend:android-device or ios-device";
        const action = args.action ?? "status";
        if (!schema.properties.action.enum.includes(action)) return "wireless action must be status, usb-tcpip, pair, or connect";
        for (const key of ["serial", "host", "udid", "pairHost", "pairingCode"]) if (Object.hasOwn(args, key) && !present(args[key])) return `wireless ${key} must be nonempty`;
        if (Object.hasOwn(args, "connect") && typeof args.connect !== "boolean") return "wireless connect must be a boolean";
        if (args.backend === "ios-device") {
            if (action !== "status") return "iOS wireless supports only action:status";
            const irrelevant = ["serial", "host", "port", "pairHost", "pairPort", "pairingCode", "connect"].find(key => Object.hasOwn(args, key));
            if (irrelevant) return `iOS wireless does not support ${irrelevant}`;
        } else {
            if (Object.hasOwn(args, "udid")) return "Android wireless uses serial; omit udid";
            if (action === "usb-tcpip" && !present(args.serial)) return "wireless usb-tcpip requires serial";
            if (action === "pair" && (!present(args.pairHost) || !Number.isInteger(args.pairPort) || !present(args.pairingCode))) return "wireless pair requires pairHost, pairPort and pairingCode";
            if (action === "connect" && !present(args.host) && !present(args.serial)) return "wireless connect requires host or serial";
            if (args.connect === true && !present(args.host) && !(action === "pair" && present(args.serial))) return "wireless connect:true requires host (or serial with action:pair)";
        }
    }
    if (name === "snapshot") {
        if (args.action === "create" && !(typeof args.snapshotName === "string" && args.snapshotName.trim())) return "snapshot create requires snapshotName";
        if (["restore", "delete"].includes(args.action)) {
            if (Object.hasOwn(args, "snapshotName") === Object.hasOwn(args, "snapshotId")) return `snapshot ${args.action} requires exactly one of snapshotName or snapshotId`;
            if (!present(args.snapshotName ?? args.snapshotId)) return `snapshot ${args.action} selector must be nonempty`;
        }
    }
    if (name === "permission" && (!present(args.appId) || !present(args.permission))) return "permission requires appId and permission";
    if (name === "set_network") {
        for (const key of ["airplaneMode", "wifi", "data", "confirmDestructive"]) if (Object.hasOwn(args, key) && typeof args[key] !== "boolean") return `set_network ${key} must be a boolean`;
        if (!["airplaneMode", "wifi", "data"].some(key => Object.hasOwn(args, key))) return "set_network requires airplaneMode, wifi, or data";
    }
    if (name === "set_battery") {
        for (const [key, minimum, maximum] of [["level", 0, 100], ["status", 1, 5]]) {
            if (Object.hasOwn(args, key) && (!Number.isInteger(args[key]) || args[key] < minimum || args[key] > maximum)) return `set_battery ${key} must be an integer from ${minimum} to ${maximum}`;
        }
        if (Object.hasOwn(args, "charging") && typeof args.charging !== "boolean") return "set_battery charging must be a boolean";
    }
    if (name === "set_battery" && !["level", "charging", "status"].some(key => Object.hasOwn(args, key))) return "set_battery requires level, charging, or status";
    if (name === "clipboard" && Object.hasOwn(args, "text") && typeof args.text !== "string") return "clipboard text must be a string";
    if (name === "list_files") {
        const error = validateListFilesArgs({ ...args, ...(Object.hasOwn(args, "appId") ? { bundleId: args.appId } : {}) })?.replace(/bundleId/g, "appId");
        if (error) return error;
    }
    if (name === "key" && Object.hasOwn(args, "key") === Object.hasOwn(args, "keyCode")) return "key requires exactly one of key or keyCode";
    if (name === "key" && !(typeof args.key === "string" && args.key.length > 0)
        && !(Number.isInteger(args.keyCode) && args.keyCode >= 0)) return "key requires key or keyCode";
    if (name === "screenshot" && Object.hasOwn(args, "region")) { const error = regionInputError(args.region); if (error) return error; }
    if (name === "focus_window" && (typeof args.handle !== "string" || args.handle.length > 2048 || !((/^[1-9][0-9]{0,15}$/.test(args.handle) && Number.isSafeInteger(Number(args.handle))) || /^macos:[1-9][0-9]{0,9}:[1-9][0-9]{0,15}:.+$/.test(args.handle)))) return "focus_window requires a handle from window_list";
    if (name === "drag") {
        if (["x1", "y1", "x2", "y2"].some(key => !Number.isSafeInteger(args[key]) || args[key] < 0)) return "drag requires nonnegative integer x1, y1, x2 and y2";
        if (args.durationMs !== undefined && (!Number.isInteger(args.durationMs) || args.durationMs < 1 || args.durationMs > 10000)) return "drag durationMs must be an integer from 1 to 10000";
    }
    if (name === "move" && (!Number.isInteger(args.x) || args.x < 0 || !Number.isInteger(args.y) || args.y < 0)) return "move requires nonnegative integer x and y";
    if (name === "cursor_position" && (Object.hasOwn(args, "x") || Object.hasOwn(args, "y"))) return "Use move to change cursor position";
    if (Object.hasOwn(SINGLE_BACKEND_TOOL_DEFAULTS, name) && Object.hasOwn(args, "backend")) {
        return `${name} selects its backend automatically; omit backend`;
    }
    const unknown = Object.keys(args).find(key => !Object.hasOwn(schema.properties, key) && !TRANSPORT_FIELDS.has(key));
    if (unknown) return `${name} does not support ${unknown}`;
    return null;
}

// Public translation happens once; provider/internal calls retain their own contract.
export function normalizePublicToolArgs(name, args = {}) {
    let normalized = normalizeToolArgs(args, toolOperation(name, args));
    if (Object.hasOwn(CREATE_TOOL_BACKENDS, name)) return normalizeCreateArgs({ ...normalized, backend: CREATE_TOOL_BACKENDS[name] });
    if (name === "click") delete normalized.count;
    if (name === "reset") normalized.eraseSimulator = true;
    if (name === "start") normalized.waitForBoot ??= true;
    const schema = TOOLS.find(tool => tool.name === name)?.inputSchema;
    if (schema?.properties.appId && Object.hasOwn(args, "appId")) {
        normalized.packageName = args.appId;
        normalized.bundleId = args.appId;
        delete normalized.appId;
    }
    if (name === "permission") normalized.service = normalized.permission;
    if (name === "devices") delete normalized.view;
    // A public operation deadline must not shorten broker discovery or identity checks.
    if (schema?.properties.timeoutMs && args.timeoutMs !== undefined) normalized.brokerProbeTimeoutMs = 1000;
    if (schema?.properties.timeoutMs && args.timeoutMs !== undefined
        && !["wait_for_text", "wait_for_app", "wireless"].includes(name)) {
        normalized.helperTimeoutMs = name === "exec" ? Number(args.timeoutMs) : Math.min(Number(args.timeoutMs), 300000);
        normalized.rpcTimeoutMs ??= Math.min(Number(args.timeoutMs) + 30000, 630000);
    }
    return normalized;
}

export function normalizeToolArgs(args = {}, toolName) {
    if (!args || typeof args !== "object" || Array.isArray(args)) args = {};
    const { detail: _detail, incarnationId: _incarnationId, ...normalized } = args;
    if (Object.values(GROUP_OPERATIONS).some((group) => Object.values(group).includes(toolName))) delete normalized.action;
    if (normalized.backend === undefined && Object.hasOwn(OPERATION_DEFAULTS, toolName)) {
        normalized.backend = OPERATION_DEFAULTS[toolName];
    }
    return normalized;
}

// The runtime and real-provider verifier must interpret shared targets identically.
export function flowStepArguments(tool, rawFlowArgs, rawStepArgs) {
    const args = normalizeToolArgs(rawFlowArgs);
    const stepArgs = { ...normalizeToolArgs(rawStepArgs), ...(Object.hasOwn(rawStepArgs || {}, "action") ? { action: rawStepArgs.action } : {}) };
    const sharedTarget = sharedFlowTarget(args, stepArgs, DEVICE_TARGET_PROPERTIES.get(tool));
    return { ...sharedTarget, ...stepArgs };
}
