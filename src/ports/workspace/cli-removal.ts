import type { RemoveResult } from "../../domain/workspace/removal-result.js";

export interface WorkspaceCliContainerIdentity {
    containerId: string;
    running: boolean;
}

export interface WorkspaceCliStrandedRegistration {
    repository: string;
    lockedPaths: string[];
}

export interface WorkspaceCliRemovalRunner {
    (command: string, args: string[], options: { encoding: "utf-8"; stdio: ["ignore", "pipe", "pipe"] }): {
        error?: unknown; status: number | null; stdout?: string | null;
    };
    (command: string, args: string[], options: { stdio: "ignore" }): {
        error?: unknown; status: number | null;
    };
}

export type WorkspaceCliFamilyLock = <T>(projectId: string, operation: () => T) => T;
export type WorkspaceCliOwnershipAssertion = (
    workspacePath: string, branch: string, sourcePath: string, options: { allowTrackedGitlinks: true },
) => undefined;

/** Native callable selection remains local to the original evaluation site. */
export interface WorkspaceCliRemovalPorts {
    selectWorkspacePath(): (cwd: string, branch: string) => string;
    selectProjectId(): (workspacePath: string) => string;
    selectFamilyLock(): WorkspaceCliFamilyLock;
    selectClaims(): (projectId: string) => string[];
    selectOwnershipAssertion(): WorkspaceCliOwnershipAssertion;
    selectRuntimeReadiness(): () => undefined;
    selectContainerName(): (workspacePath: string) => string;
    selectManagedIdentity(): (name: string, workspacePath: string) => WorkspaceCliContainerIdentity | null;
    selectExists(): (name: string) => boolean;
    selectRunner(): WorkspaceCliRemovalRunner;
    selectRuntimeCli(): () => string;
    selectRemoveWorkspace(): (cwd: string, branch: string, options: { force: boolean }) => RemoveResult;
    selectLog(): (message: string) => undefined;
    selectError(): (message: string) => undefined;
    selectExit(): (status: number) => never;
    selectStrandedRegistrations(): (cwd: string, branch: string) => WorkspaceCliStrandedRegistration[];
    selectTerminalSafeLiteral(): (text: string) => string;
    selectPasteableArgument(): (text: string) => string;
}
