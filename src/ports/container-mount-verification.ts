import type {
    LiveSourceProof,
    MountPresencePolicy,
    MountVerification,
    ObservedMountContract,
} from "../domain/container/mount-verification.js";

export type MountSourceMatch = "match" | "mismatch" | "unavailable";

/** Native source interpretation, without runtime paths or inspect DTOs. */
export type ContainerMountSourceFacts =
    | { kind: "none" }
    | { kind: "volume"; matches: boolean }
    | { kind: "filesystem"; pathMatch: MountSourceMatch }
    | {
        kind: "path" | "daemon";
        generalPathMatch: MountSourceMatch;
        literalSourceMatch: boolean;
        requireLiteralSource: boolean;
        requireDaemonProofOnMatch: boolean;
    };

export type CreatedMountObservation =
    | { kind: "unavailable" }
    | {
        kind: "observed";
        containerId: unknown;
        projectMountIdentity: unknown;
        mounts: ObservedMountContract[];
    };

export type StoppedMountPreflight =
    | { kind: "preflight-verified" }
    | { kind: "mismatch" | "retryable"; reason: string };

/** One factory binds these effects to one exact target and required mount set. */
export interface ContainerMountVerificationPorts {
    observeHostIdentity(containerPath: string): LiveSourceProof;
    observeSource(containerPath: string): ContainerMountSourceFacts;
    proveFilesystem(containerPath: string, finalAttempt: boolean): LiveSourceProof;
    proveDaemon(): LiveSourceProof;
    resetAttempt(): void;
    cleanup(): void;
    inspectCreated(): CreatedMountObservation;
    requiresFinalDaemonProof(): boolean;
    withRetry(
        operation: (finalAttempt: boolean) => MountVerification,
        isRetryable: (result: MountVerification) => boolean,
    ): MountVerification;
}

export interface ContainerMountVerification {
    verifyExisting(
        observed: ObservedMountContract[],
        policy: MountPresencePolicy,
        allowUnexpected?: boolean,
    ): MountVerification;
    preflightStopped(observed: ObservedMountContract[]): StoppedMountPreflight;
    verifyCreated(expectedId: string, expectedProjectIdentity: string): MountVerification;
}
