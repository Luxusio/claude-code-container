import { describe, expect, it } from "vitest";
import { createAndroidEnvironment } from "../../../packages/device-lab/providers/application/android-environment.mjs";
import { createIosEnvironment } from "../../../packages/device-lab/providers/application/ios-environment.mjs";
import type { AndroidEmulatorEnvironmentPorts, AndroidPhysicalEnvironmentPorts, IosSimulatorEnvironmentPorts, IosPhysicalEnvironmentPorts, EnvironmentOutcome } from "../../../packages/device-lab/providers/ports/mobile-environment.mjs";

function androidContracts(ports: AndroidEmulatorEnvironmentPorts, physical: AndroidPhysicalEnvironmentPorts) {
    const outcome: EnvironmentOutcome | undefined = createAndroidEnvironment(ports).request("mobile_get_clipboard", {});
    const { execute, ...withoutExecute } = ports;
    // @ts-expect-error one-command native execution is required
    createAndroidEnvironment(withoutExecute);
    const { executeEmulator, ...withoutEmulatorCommand } = ports;
    // @ts-expect-error location requires its serial-qualified emulator command capability
    createAndroidEnvironment(withoutEmulatorCommand);
    // @ts-expect-error guarded target selection is synchronous
    createAndroidEnvironment({ ...ports, target: async () => ({ kind: "unknown" }) });
    // @ts-expect-error native command observations must settle synchronously
    createAndroidEnvironment({ ...ports, execute: async () => ({ status: 0 }) });
    // @ts-expect-error emulator serial observations must settle synchronously
    createAndroidEnvironment({ ...ports, serial: async () => "emulator-5580" });
    // @ts-expect-error physical refusal lookup must settle synchronously
    createAndroidEnvironment({ ...physical, device: async () => undefined });
    void [outcome, execute, executeEmulator];
}

function iosContracts(ports: IosSimulatorEnvironmentPorts, physical: IosPhysicalEnvironmentPorts) {
    const outcome: EnvironmentOutcome | undefined = createIosEnvironment(ports).request("mobile_get_clipboard", {});
    const { executeWithInput, ...withoutInput } = ports;
    // @ts-expect-error clipboard publication requires a native stdin command capability
    createIosEnvironment(withoutInput);
    const { ownedTarget, ...withoutOwnership } = ports;
    // @ts-expect-error exact owned Simulator target selection is required
    createIosEnvironment(withoutOwnership);
    // @ts-expect-error owned record lookup is synchronous
    createIosEnvironment({ ...ports, device: async () => undefined });
    // @ts-expect-error native discovery is synchronous
    createIosEnvironment({ ...ports, discovery: async () => ({ available: true, xcrun: "xcrun", missing: [] }) });
    // @ts-expect-error owned target resolution is synchronous
    createIosEnvironment({ ...ports, ownedTarget: async () => ({ ok: true, target: "UDID" }) });
    // @ts-expect-error native command observations are synchronous
    createIosEnvironment({ ...ports, execute: async () => ({ status: 0 }) });
    // @ts-expect-error native stdin command observations are synchronous
    createIosEnvironment({ ...ports, executeWithInput: async () => ({ status: 0 }) });
    // @ts-expect-error physical refusal lookup cannot defer settlement
    createIosEnvironment({ ...physical, device: async () => undefined });
    void [outcome, executeWithInput, ownedTarget];
}
void [androidContracts, iosContracts];

describe("mobile environment typed consumer", () => {
    it("preserves unknown physical iOS targets without adding native capabilities", () => {
        const ports: IosPhysicalEnvironmentPorts = { variant: "physical", device: () => undefined };
        const outcome: EnvironmentOutcome | undefined = createIosEnvironment(ports).request("mobile_get_clipboard", { deviceId: "missing" });
        expect(outcome).toBeUndefined();
    });
});
