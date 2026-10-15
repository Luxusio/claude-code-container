import type { RemoveResult } from "../../domain/workspace/removal-result.js";
import type {
    WorkspaceCliRemovalPorts, WorkspaceCliContainerRuntime, WorkspaceCliFamilyLock,
    WorkspaceCliOwnershipAssertion, WorkspaceCliContainerIdentity, WorkspaceCliStrandedRegistration,
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
    if (identity.running) runtime.stop(identity.containerId);
    runtime.remove(identity.containerId);
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
        if (seenIds.has(identity.containerId)) {
            throw new Error("Workspace container inventory contains a duplicate identity.");
        }
        seenIds.add(identity.containerId);
        plan.push({ containerName, identity });
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

export function workspaceRemovalAdvice(
    force: boolean,
    removed: readonly string[] = [],
): string {
    // `removed` is consulted BEFORE `force`. Partial removal is reachable under -f — more
    // likely there than without it, since -f is what gets far enough to remove some and stop
    // — and returning early on force handed the operator who forced the weaker sentence in
    // the state that needs the stronger one.
    if (removed.length > 0) {
        return `Removed ${removed.length} item(s) before stopping — the workspace is partly`
            + " dismantled. See the errors above.";
    }
    if (force) return "Workspace removal did not complete.";
    // `removed` is why this takes a second argument. Taking only `force` made the line a
    // guess, and the guess was measured wrong on the most ordinary refusal there is: a
    // workspace with two submodules, one of them dirty. `ccc rm` deregisters the clean one,
    // refuses on the dirty one, and the summary said "Nothing was removed" two lines under
    // the CLI's own `removed: services/api`. The workspace is half dismantled at that point
    // and the operator has to be told so, because the next thing they decide is whether to
    // re-run or to go looking for what is missing.
    return "Nothing was removed. See the errors above.";
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

export function strandedBranchNotice(
    branch: string,
    stranded: WorkspaceCliStrandedRegistration[],
    selectTerminalSafeLiteral: () => (text: string) => string,
    selectPasteableArgument: () => (text: string) => string,
): string {
    // Nothing held means nothing to say. The call site guards on this too, but an exported
    // function that answers "Branch 'x' is still held ... Run these:" with no repository and no
    // command under it is a message that is not true, and the guard belonging only to the
    // caller is how the same sentence gets printed by the next caller.
    if (stranded.length === 0) return "";
    const lines = [
        `\nBranch '${branch}' is still held by a worktree registration recorded at a path`
        + " that cannot be reached from here, in:",
    ];
    for (const { repository, lockedPaths } of stranded) {
        lines.push(`  ${selectTerminalSafeLiteral()(repository)}`);
        for (const path of lockedPaths) {
            lines.push(`      locked, held by: ${selectTerminalSafeLiteral()(path)}`);
        }
    }
    lines.push("Run these, or the next `ccc @" + `${branch}\` will refuse:`);
    for (const { repository, lockedPaths } of stranded) {
        const repo = selectPasteableArgument()(repository);
        for (const path of lockedPaths) {
            // `--` because the recorded path is read verbatim out of a registry gitdir file and
            // may begin with a dash. Without it `git worktree unlock -foo` answers
            // `error: unknown switch 'f'` and a usage line, exit 129 — measured, and precisely
            // the failure this notice was rewritten to stop producing. With it, git stops
            // parsing options and reports `fatal: '-foo' is not a working tree`.
            lines.push(`  git -C ${repo} worktree unlock -- ${selectPasteableArgument()(path)}`);
        }
        lines.push(`  git -C ${repo} worktree prune`);
    }
    return lines.join("\n");
}

export function workspaceRemovalFailureNote(error: unknown, force: boolean): string | null {
    const message = (error as Error)?.message ?? "";
    // The narrower substring, because the class has more than one sentence in it. Matching
    // "is not owned by its source repository" caught `assertWorkspaceOwnership` and silently
    // missed `assertWorkspaceRootOwnership`'s "Workspace is not owned by source repository
    // '<path>'" — same class, same need, one word apart. A guard written against one message
    // rather than one class is the string-literal version of the layout mistake below.
    //
    // Measured, this also catches a third sentence not named above — "Nested Git repository
    // metadata is not owned by its parent or a registered worktree". That is deliberate to
    // keep: same class, the note's opening sentence is accurate for it, and the remedy
    // applies. But it is claimed by a substring rather than decided, and a fourth message
    // containing these three words, for a class where the remedy is wrong, would be claimed
    // silently. The version that stops this recurring is a typed error on the ownership
    // asserts, matched on instead of prose; widening the literal only moves the boundary.
    if (!message.includes("not owned by")) return null;
    // Two things this note MUST NOT do, both measured after the first version did them:
    //
    // It said "this is the multi-repo layout". The same assert raises in unified mode — a
    // foreign repository at a tracked submodule's path produces the identical sentence — so
    // that was the message asserting something it cannot check, again.
    //
    // It stopped at "delete the directory yourself". Doing that leaves a registration in the
    // source holding the branch, marked `prunable`, and `ccc rm` afterwards answers
    // "Workspace not found" — a different dead end, and the next `ccc @<branch>` walks into
    // the registration bug this whole task is about. A remedy is not a remedy until the state
    // it leaves behind is also named.
    return "\nccc will not remove a workspace whose nested repository it cannot prove it owns"
        + `${force ? ", and -f does not lift this" : ""}.`
        + "\nMove what you want to keep out of the workspace, then delete the workspace"
        + " directory yourself."
        // "in each nested repository" was the first version, and it was validated in the
        // multi-repo layout, where it terminates. In the unified layout the workspace root is
        // ITSELF a linked worktree of the source root, so hand-deleting it always leaves a
        // registration there and nothing among the nested repositories can clear it — the
        // operator followed the sentence exactly and landed on the outcome its own last clause
        // promised they were avoiding. Naming the source too is a no-op in multi-repo, where
        // the root is not a git repository at all, and is the one that matters in unified.
        //
        // Third time in this task that a fix was measured in one layout and shipped for both.
        // Whatever comes next gets run in both before it ships.
        + "\nThat leaves worktree registrations still holding the branch: run"
        + " `git worktree prune` in the source repository if it is one, and in each nested"
        + " repository, or the next `ccc @<branch>` will refuse.";
}

export function createWorkspaceCliRemoval(ports: WorkspaceCliRemovalPorts) {
    return function handleWorktreeRemove(cwd: string, branch: string, force: boolean): void {
        const wsPath = ports.selectWorkspacePath()(cwd, branch);
        const wsProjectId = ports.selectProjectId()(wsPath);
        let removalResult: RemoveResult | null = null;
        try {
            withWorkspaceRemovalLifecycleLock(wsProjectId, force, () => {
                assertRemovableWorkspace(wsPath, branch, cwd, ports.selectOwnershipAssertion());
                ports.selectRuntimeReadiness()();
                ports.selectLog()(`Removing workspace @${branch}...`);
                const containerRemovalPlan = prepareWorkspaceContainerRemovalPlan(
                    wsPath,
                    (path) => listWorkspaceContainerNames(
                        path, ports.selectContainerRuntime(), ports.selectContainerName(),
                    ),
                    (name, path) => ports.selectManagedIdentity()(name, path),
                    (name) => ports.selectExists()(name),
                );
                const completed = removeWorkspaceThenContainers(
                    () => ports.selectRemoveWorkspace()(cwd, branch, { force }),
                    () => removePreparedWorkspaceContainers(
                        containerRemovalPlan, ports.selectContainerRuntime(),
                        (name) => ports.selectExists()(name),
                    ),
                );
                removalResult = completed.result;
                for (const containerName of completed.removedContainers) {
                    ports.selectLog()(`Removed associated container ${containerName}.`);
                }
            }, ports.selectFamilyLock(), (projectId) => ports.selectClaims()(projectId));
            const result = removalResult!;
            for (const name of result.removed) {
                ports.selectLog()(`  removed: ${name}`);
            }
            for (const err of result.errors) {
                ports.selectError()(`  error: ${err}`);
            }
            if (!workspaceRemovalCompleted(result)) {
                ports.selectError()(`\n${workspaceRemovalAdvice(force, result.removed)}`);
                ports.selectExit()(1);
            } else {
                ports.selectLog()("Workspace removed.");
                const stranded = ports.selectStrandedRegistrations()(cwd, branch);
                if (stranded.length > 0) ports.selectError()(strandedBranchNotice(
                    branch, stranded,
                    () => ports.selectTerminalSafeLiteral(),
                    () => ports.selectPasteableArgument(),
                ));
            }
        } catch (e) {
            ports.selectError()(`Error: ${(e as Error).message}`);
            const removalNote = workspaceRemovalFailureNote(e, force);
            if (removalNote) ports.selectError()(removalNote);
            ports.selectExit()(1);
        }
    };
}
