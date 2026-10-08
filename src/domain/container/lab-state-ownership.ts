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

export interface LabStateCommandObservation {
    error?: unknown;
    status: number | null;
    stdout: string;
}

export interface LabStateOwnershipObservation {
    error?: unknown;
    status: number | null;
}
