export interface RemoveResult {
    removed: string[];
    errors: string[];
}

export interface WorkspaceRemovalRequest {
    sourcePath: string;
    branch: string;
    force: boolean;
}

export interface WorkspaceStrandedRegistration {
    repository: string;
    lockedPaths: string[];
}

export type WorkspaceRemovalOutcome =
    | { kind: "removed"; result: RemoveResult; removedContainers: string[]; stranded: WorkspaceStrandedRegistration[] }
    | { kind: "incomplete"; result: RemoveResult }
    | { kind: "failed"; error: unknown; result: RemoveResult | null };

export type WorkspaceRemovalProgress =
    | { kind: "started"; branch: string }
    | { kind: "containers-removed"; names: readonly string[] }
    | { kind: "result"; removed: readonly string[]; errors: readonly string[] }
    | { kind: "incomplete"; removed: readonly string[] }
    | { kind: "removed" };
