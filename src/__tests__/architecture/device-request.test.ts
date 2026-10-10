import { describe, expect, it, vi } from "vitest";
import { createDeviceRequest } from "../../../device-lab-mcp/src/application/device-request.mjs";
import type { DeviceArguments, DeviceRequestPorts, DeviceResult } from "../../../device-lab-mcp/src/ports/device-request.d.mts";

function jsonReply(value: unknown): DeviceResult {
    return {
        content: [{ type: "text", text: JSON.stringify(value) }],
        isError: typeof value === "object" && value !== null && "ok" in value && value.ok === false,
    };
}

function requestPorts(operation: string, normalized: DeviceArguments = {}): DeviceRequestPorts {
    const unexpected = (): never => { throw new Error("Request reached work before admission"); };
    const brokerCommand = vi.fn(unexpected);
    const handleAndroidTool = vi.fn(unexpected);
    const ports = {
        OWNER_DEVICE_ID_PATTERN: /^owned-/,
        OPERATION_TOOLS: [
            { name: "device_status", inputSchema: { required: ["deviceId"] } },
            { name: "device_start", inputSchema: { required: ["deviceId"] } },
            { name: "device_click", inputSchema: { required: ["deviceId"] } },
        ],
        DEVICE_FLOW_TOOL_NAMES: ["screenshot"],
        now: () => 0,
        encodeBase64: unexpected,
        decodeBase64: unexpected,
        ownerId: unexpected,
        readOwnerDevices: unexpected,
        currentDisplayTarget: unexpected,
        listAndroidDevices: unexpected,
        listAndroidRealDevices: unexpected,
        listIosDevices: unexpected,
        listIosRealDevices: unexpected,
        listMacosDevices: unexpected,
        listLinuxVmDevices: unexpected,
        listWindowsDevices: unexpected,
        listWindowsVmDevices: unexpected,
        androidDiscovery: unexpected,
        iosDiscovery: unexpected,
        iosRealDiscovery: unexpected,
        androidBackend: unexpected,
        androidRealBackend: unexpected,
        iosBackend: unexpected,
        iosRealBackend: unexpected,
        macosBackend: unexpected,
        linuxVmBackend: unexpected,
        windowsBackend: unexpected,
        windowsVmBackend: unexpected,
        handleAndroidTool,
        handleAndroidRealTool: unexpected,
        handleIosTool: unexpected,
        handleIosRealTool: unexpected,
        handleMacosTool: unexpected,
        handleLinuxVmManagementTool: unexpected,
        handleLinuxVmTool: unexpected,
        handleWindowsTool: unexpected,
        handleDisplayTool: unexpected,
        brokerStatus: unexpected,
        brokerCommand,
        brokerDeviceTool: unexpected,
        brokerPhysical: unexpected,
        brokerAppium: unexpected,
        brokerRpc: unexpected,
        implicitBrokerProbeOptions: unexpected,
        isLocalObservationBudgetExhaustion: unexpected,
        withBrokerOperation: operation => operation(),
        normalizeToolArgs: () => normalized,
        normalizePublicToolArgs: () => normalized,
        toolInputError: () => null,
        toolOperation: () => operation,
        flowOperationAllowed: () => true,
        flowStepArguments: (_tool, _flow, step) => step,
        evaluateDestructivePolicy: () => ({ ok: true }),
        jsonResult: jsonReply,
        textResult: (ok, text) => ({ content: [{ type: "text", text }], isError: !ok }),
        flowJsonResult: jsonReply,
        compactToolValue: (_name, value) => value,
        actionResult: (_name, _operation, result) => result,
        buildListFilesCommand: unexpected,
        listFilesFromExecResult: unexpected,
        availableDevices: unexpected,
        startBootTimeoutMs: unexpected,
        finishStartReadiness: unexpected,
        cropScreenshotResult: unexpected,
        createWaitBudget: unexpected,
        runDeviceFlow: unexpected,
    } satisfies DeviceRequestPorts;
    return ports;
}

describe("shared device request admission", () => {
    it("returns argument and destructive peer refusals before broker or provider work", async () => {
        const ports = requestPorts("device_status");
        ports.toolInputError = () => "deviceId determines the backend; omit backend";
        const application = createDeviceRequest(ports);

        const invalid = await application.request("status", { deviceId: "owned-phone", backend: "windows-sandbox", broker: true });
        expect(invalid.isError).toBe(true);
        expect(JSON.parse(invalid.content[0].text ?? "")).toEqual({ ok: false, error: "deviceId determines the backend; omit backend" });

        ports.toolInputError = () => "delete requires confirmDestructive:true";
        ports.toolOperation = () => "device_delete";
        ports.evaluateDestructivePolicy = () => ({ ok: false, error: "destructive-action-confirmation-required", actions: ["device-delete"] });
        const refused = await application.request("delete", { deviceId: "owned-phone", confirmDestructive: false, broker: true });
        expect(refused.isError).toBe(true);
        expect(JSON.parse(refused.content[0].text ?? "")).toMatchObject({
            ok: false,
            policy: { error: "destructive-action-confirmation-required", actions: ["device-delete"] },
        });
        expect(ports.brokerCommand).not.toHaveBeenCalled();
        expect(ports.handleAndroidTool).not.toHaveBeenCalled();
    });

    it("returns a public MCP error when an asynchronous provider rejects", async () => {
        const ports = requestPorts("device_click", { deviceId: "x11-current-display", x: 1, y: 2 });
        ports.OWNER_DEVICE_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
        ports.handleLinuxVmManagementTool = () => null;
        ports.handleLinuxVmTool = () => null;
        ports.handleDisplayTool = async () => { throw new Error("display provider rejected"); };
        const result = await createDeviceRequest(ports).request("click", { deviceId: "x11-current-display", x: 1, y: 2 });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("Unexpected error: display provider rejected");
    });

    it("returns a public MCP error when start readiness rejects", async () => {
        const ports = requestPorts("device_start", { deviceId: "owned-phone", implicitBroker: false, waitForBoot: true });
        ports.listAndroidDevices = () => [{ id: "owned-phone", backend: "android-emulator" }];
        ports.listAndroidRealDevices = () => [];
        ports.listIosDevices = () => [];
        ports.listIosRealDevices = () => [];
        ports.listMacosDevices = () => [];
        ports.listLinuxVmDevices = () => [];
        ports.listWindowsDevices = () => [];
        ports.listWindowsVmDevices = () => [];
        ports.handleLinuxVmManagementTool = () => null;
        ports.handleLinuxVmTool = () => null;
        ports.handleAndroidTool = async () => jsonReply({ device: { id: "owned-phone", backend: "android-emulator", status: "running" } });
        ports.finishStartReadiness = async () => { throw new Error("readiness probe rejected"); };
        const result = await createDeviceRequest(ports).request("start", { deviceId: "owned-phone", implicitBroker: false, waitForBoot: true });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("Unexpected error: readiness probe rejected");
    });

    it("returns a public MCP error when flow execution rejects", async () => {
        const ports = requestPorts("device_run_flow", { deviceId: "owned-phone", steps: [{ tool: "screenshot" }] });
        ports.runDeviceFlow = async () => { throw new Error("flow execution rejected"); };
        const result = await createDeviceRequest(ports).request("run_flow", { deviceId: "owned-phone", steps: [{ tool: "screenshot" }] });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("Unexpected error: flow execution rejected");
    });
});
