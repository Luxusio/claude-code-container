import { describe, expect, it, vi } from "vitest";
import { createDeviceRequest } from "../../../device-lab-mcp/src/application/device-request.mjs";
import type { DeviceArguments, DeviceRequestPorts, MobileEffect } from "../../../device-lab-mcp/src/ports/device-request.d.mts";

import { presentBrokerTool, presentBackendCatalog, presentMobileObservation, presentSourceWait, imageResult, presentActiveAppWait } from "../../../device-lab-mcp/src/device-request-presenter.mjs";
type OpaqueResult = { selection: "json" | "text" | "image"; value: unknown };
function jsonReply(value: unknown): OpaqueResult { return { selection: "json", value }; }
const nativeJson = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const nativeText = (_ok: boolean, text: string) => ({ content: [{ type: "text", text }] });
function opaqueJson(result: { content: { text?: string }[] }): OpaqueResult { return jsonReply(JSON.parse(result.content[0].text ?? "null")); }

function requestPorts(operation: string, normalized: DeviceArguments = {}): DeviceRequestPorts<OpaqueResult> {
    const unexpected = (): never => { throw new Error("Request reached work before admission"); };
    const invokeBrokerLifecycle = vi.fn(unexpected);
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
        observeBrokerStatus: unexpected,
        observeBrokerBackends: unexpected,
        observeBrokerInventory: unexpected,
        invokeBrokerLifecycle,
        brokerDeviceTool: unexpected,
        brokerPhysical: unexpected,
        ensureMobileSession: unexpected,
        observeMobileSessionStatus: unexpected,
        executeMobileEffect: unexpected,
        observeActiveApp: unexpected,
        presentActiveAppWait: outcome => {
            let selected: OpaqueResult = jsonReply(null);
            presentActiveAppWait(outcome,
                value => { selected = jsonReply(value); return { content: [] }; },
                (_ok, text) => { selected = { selection: "text", value: text }; return { content: [] }; });
            return selected;
        },
        implicitBrokerProbeOptions: unexpected,
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
        presentBrokerReceipt: (receipt, extra) => jsonReply({ ...(receipt as Record<string, unknown>), ...extra }),
        presentBrokerTool: (receipt, selection) => opaqueJson(presentBrokerTool(receipt, selection, nativeJson)),
        presentBrokerLifecycle: (receipt, selection) => jsonReply({ ...(receipt as Record<string, unknown>), ...selection }),
        presentBackendCatalog: value => opaqueJson(presentBackendCatalog(value, nativeJson)),
        presentMobileObservation: (name, backend, observation, extra) => {
            const result = presentMobileObservation(name, backend, observation, extra, nativeJson, nativeText);
            if (name === "mobile_screenshot") return observation.screenshotData
                ? { selection: "image", value: { data: result.content[0].data, mimeType: result.content[0].mimeType } }
                : { selection: "text", value: result.content[0].text };
            return opaqueJson(result);
        },
        presentSourceWait: outcome => {
            const result = presentSourceWait(outcome, nativeJson, nativeText);
            return outcome.kind === "deadline-before" || outcome.kind === "deadline-during"
                ? { selection: "text", value: result.content[0].text } : opaqueJson(result);
        },
        flowJsonResult: jsonReply,
        compactToolValue: (_name, value) => value,
        actionResult: (_name, _operation, result) => result,
        invokeBrokerListFiles: unexpected,
        listDirectDeviceFiles: unexpected,
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
        expect(ports.invokeBrokerLifecycle).not.toHaveBeenCalled();
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

describe("creation broker endpoint selection without native effects", () => {
    function routing(args: DeviceArguments) {
        const ports = requestPorts("device_create", args);
        ports.handleLinuxVmManagementTool = () => null;
        ports.handleLinuxVmTool = () => null;
        ports.invokeBrokerLifecycle = vi.fn(async () => ({ ok: true, receipt: { ok: true, result: { device: { id: "fixture-returned-id" } } } }));
        ports.implicitBrokerProbeOptions = vi.fn(options => ({ hostCandidates: ["127.0.0.1"], port: options.port ?? 23123, autolaunch: false, timeoutMs: 100 }));
        ports.observeBrokerBackends = vi.fn(async () => ({ ok: true, selection: { host: "127.0.0.1", port: 24123 }, backends: [{ name: "linux-vm", provider: "hyper-v" }], payloadReceipt: {}, receipt: { ok: true } }));
        return { ports, run: () => createDeviceRequest(ports).dispatchDevice("device_create", args) };
    }

    it("resolves the runtime endpoint for an explicit Hyper-V Linux provider", async () => {
        const f = routing({ backend: "linux-vm", provider: "hyper-v", name: "Runtime VM label" });
        await f.run();
        expect(f.ports.invokeBrokerLifecycle).toHaveBeenCalledTimes(1);
        expect(f.ports.invokeBrokerLifecycle).toHaveBeenCalledWith(expect.objectContaining({ port: 23123, hostCandidates: ["127.0.0.1"], backend: "linux-vm", command: "device_create", name: "Runtime VM label" }));
        expect(vi.mocked(f.ports.invokeBrokerLifecycle).mock.calls[0][0].devicePort).toBeUndefined();
        expect(f.ports.observeBrokerBackends).not.toHaveBeenCalled();
    });

    it("retains the observed endpoint for advertised automatic Hyper-V routing", async () => {
        const f = routing({ backend: "linux-vm", provider: "auto", name: "Advertised VM label", brokerPort: 23123, devicePort: 9902 });
        await f.run();
        expect(f.ports.observeBrokerBackends).toHaveBeenCalledWith(expect.objectContaining({ port: 23123 }));
        expect(f.ports.invokeBrokerLifecycle).toHaveBeenCalledWith(expect.objectContaining({ port: 24123, hostCandidates: ["127.0.0.1"], backend: "linux-vm", command: "device_create", devicePort: 9902 }));
    });

    it("preserves an explicitly configured VM broker port", async () => {
        const f = routing({ backend: "linux-vm", provider: "hyper-v", name: "Configured VM label", brokerPort: 25123 });
        await f.run();
        expect(f.ports.invokeBrokerLifecycle).toHaveBeenCalledWith(expect.objectContaining({ port: 25123 }));
        expect(vi.mocked(f.ports.invokeBrokerLifecycle).mock.calls[0][0].devicePort).toBeUndefined();
    });

    it.each(["windows-vm", "linux-vm", "macos-vm"])("never reinterprets a selected %s HTTP endpoint as a VM device port", async backend => {
        const f = routing({ backend, name: "Selected VM label", broker: true, port: 27123 });
        await f.run();
        expect(f.ports.invokeBrokerLifecycle).toHaveBeenCalledWith(expect.objectContaining({ port: 27123 }));
        expect(vi.mocked(f.ports.invokeBrokerLifecycle).mock.calls[0][0].devicePort).toBeUndefined();
    });

    it("keeps Android console and broker ports separate", async () => {
        const f = routing({ backend: "android-emulator", name: "Console fixture", broker: true, port: 5556, brokerPort: 26123 });
        await f.run();
        expect(f.ports.invokeBrokerLifecycle).toHaveBeenCalledWith(expect.objectContaining({ backend: "android-emulator", port: 26123, devicePort: 5556 }));
    });

    it("refuses an unavailable VM endpoint before any lifecycle invocation", async () => {
        const f = routing({ backend: "linux-vm", provider: "hyper-v", name: "Unavailable VM label" });
        f.ports.implicitBrokerProbeOptions = () => null;
        expect(await f.run()).toMatchObject({ selection: "json", value: { ok: false, error: "broker-runtime-unavailable" } });
        expect(f.ports.invokeBrokerLifecycle).not.toHaveBeenCalled();
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
    ports.observeBrokerStatus = async () => ({ ok: true, available: true, receipt: { ok: true, available: true } });
    return ports;
}

describe("opaque request selection and actual native presenters", () => {
    it("filters successful direct catalogs before opaque presentation", async () => {
        const result = await createDeviceRequest(catalogPorts({ implicitBroker: false, backend: "android-device" })).dispatch("device_backends", { implicitBroker: false, backend: "android-device" });
        expect(result).toMatchObject({ selection: "json", value: { source: "direct-provider", backends: [{ name: "android-device" }] } });
    });
    it("filters successful broker catalogs while retaining their metadata", async () => {
        const ports = catalogPorts({ broker: true, backend: "android-device" });
        const backends = [{ name: "android-device" }, { name: "windows-vm" }];
        ports.observeBrokerBackends = async () => ({ ok: true, backends, payloadReceipt: { backends, startsDevices: false }, receipt: { ok: true } });
        const result = await createDeviceRequest(ports).dispatch("device_backends", { broker: true, backend: "android-device" });
        expect(result).toMatchObject({ selection: "json", value: { source: "host-broker-provider-discovery", backends: [{ name: "android-device" }], hostBackends: { startsDevices: false, backends: [{ name: "android-device" }] } } });
    });
    it("retains unfiltered local diagnostics when broker discovery fails", async () => {
        const ports = catalogPorts({ broker: true, backend: "android-device" }); ports.observeBrokerBackends = async () => ({ ok: false, backends: null, devices: null, payloadReceipt: null, receipt: { ok: false, error: "discovery refused" } });
        const result = await createDeviceRequest(ports).dispatch("device_backends", { broker: true, backend: "android-device" }, { detail: true });
        expect(result).toMatchObject({ selection: "json", value: { ok: false, backends: expect.arrayContaining([{ name: "linux-vm", host: "container" }]), localBackends: expect.arrayContaining([{ name: "windows-vm", host: "local" }]) } });
    });
    it("selects native image/error envelopes only on successful broker receipts", () => {
        const renderJson = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }], isError: true });
        const image = imageResult({ data: "image-bytes", mimeType: "image/png" });
        expect(image).toEqual({ content: [{ type: "image", data: "image-bytes", mimeType: "image/png" }] });
        expect(presentBrokerTool({ ok: true, result: { mcpResult: image } }, {}, renderJson)).toEqual(image);
        const failure = { content: [{ type: "text", text: "native refusal" }], isError: true };
        expect(presentBrokerTool({ ok: true, result: { mcpResult: failure } }, {}, renderJson)).toEqual(failure);
        expect(presentBrokerTool({ ok: false, error: "broker refused", result: { mcpResult: image } }, {}, renderJson)).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining("broker refused") }] });
    });
    it("passes selected broker fallback facts to the opaque presenter", async () => {
        const ports = requestPorts("device_inventory", { backend: "windows-sandbox", broker: true });
        ports.brokerDeviceTool = async () => ({ ok: false, receipt: { ok: false, error: "inventory refused" } });
        await expect(createDeviceRequest(ports).dispatch("device_inventory", {})).resolves.toEqual({
            selection: "json", value: { ok: false, error: "inventory refused", routedBy: "device-readonly-broker" },
        });
    });
    it("admits Appium image facts through the private mobile dispatch and rejects missing data", async () => {
        const ports = requestPorts("mobile_screenshot", { backend: "android-device", deviceId: "owned-phone", broker: true });
        let data: unknown = "image-bytes";
        ports.ensureMobileSession = async () => ({ ok: true, receipt: { ok: true } });
        ports.executeMobileEffect = async () => ({ kind: "completed", receipt: { ok: true }, screenshotData: String(data) });
        const app = createDeviceRequest(ports);
        const args = { backend: "android-device", deviceId: "owned-phone", broker: true };
        await expect(app.dispatch("mobile_screenshot", args)).resolves.toEqual({ selection: "image", value: { data: "image-bytes", mimeType: "image/png" } });
        data = "";
        await expect(app.dispatch("mobile_screenshot", args)).resolves.toEqual({ selection: "text", value: "Appium did not return screenshot data" });
    });
});

