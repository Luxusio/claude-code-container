import { describe, expectTypeOf, it } from "vitest";
import { createAndroidAppManagement } from "../../../packages/device-lab/providers/application/android-app-management.mjs";
import { createIosAppManagement } from "../../../packages/device-lab/providers/application/ios-app-management.mjs";
import type { AndroidAppEffect, AndroidAppManagementPorts, AndroidAppOutcome, IosSimulatorAppManagementPorts, IosPhysicalAppManagementPorts, IosSimulatorAppDevice, IosPhysicalAppDevice, IosVerifiedAppSession, IosAppOutcome, MobileAppArguments } from "../../../packages/device-lab/providers/ports/mobile-app-management.d.mts";

function consumedCapabilities(android: AndroidAppManagementPorts<symbol>, simulator: IosSimulatorAppManagementPorts, physical: IosPhysicalAppManagementPorts): void {
    const androidResult: AndroidAppOutcome | undefined = createAndroidAppManagement(android).request("device_install_app", { deviceId: "owned", path: "/Test.apk", replace: false });
    const simulatorResult: Promise<IosAppOutcome<IosSimulatorAppDevice> | undefined> = createIosAppManagement(simulator).request("mobile_clear_app_data", { deviceId: "owned", bundleId: "com.example.App" });
    const physicalResult: Promise<IosAppOutcome<IosPhysicalAppDevice> | undefined> = createIosAppManagement<IosPhysicalAppDevice, IosVerifiedAppSession>(physical).request("mobile_stop_app", { deviceId: "owned", bundleId: "com.example.App" });
    const { target, ...withoutTarget } = android;
    // @ts-expect-error Every ADB effect requires current native target and lease admission.
    createAndroidAppManagement(withoutTarget);
    const { perform, ...withoutExecution } = android;
    // @ts-expect-error A target-qualified semantic effect port is required.
    createAndroidAppManagement(withoutExecution);
    // @ts-expect-error Semantic native effects must settle synchronously.
    createAndroidAppManagement({ ...android, perform: async () => ({ kind: "succeeded" as const, command: { status: 0 } }) });
    // @ts-expect-error An exit receipt alone cannot replace the finite native observation.
    createAndroidAppManagement({ ...android, perform: () => ({ status: 0 }) });
    // @ts-expect-error Native process arrays are not semantic app effects.
    android.perform(Symbol("opaque"), ["shell", "pm", "clear", "app"]);
    // @ts-expect-error Helper execution budgets belong only to install effects.
    const budgetedStop: AndroidAppEffect = { kind: "stop", packageName: "app", helperTimeoutMs: 100 };
    const launch: AndroidAppEffect = { kind: "launch-component", component: "app/.Main" };
    android.perform(Symbol("opaque"), launch);
    // @ts-expect-error Target admission cannot defer lease/refusal selection.
    createAndroidAppManagement({ ...android, target: async () => ({ kind: "unknown" as const }) });
    const { containAppContainer, ...withoutContainment } = simulator;
    // @ts-expect-error App-container clearing requires native containment authority.
    createIosAppManagement(withoutContainment);
    const { publishAppReset, ...withoutPublication } = simulator;
    // @ts-expect-error Successful clear requires owner-state publication authority.
    createIosAppManagement(withoutPublication);
    // @ts-expect-error Native clearing settles synchronously before publication.
    createIosAppManagement({ ...simulator, clearAppContainer: async () => undefined });
    // @ts-expect-error Owner-state publication cannot remain pending on success.
    createIosAppManagement({ ...simulator, publishAppReset: async () => undefined });
    // @ts-expect-error Simulator semantic effects must settle synchronously.
    createIosAppManagement({ ...simulator, perform: async () => ({ kind: "succeeded" as const, command: { status: 0 } }) });
    const { perform: simulatorPerform, ...withoutSimulatorPerform } = simulator;
    // @ts-expect-error Simulator mutations require semantic native effects.
    createIosAppManagement(withoutSimulatorPerform);
    const { ownedTarget, ...withoutOwnedTarget } = simulator;
    // @ts-expect-error Simulator effects require actual owned target admission.
    createIosAppManagement(withoutOwnedTarget);
    // @ts-expect-error An exit receipt cannot replace the finite observation.
    createIosAppManagement({ ...simulator, perform: () => ({ status: 0 }) });
    // @ts-expect-error Owned target admission settles synchronously.
    createIosAppManagement({ ...simulator, ownedTarget: async () => ({ ok: true as const, target: "owned" }) });
    // @ts-expect-error Container lookup settles before containment and clearing.
    createIosAppManagement({ ...simulator, resolveAppContainer: async () => ({ ok: true as const, containerRoot: "/owned" }) });
    // @ts-expect-error Native argv cannot cross the simulator semantic effect port.
    simulator.perform("owned", ["simctl", "launch", "owned", "app"]);
    const { session, ...withoutSession } = physical;
    // @ts-expect-error Physical stop requires actual verified session authority.
    createIosAppManagement(withoutSession);
    const { terminateApp, ...withoutTermination } = physical;
    // @ts-expect-error Physical stop requires semantic native termination.
    createIosAppManagement(withoutTermination);
    const { available, ...withoutAvailability } = physical;
    // @ts-expect-error Physical install and launch require prerequisite authority.
    createIosAppManagement(withoutAvailability);
    const { perform: physicalPerform, ...withoutPhysicalPerform } = physical;
    // @ts-expect-error Physical install and launch require semantic execution.
    createIosAppManagement(withoutPhysicalPerform);
    // @ts-expect-error Physical command observations settle synchronously.
    createIosAppManagement({ ...physical, perform: async () => ({ kind: "succeeded" as const, command: { status: 0 } }) });
    // @ts-expect-error Native termination must normalize failure into a message.
    createIosAppManagement({ ...physical, terminateApp: async () => ({ kind: "failed" as const, value: false }) });
    // @ts-expect-error Raw Appium request bodies cannot cross the termination port.
    physical.terminateApp({ serverUrl: "http://localhost", sessionId: "owned" }, { script: "mobile: terminateApp", args: [{ bundleId: "app" }] });
    // @ts-expect-error Physical terminate cannot use a synchronous unverified session observation.
    createIosAppManagement({ ...physical, session: () => ({ kind: "unknown" as const }) });
    void [androidResult, simulatorResult, physicalResult, target, perform, budgetedStop, containAppContainer, publishAppReset, simulatorPerform, ownedTarget, session, terminateApp, available, physicalPerform];
}
void consumedCapabilities;

describe("mobile app management consumed contracts", () => {
    it("exposes synchronous Android and asynchronous iOS app outcomes", () => {
        type Android = ReturnType<typeof createAndroidAppManagement<symbol>>;
        type Ios = ReturnType<typeof createIosAppManagement<IosSimulatorAppDevice, IosVerifiedAppSession>>;
        expectTypeOf<Parameters<Android["request"]>>().toEqualTypeOf<[string, MobileAppArguments]>();
        expectTypeOf<ReturnType<Android["request"]>>().toEqualTypeOf<AndroidAppOutcome | undefined>();
        expectTypeOf<ReturnType<Ios["request"]>>().toEqualTypeOf<Promise<IosAppOutcome<IosSimulatorAppDevice> | undefined>>();
    });
});
