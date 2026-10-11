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
    // @ts-expect-error simctl command execution cannot defer its receipt.
    createIosAppManagement({ ...simulator, execute: async () => ({ status: 0 }) });
    const { session, ...withoutSession } = physical;
    // @ts-expect-error Physical stop requires actual verified session authority.
    createIosAppManagement(withoutSession);
    const { request, ...withoutRequest } = physical;
    // @ts-expect-error Physical stop requires a bounded native Appium request.
    createIosAppManagement(withoutRequest);
    // @ts-expect-error Physical terminate cannot use a synchronous unverified session observation.
    createIosAppManagement({ ...physical, session: () => ({ kind: "unknown" as const }) });
    void [androidResult, simulatorResult, physicalResult, target, perform, budgetedStop, containAppContainer, publishAppReset, session, request];
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
