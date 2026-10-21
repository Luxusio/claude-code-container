import { describe, expect, it, vi } from "vitest";
import { createDesktopDeviceAccess, createDisplayDeviceAccess } from "../../../packages/device-lab/providers/application/desktop-device-access.mjs";
import { createDesktopAccessResult } from "../../../packages/device-lab/providers/adapters/desktop-access-result.mjs";
import { x11AccessTarget } from "../../../packages/device-lab/providers/domain/desktop-device-access.mjs";
import { createDeviceRequest } from "../../../device-lab-mcp/src/application/device-request.mjs";
import type { DeviceArguments, DeviceRequestPorts, ProviderRequest } from "../../../device-lab-mcp/src/ports/device-request.mjs";
import type { WindowsDeviceAccessPorts, MacosDeviceAccessPorts, X11DeviceAccessPorts } from "../../../packages/device-lab/providers/ports/desktop-device-access.mjs";

type Target = { id: string };
type Helper = { outputRoot: string };
function windowsPorts(): WindowsDeviceAccessPorts<Target, Helper> {
    return {
        variant: "windows", target: () => ({ id: "guest" }), publicDevice: (target) => target, backend: () => ({ name: "windows" }),
        exec: async () => ({ ok: true, value: { stdout: "", stderr: "", status: 0, provider: "windows-helper" } }),
        accessibility: async () => ({ ok: true, value: { provider: "native-uia", accessibility: { provider: "native-uia" } } }),
        screenshot: async () => ({ ok: true, path: "/owned/output/capture.png" }),
        readScreenshot: () => ({ kind: "image", data: "native-image" }),
    };
}
type Discovery = { available: boolean; ssh: string; scp: string };
type Bridge = { target: string };
type Stage = { localPath: string; remotePath: string };
type Reply = { isError?: boolean; content: { type: string; text?: string; data?: unknown; mimeType?: string }[] };
const nativeResponses = await vi.importActual<{
    jsonResult(value: unknown): Reply;
    textResult(ok: boolean, text: string): Reply;
    fail(receipt: { status: number | null; stdout: string; stderr: string }): Reply;
}>("../../../packages/device-lab/providers/responses.mjs");
const { actionResult } = await vi.importActual<{
    actionResult(name:string,operation:string,result:Reply,options:{detail?:boolean}):Reply;
}>("../../../device-lab-mcp/src/action-output.mjs");

