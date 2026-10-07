export type WorktreeCreationAction = "worktree-existing" | "worktree-remote" | "worktree-new";

export interface WorktreeRepoResult {
    name: string;
    branch: string;
    action: WorktreeCreationAction;
}

export interface WorktreeResult {
    workspacePath: string;
    created: WorktreeRepoResult[];
    copied: string[];
}
