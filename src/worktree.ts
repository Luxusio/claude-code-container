// src/worktree.ts - Git worktree workspace management for ccc

import { spawnSync } from "child_process";
import { randomBytes } from "crypto";
import {
    chmodSync,
    closeSync,
    existsSync,
    mkdtempSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    writeFileSync,
    copyFileSync,
    rmSync,
    rmdirSync,
    lstatSync,
    linkSync,
    openSync,
    renameSync,
    realpathSync,
    unlinkSync,
} from "fs";
import {
    basename,
    dirname,
    isAbsolute,
    join,
    posix,
    relative,
    resolve,
    win32,
} from "path";

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

function mergePreservingContent(src: string, dest: string): void {
    const source = lstatSync(src);
    if (source.isSymbolicLink()) {
        throw new Error(`Workspace content contains a symbolic link that cannot be merged safely: ${src}`);
    }
    if (source.isDirectory()) {
        if (!pathExistsStrict(dest)) {
            mkdirSync(dest);
        } else {
            const destination = lstatSync(dest);
            if (destination.isSymbolicLink() || !destination.isDirectory()) {
                throw new Error(`Workspace content conflicts with checked-out worktree content: ${dest}`);
            }
        }
        for (const entry of readdirSync(src)) {
            if (entry === ".git") continue;
            mergePreservingContent(join(src, entry), join(dest, entry));
        }
        return;
    }
    if (!pathExistsStrict(dest)) {
        copyFileSync(src, dest);
        return;
    }
    const destination = lstatSync(dest);
    if (destination.isSymbolicLink()) {
        throw new Error(`Worktree destination contains a symbolic link: ${dest}`);
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

export type DirectoryIdentity = {
    realpath: string;
    dev: string;
    ino: string;
};

type FileIdentity = {
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

function captureFileIdentity(path: string): FileIdentity {
    const observed = lstatSync(path, { bigint: true });
    if (!observed.isFile() || observed.isSymbolicLink()) {
        throw new Error(`Workspace entry '${path}' must be a real file.`);
    }
    return {
        dev: observed.dev.toString(),
        ino: observed.ino.toString(),
    };
}

function assertFileIdentity(path: string, expected: FileIdentity): void {
    const actual = captureFileIdentity(path);
    if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
        throw new Error(`Workspace file identity changed: ${path}`);
    }
}

export function portableWorktreeGitDirectory(
    gitFileDirectory: string,
    resolvedGitDirectory: string,
    platform = process.platform,
): string {
    const paths = platform === "win32" ? win32 : posix;
    const portableGitDirectory = paths.relative(
        gitFileDirectory,
        resolvedGitDirectory,
    ).replace(/\\/g, "/");
    const reconstructed = paths.resolve(
        gitFileDirectory,
        portableGitDirectory,
    );
    const expected = paths.resolve(resolvedGitDirectory);
    const sameResolvedPath = platform === "win32"
        ? reconstructed.toLowerCase() === expected.toLowerCase()
        : reconstructed === expected;
    if (!portableGitDirectory
        || paths.isAbsolute(portableGitDirectory)
        || /^[A-Za-z]:/.test(portableGitDirectory)
        || !sameResolvedPath) {
        throw new Error(
            `Worktree metadata crosses incompatible filesystem roots: ${gitFileDirectory}`,
        );
    }
    return portableGitDirectory;
}

function normalizeWorktreeGitLink(
    gitFile: string,
    resolvedGitDirectory: string,
    gitFileIdentity: DirectoryIdentity,
): string {
    const portableGitDirectory = portableWorktreeGitDirectory(
        dirname(gitFile),
        resolvedGitDirectory,
    );
    const expectedContent = `gitdir: ${portableGitDirectory}\n`;
    assertPathIdentity(gitFile, gitFileIdentity);
    const existingContent = readFileSync(gitFile, "utf-8");
    assertPathIdentity(gitFile, gitFileIdentity);
    if (existingContent === expectedContent) {
        return portableGitDirectory;
    }
    const parentIdentity = captureDirectoryIdentity(dirname(gitFile));
    const temporary = join(
        dirname(gitFile),
        `.${basename(gitFile)}.ccc-${randomBytes(16).toString("hex")}.tmp`,
    );
    const backup = join(
        dirname(gitFile),
        `.${basename(gitFile)}.ccc-${randomBytes(16).toString("hex")}.backup`,
    );
    let temporaryIdentity: FileIdentity | null = null;
    try {
        writeFileSync(temporary, expectedContent, { flag: "wx", mode: 0o600 });
        temporaryIdentity = captureFileIdentity(temporary);
        assertDirectoryIdentity(dirname(gitFile), parentIdentity);
        assertPathIdentity(gitFile, gitFileIdentity);
        renameSync(gitFile, backup);
        assertQuarantinedIdentity(backup, gitFileIdentity, "entry");
        assertDirectoryIdentity(dirname(gitFile), parentIdentity);
        linkSync(temporary, gitFile);
        assertFileIdentity(gitFile, temporaryIdentity);
        rmSync(temporary, { force: true });
        assertDirectoryIdentity(dirname(gitFile), parentIdentity);
        assertFileIdentity(gitFile, temporaryIdentity);
        if (readFileSync(gitFile, "utf-8") !== expectedContent) {
            throw new Error("normalized worktree metadata changed after installation");
        }
        assertQuarantinedIdentity(backup, gitFileIdentity, "entry");
        rmSync(backup);
    } catch (error) {
        rmSync(temporary, { force: true });
        let preservedBackup = false;
        try {
            if (pathExistsStrict(backup)) {
                assertQuarantinedIdentity(backup, gitFileIdentity, "entry");
                if (!pathExistsStrict(gitFile)) {
                    linkSync(backup, gitFile);
                }
                if (temporaryIdentity) {
                    try {
                        assertFileIdentity(gitFile, temporaryIdentity);
                        if (readFileSync(gitFile, "utf-8") === expectedContent) {
                            rmSync(backup);
                            return portableGitDirectory;
                        }
                    } catch {
                        // The installed path is not the file CCC staged.
                    }
                }
                const restoredIdentity = capturePathIdentity(gitFile);
                if (restoredIdentity.dev === gitFileIdentity.dev
                    && restoredIdentity.ino === gitFileIdentity.ino) {
                    rmSync(backup);
                } else {
                    preservedBackup = true;
                }
            } else if (temporaryIdentity) {
                assertFileIdentity(gitFile, temporaryIdentity);
                if (readFileSync(gitFile, "utf-8") === expectedContent) {
                    return portableGitDirectory;
                }
            }
        } catch {
            // Preserve the normalization race as the primary diagnostic.
            preservedBackup = pathExistsStrict(backup);
        }
        const preservation = preservedBackup
            ? `; original preserved at ${backup}`
            : "";
        throw new Error(`Worktree metadata changed during normalization: ${gitFile}${preservation}`, {
            cause: error,
        });
    }
    return portableGitDirectory;
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
    registrationFence?: WorktreeRegistrationFence,
    sourceEnvironment?: NodeJS.ProcessEnv,
    mutationGuard?: () => void,
    quarantinedContentGuard?: (quarantinedPath: string) => void,
): void {
    mutationGuard?.();
    const expectedBranch = registrationFence?.expectedRef.replace(/^refs\/heads\//, "");
    if (registrationFence && (
        !expectedBranch
        || !worktreeRegistrationOwnershipMatches(
            sourceRepository,
            worktreePath,
            registrationFence,
        )
    )) {
        throw new Error(`Worktree registration ownership changed before deletion: ${worktreePath}`);
    }
    mutationGuard?.();
    const parentIdentity = captureDirectoryIdentity(dirname(worktreePath));
    mutationGuard?.();
    assertDirectoryIdentity(worktreePath, expectedIdentity);
    assertDirectoryIdentity(dirname(worktreePath), parentIdentity);
    const quarantine = createPrivateQuarantine(worktreePath, quarantineBase);
    try {
        mutationGuard?.();
        assertDirectoryIdentity(worktreePath, expectedIdentity);
        assertDirectoryIdentity(dirname(worktreePath), parentIdentity);
        renameSync(worktreePath, quarantine.path);
        mutationGuard?.();
        assertDirectoryIdentity(quarantine.directory, quarantine.directoryIdentity);
        assertQuarantinedIdentity(quarantine.path, expectedIdentity, "directory");
        if (registrationFence) {
            assertWorktreeRegistrationFenceFileIdentities(
                quarantine.path,
                registrationFence,
            );
        }
        const repaired = spawnSync(
            "git",
            ["worktree", "repair", quarantine.path],
            {
                cwd: sourceRepository,
                encoding: "utf-8",
                stdio: ["pipe", "pipe", "pipe"],
                env: sourceEnvironment,
            },
        );
        mutationGuard?.();
        if (repaired.error || repaired.status !== 0
            || !isValidWorktree(quarantine.path, sourceRepository)) {
            throw new Error((repaired.stderr ?? "").trim() || "git worktree repair failed");
        }
        if (registrationFence) {
            const quarantineIdentity = captureDirectoryIdentity(quarantine.path);
            assertQuarantinedIdentity(
                quarantine.path,
                registrationFence.destinationIdentity,
                "directory",
            );
            assertDirectoryIdentity(
                registrationFence.managementIdentity.realpath,
                registrationFence.managementIdentity,
            );
            if (!expectedBranch || !worktreeRegistrationOwnershipMatches(
                sourceRepository,
                quarantine.path,
                {
                    ...registrationFence,
                    destinationIdentity: quarantineIdentity,
                },
            )) {
                throw new Error(
                    `Worktree registration ownership changed after quarantine: ${worktreePath}`,
                );
            }
        }
        quarantinedContentGuard?.(quarantine.path);
        const args = ["worktree", "remove", quarantine.path];
        if (force) args.push("--force");
        const removed = spawnSync(
            "git",
            args,
            {
                cwd: sourceRepository,
                encoding: "utf-8",
                stdio: ["pipe", "pipe", "pipe"],
                env: sourceEnvironment,
            },
        );
        mutationGuard?.();
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
                if (registrationFence) {
                    assertWorktreeRegistrationFenceFileIdentities(
                        worktreePath,
                        registrationFence,
                    );
                }
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
    options: { allowTrackedGitlinks?: boolean } = {},
): void {
    if (!existsSync(workspacePath)) {
        throw new Error(`Workspace for branch '${expectedBranch}' no longer exists.`);
    }
    if (sourcePath) {
        assertWorkspaceOwnership(workspacePath, sourcePath, options);
    }
    const repositories = branchRepositories(
        workspacePath,
        undefined,
        options,
    );
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
        ["ls-files", "--stage", "--", `:(literal)${entryName}`],
        { cwd: repositoryPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (result.error || result.status !== 0) return false;
    const matches = (result.stdout ?? "")
        .split(/\r?\n/)
        .filter((line) => {
            const match = line.match(/^160000 [0-9a-f]+ 0\t(.+)$/i);
            return match?.[1] === entryName;
        });
    return matches.length === 1;
}

type SubmoduleDeclaration = {
    name: string;
    path: string;
};

function submoduleDeclarations(
    repositoryPath: string,
    strict: boolean,
): SubmoduleDeclaration[] {
    if (!pathExistsStrict(join(repositoryPath, ".gitmodules"))) return [];
    const configured = spawnSync(
        "git",
        [
            "config",
            "--null",
            "--file",
            ".gitmodules",
            "--get-regexp",
            "^submodule\\..*\\.path$",
        ],
        {
            cwd: repositoryPath,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        },
    );
    if (configured.error || (configured.status !== 0 && configured.status !== 1)) {
        if (!strict) return [];
        const detail = (configured.stderr ?? "").trim()
            || configured.error?.message
            || `git exited with status ${String(configured.status)}`;
        throw new Error(
            `Unable to inspect submodule configuration in '${repositoryPath}': ${detail}`,
        );
    }
    if (configured.status === 1) return [];

    const declarations: SubmoduleDeclaration[] = [];
    for (const record of (configured.stdout ?? "").split("\0")) {
        const separator = record.indexOf("\n");
        if (separator < 0) continue;
        const key = record.slice(0, separator);
        const match = key.match(/^submodule\.(.*)\.path$/);
        const name = match
            ? normalizeNestedRepositoryName(match[1])
            : null;
        const path = normalizeNestedRepositoryName(record.slice(separator + 1));
        if (!name || !path) {
            if (strict) {
                throw new Error(
                    `Invalid submodule configuration in '${repositoryPath}'.`,
                );
            }
            continue;
        }
        declarations.push({ name, path });
    }
    return declarations;
}

function trackedSubmoduleGitDirectoryIsOwned(
    parentRepository: string,
    candidateName: string,
    candidatePath: string,
): boolean {
    if (!isTrackedGitlink(parentRepository, candidateName)) return false;
    const declaration = submoduleDeclarations(parentRepository, true)
        .find(({ path }) => path === candidateName);
    if (!declaration) return false;

    const gitDirectory = spawnSync(
        "git",
        ["rev-parse", "--git-dir"],
        {
            cwd: parentRepository,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        },
    );
    const gitDirectoryOutput = (gitDirectory.stdout ?? "").trim();
    if (
        gitDirectory.error
        || gitDirectory.status !== 0
        || !gitDirectoryOutput
    ) return false;

    const expectedGitDirectory = resolve(
        parentRepository,
        gitDirectoryOutput,
        "modules",
        ...declaration.name.split("/"),
    );
    const gitFile = join(candidatePath, ".git");
    const content = readFileSync(gitFile, "utf-8").trim();
    const match = content.match(/^gitdir:\s*(.+)$/);
    if (!match) return false;
    const actualGitDirectory = resolve(dirname(gitFile), match[1].trim());
    try {
        const ownerGitDirectory = resolve(parentRepository, gitDirectoryOutput);
        const ownerGitRealpath = realpathSync(ownerGitDirectory);
        let observedPath = ownerGitDirectory;
        for (const segment of ["modules", ...declaration.name.split("/")]) {
            observedPath = join(observedPath, segment);
            const observed = lstatSync(observedPath);
            if (observed.isSymbolicLink()) return false;
        }
        const expected = lstatSync(expectedGitDirectory);
        if (!expected.isDirectory()) return false;
        const relativeExpected = relative(
            ownerGitRealpath,
            realpathSync(expectedGitDirectory),
        );
        if (relativePathEscapesRoot(relativeExpected)) return false;
        return sameObservedPath(actualGitDirectory, expectedGitDirectory);
    } catch {
        return false;
    }
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
            for (const entry of scanUnifiedNestedRepositories(
                sourcePath,
                { strict: true, allowRegisteredWorktrees: true },
            )) {
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

function primarySourceRepositoryForWorktree(
    worktreePath: string,
): string | null {
    const gitFile = join(worktreePath, ".git");
    if (!pathExistsStrict(gitFile) || gitLinkKind(gitFile) !== "worktree") {
        return null;
    }
    const content = readFileSync(gitFile, "utf-8").trim();
    const match = content.match(/^gitdir:\s*(.+)$/);
    if (!match) return null;
    const worktreeGitDirectory = resolve(
        dirname(gitFile),
        match[1].trim(),
    );
    const commonGitDirectory = resolve(worktreeGitDirectory, "..", "..");
    const listed = spawnSync(
        "git",
        [
            "--git-dir",
            commonGitDirectory,
            "worktree",
            "list",
            "--porcelain",
        ],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (listed.error || listed.status !== 0) return null;
    for (const line of (listed.stdout ?? "").split(/\r?\n/)) {
        if (!line.startsWith("worktree ")) continue;
        const candidate = line.slice("worktree ".length).trim();
        if (!candidate || sameObservedPath(candidate, worktreePath)) continue;
        const candidateGit = join(candidate, ".git");
        if (!pathExistsStrict(candidateGit)) continue;
        const observed = lstatSync(candidateGit);
        if (observed.isFile() && gitLinkKind(candidateGit) === "worktree") {
            continue;
        }
        if (isValidWorktree(worktreePath, candidate)) return candidate;
    }
    return null;
}

function branchRepositories(
    workspacePath: string,
    expectedTopology?: "root" | "children",
    options: { allowTrackedGitlinks?: boolean } = {},
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
        const rootKind = gitLinkKind(rootGit);
        const sourceRoot = rootKind === "worktree"
            ? primarySourceRepositoryForWorktree(workspacePath)
            : null;
        if (rootKind === "worktree" && !sourceRoot) {
            throw new Error(
                `Workspace root source ownership could not be established: ${workspacePath}`,
            );
        }
        const sourceRepositories = sourceRoot
            ? new Map(
                scanUnifiedNestedRepositories(sourceRoot, { strict: true })
                    .filter((entry) => entry.isGitRepo)
                    .map((entry) => [entry.name, entry.path]),
            )
            : null;
        const nestedRepositories = scanUnifiedNestedRepositories(
            workspacePath,
            { strict: true, allowRegisteredWorktrees: true },
        );
        for (const entry of nestedRepositories) {
            if (!entry.isGitRepo) continue;
            const kind = gitLinkKind(join(entry.path, ".git"));
            if (kind === "worktree") {
                const sourceRepository = sourceRepositories?.get(entry.name);
                if (
                    sourceRepositories
                    && (
                        !sourceRepository
                        || !isValidWorktree(entry.path, sourceRepository)
                    )
                ) {
                    throw new Error(
                        `Workspace repository '${entry.name}' is not owned by its source repository.`,
                    );
                }
                repositories.push({ name: entry.name, path: entry.path });
                continue;
            }
            if (kind === "gitlink"
                && isNestedTrackedGitlink(
                    workspacePath,
                    nestedRepositories,
                    entry,
                )) {
                if (options.allowTrackedGitlinks) continue;
                throw new Error(
                    `Workspace tracked submodule '${entry.name}' is not a linked worktree.`,
                );
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

function assertWorkspaceOwnership(
    workspacePath: string,
    sourcePath: string,
    options: { allowTrackedGitlinks?: boolean } = {},
): void {
    const resolvedSource = resolve(sourcePath);
    if (hasGitMetadata(resolvedSource)) {
        assertWorkspaceRootOwnership(workspacePath, resolvedSource);
        const sourceGit = join(resolvedSource, ".git");
        const sourceIsWorktree = lstatSync(sourceGit).isFile()
            && gitLinkKind(sourceGit) === "worktree";
        const sourceRepositories = new Map(
            scanUnifiedNestedRepositories(
                resolvedSource,
                {
                    strict: true,
                    allowRegisteredWorktrees: sourceIsWorktree,
                },
            )
                .filter((entry) => entry.isGitRepo)
                .map((entry) => [entry.name, entry]),
        );
        const sourceRepositoryEntries = [...sourceRepositories.values()];
        for (const source of sourceRepositoryEntries) {
            const destinationGit = join(workspacePath, source.name, ".git");
            if (!pathExistsStrict(destinationGit)
                && !(options.allowTrackedGitlinks && isNestedTrackedGitlink(
                    resolvedSource,
                    sourceRepositoryEntries,
                    source,
                ))) {
                throw new Error(
                    `Workspace repository '${source.name}' is not owned by its source repository.`,
                );
            }
        }
        const destinationRepositories = scanUnifiedNestedRepositories(
            workspacePath,
            { strict: true, allowRegisteredWorktrees: true },
        );
        for (const destination of destinationRepositories) {
            const source = sourceRepositories.get(destination.name);
            if (!source) {
                throw new Error(`Workspace contains unowned Git repository '${destination.name}'.`);
            }
            const kind = gitLinkKind(join(destination.path, ".git"));
            if (kind === "gitlink"
                && isNestedTrackedGitlink(
                    workspacePath,
                    destinationRepositories,
                    destination,
                )) {
                if (options.allowTrackedGitlinks) continue;
                throw new Error(
                    `Workspace tracked submodule '${destination.name}' is not a linked worktree.`,
                );
            }
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

function normalizeNestedRepositoryName(rawName: string): string | null {
    const normalized = rawName.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!normalized) return null;
    const segments = normalized.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
        return null;
    }
    if (segments.some((segment) => segment.includes(":"))) return null;
    return segments.join("/");
}

function relativePathEscapesRoot(relativePath: string): boolean {
    return isAbsolute(relativePath)
        || relativePath === ".."
        || relativePath.split(/[\\/]/)[0] === "..";
}

function nestedRepositoryCandidateIsSafe(
    parentRepository: string,
    candidateName: string,
    candidatePath: string,
    strict: boolean,
    allowRegisteredWorktrees: boolean,
): boolean {
    try {
        const candidate = lstatSync(candidatePath);
        if (!candidate.isDirectory() || candidate.isSymbolicLink()) return false;
        const relativeCandidate = relative(
            realpathSync(parentRepository),
            realpathSync(candidatePath),
        );
        if (relativePathEscapesRoot(relativeCandidate)) {
            throw new Error(
                `Nested Git repository escapes its parent repository: ${candidatePath}`,
            );
        }
        const gitMetadata = lstatSync(join(candidatePath, ".git"));
        if (gitMetadata.isSymbolicLink()) {
            throw new Error(
                `Nested Git repository metadata is a symbolic link: ${candidatePath}`,
            );
        }
        if (gitMetadata.isDirectory()) return true;
        if (!gitMetadata.isFile()) return false;
        const kind = gitLinkKind(join(candidatePath, ".git"));
        if (kind === "worktree" && allowRegisteredWorktrees) return true;
        if (kind === "gitlink"
            && trackedSubmoduleGitDirectoryIsOwned(
                parentRepository,
                candidateName,
                candidatePath,
            )) return true;
        throw new Error(
            `Nested Git repository metadata is not owned by its parent or a registered worktree: ${candidatePath}`,
        );
    } catch (error) {
        if (["ENOENT", "ENOTDIR"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
        )) return false;
        if (!strict) return false;
        if ((error as Error).message.startsWith("Nested Git repository ")) {
            throw error;
        }
        throw new Error(
            `Unable to inspect nested Git repository '${candidatePath}'.`,
            { cause: error },
        );
    }
}

/**
 * Find managed repositories nested below a unified Git root. Tracked
 * submodules are read from .gitmodules; non-ignored untracked repositories are
 * reported by Git without an unrestricted filesystem walk. Ignored paths are
 * deliberately outside CCC worktree management.
 */
function scanUnifiedNestedRepositories(
    repositoryPath: string,
    options: {
        strict?: boolean;
        allowRegisteredWorktrees?: boolean;
    } = {},
): WorkspaceEntry[] {
    const root = resolve(repositoryPath);
    const repositories = new Map<string, WorkspaceEntry>();

    const collect = (
        currentRepository: string,
        relativePrefix: string,
    ): void => {
        const candidates = new Map<string, WorkspaceEntry>();
        const declarations = submoduleDeclarations(
            currentRepository,
            options.strict === true,
        );
        const declaredPaths = new Set(declarations.map(({ path }) => path));
        for (const entry of scanDirectory(currentRepository, options)) {
            if (!entry.isGitRepo) continue;
            if (!declaredPaths.has(entry.name)) {
                const ignored = spawnSync(
                    "git",
                    [
                        "check-ignore",
                        "--quiet",
                        "--no-index",
                        "--",
                        entry.name,
                    ],
                    {
                        cwd: currentRepository,
                        encoding: "utf-8",
                        stdio: ["pipe", "pipe", "pipe"],
                    },
                );
                if (ignored.error || ![0, 1].includes(ignored.status ?? -1)) {
                    if (options.strict) {
                        const detail = (ignored.stderr ?? "").trim()
                            || ignored.error?.message
                            || `git exited with status ${String(ignored.status)}`;
                        throw new Error(
                            `Unable to inspect ignored repository path '${entry.path}': ${detail}`,
                        );
                    }
                    continue;
                }
                if (ignored.status === 0) continue;
            }
            candidates.set(entry.name, entry);
        }

        const declaredNames = declarations.map(({ path }) => path);
        if (declaredNames.length > 0) {
            const tracked = spawnSync(
                "git",
                [
                    "ls-files",
                    "--stage",
                    "-z",
                    "--",
                    ...declaredNames.map((name) => `:(literal)${name}`),
                ],
                {
                    cwd: currentRepository,
                    encoding: "utf-8",
                    stdio: ["pipe", "pipe", "pipe"],
                },
            );
            if (tracked.error || tracked.status !== 0) {
                if (options.strict) {
                    const detail = (tracked.stderr ?? "").trim()
                        || tracked.error?.message
                        || `git exited with status ${String(tracked.status)}`;
                    throw new Error(
                        `Unable to inspect tracked Git links in '${currentRepository}': ${detail}`,
                    );
                }
            } else {
                for (const record of (tracked.stdout ?? "").split("\0")) {
                    if (!record.startsWith("160000 ")) continue;
                    const separator = record.indexOf("\t");
                    if (separator < 0) continue;
                    const name = normalizeNestedRepositoryName(
                        record.slice(separator + 1),
                    );
                    if (!name || candidates.has(name)) continue;
                    const candidatePath = join(currentRepository, ...name.split("/"));
                    if (!pathExistsStrict(join(candidatePath, ".git"))) {
                        if (options.strict) {
                            throw new Error(
                                `Tracked submodule repository is not initialized: ${candidatePath}`,
                            );
                        }
                        continue;
                    }
                    candidates.set(name, {
                        name,
                        path: candidatePath,
                        isGitRepo: true,
                    });
                }
            }
        }

        const candidateCommands = [[
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            ":(glob)**/.git",
            ":(glob)**/.git/**",
        ]];
        for (const args of candidateCommands) {
            const listed = spawnSync(
                "git",
                args,
                {
                    cwd: currentRepository,
                    encoding: "utf-8",
                    stdio: ["pipe", "pipe", "pipe"],
                },
            );
            if (listed.error || listed.status !== 0) {
                if (!options.strict) continue;
                const detail = (listed.stderr ?? "").trim()
                    || listed.error?.message
                    || `git exited with status ${String(listed.status)}`;
                throw new Error(
                    `Unable to inspect nested Git repositories in '${currentRepository}': ${detail}`,
                );
            }
            for (const rawName of (listed.stdout ?? "").split("\0")) {
                const name = normalizeNestedRepositoryName(rawName);
                if (!name || candidates.has(name)) continue;
                const candidatePath = join(currentRepository, ...name.split("/"));
                candidates.set(name, {
                    name,
                    path: candidatePath,
                    isGitRepo: true,
                });
            }
        }

        for (const candidate of [...candidates.values()]
            .sort((left, right) => left.name.localeCompare(right.name))) {
            if (!nestedRepositoryCandidateIsSafe(
                currentRepository,
                candidate.name,
                candidate.path,
                options.strict === true,
                options.allowRegisteredWorktrees === true,
            )) continue;
            const name = relativePrefix
                ? `${relativePrefix}/${candidate.name}`
                : candidate.name;
            const key = process.platform === "win32" ? name.toLowerCase() : name;
            if (repositories.has(key)) continue;
            const nested = { ...candidate, name };
            repositories.set(key, nested);
            collect(candidate.path, name);
        }
    };

    collect(root, "");
    return [...repositories.values()].sort((left, right) => (
        left.name.split("/").length - right.name.split("/").length
        || left.name.localeCompare(right.name)
    ));
}

type NestedRepositoryIdentity = {
    directory: DirectoryIdentity;
    gitMetadata: DirectoryIdentity;
    gitFileContent: string | null;
    gitDirectory: DirectoryIdentity;
    commonDirectory: DirectoryIdentity;
    commonDirectoryFile: {
        identity: FileIdentity;
        content: string;
    } | null;
};

function captureNestedRepositoryIdentity(
    repositoryPath: string,
): NestedRepositoryIdentity {
    const gitMetadataPath = join(repositoryPath, ".git");
    const gitMetadata = capturePathIdentity(gitMetadataPath);
    const metadataObserved = lstatSync(gitMetadataPath);
    let gitFileContent: string | null = null;
    let gitDirectoryPath = gitMetadataPath;
    if (metadataObserved.isFile()) {
        gitFileContent = readFileSync(gitMetadataPath, "utf-8");
        const match = gitFileContent.trim().match(/^gitdir:\s*(.+)$/);
        if (!match) {
            throw new Error(`Nested Git repository metadata is invalid: ${repositoryPath}`);
        }
        gitDirectoryPath = resolve(repositoryPath, match[1].trim());
    }
    const gitDirectory = captureDirectoryIdentity(gitDirectoryPath);
    const commonDirectoryPath = join(gitDirectoryPath, "commondir");
    let commonDirectoryFile: NestedRepositoryIdentity["commonDirectoryFile"] = null;
    let resolvedCommonDirectory = gitDirectoryPath;
    if (pathExistsStrict(commonDirectoryPath)) {
        commonDirectoryFile = {
            identity: captureFileIdentity(commonDirectoryPath),
            content: readFileSync(commonDirectoryPath, "utf-8"),
        };
        const commonDirectoryValue = commonDirectoryFile.content.trim();
        if (!commonDirectoryValue) {
            throw new Error(`Nested Git repository common directory is invalid: ${repositoryPath}`);
        }
        resolvedCommonDirectory = resolve(gitDirectoryPath, commonDirectoryValue);
    }
    return {
        directory: captureDirectoryIdentity(repositoryPath),
        gitMetadata,
        gitFileContent,
        gitDirectory,
        commonDirectory: captureDirectoryIdentity(resolvedCommonDirectory),
        commonDirectoryFile,
    };
}

function assertNestedRepositoryIdentity(
    repositoryPath: string,
    identity: NestedRepositoryIdentity,
): void {
    assertDirectoryIdentity(repositoryPath, identity.directory);
    const gitMetadataPath = join(repositoryPath, ".git");
    assertPathIdentity(gitMetadataPath, identity.gitMetadata);
    let gitDirectoryPath = gitMetadataPath;
    if (identity.gitFileContent !== null) {
        const currentContent = readFileSync(gitMetadataPath, "utf-8");
        if (currentContent !== identity.gitFileContent) {
            throw new Error(`Nested Git repository metadata changed: ${repositoryPath}`);
        }
        const match = currentContent.trim().match(/^gitdir:\s*(.+)$/);
        if (!match) {
            throw new Error(`Nested Git repository metadata changed: ${repositoryPath}`);
        }
        gitDirectoryPath = resolve(repositoryPath, match[1].trim());
    }
    assertDirectoryIdentity(gitDirectoryPath, identity.gitDirectory);
    let resolvedCommonDirectory = gitDirectoryPath;
    if (identity.commonDirectoryFile) {
        const commonDirectoryPath = join(gitDirectoryPath, "commondir");
        assertFileIdentity(
            commonDirectoryPath,
            identity.commonDirectoryFile.identity,
        );
        const currentContent = readFileSync(commonDirectoryPath, "utf-8");
        if (currentContent !== identity.commonDirectoryFile.content) {
            throw new Error(`Nested Git repository common directory changed: ${repositoryPath}`);
        }
        resolvedCommonDirectory = resolve(gitDirectoryPath, currentContent.trim());
    } else if (pathExistsStrict(join(gitDirectoryPath, "commondir"))) {
        throw new Error(`Nested Git repository common directory changed: ${repositoryPath}`);
    }
    assertDirectoryIdentity(resolvedCommonDirectory, identity.commonDirectory);
}

function withPinnedNestedRepository<T>(
    identity: NestedRepositoryIdentity,
    operation: () => T,
): T {
    const previousGitDir = process.env.GIT_DIR;
    const previousWorkTree = process.env.GIT_WORK_TREE;
    process.env.GIT_DIR = identity.gitDirectory.realpath;
    process.env.GIT_WORK_TREE = identity.directory.realpath;
    try {
        return operation();
    } finally {
        if (previousGitDir === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = previousGitDir;
        if (previousWorkTree === undefined) delete process.env.GIT_WORK_TREE;
        else process.env.GIT_WORK_TREE = previousWorkTree;
    }
}

function pinnedNestedRepositoryEnvironment(
    identity: NestedRepositoryIdentity,
): NodeJS.ProcessEnv {
    return {
        ...process.env,
        GIT_DIR: identity.gitDirectory.realpath,
        GIT_WORK_TREE: identity.directory.realpath,
    };
}

function isNestedTrackedGitlink(
    repositoryRoot: string,
    repositories: WorkspaceEntry[],
    entry: WorkspaceEntry,
): boolean {
    const parent = repositories
        .filter((candidate) => (
            candidate.name !== entry.name
            && entry.name.startsWith(`${candidate.name}/`)
        ))
        .sort((left, right) => right.name.length - left.name.length)[0];
    const ownerPath = parent?.path ?? repositoryRoot;
    const relativeName = parent
        ? entry.name.slice(parent.name.length + 1)
        : entry.name;
    return isTrackedGitlink(ownerPath, relativeName);
}

function ensureNestedWorktreeParent(
    workspacePath: string,
    destinationPath: string,
    createdParents: Map<string, DirectoryIdentity>,
    createMissing = true,
): {
    workspace: DirectoryIdentity;
    parents: Array<{ path: string; identity: DirectoryIdentity }>;
} {
    const workspace = captureDirectoryIdentity(workspacePath);
    const workspaceRoot = workspace.realpath;
    const parents: Array<{ path: string; identity: DirectoryIdentity }> = [];
    const relativeDestination = relative(workspacePath, destinationPath);
    const segments = relativeDestination.split(/[\\/]/);
    if (!relativeDestination || relativePathEscapesRoot(relativeDestination)
        || segments.some((segment) => !segment || segment === "." || segment === "..")) {
        throw new Error(`Nested worktree destination escapes its workspace: ${destinationPath}`);
    }

    let current = workspacePath;
    for (const segment of segments.slice(0, -1)) {
        current = join(current, segment);
        assertDirectoryIdentity(workspacePath, workspace);
        for (const parent of parents) {
            assertDirectoryIdentity(parent.path, parent.identity);
        }
        if (!pathExistsStrict(current)) {
            if (!createMissing) {
                throw new Error(`Nested worktree parent is missing: ${current}`);
            }
            mkdirSync(current);
            assertDirectoryIdentity(workspacePath, workspace);
            for (const parent of parents) {
                assertDirectoryIdentity(parent.path, parent.identity);
            }
            createdParents.set(current, captureDirectoryIdentity(current));
        }
        const observed = lstatSync(current);
        if (!observed.isDirectory() || observed.isSymbolicLink()) {
            throw new Error(`Nested worktree parent is not a safe directory: ${current}`);
        }
        const relativeObserved = relative(workspaceRoot, realpathSync(current));
        if (relativePathEscapesRoot(relativeObserved)) {
            throw new Error(`Nested worktree parent escapes its workspace: ${current}`);
        }
        parents.push({
            path: current,
            identity: captureDirectoryIdentity(current),
        });
        assertDirectoryIdentity(workspacePath, workspace);
        for (const parent of parents) {
            assertDirectoryIdentity(parent.path, parent.identity);
        }
    }
    return { workspace, parents };
}

function assertNestedWorktreeDestinationFence(
    workspacePath: string,
    destinationPath: string,
    fence: {
        workspace: DirectoryIdentity;
        parents: Array<{ path: string; identity: DirectoryIdentity }>;
    },
): void {
    assertDirectoryIdentity(workspacePath, fence.workspace);
    for (const parent of fence.parents) {
        assertDirectoryIdentity(parent.path, parent.identity);
        if (relativePathEscapesRoot(
            relative(fence.workspace.realpath, realpathSync(parent.path)),
        )) {
            throw new Error(`Nested worktree parent escaped its workspace: ${parent.path}`);
        }
    }
    if (!pathExistsStrict(destinationPath)) return;
    const destination = lstatSync(destinationPath);
    if (!destination.isDirectory() || destination.isSymbolicLink()
        || relativePathEscapesRoot(relative(
            fence.workspace.realpath,
            realpathSync(destinationPath),
        ))) {
        throw new Error(`Nested worktree destination escaped its workspace: ${destinationPath}`);
    }
}

/**
 * Check if a branch exists locally or on remote in a git repo.
 * Uses refs/heads/ and refs/remotes/origin/ to match only branches (not tags/commits).
 * Returns "local" | "remote" | "none"
 */
export function branchExistsInRepo(
    repoPath: string,
    branch: string,
    runner: typeof spawnSync = spawnSync,
): "local" | "remote" | "none" {
    const exactRefExists = (ref: string, description: string): boolean => {
        const result = runner(
            "git",
            ["show-ref", "--quiet", "--verify", "--", ref],
            { cwd: repoPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        );
        if (!result.error && result.status === 0) return true;
        if (!result.error && result.status === 1) return false;
        const failure = result.error
            ? `spawn-${(result.error as NodeJS.ErrnoException).code || "error"}`
            : `exit-${String(result.status)}`;
        throw new Error(`Unable to inspect ${description} branch '${branch}' (${failure}).`);
    };

    // show-ref --verify uses a full ref and reports an absent ref as status 1
    // on every supported Git version, including Git for Windows.
    if (exactRefExists(`refs/heads/${branch}`, "local")) {
        return "local";
    }

    if (exactRefExists(`refs/remotes/origin/${branch}`, "remote")) {
        return "remote";
    }

    return "none";
}
function expectedFailedCreationBranchOid(
    repositoryPath: string,
    branch: string,
    action: WorktreeRepoResult["action"],
): string {
    const sourceRef = action === "worktree-existing"
        ? `refs/heads/${branch}^{commit}`
        : action === "worktree-remote"
            ? `refs/remotes/origin/${branch}^{commit}`
            : "HEAD^{commit}";
    const resolved = spawnSync(
        "git",
        ["rev-parse", "--verify", sourceRef],
        { cwd: repositoryPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const oid = (resolved.stdout ?? "").trim();
    if (resolved.error || resolved.status !== 0 || !/^[a-f0-9]{40,64}$/i.test(oid)) {
        throw new Error(`Unable to snapshot branch creation source for '${branch}'.`);
    }
    return oid;
}

type BranchTrackingConfig = {
    remote: string[];
    merge: string[];
    rebase: string[];
};

type BranchCreationFence = {
    expectedOid: string;
    configBefore: BranchTrackingConfig;
    configAfter: BranchTrackingConfig;
};

function readBranchTrackingConfig(
    repositoryPath: string,
    branch: string,
    configFile?: string,
): BranchTrackingConfig {
    const readValues = (suffix: keyof BranchTrackingConfig): string[] => {
        const result = spawnSync(
            "git",
            [
                "config",
                ...(configFile ? ["--file", configFile] : ["--local"]),
                "--get-all",
                `branch.${branch}.${suffix}`,
            ],
            { cwd: repositoryPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        );
        if (result.error || (result.status !== 0 && result.status !== 1)) {
            throw new Error(`Unable to inspect branch tracking configuration for '${branch}'.`);
        }
        if (result.status === 1) return [];
        return (result.stdout ?? "").replace(/\r?\n$/, "").split(/\r?\n/);
    };
    return {
        remote: readValues("remote"),
        merge: readValues("merge"),
        rebase: readValues("rebase"),
    };
}

function sameBranchTrackingConfig(
    left: BranchTrackingConfig,
    right: BranchTrackingConfig,
): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function replaceBranchTrackingConfig(
    repositoryPath: string,
    branch: string,
    expected: BranchTrackingConfig,
    replacement: BranchTrackingConfig,
    beforeCommit: () => void = () => {},
): void {
    const commonDirResult = spawnSync(
        "git",
        ["rev-parse", "--git-common-dir"],
        { cwd: repositoryPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (commonDirResult.error || commonDirResult.status !== 0) {
        throw new Error(`Unable to locate Git configuration for '${branch}'.`);
    }
    const commonDir = resolve(repositoryPath, (commonDirResult.stdout ?? "").trim());
    const commonDirIdentity = captureDirectoryIdentity(commonDir);
    const configPath = join(commonDir, "config");
    const configIdentity = capturePathIdentity(configPath);
    const lockPath = `${configPath}.lock`;
    let lockCreated = false;
    try {
        assertDirectoryIdentity(commonDir, commonDirIdentity);
        const lockFd = openSync(lockPath, "wx", 0o600);
        lockCreated = true;
        closeSync(lockFd);
        if (!sameBranchTrackingConfig(
            readBranchTrackingConfig(repositoryPath, branch, configPath),
            expected,
        )) {
            throw new Error(
                `Branch '${branch}' tracking configuration changed; preserving it.`,
            );
        }
        copyFileSync(configPath, lockPath);
        for (const suffix of ["remote", "merge", "rebase"] as const) {
            const key = `branch.${branch}.${suffix}`;
            const unset = spawnSync(
                "git",
                ["config", "--file", lockPath, "--unset-all", key],
                { cwd: repositoryPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
            );
            if (unset.error || (unset.status !== 0 && unset.status !== 5)) {
                throw new Error(`Failed to clear branch tracking configuration for '${branch}'.`);
            }
            for (const value of replacement[suffix]) {
                const restored = spawnSync(
                    "git",
                    ["config", "--file", lockPath, "--add", key, value],
                    { cwd: repositoryPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
                );
                if (restored.error || restored.status !== 0) {
                    throw new Error(
                        `Failed to restore branch tracking configuration for '${branch}'.`,
                    );
                }
            }
        }
        assertDirectoryIdentity(commonDir, commonDirIdentity);
        if (!sameBranchTrackingConfig(
            readBranchTrackingConfig(repositoryPath, branch, configPath),
            expected,
        )) {
            throw new Error(
                `Branch '${branch}' tracking configuration changed; preserving it.`,
            );
        }
        beforeCommit();
        assertPathIdentity(configPath, configIdentity);
        renameSync(lockPath, configPath);
        lockCreated = false;
    } finally {
        if (lockCreated) unlinkSync(lockPath);
    }
}

function rollbackFailedCreatedBranch(
    repositoryPath: string,
    branch: string,
    action: WorktreeRepoResult["action"],
    fence: BranchCreationFence | null,
): void {
    if (action === "worktree-existing") return;
    if (!fence) {
        throw new Error(`Missing branch ownership snapshot for '${branch}'.`);
    }
    const { expectedOid } = fence;
    const ref = `refs/heads/${branch}`;
    const current = spawnSync(
        "git",
        ["rev-parse", "--verify", "--quiet", ref],
        { cwd: repositoryPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (current.error || current.status === null) {
        throw new Error(`Unable to inspect branch '${branch}' during rollback.`);
    }
    if (current.status === 1) {
        replaceBranchTrackingConfig(
            repositoryPath,
            branch,
            fence.configAfter,
            fence.configBefore,
        );
        return;
    }
    if (current.status !== 0) {
        throw new Error(`Unable to inspect branch '${branch}' during rollback.`);
    }
    const currentOid = (current.stdout ?? "").trim();
    if (currentOid !== expectedOid) {
        throw new Error(
            `Branch '${branch}' changed during failed creation; preserving ref ${currentOid || "<unknown>"}.`,
        );
    }
    replaceBranchTrackingConfig(
        repositoryPath,
        branch,
        fence.configAfter,
        fence.configBefore,
        () => {
            const removed = spawnSync(
                "git",
                ["update-ref", "-d", ref, expectedOid],
                { cwd: repositoryPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
            );
            const remaining = spawnSync(
                "git",
                ["rev-parse", "--verify", "--quiet", ref],
                { cwd: repositoryPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
            );
            if (removed.error || removed.status !== 0
                || remaining.error || remaining.status !== 1) {
                throw new Error(`Failed to roll back branch '${branch}' by exact ref identity.`);
            }
        },
    );
}

function registeredWorktreePath(
    repositoryPath: string,
    worktreePath: string,
): boolean {
    const listed = spawnSync(
        "git",
        ["worktree", "list", "--porcelain"],
        { cwd: repositoryPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (listed.error || listed.status !== 0) {
        throw new Error(`Unable to inspect worktree registry for rollback: ${repositoryPath}`);
    }
    return (listed.stdout ?? "")
        .split(/\r?\n/)
        .filter((line) => line.startsWith("worktree "))
        .some((line) => sameObservedPath(
            line.slice("worktree ".length).trim(),
            worktreePath,
        ));
}

type WorktreeRegistrationFence = {
    destinationIdentity: DirectoryIdentity;
    managementIdentity: DirectoryIdentity;
    worktreeGitFileIdentity: FileIdentity;
    managementGitdirIdentity: FileIdentity;
    managementHeadIdentity: FileIdentity;
    expectedOid: string;
    expectedRef: string;
};

type MissingWorktreeRegistrationFence = {
    managementIdentity: DirectoryIdentity;
    managementGitdirIdentity: FileIdentity;
    managementHeadIdentity: FileIdentity;
    expectedOid: string;
    expectedRef: string;
};

type QuarantinedMissingWorktreeRegistration = {
    fence: MissingWorktreeRegistrationFence;
    location: QuarantineLocation;
    parentIdentity: DirectoryIdentity;
};

function requireWorktreeRegistrationFence(
    fence: WorktreeRegistrationFence | null,
    worktreePath: string,
): WorktreeRegistrationFence {
    if (!fence) {
        throw new Error(`Missing worktree registration ownership fence: ${worktreePath}`);
    }
    return fence;
}

function captureWorktreeManagementIdentity(
    worktreePath: string,
): DirectoryIdentity {
    const content = readFileSync(join(worktreePath, ".git"), "utf-8").trim();
    const match = content.match(/^gitdir:\s*(.+)$/);
    if (!match) {
        throw new Error(`Worktree registration metadata is invalid: ${worktreePath}`);
    }
    return captureDirectoryIdentity(resolve(worktreePath, match[1].trim()));
}

function worktreeManagementBackpointersMatch(
    worktreePath: string,
    fence: WorktreeRegistrationFence,
): boolean {
    try {
        assertDirectoryIdentity(fence.managementIdentity.realpath, fence.managementIdentity);
        const gitFile = join(worktreePath, ".git");
        assertFileIdentity(gitFile, fence.worktreeGitFileIdentity);
        const content = readFileSync(gitFile, "utf-8").trim();
        const match = content.match(/^gitdir:\s*(.+)$/);
        if (!match) return false;
        const resolvedManagement = resolve(worktreePath, match[1].trim());
        assertDirectoryIdentity(resolvedManagement, fence.managementIdentity);
        const managementGitdir = join(fence.managementIdentity.realpath, "gitdir");
        const managementHead = join(fence.managementIdentity.realpath, "HEAD");
        assertFileIdentity(managementGitdir, fence.managementGitdirIdentity);
        assertFileIdentity(managementHead, fence.managementHeadIdentity);
        const registeredGitFile = readFileSync(
            managementGitdir,
            "utf-8",
        ).trim();
        const managedHead = readFileSync(
            managementHead,
            "utf-8",
        ).trim();
        if (!sameObservedPath(registeredGitFile, gitFile)
            || managedHead !== `ref: ${fence.expectedRef}`) {
            return false;
        }
        assertFileIdentity(gitFile, fence.worktreeGitFileIdentity);
        assertFileIdentity(managementGitdir, fence.managementGitdirIdentity);
        assertFileIdentity(managementHead, fence.managementHeadIdentity);
        assertDirectoryIdentity(fence.managementIdentity.realpath, fence.managementIdentity);
        assertDirectoryIdentity(resolvedManagement, fence.managementIdentity);
        return true;
    } catch {
        return false;
    }
}

function assertWorktreeRegistrationFenceFileIdentities(
    worktreePath: string,
    fence: WorktreeRegistrationFence,
): void {
    assertFileIdentity(join(worktreePath, ".git"), fence.worktreeGitFileIdentity);
    assertFileIdentity(
        join(fence.managementIdentity.realpath, "gitdir"),
        fence.managementGitdirIdentity,
    );
    assertFileIdentity(
        join(fence.managementIdentity.realpath, "HEAD"),
        fence.managementHeadIdentity,
    );
    assertDirectoryIdentity(fence.managementIdentity.realpath, fence.managementIdentity);
}

function refreshWorktreeRegistrationFenceFileIdentities(
    worktreePath: string,
    fence: WorktreeRegistrationFence,
): WorktreeRegistrationFence {
    assertDirectoryIdentity(worktreePath, fence.destinationIdentity);
    assertDirectoryIdentity(fence.managementIdentity.realpath, fence.managementIdentity);
    const gitFile = join(worktreePath, ".git");
    const content = readFileSync(gitFile, "utf-8").trim();
    const match = content.match(/^gitdir:\s*(.+)$/);
    if (!match) {
        throw new Error(`Worktree registration metadata is invalid: ${worktreePath}`);
    }
    assertDirectoryIdentity(
        resolve(worktreePath, match[1].trim()),
        fence.managementIdentity,
    );
    const managementGitdir = join(fence.managementIdentity.realpath, "gitdir");
    const managementHead = join(fence.managementIdentity.realpath, "HEAD");
    if (!sameObservedPath(
        readFileSync(managementGitdir, "utf-8").trim(),
        gitFile,
    ) || readFileSync(managementHead, "utf-8").trim() !== `ref: ${fence.expectedRef}`) {
        throw new Error(`Worktree registration backpointer changed: ${worktreePath}`);
    }
    const refreshed = {
        ...fence,
        worktreeGitFileIdentity: captureFileIdentity(gitFile),
        managementGitdirIdentity: captureFileIdentity(managementGitdir),
        managementHeadIdentity: captureFileIdentity(managementHead),
    };
    if (!worktreeManagementBackpointersMatch(worktreePath, refreshed)) {
        throw new Error(`Worktree registration changed while refreshing metadata: ${worktreePath}`);
    }
    return refreshed;
}

function refreshMissingWorktreeRegistrationFenceFileIdentities(
    repositoryPath: string,
    worktreePath: string,
    fence: WorktreeRegistrationFence,
): WorktreeRegistrationFence {
    const managementGitdir = join(fence.managementIdentity.realpath, "gitdir");
    const managementHead = join(fence.managementIdentity.realpath, "HEAD");
    assertDirectoryIdentity(fence.managementIdentity.realpath, fence.managementIdentity);
    if (!sameObservedPath(
        readFileSync(managementGitdir, "utf-8").trim(),
        join(worktreePath, ".git"),
    ) || readFileSync(managementHead, "utf-8").trim() !== `ref: ${fence.expectedRef}`) {
        throw new Error(`Missing worktree registration backpointer changed: ${worktreePath}`);
    }
    const refreshed = {
        ...fence,
        managementGitdirIdentity: captureFileIdentity(managementGitdir),
        managementHeadIdentity: captureFileIdentity(managementHead),
    };
    if (!missingWorktreeManagementMatches(repositoryPath, worktreePath, refreshed)) {
        throw new Error(`Missing worktree registration changed: ${worktreePath}`);
    }
    return refreshed;
}

function missingWorktreeManagementMatches(
    repositoryPath: string,
    worktreePath: string,
    fence: MissingWorktreeRegistrationFence,
): boolean {
    try {
        assertDirectoryIdentity(fence.managementIdentity.realpath, fence.managementIdentity);
        const managementGitdir = join(fence.managementIdentity.realpath, "gitdir");
        const managementHead = join(fence.managementIdentity.realpath, "HEAD");
        assertFileIdentity(managementGitdir, fence.managementGitdirIdentity);
        assertFileIdentity(managementHead, fence.managementHeadIdentity);
        const registeredGitFile = readFileSync(
            managementGitdir,
            "utf-8",
        ).trim();
        const managedHead = readFileSync(
            managementHead,
            "utf-8",
        ).trim();
        if (!sameObservedPath(registeredGitFile, join(worktreePath, ".git"))
            || managedHead !== `ref: ${fence.expectedRef}`) {
            return false;
        }
        const branchHead = spawnSync(
            "git",
            ["rev-parse", "--verify", "--quiet", `${fence.expectedRef}^{commit}`],
            { cwd: repositoryPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        );
        if (branchHead.error || branchHead.status !== 0
            || (branchHead.stdout ?? "").trim() !== fence.expectedOid) {
            return false;
        }
        const common = spawnSync(
            "git",
            ["rev-parse", "--git-common-dir"],
            { cwd: repositoryPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        );
        if (common.error || common.status !== 0) return false;
        const managementRoot = join(
            resolve(repositoryPath, (common.stdout ?? "").trim()),
            "worktrees",
        );
        const matches = readdirSync(managementRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
            .map((entry) => join(managementRoot, entry.name))
            .filter((candidate) => {
                try {
                    return sameObservedPath(
                        readFileSync(join(candidate, "gitdir"), "utf-8").trim(),
                        join(worktreePath, ".git"),
                    );
                } catch {
                    return false;
                }
            });
        if (matches.length !== 1) return false;
        assertDirectoryIdentity(matches[0], fence.managementIdentity);
        const registryMatches = worktreeRegistryEntryMatches(
            repositoryPath,
            worktreePath,
            fence.expectedRef,
            fence.expectedOid,
        );
        assertFileIdentity(managementGitdir, fence.managementGitdirIdentity);
        assertFileIdentity(managementHead, fence.managementHeadIdentity);
        assertDirectoryIdentity(fence.managementIdentity.realpath, fence.managementIdentity);
        return registryMatches;
    } catch {
        return false;
    }
}

function captureExistingWorktreeRegistrationFence(
    repositoryPath: string,
    worktreePath: string,
    branch: string,
    expectedDestinationIdentity?: DirectoryIdentity,
): WorktreeRegistrationFence {
    const destinationIdentity = captureDirectoryIdentity(worktreePath);
    if (expectedDestinationIdentity) {
        assertDirectoryIdentity(worktreePath, expectedDestinationIdentity);
    }
    const head = spawnSync(
        "git",
        ["rev-parse", "--verify", "HEAD^{commit}"],
        { cwd: worktreePath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (head.error || head.status !== 0) {
        throw new Error(`Unable to capture worktree HEAD ownership: ${worktreePath}`);
    }
    const managementIdentity = captureWorktreeManagementIdentity(worktreePath);
    const fence: WorktreeRegistrationFence = {
        destinationIdentity,
        managementIdentity,
        worktreeGitFileIdentity: captureFileIdentity(join(worktreePath, ".git")),
        managementGitdirIdentity: captureFileIdentity(join(managementIdentity.realpath, "gitdir")),
        managementHeadIdentity: captureFileIdentity(join(managementIdentity.realpath, "HEAD")),
        expectedOid: (head.stdout ?? "").trim(),
        expectedRef: `refs/heads/${branch}`,
    };
    if (!worktreeRegistrationMatches(
        repositoryPath,
        worktreePath,
        branch,
        fence.expectedOid,
        fence,
    )) {
        throw new Error(`Worktree registration ownership changed before deletion: ${worktreePath}`);
    }
    return fence;
}

function captureMissingWorktreeRegistrationFence(
    repositoryPath: string,
    worktreePath: string,
    branch: string,
): MissingWorktreeRegistrationFence | null {
    const expectedRef = `refs/heads/${branch}`;
    const listed = spawnSync(
        "git",
        ["worktree", "list", "--porcelain"],
        { cwd: repositoryPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (listed.error || listed.status !== 0) {
        throw new Error(`Unable to inspect stale worktree registration: ${worktreePath}`);
    }
    const records = (listed.stdout ?? "")
        .split(/\r?\n\r?\n/)
        .filter((block) => {
            const worktreeLine = block
                .split(/\r?\n/)
                .find((line) => line.startsWith("worktree "));
            return worktreeLine !== undefined
                && sameObservedPath(
                    worktreeLine.slice("worktree ".length).trim(),
                    worktreePath,
                );
        });
    if (records.length === 0) return null;
    if (records.length !== 1) {
        throw new Error(`Ambiguous stale worktree registration: ${worktreePath}`);
    }
    const lines = records[0].split(/\r?\n/);
    const branchLine = lines.find((line) => line.startsWith("branch "));
    const headLine = lines.find((line) => line.startsWith("HEAD "));
    if (branchLine !== `branch ${expectedRef}` || !headLine) {
        throw new Error(`Stale worktree registration belongs to another branch: ${worktreePath}`);
    }
    const expectedOid = headLine.slice("HEAD ".length).trim();
    const branchHead = spawnSync(
        "git",
        ["rev-parse", "--verify", "--quiet", `${expectedRef}^{commit}`],
        { cwd: repositoryPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (branchHead.error || branchHead.status !== 0
        || (branchHead.stdout ?? "").trim() !== expectedOid) {
        throw new Error(`Stale worktree branch ownership changed: ${worktreePath}`);
    }
    const common = spawnSync(
        "git",
        ["rev-parse", "--git-common-dir"],
        { cwd: repositoryPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (common.error || common.status !== 0) {
        throw new Error(`Unable to inspect worktree management root: ${repositoryPath}`);
    }
    const commonDirectory = resolve(repositoryPath, (common.stdout ?? "").trim());
    const commonIdentity = captureDirectoryIdentity(commonDirectory);
    const managementRoot = join(commonDirectory, "worktrees");
    const managementRootIdentity = captureDirectoryIdentity(managementRoot);
    const matches: DirectoryIdentity[] = [];
    for (const entry of readdirSync(managementRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const candidate = join(managementRoot, entry.name);
        const gitdirPath = join(candidate, "gitdir");
        try {
            const registeredGitFile = readFileSync(gitdirPath, "utf-8").trim();
            if (sameObservedPath(registeredGitFile, join(worktreePath, ".git"))) {
                matches.push(captureDirectoryIdentity(candidate));
            }
        } catch {
            // A malformed unrelated registration cannot own this exact path.
        }
    }
    assertDirectoryIdentity(commonDirectory, commonIdentity);
    assertDirectoryIdentity(managementRoot, managementRootIdentity);
    if (matches.length !== 1) {
        throw new Error(`Unable to prove stale worktree management ownership: ${worktreePath}`);
    }
    const fence = {
        managementIdentity: matches[0],
        managementGitdirIdentity: captureFileIdentity(join(matches[0].realpath, "gitdir")),
        managementHeadIdentity: captureFileIdentity(join(matches[0].realpath, "HEAD")),
        expectedOid,
        expectedRef,
    };
    if (!missingWorktreeManagementMatches(repositoryPath, worktreePath, fence)) {
        throw new Error(`Stale worktree registration changed during inspection: ${worktreePath}`);
    }
    return fence;
}

function quarantineMissingWorktreeRegistration(
    repositoryPath: string,
    worktreePath: string,
    fence: MissingWorktreeRegistrationFence,
): QuarantinedMissingWorktreeRegistration {
    if (!missingWorktreeManagementMatches(repositoryPath, worktreePath, fence)) {
        throw new Error(`Stale worktree registration changed before deletion: ${worktreePath}`);
    }
    const parentIdentity = captureDirectoryIdentity(
        dirname(fence.managementIdentity.realpath),
    );
    const location = createPrivateQuarantine(
        fence.managementIdentity.realpath,
        dirname(fence.managementIdentity.realpath),
    );
    let renamed = false;
    try {
        if (!missingWorktreeManagementMatches(repositoryPath, worktreePath, fence)) {
            throw new Error(`Stale worktree registration changed before quarantine: ${worktreePath}`);
        }
        assertDirectoryIdentity(fence.managementIdentity.realpath, fence.managementIdentity);
        assertFileIdentity(
            join(fence.managementIdentity.realpath, "gitdir"),
            fence.managementGitdirIdentity,
        );
        assertFileIdentity(
            join(fence.managementIdentity.realpath, "HEAD"),
            fence.managementHeadIdentity,
        );
        assertDirectoryIdentity(dirname(fence.managementIdentity.realpath), parentIdentity);
        renameSync(fence.managementIdentity.realpath, location.path);
        renamed = true;
        assertQuarantinedIdentity(location.path, fence.managementIdentity, "directory");
        if (registeredWorktreePath(repositoryPath, worktreePath)) {
            throw new Error(`Failed to remove stale worktree registration: ${worktreePath}`);
        }
        return { fence, location, parentIdentity };
    } catch (error) {
        if (renamed) {
            try {
                rollbackQuarantinedPath(
                    fence.managementIdentity.realpath,
                    location,
                    fence.managementIdentity,
                    parentIdentity,
                    "directory",
                );
            } catch (rollbackError) {
                throw new Error(
                    `${(error as Error).message}; stale registration rollback failed: ${(rollbackError as Error).message}`,
                    { cause: error },
                );
            }
        } else {
            removePrivateQuarantine(location);
        }
        throw error;
    }
}

function restoreQuarantinedMissingWorktreeRegistration(
    registration: QuarantinedMissingWorktreeRegistration,
): void {
    const restored = rollbackQuarantinedPath(
        registration.fence.managementIdentity.realpath,
        registration.location,
        registration.fence.managementIdentity,
        registration.parentIdentity,
        "directory",
    );
    if (!restored) {
        throw new Error("Failed to restore stale worktree registration.");
    }
}

function commitQuarantinedMissingWorktreeRegistration(
    registration: QuarantinedMissingWorktreeRegistration,
): void {
    assertDirectoryIdentity(
        registration.location.directory,
        registration.location.directoryIdentity,
    );
    assertQuarantinedIdentity(
        registration.location.path,
        registration.fence.managementIdentity,
        "directory",
    );
    rmSync(registration.location.path, { recursive: true, force: true });
    if (pathExistsStrict(registration.location.path)) {
        throw new Error("Failed to remove quarantined stale worktree registration.");
    }
    removePrivateQuarantine(registration.location);
}

function worktreeRegistryEntryMatches(
    repositoryPath: string,
    worktreePath: string,
    expectedRef: string,
    expectedOid: string,
    allowMissingRefOid = false,
): boolean {
    const listed = spawnSync(
        "git",
        ["worktree", "list", "--porcelain"],
        { cwd: repositoryPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (listed.status !== 0) return false;
    const matches = (listed.stdout ?? "")
        .split(/\r?\n\r?\n/)
        .filter((block) => {
                const lines = block.split(/\r?\n/);
                const worktreeLine = lines.find((line) => line.startsWith("worktree "));
                const branchLine = lines.find((line) => line.startsWith("branch "));
                const headLine = lines.find((line) => line.startsWith("HEAD "));
                return worktreeLine !== undefined
                    && branchLine === `branch ${expectedRef}`
                    && (
                        headLine === `HEAD ${expectedOid}`
                        || (
                            allowMissingRefOid
                            && headLine === `HEAD ${"0".repeat(expectedOid.length)}`
                        )
                    )
                    && sameObservedPath(
                        worktreeLine.slice("worktree ".length).trim(),
                        worktreePath,
                    );
        });
    return matches.length === 1;
}

function worktreeRegistrationOwnershipMatches(
    repositoryPath: string,
    worktreePath: string,
    fence: WorktreeRegistrationFence,
): boolean {
    try {
        assertDirectoryIdentity(worktreePath, fence.destinationIdentity);
        assertDirectoryIdentity(
            fence.managementIdentity.realpath,
            fence.managementIdentity,
        );
        if (!worktreeManagementBackpointersMatch(
            worktreePath,
            fence,
        )) {
            return false;
        }
        const symbolicHead = spawnSync(
            "git",
            ["symbolic-ref", "-q", "HEAD"],
            { cwd: worktreePath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        );
        const matches = symbolicHead.status === 0
            && (symbolicHead.stdout ?? "").trim() === fence.expectedRef
            && worktreeRegistryEntryMatches(
                repositoryPath,
                worktreePath,
                fence.expectedRef,
                fence.expectedOid,
                true,
            );
        if (!matches) return false;
        assertDirectoryIdentity(worktreePath, fence.destinationIdentity);
        assertDirectoryIdentity(
            fence.managementIdentity.realpath,
            fence.managementIdentity,
        );
        return true;
    } catch {
        return false;
    }
}

function worktreeRegistrationMatches(
    repositoryPath: string,
    worktreePath: string,
    branch: string,
    expectedOid: string,
    fence?: WorktreeRegistrationFence,
    requireBranchRef = true,
): boolean {
    try {
        if (fence) {
            assertDirectoryIdentity(worktreePath, fence.destinationIdentity);
            if (!worktreeManagementBackpointersMatch(
                worktreePath,
                fence,
            )) {
                return false;
            }
        }
        const branchResult = spawnSync(
            "git",
            ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`],
            { cwd: repositoryPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        );
        const worktreeResult = spawnSync(
            "git",
            ["rev-parse", "--verify", "HEAD^{commit}"],
            { cwd: worktreePath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        );
        const symbolicHead = spawnSync(
            "git",
            ["symbolic-ref", "-q", "HEAD"],
            { cwd: worktreePath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        );
        const expectedRef = fence?.expectedRef ?? `refs/heads/${branch}`;
        const matches = (!requireBranchRef || (
            branchResult.status === 0
            && (branchResult.stdout ?? "").trim() === expectedOid
        ))
            && worktreeResult.status === 0
            && symbolicHead.status === 0
            && (symbolicHead.stdout ?? "").trim() === expectedRef
            && worktreeRegistryEntryMatches(
                repositoryPath,
                worktreePath,
                expectedRef,
                expectedOid,
            )
            && (worktreeResult.stdout ?? "").trim() === expectedOid;
        if (!matches) return false;
        if (fence) {
            assertDirectoryIdentity(worktreePath, fence.destinationIdentity);
            if (!worktreeManagementBackpointersMatch(
                worktreePath,
                fence,
            )) {
                return false;
            }
        }
        return true;
    } catch {
        return false;
    }
}

function rollbackFailedWorktreeAdd(
    repositoryPath: string,
    worktreePath: string,
    branch: string,
    action: WorktreeRepoResult["action"],
    expectedBranchOid: BranchCreationFence | null,
    destinationIdentity: DirectoryIdentity,
    registrationFence: WorktreeRegistrationFence | null,
    quarantineBase = dirname(worktreePath),
    sourceIdentity?: NestedRepositoryIdentity,
    mutationGuard?: () => void,
): void {
    if (pathExistsStrict(worktreePath)) {
        assertDirectoryIdentity(worktreePath, destinationIdentity);
        if (isValidWorktree(worktreePath, repositoryPath)) {
            if (!registrationFence
                || !worktreeRegistrationOwnershipMatches(
                    repositoryPath,
                    worktreePath,
                    registrationFence,
                )) {
                throw new Error(
                    `Failed worktree creation found a foreign registration at '${worktreePath}'; preserving it.`,
                );
            }
            removeRegisteredWorktree(
                repositoryPath,
                worktreePath,
                destinationIdentity,
                true,
                quarantineBase,
                registrationFence,
                sourceIdentity
                    ? pinnedNestedRepositoryEnvironment(sourceIdentity)
                    : undefined,
                mutationGuard,
            );
        } else {
            removeDirectoryByQuarantine(
                worktreePath,
                destinationIdentity,
                quarantineBase,
                true,
            );
        }
    } else if (registeredWorktreePath(repositoryPath, worktreePath)) {
        if (!registrationFence) {
            throw new Error(
                `Failed worktree creation left an unowned registry entry at '${worktreePath}'.`,
            );
        }
        try {
            assertDirectoryIdentity(
                registrationFence.managementIdentity.realpath,
                registrationFence.managementIdentity,
            );
        } catch {
            throw new Error(
                `Failed worktree creation registry ownership changed at '${worktreePath}'; preserving it.`,
            );
        }
        if (!worktreeRegistryEntryMatches(
            repositoryPath,
            worktreePath,
            registrationFence.expectedRef,
            registrationFence.expectedOid,
        )) {
            throw new Error(
                `Failed worktree creation registry entry changed at '${worktreePath}'; preserving it.`,
            );
        }
        const quarantinedRegistration = quarantineMissingWorktreeRegistration(
            repositoryPath,
            worktreePath,
            registrationFence,
        );
        commitQuarantinedMissingWorktreeRegistration(quarantinedRegistration);
    }
    const rollbackBranch = () => rollbackFailedCreatedBranch(
        repositoryPath,
        branch,
        action,
        expectedBranchOid,
    );
    if (sourceIdentity) {
        withPinnedNestedRepository(sourceIdentity, rollbackBranch);
    } else {
        rollbackBranch();
    }
}

type PreparedWorktreeAddResult = {
    result: {
        error?: Error;
        status: number | null;
        stdout?: string;
        stderr?: string;
    };
    registrationFence: WorktreeRegistrationFence | null;
};

function runPreparedWorktreeAdd(
    repositoryPath: string,
    worktreePath: string,
    branch: string,
    expectedBranchOid: string,
    destinationIdentity: DirectoryIdentity,
    destinationGuard?: () => void,
    sourceIdentity?: NestedRepositoryIdentity,
): PreparedWorktreeAddResult {
    try {
        destinationGuard?.();
        assertDirectoryIdentity(worktreePath, destinationIdentity);
    } catch (error) {
        return {
            result: { status: 1, error: error as Error },
            registrationFence: null,
        };
    }
    const register = () => spawnSync(
        "git",
        ["worktree", "add", "--no-checkout", worktreePath, branch],
        { cwd: repositoryPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const registered = sourceIdentity
        ? spawnSync(
            "git",
            ["worktree", "add", "--no-checkout", worktreePath, branch],
            {
                cwd: repositoryPath,
                encoding: "utf-8",
                stdio: ["pipe", "pipe", "pipe"],
                env: pinnedNestedRepositoryEnvironment(sourceIdentity),
            },
        )
        : register();
    if (registered.error || registered.status !== 0) {
        return { result: registered, registrationFence: null };
    }
    let registrationFence: WorktreeRegistrationFence;
    try {
        destinationGuard?.();
        assertDirectoryIdentity(worktreePath, destinationIdentity);
        registrationFence = captureExistingWorktreeRegistrationFence(
            repositoryPath,
            worktreePath,
            branch,
            destinationIdentity,
        );
    } catch (error) {
        return {
            result: { status: 1, error: error as Error },
            registrationFence: null,
        };
    }
    if (!worktreeRegistrationMatches(
        repositoryPath,
        worktreePath,
        branch,
        expectedBranchOid,
        registrationFence,
    )) {
        return {
            result: {
                status: 1,
                stderr: "worktree branch identity changed after registration",
            },
            registrationFence,
        };
    }
    try {
        destinationGuard?.();
    } catch (error) {
        return {
            result: { status: 1, error: error as Error },
            registrationFence,
        };
    }
    const checkout = spawnSync(
        "git",
        ["checkout", "--force", branch],
        { cwd: worktreePath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    try {
        destinationGuard?.();
        registrationFence = refreshWorktreeRegistrationFenceFileIdentities(
            worktreePath,
            registrationFence,
        );
    } catch (error) {
        if (!pathExistsStrict(worktreePath)) {
            try {
                registrationFence = refreshMissingWorktreeRegistrationFenceFileIdentities(
                    repositoryPath,
                    worktreePath,
                    registrationFence,
                );
                return { result: checkout, registrationFence };
            } catch {
                // Preserve the original registration fence for conservative rollback.
            }
        }
        return {
            result: {
                status: 1,
                error: error as Error,
                stderr: "worktree branch identity changed during checkout",
            },
            registrationFence,
        };
    }
    if (checkout.error || checkout.status !== 0) {
        return { result: checkout, registrationFence };
    }
    return worktreeRegistrationMatches(
        repositoryPath,
        worktreePath,
        branch,
        expectedBranchOid,
        registrationFence,
    )
        ? { result: checkout, registrationFence }
        : {
            result: {
                status: 1,
                stderr: "worktree branch identity changed during checkout",
            },
            registrationFence,
        };
}

function reserveWorktreeDestination(
    worktreePath: string,
    destinationGuard?: () => void,
): DirectoryIdentity {
    destinationGuard?.();
    mkdirSync(worktreePath);
    const identity = captureDirectoryIdentity(worktreePath);
    destinationGuard?.();
    return identity;
}

function prepareWorktreeCreation(
    repositoryPath: string,
    worktreePath: string,
    branch: string,
    action: WorktreeRepoResult["action"],
    destinationGuard?: () => void,
    quarantineBase = dirname(worktreePath),
): {
    destinationIdentity: DirectoryIdentity;
    expectedBranchOid: BranchCreationFence;
} {
    const sourceOid = expectedFailedCreationBranchOid(
        repositoryPath,
        branch,
        action,
    );
    const configBefore = readBranchTrackingConfig(repositoryPath, branch);
    const destinationIdentity = reserveWorktreeDestination(
        worktreePath,
        destinationGuard,
    );
    if (action === "worktree-existing") {
        return {
            destinationIdentity,
            expectedBranchOid: {
                expectedOid: sourceOid,
                configBefore,
                configAfter: configBefore,
            },
        };
    }
    destinationGuard?.();
    const branchArgs = ["branch", "--no-track", branch, sourceOid];
    const created = spawnSync(
        "git",
        branchArgs,
        { cwd: repositoryPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const current = spawnSync(
        "git",
        ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
        { cwd: repositoryPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (created.error || created.status !== 0
        || current.error || current.status !== 0
        || (current.stdout ?? "").trim() !== sourceOid) {
        destinationGuard?.();
        assertDirectoryIdentity(worktreePath, destinationIdentity);
        removeDirectoryByQuarantine(
            worktreePath,
            destinationIdentity,
            quarantineBase,
            true,
        );
        throw new Error(
            `Branch '${branch}' changed while reserving worktree creation; preserving any existing ref.`,
        );
    }
    let configAfter = configBefore;
    if (action === "worktree-remote") {
        const autoRebase = spawnSync(
            "git",
            ["config", "--get", "branch.autoSetupRebase"],
            { cwd: repositoryPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        );
        const autoRebaseValue = autoRebase.status === 0
            ? (autoRebase.stdout ?? "").trim().toLowerCase()
            : "";
        configAfter = {
            remote: ["origin"],
            merge: [`refs/heads/${branch}`],
            rebase: autoRebaseValue === "always" || autoRebaseValue === "remote"
                ? ["true"]
                : [],
        };
        try {
            replaceBranchTrackingConfig(
                repositoryPath,
                branch,
                configBefore,
                configAfter,
            );
        } catch (error) {
            destinationGuard?.();
            assertDirectoryIdentity(worktreePath, destinationIdentity);
            removeDirectoryByQuarantine(
                worktreePath,
                destinationIdentity,
                quarantineBase,
                true,
            );
            const removed = spawnSync(
                "git",
                ["update-ref", "-d", `refs/heads/${branch}`, sourceOid],
                { cwd: repositoryPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
            );
            if (removed.error || removed.status !== 0) {
                throw new Error(
                    `${(error as Error).message}; failed to roll back newly created branch '${branch}'.`,
                    { cause: error },
                );
            }
            throw error;
        }
    }
    return {
        destinationIdentity,
        expectedBranchOid: {
            expectedOid: sourceOid,
            configBefore,
            configAfter,
        },
    };
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
 * - Submodules remain registered without automatic checkout updates
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
    // This repository is generated from already-present child repositories.
    // Keep their local-path submodule URLs usable in the resulting worktrees.
    spawnSync("git", ["config", "protocol.file.allow", "always"], {
        cwd: resolved,
        stdio: "pipe",
    });
    spawnSync("git", ["config", "ccc.localSubmodules", "true"], {
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

    // Configure submodules: ignore = all + update = none
    // ignore = all: parent won't report submodule content changes as dirty
    // update = none: generic recursive updates cannot reset active development
    for (const repo of gitRepos) {
        spawnSync(
            "git",
            ["config", "-f", ".gitmodules", `submodule.${repo.name}.ignore`, "all"],
            { cwd: resolved, stdio: "pipe" },
        );
        spawnSync(
            "git",
            ["config", "-f", ".gitmodules", `submodule.${repo.name}.update`, "none"],
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
 *    - Creates linked worktrees for the top-level repo and initialized submodules
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

    let action: WorktreeRepoResult["action"];

    switch (existence) {
        case "local":
            action = "worktree-existing";
            break;
        case "remote":
            action = "worktree-remote";
            break;
        case "none":
            action = "worktree-new";
            break;
    }
    const {
        expectedBranchOid,
        destinationIdentity,
    } = prepareWorktreeCreation(
        resolved,
        wsPath,
        branch,
        action,
    );
    const { result, registrationFence } = runPreparedWorktreeAdd(
        resolved,
        wsPath,
        branch,
        expectedBranchOid.expectedOid,
        destinationIdentity,
    );

    if (result.status !== 0) {
        const stderr = (result.stderr ?? "").trim();
        try {
            rollbackFailedWorktreeAdd(
                resolved,
                wsPath,
                branch,
                action,
                expectedBranchOid,
                destinationIdentity,
                registrationFence,
            );
        } catch (rollbackError) {
            throw new Error(
                `Failed to create worktree: ${stderr}; rollback failed: ${(rollbackError as Error).message}`,
                { cause: rollbackError },
            );
        }
        throw new Error(`Failed to create worktree: ${stderr}`);
    }
    const rootRegistrationFence = requireWorktreeRegistrationFence(
        registrationFence,
        wsPath,
    );

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
                rootRegistrationFence.destinationIdentity,
                true,
                dirname(wsPath),
                rootRegistrationFence,
            );
            rollbackFailedCreatedBranch(
                resolved,
                branch,
                action,
                expectedBranchOid,
            );
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
    const rollbackOids = new Map<string, BranchCreationFence | null>();
    const registrationFences = new Map<string, WorktreeRegistrationFence>();
    const copied: string[] = [];
    const copiedIdentities = new Map<string, DirectoryIdentity>();

    // Process git repos → worktree (with rollback on failure)
    try {
        for (const repo of gitRepos) {
            const destPath = join(wsPath, repo.name);
            const existence = branchExistsInRepo(repo.path, branch);

            let action: WorktreeRepoResult["action"];

            switch (existence) {
                case "local":
                    action = "worktree-existing";
                    break;
                case "remote":
                    action = "worktree-remote";
                    break;
                case "none":
                    action = "worktree-new";
                    break;
            }
            const {
                expectedBranchOid,
                destinationIdentity,
            } = prepareWorktreeCreation(
                repo.path,
                destPath,
                branch,
                action,
            );
            const { result, registrationFence } = runPreparedWorktreeAdd(
                repo.path,
                destPath,
                branch,
                expectedBranchOid.expectedOid,
                destinationIdentity,
            );

            if (result.status !== 0) {
                const stderr = (result.stderr ?? "").trim();
                try {
                    rollbackFailedWorktreeAdd(
                        repo.path,
                        destPath,
                        branch,
                        action,
                        expectedBranchOid,
                        destinationIdentity,
                        registrationFence,
                    );
                } catch (rollbackError) {
                    throw new Error(
                        `Failed to create worktree for ${repo.name}: ${stderr}; rollback failed: ${(rollbackError as Error).message}`,
                        { cause: rollbackError },
                    );
                }
                throw new Error(
                    `Failed to create worktree for ${repo.name}: ${stderr}`,
                );
            }

            created.push({ name: repo.name, branch, action });
            rollbackOids.set(repo.name, expectedBranchOid);
            registrationFences.set(
                repo.name,
                requireWorktreeRegistrationFence(registrationFence, destPath),
            );
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
                const registrationFence = registrationFences.get(c.name);
                if (!registrationFence) {
                    throw new Error("missing worktree registration fence");
                }
                removeRegisteredWorktree(
                    sourceRepo.path,
                    destPath,
                    registrationFence.destinationIdentity,
                    true,
                    dirname(wsPath),
                    registrationFence,
                );
                rollbackFailedCreatedBranch(
                    sourceRepo.path,
                    branch,
                    c.action,
                    rollbackOids.get(c.name) ?? null,
                );
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
            copiedIdentities.set(entry.name, capturePathIdentity(destPath));
        } catch (e) {
            const rollbackErrors: string[] = [];
            for (const createdEntry of [...created].reverse()) {
                const sourceRepo = gitRepos.find((repo) => (
                    repo.name === createdEntry.name
                ));
                if (!sourceRepo) continue;
                try {
                    const registrationFence = registrationFences.get(createdEntry.name);
                    if (!registrationFence) {
                        throw new Error("missing worktree registration fence");
                    }
                    removeRegisteredWorktree(
                        sourceRepo.path,
                        join(wsPath, createdEntry.name),
                        registrationFence.destinationIdentity,
                        true,
                        dirname(wsPath),
                        registrationFence,
                    );
                    rollbackFailedCreatedBranch(
                        sourceRepo.path,
                        branch,
                        createdEntry.action,
                        rollbackOids.get(createdEntry.name) ?? null,
                    );
                } catch (rollbackError) {
                    rollbackErrors.push(
                        `${createdEntry.name}: ${(rollbackError as Error).message}`,
                    );
                }
            }
            for (const copiedName of [...copied].reverse()) {
                const identity = copiedIdentities.get(copiedName);
                if (!identity) continue;
                try {
                    removePathByQuarantine(
                        join(wsPath, copiedName),
                        identity,
                        dirname(wsPath),
                    );
                } catch (rollbackError) {
                    rollbackErrors.push(
                        `${copiedName}: ${(rollbackError as Error).message}`,
                    );
                }
            }
            if (pathExistsStrict(destPath)) {
                rollbackErrors.push(`${entry.name}: partial copied content was preserved`);
            } else if (rollbackErrors.length === 0) {
                try {
                    assertDirectoryIdentity(wsPath, workspaceIdentity);
                    if (readdirSync(wsPath).length === 0) {
                        removeDirectoryByQuarantine(wsPath, workspaceIdentity);
                    }
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
    }

    return { workspacePath: wsPath, created, copied };
}

/**
 * Repair an existing workspace by creating worktrees for nested git repos
 * that are missing or empty in the workspace directory.
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
    const primarySource = primarySourceRepositoryForWorktree(resolved);
    if (gitLinkKind(join(resolved, ".git")) === "worktree") {
        if (!primarySource) {
            throw new Error(
                `Source worktree ownership could not be established: ${resolved}`,
            );
        }
        assertWorkspaceOwnership(resolved, primarySource);
    }
    assertWorkspaceRootOwnership(wsPath, resolved);

    // In unified mode, the root worktree does not populate nested repositories.
    // Initialized tracked submodules receive linked worktrees so the source
    // checkout is never reset by a submodule update. Ignored repositories are
    // intentionally outside the managed inventory.
    const created: WorktreeRepoResult[] = [];
    const rollbackOids = new Map<string, BranchCreationFence | null>();
    const registrationFences = new Map<string, WorktreeRegistrationFence>();
    const removedEmptyDestinations: string[] = [];
    const createdParentDirectories = new Map<string, DirectoryIdentity>();
    const destinationFences = new Map<string, {
        workspace: DirectoryIdentity;
        parents: Array<{ path: string; identity: DirectoryIdentity }>;
    }>();
    const blockedRepositoryPrefixes: string[] = [];
    const sourceEntries = scanUnifiedNestedRepositories(
        resolved,
        {
            strict: true,
            allowRegisteredWorktrees: Boolean(primarySource),
        },
    );
    const sourceRepositoryIdentities = new Map(
        sourceEntries
            .filter((entry) => entry.isGitRepo)
            .map((entry) => [
                entry.name,
                captureNestedRepositoryIdentity(entry.path),
            ]),
    );

    function rollbackNestedCreation(error: unknown): never {
        const rollbackErrors: string[] = [];
        for (const createdEntry of [...created].reverse()) {
            const sourceEntry = sourceEntries.find((entry) => (
                entry.isGitRepo && entry.name === createdEntry.name
            ));
            const destination = join(wsPath, createdEntry.name);
            if (!sourceEntry || !pathExistsStrict(destination)) continue;
            const sourceIdentity = sourceRepositoryIdentities.get(createdEntry.name);
            if (!sourceIdentity) {
                rollbackErrors.push(`${createdEntry.name}: missing source repository fence`);
                continue;
            }
            const destinationFence = destinationFences.get(createdEntry.name);
            if (!destinationFence) {
                rollbackErrors.push(`${createdEntry.name}: missing destination parent fence`);
                continue;
            }
            try {
                assertNestedWorktreeDestinationFence(
                    wsPath,
                    destination,
                    destinationFence,
                );
            } catch (rollbackError) {
                rollbackErrors.push(
                    `${createdEntry.name}: ${(rollbackError as Error).message}`,
                );
                continue;
            }
            if (!isValidWorktree(destination, sourceEntry.path)) {
                rollbackErrors.push(
                    `${createdEntry.name}: worktree ownership changed during rollback`,
                );
                continue;
            }
            try {
                assertNestedRepositoryIdentity(sourceEntry.path, sourceIdentity);
                const registrationFence = registrationFences.get(createdEntry.name);
                if (!registrationFence) {
                    throw new Error("missing worktree registration fence");
                }
                removeRegisteredWorktree(
                    sourceEntry.path,
                    destination,
                    registrationFence.destinationIdentity,
                    true,
                    dirname(wsPath),
                    registrationFence,
                    pinnedNestedRepositoryEnvironment(sourceIdentity),
                    () => {
                        assertNestedRepositoryIdentity(
                            sourceEntry.path,
                            sourceIdentity,
                        );
                        assertNestedWorktreeDestinationFence(
                            wsPath,
                            destination,
                            destinationFence,
                        );
                    },
                );
                withPinnedNestedRepository(sourceIdentity, () => {
                    rollbackFailedCreatedBranch(
                        sourceEntry.path,
                        branch,
                        createdEntry.action,
                        rollbackOids.get(createdEntry.name) ?? null,
                    );
                });
            } catch (rollbackError) {
                rollbackErrors.push(
                    `${createdEntry.name}: ${(rollbackError as Error).message}`,
                );
            }
        }
        for (const destination of removedEmptyDestinations) {
            if (pathExistsStrict(destination)) continue;
            try {
                const sourceEntry = sourceEntries.find((entry) => (
                    join(wsPath, entry.name) === destination
                ));
                const destinationFence = sourceEntry
                    ? destinationFences.get(sourceEntry.name)
                    : null;
                if (!destinationFence) {
                    throw new Error("missing destination parent fence");
                }
                assertNestedWorktreeDestinationFence(
                    wsPath,
                    destination,
                    destinationFence,
                );
                mkdirSync(destination);
                assertNestedWorktreeDestinationFence(
                    wsPath,
                    destination,
                    destinationFence,
                );
            } catch (rollbackError) {
                rollbackErrors.push(
                    `${basename(destination)}: failed to restore empty directory: ${(rollbackError as Error).message}`,
                );
            }
        }
        for (const [parent, identity] of [...createdParentDirectories.entries()].reverse()) {
            if (!pathExistsStrict(parent)) continue;
            try {
                assertDirectoryIdentity(parent, identity);
                if (readdirSync(parent).length === 0) {
                    removeDirectoryByQuarantine(parent, identity, dirname(parent), true);
                }
            } catch (rollbackError) {
                rollbackErrors.push(
                    `${parent}: failed to remove created parent: ${(rollbackError as Error).message}`,
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
        if (blockedRepositoryPrefixes.some((prefix) => (
            entry.name.startsWith(`${prefix}/`)
        ))) {
            continue;
        }

        const destPath = join(wsPath, entry.name);
        const sourceIdentity = sourceRepositoryIdentities.get(entry.name);
        if (!sourceIdentity) {
            rollbackNestedCreation(
                new Error(`Missing source repository fence for ${entry.name}`),
            );
        }
        const sourceGuard = (): void => {
            assertNestedRepositoryIdentity(entry.path, sourceIdentity);
        };
        let destinationFence: {
            workspace: DirectoryIdentity;
            parents: Array<{ path: string; identity: DirectoryIdentity }>;
        };
        try {
            destinationFence = ensureNestedWorktreeParent(
                wsPath,
                destPath,
                createdParentDirectories,
            );
            destinationFences.set(entry.name, destinationFence);
        } catch (error) {
            rollbackNestedCreation(error);
        }
        const operationGuard = (): void => {
            sourceGuard();
            assertNestedWorktreeDestinationFence(
                wsPath,
                destPath,
                destinationFence,
            );
        };

        // Check existing directory
        if (pathExistsStrict(destPath)) {
            operationGuard();
            const destIdentity = captureDirectoryIdentity(destPath);
            const contents = readdirSync(destPath);
            if (contents.length > 0) {
                if (!isValidWorktree(destPath, entry.path)) {
                    blockedRepositoryPrefixes.push(entry.name);
                }
                operationGuard();
                // Non-empty invalid entries and their descendants require the
                // explicit repair prompt.
                continue;
            }
            operationGuard();
            removeDirectoryByQuarantine(destPath, destIdentity, dirname(wsPath), true);
            operationGuard();
            removedEmptyDestinations.push(destPath);
        }

        sourceGuard();
        const nestedExistence = branchExistsInRepo(entry.path, branch);
        sourceGuard();
        let nestedAction: WorktreeRepoResult["action"];

        switch (nestedExistence) {
            case "local":
                nestedAction = "worktree-existing";
                break;
            case "remote":
                nestedAction = "worktree-remote";
                break;
            case "none":
                nestedAction = "worktree-new";
                break;
        }
        let prepared: ReturnType<typeof prepareWorktreeCreation>;
        try {
            prepared = withPinnedNestedRepository(
                sourceIdentity,
                () => prepareWorktreeCreation(
                    entry.path,
                    destPath,
                    branch,
                    nestedAction,
                    operationGuard,
                    dirname(wsPath),
                ),
            );
        } catch (error) {
            rollbackNestedCreation(error);
        }
        const { expectedBranchOid, destinationIdentity } = prepared;
        const {
            result: nestedResult,
            registrationFence,
        } = runPreparedWorktreeAdd(
            entry.path,
            destPath,
            branch,
            expectedBranchOid.expectedOid,
            destinationIdentity,
            operationGuard,
            sourceIdentity,
        );

        if (nestedResult.error || nestedResult.status !== 0) {
            const detail = (nestedResult.stderr ?? "").trim()
                || nestedResult.error?.message
                || `git exited with status ${String(nestedResult.status)}`;
            try {
                operationGuard();
                rollbackFailedWorktreeAdd(
                    entry.path,
                    destPath,
                    branch,
                    nestedAction,
                    expectedBranchOid,
                    destinationIdentity,
                    registrationFence,
                    dirname(wsPath),
                    sourceIdentity,
                    operationGuard,
                );
                operationGuard();
            } catch (rollbackError) {
                rollbackNestedCreation(new Error(
                    `Failed to create nested worktree for ${entry.name}: ${detail}; rollback failed: ${(rollbackError as Error).message}`,
                    { cause: rollbackError },
                ));
            }
            rollbackNestedCreation(
                new Error(`Failed to create nested worktree for ${entry.name}: ${detail}`),
            );
        }
        created.push({ name: entry.name, branch, action: nestedAction });
        rollbackOids.set(entry.name, expectedBranchOid);
        registrationFences.set(
            entry.name,
            requireWorktreeRegistrationFence(registrationFence, destPath),
        );
    }

    return created;
}

// === Docker Mount Helpers ===

export interface WorktreeGitMount {
    hostPath: string;
    containerPath: string;
    identity: DirectoryIdentity;
}

export function containerGitSourceMountPath(
    containerGitFileDirectory: string,
    rawGitDirectory: string,
    platform = process.platform,
): string {
    const normalizedGitDirectory = platform === "win32"
        ? rawGitDirectory.replace(/\\/g, "/")
        : rawGitDirectory;
    return posix.resolve(
        containerGitFileDirectory,
        normalizedGitDirectory,
        "..",
        "..",
    );
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
    containerWorkspacePath?: string,
): WorktreeGitMount[] {
    const resolved = resolve(worktreePath);
    const mounts: WorktreeGitMount[] = [];
    const seen = new Set<string>();
    const destinationSources = new Map<string, string>();

    function addMount(
        hostPath: string,
        containerPath: string,
        identity = captureDirectoryIdentity(hostPath),
    ): void {
        const existingSource = destinationSources.get(containerPath);
        if (existingSource && !sameObservedPath(existingSource, hostPath)) {
            throw new Error(
                `Conflicting Git mount sources target '${containerPath}': `
                + `'${existingSource}' and '${hostPath}'.`,
            );
        }
        destinationSources.set(containerPath, hostPath);
        const key = `${hostPath}:${containerPath}`;
        if (!seen.has(key)) {
            seen.add(key);
            mounts.push({ hostPath, containerPath, identity });
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
    }
    const nestedRepositories = hasGitMetadata(resolved)
        ? scanUnifiedNestedRepositories(
            resolved,
            { strict: required, allowRegisteredWorktrees: true },
        )
        : scanDirectory(resolved, { strict: required });
    for (const entry of nestedRepositories) {
        if (!entry.isGitRepo) continue;
        const nestedGit = join(entry.path, ".git");
        if (lstatSync(nestedGit).isFile() && !gitFiles.includes(nestedGit)) {
            gitFiles.push(nestedGit);
        }
    }
    if (required && gitFiles.length === 0) {
        throw new Error(`Required worktree metadata is missing: ${resolved}`);
    }

    let unifiedSourceRoot: string | null = null;
    if (gitFiles.includes(rootGit)) {
        try {
            unifiedSourceRoot = primarySourceRepositoryForWorktree(resolved);
            if (required && !unifiedSourceRoot) {
                throw new Error("worktree source ownership could not be established");
            }
        } catch (error) {
            if (required) {
                throw new Error(`Required worktree metadata is invalid: ${rootGit}`, {
                    cause: error,
                });
            }
        }
    }

    for (const gitFile of gitFiles) {
        const gitFileIdentity = capturePathIdentity(gitFile);
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
        const rawGitDirectory = match[1].trim();
        const resolvedGitdir = resolve(dirname(gitFile), rawGitDirectory);
        const sourceGitDir = resolve(resolvedGitdir, "..", "..");
        const sourceIdentity = captureDirectoryIdentity(sourceGitDir);
        const repositoryRelativePath = relative(resolved, dirname(gitFile))
            .replace(/\\/g, "/");
        const sourceRepoDir = unifiedSourceRoot
            ? join(
                unifiedSourceRoot,
                ...repositoryRelativePath.split("/").filter(Boolean),
            )
            : dirname(sourceGitDir);
        if (!isValidWorktree(dirname(gitFile), sourceRepoDir)) {
            throw new Error(`Worktree mount ownership could not be verified: ${gitFile}`);
        }
        const portableGitDirectory = normalizeWorktreeGitLink(
            gitFile,
            resolvedGitdir,
            gitFileIdentity,
        );
        const sourceBasename = basename(sourceRepoDir);
        const containerGitFileDirectory = containerWorkspacePath
            ? posix.join(
                containerWorkspacePath,
                relative(resolved, dirname(gitFile)).replace(/\\/g, "/"),
            )
            : dirname(gitFile);
        const sourceContainerPath = containerWorkspacePath
            ? containerGitSourceMountPath(
                containerGitFileDirectory,
                portableGitDirectory,
            )
            : sourceGitDir;
        addMount(sourceGitDir, sourceContainerPath, sourceIdentity);
        const relMountPath = `/project/${
            repositoryRelativePath || sourceBasename
        }/.git`;
        if (relMountPath !== sourceContainerPath) {
            addMount(sourceGitDir, relMountPath, sourceIdentity);
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
    try {
        captureDirectoryIdentity(dirPath);
    } catch {
        return false;
    }

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
                const srcContent = readFileSync(sourceGitPath, "utf-8").trim();
                const srcMatch = srcContent.match(/^gitdir:\s*(.+)$/);
                if (!srcMatch) return false;
                const sourceLinkedGitDirectory = resolve(
                    sourceRepoPath,
                    srcMatch[1].trim(),
                );
                actualSourceGitDir = gitLinkKind(sourceGitPath) === "worktree"
                    ? resolve(sourceLinkedGitDirectory, "..", "..")
                    : sourceLinkedGitDirectory;
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
    const sourceEntries = scanUnifiedNestedRepositories(
        resolved,
        {
            strict: true,
            allowRegisteredWorktrees: Boolean(
                primarySourceRepositoryForWorktree(resolved),
            ),
        },
    );

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
    cleanupOperations: {
        removeMergedBackup?: (path: string) => void;
    } = {},
): WorktreeRepoResult | null {
    if (!confirmed) {
        throw new Error("Explicit confirmation is required to replace broken worktree content.");
    }
    const resolved = resolve(sourcePath);
    assertWorkspaceRootOwnership(wsPath, resolved);

    // Find the source repo
    const sourceEntries = scanUnifiedNestedRepositories(
        resolved,
        {
            strict: true,
            allowRegisteredWorktrees: Boolean(
                primarySourceRepositoryForWorktree(resolved),
            ),
        },
    );
    const sourceRepo = sourceEntries.find((e) => e.name === repoName && e.isGitRepo);
    if (!sourceRepo) return null;
    const destPath = join(wsPath, ...sourceRepo.name.split("/"));
    for (const ancestor of sourceEntries.filter((entry) => (
        entry.isGitRepo
        && sourceRepo.name.startsWith(`${entry.name}/`)
    ))) {
        const ancestorDestination = join(wsPath, ...ancestor.name.split("/"));
        if (!isValidWorktree(ancestorDestination, ancestor.path)) {
            throw new Error(
                `Cannot repair '${repoName}' beneath unmanaged ancestor '${ancestor.name}'.`,
            );
        }
    }
    const sourceIdentity = captureNestedRepositoryIdentity(sourceRepo.path);
    const createdParentDirectories = new Map<string, DirectoryIdentity>();
    const destinationFence = ensureNestedWorktreeParent(
        wsPath,
        destPath,
        createdParentDirectories,
    );
    const operationGuard = (): void => {
        assertNestedRepositoryIdentity(sourceRepo.path, sourceIdentity);
        assertNestedWorktreeDestinationFence(wsPath, destPath, destinationFence);
    };
    operationGuard();
    const staleRegistrationFence = captureMissingWorktreeRegistrationFence(
        sourceRepo.path,
        destPath,
        branch,
    );
    operationGuard();

    let backup: QuarantineLocation | null = null;
    let backupIdentity: DirectoryIdentity | null = null;
    let quarantinedStaleRegistration: QuarantinedMissingWorktreeRegistration | null = null;
    const workspaceIdentity = captureDirectoryIdentity(wsPath);
    const restoreStaleRegistration = (): void => {
        if (!quarantinedStaleRegistration) return;
        restoreQuarantinedMissingWorktreeRegistration(quarantinedStaleRegistration);
        quarantinedStaleRegistration = null;
    };
    if (pathExistsStrict(destPath)) {
        operationGuard();
        backupIdentity = captureDirectoryIdentity(destPath);
        backup = createPrivateQuarantine(destPath, dirname(wsPath));
        try {
            operationGuard();
            assertDirectoryIdentity(destPath, backupIdentity);
            renameSync(destPath, backup.path);
            operationGuard();
            assertQuarantinedIdentity(backup.path, backupIdentity, "directory");
        } catch (error) {
            if (!pathExistsStrict(backup.path)) removePrivateQuarantine(backup);
            throw error;
        }
    }

    if (staleRegistrationFence) {
        try {
            operationGuard();
            quarantinedStaleRegistration = withPinnedNestedRepository(
                sourceIdentity,
                () => quarantineMissingWorktreeRegistration(
                    sourceRepo.path,
                    destPath,
                    staleRegistrationFence,
                ),
            );
            operationGuard();
        } catch (error) {
            if (backup && backupIdentity) {
                operationGuard();
                rollbackQuarantinedPath(
                    destPath,
                    backup,
                    backupIdentity,
                    workspaceIdentity,
                    "directory",
                );
                operationGuard();
            }
            throw error;
        }
    }

    // Create worktree
    operationGuard();
    const existence = branchExistsInRepo(sourceRepo.path, branch);
    operationGuard();
    let action: WorktreeRepoResult["action"];

    switch (existence) {
        case "local":
            action = "worktree-existing";
            break;
        case "remote":
            action = "worktree-remote";
            break;
        case "none":
            action = "worktree-new";
            break;
    }
    let expectedBranchOid: BranchCreationFence;
    let destinationIdentity: DirectoryIdentity;
    try {
        ({
            expectedBranchOid,
            destinationIdentity,
        } = withPinnedNestedRepository(
            sourceIdentity,
            () => prepareWorktreeCreation(
                sourceRepo.path,
                destPath,
                branch,
                action,
                operationGuard,
                dirname(wsPath),
            ),
        ));
    } catch (error) {
        if (backup && backupIdentity) {
            operationGuard();
            rollbackQuarantinedPath(
                destPath,
                backup,
                backupIdentity,
                workspaceIdentity,
                "directory",
            );
            operationGuard();
        }
        restoreStaleRegistration();
        throw error;
    }
    const { result, registrationFence } = runPreparedWorktreeAdd(
        sourceRepo.path,
        destPath,
        branch,
        expectedBranchOid.expectedOid,
        destinationIdentity,
        operationGuard,
        sourceIdentity,
    );

    if (result.status !== 0) {
        try {
            operationGuard();
            rollbackFailedWorktreeAdd(
                sourceRepo.path,
                destPath,
                branch,
                action,
                expectedBranchOid,
                destinationIdentity,
                registrationFence,
                dirname(wsPath),
                sourceIdentity,
                operationGuard,
            );
            operationGuard();
        } catch (rollbackError) {
            const preservation = backup
                ? `; original content remains in '${backup.directory}'`
                : "";
            throw new Error(
                `Failed worktree repair rollback: ${(rollbackError as Error).message}${preservation}.`,
                { cause: rollbackError },
            );
        }
        if (backup && backupIdentity) {
            operationGuard();
            const restored = rollbackQuarantinedPath(
                destPath,
                backup,
                backupIdentity,
                workspaceIdentity,
                "directory",
            );
            operationGuard();
            if (!restored) {
                throw new Error(
                    `Failed worktree creation could not restore original content from '${backup.directory}'.`,
                );
            }
        }
        restoreStaleRegistration();
        return null;
    }
    const createdRegistrationFence = requireWorktreeRegistrationFence(
        registrationFence,
        destPath,
    );

    if (backup && backupIdentity) {
        try {
            operationGuard();
            if (!isValidWorktree(destPath, sourceRepo.path)) {
                throw new Error("Created worktree ownership could not be verified.");
            }
            operationGuard();
            assertQuarantinedIdentity(backup.path, backupIdentity, "directory");
            for (const name of readdirSync(backup.path)) {
                if (name === ".git") continue;
                mergePreservingContent(
                    join(backup.path, name),
                    join(destPath, name),
                );
            }
        } catch (error) {
            if (pathExistsStrict(destPath)) {
                operationGuard();
                if (!isValidWorktree(destPath, sourceRepo.path)) {
                    throw new Error(
                        `${(error as Error).message}; created worktree ownership changed during rollback`,
                        { cause: error },
                    );
                }
                removeRegisteredWorktree(
                    sourceRepo.path,
                    destPath,
                    createdRegistrationFence.destinationIdentity,
                    true,
                    dirname(wsPath),
                    createdRegistrationFence,
                    pinnedNestedRepositoryEnvironment(sourceIdentity),
                    operationGuard,
                );
                operationGuard();
                withPinnedNestedRepository(sourceIdentity, () => (
                    rollbackFailedCreatedBranch(
                        sourceRepo.path,
                        branch,
                        action,
                        expectedBranchOid,
                    )
                ));
            }
            operationGuard();
            rollbackQuarantinedPath(
                destPath,
                backup,
                backupIdentity,
                workspaceIdentity,
                "directory",
            );
            operationGuard();
            restoreStaleRegistration();
            throw error;
        }

        // The replacement is now the authoritative worktree. Cleanup failures
        // must not roll it back after either quarantine has been committed.
        if (quarantinedStaleRegistration) {
            commitQuarantinedMissingWorktreeRegistration(
                quarantinedStaleRegistration,
            );
            quarantinedStaleRegistration = null;
        }
        const removeMergedBackup = cleanupOperations.removeMergedBackup
            ?? ((path: string) => rmSync(path, { recursive: true, force: true }));
        operationGuard();
        assertQuarantinedIdentity(backup.path, backupIdentity, "directory");
        removeMergedBackup(backup.path);
        operationGuard();
        if (pathExistsStrict(backup.path)) {
            throw new Error(`Broken-worktree backup was not removed: ${backup.path}`);
        }
        removePrivateQuarantine(backup);
    }

    if (quarantinedStaleRegistration) {
        commitQuarantinedMissingWorktreeRegistration(quarantinedStaleRegistration);
        quarantinedStaleRegistration = null;
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

    assertWorkspaceBranch(
        wsPath,
        branch,
        spawnSync,
        resolved,
        { allowTrackedGitlinks: true },
    );
    const workspaceIdentity = captureDirectoryIdentity(wsPath);

    // Unified mode: top-level is a git repo → remove single worktree
    if (hasGitMetadata(resolved)) {
        return removeUnifiedWorkspace(resolved, wsPath, branch, workspaceIdentity, opts);
    }

    // Multi-repo mode
    return removeMultiRepoWorkspace(resolved, wsPath, branch, workspaceIdentity, opts);
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

    const sourceEntries = scanUnifiedNestedRepositories(
        resolved,
        {
            strict: true,
            allowRegisteredWorktrees: Boolean(
                primarySourceRepositoryForWorktree(resolved),
            ),
        },
    );
    const inspectRootStatus = (path = wsPath) => spawnSync(
        "git",
        [
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
            "--ignore-submodules=all",
            "--",
            ".",
            ...sourceEntries.map(({ name }) => `:(exclude,literal)${name}`),
        ],
        { cwd: path, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const inspectIgnoredRootStatus = (path = wsPath) => spawnSync(
        "git",
        [
            "status",
            "--porcelain=v1",
            "--ignored",
            "--untracked-files=all",
            "--",
            ".",
            ...sourceEntries.map(({ name }) => `:(exclude,literal)${name}`),
        ],
        { cwd: path, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const rootStatus = inspectRootStatus();
    if (rootStatus.error || rootStatus.status !== 0) {
        return {
            removed,
            errors: [
                (rootStatus.stderr ?? "").trim()
                || rootStatus.error?.message
                || "unable to inspect root worktree status",
            ],
        };
    }
    if (opts?.force !== true && (rootStatus.stdout ?? "").trim()) {
        return {
            removed,
            errors: [
                "root worktree contains modified or untracked files, use --force to delete it",
            ],
        };
    }
    const ignoredRootStatus = inspectIgnoredRootStatus();
    if (ignoredRootStatus.error || ignoredRootStatus.status !== 0) {
        return {
            removed,
            errors: [
                (ignoredRootStatus.stderr ?? "").trim()
                || ignoredRootStatus.error?.message
                || "unable to inspect ignored root worktree content",
            ],
        };
    }
    if (opts?.force !== true && (ignoredRootStatus.stdout ?? "").trim()) {
        return {
            removed,
            errors: [
                "root worktree contains ignored files, use --force to delete it",
            ],
        };
    }

    // Remove every linked nested worktree before removing the parent.
    const workspaceRepositoryEntries = sourceEntries.map((sourceEntry) => ({
        ...sourceEntry,
        path: join(wsPath, sourceEntry.name),
    }));
    const sourceRepositoryIdentities = new Map(
        sourceEntries
            .filter((entry) => entry.isGitRepo)
            .map((entry) => [
                entry.name,
                captureNestedRepositoryIdentity(entry.path),
            ]),
    );
    for (const entry of [...sourceEntries].reverse()) {
        if (!entry.isGitRepo) continue;

        const nestedPath = join(wsPath, entry.name);
        if (!existsSync(nestedPath)) continue;
        const sourceIdentity = sourceRepositoryIdentities.get(entry.name);
        if (!sourceIdentity) {
            errors.push(`${entry.name}: missing source repository fence`);
            continue;
        }
        let destinationFence: ReturnType<typeof ensureNestedWorktreeParent>;
        try {
            destinationFence = ensureNestedWorktreeParent(
                wsPath,
                nestedPath,
                new Map<string, DirectoryIdentity>(),
                false,
            );
        } catch (error) {
            errors.push(`${entry.name}: ${(error as Error).message}`);
            continue;
        }
        const operationGuard = (): void => {
            assertDirectoryIdentity(wsPath, workspaceIdentity);
            assertNestedRepositoryIdentity(entry.path, sourceIdentity);
            assertNestedWorktreeDestinationFence(
                wsPath,
                nestedPath,
                destinationFence,
            );
        };
        operationGuard();
        const nestedGitPath = join(nestedPath, ".git");
        if (existsSync(nestedGitPath)
            && gitLinkKind(nestedGitPath) === "gitlink"
            && isNestedTrackedGitlink(
                wsPath,
                workspaceRepositoryEntries,
                {
                    ...entry,
                    path: nestedPath,
                },
            )) {
            const nestedStatus = spawnSync(
                "git",
                ["status", "--porcelain=v1", "--untracked-files=all"],
                {
                    cwd: nestedPath,
                    encoding: "utf-8",
                    stdio: ["pipe", "pipe", "pipe"],
                },
            );
            if (nestedStatus.error || nestedStatus.status !== 0) {
                errors.push(
                    `${entry.name}: ${
                        (nestedStatus.stderr ?? "").trim()
                        || nestedStatus.error?.message
                        || "unable to inspect tracked submodule status"
                    }`,
                );
            } else if (
                opts?.force !== true
                && (nestedStatus.stdout ?? "").trim()
            ) {
                errors.push(
                    `${entry.name}: tracked submodule contains modified or untracked files, use --force to delete it`,
                );
            }
            continue;
        }
        if (!isValidWorktree(nestedPath, entry.path)) {
            errors.push(`${entry.name}: worktree ownership changed before deletion`);
            continue;
        }
        const nestedIdentity = captureDirectoryIdentity(nestedPath);
        try {
            operationGuard();
            const registrationFence = captureExistingWorktreeRegistrationFence(
                entry.path,
                nestedPath,
                branch,
                nestedIdentity,
            );
            removeRegisteredWorktree(
                entry.path,
                nestedPath,
                nestedIdentity,
                opts?.force === true,
                dirname(wsPath),
                registrationFence,
                pinnedNestedRepositoryEnvironment(sourceIdentity),
                operationGuard,
            );
            operationGuard();
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
    const finalRootStatus = inspectRootStatus();
    if (finalRootStatus.error || finalRootStatus.status !== 0) {
        return {
            removed,
            errors: [
                (finalRootStatus.stderr ?? "").trim()
                || finalRootStatus.error?.message
                || "unable to re-inspect root worktree status",
            ],
        };
    }
    if (opts?.force !== true && (finalRootStatus.stdout ?? "").trim()) {
        return {
            removed,
            errors: [
                "root worktree changed during removal, use --force to delete it",
            ],
        };
    }
    const finalIgnoredRootStatus = inspectIgnoredRootStatus();
    if (finalIgnoredRootStatus.error || finalIgnoredRootStatus.status !== 0) {
        return {
            removed,
            errors: [
                (finalIgnoredRootStatus.stderr ?? "").trim()
                || finalIgnoredRootStatus.error?.message
                || "unable to re-inspect ignored root worktree content",
            ],
        };
    }
    if (
        opts?.force !== true
        && (finalIgnoredRootStatus.stdout ?? "").trim()
    ) {
        return {
            removed,
            errors: [
                "root worktree gained ignored files during removal, use --force to delete it",
            ],
        };
    }
    try {
        const registrationFence = captureExistingWorktreeRegistrationFence(
            resolved,
            wsPath,
            branch,
            workspaceIdentity,
        );
        removeRegisteredWorktree(
            resolved,
            wsPath,
            workspaceIdentity,
            true,
            dirname(wsPath),
            registrationFence,
            undefined,
            undefined,
            opts?.force === true
                ? undefined
                : (quarantinedPath) => {
                    const quarantinedStatus = inspectRootStatus(quarantinedPath);
                    if (
                        quarantinedStatus.error
                        || quarantinedStatus.status !== 0
                    ) {
                        throw new Error(
                            (quarantinedStatus.stderr ?? "").trim()
                            || quarantinedStatus.error?.message
                            || "unable to inspect quarantined root worktree status",
                        );
                    }
                    if ((quarantinedStatus.stdout ?? "").trim()) {
                        throw new Error(
                            "root worktree changed during removal, use --force to delete it",
                        );
                    }
                    const quarantinedIgnoredStatus = inspectIgnoredRootStatus(
                        quarantinedPath,
                    );
                    if (
                        quarantinedIgnoredStatus.error
                        || quarantinedIgnoredStatus.status !== 0
                    ) {
                        throw new Error(
                            (quarantinedIgnoredStatus.stderr ?? "").trim()
                            || quarantinedIgnoredStatus.error?.message
                            || "unable to inspect quarantined ignored root worktree content",
                        );
                    }
                    if ((quarantinedIgnoredStatus.stdout ?? "").trim()) {
                        throw new Error(
                            "root worktree gained ignored files during removal, use --force to delete it",
                        );
                    }
                },
        );
        removed.push(basename(resolved));
    } catch (error) {
        errors.push((error as Error).message);
    }

    return { removed, errors };
}

function removeMultiRepoWorkspace(
    resolved: string,
    wsPath: string,
    branch: string,
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
                const registrationFence = captureExistingWorktreeRegistrationFence(
                    entry.path,
                    wsEntryPath,
                    branch,
                    entryIdentity,
                );
                removeRegisteredWorktree(
                    entry.path,
                    wsEntryPath,
                    entryIdentity,
                    opts?.force === true,
                    dirname(wsPath),
                    registrationFence,
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
