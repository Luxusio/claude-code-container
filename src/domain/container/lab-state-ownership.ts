export interface LabStatePrincipal {
    uid: number;
    gid: number;
}

declare const labOwnershipHelperScope: unique symbol;

/** A call-local native context, created by trusted composition and never supplied over a wire. */
export interface LabOwnershipHelperScope {
    readonly [labOwnershipHelperScope]: true;
}

export type LabStateOwnershipIntent =
    | { kind: "verify" }
    | { kind: "migrate"; oldUid: number; oldGid: number };

export type LabVolumePresence = "present" | "absent" | "unavailable";
export type LabVolumeUse = "idle" | "in-use" | "unavailable";

export type LabPreviousPrincipal =
    | { kind: "known"; principal: LabStatePrincipal }
    | { kind: "unavailable" };

/** Unconfirmed application may have changed ownership and does not permit replay. */
export type LabOwnershipApplication = "applied" | "unconfirmed";
