/** Existing public clean options; no force or claim-bypass option is introduced. */
export interface CleanOptions {
    volumes?: boolean;
    all?: boolean;
    dryRun?: boolean;
    yes?: boolean;
}

export interface ContainerInfo {
    id: string;
    name: string;
    /** Native status text is retained only for display. */
    status: string;
    running: boolean;
}

export interface ImageInfo {
    repository: string;
    id: string;
    size: string;
}

export interface CleanMutationResult {
    ok: boolean;
}

export type CleanInventoryResult<T> =
    | { kind: "observed"; items: T[] }
    | { kind: "unavailable" };
