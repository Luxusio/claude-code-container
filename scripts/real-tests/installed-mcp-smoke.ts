#!/usr/bin/env node
import assert from "assert";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
    markExpectedFlowStepErrors,
    markExpectedToolError,
    parseToolPayload,
    withDeviceLabMcp,
} from "./device-lab-mcp-client.ts";
import { TOOLS as CANONICAL_TOOLS } from "../../device-lab-mcp/src/tools.mjs";

const DEFAULT_INSTALLED_SERVER = "/opt/ccc/device-lab-mcp/server.mjs";
const HIDDEN_LEGACY_TRANSPORT_KEYS = new Set([
    "broker",
    "viaBroker",
    "implicitBroker",
    "autolaunch",
    "hostCandidates",
    "launchHost",
    "port",
    "brokerPort",
    "timeoutMs",
    "rpcTimeoutMs",
    "launchTimeoutMs",
]);

export function installedMcpSmokeSample(toolName) {
    const direct = { implicitBroker: false };
    const brokerProbe = { hostCandidates: ["127.0.0.1"], port: 9, timeoutMs: 1, launchTimeoutMs: 1 };
    const androidId = "dist-android-smoke";
    const iosId = "dist-ios-smoke";
    const windowsId = "dist-windows-smoke";
    const macosId = "dist-macos-smoke";
    const linuxId = "dist-linux-smoke";
    const byName = {
        device_backends: { ...direct },
        device_broker_status: { ...brokerProbe },
        device_list: {},
        device_inventory: { ...direct, backend: "android-emulator" },
        device_image_list: { backend: "linux-vm" },
        device_image_import: { backend: "linux-vm", name: "Missing image smoke", sourcePath: "missing-smoke.qcow2" },
        device_wireless: { backend: "android-device", action: "status", timeoutMs: 1 },
        display_current: {},
        display_screenshot: {},
        display_click: { x: 1, y: 1, button: "left" },
        display_double_click: { x: 1, y: 1, button: "left" },
        display_key: { key: "Escape" },
        display_type: { text: "" },
        display_scroll: { x: 1, y: 1, direction: "down", amount: 1 },
        display_cursor_position: {},
        device_create: { ...direct, backend: "android-emulator", name: "Dist Android smoke", deviceId: androidId },
        device_attach: { ...direct, backend: "android-device", name: "Dist attach smoke", serial: "SERIAL-SMOKE" },
        device_detach: { ...brokerProbe, broker: true, deviceId: "missing-detach-smoke" },
        device_delete: { ...brokerProbe, broker: true, backend: "android-emulator", deviceId: "missing-delete-smoke", confirmDestructive: true },
        device_start: { ...direct, backend: "android-emulator", deviceId: androidId, waitForBoot: false, bootTimeoutMs: 1 },
        device_stop: { ...direct, backend: "android-emulator", deviceId: androidId },
        device_reboot: { backend: "linux-vm", deviceId: linuxId },
        device_status: { ...direct, backend: "android-emulator", deviceId: androidId },
        device_disk_materialize: { backend: "linux-vm", deviceId: linuxId },
        device_target_list: { backend: "linux-vm" },
        device_readiness_probe: { backend: "linux-vm", deviceId: linuxId },
        device_session_open: { backend: "linux-vm", deviceId: linuxId },
        device_workspace_sync: { backend: "linux-vm", deviceId: linuxId },
        device_artifacts_export: { backend: "linux-vm", deviceId: linuxId },
        device_guest_agent_status: { backend: "linux-vm", deviceId: linuxId, timeoutMs: 1 },
        device_guest_agent_provision: { backend: "linux-vm", deviceId: linuxId, timeoutMs: 1 },
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
        device_snapshot_list: { ...direct, backend: "linux-vm", deviceId: linuxId },
        device_snapshot_create: { ...direct, backend: "macos-vm", deviceId: macosId, snapshotName: "smoke" },
        device_snapshot_restore: { ...direct, backend: "macos-vm", deviceId: macosId, snapshotName: "smoke", force: true, confirmDestructive: true },
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
    return byName[toolName] || {};
}

function contentText(result) {
    return result?.content?.map((item) => item?.text || "").join("\n") || "";
}

function recordDispatchMismatch(failures, name, result) {
    const text = contentText(result);
    if (/Unknown tool:|Unexpected error:/.test(text)) failures.push(`${name} dispatch mismatch: ${text}`);
}

function schemaProperties(inputSchema) {
    return inputSchema?.properties || {};
}

function resolveServerPath(options: any = {}) {
    return options.serverPath
        || process.env.CCC_REAL_DEVICE_LAB_MCP_SERVER
        || DEFAULT_INSTALLED_SERVER;
}

export async function runInstalledMcpSmoke(options: any = {}) {
    const serverPath = resolveServerPath(options);
    assert.strictEqual(existsSync(serverPath), true, `device-lab MCP server not found: ${serverPath}`);

    const homeDir = options.homeDir || mkdtempSync(join(tmpdir(), "ccc-installed-device-lab-mcp-"));
    const cleanupHome = !options.homeDir;
    try {
        const result = await withDeviceLabMcp(async ({ client, callTool }) => {
            const failures = [];
            const listed = await client.listTools();
            const toolNames = listed.tools.map((tool) => tool.name);
            const canonicalToolNames = CANONICAL_TOOLS.map((tool) => tool.name);
            if (JSON.stringify(toolNames) !== JSON.stringify(canonicalToolNames)) {
                failures.push(`advertised tool names mismatch: listed=${JSON.stringify(toolNames)} canonical=${JSON.stringify(canonicalToolNames)}`);
            }
            const canonicalSchemas = CANONICAL_TOOLS.map((tool) => tool.inputSchema);
            const listedSchemas = listed.tools.map((tool) => tool.inputSchema);
            if (JSON.stringify(listedSchemas) !== JSON.stringify(canonicalSchemas)) {
                failures.push("advertised tool schemas do not match canonical device-lab MCP tools");
            }
            if (!toolNames.includes("device_backends")) failures.push("device_backends must be advertised");
            if (!toolNames.includes("device_status")) failures.push("device_status must be advertised");
            if (!toolNames.includes("device_run_flow")) failures.push("device_run_flow must be advertised");

            const backendsResult = await callTool("device_backends", { implicitBroker: false });
            recordDispatchMismatch(failures, "device_backends", backendsResult);
            const backends = backendsResult?.isError ? {} : parseToolPayload(backendsResult);
            const currentDisplay = backends.backends?.find((backend) => backend?.name === "x11-current-display");
            if (!currentDisplay) failures.push("x11-current-display backend must be advertised");
            if (currentDisplay && !currentDisplay.capabilities?.includes("device_status")) {
                failures.push("x11-current-display must expose device_status alias capability");
            }

            const statusResult = await callTool("device_status", { deviceId: "x11-current-display" });
            recordDispatchMismatch(failures, "device_status", statusResult);
            if (statusResult?.isError) {
                failures.push(`device_status current-display alias returned isError=true: ${contentText(statusResult)}`);
            } else {
                const status = parseToolPayload(statusResult);
                if (status.id !== "x11-current-display") failures.push(`device_status returned id=${JSON.stringify(status.id)}`);
                if (status.kind !== "display") failures.push(`device_status returned kind=${JSON.stringify(status.kind)}`);
                if (status.backend !== "x11") failures.push(`device_status returned backend=${JSON.stringify(status.backend)}`);
            }

            const flowResult = await callTool("device_run_flow", {
                steps: [{ tool: "device_status", arguments: { deviceId: "x11-current-display" } }],
            });
            recordDispatchMismatch(failures, "device_run_flow", flowResult);
            if (flowResult?.isError) {
                failures.push(`device_run_flow current-display alias returned isError=true: ${contentText(flowResult)}`);
            } else {
                const flow = parseToolPayload(flowResult);
                if (flow.ok !== true) failures.push(`device_run_flow returned ok=${JSON.stringify(flow.ok)}`);
                if (flow.results?.[0]?.tool !== "device_status") failures.push("device_run_flow did not run device_status");
                if (flow.results?.[0]?.isError !== false) failures.push("device_run_flow device_status step returned an error");
            }

            for (const args of [
                { implicitBroker: false, backend: "android-emulator", name: "Dist Android smoke", deviceId: "dist-android-smoke" },
                { implicitBroker: false, backend: "ios-simulator", name: "Dist iOS smoke", deviceId: "dist-ios-smoke" },
                { implicitBroker: false, backend: "windows-sandbox", name: "Dist Windows smoke", deviceId: "dist-windows-smoke" },
                { implicitBroker: false, backend: "macos-vm", name: "Dist macOS smoke", deviceId: "dist-macos-smoke", image: "missing-image" },
            ]) {
                markExpectedToolError(await callTool("device_create", args));
            }

            const missingRequiredSamples = listed.tools.flatMap((tool) => {
                const required = Array.isArray(tool.inputSchema?.required)
                    ? tool.inputSchema.required.map(String)
                    : [];
                const sample = installedMcpSmokeSample(tool.name);
                return required
                    .filter((key) => !(key in sample))
                    .map((key) => `${tool.name} missing required sample key ${key}`);
            });
            failures.push(...missingRequiredSamples);

            const missingAnyOfSamples = listed.tools.flatMap((tool) => {
                const anyOf = Array.isArray(tool.inputSchema?.anyOf)
                    ? tool.inputSchema.anyOf
                        .map((item) => Array.isArray(item?.required) ? item.required.map(String) : [])
                        .filter((required) => required.length > 0)
                    : [];
                const sample = installedMcpSmokeSample(tool.name);
                if (anyOf.length === 0 || anyOf.some((required) => required.every((key) => key in sample))) return [];
                return [`${tool.name} sample does not satisfy anyOf ${JSON.stringify(anyOf)}`];
            });
            failures.push(...missingAnyOfSamples);

            const unknownSampleKeys = listed.tools.flatMap((tool) => {
                const properties = schemaProperties(tool.inputSchema);
                const sample = installedMcpSmokeSample(tool.name);
                return Object.keys(sample)
                    .filter((key) => !(key in properties) && !HIDDEN_LEGACY_TRANSPORT_KEYS.has(key))
                    .map((key) => `${tool.name} sample has unknown key ${key}`);
            });
            failures.push(...unknownSampleKeys);

            let publicDispatchTools = 0;
            for (const tool of listed.tools) {
                const result = await callTool(tool.name, installedMcpSmokeSample(tool.name));
                recordDispatchMismatch(failures, tool.name, result);
                markExpectedToolError(result);
                if (tool.name === "mobile_run_flow") {
                    markExpectedFlowStepErrors(result, ["mobile_session_status"]);
                }
                publicDispatchTools += 1;
            }

            if (failures.length > 0) {
                throw new Error(failures.join("\n"));
            }

            return {
                status: "PASS",
                serverPath,
                tools: toolNames.length,
                publicDispatchTools,
                currentDisplayAliases: (currentDisplay?.capabilities || []).filter((capability) => capability.startsWith("device_")),
            };
        }, {
            name: options.name || "ccc-installed-device-lab-mcp-smoke",
            serverPath,
            env: {
                HOME: homeDir,
                PATH: process.env.PATH || "",
                ...(options.env || {}),
            },
        });
        return result;
    } finally {
        if (cleanupHome) rmSync(homeDir, { recursive: true, force: true });
    }
}

function usage() {
    return [
        "Usage: node scripts/real-tests/installed-mcp-smoke.ts [server.mjs]",
        "",
        `Default server: ${DEFAULT_INSTALLED_SERVER}`,
        "Override with CCC_REAL_DEVICE_LAB_MCP_SERVER or a positional path.",
    ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const arg = process.argv.slice(2).find((value) => value !== "--help" && value !== "-h");
    if (process.argv.includes("--help") || process.argv.includes("-h")) {
        console.log(usage());
        process.exit(0);
    }
    runInstalledMcpSmoke({ serverPath: arg }).then((result) => {
        console.log(JSON.stringify(result, null, 2));
    }).catch((error) => {
        console.error(error?.message || String(error));
        process.exit(1);
    });
}
