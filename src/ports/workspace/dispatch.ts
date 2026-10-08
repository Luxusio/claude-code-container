import type { WorktreeResult } from "../../domain/workspace/creation-result.js";
import type { RemoveResult } from "../../domain/workspace/removal-result.js";

interface WorkspaceDispatchPorts {
    validateBranch(branch: string): void;
    resolveSource(sourcePath: string): string;
    workspacePath(sourcePath: string, branch: string): string;
    sourceHasGitMetadata(sourcePath: string): boolean;
}

export interface WorkspaceCreationDispatchPorts extends WorkspaceDispatchPorts {
    enclosingRepository(destinationPath: string): string | null;
    warnEnclosing(destinationPath: string, enclosing: string): void;
    createUnified(request: { repositoryPath: string; destinationPath: string; branch: string }): WorktreeResult;
    createMulti(request: { repositoryPath: string; destinationPath: string; branch: string }): WorktreeResult;
}

export interface WorkspaceRemovalDispatchPorts<Identity, Content> extends WorkspaceDispatchPorts {
    destinationExists(path: string): boolean;
    assertRequestedBranch(destinationPath: string, branch: string, sourcePath: string): void;
    observeUnreachableRepositories(destinationPath: string, unreachable: string[]): void;
    observePathContent(path: string): Content;
    formatUnmanagedRefusal(path: string, content: Content): string;
    captureWorkspaceIdentity(path: string): Identity;
    removeUnified(request: { repositoryPath: string; destinationPath: string; branch: string; options: { force?: boolean } | undefined }, identity: Identity): RemoveResult;
    removeMulti(request: { repositoryPath: string; destinationPath: string; branch: string; options: { force?: boolean } | undefined }, identity: Identity): RemoveResult;
}
