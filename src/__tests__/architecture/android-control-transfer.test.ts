import { describe, expect, it, vi } from "vitest";
import { createAndroidControlTransfer } from "../../../packages/device-lab/providers/application/android-control-transfer.mjs";
import { androidOrientationPlan } from "../../../packages/device-lab/providers/domain/android-control-transfer.mjs";
import type { AndroidControlTransferPorts, AndroidControlVariant, CommandReceipt, PathObservation, StageObservation, TargetObservation } from "../../../packages/device-lab/providers/ports/android-control-transfer.d.mts";

type Target = { serial: string };
type InputHandle = { input: string };
type OutputHandle = { output: string };

function fixture(variant: AndroidControlVariant = "emulator") {
    const target = { serial: "owned-adb-target" };
    const input = { input: "allocated-upload" };
    const output = { output: "allocated-download" };
    const ports = {
        variant,
        target: vi.fn((_id: unknown): TargetObservation<Target> => ({ kind: "ready", target })),
        execute: vi.fn((_target: Target, _args: string[]): CommandReceipt => ({ status: 0, stdout: "native stdout", stderr: "native warning" })),
        transfer: vi.fn((_target: Target, _args: string[], _timeoutMs: number): CommandReceipt => ({ status: 0, stdout: "transfer stdout", stderr: "" })),
        guestPath: vi.fn((_value: unknown, _label: "upload-remote-path" | "download-remote-path"): PathObservation => ({ ok: true, path: "/sdcard/approved.txt" })),
        stageInput: vi.fn((_value: unknown): StageObservation<InputHandle> => ({ ok: true, path: "/local/upload.txt", stagedPath: "/allocated/upload/payload", handle: input })),
        stageOutput: vi.fn((_value: unknown): StageObservation<OutputHandle> => ({ ok: true, path: "/local/download.txt", stagedPath: "/allocated/download/payload", handle: output })),
        commitOutput: vi.fn((_handle: OutputHandle): PathObservation => ({ ok: true, path: "/local/published.txt" })),
        disposeInput: vi.fn((_handle: InputHandle): undefined => undefined),
        disposeOutput: vi.fn((_handle: OutputHandle): undefined => undefined),
    } satisfies AndroidControlTransferPorts<Target, InputHandle, OutputHandle>;
    return { ports, target, input, output, application: createAndroidControlTransfer(ports) };
}

