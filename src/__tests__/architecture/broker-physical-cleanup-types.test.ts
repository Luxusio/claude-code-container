import { describe, expect, it } from "vitest";
import { createBrokerPhysicalDevicesApplication } from "../../../packages/device-lab/src/device-lab/application/broker-physical-devices.js";
import { createBrokerOwnerCleanupApplication } from "../../../packages/device-lab/src/device-lab/application/broker-owner-cleanup.js";
import { physicalStopReplacement, type PhysicalExecution } from "../../../packages/device-lab/src/device-lab/domain/broker-physical-devices.js";
import type { BrokerPhysicalDevicesPorts } from "../../../packages/device-lab/src/device-lab/ports/broker-physical-devices.js";
import type { BrokerOwnerAuxiliaryAsyncPorts, BrokerOwnerCleanupPorts } from "../../../packages/device-lab/src/device-lab/ports/broker-owner-cleanup.js";
import type { AuxiliaryOutcome, CleanupDeviceOutcome, CleanupTermination } from "../../../packages/device-lab/src/device-lab/domain/broker-owner-cleanup.js";

export function consumedPhysicalCleanupContracts(physical: BrokerPhysicalDevicesPorts<string, { observed: boolean }>, cleanup: BrokerOwnerCleanupPorts<string, { observed: boolean }>): {
    devices: ReturnType<typeof createBrokerPhysicalDevicesApplication<string, { observed: boolean }>>;
    owner: ReturnType<typeof createBrokerOwnerCleanupApplication<string, { observed: boolean }>>;
    releaseLease: BrokerPhysicalDevicesPorts<string, { observed: boolean }>["releaseLease"];
    publish: BrokerOwnerCleanupPorts<string, { observed: boolean }>["publish"];
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
    const { stopLocked, ...withoutStop } = cleanup;
    // @ts-expect-error the existing locked canonical lifecycle stop is required
    createBrokerOwnerCleanupApplication(withoutStop);
    // @ts-expect-error native exit status does not prove canonical stop completion
    createBrokerOwnerCleanupApplication({ ...cleanup, stopLocked: async () => ({ status: 0, changed: true }) });
    // @ts-expect-error successful canonical stop must report whether it committed a change
    createBrokerOwnerCleanupApplication({ ...cleanup, stopLocked: async () => ({ attempted: true, ok: true, observation: { ok: true, operationKind: "runtime-stop", receipt: { observed: true } } }) });
    // @ts-expect-error canonical stop settles asynchronously inside the held device operation
    createBrokerOwnerCleanupApplication({ ...cleanup, stopLocked: () => ({ attempted: false, ok: false, changed: false, error: "unavailable" }) });
    const termination = cleanup.terminateAppium({}, () => true);
    const semanticExit: boolean = termination.ok && termination.ended;
    const nativeReceipt: boolean = termination.receipt.ok;
    void [semanticExit, nativeReceipt];
    // @ts-expect-error accepting a signal is not a process exit proof
    createBrokerOwnerCleanupApplication({ ...cleanup, terminateAppium: () => ({ ok: true, receipt: { ok: true } }) });
    // @ts-expect-error Appium termination must settle before a synchronous physical guard releases
    createBrokerOwnerCleanupApplication({ ...cleanup, terminateAppium: async () => ({ ok: true, ended: true, receipt: { ok: true } }) });
    // @ts-expect-error recorder termination must settle before a synchronous physical guard releases
    createBrokerOwnerCleanupApplication({ ...cleanup, signalRecording: async () => ({ ok: true, ended: true, receipt: { ok: true } }) });
    // @ts-expect-error watchdog cancellation is synchronous and carries no process exit promise
    createBrokerOwnerCleanupApplication({ ...cleanup, cancelWatchdog: async () => ({ ok: true }) });
    createBrokerOwnerCleanupApplication({ ...cleanup, terminateAppium: (_runtime, stillCurrent) => {
        const authorized: boolean = stillCurrent();
        return { ok: authorized, ended: authorized, receipt: { ok: authorized } };
    } });
    const target = { backend: "android-emulator", stateKey: "android", deviceId: "emu" };
    const synchronousAuxiliary: AuxiliaryOutcome = owner.auxiliary("owner", target, {});
    const synchronousCleanupDevice: CleanupDeviceOutcome<{ observed: boolean }> = owner.cleanupDevice("owner", "ios-device", {}, { stopDevices: false, detachPhysical: true });
    const terminationThenable: PromiseLike<CleanupTermination> = {
        then: (fulfilled, rejected) => Promise.resolve<CleanupTermination>({ ok: true, ended: true, receipt: { ok: true } }).then(fulfilled, rejected),
    };
    const asyncEffects: BrokerOwnerAuxiliaryAsyncPorts = {
        terminateAppium: async (_runtime, stillCurrent) => {
            const authorized: boolean = stillCurrent();
            return { ok: authorized, ended: authorized, receipt: { ok: authorized } };
        },
        signalRecording: (_runtime, stillCurrent) => {
            const authorized: boolean = stillCurrent();
            return authorized ? terminationThenable : { ok: false, ended: false, receipt: { ok: false } };
        },
    };
    const asynchronousAuxiliary: Promise<AuxiliaryOutcome> = owner.auxiliaryAsync("owner", target, {}, asyncEffects);
    const synchronousEffectsAccepted: Promise<AuxiliaryOutcome> = owner.auxiliaryAsync("owner", target, {}, {
        terminateAppium: cleanup.terminateAppium, signalRecording: cleanup.signalRecording,
    });
    // @ts-expect-error asynchronous cleanup requires explicit native effects rather than synchronous fallback
    owner.auxiliaryAsync("owner", target, {});
    const { terminateAppium: asyncAppium, ...withoutAsyncAppium } = asyncEffects;
    // @ts-expect-error asynchronous Appium termination is a mandatory capability
    owner.auxiliaryAsync("owner", target, {}, withoutAsyncAppium);
    const { signalRecording: asyncRecording, ...withoutAsyncRecording } = asyncEffects;
    // @ts-expect-error asynchronous recorder termination is a mandatory capability
    owner.auxiliaryAsync("owner", target, {}, withoutAsyncRecording);
    // @ts-expect-error an awaited successful signal still requires semantic exit proof
    owner.auxiliaryAsync("owner", target, {}, { ...asyncEffects, signalRecording: async () => ({ ok: true, receipt: { ok: true } }) });
    void [synchronousAuxiliary, synchronousCleanupDevice, asynchronousAuxiliary, synchronousEffectsAccepted, asyncAppium, asyncRecording];
    const { observePhysicalStop, ...withoutObservation } = physical;
    // @ts-expect-error the physical stop observation is required
    createBrokerPhysicalDevicesApplication(withoutObservation);
    // @ts-expect-error physical stop observation cannot defer its outcome
    createBrokerPhysicalDevicesApplication({ ...physical, observePhysicalStop: async () => ({ ok: true, receipt: { observed: true } }) });
    void [stopLocked, observePhysicalStop];
    return { devices, owner, releaseLease, publish };
}

describe("physical stop record", () => {
    it("retains the definition while detaching and clearing its exact claim", () => {
        expect(physicalStopReplacement({ id: "phone", serial: "usb", status: "attached", leaseClaimId: "old", leaseClaimNonce: "nonce", label: "keep" }, "now")).toEqual({
            id: "phone", serial: "usb", status: "detached", leaseClaimId: null, leaseClaimNonce: null, label: "keep", updatedAt: "now",
        });
    });
});
