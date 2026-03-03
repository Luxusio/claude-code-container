// src/worktree.ts - Git worktree workspace management for ccc

import { spawnSync } from "child_process";
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    copyFileSync,
    statSync,
    rmSync,
    lstatSync,
    renameSync,
    realpathSync,
} from "fs";
import { basename, dirname, join, resolve } from "path";

/** Recursive directory copy (Node 14 compatible replacement for cpSync) */
function copyDirRecursive(src: string, dest: string, depth: number = 0): void {
    if (depth > 20) return;
    const stat = lstatSync(src);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
        mkdirSync(dest, { recursive: true });
        for (const entry of readdirSync(src)) {
            copyDirRecursive(join(src, entry), join(dest, entry), depth + 1);
        }
    } else {
        copyFileSync(src, dest);
    }
}

export const WORKTREE_SEPARATOR = "--";

// === Types ===

export interface WorkspaceEntry {
    name: string;
    path: string;
    isGitRepo: boolean;
}

export interface WorkspaceInfo {
    branch: string;
    path: string;
}

export interface WorktreeResult {
    workspacePath: string;
    created: WorktreeRepoResult[];
    copied: string[];
}

export interface WorktreeRepoResult {
    name: string;
    branch: string;
    action: "worktree-existing" | "worktree-remote" | "worktree-new";
}

export interface RemoveResult {
    removed: string[];
    errors: string[];
}

// === Pure Functions ===

/**
 * Validate a git branch name. Rejects flag injection, path traversal,
 * control characters, and other unsafe patterns.
 * Based on git-check-ref-format rules.
 *
 * @throws {Error} If the branch name is invalid
 * @returns The validated branch name (unchanged)
 */
export function validateBranchName(branch: string): string {
    if (!branch || branch.trim() === "") {
        throw new Error("Invalid branch name: cannot be empty");
    }

    // Flag injection prevention
    if (branch.startsWith("-")) {
        throw new Error(
            `Invalid branch name '${branch}': cannot start with '-'`,
        );
    }

    // Path traversal prevention
    if (branch.includes("..")) {
        throw new Error(
            `Invalid branch name '${branch}': cannot contain '..'`,
        );
    }

    // git-check-ref-format forbidden characters:
    // control chars, space, ~, ^, :, ?, *, [, \, DEL
    // Also reject @{ (git refspec syntax)
    const invalidChars = /[\x00-\x1f\x7f ~^:?*[\]\\]/;
    if (invalidChars.test(branch)) {
        throw new Error(
            `Invalid branch name '${branch}': contains forbidden characters`,
        );
    }

    if (branch.includes("@{")) {
        throw new Error(
            `Invalid branch name '${branch}': cannot contain '@{'`,
        );
    }

    // Cannot start or end with slash, or contain consecutive slashes
    if (branch.startsWith("/") || branch.endsWith("/")) {
        throw new Error(
            `Invalid branch name '${branch}': cannot start or end with '/'`,
        );
    }

    if (branch.includes("//")) {
        throw new Error(
            `Invalid branch name '${branch}': cannot contain consecutive slashes`,
        );
    }

    // Cannot end with .lock
    if (branch.endsWith(".lock")) {
        throw new Error(
            `Invalid branch name '${branch}': cannot end with '.lock'`,
        );
    }

    // Cannot end with dot
    if (branch.endsWith(".")) {
        throw new Error(
            `Invalid branch name '${branch}': cannot end with '.'`,
        );
    }

    // Length limit
    if (Buffer.byteLength(branch, "utf-8") > 255) {
        throw new Error(
            `Invalid branch name: too long (max 255 bytes)`,
        );
    }

    return branch;
}

/**
 * Parse a worktree argument like "@feature" or "@"
 * Returns null if the arg doesn't start with "@"
 */
export function parseWorktreeArg(
    arg: string,
): { branch: string | null } | null {
    if (!arg.startsWith("@")) {
        return null;
    }

    const branch = arg.slice(1);
    if (branch === "") {
        return { branch: null }; // list mode
    }

    return { branch };
}

/**
 * Get the workspace path for a given source path and branch.
 * Created as a sibling directory: /projects → /projects--feature
 * Branch `/` chars are replaced with `-` in the directory name.
 */
