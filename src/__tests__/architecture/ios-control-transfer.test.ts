import { describe, expect, it, vi } from "vitest";
import { createIosControlTransfer } from "../../../packages/device-lab/providers/application/ios-control-transfer.mjs";
import type { IosSimulatorControlPorts } from "../../../packages/device-lab/providers/ports/ios-control-transfer.mjs";

function simulatorPorts(): IosSimulatorControlPorts<object> {
    return {
        kind: "simulator", findDevice: () => ({ id: "owned", simulatorName: "ccc-owned" }),
        resolveSession: async () => ({ serverUrl: "http://appium", sessionId: "session" }),
        requestSession: async () => ({}), jsonResult: value => value,
        textResult: (ok, message) => ({ ok, message }),
        ownedSimulatorName: () => true,
        discovery: () => ({ available: true, xcrun: "/sdk/xcrun", missing: [] }),
        missingPrerequisites: () => ({ ok: false }), verifyTarget: () => ({ target: "udid" }),
        appContainerCommand: () => ({ status: 0, stdout: "/container\n", stderr: "" }),
        pathFacts: () => ({ path: "/container/Documents/file", relativePath: "Documents/file", absolute: false }),
        guardWrite: () => ({}), guardRead: () => ({}), exists: () => true,
        stageInput: () => ({ ok: true, path: "/input", stagedPath: "/stage/input", cleanup: () => {} }),
        stageOutput: () => ({ ok: true, path: "/output", stagedPath: "/stage/output", cleanup: () => {} }),
        copyInput: () => ({ ok: true, path: "/container/Documents/file" }),
        populateOutput: () => ({ ok: true, path: "/stage/output" }),
        commitOutput: () => ({ ok: true, path: "/output" }), disposeStage: () => undefined,
        fail: result => ({ ok: false, result }),
    };
}

describe("iOS control and transfer application", () => {
    it("sends the default long press and preserves the public provider result", async () => {
        const ports = simulatorPorts();
        const request = vi.fn(ports.requestSession);
        ports.requestSession = request;
        expect(await createIosControlTransfer(ports).handle("mobile_long_press", { deviceId: "owned", x: 10, y: 20 })).toEqual({
            longPressed: { x: 10, y: 20, durationMs: 700 }, provider: "appium-xcuitest",
        });
        expect(request).toHaveBeenCalledWith({ serverUrl: "http://appium", sessionId: "session" }, "/actions", {
            actions: [{ type: "pointer", id: "finger1", parameters: { pointerType: "touch" }, actions: [
                { type: "pointerMove", duration: 0, x: 10, y: 20 }, { type: "pointerDown", button: 0 },
                { type: "pause", duration: 700 }, { type: "pointerUp", button: 0 },
            ] }], gesture: "longPress",
        });
    });

    it("does not report success for an unknown or failed session", async () => {
        const ports = simulatorPorts();
        ports.requestSession = async () => { throw new Error("unexpected request"); };
        ports.resolveSession = async () => ({ unknown: true });
        expect(await createIosControlTransfer(ports).handle("mobile_home", { deviceId: "owned" })).toBeUndefined();
        ports.resolveSession = async () => ({ error: "session unavailable" });
        expect(await createIosControlTransfer(ports).handle("mobile_home", { deviceId: "owned" })).toEqual({ ok: false, message: "session unavailable" });
    });

    it("disposes an upload stage when native copying throws", async () => {
        const ports = simulatorPorts();
        const fault = new Error("copy denied");
        ports.copyInput = () => { throw fault; };
        const dispose = vi.fn(ports.disposeStage);
        ports.disposeStage = dispose;
        await expect(createIosControlTransfer(ports).handle("device_upload", {
            deviceId: "owned", bundleId: "com.example.App", localPath: "/input", remotePath: "Documents/file",
        })).rejects.toBe(fault);
        expect(dispose).toHaveBeenCalledWith(expect.objectContaining({ path: "/input", stagedPath: "/stage/input" }));
    });

    it("reports failed download publication and disposes its stage", async () => {
        const ports = simulatorPorts();
        ports.commitOutput = () => ({ ok: false, message: "destination changed" });
        const dispose = vi.fn(ports.disposeStage);
        ports.disposeStage = dispose;
        expect(await createIosControlTransfer(ports).handle("device_download", {
            deviceId: "owned", bundleId: "com.example.App", localPath: "/output", remotePath: "Documents/file",
        })).toEqual({ ok: false, message: "destination changed" });
        expect(dispose).toHaveBeenCalledWith(expect.objectContaining({ path: "/output" }));
    });
});
