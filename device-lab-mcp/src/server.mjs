import { presentBrokerReceipt, presentBrokerTool, presentBrokerLifecycle, presentBackendCatalog, presentMobileObservation, presentSourceWait, presentActiveAppWait } from "./device-request-presenter.mjs";
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
import { brokerObservation, observeBrokerStatus, observeBrokerBackends, observeBrokerInventory, invokeBrokerLifecycle, ensureMobileSession, observeMobileSessionStatus, executeMobileEffect, observeActiveApp, brokerDeviceTool, brokerPhysical, implicitBrokerProbeOptions, withBrokerOperation } from "./broker.mjs";
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
import { isBrokerMacosTartImageCreate, brokerMacosTartCreateRpcTimeoutMs } from "@ccc/device-lab/device-lab/domain/lifecycle/macos-vm-lifecycle.js";
export { HYPER_V_LINUX_GUI_TIMEOUT_MS, HYPER_V_IMAGE_ACQUIRE_RPC_TIMEOUT_MS, HYPER_V_LIFECYCLE_RPC_BUFFER_MS, HYPER_V_CLEANUP_RESERVE_MS, HYPER_V_CREATE_RPC_TIMEOUT_MS, HYPER_V_HOST_LOCK_WAIT_MS, HYPER_V_PROVIDER_LIFECYCLE_TIMEOUT_MS, HYPER_V_MAX_BOOT_TIMEOUT_MS, MAX_DEVICE_HELPER_TIMEOUT_MS, MAX_DEVICE_OPERATION_TIMEOUT_MS, brokerDeviceToolExecutionTimeout } from "./domain/device-request.mjs";

const deviceRequest = createDeviceRequest({
    availableDevices,
    cropScreenshotResult,
    finishStartReadiness,
    startBootTimeoutMs,
    listFilesFromExecResult,
    invokeBrokerListFiles: async (args, backend) => {
        const command = buildListFilesCommand(backend, args);
        const {path, limit, bundleId, containerType, ...execArgs} = args;
        return brokerObservation(await brokerDeviceTool({...execArgs,backend,tool:'device_exec',command}));
    },
    listDirectDeviceFiles: async (args, backend) => {
        const command = buildListFilesCommand(backend, args);
        const execute = backend === 'android-emulator' ? handleAndroidTool
            : backend === 'android-device' ? handleAndroidRealTool
            : backend === 'linux-vm' ? handleLinuxVmTool
            : backend === 'windows-sandbox' || backend === 'windows-vm' ? handleWindowsTool
            : handleMacosTool;
        const result = await execute('device_exec', {...args,command});
        return listFilesFromExecResult(result || textResult(false, JSON.stringify({ok:false,error:'device-tool-unsupported',tool:'device_exec',deviceId:args.deviceId,backend})), args);
    },
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
    observeBrokerStatus,
    observeBrokerBackends,
    observeBrokerInventory,
    invokeBrokerLifecycle,
    ensureMobileSession,
    observeMobileSessionStatus,
    executeMobileEffect,
    observeActiveApp,
    brokerDeviceTool: async args => brokerObservation(await brokerDeviceTool(args)),
    brokerPhysical: async args => brokerObservation(await brokerPhysical(args)),
    implicitBrokerProbeOptions,
    macosTartCreateRpcTimeoutMs: args => isBrokerMacosTartImageCreate(args) ? brokerMacosTartCreateRpcTimeoutMs(args) : null,
    withBrokerOperation,
    ownerId,
    currentDisplayTarget,
    handleDisplayTool,
    evaluateDestructivePolicy,
    flowJsonResult,
    jsonResult,
    presentBrokerReceipt: (receipt, extra) => presentBrokerReceipt(receipt, extra, jsonResult),
    presentBrokerLifecycle: (receipt, value) => presentBrokerLifecycle(receipt, value, jsonResult),
    presentBackendCatalog: value => presentBackendCatalog(value, jsonResult),
    presentMobileObservation: (name, backend, observation, extra) => presentMobileObservation(name, backend, observation, extra, jsonResult, textResult),
    presentSourceWait: outcome => presentSourceWait(outcome, jsonResult, textResult),
    presentBrokerTool: (receipt, value) => presentBrokerTool(receipt, value, jsonResult),
    presentActiveAppWait: outcome => presentActiveAppWait(outcome, jsonResult, textResult),
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
