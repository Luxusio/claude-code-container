import { describe, expect, it } from "vitest";
import { createIosObservationAccess } from "../../../packages/device-lab/providers/application/ios-observation-access.mjs";
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
    createIosObservationAccess({ ...simulator, simulatorEffect: async () => ({ ok: true, status: 0, stdout: "", stderr: "" }) });
    // @ts-expect-error Native session creation must decode the session identifier before returning.
    simulator.appiumEffect({ kind: "create-session", serverUrl: "http://owned", target: "owned", deviceName: "owned", physical: false }).then((result: { value: { sessionId: string } }) => result);
    // @ts-expect-error Arbitrary HTTP request recipes are not observation effects.
    simulator.appiumEffect({ kind: "request", url: "/session", method: "POST", body: {} });
    // @ts-expect-error Simulator probes accept semantic identities, not executable recipes.
    simulator.simulatorEffect({ kind: "app-probe", target: "owned", bundleId: "app", probe: "bundle-process", timeoutMs: 10, xcrun: "/usr/bin/xcrun" });
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
    it("keeps an unknown device distinct from an observation failure", async () => {
        const ports = { findDevice: () => null } as IosSimulatorAccessPorts<IosAccessDevice, object>;
        expect(await createIosObservationAccess(ports).ensureSession("missing")).toEqual({ unknown: true });
    });
});
