import { describe, expect, it } from "vitest";
import { createBrokerOwnerApplication } from "../../../packages/device-lab/src/device-lab/application/broker-owner.js";
import { createBrokerPhysicalLeasesApplication } from "../../../packages/device-lab/src/device-lab/application/broker-physical-leases.js";
import type { BrokerOwnerRegistration, BrokerOwnerResolution } from "../../../packages/device-lab/src/device-lab/domain/broker-owner.js";
import { validateLeaseParams, type ClaimOutcome, type HeartbeatOutcome, type ReleaseOutcome, type PruneOutcome, type LeaseWaitBudget } from "../../../packages/device-lab/src/device-lab/domain/broker-physical-leases.js";
import type { BrokerOwnerPorts } from "../../../packages/device-lab/src/device-lab/ports/broker-owner.js";
import type { BrokerPhysicalLeasePorts } from "../../../packages/device-lab/src/device-lab/ports/broker-physical-leases.js";

function ownerContracts(ports: BrokerOwnerPorts) {
    const app = createBrokerOwnerApplication(ports);
    const registration: BrokerOwnerRegistration = app.register("/host/project", "work");
    const resolved: BrokerOwnerResolution = app.resolve({ projectMountPath: "/project/project", profile: "work" });
    const secret: string = app.secret(registration.ownerId);
    const { identity, ...withoutIdentity } = ports;
    // @ts-expect-error canonical owner identity authority is required
    createBrokerOwnerApplication(withoutIdentity);
    const { withAuthLock, ...withoutAuthLock } = ports;
    // @ts-expect-error credential mutation requires a native scoped lock
    createBrokerOwnerApplication(withoutAuthLock);
    const { publishSecret, ...withoutPublication } = ports;
    // @ts-expect-error secret publication authority is required
    createBrokerOwnerApplication(withoutPublication);
    // @ts-expect-error registration publication must settle synchronously
    createBrokerOwnerApplication({ ...ports, writeRegistration: async () => undefined });
    // @ts-expect-error credential publication cannot defer settlement
    createBrokerOwnerApplication({ ...ports, publishSecret: async () => undefined });
    // @ts-expect-error registration completes synchronously
    const asynchronous: Promise<unknown> = app.register("/host/project");
    void [registration, resolved, secret, identity, withAuthLock, publishSecret, asynchronous];
}
function leaseContracts<Timer>(ports: BrokerPhysicalLeasePorts<Timer>, budget: LeaseWaitBudget) {
    const app = createBrokerPhysicalLeasesApplication(ports);
    const request = { backend: "android-device", hardwareId: "phone", deviceId: "device" };
    const claim: ClaimOutcome = app.claim("owner", request);
    const heartbeat: HeartbeatOutcome = app.heartbeat("owner", request, budget);
    const released: ReleaseOutcome = app.release("owner", request);
    const pruned: PruneOutcome = app.prune("owner", { backend: "android-device" });
    const { withHardwareLock, ...withoutLock } = ports;
    // @ts-expect-error each hardware mutation requires its native lock
    createBrokerPhysicalLeasesApplication(withoutLock);
    const { read, ...withoutRead } = ports;
    // @ts-expect-error guarded current-record reread is required
    createBrokerPhysicalLeasesApplication(withoutRead);
    const { remove, ...withoutRemoval } = ports;
    // @ts-expect-error native lease removal authority is required
    createBrokerPhysicalLeasesApplication(withoutRemoval);
    // @ts-expect-error guarded reads must settle synchronously
    createBrokerPhysicalLeasesApplication({ ...ports, read: async () => null });
    // @ts-expect-error lease removal cannot defer settlement
    createBrokerPhysicalLeasesApplication({ ...ports, remove: async () => undefined });
    const { schedule, ...withoutSchedule } = ports;
    // @ts-expect-error native periodic allocation is required
    createBrokerPhysicalLeasesApplication(withoutSchedule);
    const { cancel, ...withoutCancel } = ports;
    // @ts-expect-error native timer cancellation is required
    createBrokerPhysicalLeasesApplication(withoutCancel);
    const { unref, ...withoutUnref } = ports;
    // @ts-expect-error native timer lifetime release is required
    createBrokerPhysicalLeasesApplication(withoutUnref);
    // @ts-expect-error native timer allocation must settle synchronously
    createBrokerPhysicalLeasesApplication({...ports, schedule: async () => ({handle: null})});
    // @ts-expect-error native cancellation must settle synchronously
    createBrokerPhysicalLeasesApplication({...ports, cancel: async () => undefined});
    // @ts-expect-error native unref must settle synchronously
    createBrokerPhysicalLeasesApplication({...ports, unref: async () => undefined});
    const renewal: {intervalMs: number; ttlMs: number} = app.startHeartbeat("owner", request.backend, request.hardwareId, request.deviceId);
    const stopped: boolean = app.stopHeartbeat("owner", request.backend, request.hardwareId, request.deviceId);
    app.stopAllHeartbeats();
    void [schedule, cancel, unref, renewal, stopped];
    // @ts-expect-error lease claim completes synchronously
    const asynchronous: Promise<unknown> = app.claim("owner", request);
    void [claim, heartbeat, released, pruned, withHardwareLock, read, remove, asynchronous];
}
void [ownerContracts, leaseContracts];

describe("broker owner and lease type consumers", () => {
    it("rejects a lease duration shorter than the physical ownership minimum", () => {
        expect(validateLeaseParams({ backend: "android-device", hardwareId: "phone", ttlMs: 1 }, "claim")).toEqual({ ok: false, kind: "invalid", error: "invalid-lease-ttl-ms" });
    });
});
