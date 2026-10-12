import { describe, expect, it } from "vitest";
import { createDesktopDeviceAccess, createDisplayDeviceAccess } from "../../../packages/device-lab/providers/application/desktop-device-access.mjs";
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
        const failure = await createDesktopDeviceAccess(f.ports).handle("device_screenshot", {}).catch(error => error);
        expect(failure).toBeInstanceOf(AggregateError);
        expect(failure.errors).toEqual([primary, remote]);
        expect(failure.cause).toBe(primary);
        expect(f.state.disposed).toBe(true);
    });

    it("retains failed capture evidence when remote cleanup and local disposal also fail", async () => {
        const f = macosFixture();
        const receipt = { status: 7, stdout: "", stderr: "capture refused" };
        const remote = new Error("remote cleanup threw"), local = new Error("local disposal threw");
        f.ports.capture = () => ({ ok: false, receipt });
        f.ports.cleanupRemote = () => { f.state.remoteCleaned = true; throw remote; };
        f.ports.disposeScreenshot = () => { f.state.disposed = true; throw local; };
        const failure = await createDesktopDeviceAccess(f.ports).handle("device_screenshot", {}).catch(error => error);
        expect(failure.errors).toEqual([{ kind: "command-failure", receipt }, remote, local]);
        expect(failure.cause).toEqual({ kind: "command-failure", receipt });
        expect(failure.outcome).toEqual({ kind: "command-failure", receipt });
        expect(failure.outcome.receipt).toBe(receipt);
        expect(f.state.disposed).toBe(true);
    });

    it("retains completed image publication evidence when local disposal fails", async () => {
        const f = macosFixture();
        const local = new Error("local disposal threw");
        f.ports.disposeScreenshot = () => { f.state.disposed = true; throw local; };
        const failure = await createDesktopDeviceAccess(f.ports).handle("device_screenshot", {}).catch(error => error);
        expect(failure.errors).toEqual([local]);
        expect(failure.outcome).toEqual({ kind: "image", data: "native-image" });
        expect(f.state).toEqual({ remoteCleaned: true, disposed: true });
    });

    it("reports negative remote cleanup and still disposes the local image stage", async () => {
        const f = macosFixture();
        const receipt = { status: 9, stdout: "", stderr: "cleanup denied" };
        f.ports.cleanupRemote = () => { f.state.remoteCleaned = true; return { ok: false, receipt }; };
        const failure = await createDesktopDeviceAccess(f.ports).handle("device_screenshot", {}).catch(error => error);
        expect(failure.errors[0].receipt).toBe(receipt);
        expect(failure.outcome).toEqual({ kind: "image", data: "native-image" });
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
        const failure = await createDisplayDeviceAccess(ports).handle("display_screenshot").catch(error => error);
        expect(failure.errors).toEqual([primary, local]);
        expect(failure.cause).toBe(primary);
    });

    it("retains successful X11 image evidence when disposal fails", async () => {
        const local = new Error("disposal threw");
        const ports: X11DeviceAccessPorts<Target, Stage> = {
            variant: "x11", owner: () => "owner", display: () => ":1", available: () => true, publicTarget: target => target,
            stageScreenshot: () => ({ localPath: "/owned/x11.png", remotePath: "" }),
            capture: () => ({ ok: true, receipt: { status: 0, stdout: "", stderr: "" } }), readScreenshot: () => ({ kind: "image", data: "x11-image" }),
            disposeScreenshot: () => { throw local; },
        };
        const failure = await createDisplayDeviceAccess(ports).handle("display_screenshot").catch(error => error);
        expect(failure.errors).toEqual([local]);
        expect(failure.outcome).toEqual({ kind: "image", data: "x11-image" });
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
