import { describe, expect, it, vi } from "vitest";
import { createAndroidControlTransfer } from "../../../packages/device-lab/providers/application/android-control-transfer.mjs";
import type { AndroidControlTransferPorts, AndroidControlObservation, Point, Swipe, TargetObservation, PathObservation, StageObservation } from "../../../packages/device-lab/providers/ports/android-control-transfer.mjs";

type Target = { serial: string };
type Input = { input: string };
type Output = { output: string };

function fixture() {
    const target = { serial: "owned" }, input = { input: "allocated" }, output = { output: "allocated" };
    const evidence = Object.freeze({ status: 17, stdout: "opaque evidence", error: { message: "not an inward decision" } });
    const good = (): AndroidControlObservation => ({ ok: true, evidence });
    const ports = {
        target: vi.fn((_id: unknown): TargetObservation<Target> => ({ kind: "ready", target })),
        tap: vi.fn((_target: Target, _point: Point) => good()),
        swipe: vi.fn((_target: Target, _swipe: Swipe) => good()),
        typeText: vi.fn((_target: Target, _text: unknown) => good()),
        key: vi.fn((_target: Target, _key: unknown) => good()),
        navigate: vi.fn((_target: Target, _navigation: "back" | "home" | "forward" | "recents" | "power" | "lock" | "unlock") => good()),
        disableAutoRotation: vi.fn((_target: Target) => good()),
        setOrientation: vi.fn((_target: Target, _orientation: "portrait" | "landscape" | "reverse-portrait" | "reverse-landscape") => good()),
        upload: vi.fn((_target: Target, _local: string, _remote: string, _budget: number) => good()),
        download: vi.fn((_target: Target, _remote: string, _local: string, _budget: number) => good()),
        guestPath: vi.fn((_value: unknown, _label: "upload-remote-path" | "download-remote-path"): PathObservation => ({ ok: true, path: "/sdcard/approved" })),
        stageInput: vi.fn((_value: unknown): StageObservation<Input> => ({ ok: true, path: "/local/input", stagedPath: "/stage/input", handle: input })),
        stageOutput: vi.fn((_value: unknown): StageObservation<Output> => ({ ok: true, path: "/local/destination", stagedPath: "/stage/output", handle: output })),
        commitOutput: vi.fn((_handle: Output): PathObservation => ({ ok: true, path: "/local/destination" })),
        disposeInput: vi.fn((_handle: Input): undefined => undefined),
        disposeOutput: vi.fn((_handle: Output): undefined => undefined),
    } satisfies AndroidControlTransferPorts<Target, Input, Output>;
    return { ports, target, input, output, evidence, app: createAndroidControlTransfer(ports) };
}

