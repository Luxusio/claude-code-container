import type { RemoveResult, WorkspaceRemovalOutcome, WorkspaceRemovalRequest } from "../../domain/workspace/removal-result.js";
import type {
    WorkspaceCliRemovalPorts, WorkspaceCliContainerRuntime, WorkspaceCliFamilyLock,
    WorkspaceCliOwnershipAssertion, WorkspaceCliContainerIdentity,
} from "../../ports/workspace/cli-removal.js";

export type WorkspaceContainerRemoval = {
    containerName: string;
    identity: WorkspaceCliContainerIdentity;
};

export function withWorkspaceRemovalLifecycleLock<T>(
    projectId: string,
    force: boolean,
    operation: () => T,
    lifecycleLock: WorkspaceCliFamilyLock,
    activeSessions: (projectId: string) => string[],
): T {
    return lifecycleLock(projectId, () => {
        const sessions = activeSessions(projectId);
        if (sessions.length > 0 && !force) {
            throw new Error(`Workspace has ${sessions.length} session ownership claim(s); stop sessions first or use -f to force removal.`);
        }
        return operation();
    });
}

export function listWorkspaceContainerNames(
    workspacePath: string,
    runtime: Pick<WorkspaceCliContainerRuntime, "listNames">,
    getContainerName: (workspacePath: string) => string,
): string[] {
    const baseName = getContainerName(workspacePath);
    const result = runtime.listNames();
    if (result.kind === "unavailable") {
        throw new Error("Unable to list workspace containers.");
    }
    return result.names
        .filter((name) => name === baseName || name.startsWith(`${baseName}--p--`));
}

export function removeWorkspaceContainerByIdentity(
    containerName: string,
    identityProbe: (name: string) => WorkspaceCliContainerIdentity | null,
    runtime: Pick<WorkspaceCliContainerRuntime, "stop" | "remove">,
    existsProbe: (name: string) => boolean,
): boolean {
    const identity = identityProbe(containerName);
    if (!identity) {
        if (existsProbe(containerName)) {
            throw new Error("Workspace container identity inspection failed; workspace removal was aborted.");
        }
        return false;
    }
    const { containerId, running } = identity;
    if (running) runtime.stop(containerId);
    runtime.remove(containerId);
    return true;
}

export function removeManagedWorkspaceContainerByIdentity(
    containerName: string,
    workspacePath: string,
    identityProbe: (name: string, workspacePath: string) => WorkspaceCliContainerIdentity | null,
    runtime: Pick<WorkspaceCliContainerRuntime, "stop" | "remove">,
    existsProbe: (name: string) => boolean,
): boolean {
    return removeWorkspaceContainerByIdentity(
        containerName,
        (name) => identityProbe(name, workspacePath),
        runtime,
        existsProbe,
    );
}

export function removeWorkspaceContainers(
    workspacePath: string,
    listContainers: (workspacePath: string) => string[],
    removeContainer: (containerName: string, workspacePath: string) => boolean,
): string[] {
    const removed: string[] = [];
    for (const containerName of listContainers(workspacePath)) {
        if (!removeContainer(containerName, workspacePath)) continue;
        removed.push(containerName);
    }
    return removed;
}

export function prepareWorkspaceContainerRemovalPlan(
    workspacePath: string,
    listContainers: (workspacePath: string) => string[],
    identityProbe: (
        containerName: string,
        workspacePath: string,
    ) => WorkspaceCliContainerIdentity | null,
    existsProbe: (name: string) => boolean,
): WorkspaceContainerRemoval[] {
    const plan: WorkspaceContainerRemoval[] = [];
    const seenIds = new Set<string>();
    for (const containerName of listContainers(workspacePath)) {
        const identity = identityProbe(containerName, workspacePath);
        if (!identity) {
            if (existsProbe(containerName)) {
                throw new Error(
                    "Workspace container identity inspection failed; workspace removal was aborted.",
                );
            }
            continue;
        }
        const { containerId, running } = identity;
        if (seenIds.has(containerId)) {
            throw new Error("Workspace container inventory contains a duplicate identity.");
        }
        seenIds.add(containerId);
        plan.push({ containerName, identity: { containerId, running } });
    }
    return plan;
}

export function removePreparedWorkspaceContainers(
    plan: readonly WorkspaceContainerRemoval[],
    runtime: Pick<WorkspaceCliContainerRuntime, "stop" | "remove">,
    existsProbe: (name: string) => boolean,
): string[] {
    const removed: string[] = [];
    for (const entry of plan) {
        if (!removeWorkspaceContainerByIdentity(
            entry.containerName,
            () => entry.identity,
            runtime,
            existsProbe,
        )) {
            continue;
        }
        removed.push(entry.containerName);
    }
    return removed;
}

