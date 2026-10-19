import type { RemoveResult, WorkspaceRemovalProgress, WorkspaceStrandedRegistration } from "../../domain/workspace/removal-result.js";

export interface WorkspaceCliContainerIdentity {
    containerId: string;
    running: boolean;
}

export type WorkspaceCliStrandedRegistration = WorkspaceStrandedRegistration;

export type WorkspaceContainerNames =
    | { kind: "listed"; names: readonly string[] }
    | { kind: "unavailable" };

export interface WorkspaceCliContainerRuntime {
    listNames(): WorkspaceContainerNames;
    stop(id: string): undefined;
    remove(id: string): undefined;
}

export type WorkspaceCliFamilyLock = <T>(projectId: string, operation: () => T) => T;
export type WorkspaceCliOwnershipAssertion = (
    workspacePath: string, branch: string, sourcePath: string, options: { allowTrackedGitlinks: true },
) => undefined;

/** Native callable selection remains local to the original evaluation site. */
export interface WorkspaceCliRemovalPorts {
    resolveSource(sourcePath: string): string;
    selectWorkspacePath(): (cwd: string, branch: string) => string;
    selectProjectId(): (workspacePath: string) => string;
    selectFamilyLock(): WorkspaceCliFamilyLock;
    selectClaims(): (projectId: string) => string[];
    selectOwnershipAssertion(): WorkspaceCliOwnershipAssertion;
    selectRuntimeReadiness(): () => undefined;
    selectContainerName(): (workspacePath: string) => string;
    selectManagedIdentity(): (name: string, workspacePath: string) => WorkspaceCliContainerIdentity | null;
    selectExists(): (name: string) => boolean;
    selectContainerRuntime(): WorkspaceCliContainerRuntime;
    selectRemoveWorkspace(): (cwd: string, branch: string, options: { force: boolean }) => RemoveResult;
    publish(event: WorkspaceRemovalProgress): undefined;
    selectStrandedRegistrations(): (cwd: string, branch: string) => WorkspaceCliStrandedRegistration[];
}
