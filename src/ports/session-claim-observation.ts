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

export interface BeginSessionClaimObservation {
    readonly receipt: SessionOwnershipReceipt;
    readonly binding: SessionClaimObservationBinding;
    readonly runtimeInvocation: NativeRuntimeInvocation;
    readonly guardian: { readonly pid: number; readonly startToken: string | null };
    readonly generation: string;
}

/** Mutations require the caller's already-held lifecycle guard. No method acquires or re-enters it. */
export interface SessionClaimObservationStore {
    begin(options: BeginSessionClaimObservation): SessionClaimObservationSnapshot;
    read(receipt: SessionOwnershipReceipt, binding: SessionClaimObservationBinding | { readonly prefix: string }): SessionClaimObservationSnapshot | null;
    matches(snapshot: SessionClaimObservationSnapshot): boolean;
    assertCurrent(snapshot: SessionClaimObservationSnapshot): void;
    update(snapshot: SessionClaimObservationSnapshot, observation: SessionClaimObservation): SessionClaimObservationSnapshot;
    retire(snapshot: SessionClaimObservationSnapshot): void;
}
