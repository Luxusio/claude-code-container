import { describe, expect, it } from "vitest";
import { createAndroidEnvironment } from "../../../packages/device-lab/providers/application/android-environment.mjs";
import { createIosEnvironment } from "../../../packages/device-lab/providers/application/ios-environment.mjs";
import type { AndroidEmulatorEnvironmentPorts, AndroidPhysicalEnvironmentPorts, IosSimulatorEnvironmentPorts, IosPhysicalEnvironmentPorts, EnvironmentOutcome, EnvironmentCommandObservation, BatterySetting } from "../../../packages/device-lab/providers/ports/mobile-environment.mjs";

function androidContracts(ports: AndroidEmulatorEnvironmentPorts<string>, physical: AndroidPhysicalEnvironmentPorts<number>) {
    const outcome: EnvironmentOutcome | undefined = createAndroidEnvironment(ports).request("mobile_get_clipboard", {});
    const { setLocation, ...withoutLocation } = ports;
    // @ts-expect-error emulator location requires its named effect capability
    createAndroidEnvironment(withoutLocation);
    const { broadcastAirplaneMode, ...withoutBroadcast } = ports;
    // @ts-expect-error airplane fallback requires a separate broadcast effect
    createAndroidEnvironment(withoutBroadcast);
    // @ts-expect-error target observations must settle synchronously
    createAndroidEnvironment({ ...ports, target: async () => ({ kind: "unknown" }) });
    // @ts-expect-error native command observations must settle synchronously
    createAndroidEnvironment({ ...ports, setBattery: async () => ({ kind: "succeeded", command: { status: 0 } }) });
    // @ts-expect-error physical lookup must settle synchronously
    createAndroidEnvironment({ ...physical, device: async () => undefined });
    const { readClipboard, ...withoutRead } = physical;
    // @ts-expect-error physical clipboard reading is required
    createAndroidEnvironment(withoutRead);
    const setting: BatterySetting = { setting: "charging", value: false };
    // @ts-expect-error charging remains semantic boolean rather than native integer
    const invalidSetting: BatterySetting = { setting: "charging", value: 0 };
    // @ts-expect-error command status is receipt evidence, not an observation discriminant
    const invalidObservation: EnvironmentCommandObservation = { status: 0 };
    void [outcome, setLocation, broadcastAirplaneMode, readClipboard, setting, invalidSetting, invalidObservation];
}
function iosContracts(ports: IosSimulatorEnvironmentPorts<string>, physical: IosPhysicalEnvironmentPorts) {
    const outcome: EnvironmentOutcome | undefined = createIosEnvironment(ports).request("mobile_get_clipboard", {});
    const { writeClipboard, ...withoutWrite } = ports;
    // @ts-expect-error Simulator clipboard publication requires its named effect
    createIosEnvironment(withoutWrite);
    const { target, ...withoutTarget } = ports;
    // @ts-expect-error owned target admission is required
    createIosEnvironment(withoutTarget);
    // @ts-expect-error device lookup must settle synchronously
    createIosEnvironment({ ...ports, device: async () => undefined });
    // @ts-expect-error target observations must settle synchronously
    createIosEnvironment({ ...ports, target: async () => ({ kind: "missing-prerequisites", missing: ["xcrun"] }) });
    // @ts-expect-error clipboard observations must settle synchronously
    createIosEnvironment({ ...ports, readClipboard: async () => ({ kind: "succeeded", command: { status: 0 } }) });
    // @ts-expect-error physical lookup cannot defer settlement
    createIosEnvironment({ ...physical, device: async () => undefined });
    void [outcome, writeClipboard, target];
}
void [androidContracts, iosContracts];

describe("mobile environment typed consumer", () => {
    it("accepts an opaque primitive physical Android target with only clipboard capabilities", () => {
        const ports: AndroidPhysicalEnvironmentPorts<number> = { variant: "physical", device: () => ({ id: "phone" }),
            target: () => ({ kind: "ready", target: 42 }), writeClipboard: () => ({ kind: "succeeded", command: { status: 0 } }),
            readClipboard: target => ({ kind: "succeeded", command: { status: 0, stdout: String(target) } }) };
        const outcome: EnvironmentOutcome | undefined = createAndroidEnvironment(ports).request("mobile_get_clipboard", {});
        expect(outcome).toEqual({ kind: "clipboard-read", command: { status: 0, stdout: "42" } });
    });
    it("accepts physical iOS lookup alone and preserves unknown fallthrough", () => {
        const ports: IosPhysicalEnvironmentPorts = { variant: "physical", device: () => undefined };
        const outcome: EnvironmentOutcome | undefined = createIosEnvironment(ports).request("mobile_get_clipboard", { deviceId: "missing" });
        expect(outcome).toBeUndefined();
    });
});