function publicScreenshotRequest(macos:ProviderRequest<Reply>,display:ProviderRequest<Reply>) {
    const unexpected = ():never => { throw new Error("unexpected-public-screenshot-effect"); };
    const empty = () => [];
    const unhandled = () => undefined;
    const ports = {
        OWNER_DEVICE_ID_PATTERN: /^(guest|x11-current-display)$/,
        OPERATION_TOOLS: [{ name: "device_screenshot", inputSchema: { required: ["deviceId"] } }],
        DEVICE_FLOW_TOOL_NAMES: [], now: () => 0, ownerId: () => "owner", readOwnerDevices: empty,
        currentDisplayTarget: unexpected,
        listAndroidDevices: empty, listAndroidRealDevices: empty, listIosDevices: empty, listIosRealDevices: empty,
        listMacosDevices: () => [{ id: "guest", backend: "macos-vm" }], listLinuxVmDevices: empty,
        listWindowsDevices: empty, listWindowsVmDevices: empty,
        androidDiscovery: unexpected, iosDiscovery: unexpected, iosRealDiscovery: unexpected,
        androidBackend: unexpected, androidRealBackend: unexpected, iosBackend: unexpected, iosRealBackend: unexpected,
        macosBackend: unexpected, linuxVmBackend: unexpected, windowsBackend: unexpected, windowsVmBackend: unexpected,
        handleAndroidTool: unhandled, handleAndroidRealTool: unhandled, handleIosTool: unhandled,
        handleIosRealTool: unhandled, handleWindowsTool: unhandled, handleLinuxVmManagementTool: unhandled,
        handleLinuxVmTool: unhandled, handleMacosTool: macos, handleDisplayTool: display,
        observeBrokerStatus: unexpected, observeBrokerBackends: unexpected, observeBrokerInventory: unexpected,
        invokeBrokerLifecycle: unexpected, brokerDeviceTool: unexpected, brokerPhysical: unexpected,
        ensureMobileSession: unexpected, observeMobileSessionStatus: unexpected, executeMobileEffect: unexpected,
        observeActiveApp: unexpected, presentActiveAppWait: unexpected, implicitBrokerProbeOptions: () => null,
        withBrokerOperation: async <T>(operation:()=>Promise<T>) => operation(),
        normalizeToolArgs: (args:unknown) => args as DeviceArguments,
        normalizePublicToolArgs: (_name:string,args:unknown) => args as DeviceArguments,
        toolInputError: () => null, toolOperation: (name:string) => name,
        flowOperationAllowed: unexpected, flowStepArguments: unexpected, evaluateDestructivePolicy: () => ({ ok: true }),
        presentBrokerReceipt: unexpected, presentBrokerTool: unexpected, presentBrokerLifecycle: unexpected,
        presentBackendCatalog: unexpected, presentMobileObservation: unexpected, presentSourceWait: unexpected,
        jsonResult: nativeResponses.jsonResult, textResult: nativeResponses.textResult,
        flowJsonResult: unexpected, compactToolValue: unexpected,
        actionResult,
        invokeBrokerListFiles: unexpected, listDirectDeviceFiles: unexpected, listFilesFromExecResult: unexpected,
        availableDevices: unexpected, startBootTimeoutMs: unexpected, finishStartReadiness: unexpected,
        macosTartCreateRpcTimeoutMs: unexpected,
        cropScreenshotResult: unexpected, createWaitBudget: unexpected, runDeviceFlow: unexpected,
    } satisfies DeviceRequestPorts<Reply>;
    return createDeviceRequest(ports);
}
function macosFixture() {
    const state = { remoteCleaned: false, disposed: false };
    const ports: MacosDeviceAccessPorts<Target, Discovery, Bridge, Stage> = {
        variant: "macos", target: () => ({ id: "guest" }), discovery: () => ({ available: true, ssh: "ssh", scp: "scp" }),
        publicDevice: (target) => target, backend: () => ({ name: "macos" }), bridge: () => ({ ok: true, bridge: { target: "guest" } }),
        exec: () => ({ stdout: "", stderr: "", status: 0, provider: "ssh" }),
        accessibility: () => ({ ok: true, value: { provider: "macos-system-events", remoteScriptPath: "/tmp/owned-helper.sh", accessibility: null, response: null, stdout: "unparsed output", stderr: "", status: 0 } }),
        stageScreenshot: () => ({ localPath: "/owned/stage/screenshot.png", remotePath: "/tmp/owned-screenshot.png" }),
        capture: () => ({ ok: true, receipt: { status: 0, stdout: "", stderr: "" } }), copy: () => ({ ok: true, receipt: { status: 0, stdout: "", stderr: "" } }),
        readScreenshot: () => ({ kind: "image", data: "native-image" }),
        cleanupRemote: () => { state.remoteCleaned = true; return { ok: true, receipt: { status: 0, stdout: "", stderr: "" } }; },
        disposeScreenshot: () => { expect(state.remoteCleaned, "remote cleanup must precede local disposal").toBe(true); state.disposed = true; return undefined; },
    };
    return { ports, state };
}

describe("current display focus capability facts", () => {
    it.each([true, false, undefined])("regression: optional focus observation %s controls only the focus capability", focusAvailable => {
        const noCapture = (): never => { throw new Error("capability-discovery-must-not-capture"); };
        const ports: X11DeviceAccessPorts<{ id: string; capabilities: string[]; available: boolean }, { localPath: string }> = {
            variant: "x11", owner: () => "owned-fixture", display: () => ":fixture", available: () => true,
            ...(focusAvailable === undefined ? {} : { focusAvailable: () => focusAvailable }),
            publicTarget: target => target, stageScreenshot: noCapture, capture: noCapture, readScreenshot: noCapture, disposeScreenshot: noCapture,
        };
        const target = createDisplayDeviceAccess(ports).current();
        expect(target.available).toBe(true);
        expect(target.capabilities.includes("device_focus_window")).toBe(focusAvailable === true);
        expect(target.capabilities).toContain("device_key");
        expect(target.capabilities).toContain("device_screenshot");
        expect(target.capabilities).not.toContain("device_exec");
        expect(target.capabilities).not.toContain("device_accessibility_snapshot");
    });

    it("regression: existing three-fact domain consumers default to no established focus", () => {
        const legacy = x11AccessTarget("owner", ":fixture", true);
        const verified = x11AccessTarget("owner", ":fixture", true, true);
        expect(legacy.capabilities).not.toContain("device_focus_window");
        expect(verified.capabilities).toContain("device_focus_window");
        expect(verified.capabilities.filter(capability => capability !== "device_focus_window")).toEqual(legacy.capabilities);
    });
});

