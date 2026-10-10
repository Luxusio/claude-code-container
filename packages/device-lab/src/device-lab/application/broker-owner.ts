import { equivalentOwnerRegistration, ownerRegistrationRecord, type BrokerOwnerRegistration, type BrokerOwnerResult } from "../domain/broker-owner.js";
import type { BrokerOwnerPorts } from "../ports/broker-owner.js";

export function createBrokerOwnerApplication(ports: BrokerOwnerPorts) {
    function validateRegistration(value: unknown, ownerId: string): BrokerOwnerRegistration {
        const registration = ownerRegistrationRecord(value, ownerId);
        const profile = registration.profile === null ? undefined : registration.profile;
        if (ports.hostProjectMountPath(registration.hostProjectPath) === null) throw new Error("invalid-owner-registration");
        const identity = ports.identity(registration.projectMountPath, profile);
        if (!identity || identity.ownerId !== ownerId || identity.ownerBasis !== registration.ownerBasis
            || ports.hostProjectMountPath(registration.hostProjectPath) !== registration.projectMountPath) throw new Error("invalid-owner-registration");
        return registration;
    }
    function register(cwd: string, profile?: string, expectedOwnerId?: string): BrokerOwnerRegistration {
        const hostProjectPath = ports.resolveHostPath(cwd);
        const projectMountPath = ports.projectMountPath(hostProjectPath);
        const identity = ports.identity(projectMountPath, profile);
        if (!identity || (expectedOwnerId !== undefined && identity.ownerId !== expectedOwnerId)) throw new Error("device-broker-owner-registration-mismatch");
        ports.prepareRegistrations();
        const file = ports.registrationFile(identity.ownerId);
        const registration: BrokerOwnerRegistration = { version: 1, ownerId: identity.ownerId, ownerBasis: identity.ownerBasis,
            projectMountPath: identity.projectMountPath, hostProjectPath, profile: identity.profile ?? null, registeredAt: ports.timestamp() };
        return ports.withRegistrationLock(file, () => {
            const existing = ports.readRegistration(identity.ownerId);
            if (existing && equivalentOwnerRegistration(existing, identity)) return existing;
            ports.writeRegistration(file, registration);
            return registration;
        });
    }
    function secret(ownerId: string): string {
        const file = ports.authFile(ownerId);
        if (ports.inspectAuthDirectory()) {
            const existing = ports.readSecret(ownerId);
            if (existing) return existing;
        }
        ports.prepareAuthDirectory();
        try {
            return ports.withAuthLock(file, () => {
                const concurrent = ports.readSecret(ownerId);
                if (concurrent) return concurrent;
                ports.removeAbandonedAuthArtifacts(file);
                const quarantine = ports.quarantineAuth(file);
                const next = ports.newSecret();
                ports.publishSecret(file, { ownerId, secret: next, createdAt: ports.timestamp(), version: 1 });
                // Failed publication leaves invalid material quarantined as evidence.
                if (quarantine) ports.removeQuarantine(quarantine);
                return next;
            });
        } catch (error) {
            if (error && typeof error === "object" && "code" in error && error.code === "shared-mutation-lock-timeout") throw new Error("device-broker-auth-lock-timeout");
            throw error;
        }
    }
    function resolve(request: unknown): BrokerOwnerResult {
        const input = request as {projectMountPath?: unknown; profile?: unknown};
        const projectMountPath = typeof input.projectMountPath === "string" ? input.projectMountPath : "";
        const profile = input.profile === null || input.profile === undefined ? undefined : typeof input.profile === "string" ? input.profile : null;
        const identity = profile === null ? null : ports.identity(projectMountPath, profile);
        if (!identity) return { status: 400, payload: {ok: false, error: "invalid-project-owner-request", projectMountPath, profile: input.profile ?? null} };
        let registration: BrokerOwnerRegistration | null;
        try { registration = ports.readRegistration(identity.ownerId); }
        catch { return {status: 409, payload: {ok: false, error: "project-owner-registration-invalid"}}; }
        if (!registration || !equivalentOwnerRegistration(registration, identity)) return {status: 404, payload: {ok: false, error: "project-owner-unavailable"}};
        try { secret(identity.ownerId); }
        catch { return {status: 503, payload: {ok: false, error: "owner-auth-provisioning-failed"}}; }
        return {status: 200, payload: {ok: true, result: {ownerId: identity.ownerId, ownerBasis: identity.ownerBasis, projectMountPath: identity.projectMountPath, profile: identity.profile ?? null}}};
    }
    return { register, resolve, secret, validateRegistration };
}
