/** @typedef {{[key: string]: unknown, backend?: string, deviceId?: string, name?: string, provider?: string, button?: string, key?: string, packageName?: string, bundleId?: string, component?: string, orientation?: string, text?: string, path?: string, url?: string, launchHost?: string, automationName?: string, incarnationId?: string, command?: string, action?: string, tool?: string, method?: string, x?: number, y?: number, x1?: number, y1?: number, x2?: number, y2?: number, keyCode?: number, latitude?: number, longitude?: number, altitude?: number, durationMs?: number, timeoutMs?: number, rpcTimeoutMs?: number, helperTimeoutMs?: number, bootTimeoutMs?: number, intervalMs?: number, port?: number, brokerPort?: number, devicePort?: number, appiumPort?: number, serverPort?: number, launchTimeoutMs?: number, limit?: number, broker?: boolean, viaBroker?: boolean, implicitBroker?: boolean, autolaunch?: boolean, physical?: boolean, createAvd?: boolean, deleteAvd?: boolean, deleteSimulator?: boolean, waitForBoot?: boolean, dryRun?: boolean, force?: boolean, enabled?: boolean, preserveNetwork?: boolean, detail?: boolean, confirmDestructive?: boolean, hostCandidates?: string[], region?: unknown}} DeviceArguments */
export const BROKER_LIFECYCLE_COMMANDS = new Set(["device_create", "device_status", "device_start", "device_stop", "device_reboot", "device_delete"]);

export const HYPER_V_LIFECYCLE_BACKENDS = new Set(["windows-vm", "linux-vm"]);

export const BROKER_READONLY_DEVICE_TOOLS = new Set([
    "device_list_files",
    "device_inventory",
    "device_snapshot_list",
    "device_record_video_status",
    "device_screenshot",
    "device_window_list",
    "device_accessibility_snapshot",
]);

export const BROKER_MUTATING_DEVICE_TOOLS = new Set([
    "device_wireless",
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
    "device_cursor_position",
    "device_drag",
    "device_focus_window",
    "device_snapshot_create",
    "device_snapshot_restore",
    "device_snapshot_delete",
]);

export const BROKER_PHYSICAL_TOOLS = new Set(["device_attach", "device_detach"]);

export const BROKER_PHYSICAL_BACKENDS = new Set(["android-device", "ios-device"]);

export const BROKER_FAST_DEVICE_TOOLS = new Set(["device_record_video_status"]);

export const BROKER_RECORDING_DEVICE_TOOLS = new Set(["device_record_video_start", "device_record_video_stop", "device_record_video_status"]);

export const DEFAULT_BROKER_DEVICE_TOOL_TIMEOUT_MS = 30000;

export const DEFAULT_BROKER_DISCOVERY_RPC_TIMEOUT_MS = 30000;

export const HYPER_V_LINUX_GUI_TIMEOUT_MS = 17 * 60 * 1000;

export const DEFAULT_BROKER_LIFECYCLE_RPC_TIMEOUT_MS = 120000;

export const HYPER_V_IMAGE_ACQUIRE_RPC_TIMEOUT_MS = 21600000;

export const HYPER_V_LIFECYCLE_RPC_BUFFER_MS = 15000;

export const HYPER_V_CLEANUP_RESERVE_MS = 5 * 60 * 1000;

export const HYPER_V_CREATE_RPC_TIMEOUT_MS = HYPER_V_IMAGE_ACQUIRE_RPC_TIMEOUT_MS + HYPER_V_LIFECYCLE_RPC_BUFFER_MS;

export const HYPER_V_HOST_LOCK_WAIT_MS = 10 * 60 * 1000;

export const HYPER_V_PROVIDER_LIFECYCLE_TIMEOUT_MS = 120000;

export const HYPER_V_MAX_BOOT_TIMEOUT_MS = 20 * 60 * 1000;

export const DEFAULT_BROKER_PHYSICAL_RPC_TIMEOUT_MS = 30000;

export const MAX_DEVICE_HELPER_TIMEOUT_MS = 300000;

export const MAX_DEVICE_OPERATION_TIMEOUT_MS = 600000;

export const BROKER_DEVICE_TOOL_RPC_BUFFER_MS = 30000;

export const MAX_DEVICE_TOOL_RPC_TIMEOUT_MS = MAX_DEVICE_OPERATION_TIMEOUT_MS + BROKER_DEVICE_TOOL_RPC_BUFFER_MS;

export const BROKER_BOUNDED_WAIT_TOOLS = new Set(["mobile_wait_for_text", "mobile_wait_for_app"]);