export function getWorkspacePath(sourcePath: string, branch: string): string {
    const resolved = resolve(sourcePath);
    const parent = dirname(resolved);
    const dirName = basename(resolved);
    const safeBranch = branch.replace(/\//g, "-");
    return join(parent, `${dirName}${WORKTREE_SEPARATOR}${safeBranch}`);
}

// === Read-only Functions ===

/**
 * Scan a directory at 1-depth level.
 * Returns entries with isGitRepo flag based on .git existence.
 * Skips hidden files/directories (starting with .)
 * Uses lstatSync to avoid following symlinks (prevents symlink loops).
 */
export function scanDirectory(dirPath: string): WorkspaceEntry[] {
    if (!existsSync(dirPath)) {
        return [];
    }

    const entries: WorkspaceEntry[] = [];

    for (const name of readdirSync(dirPath)) {
        // Skip .git only — other dotfiles (.claude, .env, etc.) should be symlinked
        if (name === ".git") {
            continue;
        }

        const fullPath = join(dirPath, name);
        let lstat;
        try {
            lstat = lstatSync(fullPath);
        } catch {
            continue;
        }

        // Symlinks are included as non-repo entries (will be copied into workspace)
        if (lstat.isSymbolicLink()) {
            entries.push({ name, path: fullPath, isGitRepo: false });
            continue;
        }

        if (!lstat.isDirectory()) {
            entries.push({ name, path: fullPath, isGitRepo: false });
            continue;
        }

        // Check for .git (directory or file — file means gitlink/worktree/submodule)
        const isGitRepo = existsSync(join(fullPath, ".git"));
        entries.push({ name, path: fullPath, isGitRepo });
    }

    return entries;
}

/**
 * Check if a branch exists locally or on remote in a git repo.
 * Uses refs/heads/ and refs/remotes/origin/ to match only branches (not tags/commits).
 * Returns "local" | "remote" | "none"
 */
export function branchExistsInRepo(
    repoPath: string,
    branch: string,
): "local" | "remote" | "none" {
    // Check local branch (refs/heads/ restricts to branch refs only)
    const localResult = spawnSync(
        "git",
        ["rev-parse", "--verify", `refs/heads/${branch}`],
        { cwd: repoPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (localResult.status === 0) {
        return "local";
    }

    // Check remote branch
    const remoteResult = spawnSync(
        "git",
        ["rev-parse", "--verify", `refs/remotes/origin/${branch}`],
        { cwd: repoPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (remoteResult.status === 0) {
        return "remote";
    }

    return "none";
}

/**
 * Check if a workspace already exists for the given source path and branch.
 */
export function workspaceExists(sourcePath: string, branch: string): boolean {
    const wsPath = getWorkspacePath(sourcePath, branch);
    return existsSync(wsPath);
}

/**
 * List all workspaces for a given source path.
 * Finds sibling directories matching the pattern: {dirname}--*
 * Reads metadata files to recover original branch names.
 */
export function listWorkspaces(sourcePath: string): WorkspaceInfo[] {
    const resolved = resolve(sourcePath);
    const parent = dirname(resolved);
    const dirName = basename(resolved);
    const prefix = `${dirName}${WORKTREE_SEPARATOR}`;

    if (!existsSync(parent)) {
        return [];
    }

    const workspaces: WorkspaceInfo[] = [];

    for (const name of readdirSync(parent)) {
        if (!name.startsWith(prefix)) {
            continue;
        }

        const fullPath = join(parent, name);
        let stat;
        try {
            stat = lstatSync(fullPath);
        } catch {
            continue;
        }

        if (!stat.isDirectory()) {
            continue;
        }

        // Get branch name from git; fall back to dirname-derived name
        let branch = name.slice(prefix.length);
        const gitBranch = spawnSync(
            "git",
            ["rev-parse", "--abbrev-ref", "HEAD"],
            { cwd: fullPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        );
        if (gitBranch.status === 0 && (gitBranch.stdout ?? "").trim()) {
            branch = (gitBranch.stdout ?? "").trim();
        }

        workspaces.push({
            branch,
            path: fullPath,
        });
    }

    return workspaces;
}

/**
 * Check if a directory needs submodule setup:
 * - Directory is NOT itself a git repo
 * - Directory contains child git repos
 *
 * Returns the list of child git repo names, or null if setup is not needed.
 */
export function needsSubmoduleSetup(dirPath: string): string[] | null {
    const resolved = resolve(dirPath);

    // Already a git repo → no setup needed
    if (existsSync(join(resolved, ".git"))) {
        return null;
    }

    const entries = scanDirectory(resolved);
    const gitRepos = entries.filter((e) => e.isGitRepo);

    if (gitRepos.length === 0) {
        return null;
    }

    return gitRepos.map((e) => e.name);
}

/**
 * Detect the default branch for submodule tracking.
 * Priority: master → main → current branch.
 * Returns empty string if nothing is detected (e.g. detached HEAD, no branches).
 */
function detectDefaultBranch(repoPath: string): string {
    // Check if 'master' exists
    const masterCheck = spawnSync(
        "git",
        ["rev-parse", "--verify", "refs/heads/master"],
        { cwd: repoPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (masterCheck.status === 0) {
        return "master";
    }

    // Check if 'main' exists
    const mainCheck = spawnSync(
        "git",
        ["rev-parse", "--verify", "refs/heads/main"],
        { cwd: repoPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (mainCheck.status === 0) {
        return "main";
    }

    // Fall back to current branch
    const result = spawnSync(
        "git",
        ["rev-parse", "--abbrev-ref", "HEAD"],
        { cwd: repoPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const branch = (result.stdout ?? "").trim();
    if (!branch || branch === "HEAD") {
        return "";
    }
    return branch;
}

/**
 * Get the remote origin URL of a git repo.
 * Returns empty string if no remote is configured.
 */
function getRemoteUrl(repoPath: string): string {
    const result = spawnSync(
        "git",
        ["remote", "get-url", "origin"],
        { cwd: repoPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return (result.stdout ?? "").trim();
}

/**
 * Initialize a directory as a git repo with child repos as submodules.
 *
 * - git init the directory
 * - For each child git repo: add as submodule using its remote URL
 * - Submodules track their current branch (not pinned to specific commits)
 * - Sets ignore = all so parent doesn't report submodule changes as dirty
 * - Commits the initial state
 *
 * @throws {Error} If git init or submodule add fails
 */
export function initWithSubmodules(dirPath: string): void {
    const resolved = resolve(dirPath);

    // git init
    const initResult = spawnSync("git", ["init"], {
        cwd: resolved,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
    });
    if (initResult.status !== 0) {
        throw new Error(
            `Failed to git init: ${(initResult.stderr ?? "").trim()}`,
        );
    }

    // Configure user if not set (needed for commit)
    spawnSync("git", ["config", "user.email", "ccc@localhost"], {
        cwd: resolved,
        stdio: "pipe",
    });
    spawnSync("git", ["config", "user.name", "ccc"], {
        cwd: resolved,
        stdio: "pipe",
    });

    const entries = scanDirectory(resolved);
    const gitRepos = entries.filter((e) => e.isGitRepo);

    for (const repo of gitRepos) {
        const branch = detectDefaultBranch(repo.path);
        const remoteUrl = getRemoteUrl(repo.path);
        // Prefer remote URL; fall back to absolute path for local-only repos
        // (absolute path avoids resolution issues in worktrees)
        const url = remoteUrl || repo.path;

        const args = ["submodule", "add"];
        if (branch) {
            args.push("-b", branch);
        }
        args.push(url, repo.name);

        const addResult = spawnSync("git", args, {
            cwd: resolved,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        });
        if (addResult.status !== 0) {
            throw new Error(
                `Failed to add submodule ${repo.name}: ${(addResult.stderr ?? "").trim()}`,
            );
        }
    }

    // Configure submodules: ignore = all + update = rebase
    // ignore = all: parent won't report submodule content changes as dirty
    // update = rebase: submodules follow branch, not pinned to commits
    for (const repo of gitRepos) {
        spawnSync(
            "git",
            ["config", "-f", ".gitmodules", `submodule.${repo.name}.ignore`, "all"],
            { cwd: resolved, stdio: "pipe" },
        );
        spawnSync(
            "git",
            ["config", "-f", ".gitmodules", `submodule.${repo.name}.update`, "rebase"],
            { cwd: resolved, stdio: "pipe" },
        );
    }

    // Add all and commit
    spawnSync("git", ["add", "-A"], { cwd: resolved, stdio: "pipe" });
    spawnSync("git", ["commit", "-m", "chore: init workspace with submodules"], {
        cwd: resolved,
        stdio: "pipe",
    });
}

// === Write Functions ===

/**
 * Create a workspace with git worktrees.
 *
 * Two modes:
 *
 * 1. **Unified mode** (sourcePath is a git repo):
 *    - Creates a single worktree of the top-level repo
 *    - Initializes submodules with --remote (tracks branches, not pinned commits)
 *    - All files (.claude, .env, etc.) are part of the repo, fully isolated
 *
 * 2. **Multi-repo mode** (sourcePath is NOT a git repo):
 *    - Creates worktrees per child git repo
 *    - Copies non-repo items into workspace (isolated per worktree)
 *
 * @throws {Error} If branch name is invalid
 * @throws {Error} If no git repos found in sourcePath
 * @throws {Error} If workspace already exists or is being created by another process
 * @throws {Error} If git worktree creation fails (after rollback)
 */
export function createWorkspace(
    sourcePath: string,
    branch: string,
): WorktreeResult {
    validateBranchName(branch);

    const resolved = resolve(sourcePath);
    const wsPath = getWorkspacePath(resolved, branch);

    // Unified mode: top-level is a git repo
    if (existsSync(join(resolved, ".git"))) {
        return createUnifiedWorkspace(resolved, wsPath, branch);
    }

    // Multi-repo mode: scan children
    return createMultiRepoWorkspace(resolved, wsPath, branch);
}

function createUnifiedWorkspace(
    resolved: string,
    wsPath: string,
    branch: string,
): WorktreeResult {
    const existence = branchExistsInRepo(resolved, branch);

    let args: string[];
    let action: WorktreeRepoResult["action"];

    switch (existence) {
        case "local":
            args = ["worktree", "add", wsPath, branch];
            action = "worktree-existing";
            break;
        case "remote":
            args = ["worktree", "add", "-b", branch, wsPath, `origin/${branch}`];
            action = "worktree-remote";
            break;
        case "none":
            args = ["worktree", "add", "-b", branch, wsPath];
            action = "worktree-new";
            break;
    }

    const result = spawnSync("git", args, {
        cwd: resolved,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
    });

    if (result.status !== 0) {
        const stderr = (result.stderr ?? "").trim();
        throw new Error(`Failed to create worktree: ${stderr}`);
    }

    // Init submodules if any (without --remote to avoid fetch failures on local repos)
    const submoduleCheck = spawnSync(
        "git",
        ["submodule", "status"],
        { cwd: wsPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (submoduleCheck.status === 0 && (submoduleCheck.stdout ?? "").trim()) {
        spawnSync(
            "git",
            ["submodule", "update", "--init", "--recursive"],
            { cwd: wsPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        );
    }

    const dirName = basename(resolved);
    const nestedCreated = repairWorkspace(resolved, wsPath, branch);

    return {
        workspacePath: wsPath,
        created: [{ name: dirName, branch, action }, ...nestedCreated],
        copied: [],
    };
}

function createMultiRepoWorkspace(
    resolved: string,
    wsPath: string,
    branch: string,
): WorktreeResult {
    const entries = scanDirectory(resolved);
    const gitRepos = entries.filter((e) => e.isGitRepo);

    if (gitRepos.length === 0) {
        throw new Error(
            "No git repositories found in current directory. Nothing to create worktrees for.",
        );
    }

    // Atomic create: ensure parent exists, then non-recursive mkdir
    const parentDir = dirname(wsPath);
    mkdirSync(parentDir, { recursive: true });
    try {
        mkdirSync(wsPath);
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") {
            throw new Error(
                `Workspace already exists or is being created by another process: ${wsPath}`,
            );
        }
        throw e;
    }

    const created: WorktreeRepoResult[] = [];
    const copied: string[] = [];

    // Process git repos → worktree (with rollback on failure)
    try {
        for (const repo of gitRepos) {
            const destPath = join(wsPath, repo.name);
            const existence = branchExistsInRepo(repo.path, branch);

            let args: string[];
            let action: WorktreeRepoResult["action"];

            switch (existence) {
                case "local":
                    args = ["worktree", "add", destPath, branch];
                    action = "worktree-existing";
                    break;
                case "remote":
                    args = [
                        "worktree",
                        "add",
                        "-b",
                        branch,
                        destPath,
                        `origin/${branch}`,
                    ];
                    action = "worktree-remote";
                    break;
                case "none":
                    args = ["worktree", "add", "-b", branch, destPath];
                    action = "worktree-new";
                    break;
            }

            const result = spawnSync("git", args, {
                cwd: repo.path,
                encoding: "utf-8",
                stdio: ["pipe", "pipe", "pipe"],
            });

            if (result.status !== 0) {
                const stderr = (result.stderr ?? "").trim();
                throw new Error(
                    `Failed to create worktree for ${repo.name}: ${stderr}`,
                );
            }

            created.push({ name: repo.name, branch, action });
        }
    } catch (e) {
        // Rollback: remove already-created worktrees
        for (const c of created) {
            const destPath = join(wsPath, c.name);
            const sourceRepo = gitRepos.find((r) => r.name === c.name);
            if (sourceRepo) {
                spawnSync(
                    "git",
                    ["worktree", "remove", "--force", destPath],
                    { cwd: sourceRepo.path, stdio: "pipe" },
                );
            }
        }
        rmSync(wsPath, { recursive: true, force: true });
        throw e;
    }

    // Process non-repo items → copy (isolated per worktree)
    const nonRepos = entries.filter((e) => !e.isGitRepo);
    for (const entry of nonRepos) {
        const destPath = join(wsPath, entry.name);
        try {
            copyDirRecursive(entry.path, destPath);
            copied.push(entry.name);
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "EEXIST") {
                continue;
            }
        }
    }

    return { workspacePath: wsPath, created, copied };
}

/**
 * Repair an existing workspace by creating worktrees for nested git repos
 * that are missing or empty in the workspace directory.
 *
 * Also initializes submodules if they haven't been initialized yet.
 *
 * This is useful when:
 * - A workspace was created before this feature existed
 * - New nested git repos were added to the source after workspace creation
 *
 * Only operates in unified mode (source is a git repo).
 * Returns the list of repos that were repaired.
 */
export function repairWorkspace(
    sourcePath: string,
    wsPath: string,
    branch: string,
): WorktreeRepoResult[] {
    const resolved = resolve(sourcePath);

    // Only works in unified mode (source is a git repo)
    if (!existsSync(join(resolved, ".git"))) {
        return [];
    }

    // Try to init submodules that may not be initialized yet
    const submoduleCheck = spawnSync(
        "git",
        ["submodule", "status"],
        { cwd: wsPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (submoduleCheck.status === 0 && (submoduleCheck.stdout ?? "").trim()) {
        spawnSync(
            "git",
            ["submodule", "update", "--init", "--recursive"],
            { cwd: wsPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        );
    }

    // Create worktrees for nested git repos not managed as submodules.
    // In unified mode, git worktree only checks out the top-level repo.
    // Nested git repos (gitignored or gitlink entries without submodule config)
    // end up as empty or missing directories in the worktree.
    const created: WorktreeRepoResult[] = [];
    const sourceEntries = scanDirectory(resolved);

    for (const entry of sourceEntries) {
        if (!entry.isGitRepo) continue;

        const destPath = join(wsPath, entry.name);

        // Check existing directory
        if (existsSync(destPath)) {
            try {
                const contents = readdirSync(destPath);
                if (contents.length > 0) {
                    // Has content — skip if already a valid worktree
                    if (isValidWorktree(destPath, entry.path)) {
                        continue;
                    }
                    // Not a valid worktree (submodule checkout, copy, etc.) — auto-fix
                    const fixed = fixBrokenWorktree(resolved, wsPath, entry.name, branch);
                    if (fixed) {
                        created.push(fixed);
                    }
                    continue;
                }
                // Empty directory — remove so git worktree add can create it
                rmSync(destPath, { recursive: true });
            } catch {
                continue;
            }
        }

        const nestedExistence = branchExistsInRepo(entry.path, branch);
        let nestedArgs: string[];
        let nestedAction: WorktreeRepoResult["action"];

        switch (nestedExistence) {
            case "local":
                nestedArgs = ["worktree", "add", destPath, branch];
                nestedAction = "worktree-existing";
                break;
            case "remote":
                nestedArgs = ["worktree", "add", "-b", branch, destPath, `origin/${branch}`];
                nestedAction = "worktree-remote";
                break;
            case "none":
                nestedArgs = ["worktree", "add", "-b", branch, destPath];
                nestedAction = "worktree-new";
                break;
        }

        const nestedResult = spawnSync("git", nestedArgs, {
            cwd: entry.path,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        });

        if (nestedResult.status === 0) {
            created.push({ name: entry.name, branch, action: nestedAction });
        }
    }

    return created;
}

// === Docker Mount Helpers ===

export interface WorktreeGitMount {
    hostPath: string;
    containerPath: string;
}

/**
 * Get additional Docker volume mounts needed for a worktree workspace.
 *
 * Git worktrees contain .git files (not directories) that reference the
 * source repo's .git directory via absolute or relative paths. These paths
 * don't resolve inside a Docker container because only the worktree directory
 * is mounted, not the source repo.
 *
 * Returns mounts for:
 * - Source repo's .git at the host's absolute path (for absolute gitdir refs)
 * - Source repo's .git at /project/<basename>/.git (for relative refs from submodules)
 * - Each nested git repo's .git directories similarly
 */
export function getWorktreeGitMounts(worktreePath: string): WorktreeGitMount[] {
    const resolved = resolve(worktreePath);
    const gitFile = join(resolved, ".git");

    // Not a worktree if .git doesn't exist or is a directory (regular repo)
    if (!existsSync(gitFile)) return [];
    try {
        if (!lstatSync(gitFile).isFile()) return [];
    } catch {
        return [];
    }

    const content = readFileSync(gitFile, "utf-8").trim();
    const match = content.match(/^gitdir:\s*(.+)$/);
    if (!match) return [];

    const gitdirPath = match[1].trim();
    const resolvedGitdir = resolve(resolved, gitdirPath);

    // Navigate from .git/worktrees/<name> up to .git/
    const sourceGitDir = resolve(resolvedGitdir, "..", "..");
    if (!existsSync(sourceGitDir)) return [];

    const sourceRepoDir = dirname(sourceGitDir);
    const sourceBasename = basename(sourceRepoDir);

    const mounts: WorktreeGitMount[] = [];
    const seen = new Set<string>();

    function addMount(hostPath: string, containerPath: string): void {
        const key = `${hostPath}:${containerPath}`;
        if (!seen.has(key)) {
            seen.add(key);
            mounts.push({ hostPath, containerPath });
        }
    }

    // Mount source .git at absolute host path (for absolute gitdir references)
    addMount(sourceGitDir, sourceGitDir);

    // Mount source .git at /project/<basename>/.git (for relative refs from submodules)
    // Submodule .git files use paths like ../../<source_basename>/.git/worktrees/...
    const relMountPath = `/project/${sourceBasename}/.git`;
    if (relMountPath !== sourceGitDir) {
        addMount(sourceGitDir, relMountPath);
    }

    // Scan source for nested git repos and mount their .git directories too
    try {
        const entries = scanDirectory(sourceRepoDir);
        for (const entry of entries) {
            if (!entry.isGitRepo) continue;
            const nestedGitPath = join(entry.path, ".git");
            try {
                if (lstatSync(nestedGitPath).isDirectory()) {
                    addMount(nestedGitPath, nestedGitPath);
                    const nestedRelPath = `/project/${sourceBasename}/${entry.name}/.git`;
                    if (nestedRelPath !== nestedGitPath) {
                        addMount(nestedGitPath, nestedRelPath);
                    }
                }
            } catch { /* skip inaccessible entries */ }
        }
    } catch { /* skip if source scan fails */ }

    return mounts;
}

// === Broken Worktree Detection & Fix ===

export interface BrokenWorktreeEntry {
    name: string;
    sourcePath: string;
    destPath: string;
}

/**
 * Check if a directory is a valid git worktree of a given source repo.
 * Returns true only if:
 *   - The directory has a .git file (not directory)
 *   - The gitdir reference points back to the source repo's .git/worktrees/
 *
 * Uses direct .git file parsing + realpathSync instead of git rev-parse
 * to handle symlinks and macOS path resolution differences.
 */
export function isValidWorktree(
    dirPath: string,
    sourceRepoPath: string,
): boolean {
    if (!existsSync(dirPath)) return false;

    const gitPath = join(dirPath, ".git");
    if (!existsSync(gitPath)) return false;

    // Must be a file (gitlink), not a directory — directories are regular repos
    try {
        if (!lstatSync(gitPath).isFile()) return false;
    } catch {
        return false;
    }

    // Read and parse the .git file to get the gitdir reference
    try {
        const content = readFileSync(gitPath, "utf-8").trim();
        const match = content.match(/^gitdir:\s*(.+)$/);
        if (!match) return false;

        const gitdirPath = match[1].trim();
        const resolvedGitdir = resolve(dirPath, gitdirPath);

        // gitdir format: <source>/.git/worktrees/<name>
        // Navigate up to find the common .git dir
        const commonGitDir = resolve(resolvedGitdir, "..", "..");

        // Resolve the source repo's actual git directory.
        // If the source is a submodule, its .git is a gitlink file pointing
        // to the parent's .git/modules/<name> — we must follow that reference.
        const sourceGitPath = join(sourceRepoPath, ".git");
        let actualSourceGitDir: string;
        try {
            if (lstatSync(sourceGitPath).isFile()) {
                // Source is a submodule — parse gitlink to find actual git dir
                const srcContent = readFileSync(sourceGitPath, "utf-8").trim();
                const srcMatch = srcContent.match(/^gitdir:\s*(.+)$/);
                if (!srcMatch) return false;
                actualSourceGitDir = resolve(sourceRepoPath, srcMatch[1].trim());
            } else {
                actualSourceGitDir = sourceGitPath;
            }
        } catch {
            return false;
        }

        // Compare with realpathSync to handle symlinks (common on macOS)
        try {
            return realpathSync(commonGitDir) === realpathSync(actualSourceGitDir);
        } catch {
            // Fallback: compare without symlink resolution
            return resolve(commonGitDir) === resolve(actualSourceGitDir);
        }
    } catch {
        return false;
    }
}

/**
 * Detect nested git repo directories in a workspace that have content
 * but are NOT valid worktrees of the source repo.
 *
 * These are "broken" entries that need user intervention (backup + recreate).
 * Only operates in unified mode (source is a git repo).
 */
export function detectBrokenWorktrees(
    sourcePath: string,
    wsPath: string,
): BrokenWorktreeEntry[] {
    const resolved = resolve(sourcePath);

    if (!existsSync(join(resolved, ".git"))) {
        return [];
    }

    const broken: BrokenWorktreeEntry[] = [];
    const sourceEntries = scanDirectory(resolved);

    for (const entry of sourceEntries) {
        if (!entry.isGitRepo) continue;

        const destPath = join(wsPath, entry.name);
        if (!existsSync(destPath)) continue;

        try {
            const contents = readdirSync(destPath);
            if (contents.length === 0) continue; // Empty — handled by repairWorkspace
        } catch {
            continue;
        }

        // Has content — check if it's a valid worktree
        if (isValidWorktree(destPath, entry.path)) {
            continue; // Valid, nothing broken
        }

        broken.push({
            name: entry.name,
            sourcePath: entry.path,
            destPath,
        });
    }

    return broken;
}

/**
 * Fix a broken worktree entry by:
 * 1. Backing up existing content (rename to .ccc-backup)
 * 2. Creating a proper git worktree
 * 3. Restoring non-.git files from the backup
 * 4. Cleaning up the backup
 *
 * If worktree creation fails, the backup is restored and null is returned.
 */
export function fixBrokenWorktree(
    sourcePath: string,
    wsPath: string,
    repoName: string,
    branch: string,
): WorktreeRepoResult | null {
    const resolved = resolve(sourcePath);
    const destPath = join(wsPath, repoName);
    const backupPath = destPath + ".ccc-backup";

    // Find the source repo
    const sourceEntries = scanDirectory(resolved);
    const sourceRepo = sourceEntries.find((e) => e.name === repoName && e.isGitRepo);
    if (!sourceRepo) return null;

    // Backup existing content
    if (existsSync(destPath)) {
        if (existsSync(backupPath)) {
            rmSync(backupPath, { recursive: true, force: true });
        }
        renameSync(destPath, backupPath);
    }

    // Prune stale worktree references (previous fix attempts may leave orphaned entries)
    spawnSync("git", ["worktree", "prune"], {
        cwd: sourceRepo.path,
        stdio: "pipe",
    });

    // Create worktree
    const existence = branchExistsInRepo(sourceRepo.path, branch);
    let args: string[];
    let action: WorktreeRepoResult["action"];

    switch (existence) {
        case "local":
            args = ["worktree", "add", destPath, branch];
            action = "worktree-existing";
            break;
        case "remote":
            args = ["worktree", "add", "-b", branch, destPath, `origin/${branch}`];
            action = "worktree-remote";
            break;
        case "none":
            args = ["worktree", "add", "-b", branch, destPath];
            action = "worktree-new";
            break;
    }

    const result = spawnSync("git", args, {
        cwd: sourceRepo.path,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
    });

    if (result.status !== 0) {
        // Restore backup — don't lose user's content
        if (existsSync(backupPath)) {
            if (existsSync(destPath)) {
                rmSync(destPath, { recursive: true, force: true });
            }
            renameSync(backupPath, destPath);
        }
        return null;
    }

    // Restore non-.git content from backup into the new worktree
    if (existsSync(backupPath)) {
        for (const name of readdirSync(backupPath)) {
            if (name === ".git") continue;
            const srcItem = join(backupPath, name);
            const dstItem = join(destPath, name);
            // Only restore files that don't already exist in the worktree
            if (!existsSync(dstItem)) {
                copyDirRecursive(srcItem, dstItem);
            }
        }
        rmSync(backupPath, { recursive: true, force: true });
    }

    return { name: repoName, branch, action };
}

/**
 * Remove a workspace: remove git worktrees, delete copied items, remove directory.
 *
 * Without --force:
 *   - Dirty worktrees are reported as errors
 *   - Non-empty workspace directory is reported as error
 *
 * With --force:
 *   - Dirty worktrees are force-removed
 *   - Remaining files are deleted
 */
export function removeWorkspace(
    sourcePath: string,
    branch: string,
    opts?: { force?: boolean },
): RemoveResult {
    validateBranchName(branch);

    const resolved = resolve(sourcePath);
    const wsPath = getWorkspacePath(resolved, branch);

    if (!existsSync(wsPath)) {
        throw new Error(`Workspace not found: ${wsPath}`);
    }

    // Unified mode: top-level is a git repo → remove single worktree
    if (existsSync(join(resolved, ".git"))) {
        return removeUnifiedWorkspace(resolved, wsPath, opts);
    }

    // Multi-repo mode
    return removeMultiRepoWorkspace(resolved, wsPath, opts);
}

function removeUnifiedWorkspace(
    resolved: string,
    wsPath: string,
    opts?: { force?: boolean },
): RemoveResult {
    const removed: string[] = [];
    const errors: string[] = [];

    // Remove nested worktrees before removing the parent.
    // These are worktrees created for nested git repos (non-submodule).
    const sourceEntries = scanDirectory(resolved);
    for (const entry of sourceEntries) {
        if (!entry.isGitRepo) continue;

        const nestedPath = join(wsPath, entry.name);
        if (!existsSync(nestedPath)) continue;

        // Check if it's a worktree (has .git file, not directory)
        const gitPath = join(nestedPath, ".git");
        if (!existsSync(gitPath)) continue;
        try {
            const stat = lstatSync(gitPath);
            if (!stat.isFile()) continue;
        } catch {
            continue;
        }

        const nestedArgs = ["worktree", "remove", nestedPath];
        if (opts?.force) nestedArgs.push("--force");

        const nestedResult = spawnSync("git", nestedArgs, {
            cwd: entry.path,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        });
        if (nestedResult.status === 0) {
            removed.push(entry.name);
        }
    }

    const args = ["worktree", "remove", wsPath];
    if (opts?.force) {
        args.push("--force");
    }

    const result = spawnSync("git", args, {
        cwd: resolved,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
    });

    if (result.status !== 0) {
        const stderr = (result.stderr ?? "").trim();
        errors.push(stderr);
    } else {
        removed.push(basename(resolved));
    }

    return { removed, errors };
}

function removeMultiRepoWorkspace(
    resolved: string,
    wsPath: string,
    opts?: { force?: boolean },
): RemoveResult {
    const removed: string[] = [];
    const errors: string[] = [];

    const sourceEntries = scanDirectory(resolved);

    for (const entry of sourceEntries) {
        const wsEntryPath = join(wsPath, entry.name);
        if (!existsSync(wsEntryPath)) {
            continue;
        }

        if (entry.isGitRepo) {
            const args = ["worktree", "remove", wsEntryPath];
            if (opts?.force) {
                args.push("--force");
            }

            const result = spawnSync("git", args, {
                cwd: entry.path,
                encoding: "utf-8",
                stdio: ["pipe", "pipe", "pipe"],
            });

            if (result.status !== 0) {
                const stderr = (result.stderr ?? "").trim();
                errors.push(`${entry.name}: ${stderr}`);
            } else {
                removed.push(entry.name);
            }
        } else {
            try {
                rmSync(wsEntryPath, { recursive: true, force: true });
                removed.push(entry.name);
            } catch {
                // ignore
            }
        }
    }

    // Try to remove the workspace directory itself
    try {
        if (existsSync(wsPath)) {
            const remaining = readdirSync(wsPath);
            if (remaining.length === 0) {
                rmSync(wsPath, { recursive: true });
            } else if (opts?.force) {
                rmSync(wsPath, { recursive: true, force: true });
            } else {
                errors.push(
                    `Workspace directory not empty (${remaining.length} items remaining). Use -f to force.`,
                );
            }
        }
    } catch (e) {
        errors.push(
            `Failed to remove workspace directory: ${(e as Error).message}`,
        );
    }

    return { removed, errors };
}
