import { describe, expect, it } from "vitest";
import { createBrokerPhysicalDevicesApplication } from "../../../packages/device-lab/src/device-lab/application/broker-physical-devices.js";
import { createBrokerOwnerCleanupApplication } from "../../../packages/device-lab/src/device-lab/application/broker-owner-cleanup.js";
import { physicalStopReplacement, type PhysicalExecution } from "../../../packages/device-lab/src/device-lab/domain/broker-physical-devices.js";
import type { BrokerPhysicalDevicesPorts } from "../../../packages/device-lab/src/device-lab/ports/broker-physical-devices.js";
import type { BrokerOwnerCleanupPorts } from "../../../packages/device-lab/src/device-lab/ports/broker-owner-cleanup.js";

export function consumedPhysicalCleanupContracts(physical: BrokerPhysicalDevicesPorts<string, { observed: boolean }>, cleanup: BrokerOwnerCleanupPorts<string, { deviceId: string }, { observed: boolean }>): {
    devices: ReturnType<typeof createBrokerPhysicalDevicesApplication<string, { observed: boolean }>>;
    owner: ReturnType<typeof createBrokerOwnerCleanupApplication<string, { deviceId: string }, { observed: boolean }>>;
    releaseLease: BrokerPhysicalDevicesPorts<string, { observed: boolean }>["releaseLease"];
    publish: BrokerOwnerCleanupPorts<string, { deviceId: string }, { observed: boolean }>["publish"];
} {
    const devices = createBrokerPhysicalDevicesApplication(physical), owner = createBrokerOwnerCleanupApplication(cleanup);
    const inventory = physical.appleInventory();
    if (inventory.kind === "observed") {
        const udids: string[] = inventory.devices.map(device => device.udid);
        void udids;
    } else {
        const reason: "missing-executable" | "command-failed" = inventory.reason;
        void reason;
    }
    const receipt: { observed: boolean } = inventory.receipt;
    void receipt;
    const connected: PhysicalExecution<{ observed: boolean }> = physical.connectAndroid("host:5555");
    const stopped: PhysicalExecution<{ observed: boolean }> = physical.observePhysicalStop("android-device");
    const completed: boolean[] = [connected.ok, stopped.ok];
    const executionReceipts: { observed: boolean }[] = [connected.receipt, stopped.receipt];
    void [completed, executionReceipts];
    // @ts-expect-error native exit status stays outside semantic physical completion
    void connected.status;
    // @ts-expect-error native failure detail stays inside the opaque receipt
    void stopped.error;
    // @ts-expect-error raw native connect execution does not supply semantic completion
    createBrokerPhysicalDevicesApplication({ ...physical, connectAndroid: () => ({ status: 0, receipt: { observed: true } }) });
    // @ts-expect-error raw native stop execution does not supply semantic completion
    createBrokerPhysicalDevicesApplication({ ...physical, observePhysicalStop: () => ({ status: 0, receipt: { observed: true } }) });
    // @ts-expect-error native connect completion settles synchronously
    createBrokerPhysicalDevicesApplication({ ...physical, connectAndroid: async () => ({ ok: true, receipt: { observed: true } }) });
    // @ts-expect-error raw native execution is not a semantic inventory observation
    createBrokerPhysicalDevicesApplication({ ...physical, appleInventory: () => ({ status: 0, stdout: "raw", receipt: { observed: true } }) });
    // @ts-expect-error an observed inventory requires decoded devices
    createBrokerPhysicalDevicesApplication({ ...physical, appleInventory: () => ({ kind: "observed", receipt: { observed: true } }) });
    // @ts-expect-error native failures have a finite reason
    createBrokerPhysicalDevicesApplication({ ...physical, appleInventory: () => ({ kind: "failed", reason: "arbitrary native prose", receipt: { observed: true } }) });
    const { appleInventory, ...withoutInventory } = physical;
    // @ts-expect-error inventory observation is required for visibility before lease admission
    createBrokerPhysicalDevicesApplication(withoutInventory);
    void appleInventory;
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
    const { prepareStop, ...withoutPreparation } = cleanup;
    // @ts-expect-error owner stop admission requires native preparation
    createBrokerOwnerCleanupApplication(withoutPreparation);
    const { runPreparedStop, ...withoutRun } = cleanup;
    // @ts-expect-error one captured native stop effect is required
    createBrokerOwnerCleanupApplication(withoutRun);
    // @ts-expect-error native stop preparation settles synchronously
    createBrokerOwnerCleanupApplication({ ...cleanup, prepareStop: async () => ({ kind: "prepared", handle: { deviceId: "phone" } }) });
    // @ts-expect-error native stop observations settle synchronously
    createBrokerOwnerCleanupApplication({ ...cleanup, runPreparedStop: async () => ({ ok: true, operationKind: "metadata-only", receipt: { observed: true } }) });
    const { observePhysicalStop, ...withoutObservation } = physical;
    // @ts-expect-error the physical stop observation is required
    createBrokerPhysicalDevicesApplication(withoutObservation);
    // @ts-expect-error physical stop observation cannot defer its outcome
    createBrokerPhysicalDevicesApplication({ ...physical, observePhysicalStop: async () => ({ ok: true, receipt: { observed: true } }) });
    void [prepareStop, runPreparedStop, observePhysicalStop];
    return { devices, owner, releaseLease, publish };
}

describe("physical stop record", () => {
    it("retains the definition while detaching and clearing its exact claim", () => {
        expect(physicalStopReplacement({ id: "phone", serial: "usb", status: "attached", leaseClaimId: "old", leaseClaimNonce: "nonce", label: "keep" }, "now")).toEqual({
            id: "phone", serial: "usb", status: "detached", leaseClaimId: null, leaseClaimNonce: null, label: "keep", updatedAt: "now",
        });
    });
});
