import { describe, expect, it } from "vitest";
import { createDesktopDeviceAccess } from "../../../packages/device-lab/providers/application/desktop-device-access.mjs";
import type { WindowsDeviceAccessPorts, MacosDeviceAccessPorts } from "../../../packages/device-lab/providers/ports/desktop-device-access.mjs";

type Target = { id: string };
type Helper = { outputRoot: string };
function windowsPorts(): WindowsDeviceAccessPorts<Target, Helper> {
    return {
        variant: "windows", target: () => ({ id: "guest" }), publicDevice: (target) => target, backend: () => ({ name: "windows" }),
        request: async () => ({ helper: { outputRoot: "/owned/output" }, response: { ok: true } }),
        screenshotPath: () => "/owned/output/capture.png",
        readScreenshot: () => ({ kind: "image", data: "native-image" }),
    };
}
type Discovery = { available: boolean; ssh: string; scp: string };
type Bridge = { target: string };
type Stage = { localPath: string; remotePath: string };
function macosFixture() {
    const state = { remoteCleaned: false, disposed: false };
    const ports: MacosDeviceAccessPorts<Target, Discovery, Bridge, Stage> = {
        variant: "macos", target: () => ({ id: "guest" }), discovery: () => ({ available: true, ssh: "ssh", scp: "scp" }),
        publicDevice: (target) => target, backend: () => ({ name: "macos" }), bridge: () => ({ ok: true, bridge: { target: "guest" } }),
        exec: () => ({ status: 0, stdout: "", stderr: "" }),
        helper: () => ({ result: { status: 0, stdout: "unparsed output", stderr: "" }, remoteScriptPath: "/tmp/owned-helper.sh" }),
        parseHelper: () => null,
        stageScreenshot: () => ({ localPath: "/owned/stage/screenshot.png", remotePath: "/tmp/owned-screenshot.png" }),
        capture: () => ({ status: 0, stdout: "", stderr: "" }), copy: () => ({ status: 0, stdout: "", stderr: "" }),
        readScreenshot: () => ({ kind: "image", data: "native-image" }),
        cleanupRemote: () => { state.remoteCleaned = true; return { status: 0, stdout: "", stderr: "" }; },
        disposeScreenshot: () => { expect(state.remoteCleaned, "remote cleanup must precede local disposal").toBe(true); state.disposed = true; return undefined; },
    };
    return { ports, state };
}

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
        ports.request = async () => ({ helper: { outputRoot: "/owned/output" }, error: "helper unavailable" });
        ports.screenshotPath = () => { throw new Error("refused-helper-must-not-select-output"); };
        await expect(createDesktopDeviceAccess(ports).handle("device_screenshot", {})).resolves.toEqual({ kind: "text", text: "helper unavailable" });
    });

    it("keeps the Windows operation-specific default helper failure", async () => {
        const ports = windowsPorts();
        ports.request = async () => ({ helper: { outputRoot: "/owned/output" }, response: { ok: false } });
        await expect(createDesktopDeviceAccess(ports).handle("device_exec", { command: "whoami" })).resolves.toEqual({ kind: "text", text: "Windows helper exec failed" });
    });

    it("refuses unsafe Windows output without reading or disclosing the requested path", async () => {
        const ports = windowsPorts();
        ports.request = async () => ({ helper: { outputRoot: "/owned/output" }, response: { ok: true, imagePath: "/foreign/private.png" } });
        ports.screenshotPath = () => null;
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
        ports.request = async (_target, request) => {
            if (request.type !== "accessibility_snapshot") throw new Error("expected-accessibility-operation");
            expect(request.maxDepth).toBe(3);
            expect(request.maxNodes).toBe(200);
            return { helper: { outputRoot: "/owned/output" }, response: { ok: true, accessibility: { provider: "native-uia" } } };
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
        f.ports.capture = () => receipt;
        f.ports.copy = () => { throw new Error("failed-capture-must-not-copy"); };
        await expect(createDesktopDeviceAccess(f.ports).handle("device_screenshot", {})).resolves.toEqual({ kind: "command-failure", receipt });
        expect(f.state.remoteCleaned).toBe(true);
        expect(f.state.disposed).toBe(true);
    });

    it("cleans a failed macOS copy without returning image success", async () => {
        const f = macosFixture();
        const receipt = { status: 5, stdout: "", stderr: "copy refused" };
        f.ports.copy = () => receipt;
        f.ports.readScreenshot = () => { throw new Error("failed-copy-must-not-read-image"); };
        await expect(createDesktopDeviceAccess(f.ports).handle("device_screenshot", {})).resolves.toEqual({ kind: "command-failure", receipt });
        expect(f.state.disposed).toBe(true);
    });

    it("preserves a thrown remote cleanup error before local disposal", async () => {
        const f = macosFixture();
        const failure = new Error("native remote cleanup threw");
        f.ports.cleanupRemote = () => { throw failure; };
        await expect(createDesktopDeviceAccess(f.ports).handle("device_screenshot", {})).rejects.toBe(failure);
        expect(f.state.disposed).toBe(false);
    });

    it("keeps the macOS AX fallback when native helper output has no structured payload", async () => {
        const f = macosFixture();
        await expect(createDesktopDeviceAccess(f.ports).handle("device_accessibility_snapshot", {})).resolves.toEqual({ kind: "json", value: {
            provider: "macos-system-events", remoteScriptPath: "/tmp/owned-helper.sh", accessibility: null, response: null,
            stdout: "unparsed output", stderr: "", status: 0,
        } });
    });
});
