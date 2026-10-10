import { describe, expect, it } from "vitest";
import { createBrokerPhysicalDevicesApplication } from "../../../packages/device-lab/src/device-lab/application/broker-physical-devices.js";
import { createBrokerOwnerCleanupApplication } from "../../../packages/device-lab/src/device-lab/application/broker-owner-cleanup.js";
import { physicalStopReplacement } from "../../../packages/device-lab/src/device-lab/domain/broker-physical-devices.js";
import type { BrokerPhysicalDevicesPorts } from "../../../packages/device-lab/src/device-lab/ports/broker-physical-devices.js";
import type { BrokerOwnerCleanupPorts } from "../../../packages/device-lab/src/device-lab/ports/broker-owner-cleanup.js";

export function consumedPhysicalCleanupContracts(physical: BrokerPhysicalDevicesPorts<string>, cleanup: BrokerOwnerCleanupPorts<string>) {
    const devices = createBrokerPhysicalDevicesApplication(physical), owner = createBrokerOwnerCleanupApplication(cleanup);
    const { releaseLease, ...missingRelease } = physical;
    // @ts-expect-error exact lease release is a required physical capability
    createBrokerPhysicalDevicesApplication(missingRelease);
    // @ts-expect-error definition removal must finish before detach settles
    createBrokerPhysicalDevicesApplication({ ...physical, removeDevice: async () => undefined });
    // @ts-expect-error captured stop records must be cloned synchronously before lease cleanup
    createBrokerPhysicalDevicesApplication({ ...physical, clone: async value => structuredClone(value) });
    const { publish, ...missingPublication } = cleanup;
    // @ts-expect-error owner cleanup requires conditional publication
    createBrokerOwnerCleanupApplication(missingPublication);
    // @ts-expect-error synchronous publication cannot defer its guarded decision
    createBrokerOwnerCleanupApplication({ ...cleanup, publish: async () => ({ found: true, matched: true, device: null }) });
    return { devices, owner, releaseLease, publish };
}

describe("physical stop record", () => {
    it("retains the definition while detaching and clearing its exact claim", () => {
        expect(physicalStopReplacement({ id: "phone", serial: "usb", status: "attached", leaseClaimId: "old", leaseClaimNonce: "nonce", label: "keep" }, "now")).toEqual({
            id: "phone", serial: "usb", status: "detached", leaseClaimId: null, leaseClaimNonce: null, label: "keep", updatedAt: "now",
        });
    });
});
