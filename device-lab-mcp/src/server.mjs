import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { androidBackend, handleAndroidTool, listAndroidDevices } from "./backends/android.mjs";
import { androidRealBackend, handleAndroidRealTool, listAndroidRealDevices } from "./backends/android-device.mjs";
import { handleIosTool, iosBackend, listIosDevices } from "./backends/ios-simulator.mjs";
import { handleIosRealTool, iosRealBackend, listIosRealDevices } from "./backends/ios-device.mjs";
import { handleMacosTool, listMacosDevices, macosBackend } from "./backends/macos-vm.mjs";
import { handleWindowsTool, listWindowsDevices, windowsBackend } from "./backends/windows-sandbox.mjs";
import { ownerId } from "./context.mjs";
import { currentDisplayTarget, handleDisplayTool, x11Available } from "./display/x11.mjs";
import { jsonResult, textResult } from "./responses.mjs";
import { TOOLS } from "./tools.mjs";

function heavyBackend(name, host, capabilities) {
    return {
        name,
        host,
        creatable: true,
        available: false,
        lazy: true,
        status: "planned",
        reason: "Backend adapter is not implemented in this foundation slice.",
        capabilities,
    };
}

const FLOW_MAX_STEPS = 50;
const FLOW_ALLOWED_DEVICE_TOOLS = new Set(["device_status", "device_screenshot"]);

function flowStepTool(step) {
    return step?.tool || step?.name || "";
}

function flowToolAllowed(name) {
    if (name === "mobile_run_flow") return false;
    if (name.startsWith("mobile_")) return true;
    return FLOW_ALLOWED_DEVICE_TOOLS.has(name);
}

function summarizeContentItem(item) {
    if (item.type === "image") {
        return {
            type: "image",
            mimeType: item.mimeType || null,
            bytes: item.data ? Buffer.byteLength(item.data, "base64") : 0,
        };
    }
    if (item.type === "text") {
        const text = item.text || "";
        try {
            return { type: "json", value: JSON.parse(text) };
        } catch {
            return { type: "text", text };
        }
    }
    return { type: item.type || "unknown" };
}

function summarizeToolResult(result) {
    return {
        isError: Boolean(result?.isError),
        content: (result?.content || []).map(summarizeContentItem),
    };
}

async function dispatchTool(name, args) {
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

    return textResult(false, `Unknown tool: ${name}`);
}

async function handleMobileRunFlow(args) {
    const { steps, stopOnError = true } = args;
    if (!Array.isArray(steps)) return textResult(false, "mobile_run_flow requires steps array");
    if (steps.length > FLOW_MAX_STEPS) return textResult(false, `mobile_run_flow supports at most ${FLOW_MAX_STEPS} steps`);

    const results = [];
    for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index] || {};
        const tool = flowStepTool(step);
        const label = step.label || tool || `step-${index + 1}`;
        if (!tool) {
            const summary = { index, label, isError: true, error: "Flow step requires tool or name" };
            results.push(summary);
            if (stopOnError) return jsonResult({ ok: false, stoppedAt: index, results });
            continue;
        }
        if (!flowToolAllowed(tool)) {
            const summary = { index, label, tool, isError: true, error: `mobile_run_flow does not allow step tool: ${tool}` };
            results.push(summary);
            if (stopOnError) return jsonResult({ ok: false, stoppedAt: index, results });
            continue;
        }

        const result = await dispatchTool(tool, step.arguments || {});
        const summary = { index, label, tool, ...summarizeToolResult(result) };
        results.push(summary);
        if (summary.isError && stopOnError) return jsonResult({ ok: false, stoppedAt: index, results });
    }

    return jsonResult({ ok: results.every((result) => !result.isError), results });
}

export async function startServer() {
    const server = new Server(
        { name: "device-lab-mcp", version: "0.1.0" },
        { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args = {} } = request.params;

        try {
            switch (name) {
                case "device_backends":
                    return jsonResult({
                        ownerId: ownerId(),
                        backends: [
                            {
                                name: "x11-current-display",
                                host: "container",
                                creatable: false,
                                available: x11Available(),
                                lazy: false,
                                capabilities: currentDisplayTarget().capabilities,
                            },
                            androidBackend(),
                            androidRealBackend(),
                            iosBackend(),
                            iosRealBackend(),
                            windowsBackend(),
                            macosBackend(),
                        ],
                    });

                case "device_list":
                    return jsonResult({
                        ownerId: ownerId(),
                        devices: [
                            currentDisplayTarget(),
                            ...listAndroidDevices(),
                            ...listAndroidRealDevices(),
                            ...listIosDevices(),
                            ...listIosRealDevices(),
                            ...listWindowsDevices(),
                            ...listMacosDevices(),
                        ],
                    });

                case "mobile_run_flow":
                    return handleMobileRunFlow(args);

                default: {
                    return dispatchTool(name, args);
                }
            }
        } catch (err) {
            return textResult(false, `Unexpected error: ${err.message}`);
        }
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
}
