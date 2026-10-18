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

/** Cleanup decisions supplied to the outward progress renderer. */
export type CleanProgress =
    | { kind: "nothing-to-clean" | "containers-to-stop" | "containers-to-remove" | "images-to-remove" | "volumes-to-remove" | "dry-run" | "aborted" }
    | { kind: "container-selected"; name: string; status: string }
    | { kind: "image-selected"; repository: string; id: string; size: string }
    | { kind: "volume-selected"; name: string }
    | { kind: "container-claimed"; name: string; claimCount: number }
    | { kind: "stopping-container" | "removing-container"; name: string }
    | { kind: "removing-image"; repository: string; id: string }
    | { kind: "removing-volume"; name: string }
    | { kind: "completed"; removed: number };

/** Cleanup refusal/failure decisions; native adapters construct their errors. */
export type CleanFailure =
    | { kind: "inventory-unavailable"; inventory: "containers" | "images" | "volumes" }
    | { kind: "unmanaged-container" | "stop-container-failed" | "remove-container-failed"; name: string }
    | { kind: "remove-image-failed"; repository: string }
    | { kind: "remove-volume-failed"; name: string };
