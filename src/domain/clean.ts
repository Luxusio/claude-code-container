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
    status: string;
}

export interface ImageInfo {
    repository: string;
    id: string;
    size: string;
}

/** Native results stay raw so truthiness and lazy field reads remain visible. */
export interface CleanMutationResult {
    error?: unknown;
    status: number | null;
}

export interface CleanInventoryResult extends CleanMutationResult {
    stdout?: string | null;
}
