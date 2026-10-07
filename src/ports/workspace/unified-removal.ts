import type { WorkspaceEntry } from "../../domain/workspace/source-entry.js";

export interface UnifiedRemovalRequest {
    readonly repositoryPath: string;
    readonly destinationPath: string;
    readonly branch: string;
    readonly options: { force?: boolean } | undefined;
}

export type RemovalStatus = { readonly kind: "failed"; readonly readDetail: () => string }
    | { readonly kind: "observed"; readonly readContent: () => string };
export type BranchObservation = { readonly failed: boolean; readonly observedBranch: string };
export type RootStatusTarget<Q> = { readonly kind: "workspace"; readonly stage: "pre" | "final" }
    | { readonly kind: "quarantined"; readonly root: Q };
export type GitMetadataKind = "directory" | "worktree" | "gitlink";
export type PathContent = "absent" | "empty" | "unreadable" | "content" | "repository" | "broken-worktree";

export interface UnifiedRemovalPorts<D, S extends object | symbol, F, R, Q> {
    readonly scanSource: (request: UnifiedRemovalRequest) => WorkspaceEntry[];
    readonly destinationPath: (request: UnifiedRemovalRequest, name: string) => string;
    readonly pathExists: (path: string) => boolean;
    readonly captureSourceIdentity: (source: string) => S;
    readonly captureDestinationFence: (request: UnifiedRemovalRequest, destination: string) => F;
    readonly assertWorkspaceIdentity: (request: UnifiedRemovalRequest, identity: D) => void;
    readonly assertSourceIdentity: (source: string, identity: S) => void;
    readonly assertDestinationFence: (request: UnifiedRemovalRequest, destination: string, fence: F) => void;
    readonly metadataExists: (destination: string) => boolean;
    readonly metadataKind: (destination: string) => GitMetadataKind;
    readonly unreachableRecordedPath: (error: unknown) => string | null;
    readonly isTrackedGitlink: (request: UnifiedRemovalRequest, repositories: WorkspaceEntry[], entry: WorkspaceEntry) => boolean;
    readonly inspectNestedStatus: (destination: string) => RemovalStatus;
    readonly worktreeMatches: (source: string, destination: string) => boolean;
    readonly pathContent: (destination: string) => PathContent;
    readonly unmanagedPathRefusal: (destination: string, content: PathContent) => string;
    readonly unreadablePathRefusal: (destination: string) => string;
    readonly captureDirectoryIdentity: (destination: string) => D;
    readonly captureRegistration: (request: UnifiedRemovalRequest, source: string, destination: string, identity: D) => R;
    readonly removeRegisteredNested: (request: UnifiedRemovalRequest, source: string, destination: string, identity: D, registration: R, force: boolean, sourceIdentity: S, guard: () => void) => void;
    readonly relayEntryError: (name: string, destination: string, error: unknown) => string;
    readonly assertRootOwnership: (request: UnifiedRemovalRequest) => void;
    readonly inspectRootBranch: (request: UnifiedRemovalRequest) => BranchObservation;
    readonly inspectRootStatus: (request: UnifiedRemovalRequest, sourceEntries: WorkspaceEntry[], target: RootStatusTarget<Q>, mode: "ordinary" | "ignored") => RemovalStatus;
    readonly workspaceName: (request: UnifiedRemovalRequest) => string;
    readonly sourceName: (request: UnifiedRemovalRequest) => string;
    readonly removeRegisteredRoot: (request: UnifiedRemovalRequest, identity: D, registration: R, veto: ((root: Q) => void) | undefined) => void;
}
