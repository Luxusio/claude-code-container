import { createPhysicalLeases } from "../../../packages/device-lab/providers/application/physical-leases.mjs";
import { claimPhysicalLease, readPhysicalLeases, releasePhysicalLeaseWithMutation } from "../../../packages/device-lab/providers/state/physical-lease-store.mjs";
import type { PhysicalLease, PhysicalLeasePorts, PhysicalLeaseTransaction } from "../../../packages/device-lab/providers/ports/physical-leases.mjs";

function consumedDirectLeaseCapabilities<Timer>(ports: PhysicalLeasePorts<Timer>, transaction: PhysicalLeaseTransaction): void {
    const application = createPhysicalLeases(ports);
    const leases: PhysicalLease[] = application.read("android-device");
    const claim = application.claim("android-device", "serial", "owned-device", { ttlMs: 60_000, claimNonce: "operation" });
    if (claim.ok) {
        const owner: string = claim.lease.ownerId;
        const reused: true | undefined = claim.reused;
        void [owner, reused];
    } else {
        const conflict: PhysicalLease | undefined = claim.conflict;
        const error: string | undefined = claim.error;
        void [conflict, error];
    }
    const residue = application.releaseResidue("android-device", { hardwareId: "serial", deviceId: "owned-device" }, { requireLockAbsent: true });
    if (residue.ok) {
        const removed: boolean = residue.authoritativeLockRemoved;
        void removed;
    } else {
        const error: string = residue.error;
        void error;
    }
    const mutation = application.releaseWithMutation("android-device", "serial", "owned-device", { claimNonce: "operation" }, () => ({ ok: true, restored: true, rollback: () => undefined }));
    if (mutation.ok) {
        const restored: boolean = mutation.mutation.restored;
        void restored;
    }
    const publicRead: typeof application.read = readPhysicalLeases;
    const publicClaim: typeof application.claim = claimPhysicalLease;
    const publicMutation: typeof application.releaseWithMutation = releasePhysicalLeaseWithMutation;

    const { owner, ...withoutOwner } = ports;
    // @ts-expect-error Direct lease decisions require current native owner authority.
    createPhysicalLeases(withoutOwner);
    const { withTransaction, ...withoutTransaction } = ports;
    // @ts-expect-error Lease publication requires the guarded native transaction scope.
    createPhysicalLeases(withoutTransaction);
    const { writeAggregate, ...withoutAggregateWrite } = transaction;
    // @ts-expect-error The transaction must expose aggregate publication for commit and compensation.
    createPhysicalLeases({ ...ports, withTransaction: (_backend, _hardwareId, operation) => operation(withoutAggregateWrite) });
    // @ts-expect-error Authoritative lease publication must settle within the held native locks.
    createPhysicalLeases({ ...ports, withTransaction: (_backend, _hardwareId, operation) => operation({ ...transaction, writeLease: async () => undefined }) });
    // @ts-expect-error A deferred transaction cannot implement the synchronous direct lease API.
    createPhysicalLeases({ ...ports, withTransaction: async (_backend, _hardwareId, operation) => operation(transaction) });
    void [leases, publicRead, publicClaim, publicMutation, owner, withTransaction, writeAggregate];
}
void consumedDirectLeaseCapabilities;