export const DIRECT_DEVICE_BACKEND_HINT_TOOLS = new Set([
    "device_list_files",
    ...BROKER_LIFECYCLE_COMMANDS,
    "device_exec",
    "device_screenshot",
    "device_click",
    "device_double_click",
    "device_key",
    "device_type",
    "device_scroll",
    "device_cursor_position",
    "device_drag",
    "device_focus_window",
    "device_upload",
    "device_download",
    "device_reset",
    "device_install_app",
    "device_launch_app",
    "device_record_video_status",
    "device_record_video_start",
    "device_record_video_stop",
    "device_snapshot_list",
    "device_snapshot_create",
    "device_snapshot_restore",
    "device_snapshot_delete",
]);

export const CURRENT_DISPLAY_DEVICE_ID = "x11-current-display";

export const MOBILE_COMMON_OPERATIONS = new Map([
    ["device_drag", "mobile_drag"],
    ["device_click", "mobile_tap"], ["device_double_click", "mobile_double_tap"],
    ["device_accessibility_snapshot", "mobile_dump_ui"], ["device_type", "mobile_type_text"], ["device_key", "mobile_key"],
]);

/** @param {string} name @param {string|undefined} backend @param {DeviceArguments} args */
export function commonOperation(name, backend, args) {
    if (!(backend !== undefined && ["android-emulator", "android-device", "ios-simulator", "ios-device"].includes(backend))) {
        if (name === "device_key" && args.keyCode !== undefined) return { name, error: "keyCode is supported only on Android; use key on this device" };
        return { name };
    }
    if ((name === "device_click" || name === "device_double_click") && args.button !== undefined && args.button !== "left") return { name, error: "Mobile click supports only the left button" };
    if (name === "device_key" && backend.startsWith("ios") && args.keyCode !== undefined) return { name, error: "keyCode is supported only on Android; use key on iOS" };
    return { name: MOBILE_COMMON_OPERATIONS.get(name) || name };
}

export const DISPLAY_DEVICE_TOOL_MAP = new Map([
    ["device_drag", "display_drag"],
    ["device_focus_window", "display_focus_window"],
    ["device_window_list", "display_window_list"],
    ["device_screenshot", "display_screenshot"],
    ["device_click", "display_click"],
    ["device_double_click", "display_double_click"],
    ["device_key", "display_key"],
    ["device_type", "display_type"],
    ["device_scroll", "display_scroll"],
    ["device_cursor_position", "display_cursor_position"],
]);

export const LIFECYCLE_STATE_BACKENDS = new Map([
    ["android", "android-emulator"],
    ["android-device", "android-device"],
    ["ios", "ios-simulator"],
    ["ios-device", "ios-device"],
    ["windows", "windows-sandbox"],
    ["windows-vm", "windows-vm"],
    ["linux-vm", "linux-vm"],
    ["macos", "macos-vm"],
]);

export const BROKER_MOBILE_ACTIONS = new Set([
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
]);

export const BROKER_BACKEND_MOBILE_TOOLS = new Set([
    "mobile_set_network",
    "mobile_clear_app_data",
    "mobile_grant_permission",
    "mobile_revoke_permission",
    "mobile_set_battery",
]);

export const BROKER_APPIUM_ROUTED_MOBILE_TOOLS = new Set(["mobile_session_status", "mobile_set_clipboard", "mobile_get_clipboard"]);

export const DEFAULT_BROKER_APPIUM_RPC_TIMEOUT_MS = 315000;

/** @param {string} name @param {DeviceArguments} args */
export function wantsBrokerLifecycle(name, args) {
    return BROKER_LIFECYCLE_COMMANDS.has(name) && (args?.broker === true || args?.viaBroker === true || args?.autolaunch === true);
}

/** @param {string} name @param {DeviceArguments} args */
export function wantsBrokerDeviceTool(name, args) {
    return (BROKER_READONLY_DEVICE_TOOLS.has(name) || BROKER_MUTATING_DEVICE_TOOLS.has(name))
        && (args?.broker === true || args?.viaBroker === true || args?.autolaunch === true);
}

/** @param {DeviceArguments} args */
export function optsOutOfImplicitBroker(args) {
    const explicitBroker = args?.broker === true || args?.viaBroker === true || args?.autolaunch === true;
    return !explicitBroker && (args?.broker === false || args?.viaBroker === false || args?.implicitBroker === false);
}

