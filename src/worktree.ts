// src/worktree.ts - Git worktree workspace management for ccc

import { spawnSync } from "child_process";
import {
    existsSync,
    mkdirSync,
    readdirSync,
    writeFileSync,
    readFileSync,
    symlinkSync,
    rmSync,
    lstatSync,
} from "fs";
import { basename, dirname, join, relative, resolve } from "path";

export const WORKTREE_SEPARATOR = "--";
export const METADATA_FILE = ".ccc-meta.json";

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
    symlinked: string[];
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

export interface WorkspaceMetadata {
    branch: string;
    sourcePath: string;
    createdAt: string;
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
        // Skip hidden files/directories
        if (name.startsWith(".")) {
            continue;
        }

        const fullPath = join(dirPath, name);
        let lstat;
        try {
            lstat = lstatSync(fullPath);
        } catch {
            continue;
        }

        // Symlinks are included as non-repo entries (will be symlinked into workspace)
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
 * Read workspace metadata from the .ccc-meta.json file.
 * Returns null if metadata file doesn't exist or is invalid.
 */
export function readWorkspaceMetadata(
    wsPath: string,
): WorkspaceMetadata | null {
    const metaPath = join(wsPath, METADATA_FILE);
    if (!existsSync(metaPath)) {
        return null;
    }
    try {
        return JSON.parse(readFileSync(metaPath, "utf-8")) as WorkspaceMetadata;
    } catch {
        return null;
    }
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

        // Read metadata for original branch name; fall back to dirname-derived name
        const meta = readWorkspaceMetadata(fullPath);
        const branch = meta?.branch ?? name.slice(prefix.length);

        workspaces.push({
            branch,
            path: fullPath,
        });
    }

    return workspaces;
}

// === Write Functions ===

/**
 * Create a workspace with git worktrees and symlinks.
 *
 * - Validates the branch name before any operations
 * - Uses non-recursive mkdir for atomic creation (prevents concurrent races)
 * - Writes metadata file with original branch name
 * - Rolls back on failure (removes partial worktrees and workspace directory)
 * - Uses EEXIST handling instead of check-then-act for symlinks
 *
 * For each git repo in sourcePath:
 *   - local branch exists: git worktree add <dest> <branch>
 *   - remote branch exists: git worktree add -b <branch> <dest> origin/<branch>
 *   - no branch: git worktree add -b <branch> <dest> (new from HEAD)
 *
 * For non-repo items: create relative symlinks.
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

    const entries = scanDirectory(resolved);
    const gitRepos = entries.filter((e) => e.isGitRepo);

    if (gitRepos.length === 0) {
        throw new Error(
            "No git repositories found in current directory. Nothing to create worktrees for.",
        );
    }

    // Atomic create: ensure parent exists, then non-recursive mkdir
    // mkdirSync without recursive throws EEXIST if directory already exists,
    // preventing concurrent create races (M1 fix)
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

    // Write metadata (original branch name for round-trip fidelity)
    const metadata: WorkspaceMetadata = {
        branch,
        sourcePath: resolved,
        createdAt: new Date().toISOString(),
    };
    writeFileSync(
        join(wsPath, METADATA_FILE),
        JSON.stringify(metadata, null, 2),
    );

    const created: WorktreeRepoResult[] = [];
    const symlinked: string[] = [];

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
        // Remove the workspace directory
        rmSync(wsPath, { recursive: true, force: true });
        throw e;
    }

    // Process non-repo items → relative symlink
    // Uses try/catch with EEXIST instead of check-then-act (eliminates TOCTOU)
    const nonRepos = entries.filter((e) => !e.isGitRepo);
    for (const entry of nonRepos) {
        const destPath = join(wsPath, entry.name);
        const relTarget = relative(wsPath, entry.path);
        try {
            symlinkSync(relTarget, destPath);
            symlinked.push(entry.name);
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "EEXIST") {
                continue; // already exists, skip
            }
            // Non-EEXIST errors are unexpected but non-fatal for symlinks
        }
    }

    return { workspacePath: wsPath, created, symlinked };
}

/**
 * Remove a workspace: remove git worktrees, delete symlinks, remove directory.
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

    const removed: string[] = [];
    const errors: string[] = [];

    // Find git worktrees in the workspace and remove them via the source repo
    const sourceEntries = scanDirectory(resolved);

    for (const entry of sourceEntries) {
        const wsEntryPath = join(wsPath, entry.name);
        if (!existsSync(wsEntryPath)) {
            continue;
        }

        if (entry.isGitRepo) {
            // Remove worktree via git
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
            // Remove symlink
            try {
                const lstats = lstatSync(wsEntryPath);
                if (lstats.isSymbolicLink()) {
                    rmSync(wsEntryPath);
                    removed.push(entry.name);
                }
            } catch {
                // ignore
            }
        }
    }

    // Try to remove the workspace directory itself
    try {
        if (existsSync(wsPath)) {
            // Remove metadata file
            const metaPath = join(wsPath, METADATA_FILE);
            if (existsSync(metaPath)) {
                rmSync(metaPath);
            }

            const remaining = readdirSync(wsPath);
            if (remaining.length === 0) {
                rmSync(wsPath, { recursive: true });
            } else if (opts?.force) {
                rmSync(wsPath, { recursive: true, force: true });
            } else {
                // Not empty and not forced — report as error (M4 fix: no silent data loss)
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