describe("desktop device access policy", () => {
    it("returns macOS screenshot bytes and releases its remote and local capture", async () => {
        const f = macosFixture();
        await expect(createDesktopDeviceAccess(f.ports).handle("device_screenshot", {})).resolves.toEqual({ kind: "image", data: "native-image" });
        expect(f.state).toEqual({ remoteCleaned: true, disposed: true });
    });

    it("reports a rejected macOS screenshot and releases the capture", async () => {
        const f = macosFixture();
        f.ports.readScreenshot = () => ({ kind: "invalid", message: "screenshot-file-link" });
        await expect(createDesktopDeviceAccess(f.ports).handle("device_screenshot", {})).resolves.toEqual({ kind: "text", text: "screenshot-file-link" });
        expect(f.state).toEqual({ remoteCleaned: true, disposed: true });
    });

    it("returns native Windows helper refusal without reading screenshot output", async () => {
        const ports = windowsPorts();
        ports.screenshot = async () => ({ ok: false, outcome: { kind: "text", text: "helper unavailable" } });
        ports.readScreenshot = () => { throw new Error("refused-helper-must-not-read-output"); };
        await expect(createDesktopDeviceAccess(ports).handle("device_screenshot", {})).resolves.toEqual({ kind: "text", text: "helper unavailable" });
    });

    it("keeps the Windows operation-specific default helper failure", async () => {
        const ports = windowsPorts();
        ports.exec = async () => ({ ok: false, outcome: { kind: "text", text: "Windows helper exec failed" } });
        await expect(createDesktopDeviceAccess(ports).handle("device_exec", { command: "whoami" })).resolves.toEqual({ kind: "text", text: "Windows helper exec failed" });
    });

    it("refuses unsafe Windows output without reading or disclosing the requested path", async () => {
        const ports = windowsPorts();
        ports.screenshot = async () => ({ ok: false, outcome: { kind: "text", text: "Windows helper screenshot output is missing or unsafe" } });
        ports.readScreenshot = () => { throw new Error("unsafe-output-must-not-read"); };
        await expect(createDesktopDeviceAccess(ports).handle("device_screenshot", {})).resolves.toEqual({ kind: "text", text: "Windows helper screenshot output is missing or unsafe" });
    });

    it("reports a native bounded screenshot read rejection instead of image success", async () => {
        const ports = windowsPorts();
        ports.readScreenshot = () => ({ kind: "invalid", reason: "screenshot-file-link" });
        await expect(createDesktopDeviceAccess(ports).handle("device_screenshot", {})).resolves.toEqual({ kind: "text", text: "Windows helper screenshot output is invalid: screenshot-file-link" });
    });

    it("applies the default AX bounds and preserves the native accessibility provider", async () => {
        const ports = windowsPorts();
        ports.accessibility = async (_target, limits) => {
            expect(limits).toEqual({ maxDepth: 3, maxNodes: 200 });
            return { ok: true, value: { provider: "native-uia", accessibility: { provider: "native-uia" } } };
        };
        await expect(createDesktopDeviceAccess(ports).handle("device_accessibility_snapshot", {})).resolves.toMatchObject({ kind: "json", value: { provider: "native-uia", accessibility: { provider: "native-uia" } } });
    });

    it("preserves native Windows exec defaults for omitted result fields", async () => {
        await expect(createDesktopDeviceAccess(windowsPorts()).handle("device_exec", { command: "whoami" })).resolves.toEqual({ kind: "json", value: { stdout: "", stderr: "", status: 0, provider: "windows-helper" } });
    });

    it("does not allocate screenshot staging after a macOS bridge refusal", async () => {
        const f = macosFixture();
        const refusal = { isError: true, content: [{ type: "text", text: "owned SSH bridge refused" }] };
        f.ports.bridge = () => ({ ok: false, result: refusal });
        f.ports.stageScreenshot = () => { throw new Error("refused-bridge-must-not-stage"); };
        await expect(createDesktopDeviceAccess(f.ports).handle("device_screenshot", {})).resolves.toEqual({ kind: "native", value: refusal });
        expect(f.state.disposed).toBe(false);
    });

    it("cleans a failed macOS capture before local disposal without starting copy", async () => {
        const f = macosFixture();
        const receipt = { status: 7, stdout: "", stderr: "capture refused" };
        f.ports.capture = () => ({ ok: false, receipt });
        f.ports.copy = () => { throw new Error("failed-capture-must-not-copy"); };
        await expect(createDesktopDeviceAccess(f.ports).handle("device_screenshot", {})).resolves.toEqual({ kind: "command-failure", receipt });
        expect(f.state.remoteCleaned).toBe(true);
        expect(f.state.disposed).toBe(true);
    });

    it("cleans a failed macOS copy without returning image success", async () => {
        const f = macosFixture();
        const receipt = { status: 5, stdout: "", stderr: "copy refused" };
        f.ports.copy = () => ({ ok: false, receipt });
        f.ports.readScreenshot = () => { throw new Error("failed-copy-must-not-read-image"); };
        await expect(createDesktopDeviceAccess(f.ports).handle("device_screenshot", {})).resolves.toEqual({ kind: "command-failure", receipt });
        expect(f.state.disposed).toBe(true);
    });

    it("keeps the macOS AX fallback when native helper output has no structured payload", async () => {
        const f = macosFixture();
        await expect(createDesktopDeviceAccess(f.ports).handle("device_accessibility_snapshot", {})).resolves.toEqual({ kind: "json", value: {
            provider: "macos-system-events", remoteScriptPath: "/tmp/owned-helper.sh", accessibility: null, response: null,
            stdout: "unparsed output", stderr: "", status: 0,
        } });
    });

    it.each(["capture", "copy", "readScreenshot"] as const)("finalizes the owned capture after %s throws", async operation => {
        const f = macosFixture();
        const primary = new Error(`${operation} threw`);
        f.ports[operation] = () => { throw primary; };
        await expect(createDesktopDeviceAccess(f.ports).handle("device_screenshot", {})).rejects.toBe(primary);
        expect(f.state).toEqual({ remoteCleaned: true, disposed: true });
    });

    it("attempts local disposal and retains both primary and remote cleanup exceptions", async () => {
        const f = macosFixture();
        const primary = new Error("copy threw"), remote = new Error("remote cleanup threw");
        f.ports.copy = () => { throw primary; };
        f.ports.cleanupRemote = () => { f.state.remoteCleaned = true; throw remote; };
        const failure = await createDesktopDeviceAccess(f.ports).handle("device_screenshot", {});
        expect(failure).toEqual({ kind: "cleanup-failure", primary: { kind: "thrown", error: primary }, cleanup: [{ operation: "remote", evidence: remote }] });
        expect(f.state.disposed).toBe(true);
    });

    it("retains failed capture evidence when remote cleanup and local disposal also fail", async () => {
        const f = macosFixture();
        const receipt = { status: 7, stdout: "", stderr: "capture refused" };
        const remote = new Error("remote cleanup threw"), local = new Error("local disposal threw");
        f.ports.capture = () => ({ ok: false, receipt });
        f.ports.cleanupRemote = () => { f.state.remoteCleaned = true; throw remote; };
        f.ports.disposeScreenshot = () => { f.state.disposed = true; throw local; };
        const failure = await createDesktopDeviceAccess(f.ports).handle("device_screenshot", {});
        expect(failure).toEqual({ kind: "cleanup-failure", primary: { kind: "command-failure", receipt }, cleanup: [{ operation: "remote", evidence: remote }, { operation: "local", evidence: local }] });
        expect(f.state.disposed).toBe(true);
    });

    it("retains completed image publication evidence when local disposal fails", async () => {
        const f = macosFixture();
        const local = new Error("local disposal threw");
        f.ports.disposeScreenshot = () => { f.state.disposed = true; throw local; };
        const failure = await createDesktopDeviceAccess(f.ports).handle("device_screenshot", {});
        expect(failure).toEqual({ kind: "cleanup-failure", primary: { kind: "image", data: "native-image" }, cleanup: [{ operation: "local", evidence: local }] });
        expect(f.state).toEqual({ remoteCleaned: true, disposed: true });
    });

    it("reports negative remote cleanup and still disposes the local image stage", async () => {
        const f = macosFixture();
        const receipt = { status: 9, stdout: "", stderr: "cleanup denied" };
        f.ports.cleanupRemote = () => { f.state.remoteCleaned = true; return { ok: false, receipt }; };
        const failure = await createDesktopDeviceAccess(f.ports).handle("device_screenshot", {});
        expect(failure).toEqual({ kind: "cleanup-failure", primary: { kind: "image", data: "native-image" }, cleanup: [{ operation: "remote", evidence: receipt }] });
        expect(f.state.disposed).toBe(true);
    });

    it("keeps native AX failure distinct from successful empty fallback", async () => {
        const f = macosFixture();
        const receipt = { status: 7, stdout: "", stderr: "native helper refused" };
        f.ports.accessibility = () => ({ ok: false, outcome: { kind: "command-failure", receipt } });
        await expect(createDesktopDeviceAccess(f.ports).handle("device_accessibility_snapshot", {})).resolves.toEqual({ kind: "command-failure", receipt });
    });

    it("bounds explicit AX limits before issuing the native intent", async () => {
        const f = macosFixture();
        f.ports.accessibility = (_target, limits) => {
            expect(limits).toEqual({ maxDepth: 8, maxNodes: 1000 });
            return { ok: true, value: { provider: "native-ax" } };
        };
        await expect(createDesktopDeviceAccess(f.ports).handle("device_accessibility_snapshot", { maxDepth: 99, maxNodes: 9999 })).resolves.toEqual({ kind: "json", value: { provider: "native-ax" } });
    });
});

