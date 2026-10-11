import { describe, expect, it } from "vitest";
import { createDesktopDeviceAccess, createDisplayDeviceAccess } from "../../../packages/device-lab/providers/application/desktop-device-access.mjs";
import type { WindowsDeviceAccessPorts, MacosDeviceAccessPorts, X11DeviceAccessPorts, DesktopAccessOutcome, DesktopScreenshotResult } from "../../../packages/device-lab/providers/ports/desktop-device-access.mjs";

type Target = { id: string };
type Helper = { outputRoot: string };
type Discovery = { available: boolean; ssh: string };
type Bridge = { target: string };
type Stage = { localPath: string };
function windowsContracts(ports: WindowsDeviceAccessPorts<Target, Helper>) {
    const result: Promise<DesktopAccessOutcome | undefined> = createDesktopDeviceAccess(ports).handle("device_exec", { command: "whoami" });
    const { request, ...withoutRequest } = ports;
    // @ts-expect-error correlated native helper requests are required
    createDesktopDeviceAccess(withoutRequest);
    const { screenshotPath, ...withoutOutputFence } = ports;
    // @ts-expect-error native helper output path qualification is required
    createDesktopDeviceAccess(withoutOutputFence);
    // @ts-expect-error owned target lookup must settle synchronously
    createDesktopDeviceAccess({ ...ports, target: async () => ({ id: "guest" }) });
    // @ts-expect-error bounded screenshot file observations are synchronous
    createDesktopDeviceAccess({ ...ports, readScreenshot: async () => ({ kind: "missing" }) });
    void [result, request, screenshotPath];
}
function macosContracts(ports: MacosDeviceAccessPorts<Target, Discovery, Bridge, Stage>) {
    const result: Promise<DesktopAccessOutcome | undefined> = createDesktopDeviceAccess(ports).handle("device_screenshot", {});
    const screenshot: DesktopScreenshotResult = ports.readScreenshot({ localPath: "/owned/image.png" });
    const { cleanupRemote, ...withoutRemoteCleanup } = ports;
    // @ts-expect-error owned remote screenshot cleanup is required
    createDesktopDeviceAccess(withoutRemoteCleanup);
    const { disposeScreenshot, ...withoutDisposal } = ports;
    // @ts-expect-error local screenshot disposal is required
    createDesktopDeviceAccess(withoutDisposal);
    // @ts-expect-error guarded SSH bridge admission is synchronous
    createDesktopDeviceAccess({ ...ports, bridge: async () => ({ ok: true, bridge: { target: "guest" } }) });
    // @ts-expect-error SCP observations settle before image publication
    createDesktopDeviceAccess({ ...ports, copy: async () => ({ status: 0 }) });
    // @ts-expect-error guarded screenshot facts must be available synchronously
    createDesktopDeviceAccess({ ...ports, readScreenshot: async () => ({ kind: "image", data: "image" }) });
    // @ts-expect-error local disposal must finish synchronously
    createDesktopDeviceAccess({ ...ports, disposeScreenshot: async () => undefined });
    void [result, screenshot, cleanupRemote, disposeScreenshot];
}
function displayContracts(ports: X11DeviceAccessPorts<Target, Stage>) {
    const app = createDisplayDeviceAccess(ports);
    const current: Target = app.current();
    const result: Promise<DesktopAccessOutcome | undefined> = app.handle("display_screenshot");
    const { disposeScreenshot, ...withoutDisposal } = ports;
    // @ts-expect-error owned X11 staging disposal is required
    createDisplayDeviceAccess(withoutDisposal);
    const { owner, ...withoutOwner } = ports;
    // @ts-expect-error actual display owner facts are required
    createDisplayDeviceAccess(withoutOwner);
    // @ts-expect-error current display owner observations are synchronous
    createDisplayDeviceAccess({ ...ports, owner: async () => "owner" });
    // @ts-expect-error native availability observations are synchronous
    createDisplayDeviceAccess({ ...ports, available: async () => true });
    // @ts-expect-error native target formatting cannot defer synchronous current()
    createDisplayDeviceAccess({ ...ports, publicTarget: async () => ({ id: "x11-current-display" }) });
    // @ts-expect-error one native capture observation is synchronous
    createDisplayDeviceAccess({ ...ports, capture: async () => ({ status: 0 }) });
    // @ts-expect-error native local stage allocation is synchronous
    createDisplayDeviceAccess({ ...ports, stageScreenshot: async () => ({ localPath: "/owned/image.png" }) });
    // @ts-expect-error guarded screenshot facts must be available synchronously
    createDisplayDeviceAccess({ ...ports, readScreenshot: async () => ({ kind: "image", data: "image" }) });
    // @ts-expect-error owned X11 stage disposal is synchronous
    createDisplayDeviceAccess({ ...ports, disposeScreenshot: async () => undefined });
    void [current, result, disposeScreenshot, owner];
}
void [windowsContracts, macosContracts, displayContracts];

describe("desktop device access typed display consumer", () => {
    it("preserves current target metadata without adding X11 exec support", async () => {
        const unavailable = (): never => { throw new Error("unsupported-display-operation-must-not-stage-or-capture"); };
        const ports: X11DeviceAccessPorts<{ id: string; display: string; creatable: false }, Stage> = {
            variant: "x11", owner: () => "owned-fixture", display: () => ":fixture", available: () => true,
            publicTarget: (target) => target,
            stageScreenshot: unavailable, capture: unavailable, readScreenshot: unavailable, disposeScreenshot: unavailable,
        };
        const app = createDisplayDeviceAccess(ports);
        const target: { id: string; display: string; creatable: false } = app.current();
        expect(target).toMatchObject({ id: "x11-current-display", display: ":fixture", creatable: false, ownerId: "owned-fixture", available: true });
        await expect(app.handle("device_exec")).resolves.toBeUndefined();
    });
});
