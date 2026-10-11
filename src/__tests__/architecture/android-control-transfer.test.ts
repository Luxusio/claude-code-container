import { describe, expect, it, vi } from "vitest";
import { createAndroidControlTransfer } from "../../../packages/device-lab/providers/application/android-control-transfer.mjs";
import type { AndroidControlTransferPorts, CommandReceipt, Point, Swipe, TargetObservation, PathObservation, StageObservation } from "../../../packages/device-lab/providers/ports/android-control-transfer.mjs";
type Target = { serial: string }; type Input = { input: string }; type Output = { output: string };
function fixture() {
    const target = { serial: "owned" }, output = { output: "allocated" };
    const good = (): CommandReceipt => ({ status: 0, stdout: "native stdout", stderr: "" });
    const ports = {
        variant: "emulator" as const,
        target: vi.fn((_id: unknown): TargetObservation<Target> => ({ kind: "ready", target })),
        tap: vi.fn((_target: Target, _point: Point) => good()), swipe: vi.fn((_target: Target, _swipe: Swipe) => good()),
        typeText: vi.fn((_target: Target, _text: unknown) => good()), key: vi.fn((_target: Target, _key: unknown) => good()),
        disableAutoRotation: vi.fn((_target: Target) => good()), setRotation: vi.fn((_target: Target, _rotation: "0"|"1"|"2"|"3") => good()),
        upload: vi.fn((_target: Target, _local: string, _remote: string, _budget: number) => good()),
        download: vi.fn((_target: Target, _remote: string, _local: string, _budget: number) => good()),
        guestPath: vi.fn((_value: unknown, _label: "upload-remote-path"|"download-remote-path"): PathObservation => ({ ok: true, path: "/sdcard/approved" })),
        stageInput: vi.fn((_value: unknown): StageObservation<Input> => ({ ok: true, path: "/local/input", stagedPath: "/stage/input", handle: { input: "allocated" } })),
        stageOutput: vi.fn((_value: unknown): StageObservation<Output> => ({ ok: true, path: "/local/destination", stagedPath: "/stage/output", handle: output })),
        commitOutput: vi.fn((_handle: Output): PathObservation => ({ ok: true, path: "/local/destination" })),
        disposeInput: vi.fn((_handle: Input): undefined => undefined), disposeOutput: vi.fn((_handle: Output): undefined => undefined),
    } satisfies AndroidControlTransferPorts<Target, Input, Output>;
    return { ports, target, output, app: createAndroidControlTransfer(ports) };
}
describe("Android control and transfer policy", () => {
    it("stops double tap after first native failure", () => {
        const { ports, app } = fixture(); const failure = { status: 17, stderr: "tap denied" };
        let admitted = false;
        ports.tap.mockImplementation(() => { if (admitted) throw new Error("failed-first-tap-must-stop"); admitted = true; return failure; });
        expect(app.request("mobile_double_tap", { x: 1, y: 2 })).toEqual({ kind: "command-failure", command: failure });
    });
    it("refuses rotation after disabling auto rotation fails", () => {
        const { ports, app } = fixture(); const failure = { status: 9, stderr: "disabled refused" };
        ports.disableAutoRotation.mockReturnValue(failure);
        ports.setRotation.mockImplementation(() => { throw new Error("failed-disable-must-not-rotate"); });
        expect(app.request("mobile_set_orientation", { orientation: "portrait" })).toEqual({ kind: "command-failure", command: failure });
    });
    it("preserves disabled auto rotation when setting rotation fails", () => {
        const { ports, app } = fixture(); let enabled = true; const failure = { status: 8, stderr: "rotation refused" };
        ports.disableAutoRotation.mockImplementation(() => { enabled = false; return { status: 0 }; });
        ports.setRotation.mockReturnValue(failure);
        expect(app.request("mobile_rotate_right", {})).toEqual({ kind: "command-failure", command: failure }); expect(enabled).toBe(false);
    });
    it("passes raw text to native encoding and preserves zero keyCode", () => {
        const { ports, target, app } = fixture();
        app.request("mobile_type_text", { text: "two words\tline\nnext" });
        expect(ports.typeText).toHaveBeenCalledWith(target, "two words\tline\nnext");
        expect(app.request("mobile_key", { key: "HOME", keyCode: 0 })).toMatchObject({ kind: "json", payload: { key: 0 } });
        expect(ports.key).toHaveBeenCalledWith(target, 0);
        expect(app.request("mobile_key", {})).toEqual({ kind: "text", message: "mobile_key requires key or keyCode" });
    });
    it("refuses unknown or lost-lease targets before staging", () => {
        const { ports, app } = fixture(); ports.target.mockReturnValueOnce({ kind: "unknown" }).mockReturnValueOnce({ kind: "refused", message: "lease lost" });
        ports.stageInput.mockImplementation(() => { throw new Error("refusal-must-not-stage"); });
        expect(app.request("device_upload", {})).toBeUndefined(); expect(app.request("device_upload", {})).toEqual({ kind: "text", message: "lease lost" });
    });
    it("uploads only the admitted stage and disposes it", () => {
        const { ports, target, app } = fixture(); let live = true;
        ports.upload.mockImplementation((actual, local, remote, budget) => { expect(actual).toBe(target); expect({ local, remote, budget }).toEqual({ local: "/stage/input", remote: "/sdcard/approved", budget: 300000 }); expect(live).toBe(true); return { status: 0 }; });
        ports.disposeInput.mockImplementation(() => { live = false; return undefined; });
        expect(app.request("device_upload", {})).toMatchObject({ kind: "json", payload: { uploaded: { localPath: "/local/input" } } }); expect(live).toBe(false);
    });
    it("preserves the destination after download failure and disposes the stage", () => {
        const { ports, app } = fixture(); let destination = "original", disposed = false;
        const failure = { status: 8, stderr: "pull refused" }; ports.download.mockReturnValue(failure);
        ports.commitOutput.mockImplementation(() => { destination = "new"; return { ok: true, path: "/local/destination" }; });
        ports.disposeOutput.mockImplementation(() => { disposed = true; return undefined; });
        expect(app.request("device_download", {})).toEqual({ kind: "command-failure", command: failure }); expect(destination).toBe("original"); expect(disposed).toBe(true);
    });
    it("disposes the download stage after atomic commit refusal", () => {
        const { ports, app } = fixture(); let disposed = false;
        ports.commitOutput.mockReturnValue({ ok: false, message: "destination changed" });
        ports.disposeOutput.mockImplementation(() => { disposed = true; return undefined; });
        expect(app.request("device_download", {})).toEqual({ kind: "text", message: "destination changed" }); expect(disposed).toBe(true);
    });
});
