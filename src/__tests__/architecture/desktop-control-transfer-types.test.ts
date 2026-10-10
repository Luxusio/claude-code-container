import { expectTypeOf, it } from "vitest";
import { createDesktopControlTransfer } from "../../../packages/device-lab/providers/application/desktop-control-transfer.mjs";
import type { DesktopOutcome } from "../../../packages/device-lab/providers/domain/desktop-control-transfer.mjs";
import type { MacosPorts, WindowsPorts, X11Ports } from "../../../packages/device-lab/providers/ports/desktop-control-transfer.mjs";

const unexpected = (): never => { throw new Error("Compile-only capability must not execute"); };
type Device = { id: string };
type Handle = { allocation: string };
type MacPorts = MacosPorts<Device, { host: string }, Handle, Handle>;
type WinPorts = WindowsPorts<Device, { id: string }, Handle>;
const x11: X11Ports = { variant: "x11", command: unexpected, boundedCommand: unexpected,
    windowList: unexpected, parseWindowList: unexpected, drag: unexpected };
const windows: WinPorts = { variant: "windows", target: unexpected, workspace: unexpected,
    guestPath: unexpected, inputPath: unexpected, outputPath: unexpected, stageUpload: unexpected,
    disposeUpload: unexpected, request: unexpected, readyMarkerPresent: unexpected,
    downloadOutput: unexpected, copyDownload: unexpected };
const macos: MacPorts = { variant: "macos", target: unexpected, helper: unexpected,
    parseHelper: unexpected, bridge: unexpected, guestPath: unexpected, stageInput: unexpected,
    stageOutput: unexpected, upload: unexpected, download: unexpected, commitOutput: unexpected,
    disposeInput: unexpected, disposeOutput: unexpected };

function consumedContracts() {
    const { command, ...withoutCommand } = x11;
    // @ts-expect-error X11 native command authority is required by the actual factory
    createDesktopControlTransfer(withoutCommand);
    const { commitOutput, ...withoutCommit } = macos;
    // @ts-expect-error macOS download publication authority is required by the actual factory
    createDesktopControlTransfer(withoutCommit);
    // @ts-expect-error native output staging must return an immediate allocated handle
    const asyncStage: MacPorts = { ...macos, stageOutput: async () => ({ ok: true, path: "/output", stagedPath: "/stage/payload", handle: { allocation: "output" } }) };
    // @ts-expect-error publication must finish synchronously before reporting download success
    const asyncCommit: MacPorts = { ...macos, commitOutput: async () => ({ ok: true, path: "/output" }) };
    // @ts-expect-error allocated output disposal settles synchronously
    const asyncDispose: MacPorts = { ...macos, disposeOutput: async () => undefined };
    // @ts-expect-error Windows helper observation is asynchronous
    const syncRequest: WinPorts = { ...windows, request: () => ({ helper: { id: "helper" }, response: { ok: true } }) };
    void [command, commitOutput, asyncStage, asyncCommit, asyncDispose, syncRequest];
}
void consumedContracts;

it("consumes all finite variants through the actual asynchronous factory", () => {
    expectTypeOf(createDesktopControlTransfer(x11).handle).returns.toEqualTypeOf<Promise<DesktopOutcome>>();
    expectTypeOf(createDesktopControlTransfer(windows).handle).returns.toEqualTypeOf<Promise<DesktopOutcome>>();
    expectTypeOf(createDesktopControlTransfer(macos).handle).returns.toEqualTypeOf<Promise<DesktopOutcome>>();
});
