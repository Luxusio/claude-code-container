#!/usr/bin/env node
import assert from "assert";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
    markExpectedFlowStepErrors,
    markExpectedToolError,
    markExpectedInputError,
    parseToolPayload,
    withDeviceLabMcp,
} from "./device-lab-mcp-client.ts";
import { TOOLS as CANONICAL_TOOLS, createToolName } from "../../device-lab-mcp/src/tools.mjs";
import { toolInputError } from "../../device-lab-mcp/src/tool-arguments.mjs";

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
        devices: {},
        list_files: { ...direct, deviceId: androidId, path: "/", limit: 2 },
        list_images: { },
        import_image: { name: "Missing image smoke", sourcePath: "missing-smoke.qcow2" },
        wireless: { backend: "android-device", action: "status", timeoutMs: 1 },
        create_android_emulator: { ...direct, name: "Dist Android smoke", avdName: "dist-existing-smoke", deviceId: androidId },
        create_ios_simulator: { ...direct, name: "Dist iOS smoke", deviceType: "missing-type", runtime: "missing-runtime" },
        create_windows_vm: { broker: true, hostCandidates: ["127.0.0.1"], brokerPort: 9, timeoutMs: 1, launchTimeoutMs: 1, name: "Dist Windows VM smoke", dryRun: true },
        create_windows_sandbox: { ...direct, name: "Dist Windows Sandbox smoke" },
        create_linux_vm: { ...direct, name: "Dist Linux smoke", sourceImage: "/missing/image.qcow2" },
        create_macos_vm: { ...direct, name: "Dist macOS smoke", image: "missing-image" },
        attach: { ...direct, backend: "android-device", name: "Dist attach smoke", serial: "SERIAL-SMOKE" },
        detach: { ...brokerProbe, broker: true, deviceId: "missing-detach-smoke" },
        delete: { ...brokerProbe, broker: true, deviceId: "missing-delete-smoke", confirmDestructive: true },
        start: { ...direct, deviceId: androidId, waitForBoot: false, bootTimeoutMs: 1 },
        stop: { ...direct, deviceId: androidId },
        reboot: { deviceId: linuxId },
        status: { ...direct, deviceId: androidId },
        exec: { ...direct, deviceId: androidId, command: "true", timeoutMs: 1 },
        screenshot: { ...direct, deviceId: androidId, timeoutMs: 1 },
        scroll: { ...direct, deviceId: windowsId, x: 1, y: 1, direction: "down", amount: 1, timeoutMs: 1 },
        move: { deviceId: "x11-current-display", x: 1, y: 1 },
        cursor_position: { ...direct, deviceId: windowsId, timeoutMs: 1 },
        focus_window: { ...direct, deviceId: windowsId, handle: "123", timeoutMs: 1 },
        window_list: { ...direct, deviceId: windowsId, timeoutMs: 1 },
        ui: { ...direct, deviceId: windowsId, maxDepth: 1, maxNodes: 1, timeoutMs: 1 },
        snapshot: { action: "list", ...direct, deviceId: linuxId },
        record_video: { action: "start", ...direct, deviceId: androidId, remotePath: "/sdcard/smoke.mp4", timeLimitSec: 1 },
        upload: { ...direct, deviceId: androidId, localPath: "/tmp/missing-smoke.txt", remotePath: "/sdcard/missing-smoke.txt", timeoutMs: 1 },
        download: { ...direct, deviceId: androidId, remotePath: "/sdcard/missing-smoke.txt", localPath: "/tmp/device-lab-smoke-download.txt", timeoutMs: 1 },
        reset: { ...direct, deviceId: iosId, confirmDestructive: true },
        install_app: { ...direct, deviceId: androidId, path: "/tmp/missing-smoke.apk" },
        launch_app: { ...direct, deviceId: androidId, appId: "com.example.smoke" },
        click: { count: 1, ...direct, deviceId: androidId, x: 1, y: 1 },
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
        set_network: { deviceId: androidId, wifi: true, airplaneMode: false, confirmDestructive: true },
        clipboard: { ...direct, deviceId: androidId, text: "smoke" },
        wait_for_text: { ...direct, deviceId: androidId, text: "smoke", timeoutMs: 1, intervalMs: 50 },
        wait_for_app: { ...direct, deviceId: androidId, appId: "com.example.smoke", timeoutMs: 1, intervalMs: 50 },
        run_flow: { steps: [{ tool: "status", arguments: { ...direct, deviceId: androidId } }] },
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
    return Object.assign({}, inputSchema?.properties, ...(inputSchema?.oneOf || []).map(schemaProperties));
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
        const result = await withDeviceLabMcp(async ({ client, callTool: rawCallTool }) => {
            // This diagnostic smoke checks provider capability and state details.
            const callTool = (name: string, args: Record<string, any> = {}) => rawCallTool(name, { detail: true, ...args });
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
            if (!toolNames.includes("devices")) failures.push("devices must be advertised");
            if (!toolNames.includes("status")) failures.push("status must be advertised");
            if (!toolNames.includes("run_flow")) failures.push("run_flow must be advertised");

            const backendsResult = await callTool("devices", { view: "backends", detail: true, implicitBroker: false });
            recordDispatchMismatch(failures, "devices", backendsResult);
            const backends = backendsResult?.isError ? {} : parseToolPayload(backendsResult);
            const currentDisplay = backends.backends?.find((backend) => backend?.name === "x11-current-display");
            if (!currentDisplay) failures.push("x11-current-display backend must be advertised");
            if (currentDisplay && !currentDisplay.capabilities?.includes("status")) {
                failures.push("x11-current-display must expose status capability");
            }

            const ownedResult = await callTool("devices", { view: "owned", implicitBroker: false });
            recordDispatchMismatch(failures, "devices", ownedResult);
            if (ownedResult.isError || !Array.isArray(parseToolPayload(ownedResult).devices)) {
                failures.push(`devices view:owned returned no owned device list: ${contentText(ownedResult)}`);
            }

            const statusResult = await callTool("status", { detail: true, deviceId: "x11-current-display" });
            recordDispatchMismatch(failures, "status", statusResult);
            if (statusResult?.isError) {
                failures.push(`status current-display returned isError=true: ${contentText(statusResult)}`);
            } else {
                const status = parseToolPayload(statusResult);
                if (status.deviceId !== "x11-current-display") failures.push(`status returned id=${JSON.stringify(status.deviceId)}`);
                if (status.kind !== "display") failures.push(`status returned kind=${JSON.stringify(status.kind)}`);
                if (status.backend !== "x11") failures.push(`status returned backend=${JSON.stringify(status.backend)}`);
            }

            const flowResult = await callTool("run_flow", { detail: true,
                steps: [{ tool: "status", arguments: { deviceId: "x11-current-display" } }],
            });
            recordDispatchMismatch(failures, "run_flow", flowResult);
            if (flowResult?.isError) {
                failures.push(`run_flow current-display returned isError=true: ${contentText(flowResult)}`);
            } else {
                const flow = parseToolPayload(flowResult);
                if (flow.ok !== true) failures.push(`run_flow returned ok=${JSON.stringify(flow.ok)}`);
                if (flow.results?.[0]?.tool !== "status") failures.push("run_flow did not run status");
                if (flow.results?.[0]?.isError !== false) failures.push("run_flow status step returned an error");
            }

            for (const args of [
                { implicitBroker: false, backend: "android-emulator", name: "Dist Android smoke", deviceId: "dist-android-smoke" },
                { implicitBroker: false, backend: "ios-simulator", name: "Dist iOS smoke", deviceId: "dist-ios-smoke" },
                { implicitBroker: false, backend: "windows-sandbox", name: "Dist Windows smoke", deviceId: "dist-windows-smoke" },
                { implicitBroker: false, backend: "macos-vm", name: "Dist macOS smoke", image: "missing-image" },
            ]) {
                const { backend, ...input } = args;
                const response = backend === "macos-vm"
                    ? await callTool("create_macos_vm", { detail: true, ...input })
                    : await callTool(createToolName(backend), { detail: true, ...input });
                if (backend === "android-emulator" || backend === "ios-simulator") {
                    const expected = toolInputError(createToolName(backend), input);
                    assert.strictEqual(typeof expected, "string");
                    markExpectedInputError(response, expected);
                } else if (backend === "macos-vm") {
                    assert.strictEqual(response?.isError, true, "missing macOS image unexpectedly created a device");
                    const diagnostic = contentText(response);
                    let code = "";
                    try { code = JSON.parse(diagnostic).error || ""; } catch { /* Native provider refusals can be plain text. */ }
                    assert.ok(code === "macos-tart-clone-failed"
                        || /^macOS VM backend missing prerequisites: .+/.test(diagnostic)
                        || /(?:missing-image.*(?:does not exist|not found|no such)|(?:does not exist|not found|no such).*missing-image)/i.test(diagnostic),
                    "macOS smoke must report the missing image or prerequisites rejection");
                    markExpectedToolError(response);
                } else markExpectedToolError(response);
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
                const result = await callTool(tool.name, { detail: true, ...installedMcpSmokeSample(tool.name) });
                recordDispatchMismatch(failures, tool.name, result);
                markExpectedToolError(result);
                if (tool.name === "run_flow") {
                    markExpectedFlowStepErrors(result, ["status"]);
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
                currentDisplayCapabilities: currentDisplay?.capabilities || [],
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
