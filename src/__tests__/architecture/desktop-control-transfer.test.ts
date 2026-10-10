import { describe, expect, it } from "vitest";
import { createDesktopControlTransfer } from "../../../packages/device-lab/providers/application/desktop-control-transfer.mjs";
import type { CommandReceipt, MacosPorts, WindowsPorts, X11Ports } from "../../../packages/device-lab/providers/ports/desktop-control-transfer.mjs";

const device = { id: "owned-desktop" };
const helper = { id: "owned-helper" };
const bridge = { target: "guest" };
type Stage = { allocation: string };
type MacPorts = MacosPorts<typeof device, typeof bridge, Stage, Stage>;
type WinPorts = WindowsPorts<typeof device, typeof helper, Stage>;
const successful: CommandReceipt = { status: 0, stdout: "", stderr: "" };
const failed: CommandReceipt = { status: 5, stdout: "", stderr: "native command failed" };
const unexpected = (): never => { throw new Error("Unexpected native effect"); };

function x11(overrides: Partial<X11Ports> = {}): X11Ports {
    return { variant: "x11", command: unexpected, boundedCommand: unexpected,
        windowList: unexpected, parseWindowList: unexpected, drag: unexpected, ...overrides };
}
function windows(overrides: Partial<WinPorts> = {}): WinPorts {
    return { variant: "windows", target: () => device, workspace: () => helper,
        guestPath: unexpected, inputPath: unexpected, outputPath: unexpected,
        stageUpload: unexpected, disposeUpload: unexpected, request: unexpected,
        readyMarkerPresent: unexpected, downloadOutput: unexpected, copyDownload: unexpected, ...overrides };
}
function macos(overrides: Partial<MacPorts> = {}): MacPorts {
    return { variant: "macos", target: () => device, helper: unexpected, parseHelper: unexpected,
        bridge: () => ({ ok: true, bridge }), guestPath: unexpected,
        stageInput: unexpected, stageOutput: unexpected, upload: unexpected, download: unexpected,
        commitOutput: unexpected, disposeInput: unexpected, disposeOutput: unexpected, ...overrides };
}

