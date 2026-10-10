import type { BrokerOwnerIdentity, BrokerOwnerRegistration } from "../domain/broker-owner.js";
/** Captured native quarantine identity; the application never interprets it. */
export interface BrokerAuthQuarantine {
    path: string; dev: number; ino: number; uid: number; nlink: number;
    kind: "file" | "symlink" | "other";
}
export interface BrokerOwnerPorts {
    resolveHostPath(cwd: string): string;
    projectMountPath(hostPath: string): string;
    identity(projectMountPath: string, profile?: string): BrokerOwnerIdentity | null;
    hostProjectMountPath(hostPath: string): string | null;
    prepareRegistrations(): undefined;
    registrationFile(ownerId: string): string;
    readRegistration(ownerId: string): BrokerOwnerRegistration | null;
    writeRegistration(file: string, registration: BrokerOwnerRegistration): undefined;
    withRegistrationLock<Result>(file: string, operation: () => Result): Result;
    timestamp(): string;
    authFile(ownerId: string): string;
    inspectAuthDirectory(): boolean;
    prepareAuthDirectory(): undefined;
    readSecret(ownerId: string): string | null;
    withAuthLock<Result>(file: string, operation: () => Result): Result;
    removeAbandonedAuthArtifacts(file: string): undefined;
    quarantineAuth(file: string): BrokerAuthQuarantine | null;
    newSecret(): string;
    publishSecret(file: string, record: {ownerId: string; secret: string; createdAt: string; version: 1}): undefined;
    removeQuarantine(quarantine: BrokerAuthQuarantine): undefined;
}
