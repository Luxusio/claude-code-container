import type { CleanupCommandResult, CleanupRecord } from "./device-admin-cleanup.js";
export type PhysicalDeleteLease = Record<string, unknown> & { ownerId?: string; deviceId?: string; hardwareId?: string; expiresAt?: string };
export type DeviceAdminDeleteResult = { ok: true; commands: CleanupCommandResult[] } | { ok: false; reason: string; commands: CleanupCommandResult[] };

export function physicalLeaseMatchesOwnerDevice(ownerId: string, device: CleanupRecord, lease: PhysicalDeleteLease | null): boolean {
    const claimId = typeof device.leaseClaimId === "string" ? device.leaseClaimId : null;
    const nonce = typeof device.leaseClaimNonce === "string" ? device.leaseClaimNonce : null;
    const generation = claimId && nonce ? lease?.claimId === claimId && lease?.claimNonce === nonce : !lease?.claimId && !lease?.claimNonce;
    return lease?.ownerId === ownerId && (!device.id || !lease.deviceId || lease.deviceId === device.id) && Boolean(generation);
}
export function macosDeleteArgs(provider: string, instance: string): string[] | null {
    return ["tart", "vz", "utmctl"].includes(provider) ? ["delete", instance] : null;
}
export function macosDeleteFailure(provider: string, instance: string, stderr: string): CleanupCommandResult {
    return { command: `${provider} delete ${instance}`, status: null, stdout: "", stderr };
}
