import { availableDevices } from "./available-devices.mjs";
import { cropScreenshotResult } from "./screenshot-region.mjs";
import { finishStartReadiness, startBootTimeoutMs } from "./start-readiness.mjs";
import { buildListFilesCommand, listFilesFromExecResult } from "@ccc/device-lab/providers/file-listing.mjs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { androidBackend, androidDiscovery, handleAndroidTool, listAndroidDevices } from "@ccc/device-lab/providers/backends/android.mjs";
import { androidRealBackend, handleAndroidRealTool, listAndroidRealDevices } from "@ccc/device-lab/providers/backends/android-device.mjs";
import { handleIosTool, iosBackend, iosDiscovery, listIosDevices } from "@ccc/device-lab/providers/backends/ios-simulator.mjs";
import { handleIosRealTool, iosRealBackend, iosRealDiscovery, listIosRealDevices } from "@ccc/device-lab/providers/backends/ios-device.mjs";
import { handleMacosTool, listMacosDevices, macosBackend } from "@ccc/device-lab/providers/backends/macos-vm.mjs";
import { handleLinuxVmManagementTool, handleLinuxVmTool, linuxVmBackend, listLinuxVmDevices } from "@ccc/device-lab/providers/backends/linux-vm.mjs";
import { handleWindowsTool, listWindowsDevices, windowsBackend } from "@ccc/device-lab/providers/backends/windows-sandbox.mjs";
import { listWindowsVmDevices, windowsVmBackend } from "@ccc/device-lab/providers/backends/windows-vm.mjs";
import { brokerAppium, brokerCommand, brokerDeviceTool, brokerPhysical, brokerRpc, brokerStatus, implicitBrokerProbeOptions, withBrokerOperation } from "./broker.mjs";
import { ownerId } from "@ccc/device-lab/providers/context.mjs";
import { currentDisplayTarget, handleDisplayTool } from "@ccc/device-lab/providers/display/x11.mjs";
import { evaluateDestructivePolicy } from "./policy/destructive.mjs";
import { flowJsonResult, jsonResult, textResult } from "@ccc/device-lab/providers/responses.mjs";
import { compactToolValue } from "./public-output.mjs";
import { OWNER_DEVICE_ID_PATTERN } from "@ccc/device-lab/providers/state/owner-device-state.mjs";
import { readOwnerDevices } from "@ccc/device-lab/providers/state/device-store.mjs";
import { DEVICE_FLOW_TOOL_NAMES, TOOLS, toolOperation, flowOperationAllowed } from "./tools.mjs";
import { TOOLS as OPERATION_TOOLS } from "./operation-tools.mjs";
import { actionResult } from "./action-output.mjs";
import { flowStepArguments, normalizeToolArgs, normalizePublicToolArgs, toolInputError } from "./tool-arguments.mjs";
import { createWaitBudget } from "@ccc/device-lab/providers/wait-budget.mjs";
import { runDeviceFlow } from "@ccc/device-lab/providers/application/device-flow.mjs";

const DEVICE_REQUIRED_TOOLS = new Set(OPERATION_TOOLS
    .filter((tool) => tool.inputSchema?.required?.includes("deviceId"))
    .map((tool) => tool.name));