/** @param {string} name @param {DeviceArguments} args */
export function wantsBrokerMobile(name, args) {
    return BROKER_MOBILE_ACTIONS.has(name) && (args?.broker === true || args?.viaBroker === true || args?.autolaunch === true);
}

/** @param {string} name @param {DeviceArguments} args */
export function wantsBrokerPhysical(name, args) {
    return BROKER_PHYSICAL_TOOLS.has(name) && (args?.broker === true || args?.viaBroker === true || args?.autolaunch === true);
}

/** @param {unknown} value @param {number} maximum @param {number} fallback */
export function boundedTimeoutMs(value, maximum, fallback) {
    const requested = Number(value);
    if (!Number.isFinite(requested) || requested <= 0) return fallback;
    return Math.min(maximum, Math.max(1, Math.trunc(requested)));
}

/** @param {string} name @param {DeviceArguments} args */
export function brokerDeviceToolExecutionTimeout(name, args) {
    if (Number.isFinite(args?.rpcTimeoutMs)) {
        return { rpcTimeoutMs: boundedTimeoutMs(args.rpcTimeoutMs, MAX_DEVICE_TOOL_RPC_TIMEOUT_MS, DEFAULT_BROKER_DEVICE_TOOL_TIMEOUT_MS) };
    }
    if (BROKER_BOUNDED_WAIT_TOOLS.has(name) && Number.isFinite(args?.timeoutMs)) {
        const operationTimeoutMs = boundedTimeoutMs(args.timeoutMs, MAX_DEVICE_OPERATION_TIMEOUT_MS, DEFAULT_BROKER_DEVICE_TOOL_TIMEOUT_MS);
        return {
            rpcTimeoutMs: Math.max(
                DEFAULT_BROKER_DEVICE_TOOL_TIMEOUT_MS + BROKER_DEVICE_TOOL_RPC_BUFFER_MS,
                operationTimeoutMs + BROKER_DEVICE_TOOL_RPC_BUFFER_MS,
            ),
        };
    }
    if (Number.isFinite(args?.timeoutMs)) {
        return { rpcTimeoutMs: boundedTimeoutMs(args.timeoutMs, MAX_DEVICE_OPERATION_TIMEOUT_MS, DEFAULT_BROKER_DEVICE_TOOL_TIMEOUT_MS) };
    }
    const requestedHelperTimeoutMs = Number(args?.helperTimeoutMs);
    if (Number.isFinite(requestedHelperTimeoutMs)) {
        return {
            rpcTimeoutMs: Math.max(
                DEFAULT_BROKER_DEVICE_TOOL_TIMEOUT_MS,
                boundedTimeoutMs(requestedHelperTimeoutMs, MAX_DEVICE_HELPER_TIMEOUT_MS, DEFAULT_BROKER_DEVICE_TOOL_TIMEOUT_MS) + BROKER_DEVICE_TOOL_RPC_BUFFER_MS,
            ),
        };
    }
    if (BROKER_FAST_DEVICE_TOOLS.has(name)) return {};
    const rpcTimeoutMs = DEFAULT_BROKER_DEVICE_TOOL_TIMEOUT_MS + BROKER_DEVICE_TOOL_RPC_BUFFER_MS;
    return { rpcTimeoutMs };
}


/** @param {DeviceArguments} args */
export function wantsBrokerBackends(args) {
    return args?.broker === true || args?.viaBroker === true || args?.autolaunch === true;
}

/** @param {string} name @param {DeviceArguments} args */
export function wantsCurrentDisplayDevice(name, args = {}) {
    return args?.deviceId === CURRENT_DISPLAY_DEVICE_ID && (name === "device_status" || DISPLAY_DEVICE_TOOL_MAP.has(name));
}

export const HYPER_V_LINUX_TOOLS = new Set([
    ...BROKER_LIFECYCLE_COMMANDS,
    "device_inventory",
    "device_exec",
    "device_upload",
    "device_download",
    "device_screenshot",
    "device_click",
    "device_double_click",
    "device_key",
    "device_type",
    "device_scroll",
    "device_cursor_position",
    "device_drag",
    "device_focus_window",
    "device_snapshot_list",
    "device_snapshot_create",
    "device_snapshot_restore",
    "device_snapshot_delete",
]);

/** @param {string} name @param {DeviceArguments} args */
export function isCursorMove(name, args = {}) {
    return name === "device_cursor_position" && (args.x !== undefined || args.y !== undefined);
}

/** @param {unknown} error */
export function requestErrorMessage(error) {
 return error !== null && (typeof error === "object" || typeof error === "function") ? Reflect.get(error, "message") : undefined;
}
