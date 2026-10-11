import { describe, expect, it, vi } from "vitest";
import { createDeviceRequest } from "../../../device-lab-mcp/src/application/device-request.mjs";
import type { DeviceArguments, DeviceRequestPorts } from "../../../device-lab-mcp/src/ports/device-request.d.mts";

import { presentBrokerTool, imageResult } from "../../../device-lab-mcp/src/device-request-presenter.mjs";
type OpaqueResult = { selection: "json" | "text" | "image"; value: unknown };
function jsonReply(value: unknown): OpaqueResult { return { selection: "json", value }; }

function requestPorts(operation: string, normalized: DeviceArguments = {}): DeviceRequestPorts<OpaqueResult> {
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
        textResult: (_ok, text) => ({ selection: "text", value: text }),
        presentBrokerTool: (_receipt, value) => jsonReply(value),
        imageResult: value => ({ selection: "image", value }),
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
    } satisfies DeviceRequestPorts<OpaqueResult>;
    return ports;
}

describe("shared device request admission", () => {
    it("returns argument and destructive peer refusals before broker or provider work", async () => {
        const ports = requestPorts("device_status");
        ports.toolInputError = () => "deviceId determines the backend; omit backend";
        const application = createDeviceRequest(ports);

        const invalid = await application.request("status", { deviceId: "owned-phone", backend: "windows-sandbox", broker: true });
        expect(invalid.selection).toBe("json");
        expect(invalid.value).toEqual({ ok: false, error: "deviceId determines the backend; omit backend" });

        ports.toolInputError = () => "delete requires confirmDestructive:true";
        ports.toolOperation = () => "device_delete";
        ports.evaluateDestructivePolicy = () => ({ ok: false, error: "destructive-action-confirmation-required", actions: ["device-delete"] });
        const refused = await application.request("delete", { deviceId: "owned-phone", confirmDestructive: false, broker: true });
        expect(refused.selection).toBe("json");
        expect(refused.value).toMatchObject({
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
        expect(result.selection).toBe("text");
        expect(String(result.value)).toContain("Unexpected error: display provider rejected");
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
        expect(result.selection).toBe("text");
        expect(String(result.value)).toContain("Unexpected error: readiness probe rejected");
    });

    it("returns a public MCP error when flow execution rejects", async () => {
        const ports = requestPorts("device_run_flow", { deviceId: "owned-phone", steps: [{ tool: "screenshot" }] });
        ports.runDeviceFlow = async () => { throw new Error("flow execution rejected"); };
        const result = await createDeviceRequest(ports).request("run_flow", { deviceId: "owned-phone", steps: [{ tool: "screenshot" }] });
        expect(result.selection).toBe("text");
        expect(String(result.value)).toContain("Unexpected error: flow execution rejected");
    });
});

function catalogPorts(normalized: DeviceArguments): DeviceRequestPorts<OpaqueResult> {
    const ports = requestPorts("device_backends", normalized);
    ports.ownerId = () => "owned";
    ports.currentDisplayTarget = () => ({ id: "x11-current-display", available: true, capabilities: [] });
    ports.androidDiscovery = ports.iosDiscovery = ports.iosRealDiscovery = () => ({});
    ports.androidBackend = () => ({ name: "android-emulator", host: "local" });
    ports.androidRealBackend = () => ({ name: "android-device", host: "local" });
    ports.iosBackend = () => ({ name: "ios-simulator", host: "local" });
    ports.iosRealBackend = () => ({ name: "ios-device", host: "local" });
    ports.windowsBackend = () => ({ name: "windows-sandbox", host: "local" });
    ports.windowsVmBackend = () => ({ name: "windows-vm", host: "local" });
    ports.macosBackend = () => ({ name: "macos-vm", host: "local" });
    ports.linuxVmBackend = () => ({ name: "linux-vm", host: "container" });
    ports.brokerStatus = async () => ({ ok: true, available: true });
    return ports;
}

describe("opaque request selection and actual native presenters", () => {
    it("filters successful direct catalogs before opaque presentation", async () => {
        const result = await createDeviceRequest(catalogPorts({ implicitBroker: false, backend: "android-device" })).dispatch("device_backends", { implicitBroker: false, backend: "android-device" });
        expect(result).toMatchObject({ selection: "json", value: { source: "direct-provider", backends: [{ name: "android-device" }] } });
    });
    it("filters successful broker catalogs while retaining their metadata", async () => {
        const ports = catalogPorts({ broker: true, backend: "android-device" });
        ports.brokerRpc = async () => ({ ok: true, result: { backends: [{ name: "android-device" }, { name: "windows-vm" }], startsDevices: false } });
        const result = await createDeviceRequest(ports).dispatch("device_backends", { broker: true, backend: "android-device" });
        expect(result).toMatchObject({ selection: "json", value: { source: "host-broker-provider-discovery", backends: [{ name: "android-device" }], hostBackends: { startsDevices: false, backends: [{ name: "android-device" }] } } });
    });
    it("retains unfiltered local diagnostics when broker discovery fails", async () => {
        const ports = catalogPorts({ broker: true, backend: "android-device" }); ports.brokerRpc = async () => ({ ok: false, error: "discovery refused" });
        const result = await createDeviceRequest(ports).dispatch("device_backends", { broker: true, backend: "android-device" }, { detail: true });
        expect(result).toMatchObject({ selection: "json", value: { ok: false, backends: expect.arrayContaining([{ name: "linux-vm", host: "container" }]), localBackends: expect.arrayContaining([{ name: "windows-vm", host: "local" }]) } });
    });
    it("selects native image/error envelopes only on successful broker receipts", () => {
        const renderJson = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }], isError: true });
        const image = imageResult({ data: "image-bytes", mimeType: "image/png" });
        expect(image).toEqual({ content: [{ type: "image", data: "image-bytes", mimeType: "image/png" }] });
        expect(presentBrokerTool({ ok: true, result: { mcpResult: image } }, { fallback: true }, renderJson)).toEqual(image);
        const failure = { content: [{ type: "text", text: "native refusal" }], isError: true };
        expect(presentBrokerTool({ ok: true, result: { mcpResult: failure } }, {}, renderJson)).toEqual(failure);
        expect(presentBrokerTool({ ok: false, result: { mcpResult: image } }, { ok: false, error: "broker refused" }, renderJson)).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining("broker refused") }] });
    });
    it("passes selected broker fallback facts to the opaque presenter", async () => {
        const ports = requestPorts("device_inventory", { backend: "windows-sandbox", broker: true });
        ports.brokerDeviceTool = async () => ({ ok: false, error: "inventory refused" });
        await expect(createDeviceRequest(ports).dispatch("device_inventory", {})).resolves.toEqual({
            selection: "json", value: { ok: false, error: "inventory refused", routedBy: "device-readonly-broker" },
        });
    });
    it("admits Appium image facts through the private mobile dispatch and rejects missing data", async () => {
        const ports = requestPorts("mobile_screenshot", { backend: "android-device", deviceId: "owned-phone", broker: true });
        let data: unknown = "image-bytes";
        ports.brokerAppium = async args => args.action === "ensure-session" ? { ok: true } : { ok: true, result: { response: { body: { value: data } } } };
        const app = createDeviceRequest(ports);
        const args = { backend: "android-device", deviceId: "owned-phone", broker: true };
        await expect(app.dispatch("mobile_screenshot", args)).resolves.toEqual({ selection: "image", value: { data: "image-bytes", mimeType: "image/png" } });
        data = "";
        await expect(app.dispatch("mobile_screenshot", args)).resolves.toEqual({ selection: "text", value: "Appium did not return screenshot data" });
    });
});

function requiredPresenters(ports: DeviceRequestPorts<OpaqueResult>) {
    const { presentBrokerTool: broker, ...withoutBroker } = ports;
    // @ts-expect-error native broker presentation is a required capability
    createDeviceRequest<OpaqueResult>(withoutBroker);
    const { imageResult: image, ...withoutImage } = ports;
    // @ts-expect-error native image presentation is a required capability
    createDeviceRequest<OpaqueResult>(withoutImage);
    // @ts-expect-error opaque broker results are presented synchronously
    createDeviceRequest<OpaqueResult>({ ...ports, presentBrokerTool: async () => ({ selection: "json", value: null }) });
    // @ts-expect-error opaque image results are presented synchronously
    createDeviceRequest<OpaqueResult>({ ...ports, imageResult: async () => ({ selection: "image", value: null }) });
    void [broker, image];
}
void requiredPresenters;
