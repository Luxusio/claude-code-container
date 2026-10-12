import { describe, expect, it } from "vitest";
import { createIosObservationAccess } from "../../../packages/device-lab/providers/application/ios-observation-access.mjs";
import { iosAccessErrorMessage } from "../../../packages/device-lab/providers/domain/ios-observation-access.mjs";
import type { IosAccessDevice, IosAccessSessionOutcome, IosSimulatorAccessPorts, IosPhysicalAccessPorts, IosAccessSimulatorEffect } from "../../../packages/device-lab/providers/ports/ios-observation-access.mjs";

function consumedCapabilities(simulator: IosSimulatorAccessPorts<IosAccessDevice, object>, physical: IosPhysicalAccessPorts<IosAccessDevice, object>): void {
    const screenshot: Promise<object | undefined> = createIosObservationAccess(simulator).request("device_screenshot", { deviceId: "owned" });
    const session: Promise<IosAccessSessionOutcome<IosAccessDevice>> = createIosObservationAccess(physical).ensureSession("phone");
    simulator.spawnServer(4723);
    simulator.verifyTarget({ id: "owned", udid: "OWNED-UDID" });
    // @ts-expect-error Server allocation accepts a semantic port, not an executable path.
    simulator.spawnServer("/usr/bin/appium", 4723);
    // @ts-expect-error Target admission accepts the owned device, not an executable path.
    simulator.verifyTarget("/usr/bin/xcrun", { id: "owned" });
    // @ts-expect-error Native executable discovery is opaque to the inward capability contract.
    simulator.appiumDiscovery().appium;
    // @ts-expect-error Physical status discovery does not expose a native executable selector.
    physical.discovery().xcrun;
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
    createIosObservationAccess({ ...simulator, simulatorEffect: async () => ({ ok: true, status: 0, stdout: "", stderr: "" }) });
    // @ts-expect-error Native session creation must decode the session identifier before returning.
    simulator.appiumEffect({ kind: "create-session", serverUrl: "http://owned", target: "owned", deviceName: "owned", physical: false }).then((result: { value: { sessionId: string } }) => result);
    // @ts-expect-error Arbitrary HTTP request recipes are not observation effects.
    simulator.appiumEffect({ kind: "request", url: "/session", method: "POST", body: {} });
    // @ts-expect-error A concrete finite simulator probe does not include an executable recipe.
    const malformedProbe: IosAccessSimulatorEffect = { kind: "app-probe", target: "owned", bundleId: "app", probe: "bundle-process", timeoutMs: 10, xcrun: "/usr/bin/xcrun" };
    // @ts-expect-error Conditional publication cannot remain pending while startup succeeds.
    createIosObservationAccess({ ...simulator, publishAppium: async () => ({ committed: true, device: null }) });
    // @ts-expect-error Generation qualification must finish before interpreting an observation.
    createIosObservationAccess({ ...physical, checkObservation: async () => undefined });
    // @ts-expect-error Allocated screenshot cleanup settles before the response is returned.
    createIosObservationAccess({ ...simulator, stageScreenshot: () => ({ path: "/stage/screenshot.png", dispose: async () => undefined }) });
    void [screenshot, session, publishAppium, verifyTarget, refreshLease, malformedProbe];
}
void consumedCapabilities;

describe("iOS access consumed contracts", () => {
    it("retains native session failure messages", () => {
        expect(iosAccessErrorMessage(new Error("session rejected"))).toBe("session rejected");
    });
});
