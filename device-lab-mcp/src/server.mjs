import { presentBrokerTool, presentActiveAppWait, imageResult } from "./device-request-presenter.mjs";
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
import { brokerAppium, observeActiveApp, brokerCommand, brokerDeviceTool, brokerPhysical, brokerRpc, brokerStatus, implicitBrokerProbeOptions, isLocalObservationBudgetExhaustion, withBrokerOperation } from "./broker.mjs";
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
import { runMcpDeviceFlow as runDeviceFlow } from "./device-flow-adapter.mjs";
import { createDeviceRequest } from "./application/device-request.mjs";
export { HYPER_V_LINUX_GUI_TIMEOUT_MS, HYPER_V_IMAGE_ACQUIRE_RPC_TIMEOUT_MS, HYPER_V_LIFECYCLE_RPC_BUFFER_MS, HYPER_V_CLEANUP_RESERVE_MS, HYPER_V_CREATE_RPC_TIMEOUT_MS, HYPER_V_HOST_LOCK_WAIT_MS, HYPER_V_PROVIDER_LIFECYCLE_TIMEOUT_MS, HYPER_V_MAX_BOOT_TIMEOUT_MS, MAX_DEVICE_HELPER_TIMEOUT_MS, MAX_DEVICE_OPERATION_TIMEOUT_MS, brokerDeviceToolExecutionTimeout } from "./domain/device-request.mjs";

const deviceRequest = createDeviceRequest({
    availableDevices,
    cropScreenshotResult,
    finishStartReadiness,
    startBootTimeoutMs,
    buildListFilesCommand,
    listFilesFromExecResult,
    androidBackend,
    androidDiscovery,
    handleAndroidTool,
    listAndroidDevices,
    androidRealBackend,
    handleAndroidRealTool,
    listAndroidRealDevices,
    handleIosTool,
    iosBackend,
    iosDiscovery,
    listIosDevices,
    handleIosRealTool,
    iosRealBackend,
    iosRealDiscovery,
    listIosRealDevices,
    handleMacosTool,
    listMacosDevices,
    macosBackend,
    handleLinuxVmManagementTool,
    handleLinuxVmTool,
    linuxVmBackend,
    listLinuxVmDevices,
    handleWindowsTool,
    listWindowsDevices,
    windowsBackend,
    listWindowsVmDevices,
    windowsVmBackend,
    brokerAppium,
    observeActiveApp,
    brokerCommand,
    brokerDeviceTool,
    brokerPhysical,
    brokerRpc,
    brokerStatus,
    implicitBrokerProbeOptions,
    isLocalObservationBudgetExhaustion,
    withBrokerOperation,
    ownerId,
    currentDisplayTarget,
    handleDisplayTool,
    evaluateDestructivePolicy,
    flowJsonResult,
    jsonResult,
    presentBrokerTool: (receipt, value) => presentBrokerTool(receipt, value, jsonResult),
    presentActiveAppWait: outcome => presentActiveAppWait(outcome, jsonResult, textResult),
    imageResult,
    textResult,
    compactToolValue,
    OWNER_DEVICE_ID_PATTERN,
    readOwnerDevices,
    toolOperation,
    flowOperationAllowed,
    actionResult,
    flowStepArguments,
    normalizeToolArgs,
    normalizePublicToolArgs,
    toolInputError,
    createWaitBudget,
    runDeviceFlow,
    OPERATION_TOOLS,
    DEVICE_FLOW_TOOL_NAMES,
    now: () => Date.now(),
    encodeBase64: text => Buffer.from(text, "utf8").toString("base64"),
    decodeBase64: text => Buffer.from(text, "base64").toString("utf8"),
});

export function brokerLifecycleExecutionTimeout(args) {
    return deviceRequest.brokerLifecycleExecutionTimeout(args);
}

export async function startServer() {
    const server = new Server(
        { name: "device-lab-mcp", version: "0.1.0" },
        { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args = {} } = request.params;
        return deviceRequest.request(name, args);
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
}
