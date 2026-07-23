// src/worktree.ts - Git worktree workspace management for ccc

import { spawnSync } from "child_process";
import {
    chmodSync,
    existsSync,
    mkdtempSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    copyFileSync,
    rmSync,
    rmdirSync,
    lstatSync,
    renameSync,
    realpathSync,
} from "fs";
import { basename, dirname, join, resolve } from "path";

/** Recursive directory copy (Node 14 compatible replacement for cpSync) */
function copyDirRecursive(src: string, dest: string, depth: number = 0): void {
    if (depth > 20) throw new Error(`Source entry nesting is too deep to copy safely: ${src}`);
    const stat = lstatSync(src);
    if (stat.isSymbolicLink()) {
        throw new Error(`Source entry contains a symbolic link that cannot be copied safely: ${src}`);
    }
    if (stat.isDirectory()) {
        mkdirSync(dest, { recursive: true });
        for (const entry of readdirSync(src)) {
            copyDirRecursive(join(src, entry), join(dest, entry), depth + 1);
        }
    } else {
        copyFileSync(src, dest);
    }
}

function mergePreservingContent(src: string, dest: string, depth: number = 0): void {
    if (depth > 20) throw new Error(`Workspace content nesting is too deep: ${src}`);
    const source = lstatSync(src);
    if (source.isSymbolicLink()) {
        throw new Error(`Workspace content contains a symbolic link that cannot be merged safely: ${src}`);
    }
    if (!pathExistsStrict(dest)) {
        copyDirRecursive(src, dest, depth);
        return;
    }
    const destination = lstatSync(dest);
    if (destination.isSymbolicLink()) {
        throw new Error(`Worktree destination contains a symbolic link: ${dest}`);
    }
    if (source.isDirectory() && destination.isDirectory()) {
        for (const entry of readdirSync(src)) {
            mergePreservingContent(join(src, entry), join(dest, entry), depth + 1);
        }
        return;
    }
    if (source.isFile() && destination.isFile()
        && readFileSync(src).equals(readFileSync(dest))) {
        return;
    }
    throw new Error(`Workspace content conflicts with checked-out worktree content: ${dest}`);
}

export const WORKTREE_SEPARATOR = "--";

// === Types ===

export interface WorkspaceEntry {
    name: string;
    path: string;
    isGitRepo: boolean;
}

type DirectoryIdentity = {
    realpath: string;
    dev: string;
    ino: string;
};

function captureDirectoryIdentity(path: string): DirectoryIdentity {
    const observed = lstatSync(path, { bigint: true });
    if (!observed.isDirectory() || observed.isSymbolicLink()) {
        throw new Error(`Workspace path '${path}' must be a real directory.`);
    }
    return {
        realpath: realpathSync(path),
        dev: observed.dev.toString(),
        ino: observed.ino.toString(),
    };
}

function assertDirectoryIdentity(path: string, expected: DirectoryIdentity): void {
    const actual = captureDirectoryIdentity(path);
    if (actual.realpath !== expected.realpath
        || actual.dev !== expected.dev
        || actual.ino !== expected.ino) {
        throw new Error(`Workspace path identity changed before deletion: ${path}`);
    }
}

function capturePathIdentity(path: string): DirectoryIdentity {
    const observed = lstatSync(path, { bigint: true });
    if (observed.isSymbolicLink()) {
        throw new Error(`Workspace entry '${path}' must not be a symbolic link.`);
    }
    return {
        realpath: realpathSync(path),
        dev: observed.dev.toString(),
        ino: observed.ino.toString(),
    };
}

function assertPathIdentity(path: string, expected: DirectoryIdentity): void {
    const actual = capturePathIdentity(path);
    if (actual.realpath !== expected.realpath
        || actual.dev !== expected.dev
        || actual.ino !== expected.ino) {
        throw new Error(`Workspace entry identity changed before deletion: ${path}`);
    }
}

function assertQuarantinedIdentity(
    path: string,
    expected: DirectoryIdentity,
    kind: "directory" | "entry",
): void {
    const observed = lstatSync(path, { bigint: true });
    if (observed.isSymbolicLink()
        || (kind === "directory" && !observed.isDirectory())
        || observed.dev.toString() !== expected.dev
        || observed.ino.toString() !== expected.ino) {
        throw new Error(`Workspace ${kind} identity changed after quarantine: ${path}`);
    }
}

function pathExistsStrict(path: string): boolean {
    try {
        lstatSync(path);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw new Error(`Unable to inspect workspace path '${path}'.`, { cause: error });
    }
}

type QuarantineLocation = {
    directory: string;
    directoryIdentity: DirectoryIdentity;
    path: string;
};

function createPrivateQuarantine(
    originalPath: string,
    quarantineBase: string,
): QuarantineLocation {
    // The base is the workspace sibling directory, outside the project mount.
    const baseIdentity = captureDirectoryIdentity(quarantineBase);
    const directory = mkdtempSync(join(quarantineBase, ".ccc-worktree-quarantine-"));
    try {
        chmodSync(directory, 0o700);
        assertDirectoryIdentity(quarantineBase, baseIdentity);
        const directoryIdentity = captureDirectoryIdentity(directory);
        return {
            directory,
            directoryIdentity,
            path: join(directory, basename(originalPath)),
        };
    } catch (error) {
        rmdirSync(directory);
        throw error;
    }
}

function removePrivateQuarantine(location: QuarantineLocation): void {
    assertDirectoryIdentity(location.directory, location.directoryIdentity);
    const remaining = readdirSync(location.directory);
    if (remaining.length > 0) {
        throw new Error(`Private worktree quarantine is not empty: ${location.directory}`);
    }
    rmdirSync(location.directory);
    if (pathExistsStrict(location.directory)) {
        throw new Error(`Private worktree quarantine was not removed: ${location.directory}`);
    }
}