describe("X11 capture finalization", () => {
    it.each(["capture", "read"])("retains %s failure together with local disposal failure", async operation => {
        const primary = new Error(`${operation} threw`), local = new Error("disposal threw");
        const ports: X11DeviceAccessPorts<Target, Stage> = {
            variant: "x11", owner: () => "owner", display: () => ":1", available: () => true, publicTarget: target => target,
            stageScreenshot: () => ({ localPath: "/owned/x11.png", remotePath: "" }),
            capture: () => { if (operation === "capture") throw primary; return { ok: true, receipt: { status: 0, stdout: "", stderr: "" } }; },
            readScreenshot: () => { throw primary; }, disposeScreenshot: () => { throw local; },
        };
        const failure = await createDisplayDeviceAccess(ports).handle("display_screenshot");
        expect(failure).toEqual({ kind: "cleanup-failure", primary: { kind: "thrown", error: primary }, cleanup: [{ operation: "local", evidence: local }] });
    });

    it("retains successful X11 image evidence when disposal fails", async () => {
        const local = new Error("disposal threw");
        const ports: X11DeviceAccessPorts<Target, Stage> = {
            variant: "x11", owner: () => "owner", display: () => ":1", available: () => true, publicTarget: target => target,
            stageScreenshot: () => ({ localPath: "/owned/x11.png", remotePath: "" }),
            capture: () => ({ ok: true, receipt: { status: 0, stdout: "", stderr: "" } }), readScreenshot: () => ({ kind: "image", data: "x11-image" }),
            disposeScreenshot: () => { throw local; },
        };
        const failure = await createDisplayDeviceAccess(ports).handle("display_screenshot");
        expect(failure).toEqual({ kind: "cleanup-failure", primary: { kind: "image", data: "x11-image" }, cleanup: [{ operation: "local", evidence: local }] });
    });
    it.each(["refused", "threw"])("disposes its allocated stage when native capture %s", async mode => {
        const stage = { localPath: "/owned/x11.png" };
        let disposed = false;
        const receipt = { status: 3, stdout: "", stderr: "X11 capture refused" };
        const primary = new Error("X11 capture threw");
        const ports: X11DeviceAccessPorts<Target, typeof stage> = {
            variant: "x11", owner: () => "owner", display: () => ":1", available: () => true,
            publicTarget: target => target, stageScreenshot: () => stage,
            capture: allocated => { expect(allocated).toBe(stage); if (mode === "threw") throw primary; return { ok: false, receipt }; },
            readScreenshot: () => { throw new Error("failed-capture-must-not-publish"); },
            disposeScreenshot: allocated => { expect(allocated).toBe(stage); disposed = true; return undefined; },
        };
        const result = createDisplayDeviceAccess(ports).handle("display_screenshot");
        if (mode === "threw") await expect(result).rejects.toBe(primary);
        else await expect(result).resolves.toEqual({ kind: "command-failure", receipt });
        expect(disposed).toBe(true);
    });
});

