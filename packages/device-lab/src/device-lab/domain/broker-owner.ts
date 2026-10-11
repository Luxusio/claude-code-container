export interface BrokerOwnerIdentity {
    ownerId: string; ownerBasis: string; projectMountPath: string; profile?: string;
}
export interface BrokerOwnerRegistration {
    version: 1; ownerId: string; ownerBasis: string; projectMountPath: string;
    hostProjectPath: string; profile?: string | null; registeredAt: string;
}
export type BrokerOwnerResolution =
    | {kind: "resolved"; identity: BrokerOwnerIdentity}
    | {kind: "invalid-request"; projectMountPath: string; profile: unknown}
    | {kind: "registration-invalid"}
    | {kind: "unavailable"}
    | {kind: "auth-provisioning-failed"};
export function equivalentOwnerRegistration(registration: BrokerOwnerRegistration, identity: BrokerOwnerIdentity): boolean {
    return registration.ownerBasis === identity.ownerBasis
        && registration.projectMountPath === identity.projectMountPath
        && registration.profile === (identity.profile ?? null);
}
function isOwnerRegistrationRecord(value: unknown, ownerId: string): value is BrokerOwnerRegistration {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    if (record.version !== 1 || record.ownerId !== ownerId || typeof record.ownerBasis !== "string"
        || typeof record.projectMountPath !== "string" || typeof record.hostProjectPath !== "string"
        || (record.profile !== null && record.profile !== undefined && typeof record.profile !== "string")
        || typeof record.registeredAt !== "string") return false;
    return true;
}
export function ownerRegistrationRecord(value: unknown, ownerId: string): BrokerOwnerRegistration {
    if (!isOwnerRegistrationRecord(value, ownerId)) throw new Error("invalid-owner-registration");
    return value;
}
