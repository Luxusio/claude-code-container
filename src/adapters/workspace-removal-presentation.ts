import type { WorkspaceRemovalProgress, WorkspaceStrandedRegistration } from "../domain/workspace/removal-result.js";

export function workspaceRemovalAdvice(
    force: boolean,
    removed: readonly string[] = [],
): string {
    // Partial removal takes precedence over force: -f can still leave a dismantled workspace.
    if (removed.length > 0) {
        return `Removed ${removed.length} item(s) before stopping — the workspace is partly`
            + " dismantled. See the errors above.";
    }
    if (force) return "Workspace removal did not complete.";
    return "Nothing was removed. See the errors above.";
}

export function strandedBranchNotice(
    branch: string,
    stranded: WorkspaceStrandedRegistration[],
    selectTerminalSafeLiteral: () => (text: string) => string,
    selectPasteableArgument: () => (text: string) => string,
): string {
    // Public callers must not receive a held-branch claim when no registration is stranded.
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
            // Registry paths can begin with a dash; terminate option parsing before each one.
            lines.push(`  git -C ${repo} worktree unlock -- ${selectPasteableArgument()(path)}`);
        }
        lines.push(`  git -C ${repo} worktree prune`);
    }
    return lines.join("\n");
}

export function workspaceRemovalFailureNote(error: unknown, force: boolean): string | null {
    const message = (error as Error)?.message ?? "";
    // Existing root and nested ownership errors share this wording. Keep their remedy
    // conservative: no layout claim, no suggestion that force bypasses ownership.
    if (!message.includes("not owned by")) return null;
    return "\nccc will not remove a workspace whose nested repository it cannot prove it owns"
        + `${force ? ", and -f does not lift this" : ""}.`
        + "\nMove what you want to keep out of the workspace, then delete the workspace"
        + " directory yourself."
        // Manual deletion leaves registrations; unified roots need source pruning too.
        + "\nThat leaves worktree registrations still holding the branch: run"
        + " `git worktree prune` in the source repository if it is one, and in each nested"
        + " repository, or the next `ccc @<branch>` will refuse.";
}

export function renderWorkspaceRemovalProgress(
    event: WorkspaceRemovalProgress,
    force: boolean,
    log: (message: string) => undefined,
    error: (message: string) => undefined,
): undefined {
    switch (event.kind) {
        case "started":
            log(`Removing workspace @${event.branch}...`);
            break;
        case "containers-removed":
            for (const name of event.names) log(`Removed associated container ${name}.`);
            break;
        case "result":
            for (const name of event.removed) log(`  removed: ${name}`);
            for (const message of event.errors) error(`  error: ${message}`);
            break;
        case "incomplete":
            error(`\n${workspaceRemovalAdvice(force, event.removed)}`);
            break;
        case "removed":
            log("Workspace removed.");
            break;
    }
    return undefined;
}
