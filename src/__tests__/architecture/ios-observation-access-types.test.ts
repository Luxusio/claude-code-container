import { describe, expect, it } from "vitest";
import { createIosObservationAccess } from "../../../packages/device-lab/providers/application/ios-observation-access.mjs";
import { iosScreenshotData } from "../../../packages/device-lab/providers/domain/ios-observation-access.mjs";
import type { IosAccessDevice, IosAccessSessionOutcome, IosSimulatorAccessPorts, IosPhysicalAccessPorts } from "../../../packages/device-lab/providers/ports/ios-observation-access.mjs";

function consumedCapabilities(simulator: IosSimulatorAccessPorts<IosAccessDevice, object>, physical: IosPhysicalAccessPorts<IosAccessDevice, object>): void {
    const screenshot: Promise<object | undefined> = createIosObservationAccess(simulator).request("device_screenshot", { deviceId: "owned" });
    const session: Promise<IosAccessSessionOutcome<IosAccessDevice>> = createIosObservationAccess(physical).ensureSession("phone");
    const { publishAppium, ...withoutPublication } = simulator;
    // @ts-expect-error Session creation requires conditional native generation publication.
    createIosObservationAccess(withoutPublication);
    const { verifyTarget, ...withoutTarget } = simulator;
    // @ts-expect-error Simulator effects require current owned target admission.
    createIosObservationAccess(withoutTarget);
    const { refreshLease, ...withoutLease } = physical;
    // @ts-expect-error Physical access requires actual lease admission.
    createIosObservationAccess(withoutLease);
    // @ts-expect-error A native command receipt must settle before success or publication.
    createIosObservationAccess({ ...simulator, execute: async () => ({ status: 0, stdout: "", stderr: "" }) });
    // @ts-expect-error Conditional publication cannot remain pending while startup succeeds.
    createIosObservationAccess({ ...simulator, publishAppium: async () => ({ committed: true, device: null }) });
    // @ts-expect-error Generation qualification must finish before interpreting an observation.
    createIosObservationAccess({ ...physical, checkObservation: async () => undefined });
    // @ts-expect-error Allocated screenshot cleanup settles before the response is returned.
    createIosObservationAccess({ ...simulator, stageScreenshot: () => ({ path: "/stage/screenshot.png", dispose: async () => undefined }) });
    void [screenshot, session, publishAppium, verifyTarget, refreshLease];
}
void consumedCapabilities;

describe("iOS access consumed contracts", () => {
    it("does not invent an image for an Appium response without screenshot data", () => {
        expect(iosScreenshotData({ value: null })).toBeUndefined();
        expect(iosScreenshotData({ value: "cG5n" })).toBe("cG5n");
    });
});