describe("Android control and transfer policy", () => {
    it("uses semantic completion despite conflicting opaque native fields", () => {
        const { app, evidence } = fixture();
        const result = app.request("mobile_tap", { x: 1, y: 2 });
        expect(result).toEqual({ kind: "completed", completion: { kind: "tapped", point: { x: 1, y: 2 } }, evidence });
        if (result?.kind === "completed") expect(result.evidence).toBe(evidence);
    });

    it.each(["first", "second"] as const)("stops double tap at the %s semantic failure", failedTap => {
        const { ports, app, evidence } = fixture();
        const failedEvidence = Object.freeze({ status: 0, stdout: "success-looking receipt" });
        let taps = 0;
        ports.tap.mockImplementation(() => {
            taps += 1;
            if (taps > (failedTap === "first" ? 1 : 2)) throw new Error("failed tap must stop dependent effects");
            return taps === (failedTap === "first" ? 1 : 2)
                ? { ok: false, evidence: failedEvidence } : { ok: true, evidence };
        });
        expect(app.request("mobile_double_tap", { x: 1, y: 2 })).toEqual({ kind: "command-failure", evidence: failedEvidence });
        expect(taps).toBe(failedTap === "first" ? 1 : 2);
    });

    it("completes both taps without materializing native output in the application", () => {
        const { ports, app } = fixture();
        expect(app.request("mobile_double_tap", { x: 3, y: 4 })).toMatchObject({ kind: "completed", completion: { kind: "double-tapped", point: { x: 3, y: 4 } } });
        expect(ports.tap).toHaveBeenCalledTimes(2);
    });

    it("refuses rotation after disabling auto rotation fails", () => {
        const { ports, app } = fixture(), evidence = { status: 0, stderr: "disabled refused" };
        ports.disableAutoRotation.mockReturnValue({ ok: false, evidence });
        ports.setOrientation.mockImplementation(() => { throw new Error("failed disable must not rotate"); });
        expect(app.request("mobile_set_orientation", { orientation: "portrait" })).toEqual({ kind: "command-failure", evidence });
    });

    it("preserves disabled auto rotation when setting orientation fails", () => {
        const { ports, app, evidence } = fixture();
        let enabled = true;
        const refusal = { status: 0, stderr: "rotation refused" };
        ports.disableAutoRotation.mockImplementation(() => { enabled = false; return { ok: true, evidence }; });
        ports.setOrientation.mockReturnValue({ ok: false, evidence: refusal });
        expect(app.request("mobile_rotate_right", {})).toEqual({ kind: "command-failure", evidence: refusal });
        expect(enabled).toBe(false);
    });

    it("sends semantic orientation and navigation instead of native codes", () => {
        const { ports, target, app } = fixture();
        expect(app.request("mobile_rotate_left", {})).toMatchObject({ kind: "completed", completion: { kind: "oriented", orientation: "landscape" } });
        expect(ports.setOrientation).toHaveBeenCalledWith(target, "landscape");
        expect(app.request("mobile_home", {})).toMatchObject({ kind: "completed", completion: { kind: "navigation", navigation: "home" } });
        expect(ports.navigate).toHaveBeenCalledWith(target, "home");
    });

    it("passes raw text and arbitrary nonempty keys while preserving zero keyCode", () => {
        const { ports, target, app } = fixture();
        app.request("mobile_type_text", { text: "two words\tline\nnext" });
        expect(ports.typeText).toHaveBeenCalledWith(target, "two words\tline\nnext");
        expect(app.request("mobile_key", { key: "HOME", keyCode: 0 })).toMatchObject({ kind: "completed", completion: { kind: "key", key: 0 } });
        expect(ports.key).toHaveBeenCalledWith(target, 0);
        app.request("mobile_key", { key: "arbitrary-key" });
        expect(ports.key).toHaveBeenCalledWith(target, "arbitrary-key");
        for (const key of [undefined, null, ""]) expect(app.request("mobile_key", { key })).toEqual({ kind: "text", message: "mobile_key requires key or keyCode" });
    });

    it("retains gesture defaults and an explicit zero duration", () => {
        const { ports, target, app } = fixture();
        app.request("mobile_long_press", { x: 1, y: 2 });
        app.request("mobile_swipe", { x1: 1, y1: 2, x2: 3, y2: 4 });
        app.request("mobile_drag", { x1: 1, y1: 2, x2: 3, y2: 4 });
        app.request("mobile_drag", { x1: 1, y1: 2, x2: 3, y2: 4, durationMs: 0 });
        expect(ports.swipe.mock.calls).toEqual([
            [target, { x1: 1, y1: 2, x2: 1, y2: 2, durationMs: 700 }],
            [target, { x1: 1, y1: 2, x2: 3, y2: 4, durationMs: 300 }],
            [target, { x1: 1, y1: 2, x2: 3, y2: 4, durationMs: 700 }],
            [target, { x1: 1, y1: 2, x2: 3, y2: 4, durationMs: 0 }],
        ]);
    });

    it("admits the target before validating keys, orientation or transfer paths", () => {
        const { ports, app } = fixture();
        ports.target.mockReturnValue({ kind: "refused", message: "lease lost" });
        ports.guestPath.mockImplementation(() => { throw new Error("refusal must not validate or stage"); });
        for (const operation of ["mobile_key", "mobile_set_orientation", "device_upload"] as const)
            expect(app.request(operation, {})).toEqual({ kind: "text", message: "lease lost" });
        ports.target.mockReturnValue({ kind: "unknown" });
        expect(app.request("device_upload", {})).toBeUndefined();
        expect(ports.stageInput).not.toHaveBeenCalled();
    });

    it.each(["upload", "download"] as const)("rejects invalid %s paths before staging and refuses a stage before transfer", operation => {
        const { ports, app } = fixture();
        const tool = operation === "upload" ? "device_upload" : "device_download";
        const stage = operation === "upload" ? ports.stageInput : ports.stageOutput;
        const dispose = operation === "upload" ? ports.disposeInput : ports.disposeOutput;
        ports.guestPath.mockReturnValueOnce({ ok: false, message: "unsafe remote" });
        expect(app.request(tool, {})).toEqual({ kind: "text", message: "unsafe remote" });
        expect(stage).not.toHaveBeenCalled();
        stage.mockReturnValue({ ok: false, message: "unsafe local path" });
        expect(app.request(tool, {})).toEqual({ kind: "text", message: "unsafe local path" });
        expect(ports[operation]).not.toHaveBeenCalled();
        expect(dispose).not.toHaveBeenCalled();
    });

    it("uploads only the admitted stage with the fixed budget and disposes it", () => {
        const { ports, target, app, evidence } = fixture();
        let live = true;
        ports.upload.mockImplementation((actual, local, remote, budget) => {
            expect(actual).toBe(target);
            expect({ local, remote, budget }).toEqual({ local: "/stage/input", remote: "/sdcard/approved", budget: 300000 });
            expect(live).toBe(true);
            return { ok: true, evidence };
        });
        ports.disposeInput.mockImplementation(() => { live = false; return undefined; });
        expect(app.request("device_upload", {})).toEqual({ kind: "completed", completion: { kind: "uploaded", localPath: "/local/input", remotePath: "/sdcard/approved" }, evidence });
        expect(live).toBe(false);
    });

    it("commits a successful pull before disposing its exact stage", () => {
        const { ports, target, output, app, evidence } = fixture();
        let live = true, destination = "original";
        ports.commitOutput.mockImplementation(stage => {
            expect(stage).toBe(output); expect(live).toBe(true);
            destination = "downloaded";
            return { ok: true, path: "/local/committed" };
        });
        ports.disposeOutput.mockImplementation(() => { live = false; return undefined; });
        expect(app.request("device_download", {})).toEqual({ kind: "completed", completion: { kind: "downloaded", remotePath: "/sdcard/approved", localPath: "/local/committed" }, evidence });
        expect(ports.download).toHaveBeenCalledWith(target, "/sdcard/approved", "/stage/output", 300000);
        expect(destination).toBe("downloaded"); expect(live).toBe(false);
    });

    it("preserves the destination after semantic pull failure and disposes the stage", () => {
        const { ports, app } = fixture();
        const evidence = { status: 0, stderr: "pull refused" };
        let destination = "original", disposed = false;
        ports.download.mockReturnValue({ ok: false, evidence });
        ports.commitOutput.mockImplementation(() => { destination = "new"; return { ok: true, path: "/local/destination" }; });
        ports.disposeOutput.mockImplementation(() => { disposed = true; return undefined; });
        expect(app.request("device_download", {})).toEqual({ kind: "command-failure", evidence });
        expect(destination).toBe("original"); expect(disposed).toBe(true);
    });

    it("disposes the download stage after atomic commit refusal", () => {
        const { ports, app } = fixture();
        ports.commitOutput.mockReturnValue({ ok: false, message: "destination changed" });
        expect(app.request("device_download", {})).toEqual({ kind: "text", message: "destination changed" });
        expect(ports.disposeOutput).toHaveBeenCalledOnce();
    });

    it.each(["upload", "download"] as const)("disposes the stage when %s throws", operation => {
        const { ports, app } = fixture(), error = new Error("transfer threw");
        ports[operation].mockImplementation(() => { throw error; });
        expect(() => app.request(operation === "upload" ? "device_upload" : "device_download", {})).toThrow(error);
        expect(operation === "upload" ? ports.disposeInput : ports.disposeOutput).toHaveBeenCalledOnce();
        expect(ports.commitOutput).not.toHaveBeenCalled();
    });

    it("disposes the stage when commit throws", () => {
        const { ports, app } = fixture(), error = new Error("commit threw");
        ports.commitOutput.mockImplementation(() => { throw error; });
        expect(() => app.request("device_download", {})).toThrow(error);
        expect(ports.disposeOutput).toHaveBeenCalledOnce();
    });

    it.each(["upload", "download"] as const)("retains completed %s publication when exact-stage disposal fails", operation => {
        const { ports, app, input, output, evidence } = fixture();
        const cleanup = Object.freeze({ code: "EACCES", privateStage: Symbol("owned stage") });
        const order: string[] = [];
        let destination = "original";
        ports[operation].mockImplementation(() => { order.push("transfer"); return { ok: true, evidence }; });
        ports.commitOutput.mockImplementation(handle => {
            expect(handle).toBe(output);
            order.push("commit"); destination = "published";
            return { ok: true, path: "/local/published" };
        });
        if (operation === "upload") ports.disposeInput.mockImplementation(handle => {
            expect(handle).toBe(input); order.push("dispose"); throw cleanup;
        });
        else ports.disposeOutput.mockImplementation(handle => {
            expect(handle).toBe(output); order.push("dispose"); throw cleanup;
        });
        const result = app.request(operation === "upload" ? "device_upload" : "device_download", {});
        expect(result).toEqual({ kind: "cleanup-failure", error: cleanup, primary: {
            kind: "completed", evidence,
            completion: operation === "upload"
                ? { kind: "uploaded", localPath: "/local/input", remotePath: "/sdcard/approved" }
                : { kind: "downloaded", remotePath: "/sdcard/approved", localPath: "/local/published" },
        } });
        if (result?.kind !== "cleanup-failure") throw new Error("expected retained cleanup observation");
        expect(result.error).toBe(cleanup);
        if (result.primary.kind !== "completed") throw new Error("expected completed primary");
        expect(result.primary.evidence).toBe(evidence);
        expect(ports[operation]).toHaveBeenCalledOnce();
        expect(ports.disposeInput.mock.calls).toEqual(operation === "upload" ? [[input]] : []);
        expect(ports.disposeOutput.mock.calls).toEqual(operation === "download" ? [[output]] : []);
        expect(order).toEqual(operation === "upload" ? ["transfer", "dispose"] : ["transfer", "commit", "dispose"]);
        expect(destination).toBe(operation === "download" ? "published" : "original");
    });

    it.each(["upload", "download"] as const)("retains opaque native %s failure while disposing only its exact stage once", operation => {
        const { ports, app, input, output } = fixture();
        const evidence = Symbol("opaque failed transfer"), cleanup = Symbol("opaque removal failure");
        ports[operation].mockReturnValue({ ok: false, evidence });
        if (operation === "upload") ports.disposeInput.mockImplementation(() => { throw cleanup; });
        else ports.disposeOutput.mockImplementation(() => { throw cleanup; });
        const result = app.request(operation === "upload" ? "device_upload" : "device_download", {});
        expect(result).toEqual({ kind: "cleanup-failure", primary: { kind: "command-failure", evidence }, error: cleanup });
        if (result?.kind !== "cleanup-failure" || result.primary.kind !== "command-failure") throw new Error("expected failed primary");
        expect(result.primary.evidence).toBe(evidence); expect(result.error).toBe(cleanup);
        expect(ports[operation]).toHaveBeenCalledOnce();
        expect(ports.commitOutput).not.toHaveBeenCalled();
        expect(ports.disposeInput.mock.calls).toEqual(operation === "upload" ? [[input]] : []);
        expect(ports.disposeOutput.mock.calls).toEqual(operation === "download" ? [[output]] : []);
    });

    it("retains download commit refusal together with removal failure without repeating the pull or publication", () => {
        const { ports, app, output } = fixture();
        const cleanup = Object.freeze({ code: "EBUSY" });
        ports.commitOutput.mockReturnValue({ ok: false, message: "destination changed" });
        ports.disposeOutput.mockImplementation(() => { throw cleanup; });
        const result = app.request("device_download", {});
        expect(result).toEqual({ kind: "cleanup-failure", primary: { kind: "text", message: "destination changed" }, error: cleanup });
        if (result?.kind !== "cleanup-failure") throw new Error("expected retained cleanup observation");
        expect(result.error).toBe(cleanup);
        expect(ports.download).toHaveBeenCalledOnce();
        expect(ports.commitOutput).toHaveBeenCalledExactlyOnceWith(output);
        expect(ports.disposeOutput).toHaveBeenCalledExactlyOnceWith(output);
        expect(ports.disposeInput).not.toHaveBeenCalled();
    });

    it.each([undefined, null, false, 0, "", Symbol("opaque cleanup")])("retains falsy or opaque cleanup failure %# after completed download", cleanup => {
        const { ports, app, evidence, output } = fixture();
        ports.disposeOutput.mockImplementation(() => { throw cleanup; });
        const result = app.request("device_download", {});
        expect(result).toEqual({ kind: "cleanup-failure", primary: { kind: "completed", evidence,
            completion: { kind: "downloaded", remotePath: "/sdcard/approved", localPath: "/local/destination" } }, error: cleanup });
        if (result?.kind !== "cleanup-failure") throw new Error("expected cleanup failure even without a truthy exception");
        expect(result.error).toBe(cleanup);
        expect(ports.commitOutput).toHaveBeenCalledExactlyOnceWith(output);
        expect(ports.disposeOutput).toHaveBeenCalledExactlyOnceWith(output);
    });

    const thrownValues = [new Error("original failure"), Symbol("opaque failure"), undefined, null, false, 0, ""];
    describe.each(["upload", "download", "commit"] as const)("%s exceptions during cleanup", phase => {
        it.each(thrownValues)("retains thrown primary %# and exact removal error together", primary => {
            const { ports, app, input, output } = fixture();
            const cleanup = Object.freeze({ code: "EIO", marker: Symbol("cleanup") });
            const events: string[] = [];
            if (phase === "commit") ports.commitOutput.mockImplementation(() => { events.push("primary"); throw primary; });
            else ports[phase].mockImplementation(() => { events.push("primary"); throw primary; });
            if (phase === "upload") ports.disposeInput.mockImplementation(handle => {
                expect(handle).toBe(input); events.push("dispose"); throw cleanup;
            });
            else ports.disposeOutput.mockImplementation(handle => {
                expect(handle).toBe(output); events.push("dispose"); throw cleanup;
            });
            const result = app.request(phase === "upload" ? "device_upload" : "device_download", {});
            expect(result).toEqual({ kind: "cleanup-failure", primary: { kind: "thrown", error: primary }, error: cleanup });
            if (result?.kind !== "cleanup-failure" || result.primary.kind !== "thrown") throw new Error("expected thrown primary");
            expect(result.primary.error).toBe(primary); expect(result.error).toBe(cleanup);
            expect(events).toEqual(["primary", "dispose"]);
            expect(ports.disposeInput.mock.calls).toEqual(phase === "upload" ? [[input]] : []);
            expect(ports.disposeOutput.mock.calls).toEqual(phase === "upload" ? [] : [[output]]);
            expect(ports[phase === "upload" ? "upload" : "download"]).toHaveBeenCalledOnce();
            if (phase === "commit") expect(ports.commitOutput).toHaveBeenCalledExactlyOnceWith(output);
            else expect(ports.commitOutput).not.toHaveBeenCalled();
        });

        it.each(thrownValues)("rethrows the exact original value %# after successful disposal", primary => {
            const { ports, app, input, output } = fixture();
            if (phase === "commit") ports.commitOutput.mockImplementation(() => { throw primary; });
            else ports[phase].mockImplementation(() => { throw primary; });
            let caught: { threw: false } | { threw: true; error: unknown } = { threw: false };
            try { app.request(phase === "upload" ? "device_upload" : "device_download", {}); }
            catch (error) { caught = { threw: true, error }; }
            expect(caught.threw).toBe(true);
            if (caught.threw) expect(caught.error).toBe(primary);
            expect(ports.disposeInput.mock.calls).toEqual(phase === "upload" ? [[input]] : []);
            expect(ports.disposeOutput.mock.calls).toEqual(phase === "upload" ? [] : [[output]]);
        });
    });
});