function finiteMobileContract(ports: DeviceRequestPorts<OpaqueResult>) {
    const target = { backend: "android-emulator", deviceId: "owned-phone" };
    void ports.executeMobileEffect(target, { kind: "set-clipboard", text: "semantic text" });
    // @ts-expect-error arbitrary native requests are outside the mobile effect contract
    const recipe: MobileEffect = { kind: "request", method: "POST", path: "/execute/sync", body: {} };
    // @ts-expect-error shell scripts are not finite semantic effects
    void ports.executeMobileEffect(target, { kind: "shell", command: "settings", args: ["put", "system", "user_rotation", "3"] });
    const { executeMobileEffect: effect, ...withoutEffect } = ports;
    // @ts-expect-error finite mobile execution is a required capability
    createDeviceRequest<OpaqueResult>(withoutEffect);
    void [recipe, effect];
}
void finiteMobileContract;

describe("semantic active-app waits", () => {
    function waiting(backend = "ios-simulator") {
        const args = { backend, deviceId: "owned-phone", broker: true, bundleId: "com.example.Test", packageName: "com.example.Test", timeoutMs: 100, intervalMs: 10 };
        const ports = requestPorts("mobile_wait_for_app", args);
        let remaining = 100;
        ports.ensureMobileSession = vi.fn(async () => ({ ok: true, selection: { host: "selected-broker", port: 43123 }, receipt: { ok: true } }));
        ports.createWaitBudget = () => ({ timeoutMs: 100, remaining: () => remaining, requestTimeout: maximum => Math.min(maximum, remaining), pause: async () => { remaining = 0; } });
        const broker = { ok: true, result: { diagnostic: "opaque-native-receipt" } };
        ports.observeActiveApp = vi.fn(async () => ({ kind: "observed" as const, activeAppId: "com.example.Test", foreground: false, receipt: { broker, appState: { bundleID: "com.example.Test" } } }));
        return { ports, args, broker, expire: () => { remaining = 0; }, run: () => createDeviceRequest(ports).dispatch("mobile_wait_for_app", args) };
    }

    it("matches iOS identity independently of foreground and preserves native receipt presentation", async () => {
        const fixture = waiting();
        await expect(fixture.run()).resolves.toEqual({ selection: "json", value: { found: true, bundleId: "com.example.Test", activeApp: { bundleID: "com.example.Test" }, provider: "broker-appium", backend: "ios-simulator", broker: fixture.broker } });
        expect(fixture.ports.observeActiveApp).toHaveBeenCalledWith(expect.objectContaining({ backend: "ios-simulator", expectedAppId: "com.example.Test", hostCandidates: ["selected-broker"], port: 43123, autolaunch: false, requestTimeoutMs: 100 }));
        expect(fixture.ports.ensureMobileSession).toHaveBeenCalledTimes(1);
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
        fixture.ports.ensureMobileSession = async () => ({ ok: false, receipt: { ok: false, error: "session-refused" } });
        await expect(fixture.run()).resolves.toEqual({ selection: "json", value: { ok: false, error: "session-refused", routedBy: "mobile-broker-appium" } });
        expect(fixture.ports.observeActiveApp).not.toHaveBeenCalled();
    });

    it("gives deadline during observation precedence over a successful match", async () => {
        const fixture = waiting();
        fixture.ports.observeActiveApp = async () => { fixture.expire(); return { kind: "observed", activeAppId: "com.example.Test", foreground: true, receipt: { broker: fixture.broker, appState: { bundleId: "com.example.Test" } } }; };
        await expect(fixture.run()).resolves.toEqual({ selection: "text", value: "Appium wait deadline exhausted during observation" });
    });
});