describe("public screenshot cleanup results", () => {
    it.each(["macos", "x11"] as const)("returns capture and cleanup failures through the %s MCP request dispatcher", async variant => {
        const receipt = { status: 7, stdout: "capture failure output", stderr: "capture refused" };
        const cleanup = new Error("owned cleanup refused");
        let disposed = false;
        const render = createDesktopAccessResult(nativeResponses);
        const f = macosFixture();
        f.ports.capture = () => ({ ok: false, receipt });
        f.ports.cleanupRemote = () => { f.state.remoteCleaned = true; throw cleanup; };
        const x11: X11DeviceAccessPorts<Target, Stage> = {
            variant: "x11", owner: () => "owner", display: () => ":1", available: () => true,
            publicTarget: target => target, stageScreenshot: () => ({ localPath: "/owned/x11.png", remotePath: "" }),
            capture: () => ({ ok: false, receipt }),
            readScreenshot: () => { throw new Error("failed-native-capture-must-not-read"); },
            disposeScreenshot: () => { disposed = true; throw cleanup; },
        };
        const macos = createDesktopDeviceAccess(f.ports), display = createDisplayDeviceAccess(x11);
        const request = publicScreenshotRequest(
            async (name, args) => render(await macos.handle(name, args)),
            async name => render(await display.handle(name)),
        );
        const reply = await request.request("device_screenshot", { deviceId: variant === "macos" ? "guest" : "x11-current-display", broker: false });
        expect(reply.isError).toBe(true);
        expect(reply.content.map(item => item.type)).toEqual(["text"]);
        const diagnostic = JSON.parse(reply.content[0].text ?? "null");
        expect(diagnostic).toMatchObject({ ok: false, error: "desktop-screenshot-cleanup-failed", cause: { kind: "command-failure" }, cleanup: [{ operation: variant === "macos" ? "remote" : "local", evidence: { message: "owned cleanup refused" } }] });
        expect(diagnostic.cause.result.isError).toBe(true);
        expect(JSON.stringify(diagnostic.cause.result)).toContain("capture refused");
        expect(diagnostic.result).toBeUndefined();
        expect(variant === "macos" ? f.state.disposed : disposed).toBe(true);
    });

    it.each(["macos", "x11"] as const)("preserves completed image bytes through %s MCP dispatch when disposal fails", async variant => {
        const cleanup = new Error("local image disposal refused");
        const render = createDesktopAccessResult(nativeResponses);
        let disposed = false;
        const f = macosFixture();
        f.ports.disposeScreenshot = () => { f.state.disposed = true; throw cleanup; };
        const x11: X11DeviceAccessPorts<Target, Stage> = {
            variant: "x11", owner: () => "owner", display: () => ":1", available: () => true,
            publicTarget: target => target, stageScreenshot: () => ({ localPath: "/owned/x11.png", remotePath: "" }),
            capture: () => ({ ok: true, receipt: { status: 0, stdout: "", stderr: "" } }),
            readScreenshot: () => ({ kind: "image", data: "x11-completed-image" }),
            disposeScreenshot: () => { disposed = true; throw cleanup; },
        };
        const macos = createDesktopDeviceAccess(f.ports), display = createDisplayDeviceAccess(x11);
        const request = publicScreenshotRequest(
            async (name, args) => render(await macos.handle(name, args)),
            async name => render(await display.handle(name)),
        );
        const reply = await request.request("device_screenshot", { deviceId: variant === "macos" ? "guest" : "x11-current-display", broker: false });
        expect(reply.isError).toBe(true);
        expect(reply.content.map(item => item.type)).toEqual(["text", "image"]);
        const diagnostic = JSON.parse(reply.content[0].text ?? "null");
        expect(diagnostic).toMatchObject({ ok: false, error: "desktop-screenshot-cleanup-failed", result: { kind: "image", completed: true }, cleanup: [{ operation: "local", evidence: { message: "local image disposal refused" } }] });
        expect(reply.content[1]).toEqual({ type: "image", data: variant === "macos" ? "native-image" : "x11-completed-image", mimeType: "image/png" });
        expect(variant === "macos" ? f.state.disposed : disposed).toBe(true);
        if (variant === "macos") expect(f.state.remoteCleaned).toBe(true);
    });
});
