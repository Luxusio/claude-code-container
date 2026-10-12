import { describe, expect, it, vi } from "vitest";
import { createDeviceRequest } from "../../../device-lab-mcp/src/application/device-request.mjs";
import type { DeviceArguments, DeviceRequestPorts } from "../../../device-lab-mcp/src/ports/device-request.d.mts";

import { presentBrokerTool, imageResult, presentActiveAppWait } from "../../../device-lab-mcp/src/device-request-presenter.mjs";
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
        observeActiveApp: unexpected,
        presentActiveAppWait: outcome => {
            let selected: OpaqueResult = jsonReply(null);
            presentActiveAppWait(outcome,
                value => { selected = jsonReply(value); return { content: [] }; },
                (_ok, text) => { selected = { selection: "text", value: text }; return { content: [] }; });
            return selected;
        },
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
        expect(refused.selection).toBe("text");
        expect(typeof refused.value).toBe("string");
        expect(JSON.parse(String(refused.value))).toMatchObject({
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

describe("semantic active-app waits", () => {
    function waiting(backend = "ios-simulator") {
        const args = { backend, deviceId: "owned-phone", broker: true, bundleId: "com.example.Test", packageName: "com.example.Test", timeoutMs: 100, intervalMs: 10 };
        const ports = requestPorts("mobile_wait_for_app", args);
        let remaining = 100;
        ports.brokerAppium = vi.fn(async () => ({ ok: true, selected: { host: "selected-broker", port: 43123 } }));
        ports.createWaitBudget = () => ({ timeoutMs: 100, remaining: () => remaining, requestTimeout: maximum => Math.min(maximum, remaining), pause: async () => { remaining = 0; } });
        const broker = { ok: true, result: { diagnostic: "opaque-native-receipt" } };
        ports.observeActiveApp = vi.fn(async () => ({ kind: "observed" as const, activeAppId: "com.example.Test", foreground: false, receipt: { broker, appState: { bundleID: "com.example.Test" } } }));
        return { ports, args, broker, expire: () => { remaining = 0; }, run: () => createDeviceRequest(ports).dispatch("mobile_wait_for_app", args) };
    }

    it("matches iOS identity independently of foreground and preserves native receipt presentation", async () => {
        const fixture = waiting();
        await expect(fixture.run()).resolves.toEqual({ selection: "json", value: { found: true, bundleId: "com.example.Test", activeApp: { bundleID: "com.example.Test" }, provider: "broker-appium", backend: "ios-simulator", broker: fixture.broker } });
        expect(fixture.ports.observeActiveApp).toHaveBeenCalledWith(expect.objectContaining({ backend: "ios-simulator", expectedAppId: "com.example.Test", hostCandidates: ["selected-broker"], port: 43123, autolaunch: false, requestTimeoutMs: 100 }));
        expect(fixture.ports.brokerAppium).toHaveBeenCalledTimes(1);
        expect(fixture.ports.handleAndroidTool).not.toHaveBeenCalled();
    });

    it("keeps strict iOS matching and presents the last unmatched state", async () => {
        const fixture = waiting();
        fixture.args.bundleId = "123";
        fixture.ports.observeActiveApp = async () => ({ kind: "observed", activeAppId: 123, foreground: true, receipt: { broker: fixture.broker, appState: { bundleId: 123 } } });
        await expect(fixture.run()).resolves.toEqual({ selection: "json", value: { found: false, appState: { bundleId: 123 }, timeoutMs: 100, provider: "broker-appium", backend: "ios-simulator" } });
    });

    it("uses Android foreground facts without requiring iOS identity", async () => {
        const fixture = waiting("android-device");
        fixture.ports.observeActiveApp = async () => ({ kind: "observed", activeAppId: null, foreground: true, receipt: { broker: fixture.broker, appState: "3" } });
        await expect(fixture.run()).resolves.toEqual({ selection: "json", value: { found: true, packageName: "com.example.Test", appState: "3", provider: "broker-appium", backend: "android-device", broker: fixture.broker } });
    });

    it.each([false, true])("fails the first observation immediately even for local exhaustion=%s", async localBudgetExhausted => {
        const fixture = waiting();
        const receipt = { ok: false, error: "native-observation-refused", selected: { host: "selected-broker", port: 43123 } };
        fixture.ports.observeActiveApp = vi.fn(async () => ({ kind: "failed" as const, localBudgetExhausted, receipt }));
        await expect(fixture.run()).resolves.toEqual({ selection: "json", value: { ...receipt, routedBy: "mobile-broker-appium" } });
        expect(fixture.ports.observeActiveApp).toHaveBeenCalledTimes(1);
        expect(fixture.ports.handleAndroidTool).not.toHaveBeenCalled();
    });

    it.each([false, true])("distinguishes provider failure from local exhaustion after observation (%s)", async localBudgetExhausted => {
        const fixture = waiting();
        fixture.ports.createWaitBudget = () => ({ timeoutMs: 100, remaining: () => 50, requestTimeout: () => 50, pause: async () => {} });
        const receipt = { ok: false, error: "native-observation-refused" };
        fixture.ports.observeActiveApp = vi.fn()
            .mockResolvedValueOnce({ kind: "observed", activeAppId: "other", foreground: false, receipt: { broker: fixture.broker, appState: { bundleId: "other" } } })
            .mockResolvedValueOnce({ kind: "failed", localBudgetExhausted, receipt });
        await expect(fixture.run()).resolves.toEqual({ selection: "json", value: localBudgetExhausted
            ? { found: false, appState: { bundleId: "other" }, timeoutMs: 100, provider: "broker-appium", backend: "ios-simulator" }
            : { ...receipt, routedBy: "mobile-broker-appium" } });
        expect(fixture.ports.observeActiveApp).toHaveBeenCalledTimes(2);
    });

    it("reports deadline before observation without dispatching a probe", async () => {
        const fixture = waiting();
        fixture.expire();
        await expect(fixture.run()).resolves.toEqual({ selection: "text", value: "Appium wait deadline exhausted before observation" });
        expect(fixture.ports.observeActiveApp).not.toHaveBeenCalled();
    });

    it("does not dispatch when the remaining request budget is zero", async () => {
        const fixture = waiting();
        fixture.ports.createWaitBudget = () => ({ timeoutMs: 100, remaining: () => 1, requestTimeout: () => 0, pause: async () => {} });
        await expect(fixture.run()).resolves.toEqual({ selection: "text", value: "Appium wait deadline exhausted before observation" });
        expect(fixture.ports.observeActiveApp).not.toHaveBeenCalled();
    });

    it("returns session refusal before active-app observation", async () => {
        const fixture = waiting();
        fixture.ports.brokerAppium = async () => ({ ok: false, error: "session-refused" });
        await expect(fixture.run()).resolves.toEqual({ selection: "json", value: { ok: false, error: "session-refused", routedBy: "mobile-broker-appium" } });
        expect(fixture.ports.observeActiveApp).not.toHaveBeenCalled();
    });

    it("gives deadline during observation precedence over a successful match", async () => {
        const fixture = waiting();
        fixture.ports.observeActiveApp = async () => { fixture.expire(); return { kind: "observed", activeAppId: "com.example.Test", foreground: true, receipt: { broker: fixture.broker, appState: { bundleId: "com.example.Test" } } }; };
        await expect(fixture.run()).resolves.toEqual({ selection: "text", value: "Appium wait deadline exhausted during observation" });
    });
});
