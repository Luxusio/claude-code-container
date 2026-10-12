import { expectTypeOf, it } from "vitest";
import { createDesktopControlTransfer as create } from "../../../packages/device-lab/providers/application/desktop-control-transfer.mjs";
import type { DesktopOutcome } from "../../../packages/device-lab/providers/domain/desktop-control-transfer.mjs";
import type { X11Ports, WindowsPorts, MacosPorts } from "../../../packages/device-lab/providers/ports/desktop-control-transfer.mjs";
const unexpected = (): never => {
    throw new Error("Compile-only capability");
};
type Target = {
    id: string
};
type Stage = {
    allocation: string
};
type Win = WindowsPorts<Target, {
    workspace: string
}, Stage>;
type Mac = MacosPorts<Target, {
    host: string
}, Stage>;
const x11: X11Ports = {
    variant: "x11",
    windowList: unexpected,
    activateWindow: unexpected,
    activeWindow: unexpected,
    movePointer: unexpected,
    click: unexpected,
    doubleClick: unexpected,
    key: unexpected,
    type: unexpected,
    scroll: unexpected,
    cursorPosition: unexpected,
    drag: unexpected
};
const windows: Win = {
    variant: "windows",
    target: unexpected,
    workspace: unexpected,
    guestPath: unexpected,
    inputPath: unexpected,
    outputPath: unexpected,
    stageUpload: unexpected,
    disposeUpload: unexpected,
    click: unexpected,
    doubleClick: unexpected,
    key: unexpected,
    type: unexpected,
    scroll: unexpected,
    drag: unexpected,
    focusWindow: unexpected,
    cursorPosition: unexpected,
    windowList: unexpected,
    upload: unexpected,
    download: unexpected,
    downloadOutput: unexpected,
    copyDownload: unexpected
};
const macos: Mac = {
    variant: "macos",
    target: unexpected,
    supportsKey: unexpected,
    click: unexpected,
    doubleClick: unexpected,
    key: unexpected,
    type: unexpected,
    scroll: unexpected,
    drag: unexpected,
    focusWindow: unexpected,
    movePointer: unexpected,
    cursorPosition: unexpected,
    windowList: unexpected,
    bridge: unexpected,
    guestPath: unexpected,
    stageInput: unexpected,
    stageOutput: unexpected,
    upload: unexpected,
    download: unexpected,
    commitOutput: unexpected,
    disposeInput: unexpected,
    disposeOutput: unexpected
};
function consumed() {
    const {
        activateWindow,
        ...withoutActivation
    } = x11;
    // @ts-expect-error named activation authority is required
    create(withoutActivation);
    const {
        supportsKey,
        ...withoutSupport
    } = macos;
    // @ts-expect-error macOS key admission authority is required
    create(withoutSupport);
    const {
        downloadOutput,
        ...withoutOutput
    } = windows;
    // @ts-expect-error Windows output authority is required
    create(withoutOutput);
    const {
        commitOutput,
        ...withoutCommit
    } = macos;
    // @ts-expect-error macOS publication authority is required
    create(withoutCommit);
    create({
        ...x11,
        // @ts-expect-error raw receipts cannot satisfy semantic observations
        key: () => ({
            status: 0,
            stdout: "",
            stderr: ""
        })
    });
    create({
        ...windows,
        // @ts-expect-error Windows upload observation is asynchronous
        upload: () => ({
            ok: true,
            evidence: null
        })
    });
    // @ts-expect-error X11 native operations are synchronous
    create({
        ...x11,
        click: async () => ({
            ok: true,
            evidence: null
        })
    });
    create({
        ...macos,
        // @ts-expect-error macOS native operations are synchronous
        download: async () => ({
            ok: true,
            evidence: null
        })
    });
    create({
        ...macos,
        // @ts-expect-error macOS stage allocation is synchronous
        stageOutput: async () => ({
            ok: true,
            path: "out",
            stagedPath: "temporary",
            handle: {
                allocation: "stage"
            }
        })
    });
    create({
        ...macos,
        // @ts-expect-error output publication is synchronous
        commitOutput: async () => ({
            ok: true,
            path: "out"
        })
    });
    create({
        ...macos,
        // @ts-expect-error output disposal is synchronous
        disposeOutput: async () => undefined
    });
    create({
        ...windows,
        // @ts-expect-error Windows upload disposal is synchronous
        disposeUpload: async () => undefined
    });
    void [activateWindow, supportsKey, downloadOutput, commitOutput];
}
void consumed;
it("public handles return Promise semantic outcomes for all finite variants", () => {
    expectTypeOf(create(x11).handle).returns.toEqualTypeOf<Promise<DesktopOutcome>>();
    expectTypeOf(create(windows).handle).returns.toEqualTypeOf<Promise<DesktopOutcome>>();
    expectTypeOf(create(macos).handle).returns.toEqualTypeOf<Promise<DesktopOutcome>>();
});
