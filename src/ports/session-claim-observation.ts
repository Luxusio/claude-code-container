import type { SessionClaimObservation, SessionClaimObservationBinding } from "../domain/session-claim-observation.js";
import type { NativeRuntimeInvocation } from "./container-runtime-invocation.js";
import type { SessionOwnershipReceipt } from "./session-ownership.js";

export interface NativeSessionFileReceipt {
    readonly path: string;
    readonly bytes: string;
    readonly device: string;
    readonly inode: string;
    readonly birthtime: string;
}

export interface SessionClaimObservationSnapshot {
    readonly observation: SessionClaimObservation;
    readonly receipt: SessionOwnershipReceipt;
    readonly runtimeInvocation: NativeRuntimeInvocation;
    readonly runtimeReceipt: NativeSessionFileReceipt;
    readonly observationReceipt: NativeSessionFileReceipt;
}

/** Recovery evidence is not ordinary authority until its two device fields are rebound. */
export interface SessionClaimDeviceDriftCandidate {
    readonly observation: SessionClaimObservation;
    readonly receipt: SessionOwnershipReceipt;
    readonly runtimeInvocation: NativeRuntimeInvocation;
}

export interface SessionClaimDeviceDriftRecovery {
    capture(receipt: SessionOwnershipReceipt,
        binding: SessionClaimObservationBinding | { readonly prefix: string }): SessionClaimDeviceDriftCandidate | null;
    assertCurrent(candidate: SessionClaimDeviceDriftCandidate): void;
    /** The caller revalidates both stale process generations and its original cohort under the lifecycle guard. */
    repair(candidate: SessionClaimDeviceDriftCandidate, revalidate: () => void): SessionClaimObservationSnapshot;
}

export interface BeginSessionClaimObservation {
    readonly receipt: SessionOwnershipReceipt;
    readonly binding: SessionClaimObservationBinding;
    readonly runtimeInvocation: NativeRuntimeInvocation;
    readonly guardian: { readonly pid: number; readonly startToken: string | null };
    readonly generation: string;
}

/** Mutations require the caller's already-held lifecycle guard. No method acquires or re-enters it. */
export interface SessionClaimObservationStore {
    deviceDriftRecovery?: SessionClaimDeviceDriftRecovery;
    begin(options: BeginSessionClaimObservation): SessionClaimObservationSnapshot;
    read(receipt: SessionOwnershipReceipt, binding: SessionClaimObservationBinding | { readonly prefix: string }): SessionClaimObservationSnapshot | null;
    matches(snapshot: SessionClaimObservationSnapshot): boolean;
    assertCurrent(snapshot: SessionClaimObservationSnapshot): void;
    update(snapshot: SessionClaimObservationSnapshot, observation: SessionClaimObservation): SessionClaimObservationSnapshot;
    retire(snapshot: SessionClaimObservationSnapshot): void;
}
