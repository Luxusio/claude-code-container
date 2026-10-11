import type { WorktreeResult } from "../../domain/workspace/creation-result.js";
import type { WorkspaceCreationDispatchPorts, WorkspaceRemovalDispatchOutcome, WorkspaceRemovalDispatchPorts } from "../../ports/workspace/dispatch.js";

export function createWorkspaceCreationDispatch(ports: WorkspaceCreationDispatchPorts) {
    function createWorkspace(sourcePath: string, branch: string): WorktreeResult {
        ports.validateBranch(branch);
        const resolved = ports.resolveSource(sourcePath);
        const wsPath = ports.workspacePath(resolved, branch);
        const enclosing = ports.enclosingRepository(wsPath);
        if (enclosing) ports.warnEnclosing(wsPath, enclosing);
        if (ports.sourceHasGitMetadata(resolved)) {
            return ports.createUnified({ repositoryPath: resolved, destinationPath: wsPath, branch });
        }
        return ports.createMulti({ repositoryPath: resolved, destinationPath: wsPath, branch });
    }
    return { createWorkspace };
}

export function createWorkspaceRemovalDispatch<Identity, Content, Result>(ports: WorkspaceRemovalDispatchPorts<Identity, Content, Result>) {
    function removeWorkspace(sourcePath: string, branch: string, opts?: { force?: boolean }): WorkspaceRemovalDispatchOutcome<Content, Result> {
        ports.validateBranch(branch);
        const resolved = ports.resolveSource(sourcePath);
        const wsPath = ports.workspacePath(resolved, branch);
        if (!ports.destinationExists(wsPath)) return { kind: "missing", destinationPath: wsPath };
        ports.assertRequestedBranch(wsPath, branch, resolved);
        if (opts?.force !== true) {
            const unreachable: string[] = [];
            ports.observeUnreachableRepositories(wsPath, unreachable);
            if (unreachable.length > 0) {
                return { kind: "unmanaged", paths: unreachable.map(path => ({ path, content: ports.observePathContent(path) })) };
            }
        }
        const workspaceIdentity = ports.captureWorkspaceIdentity(wsPath);
        if (ports.sourceHasGitMetadata(resolved)) {
            return { kind: "dispatched", result: ports.removeUnified({ repositoryPath: resolved, destinationPath: wsPath, branch, options: opts }, workspaceIdentity) };
        }
        return { kind: "dispatched", result: ports.removeMulti({ repositoryPath: resolved, destinationPath: wsPath, branch, options: opts }, workspaceIdentity) };
    }
    return { removeWorkspace };
}
