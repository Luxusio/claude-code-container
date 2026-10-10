import { describe, expect, it, vi } from "vitest";
import { createDeviceRequest } from "../../../device-lab-mcp/src/application/device-request.mjs";
import type { DeviceRequestPorts } from "../../../device-lab-mcp/src/ports/device-request.d.mts";
import { flowStepArguments, normalizePublicToolArgs, normalizeToolArgs, toolInputError } from "../../../device-lab-mcp/src/tool-arguments.mjs";
import { DEVICE_FLOW_TOOL_NAMES, flowOperationAllowed, toolOperation } from "../../../device-lab-mcp/src/tools.mjs";
import { TOOLS as OPERATION_TOOLS } from "../../../device-lab-mcp/src/operation-tools.mjs";
import { evaluateDestructivePolicy } from "../../../device-lab-mcp/src/policy/destructive.mjs";
import { actionResult } from "../../../device-lab-mcp/src/action-output.mjs";
import { compactToolValue } from "../../../device-lab-mcp/src/public-output.mjs";
import { flowJsonResult, jsonResult, textResult } from "@ccc/device-lab/providers/responses.mjs";

function requestPorts(): DeviceRequestPorts {
    const unexpected = (): never => { throw new Error("Request reached work before admission"); };
    const brokerCommand = vi.fn(unexpected);
    const handleAndroidTool = vi.fn(unexpected);
    const ports = {
        OWNER_DEVICE_ID_PATTERN: /^owned-/,
        OPERATION_TOOLS,
        DEVICE_FLOW_TOOL_NAMES,
        now: () => 0,
        encodeBase64: text => Buffer.from(text, "utf8").toString("base64"),
        decodeBase64: text => Buffer.from(text, "base64").toString("utf8"),
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
        normalizeToolArgs,
        normalizePublicToolArgs,
        toolInputError,
        toolOperation,
        flowOperationAllowed,
        flowStepArguments,
        evaluateDestructivePolicy,
        jsonResult,
        textResult,
        flowJsonResult,
        compactToolValue,
        actionResult,
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
    it("rejects invalid target selectors and unconfirmed deletion before broker or provider work", async () => {
        const ports = requestPorts();
        const application = createDeviceRequest(ports);

        const invalid = await application.request("status", { deviceId: "owned-phone", backend: "windows-sandbox", broker: true });
        expect(invalid.isError).toBe(true);
        expect(JSON.parse(invalid.content[0].text!)).toEqual({ ok: false, error: "deviceId determines the backend; omit backend" });

        const refused = await application.request("delete", { deviceId: "owned-phone", confirmDestructive: false, broker: true });
        expect(refused.isError).toBe(true);
        expect(JSON.parse(refused.content[0].text!)).toMatchObject({
            ok: false,
            policy: { error: "destructive-action-confirmation-required", actions: ["device-delete"] },
        });
        expect(ports.brokerCommand).not.toHaveBeenCalled();
        expect(ports.handleAndroidTool).not.toHaveBeenCalled();
    });

    it("returns a public MCP error when an asynchronous provider rejects", async () => {
        const ports = requestPorts();
        ports.OWNER_DEVICE_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
        ports.handleLinuxVmManagementTool = () => null;
        ports.handleLinuxVmTool = () => null;
        ports.handleDisplayTool = async () => { throw new Error("display provider rejected"); };
        const result = await createDeviceRequest(ports).request("click", { deviceId: "x11-current-display", x: 1, y: 2 });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("Unexpected error: display provider rejected");
    });

    it("returns a public MCP error when start readiness rejects", async () => {
        const ports = requestPorts();
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
        ports.handleAndroidTool = async () => jsonResult({ device: { id: "owned-phone", backend: "android-emulator", status: "running" } });
        ports.finishStartReadiness = async () => { throw new Error("readiness probe rejected"); };
        const result = await createDeviceRequest(ports).request("start", { deviceId: "owned-phone", implicitBroker: false, waitForBoot: true });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("Unexpected error: readiness probe rejected");
    });

    it("returns a public MCP error when flow execution rejects", async () => {
        const ports = requestPorts();
        ports.runDeviceFlow = async () => { throw new Error("flow execution rejected"); };
        const result = await createDeviceRequest(ports).request("run_flow", { deviceId: "owned-phone", steps: [{ tool: "screenshot" }] });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("Unexpected error: flow execution rejected");
    });
});