function rollbackQuarantinedPath(
    originalPath: string,
    location: QuarantineLocation,
    expectedIdentity: DirectoryIdentity,
    parentIdentity: DirectoryIdentity,
    kind: "directory" | "entry",
): boolean {
    const quarantinedExists = pathExistsStrict(location.path);
    const originalExists = pathExistsStrict(originalPath);
    if (!quarantinedExists) {
        removePrivateQuarantine(location);
        return false;
    }
    if (originalExists) return false;
    assertDirectoryIdentity(dirname(originalPath), parentIdentity);
    assertDirectoryIdentity(location.directory, location.directoryIdentity);
    assertQuarantinedIdentity(location.path, expectedIdentity, kind);
    renameSync(location.path, originalPath);
    if (kind === "directory") {
        assertDirectoryIdentity(originalPath, expectedIdentity);
    } else {
        assertPathIdentity(originalPath, expectedIdentity);
    }
    removePrivateQuarantine(location);
    return true;
}

function removeRegisteredWorktree(
    sourceRepository: string,
    worktreePath: string,
    expectedIdentity: DirectoryIdentity,
    force: boolean,
    quarantineBase = dirname(worktreePath),
): void {
    const parentIdentity = captureDirectoryIdentity(dirname(worktreePath));
    assertDirectoryIdentity(worktreePath, expectedIdentity);
    assertDirectoryIdentity(dirname(worktreePath), parentIdentity);
    const quarantine = createPrivateQuarantine(worktreePath, quarantineBase);
    try {
        assertDirectoryIdentity(worktreePath, expectedIdentity);
        assertDirectoryIdentity(dirname(worktreePath), parentIdentity);
        renameSync(worktreePath, quarantine.path);
        assertDirectoryIdentity(quarantine.directory, quarantine.directoryIdentity);
        assertQuarantinedIdentity(quarantine.path, expectedIdentity, "directory");
        const repaired = spawnSync(
            "git",
            ["worktree", "repair", quarantine.path],
            { cwd: sourceRepository, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        );
        if (repaired.error || repaired.status !== 0
            || !isValidWorktree(quarantine.path, sourceRepository)) {
            throw new Error((repaired.stderr ?? "").trim() || "git worktree repair failed");
        }
        const args = ["worktree", "remove", quarantine.path];
        if (force) args.push("--force");
        const removed = spawnSync(
            "git",
            args,
            { cwd: sourceRepository, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        );
        if (removed.error || removed.status !== 0) {
            throw new Error((removed.stderr ?? "").trim() || "git worktree remove failed");
        }
        if (pathExistsStrict(quarantine.path)) {
            throw new Error(`Git left quarantined worktree content behind: ${quarantine.path}`);
        }
        if (pathExistsStrict(worktreePath)) {
            throw new Error(`Worktree path was recreated during deletion: ${worktreePath}`);
        }
        removePrivateQuarantine(quarantine);
    } catch (error) {
        try {
            if (rollbackQuarantinedPath(
                worktreePath,
                quarantine,
                expectedIdentity,
                parentIdentity,
                "directory",
            )) {
                const repaired = spawnSync(
                    "git",
                    ["worktree", "repair", worktreePath],
                    { cwd: sourceRepository, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
                );
                if (repaired.error || repaired.status !== 0
                    || !isValidWorktree(worktreePath, sourceRepository)) {
                    throw new Error(
                        (repaired.stderr ?? "").trim() || "git worktree rollback repair failed",
                    );
                }
            }
        } catch (rollbackError) {
            throw new Error(
                `${(error as Error).message}; quarantine rollback failed: ${(rollbackError as Error).message}`,
                { cause: error },
            );
        }
        throw error;
    }
}

function removeDirectoryByQuarantine(
    path: string,
    expectedIdentity: DirectoryIdentity,
    quarantineBase = dirname(path),
    emptyOnly = false,
): void {
    const parentIdentity = captureDirectoryIdentity(dirname(path));
    assertDirectoryIdentity(path, expectedIdentity);
    assertDirectoryIdentity(dirname(path), parentIdentity);
    const quarantine = createPrivateQuarantine(path, quarantineBase);
    try {
        assertDirectoryIdentity(path, expectedIdentity);
        assertDirectoryIdentity(dirname(path), parentIdentity);
        renameSync(path, quarantine.path);
        assertDirectoryIdentity(quarantine.directory, quarantine.directoryIdentity);
        assertQuarantinedIdentity(quarantine.path, expectedIdentity, "directory");
        if (emptyOnly) {
            rmdirSync(quarantine.path);
        } else {
            rmSync(quarantine.path, { recursive: true, force: true });
        }
        if (pathExistsStrict(quarantine.path)) {
            throw new Error(`Quarantined workspace directory was not removed: ${quarantine.path}`);
        }
        if (pathExistsStrict(path)) {
            throw new Error(`Workspace path was recreated during deletion: ${path}`);
        }
        removePrivateQuarantine(quarantine);
    } catch (error) {
        try {
            rollbackQuarantinedPath(
                path,
                quarantine,
                expectedIdentity,
                parentIdentity,
                "directory",
            );
        } catch (rollbackError) {
            throw new Error(
                `${(error as Error).message}; quarantine rollback failed: ${(rollbackError as Error).message}`,
                { cause: error },
            );
        }
        throw error;
    }
}

function removePathByQuarantine(
    path: string,
    expectedIdentity: DirectoryIdentity,
    quarantineBase = dirname(path),
): void {
    const parentIdentity = captureDirectoryIdentity(dirname(path));
    assertPathIdentity(path, expectedIdentity);
    assertDirectoryIdentity(dirname(path), parentIdentity);
    const quarantine = createPrivateQuarantine(path, quarantineBase);
    try {
        assertPathIdentity(path, expectedIdentity);
        assertDirectoryIdentity(dirname(path), parentIdentity);
        renameSync(path, quarantine.path);
        assertDirectoryIdentity(quarantine.directory, quarantine.directoryIdentity);
        assertQuarantinedIdentity(quarantine.path, expectedIdentity, "entry");
        rmSync(quarantine.path, { recursive: true, force: true });
        if (pathExistsStrict(quarantine.path)) {
            throw new Error(`Quarantined workspace entry was not removed: ${quarantine.path}`);
        }
        removePrivateQuarantine(quarantine);
    } catch (error) {
        try {
            rollbackQuarantinedPath(
                path,
                quarantine,
                expectedIdentity,
                parentIdentity,
                "entry",
            );
        } catch (rollbackError) {
            throw new Error(
                `${(error as Error).message}; quarantine rollback failed: ${(rollbackError as Error).message}`,
                { cause: error },
            );
        }
        throw error;
    }
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

export function assertWorkspaceBranch(
    workspacePath: string,
    expectedBranch: string,
    runner: typeof spawnSync = spawnSync,
    sourcePath?: string,
): void {
    if (!existsSync(workspacePath)) {
        throw new Error(`Workspace for branch '${expectedBranch}' no longer exists.`);
    }
    if (sourcePath) {
        assertWorkspaceOwnership(workspacePath, sourcePath);
    }
    const repositories = branchRepositories(workspacePath);
    if (repositories.length === 0) {
        throw new Error(`Unable to verify workspace branch '${expectedBranch}': no worktree repositories found.`);
    }
    for (const repository of repositories) {
        const result = runner(
            "git",
            ["rev-parse", "--abbrev-ref", "HEAD"],
            { cwd: repository.path, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        );
        const actualBranch = (result.stdout ?? "").trim();
        if (result.error || result.status !== 0 || !actualBranch) {
            throw new Error(`Unable to verify workspace branch '${expectedBranch}' in '${repository.name}'.`);
        }
        if (actualBranch !== expectedBranch) {
            throw new Error(
                `Workspace repository '${repository.name}' belongs to branch '${actualBranch}', not '${expectedBranch}'.`,
            );
        }
    }
}

type GitLinkKind = "directory" | "worktree" | "gitlink";

function gitLinkKind(gitPath: string): GitLinkKind {
    let observed;
    try {
        observed = lstatSync(gitPath);
    } catch (error) {
        throw new Error(`Unable to inspect worktree metadata '${gitPath}'.`, { cause: error });
    }
    if (observed.isDirectory()) return "directory";
    if (!observed.isFile()) {
        throw new Error(`Invalid worktree metadata '${gitPath}'.`);
    }
    const content = readFileSync(gitPath, "utf-8").trim();
    const match = content.match(/^gitdir:\s*(.+)$/);
    if (!match) throw new Error(`Invalid worktree metadata '${gitPath}'.`);
    const gitDir = resolve(dirname(gitPath), match[1].trim());
    let commonDir: string;
    try {
        commonDir = readFileSync(join(gitDir, "commondir"), "utf-8").trim();
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "gitlink";
        throw new Error(`Unable to inspect worktree common directory '${gitPath}'.`, { cause: error });
    }
    try {
        if (!commonDir) throw new Error("empty commondir");
        const gitDirObserved = lstatSync(gitDir);
        if (!gitDirObserved.isDirectory() || gitDirObserved.isSymbolicLink()) {
            throw new Error("worktree management entry is not a real directory");
        }
        const registeredGitFile = readFileSync(join(gitDir, "gitdir"), "utf-8").trim();
        if (!registeredGitFile) throw new Error("empty gitdir registration");
        if (realpathSync(registeredGitFile) !== realpathSync(gitPath)) {
            throw new Error("worktree registration does not point back to workspace");
        }
        const commonGitDir = resolve(gitDir, commonDir);
        if (!lstatSync(commonGitDir).isDirectory()) {
            throw new Error("worktree common directory is not a directory");
        }
        const managementRootPath = join(realpathSync(commonGitDir), "worktrees");
        const managementRootObserved = lstatSync(managementRootPath);
        if (!managementRootObserved.isDirectory() || managementRootObserved.isSymbolicLink()) {
            throw new Error("worktree management root is not a real directory");
        }
        if (dirname(realpathSync(gitDir)) !== realpathSync(managementRootPath)) {
            throw new Error("worktree management entry is outside its source repository");
        }
        const listed = spawnSync(
            "git",
            ["--git-dir", realpathSync(commonGitDir), "worktree", "list", "--porcelain"],
            { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        );
        if (listed.error || listed.status !== 0) {
            throw new Error("unable to verify Git worktree registry");
        }
        const expectedPath = realpathSync(dirname(gitPath));
        const registered = (listed.stdout ?? "")
            .split(/\r?\n/)
            .filter((line) => line.startsWith("worktree "))
            .some((line) => {
                try {
                    return realpathSync(line.slice("worktree ".length).trim()) === expectedPath;
                } catch {
                    return false;
                }
            });
        if (!registered) throw new Error("workspace is absent from Git worktree registry");
        return "worktree";
    } catch (error) {
        throw new Error(`Unable to inspect worktree common directory '${gitPath}'.`, { cause: error });
    }
}

function isTrackedGitlink(repositoryPath: string, entryName: string): boolean {
    const result = spawnSync(
        "git",
        ["ls-files", "--stage", "--", entryName],
        { cwd: repositoryPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (result.error || result.status !== 0) return false;
    return (result.stdout ?? "")
        .split(/\r?\n/)
        .some((line) => line.startsWith("160000 "));
}

function sameObservedPath(left: string, right: string): boolean {
    try {
        return realpathSync(left) === realpathSync(right);
    } catch {
        const resolvedLeft = resolve(left);
        const resolvedRight = resolve(right);
        return process.platform === "win32"
            ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
            : resolvedLeft === resolvedRight;
    }
}

function registryContainsWorktree(repositoryPath: string, expectedPath: string): boolean {
    const listed = spawnSync(
        "git",
        ["worktree", "list", "--porcelain"],
        { cwd: repositoryPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (listed.error || listed.status !== 0) {
        throw new Error(`Unable to inspect Git worktree registry '${repositoryPath}'.`);
    }
    return (listed.stdout ?? "")
        .split(/\r?\n/)
        .filter((line) => line.startsWith("worktree "))
        .some((line) => sameObservedPath(
            line.slice("worktree ".length).trim(),
            expectedPath,
        ));
}

function siblingRegisteredWorkspacePaths(workspacePath: string): string[] {
    const registered: string[] = [];
    const workspaceName = basename(workspacePath);
    let separatorIndex = workspaceName.indexOf(WORKTREE_SEPARATOR);
    while (separatorIndex > 0) {
        const sourcePath = join(
            dirname(workspacePath),
            workspaceName.slice(0, separatorIndex),
        );
        if (pathExistsStrict(sourcePath)) {
            if (hasGitMetadata(sourcePath)
                && registryContainsWorktree(sourcePath, workspacePath)) {
                registered.push(workspacePath);
            }
            for (const entry of scanDirectory(sourcePath, { strict: true })) {
                if (entry.isGitRepo
                    && registryContainsWorktree(
                        entry.path,
                        join(workspacePath, entry.name),
                    )) {
                    registered.push(join(workspacePath, entry.name));
                }
            }
        }
        separatorIndex = workspaceName.indexOf(
            WORKTREE_SEPARATOR,
            separatorIndex + WORKTREE_SEPARATOR.length,
        );
    }
    return registered.filter((path, index) => (
        registered.findIndex((candidate) => sameObservedPath(candidate, path)) === index
    ));
}

function siblingSourceRegistersWorkspace(workspacePath: string): boolean {
    return siblingRegisteredWorkspacePaths(workspacePath).length > 0;
}

function branchRepositories(
    workspacePath: string,
    expectedTopology?: "root" | "children",
): Array<{ name: string; path: string }> {
    const rootGit = join(workspacePath, ".git");
    const hasRootGit = pathExistsStrict(rootGit);
    if (expectedTopology === "root" && !hasRootGit) {
        throw new Error(`Workspace root metadata changed during inspection: ${rootGit}`);
    }
    if (expectedTopology === "children" && hasRootGit) {
        throw new Error(`Workspace topology changed during inspection: ${rootGit}`);
    }
    if (hasRootGit) {
        const repositories = [{ name: basename(workspacePath), path: workspacePath }];
        for (const entry of scanDirectory(workspacePath, { strict: true })) {
            if (!entry.isGitRepo) continue;
            const kind = gitLinkKind(join(entry.path, ".git"));
            if (kind === "worktree") {
                repositories.push({ name: entry.name, path: entry.path });
                continue;
            }
            if (kind === "gitlink" && isTrackedGitlink(workspacePath, entry.name)) {
                continue;
            }
            throw new Error(`Workspace contains unmanaged Git repository '${entry.name}'.`);
        }
        return repositories;
    }
    return scanDirectory(workspacePath, { strict: true })
        .filter((entry) => entry.isGitRepo)
        .map(({ name, path }) => ({ name, path }));
}

export function hasGitMetadata(repositoryPath: string): boolean {
    const gitPath = join(resolve(repositoryPath), ".git");
    try {
        lstatSync(gitPath);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw new Error(`Unable to inspect Git metadata '${gitPath}'.`, { cause: error });
    }
}

function assertWorkspaceOwnership(workspacePath: string, sourcePath: string): void {
    const resolvedSource = resolve(sourcePath);
    if (hasGitMetadata(resolvedSource)) {
        assertWorkspaceRootOwnership(workspacePath, resolvedSource);
        const sourceRepositories = new Map(
            scanDirectory(resolvedSource, { strict: true })
                .filter((entry) => entry.isGitRepo)
                .map((entry) => [entry.name, entry]),
        );
        for (const source of sourceRepositories.values()) {
            const destinationGit = join(workspacePath, source.name, ".git");
            if (!pathExistsStrict(destinationGit)
                && !isTrackedGitlink(resolvedSource, source.name)) {
                throw new Error(
                    `Workspace repository '${source.name}' is not owned by its source repository.`,
                );
            }
        }
        for (const destination of scanDirectory(workspacePath, { strict: true }).filter((entry) => entry.isGitRepo)) {
            const source = sourceRepositories.get(destination.name);
            if (!source) {
                throw new Error(`Workspace contains unowned Git repository '${destination.name}'.`);
            }
            const kind = gitLinkKind(join(destination.path, ".git"));
            if (kind === "gitlink" && isTrackedGitlink(workspacePath, destination.name)) continue;
            if (kind !== "worktree" || !isValidWorktree(destination.path, source.path)) {
                throw new Error(`Workspace repository '${destination.name}' is not owned by its source repository.`);
            }
        }
        return;
    }

    const sourceRepositories = scanDirectory(resolvedSource, { strict: true }).filter((entry) => entry.isGitRepo);
    if (sourceRepositories.length === 0) {
        throw new Error(`Unable to verify workspace ownership: no source repositories found.`);
    }
    for (const source of sourceRepositories) {
        const destination = join(workspacePath, source.name);
        if (!isValidWorktree(destination, source.path)) {
            throw new Error(`Workspace repository '${source.name}' is not owned by its source repository.`);
        }
    }
    const sourceNames = new Set(sourceRepositories.map(({ name }) => name));
    for (const destination of scanDirectory(workspacePath, { strict: true }).filter((entry) => entry.isGitRepo)) {
        if (!sourceNames.has(destination.name)) {
            throw new Error(`Workspace contains unowned Git repository '${destination.name}'.`);
        }
    }
}

export function assertWorkspaceRootOwnership(
    workspacePath: string,
    sourcePath: string,
): void {
    const resolvedSource = resolve(sourcePath);
    if (!isValidWorktree(workspacePath, resolvedSource)) {
        throw new Error(`Workspace is not owned by source repository '${resolvedSource}'.`);
    }
}

export function detectWorktreeWorkspaceBranch(
    workspacePath: string,
    runner: typeof spawnSync = spawnSync,
): string | null {
    if (!pathExistsStrict(workspacePath)) return null;
    const rootGit = join(workspacePath, ".git");
    let repositories: Array<{ name: string; path: string }>;
    if (pathExistsStrict(rootGit)) {
        if (gitLinkKind(rootGit) !== "worktree") {
            const nestedKinds = scanDirectory(workspacePath, { strict: true })
                .filter((entry) => entry.isGitRepo)
                .map((entry) => gitLinkKind(join(entry.path, ".git")));
            if (nestedKinds.some((kind) => kind === "worktree")
                || siblingSourceRegistersWorkspace(workspacePath)) {
                throw new Error("Workspace contains a mixture of a root repository and child worktrees.");
            }
            return null;
        }
        repositories = branchRepositories(workspacePath, "root");
    } else {
        const candidates = scanDirectory(workspacePath, { strict: true }).filter((entry) => entry.isGitRepo);
        const kinds = candidates.map((entry) => ({
            entry,
            kind: gitLinkKind(join(entry.path, ".git")),
        }));
        const worktrees = kinds.filter(({ kind }) => kind === "worktree");
        if (worktrees.length === 0) {
            if (siblingSourceRegistersWorkspace(workspacePath)) {
                throw new Error("Workspace Git metadata is missing or damaged.");
            }
            return null;
        }
        if (worktrees.length !== kinds.length) {
            throw new Error("Workspace contains a mixture of worktrees and regular repositories.");
        }
        repositories = worktrees.map(({ entry: { name, path } }) => ({ name, path }));
    }
    const registeredPaths = siblingRegisteredWorkspacePaths(workspacePath);
    if (registeredPaths.some((registeredPath) => (
        !repositories.some(({ path }) => sameObservedPath(path, registeredPath))
    ))) {
        throw new Error("Workspace Git metadata is missing or damaged.");
    }
    if (repositories.length === 0) return null;

    const branches = new Set<string>();
    for (const repository of repositories) {
        const result = runner(
            "git",
            ["rev-parse", "--abbrev-ref", "HEAD"],
            { cwd: repository.path, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        );
        const branch = (result.stdout ?? "").trim();
        if (result.error || result.status !== 0 || !branch) {
            throw new Error(`Unable to determine worktree branch in '${repository.name}'.`);
        }
        branches.add(branch);
    }
    if (branches.size !== 1) {
        throw new Error("Workspace repositories do not share one checked-out branch.");
    }
    return [...branches][0];
}

// === Read-only Functions ===

/**
 * Scan a directory at 1-depth level.
 * Returns entries with isGitRepo flag based on .git existence.
 * Skips hidden files/directories (starting with .)
 * Uses lstatSync to avoid following symlinks (prevents symlink loops).
 */
export function scanDirectory(
    dirPath: string,
    options: { strict?: boolean } = {},
): WorkspaceEntry[] {
    if (!options.strict && !existsSync(dirPath)) return [];
    if (options.strict) {
        try {
            if (!lstatSync(dirPath).isDirectory()) return [];
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw new Error(`Unable to inspect workspace directory '${dirPath}'.`, { cause: error });
        }
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
        } catch (error) {
            if (options.strict) {
                throw new Error(`Unable to inspect workspace entry '${fullPath}'.`, { cause: error });
            }
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
        const gitPath = join(fullPath, ".git");
        let isGitRepo: boolean;
        if (options.strict) {
            try {
                lstatSync(gitPath);
                isGitRepo = true;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                    throw new Error(`Unable to inspect Git metadata '${gitPath}'.`, { cause: error });
                }
                isGitRepo = false;
            }
        } else {
            isGitRepo = existsSync(gitPath);
        }
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

function rollbackCreatedBranch(
    repositoryPath: string,
    branch: string,
    action: WorktreeRepoResult["action"],
): void {
    if (action === "worktree-existing") return;
    const result = spawnSync(
        "git",
        ["branch", "-D", branch],
        { cwd: repositoryPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (result.error || result.status !== 0) {
        const detail = (result.stderr ?? "").trim()
            || result.error?.message
            || `git exited with status ${String(result.status)}`;
        throw new Error(`Failed to roll back branch '${branch}': ${detail}`);
    }
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
    if (hasGitMetadata(resolved)) {
        return null;
    }

    const entries = scanDirectory(resolved, { strict: true });
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
    spawnSync("git", ["config", "commit.gpgsign", "false"], {
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
    if (hasGitMetadata(resolved)) {
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
    let nestedCreated: WorktreeRepoResult[];
    try {
        nestedCreated = repairWorkspace(resolved, wsPath, branch);
    } catch (error) {
        const rollbackErrors: string[] = [];
        try {
            if (!isValidWorktree(wsPath, resolved)) {
                throw new Error("root worktree ownership changed during rollback");
            }
            removeRegisteredWorktree(
                resolved,
                wsPath,
                captureDirectoryIdentity(wsPath),
                true,
                dirname(wsPath),
            );
            rollbackCreatedBranch(resolved, branch, action);
        } catch (rollbackError) {
            rollbackErrors.push((rollbackError as Error).message);
        }
        if (rollbackErrors.length > 0) {
            throw new Error(
                `${(error as Error).message}; workspace rollback failed: ${rollbackErrors.join("; ")}`,
                { cause: error },
            );
        }
        throw error;
    }

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
    const entries = scanDirectory(resolved, { strict: true });
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
    const workspaceIdentity = captureDirectoryIdentity(wsPath);

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
        const rollbackErrors: string[] = [];
        for (const c of created) {
            const destPath = join(wsPath, c.name);
            const sourceRepo = gitRepos.find((r) => r.name === c.name);
            if (!sourceRepo || !pathExistsStrict(destPath)) continue;
            if (!isValidWorktree(destPath, sourceRepo.path)) {
                rollbackErrors.push(`${c.name}: worktree ownership changed during rollback`);
                continue;
            }
            try {
                removeRegisteredWorktree(
                    sourceRepo.path,
                    destPath,
                    captureDirectoryIdentity(destPath),
                    true,
                    dirname(wsPath),
                );
                rollbackCreatedBranch(sourceRepo.path, branch, c.action);
            } catch (rollbackError) {
                rollbackErrors.push(`${c.name}: ${(rollbackError as Error).message}`);
            }
        }
        if (rollbackErrors.length === 0) {
            try {
                assertDirectoryIdentity(wsPath, workspaceIdentity);
                if (readdirSync(wsPath).length !== 0) {
                    throw new Error("workspace is not empty after worktree rollback");
                }
                removeDirectoryByQuarantine(wsPath, workspaceIdentity);
            } catch (rollbackError) {
                rollbackErrors.push((rollbackError as Error).message);
            }
        }
        if (rollbackErrors.length > 0) {
            throw new Error(
                `${(e as Error).message}; workspace rollback failed: ${rollbackErrors.join("; ")}`,
                { cause: e },
            );
        }
        throw e;
    }

    // Process non-repo items → copy (isolated per worktree)
    const nonRepos = entries.filter((e) => !e.isGitRepo);
    for (const entry of nonRepos) {
        const destPath = join(wsPath, entry.name);
        try {
            copyDirRecursive(entry.path, destPath);
            if (!pathExistsStrict(destPath)) {
                throw new Error(`Source entry could not be copied safely: ${entry.path}`);
            }
            copied.push(entry.name);
        } catch (e) {
            const rollback = removeWorkspace(resolved, branch, { force: true });
            if (rollback.errors.length > 0) {
                throw new Error(
                    `${(e as Error).message}; workspace rollback failed: ${rollback.errors.join("; ")}`,
                    { cause: e },
                );
            }
            throw e;
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
    if (!hasGitMetadata(resolved)) {
        return [];
    }
    assertWorkspaceRootOwnership(wsPath, resolved);

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
    const removedEmptyDestinations: string[] = [];
    const sourceEntries = scanDirectory(resolved, { strict: true });

    function rollbackNestedCreation(error: unknown): never {
        const rollbackErrors: string[] = [];
        for (const createdEntry of [...created].reverse()) {
            const sourceEntry = sourceEntries.find((entry) => (
                entry.isGitRepo && entry.name === createdEntry.name
            ));
            const destination = join(wsPath, createdEntry.name);
            if (!sourceEntry || !pathExistsStrict(destination)) continue;
            if (!isValidWorktree(destination, sourceEntry.path)) {
                rollbackErrors.push(
                    `${createdEntry.name}: worktree ownership changed during rollback`,
                );
                continue;
            }
            try {
                removeRegisteredWorktree(
                    sourceEntry.path,
                    destination,
                    captureDirectoryIdentity(destination),
                    true,
                    dirname(wsPath),
                );
                rollbackCreatedBranch(
                    sourceEntry.path,
                    branch,
                    createdEntry.action,
                );
            } catch (rollbackError) {
                rollbackErrors.push(
                    `${createdEntry.name}: ${(rollbackError as Error).message}`,
                );
            }
        }
        for (const destination of removedEmptyDestinations) {
            if (pathExistsStrict(destination)) continue;
            try {
                mkdirSync(destination);
            } catch (rollbackError) {
                rollbackErrors.push(
                    `${basename(destination)}: failed to restore empty directory: ${(rollbackError as Error).message}`,
                );
            }
        }
        if (rollbackErrors.length > 0) {
            throw new Error(
                `${(error as Error).message}; nested worktree rollback failed: ${rollbackErrors.join("; ")}`,
                { cause: error },
            );
        }
        throw error;
    }

    for (const entry of sourceEntries) {
        if (!entry.isGitRepo) continue;

        const destPath = join(wsPath, entry.name);

        // Check existing directory
        if (pathExistsStrict(destPath)) {
            const destIdentity = captureDirectoryIdentity(destPath);
            const contents = readdirSync(destPath);
            if (contents.length > 0) {
                // Non-empty invalid entries require the explicit repair prompt.
                continue;
            }
            removeDirectoryByQuarantine(destPath, destIdentity, dirname(wsPath), true);
            removedEmptyDestinations.push(destPath);
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

        if (nestedResult.error || nestedResult.status !== 0) {
            const detail = (nestedResult.stderr ?? "").trim()
                || nestedResult.error?.message
                || `git exited with status ${String(nestedResult.status)}`;
            rollbackNestedCreation(
                new Error(`Failed to create nested worktree for ${entry.name}: ${detail}`),
            );
        }
        created.push({ name: entry.name, branch, action: nestedAction });
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
export function getWorktreeGitMounts(
    worktreePath: string,
    required = false,
): WorktreeGitMount[] {
    const resolved = resolve(worktreePath);
    const mounts: WorktreeGitMount[] = [];
    const seen = new Set<string>();

    function addMount(hostPath: string, containerPath: string): void {
        const key = `${hostPath}:${containerPath}`;
        if (!seen.has(key)) {
            seen.add(key);
            mounts.push({ hostPath, containerPath });
        }
    }

    const rootGit = join(resolved, ".git");
    const gitFiles: string[] = [];
    if (pathExistsStrict(rootGit)) {
        if (lstatSync(rootGit).isFile()) {
            gitFiles.push(rootGit);
        } else if (required) {
            throw new Error(`Required worktree metadata is invalid: ${rootGit}`);
        }
    } else {
        for (const entry of scanDirectory(resolved, { strict: required })) {
            if (!entry.isGitRepo) continue;
            const nestedGit = join(entry.path, ".git");
            if (lstatSync(nestedGit).isFile()) gitFiles.push(nestedGit);
        }
    }
    if (required && gitFiles.length === 0) {
        throw new Error(`Required worktree metadata is missing: ${resolved}`);
    }

    for (const gitFile of gitFiles) {
        let kind: GitLinkKind;
        try {
            kind = gitLinkKind(gitFile);
        } catch (error) {
            if (required) {
                throw new Error(`Required worktree metadata is invalid: ${gitFile}`, {
                    cause: error,
                });
            }
            continue;
        }
        if (kind !== "worktree") {
            if (required) throw new Error(`Required worktree metadata is invalid: ${gitFile}`);
            continue;
        }
        const content = readFileSync(gitFile, "utf-8").trim();
        const match = content.match(/^gitdir:\s*(.+)$/);
        if (!match) throw new Error(`Required worktree metadata is invalid: ${gitFile}`);
        const resolvedGitdir = resolve(dirname(gitFile), match[1].trim());
        const sourceGitDir = resolve(resolvedGitdir, "..", "..");
        captureDirectoryIdentity(sourceGitDir);
        const sourceRepoDir = dirname(sourceGitDir);
        if (!isValidWorktree(dirname(gitFile), sourceRepoDir)) {
            throw new Error(`Worktree mount ownership could not be verified: ${gitFile}`);
        }
        const sourceBasename = basename(sourceRepoDir);
        addMount(sourceGitDir, sourceGitDir);
        const relMountPath = `/project/${sourceBasename}/.git`;
        if (relMountPath !== sourceGitDir) {
            addMount(sourceGitDir, relMountPath);
        }

        for (const entry of scanDirectory(sourceRepoDir, { strict: required })) {
            if (!entry.isGitRepo) continue;
            const nestedGitPath = join(entry.path, ".git");
            const nestedGit = lstatSync(nestedGitPath);
            if (nestedGit.isDirectory() && !nestedGit.isSymbolicLink()) {
                addMount(nestedGitPath, nestedGitPath);
                const nestedRelPath = `/project/${sourceBasename}/${entry.name}/.git`;
                if (nestedRelPath !== nestedGitPath) {
                    addMount(nestedGitPath, nestedRelPath);
                }
            }
        }
    }

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
        const gitdirObserved = lstatSync(resolvedGitdir);
        if (!gitdirObserved.isDirectory() || gitdirObserved.isSymbolicLink()) return false;
        const registeredGitFile = readFileSync(
            join(resolvedGitdir, "gitdir"),
            "utf-8",
        ).trim();
        if (!registeredGitFile) return false;
        try {
            if (realpathSync(registeredGitFile) !== realpathSync(gitPath)) return false;
        } catch {
            return false;
        }

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

        // Compare with realpathSync to handle symlinks (common on macOS).
        // Observation failure cannot establish destructive ownership.
        try {
            const sourceGitRealpath = realpathSync(actualSourceGitDir);
            if (realpathSync(commonGitDir) !== sourceGitRealpath) return false;
            const managementRootPath = join(sourceGitRealpath, "worktrees");
            const managementRootObserved = lstatSync(managementRootPath);
            if (!managementRootObserved.isDirectory() || managementRootObserved.isSymbolicLink()) {
                return false;
            }
            const managementRoot = realpathSync(managementRootPath);
            const managementEntry = realpathSync(resolvedGitdir);
            if (dirname(managementEntry) !== managementRoot) return false;
            const listed = spawnSync(
                "git",
                ["worktree", "list", "--porcelain"],
                { cwd: sourceRepoPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
            );
            if (listed.error || listed.status !== 0) return false;
            const expectedPath = realpathSync(dirPath);
            return (listed.stdout ?? "")
                .split(/\r?\n/)
                .filter((line) => line.startsWith("worktree "))
                .some((line) => {
                    const registeredPath = line.slice("worktree ".length).trim();
                    if (!registeredPath) return false;
                    try {
                        return realpathSync(registeredPath) === expectedPath;
                    } catch {
                        return false;
                    }
                });
        } catch {
            return false;
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

    if (!hasGitMetadata(resolved)) {
        return [];
    }

    const broken: BrokenWorktreeEntry[] = [];
    const sourceEntries = scanDirectory(resolved, { strict: true });

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
    confirmed = false,
): WorktreeRepoResult | null {
    if (!confirmed) {
        throw new Error("Explicit confirmation is required to replace broken worktree content.");
    }
    const resolved = resolve(sourcePath);
    const destPath = join(wsPath, repoName);
    assertWorkspaceRootOwnership(wsPath, resolved);

    // Find the source repo
    const sourceEntries = scanDirectory(resolved, { strict: true });
    const sourceRepo = sourceEntries.find((e) => e.name === repoName && e.isGitRepo);
    if (!sourceRepo) return null;

    let backup: QuarantineLocation | null = null;
    let backupIdentity: DirectoryIdentity | null = null;
    const workspaceIdentity = captureDirectoryIdentity(wsPath);
    if (pathExistsStrict(destPath)) {
        backupIdentity = captureDirectoryIdentity(destPath);
        backup = createPrivateQuarantine(destPath, dirname(wsPath));
        try {
            assertDirectoryIdentity(wsPath, workspaceIdentity);
            assertDirectoryIdentity(destPath, backupIdentity);
            renameSync(destPath, backup.path);
            assertQuarantinedIdentity(backup.path, backupIdentity, "directory");
        } catch (error) {
            if (!pathExistsStrict(backup.path)) removePrivateQuarantine(backup);
            throw error;
        }
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
        if (backup && backupIdentity) {
            if (pathExistsStrict(destPath)) {
                if (!isValidWorktree(destPath, sourceRepo.path)) {
                    throw new Error(
                        `Failed worktree creation left unverified content at '${destPath}'; original content remains in '${backup.directory}'.`,
                    );
                }
                removeRegisteredWorktree(
                    sourceRepo.path,
                    destPath,
                    captureDirectoryIdentity(destPath),
                    true,
                    dirname(wsPath),
                );
                rollbackCreatedBranch(sourceRepo.path, branch, c.action);
            }
            const restored = rollbackQuarantinedPath(
                destPath,
                backup,
                backupIdentity,
                workspaceIdentity,
                "directory",
            );
            if (!restored) {
                throw new Error(
                    `Failed worktree creation could not restore original content from '${backup.directory}'.`,
                );
            }
        }
        return null;
    }

    if (backup && backupIdentity) {
        try {
            assertDirectoryIdentity(wsPath, workspaceIdentity);
            if (!isValidWorktree(destPath, sourceRepo.path)) {
                throw new Error("Created worktree ownership could not be verified.");
            }
            assertQuarantinedIdentity(backup.path, backupIdentity, "directory");
            for (const name of readdirSync(backup.path)) {
                if (name === ".git") continue;
                mergePreservingContent(
                    join(backup.path, name),
                    join(destPath, name),
                );
            }
            rmSync(backup.path, { recursive: true, force: true });
            if (pathExistsStrict(backup.path)) {
                throw new Error(`Broken-worktree backup was not removed: ${backup.path}`);
            }
            removePrivateQuarantine(backup);
        } catch (error) {
            if (pathExistsStrict(destPath)) {
                if (!isValidWorktree(destPath, sourceRepo.path)) {
                    throw new Error(
                        `${(error as Error).message}; created worktree ownership changed during rollback`,
                        { cause: error },
                    );
                }
                removeRegisteredWorktree(
                    sourceRepo.path,
                    destPath,
                    captureDirectoryIdentity(destPath),
                    true,
                    dirname(wsPath),
                );
            }
            rollbackQuarantinedPath(
                destPath,
                backup,
                backupIdentity,
                workspaceIdentity,
                "directory",
            );
            throw error;
        }
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

    assertWorkspaceBranch(wsPath, branch, spawnSync, resolved);
    const workspaceIdentity = captureDirectoryIdentity(wsPath);

    // Unified mode: top-level is a git repo → remove single worktree
    if (hasGitMetadata(resolved)) {
        return removeUnifiedWorkspace(resolved, wsPath, branch, workspaceIdentity, opts);
    }

    // Multi-repo mode
    return removeMultiRepoWorkspace(resolved, wsPath, workspaceIdentity, opts);
}

function removeUnifiedWorkspace(
    resolved: string,
    wsPath: string,
    branch: string,
    workspaceIdentity: DirectoryIdentity,
    opts?: { force?: boolean },
): RemoveResult {
    const removed: string[] = [];
    const errors: string[] = [];

    // Remove nested worktrees before removing the parent.
    // These are worktrees created for nested git repos (non-submodule).
    const sourceEntries = scanDirectory(resolved, { strict: true });
    for (const entry of sourceEntries) {
        if (!entry.isGitRepo) continue;

        const nestedPath = join(wsPath, entry.name);
        if (!existsSync(nestedPath)) continue;
        assertDirectoryIdentity(wsPath, workspaceIdentity);
        const nestedGitPath = join(nestedPath, ".git");
        if (existsSync(nestedGitPath)
            && gitLinkKind(nestedGitPath) === "gitlink"
            && isTrackedGitlink(wsPath, entry.name)) {
            continue;
        }
        if (!isValidWorktree(nestedPath, entry.path)) {
            errors.push(`${entry.name}: worktree ownership changed before deletion`);
            continue;
        }
        const nestedIdentity = captureDirectoryIdentity(nestedPath);
        try {
            removeRegisteredWorktree(
                entry.path,
                nestedPath,
                nestedIdentity,
                opts?.force === true,
                dirname(wsPath),
            );
            removed.push(entry.name);
        } catch (error) {
            errors.push(`${entry.name}: ${(error as Error).message}`);
        }
    }

    if (errors.length > 0) return { removed, errors };
    assertDirectoryIdentity(wsPath, workspaceIdentity);
    assertWorkspaceRootOwnership(wsPath, resolved);
    const branchResult = spawnSync(
        "git",
        ["rev-parse", "--abbrev-ref", "HEAD"],
        { cwd: wsPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const observedBranch = (branchResult.stdout ?? "").trim();
    if (branchResult.error || branchResult.status !== 0 || observedBranch !== branch) {
        throw new Error(
            observedBranch
                ? `Workspace belongs to branch '${observedBranch}', not '${branch}'.`
                : `Unable to determine worktree branch in '${basename(wsPath)}'.`,
        );
    }
    try {
        removeRegisteredWorktree(resolved, wsPath, workspaceIdentity, opts?.force === true);
        removed.push(basename(resolved));
    } catch (error) {
        errors.push((error as Error).message);
    }

    return { removed, errors };
}

function removeMultiRepoWorkspace(
    resolved: string,
    wsPath: string,
    workspaceIdentity: DirectoryIdentity,
    opts?: { force?: boolean },
): RemoveResult {
    const removed: string[] = [];
    const errors: string[] = [];

    const sourceEntries = scanDirectory(resolved, { strict: true });

    for (const entry of sourceEntries) {
        const wsEntryPath = join(wsPath, entry.name);
        if (!existsSync(wsEntryPath)) {
            continue;
        }

        if (entry.isGitRepo) {
            assertDirectoryIdentity(wsPath, workspaceIdentity);
            if (!isValidWorktree(wsEntryPath, entry.path)) {
                errors.push(`${entry.name}: worktree ownership changed before deletion`);
                continue;
            }
            const entryIdentity = captureDirectoryIdentity(wsEntryPath);
            try {
                removeRegisteredWorktree(
                    entry.path,
                    wsEntryPath,
                    entryIdentity,
                    opts?.force === true,
                    dirname(wsPath),
                );
                removed.push(entry.name);
            } catch (error) {
                errors.push(`${entry.name}: ${(error as Error).message}`);
            }
        } else {
            try {
                assertDirectoryIdentity(wsPath, workspaceIdentity);
                const current = scanDirectory(wsPath, { strict: true })
                    .find((candidate) => candidate.name === entry.name);
                if (current?.isGitRepo) {
                    errors.push(`${entry.name}: became a Git repository before deletion`);
                    continue;
                }
                const entryIdentity = capturePathIdentity(wsEntryPath);
                removePathByQuarantine(wsEntryPath, entryIdentity, dirname(wsPath));
                if (existsSync(wsEntryPath)) {
                    errors.push(`${entry.name}: path was recreated during deletion`);
                    continue;
                }
                removed.push(entry.name);
            } catch (error) {
                errors.push(`${entry.name}: ${(error as Error).message}`);
            }
        }
    }

    // Try to remove the workspace directory itself
    try {
        if (existsSync(wsPath)) {
            assertDirectoryIdentity(wsPath, workspaceIdentity);
            if (errors.length > 0) return { removed, errors };
            const remaining = readdirSync(wsPath);
            if (remaining.length === 0) {
                removeDirectoryByQuarantine(wsPath, workspaceIdentity);
            } else if (opts?.force) {
                const remainingRepositories = scanDirectory(wsPath, { strict: true })
                    .filter((entry) => entry.isGitRepo);
                if (remainingRepositories.length > 0) {
                    errors.push(
                        `Workspace ownership changed before deletion (${remainingRepositories.map(({ name }) => name).join(", ")}).`,
                    );
                    return { removed, errors };
                }
                removeDirectoryByQuarantine(wsPath, workspaceIdentity);
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
