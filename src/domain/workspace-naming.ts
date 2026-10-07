export const WORKTREE_SEPARATOR = "--";

export function formatWorkspaceSiblingBasename(sourceBasename: string, branch: string): string {
    const safeBranch = branch.replace(/\//g, "-");
    return `${sourceBasename}${WORKTREE_SEPARATOR}${safeBranch}`;
}

export function* iterateWorkspaceSourceBasenames(
    workspaceBasename: string,
): Generator<string, void, unknown> {
    let separatorIndex = workspaceBasename.indexOf(WORKTREE_SEPARATOR);
    while (separatorIndex > 0) {
        yield workspaceBasename.slice(0, separatorIndex);
        separatorIndex = workspaceBasename.indexOf(
            WORKTREE_SEPARATOR,
            separatorIndex + WORKTREE_SEPARATOR.length,
        );
    }
}
