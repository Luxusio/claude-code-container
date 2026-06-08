import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { androidBackend, handleAndroidTool, listAndroidDevices } from "./backends/android.mjs";
import { handleIosTool, iosBackend, listIosDevices } from "./backends/ios-simulator.mjs";
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
                            iosBackend(),
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
                            ...listIosDevices(),
                            ...listWindowsDevices(),
                            ...listMacosDevices(),
                        ],
                    });

                default: {
                    const androidResult = await handleAndroidTool(name, args);
                    if (androidResult) return androidResult;

                    const iosResult = await handleIosTool(name, args);
                    if (iosResult) return iosResult;

                    const windowsResult = await handleWindowsTool(name, args);
                    if (windowsResult) return windowsResult;

                    const macosResult = await handleMacosTool(name, args);
                    if (macosResult) return macosResult;

                    const displayResult = await handleDisplayTool(name, args);
                    if (displayResult) return displayResult;

                    return textResult(false, `Unknown tool: ${name}`);
                }
            }
        } catch (err) {
            return textResult(false, `Unexpected error: ${err.message}`);
        }
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
}
