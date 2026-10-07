import type { WorkspaceEntry } from "../../domain/workspace/source-entry.js";
import type { WorktreeAdditionAction, WorktreeAdditionPorts } from "./worktree-addition.js";

export interface MultiCreationRequest {
    readonly repositoryPath: string;
    readonly destinationPath: string;
    readonly branch: string;
}

export interface MultiCreationPorts<Prepared, Registration, WorkspaceIdentity, CopiedIdentity>
    extends WorktreeAdditionPorts<Prepared, Registration> {
    readonly scanSource: (request: MultiCreationRequest) => WorkspaceEntry[];
    readonly destinationPath: (request: MultiCreationRequest, name: string) => string;
    readonly ensureWorkspaceParent: (request: MultiCreationRequest) => void;
    readonly createWorkspaceExclusive: (request: MultiCreationRequest) => void;
    readonly captureWorkspaceIdentity: (request: MultiCreationRequest) => WorkspaceIdentity;
    readonly requireRegistration: (receipt: Registration | null, destination: string) => Registration;
    readonly pathExists: (path: string) => boolean;
    readonly worktreeMatches: (source: string, destination: string) => boolean;
    readonly removeRegisteredWorktree: (
        request: MultiCreationRequest, source: string, destination: string, receipt: Registration,
    ) => void;
    readonly rollbackCreatedBranch: (
        source: string, branch: string, action: WorktreeAdditionAction, prepared: Prepared | null,
    ) => void;
    readonly assertWorkspaceIdentity: (request: MultiCreationRequest, identity: WorkspaceIdentity) => void;
    readonly workspaceEntryCount: (request: MultiCreationRequest) => number;
    readonly quarantineWorkspace: (request: MultiCreationRequest, identity: WorkspaceIdentity) => void;
    readonly copyEntry: (source: string, destination: string) => void;
    readonly captureCopiedIdentity: (destination: string) => CopiedIdentity;
    readonly quarantineCopiedEntry: (
        request: MultiCreationRequest, destination: string, identity: CopiedIdentity,
    ) => void;
}