describe("desktop control and transfer application", () => {
    it("refuses invalid X11 input and leaves unsupported transfer and unknown actions unhandled", async () => {
        const app = createDesktopControlTransfer(x11());
        expect(await app.handle("display_drag", { x1: -1, y1: 0, x2: 2, y2: 3 })).toEqual({ kind: "text", ok: false, text: "invalid-drag-arguments" });
        expect(await app.handle("display_focus_window", { handle: "0" })).toEqual({ kind: "text", ok: false, text: "invalid-window-handle" });
        expect(await app.handle("display_move", { x: 1.5, y: 2 })).toEqual({ kind: "text", ok: false, text: "invalid-pointer-coordinates" });
        expect(await app.handle("device_upload", { localPath: "/input", remotePath: "/output" })).toBeUndefined();
        expect(await app.handle("unknown-operation", {})).toBeUndefined();
    });

    it("requires X11 active-window readback and keeps command failure distinct from focus denial", async () => {
        const denied = createDesktopControlTransfer(x11({
            boundedCommand: argv => argv[0] === "windowactivate" ? successful : { ...successful, stdout: "99\n" },
        }));
        expect(await denied.handle("display_focus_window", { handle: "42" })).toEqual({ kind: "text", ok: false, text: "window-focus-denied" });
        const broken = createDesktopControlTransfer(x11({ boundedCommand: () => failed }));
        expect(await broken.handle("display_focus_window", { handle: "42" })).toEqual({ kind: "command-failure", receipt: failed });
    });

    it("escapes Windows literal typing and preserves helper frame refusal", async () => {
        const app = createDesktopControlTransfer(windows({
            request: async (target, request) => {
                expect(target).toEqual(device);
                expect(request).toEqual({ type: "type", text: "A+{B}", keys: "A{+}{{}B{}}" });
                return { helper, response: { ok: true } };
            },
        }));
        expect(await app.handle("device_type", { deviceId: device.id, text: "A+{B}" })).toEqual({ kind: "json", value: {
            provider: "windows-helper", typed: { text: "A+{B}", keys: "A{+}{{}B{}}" }, response: { ok: true },
        } });
        const refused = createDesktopControlTransfer(windows({ request: async () => ({ helper, response: { ok: false, error: "frame-not-current" } }) }));
        expect(await refused.handle("device_click", { deviceId: device.id, x: 1, y: 2 })).toEqual({ kind: "text", ok: false, text: "frame-not-current" });
        expect(await createDesktopControlTransfer(windows()).handle("device_click", { deviceId: device.id, x: NaN, y: 2 })).toEqual({ kind: "text", ok: false, text: "device_click requires numeric x and y" });
    });

    it("returns the actionable Windows helper timeout diagnostic instead of cursor success", async () => {
        const diagnostic = { stage: "response-timeout", readyMarkerPresent: false };
        const app = createDesktopControlTransfer(windows({
            request: async () => ({ helper, error: "helper is unavailable", helperDiagnostic: diagnostic }),
        }));
        expect(await app.handle("device_cursor_position", { deviceId: device.id })).toEqual({ kind: "json", value: {
            ok: false, error: "windows-sandbox-helper-timeout", helperDiagnostic: diagnostic,
        } });
    });

    it("keeps the Windows upload allocation live through the helper response and disposes it on refusal", async () => {
        const allocation: Stage = { allocation: "windows-upload" };
        let live = true;
        const app = createDesktopControlTransfer(windows({
            guestPath: () => ({ ok: true, path: "C:\\guest\\report.txt" }),
            inputPath: () => ({ ok: true, path: "/owned/input.txt" }),
            stageUpload: () => ({ ok: true, handle: allocation, guestPath: "C:\\uploads\\staged.txt" }),
            request: async (_target, request) => {
                expect({ request, live }).toEqual({ request: { type: "upload", uploadPath: "C:\\uploads\\staged.txt", remotePath: "C:\\guest\\report.txt" }, live: true });
                return { helper, response: { ok: false, error: "guest-transfer-refused" } };
            },
            disposeUpload: handle => { expect(handle).toBe(allocation); live = false; return undefined; },
        }));
        expect(await app.handle("device_upload", { deviceId: device.id, localPath: "/owned/input.txt", remotePath: "C:\\guest\\report.txt" })).toEqual({ kind: "text", ok: false, text: "guest-transfer-refused" });
        expect(live).toBe(false);
    });

    it("preserves unknown macOS targets and rejects unsupported key expressions before helper execution", async () => {
        expect(await createDesktopControlTransfer(macos({ target: () => undefined })).handle("device_key", { deviceId: "absent", key: "Enter" })).toBeUndefined();
        expect(await createDesktopControlTransfer(macos()).handle("device_key", { deviceId: device.id, key: "Super+Enter" })).toEqual({ kind: "text", ok: false, text: "Unsupported macOS key expression: Super+Enter" });
    });

    it("requires macOS helper focus verification and does not hide SSH command failure", async () => {
        const handle = "macos:123:456:Editor";
        const unverified = createDesktopControlTransfer(macos({
            helper: () => ({ result: successful, remoteScriptPath: "/guest/helper" }),
            parseHelper: () => ({ ok: false }),
        }));
        expect(await unverified.handle("device_focus_window", { deviceId: device.id, handle })).toEqual({ kind: "text", ok: false, text: "window-focus-unverified" });
        const broken = createDesktopControlTransfer(macos({ helper: () => ({ result: failed, remoteScriptPath: "/guest/helper" }) }));
        expect(await broken.handle("device_focus_window", { deviceId: device.id, handle })).toEqual({ kind: "command-failure", receipt: failed });
    });

    it("refuses a macOS upload guest path before allocating or transferring input", async () => {
        const app = createDesktopControlTransfer(macos({ guestPath: () => ({ ok: false, message: "upload-remote-path-unsafe" }) }));
        expect(await app.handle("device_upload", { deviceId: device.id, localPath: "/owned/input", remotePath: "../escape" })).toEqual({ kind: "text", ok: false, text: "upload-remote-path-unsafe" });
    });

    it.each(["command", "commit"] as const)("disposes the allocated macOS download stage after %s failure without publishing success", async failure => {
        const allocation: Stage = { allocation: "download" };
        let live = true;
        const app = createDesktopControlTransfer(macos({
            guestPath: () => ({ ok: true, path: "/guest/report.txt" }),
            stageOutput: () => ({ ok: true, path: "/owned/report.txt", stagedPath: "/owned/stage/payload", handle: allocation }),
            download: (target, selectedBridge, remote, staged) => {
                expect(target).toEqual(device);
                expect(selectedBridge).toEqual(bridge);
                expect({ remote, staged, live }).toEqual({ remote: "/guest/report.txt", staged: "/owned/stage/payload", live: true });
                return failure === "command" ? failed : successful;
            },
            commitOutput: failure === "command" ? unexpected : handle => {
                expect(handle).toBe(allocation);
                expect(live).toBe(true);
                return { ok: false, message: "download-publication-refused" };
            },
            disposeOutput: handle => { expect(handle).toBe(allocation); live = false; return undefined; },
        }));
        expect(await app.handle("device_download", { deviceId: device.id, localPath: "/owned/report.txt", remotePath: "/guest/report.txt" })).toEqual(failure === "command"
            ? { kind: "command-failure", receipt: failed }
            : { kind: "text", ok: false, text: "download-publication-refused" });
        expect(live).toBe(false);
    });
});