export function workspaceRemovalCompleted(
    result: { errors: string[] },
): boolean {
    return result.errors.length === 0;
}

export function removeWorkspaceThenContainers<T extends { errors: string[] }>(
    removeWorkspaceOperation: () => T,
    removeContainersOperation: () => string[],
): { result: T; removedContainers: string[] } {
    const result = removeWorkspaceOperation();
    return {
        result,
        removedContainers: workspaceRemovalCompleted(result)
            ? removeContainersOperation()
            : [],
    };
}

export function assertRemovableWorkspace(
    workspacePath: string,
    branch: string,
    sourcePath: string,
    assertWorkspaceBranch: WorkspaceCliOwnershipAssertion,
): void {
    // The same options `removeWorkspace` uses on its own copy of this assert, and the same
    // ones the arm that OPENS a workspace passes. Without them `ccc rm` and `ccc rm -f` both
    // died on a workspace whose tracked submodule is not a linked worktree — `Workspace
    // repository 'services/api' is not owned by its source repository` — while
    // `removeWorkspace()` on that same workspace returned {"removed":["src"],"errors":[]}.
    // The CLI refused what the library it wraps does fine, contradicted the NOTE printed on
    // that very workspace ("`ccc rm` will not delete it unless you pass -f", with -f being
    // what had just refused), and left the partial-removal state unrecoverable, since the way
    // out of that state is `--force`.
    //
    // This does not widen what is deletable: `allowTrackedGitlinks` admits only gitlinks the
    // workspace's own index tracks, so a genuinely foreign repository at that path still
    // refuses under both flags.
    assertWorkspaceBranch(workspacePath, branch, sourcePath, {
        allowTrackedGitlinks: true,
    });
}

export function createWorkspaceRemoval(ports: WorkspaceCliRemovalPorts) {
    return function removeWorkspace(request: WorkspaceRemovalRequest): WorkspaceRemovalOutcome {
        const { sourcePath, branch, force } = request;
        // Observer callbacks must not redirect a relative source by changing the cwd.
        const resolvedSource = ports.resolveSource(sourcePath);
        const wsPath = ports.selectWorkspacePath()(resolvedSource, branch);
        const wsProjectId = ports.selectProjectId()(wsPath);
        let removalResult: RemoveResult | null = null;
        try {
            const completed = withWorkspaceRemovalLifecycleLock(wsProjectId, force, () => {
                assertRemovableWorkspace(wsPath, branch, resolvedSource, ports.selectOwnershipAssertion());
                ports.selectRuntimeReadiness()();
                ports.publish({ kind: "started", branch });
                const containerRemovalPlan = prepareWorkspaceContainerRemovalPlan(
                    wsPath,
                    (path) => listWorkspaceContainerNames(
                        path, ports.selectContainerRuntime(), ports.selectContainerName(),
                    ),
                    (name, path) => ports.selectManagedIdentity()(name, path),
                    (name) => ports.selectExists()(name),
                );
                const result = ports.selectRemoveWorkspace()(resolvedSource, branch, { force });
                removalResult = result;
                const removed = [...result.removed];
                const errors = [...result.errors];
                const complete = errors.length === 0;
                const removedContainers = complete ? removePreparedWorkspaceContainers(
                    containerRemovalPlan, ports.selectContainerRuntime(),
                    (name) => ports.selectExists()(name),
                ) : [];
                if (removedContainers.length > 0) {
                    ports.publish({ kind: "containers-removed", names: [...removedContainers] });
                }
                return { result, removed, errors, complete, removedContainers };
            }, ports.selectFamilyLock(), (projectId) => ports.selectClaims()(projectId));
            ports.publish({ kind: "result", removed: [...completed.removed], errors: [...completed.errors] });
            if (!completed.complete) {
                ports.publish({ kind: "incomplete", removed: [...completed.removed] });
                return { kind: "incomplete", result: completed.result };
            }
            ports.publish({ kind: "removed" });
            const stranded = ports.selectStrandedRegistrations()(resolvedSource, branch);
            return {
                kind: "removed", result: completed.result,
                removedContainers: completed.removedContainers, stranded,
            };
        } catch (error) {
            return { kind: "failed", error, result: removalResult };
        }
    };
}