describe("Android control and transfer application", () => {
    it("plans all four orientation mappings and the effective left/right orientations", () => {
        for (const [orientation, rotation] of [["portrait", "0"], ["landscape", "1"], ["reverse-portrait", "2"], ["reverse-landscape", "3"]] as const) {
            expect(androidOrientationPlan("mobile_set_orientation", { orientation })).toEqual({
                ok: true,
                firstArgs: ["shell", "settings", "put", "system", "accelerometer_rotation", "0"],
                args: ["shell", "settings", "put", "system", "user_rotation", rotation],
                payload: { orientation, rotation, provider: "adb" },
            });
        }
        expect(androidOrientationPlan("mobile_rotate_left", {})).toMatchObject({ ok: true, payload: { orientation: "landscape", rotation: "1" } });
        expect(androidOrientationPlan("mobile_rotate_right", {})).toMatchObject({ ok: true, payload: { orientation: "reverse-landscape", rotation: "3" } });
    });

    it("resolves the target before orientation admission and refuses unsupported values without settings effects", () => {
        const { ports, application } = fixture();
        ports.target.mockReturnValueOnce({ kind: "unknown" }).mockReturnValueOnce({ kind: "refused", message: "attachment lease lost" });
        ports.execute.mockImplementation(() => { throw new Error("Refused orientation must not change settings"); });
        expect(application.request("mobile_set_orientation", { deviceId: "absent", orientation: "diagonal" })).toBeUndefined();
        expect(application.request("mobile_set_orientation", { deviceId: "lost-lease", orientation: "diagonal" })).toEqual({ kind: "text", message: "attachment lease lost" });
        expect(application.request("mobile_set_orientation", { deviceId: "owned", orientation: "diagonal" })).toEqual({ kind: "text", message: "Unsupported Android orientation: diagonal" });
    });

    it("does not change user rotation when disabling the accelerometer fails", () => {
        const { ports, application } = fixture();
        const failure = { status: 9, stdout: "", stderr: "accelerometer setting denied" };
        let rotation: string | undefined = "2";
        ports.execute.mockImplementation((_target, args) => {
            if (args[4] === "user_rotation") rotation = args[5];
            return failure;
        });
        expect(application.request("mobile_set_orientation", { deviceId: "owned", orientation: "portrait" })).toEqual({ kind: "command-failure", command: failure });
        expect(rotation).toBe("2");
    });

    it("keeps the first settings effect when the second orientation command fails", () => {
        const { ports, application } = fixture();
        const failure = { status: 8, stdout: "partial rotation", stderr: "user rotation denied" };
        let accelerometer: string | undefined = "1";
        ports.execute.mockImplementation((_target, args) => {
            if (args[4] === "accelerometer_rotation") { accelerometer = args[5]; return { status: 0, stdout: "accelerometer disabled" }; }
            expect(args).toEqual(["shell", "settings", "put", "system", "user_rotation", "3"]);
            return failure;
        });
        expect(application.request("mobile_rotate_right", { deviceId: "owned" })).toEqual({ kind: "command-failure", command: failure });
        expect(accelerometer).toBe("0");
    });

    it("returns orientation success using only the final command streams", () => {
        const { ports, target, application } = fixture();
        ports.execute.mockReturnValueOnce({ status: 0, stdout: "first command stdout", stderr: "first warning" })
            .mockReturnValueOnce({ status: 0, stdout: "rotation applied", stderr: "final warning" });
        expect(application.request("mobile_set_orientation", { deviceId: "owned", orientation: "reverse-portrait" })).toEqual({ kind: "json", payload: {
            orientation: "reverse-portrait", rotation: "2", provider: "adb", stdout: "rotation applied", stderr: "final warning", status: 0,
        } });
        expect(ports.execute).toHaveBeenLastCalledWith(target, ["shell", "settings", "put", "system", "user_rotation", "2"]);
    });

    it("uses the current long-press, swipe and drag duration defaults", () => {
        const { ports, target, application } = fixture();
        expect(application.request("mobile_long_press", { deviceId: "owned", x: 1, y: 2 })).toMatchObject({ kind: "json", payload: { longPressed: { x: 1, y: 2, durationMs: 700 }, stdout: "native stdout", stderr: "native warning" } });
        expect(ports.execute).toHaveBeenLastCalledWith(target, ["shell", "input", "swipe", "1", "2", "1", "2", "700"]);
        application.request("mobile_swipe", { deviceId: "owned", x1: 1, y1: 2, x2: 3, y2: 4 });
        expect(ports.execute).toHaveBeenLastCalledWith(target, ["shell", "input", "swipe", "1", "2", "3", "4", "300"]);
        application.request("mobile_drag", { deviceId: "owned", x1: 1, y1: 2, x2: 3, y2: 4 });
        expect(ports.execute).toHaveBeenLastCalledWith(target, ["shell", "input", "swipe", "1", "2", "3", "4", "700"]);
    });

    it("preserves text encoding and zero keyCode precedence, and refuses a missing key", () => {
        const { ports, target, application } = fixture();
        application.request("mobile_type_text", { deviceId: "owned", text: "two words\tline\nnext" });
        expect(ports.execute).toHaveBeenLastCalledWith(target, ["shell", "input", "text", "two%swords%sline%snext"]);
        expect(application.request("mobile_key", { deviceId: "owned", key: "HOME", keyCode: 0 })).toMatchObject({ kind: "json", payload: { key: 0 } });
        expect(ports.execute).toHaveBeenLastCalledWith(target, ["shell", "input", "keyevent", "0"]);
        ports.execute.mockClear();
        expect(application.request("mobile_key", { deviceId: "owned" })).toEqual({ kind: "text", message: "mobile_key requires key or keyCode" });
        expect(ports.execute).not.toHaveBeenCalled();
    });

    it("stops double tap after the first failure and reports a second-tap failure", () => {
        const { ports, target, application } = fixture();
        const failure = { status: 17, stdout: "partial tap", stderr: "tap denied", error: { message: "ADB failed" } };
        ports.execute.mockReturnValueOnce(failure);
        expect(application.request("mobile_double_tap", { deviceId: "owned", x: 1, y: 2 })).toEqual({ kind: "command-failure", command: failure });
        expect(ports.execute.mock.calls).toEqual([[target, ["shell", "input", "tap", "1", "2"]]]);
        ports.execute.mockClear();
        ports.execute.mockReturnValueOnce({ status: 0 }).mockReturnValueOnce(failure);
        expect(application.request("mobile_double_tap", { deviceId: "owned", x: 1, y: 2 })).toEqual({ kind: "command-failure", command: failure });
        expect(ports.execute.mock.calls).toEqual([
            [target, ["shell", "input", "tap", "1", "2"]],
            [target, ["shell", "input", "tap", "1", "2"]],
        ]);
    });

    it("keeps emulator and physical navigation results distinct", () => {
        const emulator = fixture("emulator");
        const physical = fixture("physical");
        expect(emulator.application.request("mobile_home", { deviceId: "owned" })).toMatchObject({ kind: "json", payload: { home: true, provider: "adb" } });
        expect(physical.application.request("mobile_home", { deviceId: "owned" })).toMatchObject({ kind: "json", payload: { key: 3, provider: "adb" } });
        expect(physical.ports.execute).toHaveBeenCalledWith(physical.target, ["shell", "input", "keyevent", "3"]);
    });

    it("returns native target and path refusals before allocating or transferring", () => {
        const { ports, application } = fixture();
        ports.target.mockReturnValueOnce({ kind: "unknown" }).mockReturnValueOnce({ kind: "refused", message: "lease is not owned by this attachment" });
        expect(application.request("device_upload", { deviceId: "unknown" })).toBeUndefined();
        expect(application.request("device_upload", { deviceId: "lost-lease" })).toEqual({ kind: "text", message: "lease is not owned by this attachment" });
        expect(ports.guestPath).not.toHaveBeenCalled();
        ports.guestPath.mockReturnValueOnce({ ok: false, message: "upload-remote-path-traversal-rejected" });
        expect(application.request("device_upload", { deviceId: "owned", remotePath: "/sdcard/../escape" })).toEqual({ kind: "text", message: "upload-remote-path-traversal-rejected" });
        expect(ports.stageInput).not.toHaveBeenCalled();
        ports.stageInput.mockReturnValueOnce({ ok: false, message: "upload-local-path-secret-looking-file" });
        expect(application.request("device_upload", { deviceId: "owned", localPath: "/local/.env", remotePath: "/sdcard/approved.txt" })).toEqual({ kind: "text", message: "upload-local-path-secret-looking-file" });
        expect(ports.transfer).not.toHaveBeenCalled();
        expect(ports.disposeInput).not.toHaveBeenCalled();
    });

    it("uses the allocated upload stage through the bounded command and then disposes it", () => {
        const { ports, target, input, application } = fixture();
        let live = true;
        ports.transfer.mockImplementation((_target, args, timeoutMs) => {
            expect(live).toBe(true);
            expect(_target).toBe(target);
            expect(args).toEqual(["push", "/allocated/upload/payload", "/sdcard/approved.txt"]);
            expect(timeoutMs).toBe(300_000);
            return { status: 0, stdout: "uploaded", stderr: "" };
        });
        ports.disposeInput.mockImplementation(handle => { expect(handle).toBe(input); live = false; return undefined; });
        expect(application.request("device_upload", { deviceId: "owned", localPath: "/local/upload.txt", remotePath: "/sdcard/approved.txt" })).toMatchObject({ kind: "json", payload: { uploaded: { localPath: "/local/upload.txt", remotePath: "/sdcard/approved.txt" } } });
        expect(live).toBe(false);
    });

    it("does not commit failed downloads and disposes the exact stage after commit refusal", () => {
        const { ports, target, output, application } = fixture();
        const failure = { status: 8, stderr: "pull denied" };
        ports.transfer.mockReturnValueOnce(failure);
        expect(application.request("device_download", { deviceId: "owned" })).toEqual({ kind: "command-failure", command: failure });
        expect(ports.transfer).toHaveBeenCalledWith(target, ["pull", "/sdcard/approved.txt", "/allocated/download/payload"], 300_000);
        expect(ports.commitOutput).not.toHaveBeenCalled();
        expect(ports.disposeOutput).toHaveBeenCalledWith(output);
        ports.disposeOutput.mockClear();
        ports.commitOutput.mockReturnValueOnce({ ok: false, message: "destination changed before atomic publication" });
        expect(application.request("device_download", { deviceId: "owned" })).toEqual({ kind: "text", message: "destination changed before atomic publication" });
        expect(ports.commitOutput).toHaveBeenCalledWith(output);
        expect(ports.disposeOutput).toHaveBeenCalledWith(output);
    });
});
