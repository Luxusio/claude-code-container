import type { CleanupRecord } from "./device-admin-cleanup.js";
export type PhysicalDeleteLease = Record<string, unknown> & { ownerId?: string; deviceId?: string; hardwareId?: string; expiresAt?: string };
export type ManagedResourceDeletion<Evidence> = { state: "success" | "failure"; evidence: Evidence } | { state: "no-result" };
export type DeviceAdminDeleteResult<Evidence = unknown> = { ok: true; evidence: Evidence[] } | { ok: false; reason: string; evidence: Evidence[] };

export function physicalLeaseMatchesOwnerDevice(ownerId: string, device: CleanupRecord, lease: PhysicalDeleteLease | null): boolean {
    const claimId = typeof device.leaseClaimId === "string" ? device.leaseClaimId : null;
    const nonce = typeof device.leaseClaimNonce === "string" ? device.leaseClaimNonce : null;
    const generation = claimId && nonce ? lease?.claimId === claimId && lease?.claimNonce === nonce : !lease?.claimId && !lease?.claimNonce;
    return lease?.ownerId === ownerId && (!device.id || !lease.deviceId || lease.deviceId === device.id) && Boolean(generation);
}