describe("finite mobile effect admission and sequencing", () => {
    function mobile(operation: string, additional: DeviceArguments = {}) {
        const args = { backend: "android-emulator", deviceId: "owned-phone", broker: true, ...additional };
        const ports = requestPorts(operation, args);
        ports.ensureMobileSession = vi.fn(async () => ({ ok: true, selection: { host: "authenticated-broker", port: 43210 }, receipt: { ok: true } }));
        ports.executeMobileEffect = vi.fn(async () => ({ kind: "completed" as const, receipt: { ok: true } }));
        return { args, ports, run: () => createDeviceRequest(ports).dispatch(operation, args) };
    }

    it("rejects unsupported orientation before opening a session", async () => {
        const fixture = mobile("mobile_set_orientation", { orientation: "diagonal" });
        await expect(fixture.run()).resolves.toMatchObject({ selection: "text", value: expect.stringContaining("Unsupported Android orientation") });
        expect(fixture.ports.ensureMobileSession).not.toHaveBeenCalled();
        expect(fixture.ports.executeMobileEffect).not.toHaveBeenCalled();
    });

    it("executes both rotation effects against the selected authenticated broker", async () => {
        const fixture = mobile("mobile_set_orientation", { orientation: "reverse-landscape" });
        await expect(fixture.run()).resolves.toMatchObject({ selection: "json", value: { requests: 2 } });
        expect(fixture.ports.executeMobileEffect).toHaveBeenNthCalledWith(1, expect.objectContaining({ hostCandidates: ["authenticated-broker"], port: 43210, autolaunch: false }), { kind: "set-automatic-rotation", enabled: false });
        expect(fixture.ports.executeMobileEffect).toHaveBeenNthCalledWith(2, expect.objectContaining({ hostCandidates: ["authenticated-broker"], port: 43210, autolaunch: false }), { kind: "set-display-rotation", orientation: "reverse-landscape" });
    });

    it("stops after a failed first effect and preserves its diagnostic receipt", async () => {
        const fixture = mobile("mobile_set_orientation", { orientation: "reverse-landscape" });
        fixture.ports.executeMobileEffect = vi.fn(async () => ({ kind: "failed" as const, localBudgetExhausted: false, receipt: { ok: false, error: "rotation-setting-refused", diagnostic: "native receipt" } }));
        await expect(fixture.run()).resolves.toMatchObject({ selection: "json", value: { ok: false, error: "rotation-setting-refused", diagnostic: "native receipt" } });
        expect(fixture.ports.executeMobileEffect).toHaveBeenCalledTimes(1);
        expect(fixture.ports.handleAndroidTool).not.toHaveBeenCalled();
    });

    it("returns session refusal before executing any finite effect", async () => {
        const fixture = mobile("mobile_set_clipboard", { text: "héllo 📋" });
        fixture.ports.ensureMobileSession = vi.fn(async () => ({ ok: false, receipt: { ok: false, error: "owner-session-refused" } }));
        await expect(fixture.run()).resolves.toMatchObject({ selection: "json", value: { ok: false, error: "owner-session-refused" } });
        expect(fixture.ports.executeMobileEffect).not.toHaveBeenCalled();
    });

    it("keeps dump source facts opaque while text waits use normalized source text", async () => {
        const dump = mobile("mobile_dump_ui");
        const source = { tree: ["Welcome"] };
        dump.ports.executeMobileEffect = vi.fn(async () => ({ kind: "completed" as const, source, sourceText: "Welcome", receipt: { ok: true } }));
        await expect(dump.run()).resolves.toMatchObject({ selection: "json", value: { source } });

        const wait = mobile("mobile_wait_for_text", { text: "Welcome", timeoutMs: 100, intervalMs: 10 });
        wait.ports.createWaitBudget = () => ({ timeoutMs: 100, remaining: () => 100, requestTimeout: maximum => Math.min(maximum, 100), pause: async () => {} });
        wait.ports.executeMobileEffect = vi.fn(async () => ({ kind: "completed" as const, source, sourceText: "Welcome", receipt: { ok: true } }));
        await expect(wait.run()).resolves.toMatchObject({ selection: "json", value: { found: true, source: "Welcome" } });
        expect(wait.ports.executeMobileEffect).toHaveBeenCalledTimes(1);
    });

    it("does not read source with a zero request budget", async () => {
        const fixture = mobile("mobile_wait_for_text", { text: "Welcome", timeoutMs: 100 });
        fixture.ports.createWaitBudget = () => ({ timeoutMs: 100, remaining: () => 1, requestTimeout: () => 0, pause: async () => {} });
        await expect(fixture.run()).resolves.toEqual({ selection: "text", value: "Appium wait deadline exhausted before observation" });
        expect(fixture.ports.executeMobileEffect).not.toHaveBeenCalled();
    });

    it("gives a source observation deadline precedence over a late text match", async () => {
        const fixture = mobile("mobile_wait_for_text", { text: "Welcome", timeoutMs: 100 });
        let remaining = 100;
        fixture.ports.createWaitBudget = () => ({ timeoutMs: 100, remaining: () => remaining, requestTimeout: maximum => Math.min(maximum, remaining), pause: async () => {} });
        fixture.ports.executeMobileEffect = vi.fn(async () => {
            remaining = 0;
            return { kind: "completed" as const, sourceText: "Welcome", receipt: { ok: true } };
        });
        await expect(fixture.run()).resolves.toEqual({ selection: "text", value: "Appium wait deadline exhausted during observation" });
        expect(fixture.ports.executeMobileEffect).toHaveBeenCalledTimes(1);
    });
});