DEVICE_REQUIRED_TOOLS.add("device_drag");
const DEVICE_FLOW_ALLOWED_TOOLS = new Set(DEVICE_FLOW_TOOL_NAMES);
const BROKER_LIFECYCLE_COMMANDS = new Set(["device_create", "device_status", "device_start", "device_stop", "device_reboot", "device_delete"]);
const HYPER_V_LIFECYCLE_BACKENDS = new Set(["windows-vm", "linux-vm"]);
const BROKER_READONLY_DEVICE_TOOLS = new Set([
    "device_list_files",
    "device_inventory",
    "device_snapshot_list",
    "device_record_video_status",
    "device_screenshot",
    "device_window_list",
    "device_accessibility_snapshot",
]);
const BROKER_MUTATING_DEVICE_TOOLS = new Set([
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
const BROKER_PHYSICAL_TOOLS = new Set(["device_attach", "device_detach"]);
const BROKER_PHYSICAL_BACKENDS = new Set(["android-device", "ios-device"]);
const BROKER_FAST_DEVICE_TOOLS = new Set(["device_record_video_status"]);
const BROKER_RECORDING_DEVICE_TOOLS = new Set(["device_record_video_start", "device_record_video_stop", "device_record_video_status"]);
const DEFAULT_BROKER_DEVICE_TOOL_TIMEOUT_MS = 30000;
const DEFAULT_BROKER_DISCOVERY_RPC_TIMEOUT_MS = 30000;
export const HYPER_V_LINUX_GUI_TIMEOUT_MS = 17 * 60 * 1000;
const DEFAULT_BROKER_LIFECYCLE_RPC_TIMEOUT_MS = 120000;
// Image acquisition may consume the full four-hour provider budget. Reserve
// another 30 minutes for hashing, VM creation, and guest provisioning.
export const HYPER_V_IMAGE_ACQUIRE_RPC_TIMEOUT_MS = 21600000;
export const HYPER_V_LIFECYCLE_RPC_BUFFER_MS = 15000;
// Mirrors DEVICE_BROKER_HYPER_V_CLEANUP_RESERVE_MS in src/device-lab-broker.ts. The broker adds
// this to its cleanup deadline for linux-vm and windows-vm start/reboot so containment has time to
// run after the operation deadline; the caller has to wait at least as long or it drops the reply.
export const HYPER_V_CLEANUP_RESERVE_MS = 5 * 60 * 1000;
export const HYPER_V_CREATE_RPC_TIMEOUT_MS = HYPER_V_IMAGE_ACQUIRE_RPC_TIMEOUT_MS + HYPER_V_LIFECYCLE_RPC_BUFFER_MS;
export const HYPER_V_HOST_LOCK_WAIT_MS = 10 * 60 * 1000;
export const HYPER_V_PROVIDER_LIFECYCLE_TIMEOUT_MS = 120000;
export const HYPER_V_MAX_BOOT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_BROKER_PHYSICAL_RPC_TIMEOUT_MS = 30000;
export const MAX_DEVICE_HELPER_TIMEOUT_MS = 300000;
export const MAX_DEVICE_OPERATION_TIMEOUT_MS = 600000;
// The host broker child already reserves 15 seconds beyond the provider timeout.
// Keep the HTTP caller outside that deadline so it can receive child diagnostics.
const BROKER_DEVICE_TOOL_RPC_BUFFER_MS = 30000;
const MAX_DEVICE_TOOL_RPC_TIMEOUT_MS = MAX_DEVICE_OPERATION_TIMEOUT_MS + BROKER_DEVICE_TOOL_RPC_BUFFER_MS;
const BROKER_BOUNDED_WAIT_TOOLS = new Set(["mobile_wait_for_text", "mobile_wait_for_app"]);
const DIRECT_DEVICE_BACKEND_HINT_TOOLS = new Set([
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
const CURRENT_DISPLAY_DEVICE_ID = "x11-current-display";
const MOBILE_COMMON_OPERATIONS = new Map([
    ["device_drag", "mobile_drag"],
    ["device_click", "mobile_tap"], ["device_double_click", "mobile_double_tap"],
    ["device_accessibility_snapshot", "mobile_dump_ui"], ["device_type", "mobile_type_text"], ["device_key", "mobile_key"],
]);
function commonOperation(name, backend, args) {
    if (!["android-emulator", "android-device", "ios-simulator", "ios-device"].includes(backend)) {
        if (name === "device_key" && args.keyCode !== undefined) return { error: "keyCode is supported only on Android; use key on this device" };
        return { name };
    }
    if ((name === "device_click" || name === "device_double_click") && args.button !== undefined && args.button !== "left") return { error: "Mobile click supports only the left button" };
    if (name === "device_key" && backend.startsWith("ios") && args.keyCode !== undefined) return { error: "keyCode is supported only on Android; use key on iOS" };
    return { name: MOBILE_COMMON_OPERATIONS.get(name) || name };
}
const DISPLAY_DEVICE_TOOL_MAP = new Map([
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
const LIFECYCLE_STATE_BACKENDS = new Map([
    ["android", "android-emulator"],
    ["android-device", "android-device"],
    ["ios", "ios-simulator"],
    ["ios-device", "ios-device"],
    ["windows", "windows-sandbox"],
    ["windows-vm", "windows-vm"],
    ["linux-vm", "linux-vm"],
    ["macos", "macos-vm"],
]);


const BROKER_MOBILE_ACTIONS = new Set([
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
const BROKER_BACKEND_MOBILE_TOOLS = new Set([
    "mobile_set_network",
    "mobile_clear_app_data",
    "mobile_grant_permission",
    "mobile_revoke_permission",
    "mobile_set_battery",
]);
const BROKER_APPIUM_ROUTED_MOBILE_TOOLS = new Set(["mobile_session_status", "mobile_set_clipboard", "mobile_get_clipboard"]);
const DEFAULT_BROKER_APPIUM_RPC_TIMEOUT_MS = 315000;

function summarizeContentItem(item) {
    const text = item.text || "";
    try {
        return { type: "json", value: JSON.parse(text) };
    } catch {
        return { type: "text", text };
    }
}

function summarizeToolResult(name, result, nativeContent) {
    const content = [];
    // A range stays small even for many native blocks and survives diagnostic
    // truncation of step.content. Index 0 is the outer JSON summary.
    const contentIndex = nativeContent.length + 1;
    for (const item of result?.content || []) {
        if (item.type === "text") content.push(summarizeContentItem(item));
        else nativeContent.push(item);
    }
    const contentCount = nativeContent.length + 1 - contentIndex;
    const isError = Boolean(result?.isError) || content.some((item) => item.type === "json" && item.value?.ok === false);
    const unmetWait = !isError && content.some((item) => item.type === "json" && (
        (["mobile_wait_for_text", "mobile_wait_for_app"].includes(name) && item.value?.matched === false)
        ||
        (name === "mobile_wait_for_text" && item.value?.found === false)
        || (name === "mobile_wait_for_app" && (item.value?.found === false || item.value?.running === false))
    ));
    return {
        isError: isError || unmetWait,
        ...(unmetWait ? { error: "wait-condition-not-met" } : {}),
        ...(contentCount ? { contentIndex, contentCount } : {}),
        ...(content.length ? { content } : {}),
    };
}

function policyDeniedResult(policy) {
    return textResult(false, JSON.stringify({ ok: false, policy }, null, 2));
}

function wantsBrokerLifecycle(name, args) {
    return BROKER_LIFECYCLE_COMMANDS.has(name) && (args?.broker === true || args?.viaBroker === true || args?.autolaunch === true);
}

function wantsBrokerDeviceTool(name, args) {
    return (BROKER_READONLY_DEVICE_TOOLS.has(name) || BROKER_MUTATING_DEVICE_TOOLS.has(name))
        && (args?.broker === true || args?.viaBroker === true || args?.autolaunch === true);
}

function optsOutOfImplicitBroker(args) {
    return args?.broker === false || args?.viaBroker === false || args?.implicitBroker === false;
}

function wantsBrokerMobile(name, args) {
    return BROKER_MOBILE_ACTIONS.has(name) && (args?.broker === true || args?.viaBroker === true || args?.autolaunch === true);
}

function wantsBrokerPhysical(name, args) {
    return BROKER_PHYSICAL_TOOLS.has(name) && (args?.broker === true || args?.viaBroker === true || args?.autolaunch === true);
}

function brokerRouteOptions(args = {}) {
    return { ...args, autolaunch: args?.autolaunch === false ? false : true };
}

function brokerDeviceToolRouteArgs(name, args = {}) {
    if (name !== "device_wireless") return args;
    return {
        ...args,
        devicePort: args?.port,
        port: Number.isInteger(args?.brokerPort) ? args.brokerPort : undefined,
    };
}

function boundedTimeoutMs(value, maximum, fallback) {
    const requested = Number(value);
    if (!Number.isFinite(requested) || requested <= 0) return fallback;
    return Math.min(maximum, Math.max(1, Math.trunc(requested)));
}

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

export function brokerLifecycleExecutionTimeout(args) {
    const hyperVBackend = args?.backend === "windows-vm" || args?.backend === "linux-vm";
    if (hyperVBackend && args?.command === "device_create") {
        return { rpcTimeoutMs: HYPER_V_CREATE_RPC_TIMEOUT_MS };
    }
    if (hyperVBackend) {
        const waitsForBoot = (args?.command === "device_start" || args?.command === "device_reboot")
            && args?.waitForBoot !== false;
        const bootTimeoutMs = waitsForBoot
            ? Number.isFinite(args?.bootTimeoutMs)
                ? Math.min(HYPER_V_MAX_BOOT_TIMEOUT_MS, Math.max(1000, Number(args.bootTimeoutMs)))
                : 5 * 60 * 1000
            : 0;
        // The broker reserves cleanup time on top of the operation deadline for linux-vm AND
        // windows-vm start/reboot, so its outer window is that much longer than the sum below.
        // Without matching it here the caller can time out while containment is still running, and
        // the response carrying scrubContainmentFailed — the one signal that a guest may still be
        // up with a live autologon — is simply lost.
        const containmentReserveMs = waitsForBoot ? HYPER_V_CLEANUP_RESERVE_MS : 0;
        const automaticRpcTimeoutMs = HYPER_V_HOST_LOCK_WAIT_MS
            + HYPER_V_PROVIDER_LIFECYCLE_TIMEOUT_MS
            + bootTimeoutMs
            + (waitsForBoot && args?.backend === "linux-vm" ? HYPER_V_LINUX_GUI_TIMEOUT_MS : 0)
            + containmentReserveMs
            + HYPER_V_LIFECYCLE_RPC_BUFFER_MS;
        return { rpcTimeoutMs: automaticRpcTimeoutMs };
    }
    if (Number.isFinite(args?.rpcTimeoutMs)) return { rpcTimeoutMs: boundedTimeoutMs(args.rpcTimeoutMs, MAX_DEVICE_TOOL_RPC_TIMEOUT_MS, DEFAULT_BROKER_LIFECYCLE_RPC_TIMEOUT_MS) };
    if (Number.isFinite(args?.timeoutMs)) return { rpcTimeoutMs: boundedTimeoutMs(args.timeoutMs, MAX_DEVICE_OPERATION_TIMEOUT_MS, DEFAULT_BROKER_LIFECYCLE_RPC_TIMEOUT_MS) };
    if (args?.backend === "android-emulator" && args?.createAvd === true) {
        return { rpcTimeoutMs: 315000 };
    }
    if (args?.backend === "android-emulator" && args?.deleteAvd === true) {
        return { rpcTimeoutMs: 135000 };
    }
    if (args?.waitForBoot === true) {
        const bootTimeoutMs = startBootTimeoutMs(args);
        return { rpcTimeoutMs: bootTimeoutMs + 15000 };
    }
    return { rpcTimeoutMs: DEFAULT_BROKER_LIFECYCLE_RPC_TIMEOUT_MS };
}

function selectedBrokerProbeOptions(probe, rpcResult) {
    const selected = rpcResult?.selected;
    if (!selected?.host || !Number.isInteger(selected.port)) return probe;
    return { ...probe, hostCandidates: [selected.host], port: selected.port };
}

function implicitBrokerUnavailableResult(routedBy) {
    return jsonResult({
        ok: false,
        error: "broker-runtime-unavailable",
        routedBy,
        detail: "Implicit broker routing was required for this owner-scoped device operation, but no usable broker runtime was available. Use implicitBroker:false only when direct local provider access is intended.",
    });
}

function lifecycleBackendDevices() {
    return [
        ["android-emulator", listAndroidDevices()],
        ["android-device", listAndroidRealDevices()],
        ["ios-simulator", listIosDevices({ identityOnly: true })],
        ["ios-device", listIosRealDevices()],
        ["windows-sandbox", listWindowsDevices()],
        ["windows-vm", listWindowsVmDevices()],
        ["macos-vm", listMacosDevices({ identityOnly: true })],
        ["linux-vm", listLinuxVmDevices()],
    ];
}

function directBackendList(includeLocalProviders = true) {
    const display = currentDisplayTarget();
    const android = includeLocalProviders ? androidDiscovery() : null;
    const ios = includeLocalProviders ? iosDiscovery() : null;
    return [
        {
            name: "x11-current-display",
            host: "container",
            creatable: false,
            available: display.available,
            lazy: false,
            capabilities: display.capabilities,
        },
        ...(includeLocalProviders ? [
            androidBackend(android),
            androidRealBackend(android),
            iosBackend(ios),
            iosRealBackend(iosRealDiscovery(ios)),
            windowsBackend(),
            windowsVmBackend(),
            macosBackend(),
        ] : []),
        linuxVmBackend(),
    ];
}

function wantsBrokerBackends(args) {
    return args?.broker === true || args?.viaBroker === true || args?.autolaunch === true;
}

function brokerDiscoveryExecutionTimeout(args = {}) {
    return {
        rpcTimeoutMs: boundedTimeoutMs(args.rpcTimeoutMs, MAX_DEVICE_TOOL_RPC_TIMEOUT_MS, DEFAULT_BROKER_DISCOVERY_RPC_TIMEOUT_MS),
    };
}

async function handleDeviceBackends(args = {}, { detail = false } = {}) {
    const brokerOptOut = optsOutOfImplicitBroker(args);
    const directBackends = directBackendList(brokerOptOut || detail);
    const containerBackends = directBackends.filter((backend) => backend.host === "container");
    const explicitBroker = wantsBrokerBackends(args);
    if (brokerOptOut) {
        const broker = await brokerStatus({ ...args, autolaunch: false, probe: false });
        return jsonResult({
            ownerId: ownerId(),
            broker,
            source: "direct-provider",
            backends: directBackends,
        });
    }
    const implicitProbe = explicitBroker || brokerOptOut ? null : implicitBrokerProbeOptions(args || {});
    const probe = explicitBroker ? { ...args, probe: true } : implicitProbe;
    const broker = await brokerStatus(probe ? { ...args, ...probe, probe: true } : { ...args, autolaunch: !brokerOptOut, probe: !brokerOptOut });
    if (probe && broker.available) {
        const brokerBackends = await brokerRpc({ ...args, ...probe, ...brokerDiscoveryExecutionTimeout(args), method: "broker.backends" });
        if (brokerBackends.ok && Array.isArray(brokerBackends.result?.backends)) {
            const brokerBackendNames = new Set(brokerBackends.result.backends.map((backend) => backend?.name).filter(Boolean));
            return jsonResult({
                ownerId: ownerId(),
                broker,
                source: "host-broker-provider-discovery",
                routedBy: "device-backends-broker",
                backends: [
                    ...containerBackends.filter((backend) => !brokerBackendNames.has(backend.name)),
                    ...brokerBackends.result.backends,
                ],
                hostBackends: brokerBackends.result,
                ...(detail ? { localBackends: directBackends } : {}),
            });
        }
        return jsonResult({
            ok: false,
            ownerId: ownerId(),
            broker,
            source: "broker-provider-discovery-failed",
            routedBy: "device-backends-broker",
            backends: containerBackends,
            brokerBackendsError: brokerBackends,
            ...(detail ? { localBackends: directBackends } : {}),
        });
    }
    return jsonResult({
        ok: false,
        error: broker.available ? "broker-provider-discovery-unavailable" : "broker-unavailable",
        ownerId: ownerId(),
        broker,
        source: broker.available ? "broker-provider-discovery-failed" : "broker-unavailable",
        routedBy: "device-backends-broker",
        backends: containerBackends,
        ...(detail ? { localBackends: directBackends } : {}),
    });
}

function inferLifecycleBackend(deviceId) {
    if (!deviceId) return { ok: false, error: "missing-device-id" };
    const matches = [];
    for (const [backend, devices] of lifecycleBackendDevices()) {
        if ((devices || []).some((device) => device?.id === deviceId)) matches.push(backend);
    }
    if (matches.length === 1) return { ok: true, backend: matches[0] };
    if (matches.length > 1) return { ok: false, error: "ambiguous-device-backend", matches };
    return { ok: false, error: "device-backend-not-found" };
}

function inferBrokerInventoryLifecycleBackend(inventory, deviceId) {
    const matches = [];
    const backends = Array.isArray(inventory?.result?.backends) ? inventory.result.backends : [];
    for (const entry of backends) {
        const backend = LIFECYCLE_STATE_BACKENDS.get(entry?.stateKey);
        if (!backend) continue;
        const devices = Array.isArray(entry?.devices) ? entry.devices : [];
        if (devices.some((device) => device?.id === deviceId)) matches.push(backend);
    }
    if (matches.length === 1) return { ok: true, backend: matches[0] };
    if (matches.length > 1) return { ok: false, error: "ambiguous-device-backend", matches };
    return { ok: false, error: "device-backend-not-found" };
}

function mobileBackendDevices() {
    return [
        ["android-emulator", listAndroidDevices()],
        ["android-device", listAndroidRealDevices()],
        ["ios-simulator", listIosDevices({ identityOnly: true })],
        ["ios-device", listIosRealDevices()],
    ];
}

function inferMobileBackend(deviceId) {
    if (!deviceId) return { ok: false, error: "missing-device-id" };
    const matches = [];
    for (const [backend, devices] of mobileBackendDevices()) {
        if ((devices || []).some((device) => device?.id === deviceId)) matches.push(backend);
    }
    if (matches.length === 1) return { ok: true, backend: matches[0] };
    if (matches.length > 1) return { ok: false, error: "ambiguous-device-backend", matches };
    return { ok: false, error: "device-backend-not-found" };
}

function brokerMobileOptions(args) {
    return {
        autolaunch: args?.autolaunch,
        hostCandidates: args?.hostCandidates,
        launchHost: args?.launchHost,
        port: args?.port,
        timeoutMs: args?.timeoutMs,
        rpcTimeoutMs: args?.rpcTimeoutMs,
        launchTimeoutMs: args?.launchTimeoutMs,
        appiumPort: args?.appiumPort,
        serverPort: args?.serverPort,
        automationName: args?.automationName,
        provider: args?.provider,
        physical: args?.physical,
    };
}

function brokerAppiumOptions(args) {
    return {
        ...brokerMobileOptions(args),
        rpcTimeoutMs: Number.isFinite(args?.rpcTimeoutMs)
            ? Number(args.rpcTimeoutMs)
            : DEFAULT_BROKER_APPIUM_RPC_TIMEOUT_MS,
    };
}

function brokerPointerActions(type, steps) {
    return {
        actions: [
            {
                type: "pointer",
                id: type,
                parameters: { pointerType: "touch" },
                actions: steps,
            },
        ],
    };
}

function androidKeycodeRequest(keycode) {
    return { method: "POST", path: "/appium/device/press_keycode", body: { keycode } };
}

function brokerAndroidShellRequest(command, args) {
    return { method: "POST", path: "/execute/sync", body: { script: "mobile: shell", args: [{ command, args }] } };
}

function appIdForBackend(args, backend) {
    return backend.startsWith("android") ? args?.packageName : args?.bundleId;
}

function base64Text(text) {
    return Buffer.from(String(text), "utf8").toString("base64");
}

function decodeBase64Text(value) {
    if (typeof value !== "string") return value;
    const normalized = value.trim();
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4 === 1) return value;
    try {
        const decoded = Buffer.from(normalized, "base64").toString("utf8");
        const encoded = Buffer.from(decoded, "utf8").toString("base64").replace(/=+$/, "");
        if (encoded !== normalized.replace(/=+$/, "")) return value;
        return decoded;
    } catch {
        return value;
    }
}

function androidOrientationRequests(orientation) {
    const rotations = {
        portrait: "0",
        landscape: "1",
        "reverse-portrait": "2",
        "reverse-landscape": "3",
    };
    const rotation = rotations[orientation];
    if (rotation === undefined) return null;
    if (orientation === "portrait" || orientation === "landscape") {
        return [{ method: "POST", path: "/orientation", body: { orientation: orientation.toUpperCase() } }];
    }
    return [
        brokerAndroidShellRequest("settings", ["put", "system", "accelerometer_rotation", "0"]),
        brokerAndroidShellRequest("settings", ["put", "system", "user_rotation", rotation]),
    ];
}

function brokerMobileRequest(name, args, backend) {
    if (name === "mobile_dump_ui") return { method: "GET", path: "/source" };
    if (name === "mobile_screenshot") return { method: "GET", path: "/screenshot" };
    if (name === "mobile_tap") {
        const { x, y } = args;
        return { method: "POST", path: "/actions", body: brokerPointerActions("tap", [
            { type: "pointerMove", duration: 0, x, y },
            { type: "pointerDown", button: 0 },
            { type: "pointerUp", button: 0 },
        ]) };
    }
    if (name === "mobile_double_tap") {
        const { x, y } = args;
        return { method: "POST", path: "/actions", body: brokerPointerActions("doubleTap", [
            { type: "pointerMove", duration: 0, x, y },
            { type: "pointerDown", button: 0 },
            { type: "pointerUp", button: 0 },
            { type: "pause", duration: 80 },
            { type: "pointerDown", button: 0 },
            { type: "pointerUp", button: 0 },
        ]) };
    }
    if (name === "mobile_long_press") {
        const { x, y, durationMs = 700 } = args;
        return { method: "POST", path: "/actions", body: brokerPointerActions("longPress", [
            { type: "pointerMove", duration: 0, x, y },
            { type: "pointerDown", button: 0 },
            { type: "pause", duration: durationMs },
            { type: "pointerUp", button: 0 },
        ]) };
    }
    if (name === "mobile_swipe" || name === "mobile_drag") {
        const { x1, y1, x2, y2, durationMs = name === "mobile_drag" ? 700 : 300 } = args;
        return { method: "POST", path: "/actions", body: brokerPointerActions(name === "mobile_drag" ? "drag" : "swipe", [
            { type: "pointerMove", duration: 0, x: x1, y: y1 },
            { type: "pointerDown", button: 0 },
            { type: "pointerMove", duration: durationMs, x: x2, y: y2 },
            { type: "pointerUp", button: 0 },
        ]) };
    }
    if (name === "mobile_type_text") return { method: "POST", path: "/keys", body: { text: String(args.text), value: [...String(args.text)] } };
    if (name === "mobile_key") {
        const resolvedKey = args.key ?? args.keyCode;
        if (resolvedKey === undefined || resolvedKey === null || resolvedKey === "") return { error: "mobile_key requires key or keyCode" };
        if (backend.startsWith("android") && Number.isFinite(args.keyCode)) return androidKeycodeRequest(Number(args.keyCode));
        return { method: "POST", path: "/keys", body: { text: String(resolvedKey), value: [String(resolvedKey)] } };
    }
    if (name === "mobile_back") return { method: "POST", path: "/back", body: {} };
    if (name === "mobile_home") {
        if (backend.startsWith("android")) return androidKeycodeRequest(3);
        return { method: "POST", path: "/execute/sync", body: { script: "mobile: pressButton", args: [{ name: "home" }] } };
    }
    if (name === "mobile_forward") {
        if (backend.startsWith("android")) return androidKeycodeRequest(125);
        return { error: "mobile_forward is only supported by Android broker routing" };
    }
    if (name === "mobile_recents") {
        if (backend.startsWith("android")) return androidKeycodeRequest(187);
        return { error: "mobile_recents is only supported by Android broker routing" };
    }
    if (name === "mobile_power") {
        if (backend.startsWith("android")) return androidKeycodeRequest(26);
        return { error: "mobile_power is only supported by Android broker routing" };
    }
    if (name === "mobile_lock") {
        if (backend.startsWith("android")) return androidKeycodeRequest(223);
        return { method: "POST", path: "/execute/sync", body: { script: "mobile: lock", args: [] } };
    }
    if (name === "mobile_unlock") {
        if (backend.startsWith("android")) return androidKeycodeRequest(224);
        return { method: "POST", path: "/execute/sync", body: { script: "mobile: unlock", args: [] } };
    }
    if (name === "mobile_rotate_left") return brokerMobileRequest("mobile_set_orientation", { orientation: backend.startsWith("android") ? "landscape" : "LANDSCAPE" }, backend);
    if (name === "mobile_rotate_right") return brokerMobileRequest("mobile_set_orientation", { orientation: backend.startsWith("android") ? "reverse-landscape" : "PORTRAIT" }, backend);
    if (name === "mobile_set_orientation") {
        const raw = String(args.orientation || "");
        if (backend.startsWith("android")) {
            const requests = androidOrientationRequests(raw.toLowerCase());
            if (!requests) return { error: `Unsupported Android orientation: ${raw}` };
            return requests.length === 1 ? requests[0] : { requests };
        }
        const orientation = raw.toUpperCase();
        if (!["PORTRAIT", "LANDSCAPE"].includes(orientation)) return { error: "iOS broker mobile_set_orientation requires PORTRAIT or LANDSCAPE" };
        return { method: "POST", path: "/orientation", body: { orientation } };
    }
    if (name === "mobile_open_url") {
        if (!args.url) return { error: "mobile_open_url requires url" };
        return { method: "POST", path: "/url", body: { url: String(args.url) } };
    }
    if (name === "mobile_install_app") {
        if (!args.path) return { error: "mobile_install_app requires path" };
        return { method: "POST", path: "/appium/device/install_app", body: { appPath: String(args.path) } };
    }
    if (name === "mobile_launch_app") {
        if (backend.startsWith("android") && args.component && !args.packageName) {
            return brokerAndroidShellRequest("am", ["start", "-n", String(args.component)]);
        }
        const appId = appIdForBackend(args, backend);
        if (!appId) return { error: backend.startsWith("android") ? "mobile_launch_app requires packageName" : "mobile_launch_app requires bundleId" };
        return { method: "POST", path: "/appium/device/activate_app", body: { appId: String(appId) } };
    }
    if (name === "mobile_uninstall_app") {
        const appId = appIdForBackend(args, backend);
        if (!appId) return { error: backend.startsWith("android") ? "mobile_uninstall_app requires packageName" : "mobile_uninstall_app requires bundleId" };
        return { method: "POST", path: "/appium/device/remove_app", body: { appId: String(appId) } };
    }
    if (name === "mobile_stop_app") {
        const appId = appIdForBackend(args, backend);
        if (!appId) return { error: backend.startsWith("android") ? "mobile_stop_app requires packageName" : "mobile_stop_app requires bundleId" };
        return { method: "POST", path: "/appium/device/terminate_app", body: { appId: String(appId) } };
    }
    if (name === "mobile_clear_app_data") {
        if (!backend.startsWith("android")) return { error: "mobile_clear_app_data is only supported by Android broker routing" };
        if (!args.packageName) return { error: "mobile_clear_app_data requires packageName" };
        return brokerAndroidShellRequest("pm", ["clear", String(args.packageName)]);
    }
    if (name === "mobile_set_location") {
        if (backend === "android-device") return { error: "Android real devices do not support mobile_set_location safely through broker routing; use an emulator or a dedicated device-farm controller." };
        if (backend === "ios-device") return { error: "iOS real devices do not support mobile_set_location safely through broker routing; use a simulator or a dedicated device-farm controller." };
        if (!Number.isFinite(args.latitude) || !Number.isFinite(args.longitude)) return { error: "mobile_set_location requires latitude and longitude" };
        return {
            method: "POST",
            path: "/location",
            body: {
                location: {
                    latitude: Number(args.latitude),
                    longitude: Number(args.longitude),
                    altitude: Number.isFinite(args.altitude) ? Number(args.altitude) : 0,
                },
            },
        };
    }
    if (name === "mobile_toggle_airplane_mode") {
        if (!backend.startsWith("android")) return { error: "mobile_toggle_airplane_mode is only supported by Android broker routing" };
        if (typeof args.enabled !== "boolean") return { error: "mobile_toggle_airplane_mode enabled must be boolean" };
        return {
            requests: [
                brokerAndroidShellRequest("settings", ["put", "global", "airplane_mode_on", args.enabled ? "1" : "0"]),
                brokerAndroidShellRequest("am", ["broadcast", "-a", "android.intent.action.AIRPLANE_MODE", "--ez", "state", args.enabled ? "true" : "false"]),
            ],
        };
    }
    if (name === "mobile_set_clipboard") {
        if (args.text === undefined || args.text === null) return { error: "mobile_set_clipboard requires text" };
        return { method: "POST", path: "/appium/device/set_clipboard", body: { content: base64Text(args.text), contentType: "plaintext", label: "text" } };
    }
    if (name === "mobile_get_clipboard") {
        return { method: "POST", path: "/appium/device/get_clipboard", body: { contentType: "plaintext" } };
    }
    if (name === "mobile_wait_for_app") {
        const appId = appIdForBackend(args, backend);
        if (!appId) return { error: backend.startsWith("android") ? "mobile_wait_for_app requires packageName" : "mobile_wait_for_app requires bundleId" };
        if (backend.startsWith("ios")) return { method: "POST", path: "/execute/sync", body: { script: "mobile: activeAppInfo", args: [] } };
        return { method: "POST", path: "/appium/device/app_state", body: { appId: String(appId) } };
    }
    return { error: `broker mobile route does not support ${name}` };
}

function brokerMobilePayload(name, backend, requestResult, extra = {}) {
    const responseBody = requestResult?.result?.response?.body;
    const value = responseBody?.value ?? responseBody;
    const base = {
        provider: "broker-appium",
        backend,
        broker: requestResult,
        ...extra,
    };
    if (name === "mobile_dump_ui") return { ...base, source: value };
    if (name === "mobile_get_clipboard") return { ...base, text: decodeBase64Text(value) };
    if (name === "mobile_wait_for_app") return { ...base, appState: value };
    return base;
}

function explicitBackendMismatchResult(name, args) {
    const requestedBackend = typeof args?.backend === "string" && args.backend ? args.backend : "";
    const deviceId = typeof args?.deviceId === "string" ? args.deviceId : "";
    if (!requestedBackend || !deviceId) return null;
    const inference = BROKER_MOBILE_ACTIONS.has(name)
        ? inferMobileBackend(deviceId)
        : DIRECT_DEVICE_BACKEND_HINT_TOOLS.has(name)
            ? inferLifecycleBackend(deviceId)
            : null;
    if (!inference?.ok || inference.backend === requestedBackend) return null;
    return jsonResult({
        ok: false,
        error: "device-backend-mismatch",
        deviceId,
        requestedBackend,
        actualBackend: inference.backend,
        routedBy: "direct-backend-hint",
    });
}

function wantsCurrentDisplayDevice(name, args = {}) {
    return args?.deviceId === CURRENT_DISPLAY_DEVICE_ID && (name === "device_status" || DISPLAY_DEVICE_TOOL_MAP.has(name));
}

async function handleCurrentDisplayDeviceTool(name, args = {}) {
    if (name === "device_status") return jsonResult(currentDisplayTarget());
    const displayTool = DISPLAY_DEVICE_TOOL_MAP.get(name);
    if (!displayTool) return null;
    return handleDisplayTool(displayTool, args);
}

async function handleBrokerLifecycleTool(name, args) {
    if (name !== "device_create" && !args?.backend) {
        return maybeHandleImplicitBrokerLifecycleTool(name, { ...args, implicitBroker: true, broker: true, viaBroker: true });
    }
    const deviceId = typeof args?.deviceId === "string" ? args.deviceId : "";
    const backend = typeof args?.backend === "string" && args.backend ? args.backend : name === "device_create" ? { ok: false, error: "missing-backend", matches: [] } : inferLifecycleBackend(deviceId);
    if (backend?.ok === false) {
        return jsonResult({
            ok: false,
            error: backend.error,
            deviceId,
            matches: backend.matches || [],
            routedBy: "device-lifecycle-broker",
        });
    }
    const routeArgs = brokerRouteOptions(args);
    const brokerArgs = name === "device_create" ? { ...routeArgs, devicePort: args?.port, port: args?.brokerPort } : routeArgs;
    const result = await brokerCommand({
        ...brokerArgs,
        ...brokerLifecycleExecutionTimeout({ ...args, backend: typeof backend === "string" ? backend : backend.backend, command: name }),
        action: "invoke",
        backend: typeof backend === "string" ? backend : backend.backend,
        command: name,
        deviceId,
        incarnationId: args?.incarnationId,
        preserveNetwork: args?.preserveNetwork,
        dryRun: args?.dryRun === true,
    });
    return jsonResult(brokerLifecyclePublicResult(result, "device-lifecycle-broker"));
}

function brokerLifecyclePublicResult(result, routedBy) {
    const body = result?.body && typeof result.body === "object" && !Array.isArray(result.body) ? result.body : null;
    return {
        ...result,
        ...(typeof body?.detail === "string" && body.detail ? { detail: body.detail } : {}),
        ...(typeof body?.remedy === "string" && body.remedy ? { remedy: body.remedy } : {}),
        routedBy,
    };
}

function implicitBrokerLifecycleResult(name, args, result) {
    const routedBy = "device-lifecycle-broker-implicit";
    if (!result?.ok || !result.result || typeof result.result !== "object" || Array.isArray(result.result)) {
        return jsonResult(brokerLifecyclePublicResult(result, routedBy));
    }
    const payload = { ...result.result, routedBy };
    if (name === "device_delete") {
        payload.deleted = args?.deviceId;
        if (args?.deleteAvd === true) payload.avdDeleted = true;
        if (args?.deleteSimulator === true) payload.simulatorDeleted = true;
    }
    return jsonResult(payload);
}

async function maybeHandleImplicitBrokerLifecycleTool(name, args) {
    if (!BROKER_LIFECYCLE_COMMANDS.has(name) || optsOutOfImplicitBroker(args)) return null;
    const probe = implicitBrokerProbeOptions(name === "device_create" ? { ...(args || {}), port: undefined } : args || {});
    if (name === "device_create") {
        const requestedBackend = typeof args?.backend === "string" && args.backend ? args.backend : "";
        if (!requestedBackend || typeof args?.name !== "string" || !args.name.trim()) return null;
        if (!probe) return implicitBrokerUnavailableResult("device-lifecycle-broker-implicit");
        const result = await brokerCommand({
            ...args,
            ...probe,
            ...brokerLifecycleExecutionTimeout({ ...args, backend: requestedBackend, command: name }),
            devicePort: args?.port,
            action: "invoke",
            backend: requestedBackend,
            command: name,
            deviceId: args?.deviceId,
            dryRun: args?.dryRun === true,
        });
        return implicitBrokerLifecycleResult(name, args, result);
    }
    const deviceId = typeof args?.deviceId === "string" ? args.deviceId : "";
    if (!deviceId) return null;
    if (!probe) return implicitBrokerUnavailableResult("device-lifecycle-broker-implicit");
    const inventory = await brokerRpc({ ...probe, method: "broker.inventory" });
    if (!inventory.ok) return jsonResult({ ...inventory, routedBy: "device-lifecycle-broker-implicit" });
    const requestedBackend = typeof args?.backend === "string" && args.backend ? args.backend : "";
    const inventoryBackend = inferBrokerInventoryLifecycleBackend(inventory, deviceId);
    const explicitHyperVDeleteMiss = name === "device_delete"
        && inventoryBackend.error === "device-backend-not-found"
        && HYPER_V_LIFECYCLE_BACKENDS.has(requestedBackend);
    if (!inventoryBackend.ok) {
        if (inventoryBackend.error === "device-backend-not-found" && !explicitHyperVDeleteMiss) {
            return jsonResult({ ok: false, error: "device-not-found", deviceId, routedBy: "device-lifecycle-broker-implicit" });
        }
        if (!explicitHyperVDeleteMiss) {
            return jsonResult({
                ok: false,
                error: inventoryBackend.error,
                deviceId,
                matches: inventoryBackend.matches || [],
                routedBy: "device-lifecycle-broker-implicit",
            });
        }
    }
    const resolvedBackend = explicitHyperVDeleteMiss ? requestedBackend : inventoryBackend.backend;
    if (requestedBackend && requestedBackend !== resolvedBackend) {
        return jsonResult({
            ok: false,
            error: "device-backend-mismatch",
            deviceId,
            requestedBackend,
            actualBackend: resolvedBackend,
            routedBy: "device-lifecycle-broker-implicit",
        });
    }
    const result = await brokerCommand({
        ...args,
        ...selectedBrokerProbeOptions(probe, inventory),
        ...brokerLifecycleExecutionTimeout({ ...args, backend: resolvedBackend, command: name }),
        action: "invoke",
        backend: resolvedBackend,
        command: name,
        deviceId,
        dryRun: args?.dryRun === true,
    });
    return implicitBrokerLifecycleResult(name, args, result);
}

function brokerPhysicalAction(name) {
    if (name === "device_attach") return "attach";
    if (name === "device_detach") return "detach";
    return "";
}

function brokerPhysicalProbeArgs(name, args = {}) {
    return {
        ...(args || {}),
        // device_attach already uses `port` for the Android Wi-Fi device port.
        // device_detach has no device port but still accepts brokerPort for
        // legacy diagnostics. Use brokerPort, when supplied, for probing.
        port: Number.isInteger(args?.brokerPort) ? args.brokerPort : undefined,
    };
}

function brokerPhysicalInvokeArgs(name, args = {}, backend) {
    const action = brokerPhysicalAction(name);
    const result = {
        ...(args || {}),
        action,
        backend,
    };
    if (name === "device_attach") result.devicePort = args?.port;
    if (Number.isInteger(args?.brokerPort)) result.port = args.brokerPort;
    return result;
}

function brokerPhysicalExecutionTimeout(args = {}) {
    if (Number.isFinite(args?.rpcTimeoutMs)) return { rpcTimeoutMs: boundedTimeoutMs(args.rpcTimeoutMs, MAX_DEVICE_TOOL_RPC_TIMEOUT_MS, DEFAULT_BROKER_PHYSICAL_RPC_TIMEOUT_MS) };
    if (Number.isFinite(args?.timeoutMs)) return { rpcTimeoutMs: boundedTimeoutMs(args.timeoutMs, MAX_DEVICE_OPERATION_TIMEOUT_MS, DEFAULT_BROKER_PHYSICAL_RPC_TIMEOUT_MS) };
    return { rpcTimeoutMs: DEFAULT_BROKER_PHYSICAL_RPC_TIMEOUT_MS };
}

async function inferBrokerPhysicalBackend(name, args, probe, routedBy) {
    const requestedBackend = typeof args?.backend === "string" && args.backend ? args.backend : "";
    if (requestedBackend) {
        if (BROKER_PHYSICAL_BACKENDS.has(requestedBackend)) return { ok: true, backend: requestedBackend, inventory: null };
        return { ok: false, handled: true, response: jsonResult({ ok: false, error: "unsupported-physical-backend", backend: requestedBackend, routedBy }) };
    }
    if (name === "device_attach") {
        return { ok: false, handled: true, response: jsonResult({ ok: false, error: "missing-backend", routedBy }) };
    }
    const deviceId = typeof args?.deviceId === "string" ? args.deviceId : "";
    if (!deviceId) return { ok: false, handled: true, response: jsonResult({ ok: false, error: "missing-device-id", routedBy }) };
    const inventory = await brokerRpc({ ...probe, method: "broker.inventory" });
    if (!inventory.ok) return { ok: false, handled: true, response: jsonResult({ ...inventory, routedBy }) };
    const inventoryBackend = inferBrokerInventoryLifecycleBackend(inventory, deviceId);
    if (!inventoryBackend.ok) {
        if (inventoryBackend.error === "device-backend-not-found") {
            return { ok: false, handled: true, response: jsonResult({ ok: false, error: "device-not-found", deviceId, routedBy }) };
        }
        return {
            ok: false,
            handled: true,
            response: jsonResult({
                ok: false,
                error: inventoryBackend.error,
                deviceId,
                matches: inventoryBackend.matches || [],
                routedBy,
            }),
        };
    }
    if (!BROKER_PHYSICAL_BACKENDS.has(inventoryBackend.backend)) {
        return {
            ok: false,
            handled: true,
            response: jsonResult({
                ok: false,
                error: "unsupported-physical-backend",
                deviceId,
                actualBackend: inventoryBackend.backend,
                supportedBackends: [...BROKER_PHYSICAL_BACKENDS],
                routedBy,
            }),
        };
    }
    return { ok: true, backend: inventoryBackend.backend, inventory };
}

async function handleBrokerPhysicalTool(name, args) {
    const routedBy = "device-physical-broker";
    const probe = implicitBrokerProbeOptions(brokerPhysicalProbeArgs(name, args || {}), { allowDefault: true });
    const inference = await inferBrokerPhysicalBackend(name, args, probe, routedBy);
    if (!inference.ok) return inference.response || jsonResult({ ok: false, error: "broker-rpc-unavailable", routedBy });
    const result = await brokerPhysical({
        ...brokerRouteOptions(brokerPhysicalInvokeArgs(name, args, inference.backend)),
        ...selectedBrokerProbeOptions(probe, inference.inventory),
        ...brokerPhysicalExecutionTimeout(args),
    });
    return jsonResult({ ...result, routedBy });
}

async function maybeHandleImplicitBrokerPhysicalTool(name, args) {
    if (!BROKER_PHYSICAL_TOOLS.has(name) || optsOutOfImplicitBroker(args)) return null;
    const probe = implicitBrokerProbeOptions(brokerPhysicalProbeArgs(name, args || {}));
    const routedBy = "device-physical-broker-implicit";
    if (!probe) return implicitBrokerUnavailableResult(routedBy);
    const inference = await inferBrokerPhysicalBackend(name, args, probe, routedBy);
    if (!inference.ok) return inference.handled ? inference.response : null;
    const result = await brokerPhysical({
        ...brokerPhysicalInvokeArgs(name, args, inference.backend),
        ...selectedBrokerProbeOptions(probe, inference.inventory),
        ...brokerPhysicalExecutionTimeout(args),
    });
    return jsonResult({ ...result, routedBy });
}

async function handleBrokerDeviceTool(name, args) {
    if (MOBILE_COMMON_OPERATIONS.has(name) || (args?.deviceId && !args?.backend)) {
        // The shared operation needs the same owner inventory validation as implicit calls.
        return maybeHandleImplicitBrokerDeviceTool(name, { ...args, implicitBroker: true, broker: true, viaBroker: true });
    }
    const result = await brokerDeviceTool({
        ...brokerRouteOptions(brokerDeviceToolRouteArgs(name, args)),
        ...brokerDeviceToolExecutionTimeout(name, args),
        tool: name,
    });
    if (result.ok && result.result?.mcpResult?.content) return result.result.mcpResult;
    return jsonResult({ ...result, routedBy: BROKER_MUTATING_DEVICE_TOOLS.has(name) ? "device-mutating-broker" : "device-readonly-broker" });
}

async function maybeHandleImplicitBrokerDeviceTool(name, args) {
    if (!(BROKER_READONLY_DEVICE_TOOLS.has(name) || BROKER_MUTATING_DEVICE_TOOLS.has(name)) || optsOutOfImplicitBroker(args)) return null;
    if (name === "device_inventory" && !(typeof args?.backend === "string" && args.backend)) return null;
    const isUnattachedPhysicalTool = name === "device_wireless" && BROKER_PHYSICAL_BACKENDS.has(args?.backend);
    if (name !== "device_inventory" && !isUnattachedPhysicalTool && !(typeof args?.deviceId === "string" && args.deviceId)) return null;
    const routedArgs = brokerDeviceToolRouteArgs(name, args);
    const probe = implicitBrokerProbeOptions(routedArgs);
    if (!probe) return implicitBrokerUnavailableResult(BROKER_MUTATING_DEVICE_TOOLS.has(name) ? "device-mutating-broker-implicit" : "device-readonly-broker-implicit");
    let brokerBackend = typeof args?.backend === "string" && args.backend ? args.backend : "";
    let inventory = null;
    if (name !== "device_inventory" && !isUnattachedPhysicalTool) {
        inventory = await brokerRpc({ ...probe, method: "broker.inventory" });
        if (!inventory.ok) return jsonResult({ ...inventory, routedBy: BROKER_MUTATING_DEVICE_TOOLS.has(name) ? "device-mutating-broker-implicit" : "device-readonly-broker-implicit" });
        const inventoryBackend = inferBrokerInventoryLifecycleBackend(inventory, args.deviceId);
        if (!inventoryBackend.ok) {
            if (inventoryBackend.error === "device-backend-not-found") {
                return jsonResult({
                    ok: false,
                    error: "device-not-found",
                    deviceId: args.deviceId,
                    routedBy: BROKER_MUTATING_DEVICE_TOOLS.has(name) ? "device-mutating-broker-implicit" : "device-readonly-broker-implicit",
                });
            }
            return jsonResult({
                ok: false,
                error: inventoryBackend.error,
                deviceId: args.deviceId,
                matches: inventoryBackend.matches || [],
                routedBy: BROKER_MUTATING_DEVICE_TOOLS.has(name) ? "device-mutating-broker-implicit" : "device-readonly-broker-implicit",
            });
        }
        if (brokerBackend && brokerBackend !== inventoryBackend.backend) {
            return jsonResult({
                ok: false,
                error: "device-backend-mismatch",
                deviceId: args.deviceId,
                requestedBackend: brokerBackend,
                actualBackend: inventoryBackend.backend,
                routedBy: BROKER_MUTATING_DEVICE_TOOLS.has(name) ? "device-mutating-broker-implicit" : "device-readonly-broker-implicit",
            });
        }
        brokerBackend = inventoryBackend.backend;
    }
    if (isCursorMove(name, args) && !["windows-vm", "linux-vm", "windows-sandbox", "macos-vm"].includes(brokerBackend)) {
        return jsonResult({ ok: false, error: "device-cursor-move-backend-unsupported" });
    }
    const common = commonOperation(name, brokerBackend, args);
    if (common.error) return textResult(false, common.error);
    if (common.name !== name && wantsBrokerMobile(common.name, args)) {
        return handleBrokerMobileTool(common.name, {
            ...args, ...selectedBrokerProbeOptions(probe, inventory), backend: brokerBackend,
        });
    }
    const listing = name === "device_list_files";
    if (listing && brokerBackend === "ios-device") return jsonResult({ ok: false, error: "list-files-unsupported", detail: "The current Device Lab physical iOS adapter does not implement file listing.", deviceId: args.deviceId });
    const composedListing = listing && brokerBackend !== "ios-simulator";
    const listingCommand = composedListing ? buildListFilesCommand(brokerBackend, args) : undefined;
    const executionArgs = { ...routedArgs };
    if (composedListing) for (const key of ["path", "limit", "bundleId", "containerType"]) delete executionArgs[key];
    const result = await brokerDeviceTool({
        ...executionArgs,
        ...selectedBrokerProbeOptions(probe, inventory),
        ...brokerDeviceToolExecutionTimeout(name, args),
        ...(brokerBackend ? { backend: brokerBackend } : {}),
        tool: composedListing ? "device_exec" : common.name,
        ...(composedListing ? { command: listingCommand } : {}),
    });
    if (composedListing) return listFilesFromExecResult(result.ok && result.result?.mcpResult?.content ? result.result.mcpResult : jsonResult(result), args);
    if (result.ok && result.result?.mcpResult?.content) return result.result.mcpResult;
    const routedBy = BROKER_MUTATING_DEVICE_TOOLS.has(name) ? "device-mutating-broker-implicit" : "device-readonly-broker-implicit";
    if (result.ok && BROKER_RECORDING_DEVICE_TOOLS.has(name) && result.result && typeof result.result === "object") {
        return jsonResult({ ...result.result, routedBy });
    }
    return jsonResult({ ...result, routedBy });
}

async function maybeHandleImplicitBrokerMobileTool(name, args) {
    if (!BROKER_MOBILE_ACTIONS.has(name) || optsOutOfImplicitBroker(args)) return null;
    if (!(typeof args?.deviceId === "string" && args.deviceId)) return null;
    const probe = implicitBrokerProbeOptions(args || {});
    if (!probe) return implicitBrokerUnavailableResult("mobile-device-broker-implicit");
    const inventory = await brokerRpc({ ...probe, method: "broker.inventory" });
    if (!inventory.ok) return jsonResult({ ...inventory, routedBy: "mobile-device-broker-implicit" });
    const inventoryBackend = inferBrokerInventoryLifecycleBackend(inventory, args.deviceId);
    if (!inventoryBackend.ok) {
        if (inventoryBackend.error === "device-backend-not-found") {
            return jsonResult({ ok: false, error: "device-not-found", deviceId: args.deviceId, routedBy: "mobile-device-broker-implicit" });
        }
        return jsonResult({
            ok: false,
            error: inventoryBackend.error,
            deviceId: args.deviceId,
            matches: inventoryBackend.matches || [],
            routedBy: "mobile-device-broker-implicit",
        });
    }
    if (!["android-emulator", "android-device", "ios-simulator", "ios-device"].includes(inventoryBackend.backend)) {
        return jsonResult({
            ok: false,
            error: "unsupported-mobile-backend",
            deviceId: args.deviceId,
            actualBackend: inventoryBackend.backend,
            supportedBackends: ["android-emulator", "android-device", "ios-simulator", "ios-device"],
            routedBy: "mobile-device-broker-implicit",
        });
    }
    const requestedBackend = typeof args?.backend === "string" && args.backend ? args.backend : "";
    if (requestedBackend && requestedBackend !== inventoryBackend.backend) {
        return jsonResult({
            ok: false,
            error: "device-backend-mismatch",
            deviceId: args.deviceId,
            requestedBackend,
            actualBackend: inventoryBackend.backend,
            routedBy: "mobile-device-broker-implicit",
        });
    }
    if (BROKER_APPIUM_ROUTED_MOBILE_TOOLS.has(name)) {
        return handleBrokerMobileTool(name, {
            ...args,
            ...selectedBrokerProbeOptions(probe, inventory),
            backend: inventoryBackend.backend,
        });
    }
    const result = await brokerDeviceTool({
        ...args,
        ...selectedBrokerProbeOptions(probe, inventory),
        ...brokerDeviceToolExecutionTimeout(name, args),
        backend: inventoryBackend.backend,
        tool: name,
    });
    if (result.ok && result.result?.mcpResult?.content) return result.result.mcpResult;
    return jsonResult({ ...result, routedBy: "mobile-device-broker-implicit" });
}

async function handleBrokerMobileTool(name, args) {
    const deviceId = typeof args?.deviceId === "string" ? args.deviceId : "";
    let backend = args?.backend;
    if (!backend) {
        const probe = implicitBrokerProbeOptions(args || {}, { allowDefault: true });
        if (!probe) return implicitBrokerUnavailableResult("mobile-broker-appium");
        const inventory = await brokerRpc({ ...probe, method: "broker.inventory" });
        if (!inventory.ok) return jsonResult({ ...inventory, routedBy: "mobile-broker-appium" });
        backend = inferBrokerInventoryLifecycleBackend(inventory, deviceId);
        args = { ...args, ...selectedBrokerProbeOptions(probe, inventory) };
    }
    if (backend?.ok === false) {
        return jsonResult({
            ok: false,
            error: backend.error,
            deviceId,
            matches: backend.matches || [],
            routedBy: "mobile-broker-appium",
        });
    }
    const resolvedBackend = typeof backend === "string" ? backend : backend.backend;
    if (!["android-emulator", "android-device", "ios-simulator", "ios-device"].includes(resolvedBackend)) {
        return jsonResult({ ok: false, error: "unsupported-mobile-backend", deviceId });
    }
    const routeArgs = brokerRouteOptions(args);
    const appiumOptions = brokerAppiumOptions(routeArgs);
    if (name === "mobile_clear_app_data" && resolvedBackend === "ios-device") {
        return textResult(false, "mobile_clear_app_data is not supported by iOS physical devices");
    }
    if (BROKER_BACKEND_MOBILE_TOOLS.has(name)) {
        const result = await brokerDeviceTool({
            ...routeArgs,
            ...brokerDeviceToolExecutionTimeout(name, args),
            backend: resolvedBackend,
            tool: name,
        });
        if (result.ok && result.result?.mcpResult?.content) return result.result.mcpResult;
        return jsonResult({ ...result, routedBy: "mobile-device-broker" });
    }
    if (name === "mobile_session_status") {
        const result = await brokerAppium({
            ...appiumOptions,
            action: "status",
            backend: resolvedBackend,
            deviceId,
        });
        return jsonResult({ deviceId, ...result, routedBy: "mobile-broker-appium" });
    }
    const mapped = name === "mobile_wait_for_text" ? null : brokerMobileRequest(name, args || {}, resolvedBackend);
    if (mapped?.error) return textResult(false, mapped.error);
    const ensure = await brokerAppium({
        ...appiumOptions,
        action: "ensure-session",
        backend: resolvedBackend,
        deviceId,
        force: args?.force === true,
    });
    if (!ensure.ok) return jsonResult({ ...ensure, routedBy: "mobile-broker-appium" });

    if (name === "mobile_wait_for_text") {
        const text = args?.text;
        if (!text) return textResult(false, "mobile_wait_for_text requires text");
        const wait = createWaitBudget(args?.timeoutMs, args?.intervalMs);
        const timeoutMs = wait.timeoutMs;
        let observed = false;
        let lastSource = "";
        while (wait.remaining() > 0) {
            const request = await brokerAppium({
                ...selectedBrokerProbeOptions(appiumOptions, ensure),
                autolaunch: false,
                requestTimeoutMs: wait.requestTimeout(600000),
                action: "request",
                backend: resolvedBackend,
                deviceId,
                method: "GET",
                path: "/source",
            });
            if (!request.ok) return jsonResult({ ...request, routedBy: "mobile-broker-appium" });
            if (wait.remaining() <= 0) return textResult(false, "Appium wait deadline exhausted during observation");
            observed = true;
            lastSource = String(request.result?.response?.body?.value ?? "");
            if (lastSource.includes(text)) return jsonResult({ found: true, text, source: lastSource, provider: "broker-appium", backend: resolvedBackend, broker: request });
            await wait.pause();
        }
        if (!observed) return textResult(false, "Appium wait deadline exhausted before observation");
        return jsonResult({ found: false, text, source: lastSource, timeoutMs, provider: "broker-appium", backend: resolvedBackend });
    }

    if (name === "mobile_wait_for_app") {
        const wait = createWaitBudget(args?.timeoutMs, args?.intervalMs);
        const timeoutMs = wait.timeoutMs;
        let observed = false;
        let lastState = null;
        const expectedAppId = appIdForBackend(args, resolvedBackend);
        while (wait.remaining() > 0) {
            const request = await brokerAppium({
                ...selectedBrokerProbeOptions(appiumOptions, ensure),
                autolaunch: false,
                requestTimeoutMs: wait.requestTimeout(600000),
                action: "request",
                backend: resolvedBackend,
                deviceId,
                method: mapped.method,
                path: mapped.path,
                body: mapped.body,
            });
            if (!request.ok) return jsonResult({ ...request, routedBy: "mobile-broker-appium" });
            if (wait.remaining() <= 0) return textResult(false, "Appium wait deadline exhausted during observation");
            observed = true;
            lastState = request.result?.response?.body?.value ?? request.result?.response?.body ?? null;
            if (resolvedBackend.startsWith("ios")) {
                const activeBundleId = lastState?.bundleId ?? lastState?.bundleID ?? null;
                if (activeBundleId === expectedAppId) return jsonResult({ found: true, bundleId: expectedAppId, activeApp: lastState, provider: "broker-appium", backend: resolvedBackend, broker: request });
            } else if (Number(lastState) >= 3) {
                return jsonResult({ found: true, packageName: expectedAppId, appState: lastState, provider: "broker-appium", backend: resolvedBackend, broker: request });
            }
            await wait.pause();
        }
        if (!observed) return textResult(false, "Appium wait deadline exhausted before observation");
        return jsonResult({ found: false, appState: lastState, timeoutMs, provider: "broker-appium", backend: resolvedBackend });
    }

    const requests = mapped.requests || [mapped];
    let request = null;
    for (const item of requests) {
        request = await brokerAppium({
            ...appiumOptions,
            action: "request",
            backend: resolvedBackend,
            deviceId,
            method: item.method,
            path: item.path,
            body: item.body,
        });
        if (!request.ok) return jsonResult({ ...request, routedBy: "mobile-broker-appium" });
    }
    if (!request.ok) return jsonResult({ ...request, routedBy: "mobile-broker-appium" });
    if (name === "mobile_screenshot") {
        const value = request?.result?.response?.body?.value ?? request?.result?.response?.body?.screenshot;
        if (!value) return textResult(false, "Appium did not return screenshot data");
        return { content: [{ type: "image", data: String(value), mimeType: "image/png" }] };
    }
    const appId = appIdForBackend(args, resolvedBackend);
    return jsonResult(brokerMobilePayload(name, resolvedBackend, request, {
        requests: requests.length,
        ...(name === "mobile_open_url" ? { openedUrl: args.url } : {}),
        ...(name === "mobile_install_app" ? { installed: args.path } : {}),
        ...(name === "mobile_launch_app" ? { launched: appId } : {}),
        ...(name === "mobile_uninstall_app" ? { uninstalled: appId } : {}),
        ...(name === "mobile_stop_app" ? { stopped: appId } : {}),
        ...(name === "mobile_set_location" ? { location: { latitude: Number(args.latitude), longitude: Number(args.longitude) } } : {}),
    }));
}

const HYPER_V_LINUX_TOOLS = new Set([
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

async function maybeHandleHyperVLinuxVmTool(name, args = {}) {
    if (args?.backend !== "linux-vm" || !HYPER_V_LINUX_TOOLS.has(name) || optsOutOfImplicitBroker(args)) return null;
    const explicitHyperVBroker = args?.provider === "hyper-v"
        || wantsBrokerLifecycle(name, args)
        || wantsBrokerDeviceTool(name, args);
    if (explicitHyperVBroker) {
        return BROKER_LIFECYCLE_COMMANDS.has(name)
            ? handleBrokerLifecycleTool(name, args)
            : handleBrokerDeviceTool(name, args);
    }
    const probeArgs = name === "device_create"
        ? { ...(args || {}), port: args?.brokerPort }
        : args || {};
    const probe = implicitBrokerProbeOptions(probeArgs);
    if (!probe) return null;
    const backends = await brokerRpc({ ...probe, ...brokerDiscoveryExecutionTimeout(args), method: "broker.backends" });
    const advertised = backends.ok && Array.isArray(backends.result?.backends)
        ? backends.result.backends.find((backend) => backend?.name === "linux-vm" && backend?.provider === "hyper-v")
        : null;
    if (!advertised) return null;
    const route = { ...args, ...selectedBrokerProbeOptions(probe, backends), autolaunch: true };
    if (BROKER_LIFECYCLE_COMMANDS.has(name)) return handleBrokerLifecycleTool(name, route);
    return handleBrokerDeviceTool(name, route);
}

function directDeviceList() {
    return [
        currentDisplayTarget(),
        ...listAndroidDevices(),
        ...listAndroidRealDevices(),
        ...listIosDevices(),
        ...listIosRealDevices(),
        ...listWindowsDevices(),
        ...listWindowsVmDevices(),
        ...listMacosDevices(),
        ...listLinuxVmDevices(),
    ];
}

async function handleDeviceList(args = {}) {
    if (!optsOutOfImplicitBroker(args)) {
        const probe = implicitBrokerProbeOptions(args);
        if (probe) {
            const inventory = await brokerRpc({ ...args, ...probe, method: "broker.inventory" });
            if (!inventory.ok || !Array.isArray(inventory.result?.backends)) {
                return jsonResult({ ...inventory, routedBy: "device-list-broker-implicit" });
            }
            const failedBackend = inventory.result.backends.find((entry) => entry?.error);
            if (failedBackend) {
                return jsonResult({
                    ok: false,
                    error: failedBackend.error,
                    stateKey: failedBackend.stateKey,
                    routedBy: "device-list-broker-implicit",
                });
            }
            return jsonResult({
                ownerId: ownerId(),
                devices: [
                    currentDisplayTarget(),
                    ...inventory.result.backends.flatMap((entry) => Array.isArray(entry?.devices) ? entry.devices : []),
                ].filter((device) => !args.backend || device.backend === args.backend || (args.backend === CURRENT_DISPLAY_DEVICE_ID && device.id === CURRENT_DISPLAY_DEVICE_ID)),
                routedBy: "device-list-broker-implicit",
            });
        }
    }
    return jsonResult({ ownerId: ownerId(), devices: directDeviceList().filter((device) => !args.backend || device.backend === args.backend || (args.backend === CURRENT_DISPLAY_DEVICE_ID && device.id === CURRENT_DISPLAY_DEVICE_ID)), routedBy: "device-list-direct" });
}

function isCursorMove(name, args = {}) {
    return name === "device_cursor_position" && (args.x !== undefined || args.y !== undefined);
}

function unhandledDeviceToolResult(name, args) {
    if (!DEVICE_REQUIRED_TOOLS.has(name)) return null;
    const deviceId = args.deviceId;
    const detail = "Use devices to choose a device.";
    let diagnostic;
    if (deviceId === undefined) {
        diagnostic = { ok: false, error: "missing-device-id", detail };
    } else {
        // Read only this owner's stored targets; diagnosing an unsupported action
        // must not discover providers or turn an unreadable state into absence.
        const matches = new Set();
        if (deviceId === CURRENT_DISPLAY_DEVICE_ID) matches.add(CURRENT_DISPLAY_DEVICE_ID);
        for (const [stateKey, backend] of LIFECYCLE_STATE_BACKENDS) {
            if (readOwnerDevices(stateKey).some((device) => device.id === deviceId)) matches.add(backend);
        }
        if (listLinuxVmDevices({ strictState: true }).some((device) => device.id === deviceId)) matches.add("linux-vm");
        if (matches.size === 0) {
            diagnostic = { ok: false, error: "device-not-found", deviceId, detail };
        } else if (matches.size > 1) {
            diagnostic = { ok: false, error: "ambiguous-device-backend", deviceId, matches: [...matches] };
        } else {
            diagnostic = { ok: false, error: "device-tool-unsupported", tool: name, deviceId, backend: [...matches][0] };
        }
    }
    return textResult(false, JSON.stringify(diagnostic));
}

async function handleFilteredBackends(args, detail) {
    const result = await handleDeviceBackends(args, { detail });
    if (!args.backend || result.isError) return result;
    return { ...result, content: result.content.map(item => {
        if (item.type !== "text") return item;
        const value = JSON.parse(item.text);
        for (const key of ["backends", "localBackends"]) {
            if (Array.isArray(value[key])) value[key] = value[key].filter(backend => backend.name === args.backend);
        }
        if (Array.isArray(value.hostBackends?.backends)) value.hostBackends.backends = value.hostBackends.backends.filter(backend => backend.name === args.backend);
        return { ...item, text: JSON.stringify(value) };
    }) };
}

async function dispatchTool(name, rawArgs, options = {}) {
    const { region, ...args } = rawArgs || {};
    const startedAt = Date.now();
    const result = await dispatchDeviceTool(name, args, options);
    if (name === "device_start") return finishStartReadiness(result, args, startedAt,
        (probe, probeArgs) => dispatchDeviceTool(probe, probeArgs, options));
    return name === "device_screenshot" && region !== undefined ? cropScreenshotResult(result, region) : result;
}

async function dispatchDeviceTool(name, rawArgs, { detail = false } = {}) {
    const args = normalizeToolArgs(rawArgs, name);
    if (name === "device_list") return handleDeviceList(args);
    if (name === "device_inventory" && args.backend === undefined) {
        return availableDevices(backend => dispatchDeviceTool(name, { ...args, backend }, { detail }), { detail });
    }
    if (name === "device_backends") return handleFilteredBackends(args, detail);
    if (MOBILE_COMMON_OPERATIONS.has(name) && args.backend !== undefined) {
        const common = commonOperation(name, args.backend, args);
        if (common.error) return textResult(false, common.error);
    }
    if (name === "mobile_key"
        && !(typeof args.key === "string" && args.key.length > 0)
        && !(typeof args.keyCode === "number" && Number.isFinite(args.keyCode))) {
        return textResult(false, "mobile_key requires key or keyCode");
    }
    if (name === "mobile_wait_for_text" && !(typeof args.text === "string" && args.text.length > 0)) {
        return textResult(false, "mobile_wait_for_text requires text");
    }
    if (isCursorMove(name, args)) {
        if (!Number.isInteger(args.x) || args.x < 0 || !Number.isInteger(args.y) || args.y < 0) {
            return jsonResult({ ok: false, error: "device-cursor-coordinates-invalid", detail: "Provide both x and y as nonnegative screenshot pixels." });
        }
        if (args.deviceId === CURRENT_DISPLAY_DEVICE_ID && (args.backend === undefined || args.backend === CURRENT_DISPLAY_DEVICE_ID)) return handleDisplayTool("display_move", args);

    }
    if (args.deviceId !== undefined
        && (typeof args.deviceId !== "string" || !OWNER_DEVICE_ID_PATTERN.test(args.deviceId))) {
        return textResult(false, JSON.stringify({
            ok: false,
            error: "device-id-invalid",
            deviceId: typeof args.deviceId === "string" ? args.deviceId.slice(0, 128) : null,
        }, null, 2));
    }
    const policy = evaluateDestructivePolicy(name, args);
    if (!policy.ok) return policyDeniedResult(policy);

    const directTarget = optsOutOfImplicitBroker(args) && args.deviceId && args.deviceId !== CURRENT_DISPLAY_DEVICE_ID
        && name !== "device_create" && name !== "device_attach"
        ? inferLifecycleBackend(args.deviceId) : null;
    if (directTarget?.error === "ambiguous-device-backend") return jsonResult(directTarget);

    if (name === "device_list_files" && args.deviceId === CURRENT_DISPLAY_DEVICE_ID) return jsonResult({ ok: false, error: "list-files-unsupported", detail: "Current-display targets do not provide a filesystem adapter." });
    const hyperVLinuxResult = await maybeHandleHyperVLinuxVmTool(name, args);
    if (hyperVLinuxResult) return hyperVLinuxResult;

    const linuxVmManagementResult = await handleLinuxVmManagementTool(name, args);
    if (linuxVmManagementResult) return linuxVmManagementResult;

    const linuxVmResult = await handleLinuxVmTool(name, args);
    if (linuxVmResult) return linuxVmResult;

    if (wantsCurrentDisplayDevice(name, args)) {
        if (args.backend !== undefined && args.backend !== CURRENT_DISPLAY_DEVICE_ID) return jsonResult({ ok: false, error: "device-backend-mismatch", actualBackend: CURRENT_DISPLAY_DEVICE_ID });
        const common = commonOperation(name, CURRENT_DISPLAY_DEVICE_ID, args);
        if (common.error) return textResult(false, common.error);
        return handleCurrentDisplayDeviceTool(name, args);
    }

    if (wantsBrokerLifecycle(name, args)) return handleBrokerLifecycleTool(name, args);
    if (wantsBrokerDeviceTool(name, args)) return handleBrokerDeviceTool(name, args);
    if (wantsBrokerMobile(name, args)) return handleBrokerMobileTool(name, args);
    if (wantsBrokerPhysical(name, args)) return handleBrokerPhysicalTool(name, args);

    const implicitBrokerLifecycleResult = await maybeHandleImplicitBrokerLifecycleTool(name, args);
    if (implicitBrokerLifecycleResult) return implicitBrokerLifecycleResult;

    const implicitBrokerPhysicalResult = await maybeHandleImplicitBrokerPhysicalTool(name, args);
    if (implicitBrokerPhysicalResult) return implicitBrokerPhysicalResult;

    const implicitBrokerDeviceResult = await maybeHandleImplicitBrokerDeviceTool(name, args);
    if (implicitBrokerDeviceResult) return implicitBrokerDeviceResult;

    const implicitBrokerMobileResult = await maybeHandleImplicitBrokerMobileTool(name, args);
    if (implicitBrokerMobileResult) return implicitBrokerMobileResult;

    const explicitMismatch = explicitBackendMismatchResult(name, args);
    if (explicitMismatch) return explicitMismatch;

    if (MOBILE_COMMON_OPERATIONS.has(name)) {
        const inferred = directTarget || inferLifecycleBackend(args.deviceId);
        if (inferred.error === "ambiguous-device-backend") return jsonResult(inferred);
        const common = commonOperation(name, inferred.ok ? inferred.backend : args.backend, args);
        if (common.error) return textResult(false, common.error);
        name = common.name;
    }

    if (name === "device_list_files") {
        const owner = directTarget || inferLifecycleBackend(args.deviceId);
        if (!owner.ok) return unhandledDeviceToolResult(name, args) || jsonResult(owner);
        if (owner.backend === "ios-device") return jsonResult({ ok: false, error: "list-files-unsupported", detail: "The current Device Lab physical iOS adapter does not implement file listing.", deviceId: args.deviceId });
        if (owner.backend !== "ios-simulator") {
            const command = buildListFilesCommand(owner.backend, args);
            return listFilesFromExecResult(await dispatchTool("device_exec", { ...args, command }), args);
        }
    }
    const androidResult = await handleAndroidTool(name, args);
    if (androidResult) return androidResult;

    const androidRealResult = await handleAndroidRealTool(name, args);
    if (androidRealResult) return androidRealResult;

    const iosResult = await handleIosTool(name, args);
    if (iosResult) return iosResult;

    const iosRealResult = await handleIosRealTool(name, args);
    if (iosRealResult) return iosRealResult;

    const windowsResult = await handleWindowsTool(name, args);
    if (windowsResult) return windowsResult;

    const macosResult = await handleMacosTool(name, args);
    if (macosResult) return macosResult;

    const displayResult = await handleDisplayTool(name, args);
    if (displayResult) return displayResult;

    return unhandledDeviceToolResult(name, args) || textResult(false, `Unknown tool: ${name}`);
}

async function handleRunFlow(args, options) {
    return runDeviceFlow(args, options, {
        toolInputError, flowOperationAllowed, toolOperation,
        flowStepArguments, normalizePublicToolArgs, withBrokerOperation, dispatchTool,
        evaluateDestructivePolicy, policyDeniedResult, summarizeToolResult, actionResult,
        unexpectedError: (message) => textResult(false, message),
        textFailure: (message) => textResult(false, message),
        renderFlow: (value, { toolName, detail }) => flowJsonResult(detail ? value : compactToolValue(toolName, value), { detail }),
    });
}

async function handleDeviceRunFlow(args, options) {
    return handleRunFlow(args, { toolName: "device_run_flow", toolAllowed: (name) => DEVICE_FLOW_ALLOWED_TOOLS.has(name), ...options });
}

export async function startServer() {
    const server = new Server(
        { name: "device-lab-mcp", version: "0.1.0" },
        { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name: publicName, arguments: rawArgs = {} } = request.params;
        const inputError = toolInputError(publicName, rawArgs);
        if (inputError) {
            if (inputError === `${publicName} requires confirmDestructive:true`) {
                return policyDeniedResult(evaluateDestructivePolicy(toolOperation(publicName, rawArgs), rawArgs));
            }
            return jsonResult({ ok: false, error: inputError });
        }
        const name = toolOperation(publicName, rawArgs);
        const args = normalizePublicToolArgs(publicName, rawArgs);
        const result = await withBrokerOperation(async () => {
            try {
                const policy = evaluateDestructivePolicy(name, args);
                if (!policy.ok) return policyDeniedResult(policy);

                switch (name) {

                    case "device_broker_status":
                        return jsonResult(await brokerStatus(args));

                    case "device_run_flow":
                        return handleDeviceRunFlow(args, { detail: rawArgs?.detail === true });

                    default: {
                        return dispatchTool(name, args, { detail: rawArgs?.detail === true });
                    }
                }
            } catch (err) {
                return textResult(false, `Unexpected error: ${err.message}`);
            }
        });
        return name === "device_run_flow"
            ? result : actionResult(publicName, name, result, { detail: rawArgs?.detail === true });
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
}
