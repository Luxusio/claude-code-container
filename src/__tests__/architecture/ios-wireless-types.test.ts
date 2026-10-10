import { expectTypeOf, it } from "vitest";
import { createIosWirelessApplication } from "../../../packages/device-lab/providers/application/ios-wireless.mjs";
import type { IosWirelessArguments, IosWirelessOutcome, IosWirelessPorts } from "../../../packages/device-lab/providers/ports/ios-wireless.mjs";

type Application = ReturnType<typeof createIosWirelessApplication>;
function consumedCapabilities(ports: IosWirelessPorts) {
    const app = createIosWirelessApplication(ports);
    const result: IosWirelessOutcome | undefined = app.request({ backend: "ios-device", action: "status", udid: "selected-udid" });
    const { discover, ...withoutDiscovery } = ports;
    // @ts-expect-error Native prerequisite observation is required by the actual factory.
    createIosWirelessApplication(withoutDiscovery);
    // @ts-expect-error Inventory observation must finish synchronously before wireless status is returned.
    createIosWirelessApplication({ ...ports, listDevices: async () => ({ available: true, missing: [], devices: [] }) });
    void [result, discover];
}
void consumedCapabilities;

it("consumes the actual synchronous wireless factory and optional finite request arguments", () => {
    expectTypeOf<Parameters<Application["request"]>>().toEqualTypeOf<[IosWirelessArguments?]>();
    expectTypeOf<ReturnType<Application["request"]>>().toEqualTypeOf<IosWirelessOutcome | undefined>();
});
