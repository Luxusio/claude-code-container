import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
    mkdirSync,
    writeFileSync,
    rmSync,
    existsSync,
    symlinkSync,
    readFileSync,
    lstatSync,
    statSync,
} from "fs";
import { join, dirname, basename } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { spawnSync } from "child_process";
import {
    parseWorktreeArg,
    getWorkspacePath,
    validateBranchName,
    WORKTREE_SEPARATOR,
    scanDirectory,
    workspaceExists,
    listWorkspaces,
    branchExistsInRepo,
    createWorkspace,
    removeWorkspace,
    repairWorkspace,
    isValidWorktree,
    detectBrokenWorktrees,
    fixBrokenWorktree,
    getWorktreeGitMounts,
    needsSubmoduleSetup,
    initWithSubmodules,
} from "../worktree.js";

/** Helper: create a real git repo with an initial commit */
function initRepo(repoPath: string): void {
    mkdirSync(repoPath, { recursive: true });
    spawnSync("git", ["init"], { cwd: repoPath, stdio: "pipe" });
    spawnSync("git", ["config", "user.email", "t@t.com"], {
        cwd: repoPath,
        stdio: "pipe",
    });
    spawnSync("git", ["config", "user.name", "T"], {
        cwd: repoPath,
        stdio: "pipe",
    });
    writeFileSync(join(repoPath, "init.txt"), "init");
    spawnSync("git", ["add", "."], { cwd: repoPath, stdio: "pipe" });
    spawnSync("git", ["commit", "-m", "init"], {
        cwd: repoPath,
        stdio: "pipe",
    });
}

// === Pure Function Tests (no I/O) ===

describe("validateBranchName", () => {
    it("accepts valid branch names", () => {
        expect(validateBranchName("feature")).toBe("feature");
        expect(validateBranchName("feature/login")).toBe("feature/login");
        expect(validateBranchName("my-branch")).toBe("my-branch");
        expect(validateBranchName("v1.0")).toBe("v1.0");
        expect(validateBranchName("user/feature/v2")).toBe("user/feature/v2");
    });

    it("rejects empty or blank branch names", () => {
        expect(() => validateBranchName("")).toThrow(/cannot be empty/);
        expect(() => validateBranchName("  ")).toThrow(/cannot be empty/);
    });

    it("rejects branch names starting with dash (flag injection)", () => {
        expect(() => validateBranchName("-b")).toThrow(/cannot start with '-'/);
        expect(() => validateBranchName("--version")).toThrow(
            /cannot start with '-'/,
        );
        expect(() => validateBranchName("-c")).toThrow(/cannot start with '-'/);
    });

    it("rejects branch names with path traversal (..)", () => {
        expect(() => validateBranchName("..")).toThrow(/cannot contain '..'/);
        expect(() => validateBranchName("../etc")).toThrow(
            /cannot contain '..'/,
        );
        expect(() => validateBranchName("foo/../bar")).toThrow(
            /cannot contain '..'/,
        );
    });

    it("rejects forbidden characters", () => {
        expect(() => validateBranchName("feat ure")).toThrow(
            /forbidden characters/,
        );
        expect(() => validateBranchName("feat~ure")).toThrow(
            /forbidden characters/,
        );
        expect(() => validateBranchName("feat^ure")).toThrow(
            /forbidden characters/,
        );
        expect(() => validateBranchName("feat:ure")).toThrow(
            /forbidden characters/,
        );
        expect(() => validateBranchName("feat?ure")).toThrow(
            /forbidden characters/,
        );
        expect(() => validateBranchName("feat*ure")).toThrow(
            /forbidden characters/,
        );
        expect(() => validateBranchName("feat[ure")).toThrow(
            /forbidden characters/,
        );
        expect(() => validateBranchName("feat\\ure")).toThrow(
            /forbidden characters/,
        );
        expect(() => validateBranchName("feat\x00ure")).toThrow(
            /forbidden characters/,
        );
        expect(() => validateBranchName("feat\nure")).toThrow(
            /forbidden characters/,
        );
    });

    it("rejects @{ (git refspec syntax)", () => {
        expect(() => validateBranchName("branch@{upstream}")).toThrow(
            /cannot contain '@\{'/,
        );
    });

    it("allows bare @ in branch name", () => {
        expect(validateBranchName("user@feature")).toBe("user@feature");
    });

    it("rejects branches starting/ending with slash", () => {
        expect(() => validateBranchName("/feature")).toThrow(
            /cannot start or end with '\/'/,
        );
        expect(() => validateBranchName("feature/")).toThrow(
            /cannot start or end with '\/'/,
        );
    });

    it("rejects consecutive slashes", () => {
        expect(() => validateBranchName("feat//ure")).toThrow(
            /cannot contain consecutive slashes/,
        );
    });

    it("rejects branch ending with .lock", () => {
        expect(() => validateBranchName("feature.lock")).toThrow(
            /cannot end with '.lock'/,
        );
    });

    it("rejects branch ending with dot", () => {
        expect(() => validateBranchName("feature.")).toThrow(
            /cannot end with '.'/,
        );
    });

    it("rejects excessively long branch names", () => {
        const longBranch = "a".repeat(300);
        expect(() => validateBranchName(longBranch)).toThrow(/too long/);
    });

    it("accepts branch at max length", () => {
        const branch = "a".repeat(255);
        expect(validateBranchName(branch)).toBe(branch);
    });
});

describe("parseWorktreeArg", () => {
    it('returns branch for "@feature"', () => {
        expect(parseWorktreeArg("@feature")).toEqual({ branch: "feature" });
    });

    it('returns branch for "@feature/login"', () => {
        expect(parseWorktreeArg("@feature/login")).toEqual({
            branch: "feature/login",
        });
    });

    it('returns null branch for bare "@" (list mode)', () => {
        expect(parseWorktreeArg("@")).toEqual({ branch: null });
    });

    it("returns null for empty string", () => {
        expect(parseWorktreeArg("")).toBeNull();
    });

    it("returns null for non-@ string", () => {
        expect(parseWorktreeArg("feature")).toBeNull();
    });

    it("returns null for regular commands", () => {
        expect(parseWorktreeArg("shell")).toBeNull();
        expect(parseWorktreeArg("stop")).toBeNull();
        expect(parseWorktreeArg("--continue")).toBeNull();
    });

    it('handles "@my-branch-name"', () => {
        expect(parseWorktreeArg("@my-branch-name")).toEqual({
            branch: "my-branch-name",
        });
    });
});

describe("getWorkspacePath", () => {
    it("creates sibling path with separator", () => {
        const result = getWorkspacePath("/projects", "feature");
        expect(result).toBe(`/projects${WORKTREE_SEPARATOR}feature`);
    });

    it("replaces / in branch name with -", () => {
        const result = getWorkspacePath("/projects", "feature/login");
        expect(result).toBe(`/projects${WORKTREE_SEPARATOR}feature-login`);
    });

    it("handles nested slashes", () => {
        const result = getWorkspacePath("/projects", "user/feature/v2");
        expect(result).toBe(`/projects${WORKTREE_SEPARATOR}user-feature-v2`);
    });

    it("returns consistent results", () => {
        const r1 = getWorkspacePath("/projects", "feature");
        const r2 = getWorkspacePath("/projects", "feature");
        expect(r1).toBe(r2);
    });

    it("creates path in parent directory", () => {
        const result = getWorkspacePath("/home/user/my-project", "dev");
        expect(result).toBe(`/home/user/my-project${WORKTREE_SEPARATOR}dev`);
    });
});

describe("WORKTREE_SEPARATOR", () => {
    it('is "--"', () => {
        expect(WORKTREE_SEPARATOR).toBe("--");
    });
});

// === Filesystem Tests (uses tmp dir) ===

describe("scanDirectory", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = join(tmpdir(), `ccc-test-${randomUUID()}`);
        mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns empty for non-existent directory", () => {
        expect(scanDirectory("/nonexistent-path-12345")).toEqual([]);
    });

    it("returns empty for empty directory", () => {
        expect(scanDirectory(tmpDir)).toEqual([]);
    });

    it("identifies git repos", () => {
        const repoDir = join(tmpDir, "my-repo");
        mkdirSync(join(repoDir, ".git"), { recursive: true });

        const entries = scanDirectory(tmpDir);
        expect(entries).toHaveLength(1);
        expect(entries[0].name).toBe("my-repo");
        expect(entries[0].isGitRepo).toBe(true);
    });

    it("identifies git repos with .git file (gitlink/worktree)", () => {
        const repoDir = join(tmpDir, "worktree-repo");
        mkdirSync(repoDir);
        writeFileSync(
            join(repoDir, ".git"),
            "gitdir: /some/other/repo/.git/worktrees/worktree-repo",
        );

        const entries = scanDirectory(tmpDir);
        expect(entries).toHaveLength(1);
        expect(entries[0].name).toBe("worktree-repo");
        expect(entries[0].isGitRepo).toBe(true);
    });

    it("identifies non-repo directories", () => {
        mkdirSync(join(tmpDir, "shared"));

        const entries = scanDirectory(tmpDir);
        expect(entries).toHaveLength(1);
        expect(entries[0].name).toBe("shared");
        expect(entries[0].isGitRepo).toBe(false);
    });

    it("includes files as non-repo entries", () => {
        writeFileSync(join(tmpDir, "docker-compose.yml"), "version: 3");

        const entries = scanDirectory(tmpDir);
        expect(entries).toHaveLength(1);
        expect(entries[0].name).toBe("docker-compose.yml");
        expect(entries[0].isGitRepo).toBe(false);
    });

    it("includes symlinks as non-repo entries", () => {
        mkdirSync(join(tmpDir, "real-dir"));
        symlinkSync(
            join(tmpDir, "real-dir"),
            join(tmpDir, "link-dir"),
        );

        const entries = scanDirectory(tmpDir);
        const names = entries.map((e) => e.name).sort();
        expect(names).toEqual(["link-dir", "real-dir"]);

        const link = entries.find((e) => e.name === "link-dir");
        expect(link!.isGitRepo).toBe(false);
    });

    it("skips .git but includes other dotfiles", () => {
        mkdirSync(join(tmpDir, ".git"));
        mkdirSync(join(tmpDir, ".claude"));
        writeFileSync(join(tmpDir, ".env"), "SECRET=1");
        mkdirSync(join(tmpDir, "visible"));

        const entries = scanDirectory(tmpDir);
        const names = entries.map((e) => e.name).sort();
        expect(names).toEqual([".claude", ".env", "visible"]);
    });

    it("handles mixed content", () => {
        mkdirSync(join(tmpDir, "frontend", ".git"), { recursive: true });
        mkdirSync(join(tmpDir, "backend", ".git"), { recursive: true });
        mkdirSync(join(tmpDir, "shared"));
        writeFileSync(join(tmpDir, "README.md"), "# Test");
        mkdirSync(join(tmpDir, ".git"), { recursive: true }); // .git skipped

        const entries = scanDirectory(tmpDir);
        const names = entries.map((e) => e.name).sort();
        expect(names).toEqual(["README.md", "backend", "frontend", "shared"]);

        const repos = entries.filter((e) => e.isGitRepo);
        expect(repos).toHaveLength(2);
    });
});

describe("workspaceExists", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = join(tmpdir(), `ccc-test-${randomUUID()}`);
        mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns false when workspace does not exist", () => {
        expect(workspaceExists(tmpDir, "feature")).toBe(false);
    });

    it("returns true when workspace exists", () => {
        const wsPath = getWorkspacePath(tmpDir, "feature");
        mkdirSync(wsPath, { recursive: true });
        expect(workspaceExists(tmpDir, "feature")).toBe(true);
    });
});

describe("listWorkspaces", () => {
    let parentDir: string;
    let sourceDir: string;

    beforeEach(() => {
        parentDir = join(tmpdir(), `ccc-test-${randomUUID()}`);
        sourceDir = join(parentDir, "projects");
        mkdirSync(sourceDir, { recursive: true });
    });

    afterEach(() => {
        rmSync(parentDir, { recursive: true, force: true });
    });

    it("returns empty when no workspaces", () => {
        expect(listWorkspaces(sourceDir)).toEqual([]);
    });

    it("finds workspaces with separator pattern", () => {
        mkdirSync(join(parentDir, `projects${WORKTREE_SEPARATOR}feature`));
        mkdirSync(join(parentDir, `projects${WORKTREE_SEPARATOR}hotfix`));

        const workspaces = listWorkspaces(sourceDir);
        expect(workspaces).toHaveLength(2);

        const branches = workspaces.map((w) => w.branch).sort();
        expect(branches).toEqual(["feature", "hotfix"]);
    });

    it("reads original branch name from metadata", () => {
        const wsDir = join(
            parentDir,
            `projects${WORKTREE_SEPARATOR}feature-login`,
        );
        mkdirSync(wsDir);

        const workspaces = listWorkspaces(sourceDir);
        expect(workspaces).toHaveLength(1);
        // Without git, falls back to dirname-derived branch name
        expect(workspaces[0].branch).toBe("feature-login");
    });

    it("falls back to dirname when not a git repo", () => {
        mkdirSync(join(parentDir, `projects${WORKTREE_SEPARATOR}feature`));

        const workspaces = listWorkspaces(sourceDir);
        expect(workspaces[0].branch).toBe("feature");
    });

    it("ignores unrelated sibling directories", () => {
        mkdirSync(join(parentDir, "other-project"));
        mkdirSync(join(parentDir, `projects${WORKTREE_SEPARATOR}feature`));

        const workspaces = listWorkspaces(sourceDir);
        expect(workspaces).toHaveLength(1);
        expect(workspaces[0].branch).toBe("feature");
    });

    it("ignores files matching the pattern", () => {
        writeFileSync(
            join(parentDir, `projects${WORKTREE_SEPARATOR}not-a-dir`),
            "file",
        );
        expect(listWorkspaces(sourceDir)).toEqual([]);
    });

    it("returns empty when parent directory does not exist", () => {
        expect(listWorkspaces("/nonexistent-parent-12345/child")).toEqual([]);
    });
});

// === Git Integration Tests (real git repos in tmp) ===

describe("branchExistsInRepo", () => {
    let tmpDir: string;
    let repoPath: string;

    beforeEach(() => {
        tmpDir = join(tmpdir(), `ccc-test-${randomUUID()}`);
        repoPath = join(tmpDir, "repo");
        initRepo(repoPath);
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns "local" for existing local branch', () => {
        spawnSync("git", ["branch", "feature"], {
            cwd: repoPath,
            stdio: "pipe",
        });
        expect(branchExistsInRepo(repoPath, "feature")).toBe("local");
    });

    it('returns "none" for non-existent branch', () => {
        expect(branchExistsInRepo(repoPath, "nonexistent")).toBe("none");
    });

    it('returns "local" for current branch (master/main)', () => {
        const result = spawnSync(
            "git",
            ["rev-parse", "--abbrev-ref", "HEAD"],
            { cwd: repoPath, encoding: "utf-8", stdio: "pipe" },
        );
        const defaultBranch = result.stdout.trim();
        expect(branchExistsInRepo(repoPath, defaultBranch)).toBe("local");
    });

    it('returns "none" for tag names (refs/heads/ restriction)', () => {
        spawnSync("git", ["tag", "v1.0"], { cwd: repoPath, stdio: "pipe" });
        // Tags should NOT match — only branch refs
        expect(branchExistsInRepo(repoPath, "v1.0")).toBe("none");
    });
});

describe("createWorkspace", () => {
    let tmpDir: string;
    let sourceDir: string;

    beforeEach(() => {
        tmpDir = join(tmpdir(), `ccc-test-${randomUUID()}`);
        sourceDir = join(tmpDir, "projects");
        mkdirSync(sourceDir, { recursive: true });
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it("validates branch name before any operations", () => {
        initRepo(join(sourceDir, "repo-a"));
        expect(() => createWorkspace(sourceDir, "--evil")).toThrow(
            /cannot start with '-'/,
        );
        expect(() => createWorkspace(sourceDir, "../etc")).toThrow(
            /cannot contain '..'/,
        );
    });

    it("throws when no git repos found", () => {
        mkdirSync(join(sourceDir, "shared"));
        writeFileSync(join(sourceDir, "file.txt"), "hello");

        expect(() => createWorkspace(sourceDir, "feature")).toThrow(
            /No git repositories found/,
        );
    });

    it("creates worktrees for git repos and copies others", () => {
        initRepo(join(sourceDir, "repo-a"));
        mkdirSync(join(sourceDir, "shared"));
        writeFileSync(join(sourceDir, "shared", "config.json"), '{"a":1}');
        writeFileSync(join(sourceDir, "docker-compose.yml"), "version: 3");

        const result = createWorkspace(sourceDir, "feature");

        // Check workspace was created
        expect(existsSync(result.workspacePath)).toBe(true);

        // Check git worktree
        expect(result.created).toHaveLength(1);
        expect(result.created[0].name).toBe("repo-a");
        expect(result.created[0].branch).toBe("feature");
        expect(result.created[0].action).toBe("worktree-new");

        // Check worktree directory exists
        expect(existsSync(join(result.workspacePath, "repo-a"))).toBe(true);

        // Check copies
        expect(result.copied).toContain("shared");
        expect(result.copied).toContain("docker-compose.yml");

        // Verify copies are independent (not symlinks)
        expect(existsSync(join(result.workspacePath, "shared", "config.json"))).toBe(true);
        const lstat = lstatSync(join(result.workspacePath, "shared"));
        expect(lstat.isSymbolicLink()).toBe(false);
        expect(lstat.isDirectory()).toBe(true);
    });

    it("creates worktree on the correct branch", () => {
        initRepo(join(sourceDir, "repo-a"));

        const result = createWorkspace(sourceDir, "feature/login");

        // Verify branch via git
        const gitResult = spawnSync(
            "git",
            ["rev-parse", "--abbrev-ref", "HEAD"],
            { cwd: join(result.workspacePath, "repo-a"), encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        );
        expect(gitResult.stdout.trim()).toBe("feature/login");
    });

    it("creates worktree from existing local branch", () => {
        initRepo(join(sourceDir, "repo-a"));
        spawnSync("git", ["branch", "existing-branch"], {
            cwd: join(sourceDir, "repo-a"),
            stdio: "pipe",
        });

        const result = createWorkspace(sourceDir, "existing-branch");
        expect(result.created[0].action).toBe("worktree-existing");
    });

    it("handles multiple git repos", () => {
        initRepo(join(sourceDir, "repo-a"));
        initRepo(join(sourceDir, "repo-b"));

        const result = createWorkspace(sourceDir, "multi-test");
        expect(result.created).toHaveLength(2);
        const names = result.created.map((c) => c.name).sort();
        expect(names).toEqual(["repo-a", "repo-b"]);
    });

    it("throws EEXIST when workspace already exists (atomic create)", () => {
        initRepo(join(sourceDir, "repo-a"));

        createWorkspace(sourceDir, "dup-test");

        // Second create should fail with clear message
        expect(() => createWorkspace(sourceDir, "dup-test")).toThrow(
            /already exists/,
        );
    });

    it("rolls back on git worktree failure", () => {
        initRepo(join(sourceDir, "repo-a"));

        // Get current branch name
        const result = spawnSync(
            "git",
            ["rev-parse", "--abbrev-ref", "HEAD"],
            {
                cwd: join(sourceDir, "repo-a"),
                encoding: "utf-8",
                stdio: "pipe",
            },
        );
        const currentBranch = result.stdout.trim();

        // Trying to create worktree for currently checked-out branch fails
        expect(() => createWorkspace(sourceDir, currentBranch)).toThrow(
            /Failed to create worktree/,
        );

        // Workspace directory should be cleaned up (rollback)
        const wsPath = getWorkspacePath(sourceDir, currentBranch);
        expect(existsSync(wsPath)).toBe(false);
    });

    it("rolls back partial worktrees on multi-repo failure", () => {
        initRepo(join(sourceDir, "repo-a"));
        initRepo(join(sourceDir, "repo-b"));

        // Create branch only in repo-a, checkout it in repo-b to cause conflict
        spawnSync("git", ["checkout", "-b", "conflict-branch"], {
            cwd: join(sourceDir, "repo-b"),
            stdio: "pipe",
        });

        // repo-a will succeed (new branch), repo-b will fail (branch checked out)
        expect(() =>
            createWorkspace(sourceDir, "conflict-branch"),
        ).toThrow(/Failed to create worktree/);

        // Workspace directory should be cleaned up
        const wsPath = getWorkspacePath(sourceDir, "conflict-branch");
        expect(existsSync(wsPath)).toBe(false);
    });

    it("creates worktree from remote branch", () => {
        // Create a "remote" bare repo and a local clone
        const bareRepo = join(tmpDir, "bare-origin.git");
        spawnSync("git", ["init", "--bare", bareRepo], { stdio: "pipe" });

        const originClone = join(tmpDir, "origin-clone");
        spawnSync("git", ["clone", bareRepo, originClone], { stdio: "pipe" });
        spawnSync("git", ["config", "user.email", "t@t.com"], {
            cwd: originClone,
            stdio: "pipe",
        });
        spawnSync("git", ["config", "user.name", "T"], {
            cwd: originClone,
            stdio: "pipe",
        });
        writeFileSync(join(originClone, "file.txt"), "content");
        spawnSync("git", ["add", "."], { cwd: originClone, stdio: "pipe" });
        spawnSync("git", ["commit", "-m", "init"], {
            cwd: originClone,
            stdio: "pipe",
        });
        spawnSync("git", ["checkout", "-b", "remote-only"], {
            cwd: originClone,
            stdio: "pipe",
        });
        writeFileSync(join(originClone, "remote.txt"), "remote content");
        spawnSync("git", ["add", "."], { cwd: originClone, stdio: "pipe" });
        spawnSync("git", ["commit", "-m", "remote commit"], {
            cwd: originClone,
            stdio: "pipe",
        });
        spawnSync("git", ["push", "origin", "remote-only"], {
            cwd: originClone,
            stdio: "pipe",
        });
        spawnSync("git", ["checkout", "-"], {
            cwd: originClone,
            stdio: "pipe",
        });
        spawnSync("git", ["push", "origin", "HEAD"], {
            cwd: originClone,
            stdio: "pipe",
        });

        // Clone into source dir
        const repoInSource = join(sourceDir, "repo-remote");
        spawnSync("git", ["clone", bareRepo, repoInSource], {
            stdio: "pipe",
        });
        spawnSync("git", ["fetch", "origin"], {
            cwd: repoInSource,
            stdio: "pipe",
        });

        const wsResult = createWorkspace(sourceDir, "remote-only");
        expect(wsResult.created[0].action).toBe("worktree-remote");
        expect(wsResult.created[0].branch).toBe("remote-only");
    });

    it("handles EEXIST gracefully when workspace dir already exists", () => {
        initRepo(join(sourceDir, "repo-a"));
        writeFileSync(join(sourceDir, "config.yml"), "key: val");

        // Pre-create workspace dir
        const wsPath = getWorkspacePath(sourceDir, "pre-exist");
        mkdirSync(wsPath);

        // Atomic mkdir will throw EEXIST
        expect(() => createWorkspace(sourceDir, "pre-exist")).toThrow(
            /already exists/,
        );
    });
});

describe("removeWorkspace", () => {
    let tmpDir: string;
    let sourceDir: string;

    beforeEach(() => {
        tmpDir = join(tmpdir(), `ccc-test-${randomUUID()}`);
        sourceDir = join(tmpDir, "projects");
        mkdirSync(sourceDir, { recursive: true });
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it("validates branch name", () => {
        expect(() => removeWorkspace(sourceDir, "--evil")).toThrow(
            /cannot start with '-'/,
        );
    });

    it("throws when workspace not found", () => {
        expect(() => removeWorkspace(sourceDir, "nonexistent")).toThrow(
            /Workspace not found/,
        );
    });

    it("removes a workspace with worktrees and copied items", () => {
        initRepo(join(sourceDir, "repo-a"));
        writeFileSync(join(sourceDir, "readme.txt"), "hi");

        const wsResult = createWorkspace(sourceDir, "to-remove");
        expect(existsSync(wsResult.workspacePath)).toBe(true);

        const removeResult = removeWorkspace(sourceDir, "to-remove");
        expect(removeResult.errors).toHaveLength(0);
        expect(removeResult.removed).toContain("repo-a");
        expect(removeResult.removed).toContain("readme.txt");
        expect(existsSync(wsResult.workspacePath)).toBe(false);
    });

    it("reports errors for dirty worktree and removes with force", () => {
        initRepo(join(sourceDir, "repo-a"));

        const wsResult = createWorkspace(sourceDir, "dirty-test");
        writeFileSync(
            join(wsResult.workspacePath, "repo-a", "dirty.txt"),
            "uncommitted",
        );

        // Without force: should report error
        const result = removeWorkspace(sourceDir, "dirty-test");
        expect(result.errors.length).toBeGreaterThan(0);

        // With force: should succeed
        const forceResult = removeWorkspace(sourceDir, "dirty-test", {
            force: true,
        });
        expect(forceResult.removed).toContain("repo-a");
        expect(existsSync(wsResult.workspacePath)).toBe(false);
    });

    it("handles source entries not present in workspace", () => {
        initRepo(join(sourceDir, "repo-a"));

        const wsResult = createWorkspace(sourceDir, "partial");
        expect(existsSync(wsResult.workspacePath)).toBe(true);

        // Add a new item to source after workspace was created
        writeFileSync(join(sourceDir, "new-file.txt"), "new");

        const removeResult = removeWorkspace(sourceDir, "partial");
        expect(removeResult.errors).toHaveLength(0);
        expect(existsSync(wsResult.workspacePath)).toBe(false);
    });

    it("reports error for remaining files without force (M4 fix: no silent data loss)", () => {
        initRepo(join(sourceDir, "repo-a"));

        const wsResult = createWorkspace(sourceDir, "stray-test");

        // Add a stray file directly in workspace
        writeFileSync(join(wsResult.workspacePath, "stray.log"), "data");

        // Without force: should report remaining files as error
        const result = removeWorkspace(sourceDir, "stray-test");
        expect(result.errors.some((e) => /not empty/.test(e))).toBe(true);
        // Directory should still exist
        expect(existsSync(wsResult.workspacePath)).toBe(true);
    });

    it("force-removes workspace with extra files", () => {
        initRepo(join(sourceDir, "repo-a"));

        const wsResult = createWorkspace(sourceDir, "extra-files");
        writeFileSync(join(wsResult.workspacePath, "stray.log"), "data");

        const removeResult = removeWorkspace(sourceDir, "extra-files", {
            force: true,
        });
        expect(existsSync(wsResult.workspacePath)).toBe(false);
    });

    it("removes workspace with copied directories", () => {
        initRepo(join(sourceDir, "repo-a"));
        mkdirSync(join(sourceDir, "shared"));
        writeFileSync(join(sourceDir, "shared", "data.txt"), "hello");

        const wsResult = createWorkspace(sourceDir, "nonsym-test");

        // Copied dir should exist and be removable
        expect(existsSync(join(wsResult.workspacePath, "shared", "data.txt"))).toBe(true);

        const removeResult = removeWorkspace(sourceDir, "nonsym-test");
        expect(removeResult.removed).toContain("repo-a");
        expect(removeResult.removed).toContain("shared");
        expect(existsSync(wsResult.workspacePath)).toBe(false);
    });

    it("fully removes workspace directory during cleanup", () => {
        initRepo(join(sourceDir, "repo-a"));

        const wsResult = createWorkspace(sourceDir, "clean-test");

        const removeResult = removeWorkspace(sourceDir, "clean-test");
        expect(removeResult.errors).toHaveLength(0);
        expect(existsSync(wsResult.workspacePath)).toBe(false);
    });
});

// === Submodule Setup Tests ===

describe("needsSubmoduleSetup", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = join(tmpdir(), `ccc-test-${randomUUID()}`);
        mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns null when directory is already a git repo", () => {
        initRepo(tmpDir);
        expect(needsSubmoduleSetup(tmpDir)).toBeNull();
    });

    it("returns null when no child git repos exist", () => {
        mkdirSync(join(tmpDir, "shared"));
        writeFileSync(join(tmpDir, "file.txt"), "hello");
        expect(needsSubmoduleSetup(tmpDir)).toBeNull();
    });

    it("returns child repo names when setup is needed", () => {
        initRepo(join(tmpDir, "frontend"));
        initRepo(join(tmpDir, "backend"));
        mkdirSync(join(tmpDir, "shared"));

        const result = needsSubmoduleSetup(tmpDir);
        expect(result).not.toBeNull();
        expect(result!.sort()).toEqual(["backend", "frontend"]);
    });
});

describe("initWithSubmodules", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = join(tmpdir(), `ccc-test-${randomUUID()}`);
        mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it("initializes git repo with submodules", () => {
        initRepo(join(tmpDir, "repo-a"));
        mkdirSync(join(tmpDir, "shared"));

        initWithSubmodules(tmpDir);

        // Top-level should now be a git repo
        expect(existsSync(join(tmpDir, ".git"))).toBe(true);

        // .gitmodules should exist with submodule config
        expect(existsSync(join(tmpDir, ".gitmodules"))).toBe(true);

        const gitmodules = readFileSync(
            join(tmpDir, ".gitmodules"),
            "utf-8",
        );
        expect(gitmodules).toContain("[submodule");
        expect(gitmodules).toContain("repo-a");
    });

    it("configures ignore = all and update = rebase", () => {
        initRepo(join(tmpDir, "repo-a"));

        initWithSubmodules(tmpDir);

        const gitmodules = readFileSync(
            join(tmpDir, ".gitmodules"),
            "utf-8",
        );
        // ignore = all: parent won't report submodule changes as dirty
        expect(gitmodules).toContain("ignore = all");
        // update = rebase: follow branch, not pinned to commits
        expect(gitmodules).toContain("update = rebase");
    });

    it("uses remote URL when available", () => {
        // Create a bare "remote" and clone it into tmpDir
        const bareRepo = join(tmpDir, "bare-origin.git");
        spawnSync("git", ["init", "--bare", bareRepo], { stdio: "pipe" });

        const cloneDir = join(tmpDir, "workspace");
        mkdirSync(cloneDir);

        const repoInWorkspace = join(cloneDir, "my-repo");
        spawnSync("git", ["clone", bareRepo, repoInWorkspace], { stdio: "pipe" });
        spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: repoInWorkspace, stdio: "pipe" });
        spawnSync("git", ["config", "user.name", "T"], { cwd: repoInWorkspace, stdio: "pipe" });
        writeFileSync(join(repoInWorkspace, "file.txt"), "content");
        spawnSync("git", ["add", "."], { cwd: repoInWorkspace, stdio: "pipe" });
        spawnSync("git", ["commit", "-m", "init"], { cwd: repoInWorkspace, stdio: "pipe" });

        initWithSubmodules(cloneDir);

        const gitmodules = readFileSync(
            join(cloneDir, ".gitmodules"),
            "utf-8",
        );
        // Should use the remote URL, not a relative path
        expect(gitmodules).toContain(bareRepo);
        expect(gitmodules).not.toContain("url = ./");
    });

    it("prefers master branch when it exists", () => {
        // initRepo creates a repo with default branch (master in test env)
        initRepo(join(tmpDir, "repo-a"));
        // Create another branch and switch to it
        spawnSync("git", ["checkout", "-b", "develop"], {
            cwd: join(tmpDir, "repo-a"),
            stdio: "pipe",
        });

        initWithSubmodules(tmpDir);

        const gitmodules = readFileSync(
            join(tmpDir, ".gitmodules"),
            "utf-8",
        );
        // Should pick master even though current branch is develop
        expect(gitmodules).toContain("branch = master");
    });

    it("falls back to current branch when no master/main", () => {
        initRepo(join(tmpDir, "repo-a"));
        // Rename master to something else
        spawnSync("git", ["branch", "-m", "master", "develop"], {
            cwd: join(tmpDir, "repo-a"),
            stdio: "pipe",
        });

        initWithSubmodules(tmpDir);

        const gitmodules = readFileSync(
            join(tmpDir, ".gitmodules"),
            "utf-8",
        );
        expect(gitmodules).toContain("branch = develop");
    });
});

// === Unified Mode Tests ===

describe("createWorkspace (unified mode)", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = join(tmpdir(), `ccc-test-${randomUUID()}`);
        mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it("creates single worktree when source is a git repo", () => {
        initRepo(tmpDir);
        writeFileSync(join(tmpDir, ".env"), "SECRET=1");
        spawnSync("git", ["add", "."], { cwd: tmpDir, stdio: "pipe" });
        spawnSync("git", ["commit", "-m", "add env"], {
            cwd: tmpDir,
            stdio: "pipe",
        });

        const result = createWorkspace(tmpDir, "feature");

        expect(existsSync(result.workspacePath)).toBe(true);
        expect(result.created).toHaveLength(1);
        expect(result.created[0].action).toBe("worktree-new");
        expect(result.copied).toHaveLength(0);

        // .env should exist in worktree (part of git repo)
        expect(existsSync(join(result.workspacePath, ".env"))).toBe(true);
    });

    it("creates worktree after initWithSubmodules", () => {
        initRepo(join(tmpDir, "repo-a"));
        mkdirSync(join(tmpDir, ".claude"));
        writeFileSync(join(tmpDir, ".claude", "settings.json"), "{}");

        initWithSubmodules(tmpDir);

        const result = createWorkspace(tmpDir, "feature");

        expect(existsSync(result.workspacePath)).toBe(true);
        expect(result.created.length).toBeGreaterThanOrEqual(1);

        // .claude should exist in worktree (tracked by parent git repo)
        expect(
            existsSync(join(result.workspacePath, ".claude", "settings.json")),
        ).toBe(true);

        // Submodule files should be checked out in worktree
        expect(
            existsSync(join(result.workspacePath, "repo-a", "init.txt")),
        ).toBe(true);
    });

    it("creates worktrees for nested git repos not managed as submodules", () => {
        // Top-level is a git repo
        initRepo(tmpDir);

        // Create nested git repos (not submodules, gitignored by parent)
        initRepo(join(tmpDir, "frontend"));
        writeFileSync(join(tmpDir, "frontend", "app.ts"), "export default {}");
        spawnSync("git", ["add", "."], { cwd: join(tmpDir, "frontend"), stdio: "pipe" });
        spawnSync("git", ["commit", "-m", "add app"], { cwd: join(tmpDir, "frontend"), stdio: "pipe" });

        initRepo(join(tmpDir, "backend"));
        writeFileSync(join(tmpDir, "backend", "server.ts"), "export default {}");
        spawnSync("git", ["add", "."], { cwd: join(tmpDir, "backend"), stdio: "pipe" });
        spawnSync("git", ["commit", "-m", "add server"], { cwd: join(tmpDir, "backend"), stdio: "pipe" });

        const result = createWorkspace(tmpDir, "feature");

        expect(existsSync(result.workspacePath)).toBe(true);

        // Nested repos should have worktrees created
        expect(
            existsSync(join(result.workspacePath, "frontend", "app.ts")),
        ).toBe(true);
        expect(
            existsSync(join(result.workspacePath, "backend", "server.ts")),
        ).toBe(true);

        // Should report nested repos in created list
        const createdNames = result.created.map((c) => c.name).sort();
        expect(createdNames).toContain("frontend");
        expect(createdNames).toContain("backend");
    });
});

describe("repairWorkspace", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = join(tmpdir(), `ccc-test-${randomUUID()}`);
        mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it("creates worktrees for missing nested git repos in existing workspace", () => {
        // Setup: top-level git repo with nested repos
        initRepo(tmpDir);
        initRepo(join(tmpDir, "frontend"));
        writeFileSync(join(tmpDir, "frontend", "app.ts"), "export default {}");
        spawnSync("git", ["add", "."], { cwd: join(tmpDir, "frontend"), stdio: "pipe" });
        spawnSync("git", ["commit", "-m", "add app"], { cwd: join(tmpDir, "frontend"), stdio: "pipe" });

        // Create workspace (which now handles nested repos)
        const wsResult = createWorkspace(tmpDir, "repair-test");

        // Simulate a new nested repo added AFTER workspace was created
        initRepo(join(tmpDir, "backend"));
        writeFileSync(join(tmpDir, "backend", "server.ts"), "export default {}");
        spawnSync("git", ["add", "."], { cwd: join(tmpDir, "backend"), stdio: "pipe" });
        spawnSync("git", ["commit", "-m", "add server"], { cwd: join(tmpDir, "backend"), stdio: "pipe" });

        // backend/ doesn't exist in workspace yet
        expect(existsSync(join(wsResult.workspacePath, "backend", "server.ts"))).toBe(false);

        // Repair should create the missing worktree
        const repaired = repairWorkspace(tmpDir, wsResult.workspacePath, "repair-test");

        expect(repaired.length).toBeGreaterThanOrEqual(1);
        const repairedNames = repaired.map((r) => r.name);
        expect(repairedNames).toContain("backend");

        // backend files should now exist
        expect(existsSync(join(wsResult.workspacePath, "backend", "server.ts"))).toBe(true);
    });

    it("skips nested repos that are already valid worktrees", () => {
        initRepo(tmpDir);
        initRepo(join(tmpDir, "frontend"));

        const wsResult = createWorkspace(tmpDir, "skip-test");

        // frontend should already be a worktree in the workspace
        expect(existsSync(join(wsResult.workspacePath, "frontend"))).toBe(true);

        // Repair should skip it (already a valid worktree)
        const repaired = repairWorkspace(tmpDir, wsResult.workspacePath, "skip-test");
        const repairedNames = repaired.map((r) => r.name);
        expect(repairedNames).not.toContain("frontend");
    });

    it("auto-fixes nested repos with content that are not valid worktrees", () => {
        initRepo(tmpDir);
        initRepo(join(tmpDir, "frontend"));
        writeFileSync(join(tmpDir, "frontend", "app.ts"), "export default {}");
        spawnSync("git", ["add", "."], { cwd: join(tmpDir, "frontend"), stdio: "pipe" });
        spawnSync("git", ["commit", "-m", "add app"], { cwd: join(tmpDir, "frontend"), stdio: "pipe" });

        // Create workspace (top-level only, no nested worktrees yet)
        const wsPath = getWorkspacePath(tmpDir, "autofix-test");
        spawnSync("git", ["worktree", "add", wsPath, "-b", "autofix-test"], {
            cwd: tmpDir, encoding: "utf-8", stdio: "pipe",
        });

        // Simulate submodule checkout: copy frontend as a regular git repo (not a worktree)
        const destFrontend = join(wsPath, "frontend");
        mkdirSync(destFrontend, { recursive: true });
        // Clone the source repo to simulate a submodule checkout
        spawnSync("git", ["clone", join(tmpDir, "frontend"), destFrontend], {
            encoding: "utf-8", stdio: "pipe",
        });
        expect(existsSync(join(destFrontend, "app.ts"))).toBe(true);

        // Verify it's NOT a valid worktree (it's a clone, not a worktree)
        const gitPath = join(destFrontend, ".git");
        expect(statSync(gitPath).isDirectory()).toBe(true); // .git is a directory, not a file

        // Repair should auto-fix it
        const repaired = repairWorkspace(tmpDir, wsPath, "autofix-test");
        const repairedNames = repaired.map((r) => r.name);
        expect(repairedNames).toContain("frontend");

        // Should now be a valid worktree with content preserved
        expect(existsSync(join(destFrontend, "app.ts"))).toBe(true);
        const gitStat = lstatSync(join(destFrontend, ".git"));
        expect(gitStat.isFile()).toBe(true); // .git is now a file (worktree gitlink)
    });

    it("auto-fixes submodule gitlink to proper worktree", () => {
        // Setup: parent repo + nested independent repo
        initRepo(tmpDir);
        initRepo(join(tmpDir, "backend"));
        writeFileSync(join(tmpDir, "backend", "api.ts"), "export const api = true;");
        spawnSync("git", ["add", "."], { cwd: join(tmpDir, "backend"), stdio: "pipe" });
        spawnSync("git", ["commit", "-m", "add api"], { cwd: join(tmpDir, "backend"), stdio: "pipe" });

        // Create workspace (top-level worktree only)
        const wsPath = getWorkspacePath(tmpDir, "submod-fix");
        spawnSync("git", ["worktree", "add", wsPath, "-b", "submod-fix"], {
            cwd: tmpDir, encoding: "utf-8", stdio: "pipe",
        });

        // Simulate submodule checkout: .git FILE pointing to parent's modules
        const destBackend = join(wsPath, "backend");
        mkdirSync(destBackend, { recursive: true });
        writeFileSync(join(destBackend, "api.ts"), "export const api = true;");

        // Create fake parent modules dir and write .git gitlink
        const fakeModulesDir = join(tmpDir, ".git", "worktrees", basename(wsPath), "modules", "backend");
        mkdirSync(fakeModulesDir, { recursive: true });
        writeFileSync(join(destBackend, ".git"), `gitdir: ${fakeModulesDir}\n`);

        // Verify pre-condition: has .git file but NOT a valid worktree of backend
        expect(lstatSync(join(destBackend, ".git")).isFile()).toBe(true);
        expect(isValidWorktree(destBackend, join(tmpDir, "backend"))).toBe(false);

        // Repair should auto-fix: replace submodule checkout with proper worktree
        const repaired = repairWorkspace(tmpDir, wsPath, "submod-fix");
        const repairedNames = repaired.map((r) => r.name);
        expect(repairedNames).toContain("backend");

        // Should now be a valid worktree
        expect(isValidWorktree(destBackend, join(tmpDir, "backend"))).toBe(true);

        // Content should be preserved
        expect(existsSync(join(destBackend, "api.ts"))).toBe(true);
    });

    it("returns empty array for non-git-repo source", () => {
        mkdirSync(join(tmpDir, "workspace"));
        const repaired = repairWorkspace(tmpDir, join(tmpDir, "workspace"), "test");
        expect(repaired).toEqual([]);
    });

    it("returns empty array when no nested repos exist", () => {
        initRepo(tmpDir);
        const wsResult = createWorkspace(tmpDir, "no-nested");
        const repaired = repairWorkspace(tmpDir, wsResult.workspacePath, "no-nested");
        expect(repaired).toEqual([]);
    });
});

describe("isValidWorktree", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = join(tmpdir(), `ccc-test-${randomUUID()}`);
        mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns true for a valid worktree", () => {
        initRepo(tmpDir);
        initRepo(join(tmpDir, "frontend"));

        const wsResult = createWorkspace(tmpDir, "valid-wt");
        // frontend should be a valid worktree of the source
        expect(isValidWorktree(
            join(wsResult.workspacePath, "frontend"),
            join(tmpDir, "frontend"),
        )).toBe(true);
    });

    it("returns false for directory without .git", () => {
        const dir = join(tmpDir, "no-git");
        mkdirSync(dir);
        writeFileSync(join(dir, "file.txt"), "hello");
        expect(isValidWorktree(dir, tmpDir)).toBe(false);
    });

    it("returns false for regular git repo (not a worktree)", () => {
        initRepo(join(tmpDir, "regular-repo"));
        expect(isValidWorktree(join(tmpDir, "regular-repo"), tmpDir)).toBe(false);
    });

    it("returns false for non-existent directory", () => {
        expect(isValidWorktree(join(tmpDir, "nope"), tmpDir)).toBe(false);
    });

    it("returns true for valid worktree when source repo is a submodule (gitlink .git file)", () => {
        // Setup: parent repo with a submodule-like nested repo
        const parentGitDir = join(tmpDir, "parent", ".git");
        mkdirSync(parentGitDir, { recursive: true });

        // The "source" nested repo has .git as a FILE (submodule gitlink)
        // pointing to the parent's modules directory — this is how git submodules work
        const sourceRepo = join(tmpDir, "parent", "backend");
        const modulesDir = join(parentGitDir, "modules", "backend");
        mkdirSync(sourceRepo, { recursive: true });
        // Initialize a real git repo inside modules dir (the actual git storage)
        spawnSync("git", ["init", "--bare", modulesDir], { stdio: "pipe" });
        // Source .git is a gitlink file → parent's modules
        writeFileSync(join(sourceRepo, ".git"), `gitdir: ${modulesDir}\n`);
        // Make git recognize this as a valid repo
        spawnSync("git", ["config", "core.bare", "false"], { cwd: sourceRepo, stdio: "pipe" });
        spawnSync("git", ["-c", "user.name=test", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init"], { cwd: sourceRepo, stdio: "pipe" });

        // Create a worktree from this submodule source
        const wtDest = join(tmpDir, "ws", "backend");
        spawnSync("git", ["worktree", "add", "-b", "feat", wtDest], { cwd: sourceRepo, stdio: "pipe" });

        // The worktree .git file should point to modules/backend/worktrees/backend
        // isValidWorktree must return TRUE — it's a valid worktree of the source
        expect(existsSync(join(wtDest, ".git"))).toBe(true);
        expect(isValidWorktree(wtDest, sourceRepo)).toBe(true);
    });

    it("returns false for submodule gitlink (points to parent modules, not source worktrees)", () => {
        // Setup: source repo (what we'd want a worktree of)
        initRepo(join(tmpDir, "backend"));

        // Simulate a submodule checkout: directory with .git file pointing
        // to parent's modules dir (not backend's worktrees dir)
        const fakeSubmodule = join(tmpDir, "ws", "backend");
        mkdirSync(fakeSubmodule, { recursive: true });
        writeFileSync(join(fakeSubmodule, "server.ts"), "export default {}");

        // Create the parent .git/modules/backend directory to make the gitdir valid
        const parentModules = join(tmpDir, "parent-repo", ".git", "worktrees", "ws", "modules", "backend");
        mkdirSync(parentModules, { recursive: true });

        // .git file points to parent's modules, NOT to backend's .git/worktrees/
        writeFileSync(
            join(fakeSubmodule, ".git"),
            `gitdir: ${parentModules}\n`,
        );

        // isValidWorktree should reject this — it points to parent's modules, not backend's worktrees
        expect(isValidWorktree(fakeSubmodule, join(tmpDir, "backend"))).toBe(false);
    });
});

describe("detectBrokenWorktrees", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = join(tmpdir(), `ccc-test-${randomUUID()}`);
        mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it("detects directory with content that is not a valid worktree", () => {
        initRepo(tmpDir);
        initRepo(join(tmpDir, "frontend"));

        const wsResult = createWorkspace(tmpDir, "broken-detect");

        // Simulate broken state: remove the worktree and put loose files
        spawnSync("git", ["worktree", "remove", "--force",
            join(wsResult.workspacePath, "frontend")], {
            cwd: join(tmpDir, "frontend"), stdio: "pipe",
        });
        mkdirSync(join(wsResult.workspacePath, "frontend"));
        writeFileSync(join(wsResult.workspacePath, "frontend", "dirty.ts"), "dirty");

        const broken = detectBrokenWorktrees(tmpDir, wsResult.workspacePath);
        expect(broken).toHaveLength(1);
        expect(broken[0].name).toBe("frontend");
    });

    it("returns empty for valid worktrees", () => {
        initRepo(tmpDir);
        initRepo(join(tmpDir, "frontend"));

        const wsResult = createWorkspace(tmpDir, "all-good");

        const broken = detectBrokenWorktrees(tmpDir, wsResult.workspacePath);
        expect(broken).toHaveLength(0);
    });

    it("returns empty for non-git-repo source", () => {
        mkdirSync(join(tmpDir, "ws"));
        expect(detectBrokenWorktrees(tmpDir, join(tmpDir, "ws"))).toEqual([]);
    });
});

describe("fixBrokenWorktree", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = join(tmpdir(), `ccc-test-${randomUUID()}`);
        mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it("backs up content, creates worktree, restores content", () => {
        initRepo(tmpDir);
        initRepo(join(tmpDir, "frontend"));
        writeFileSync(join(tmpDir, "frontend", "app.ts"), "original");
        spawnSync("git", ["add", "."], { cwd: join(tmpDir, "frontend"), stdio: "pipe" });
        spawnSync("git", ["commit", "-m", "add app"], { cwd: join(tmpDir, "frontend"), stdio: "pipe" });

        const wsResult = createWorkspace(tmpDir, "fix-broken");

        // Simulate broken state: remove worktree, put custom content
        spawnSync("git", ["worktree", "remove", "--force",
            join(wsResult.workspacePath, "frontend")], {
            cwd: join(tmpDir, "frontend"), stdio: "pipe",
        });
        mkdirSync(join(wsResult.workspacePath, "frontend"));
        writeFileSync(join(wsResult.workspacePath, "frontend", "wip.ts"), "work in progress");

        const result = fixBrokenWorktree(tmpDir, wsResult.workspacePath, "frontend", "fix-broken");

        expect(result).not.toBeNull();
        expect(result!.name).toBe("frontend");

        // Original repo file should be in worktree (from git)
        expect(existsSync(join(wsResult.workspacePath, "frontend", "app.ts"))).toBe(true);

        // Backed up file should be restored
        expect(existsSync(join(wsResult.workspacePath, "frontend", "wip.ts"))).toBe(true);
        expect(readFileSync(join(wsResult.workspacePath, "frontend", "wip.ts"), "utf-8")).toBe("work in progress");

        // Backup should be cleaned up
        expect(existsSync(wsResult.workspacePath + ".ccc-backup")).toBe(false);
    });

    it("returns null for non-existent repo name", () => {
        initRepo(tmpDir);
        const wsResult = createWorkspace(tmpDir, "no-repo");
        const result = fixBrokenWorktree(tmpDir, wsResult.workspacePath, "nonexistent", "no-repo");
        expect(result).toBeNull();
    });

    it("restores backup if worktree creation fails", () => {
        initRepo(tmpDir);
        initRepo(join(tmpDir, "frontend"));

        const wsResult = createWorkspace(tmpDir, "fail-fix");

        // Simulate broken state
        spawnSync("git", ["worktree", "remove", "--force",
            join(wsResult.workspacePath, "frontend")], {
            cwd: join(tmpDir, "frontend"), stdio: "pipe",
        });
        mkdirSync(join(wsResult.workspacePath, "frontend"));
        writeFileSync(join(wsResult.workspacePath, "frontend", "precious.ts"), "don't lose me");

        // Make worktree creation fail by checking out the same branch in the source
        spawnSync("git", ["checkout", "fail-fix"], {
            cwd: join(tmpDir, "frontend"), stdio: "pipe",
        });

        // fail-fix branch is now checked out in source, so worktree add should fail
        const result = fixBrokenWorktree(tmpDir, wsResult.workspacePath, "frontend", "fail-fix");

        // Should fail gracefully
        expect(result).toBeNull();

        // Content should be restored (not lost)
        expect(existsSync(join(wsResult.workspacePath, "frontend", "precious.ts"))).toBe(true);
        expect(readFileSync(join(wsResult.workspacePath, "frontend", "precious.ts"), "utf-8")).toBe("don't lose me");
    });
    it("succeeds with stale worktree registration (prune cleans it up)", () => {
        initRepo(tmpDir);
        initRepo(join(tmpDir, "frontend"));
        writeFileSync(join(tmpDir, "frontend", "app.ts"), "original");
        spawnSync("git", ["add", "."], { cwd: join(tmpDir, "frontend"), stdio: "pipe" });
        spawnSync("git", ["commit", "-m", "add app"], { cwd: join(tmpDir, "frontend"), stdio: "pipe" });

        const wsResult = createWorkspace(tmpDir, "stale-wt");

        // frontend is now a worktree on branch "stale-wt"
        const wsFrontend = join(wsResult.workspacePath, "frontend");
        expect(isValidWorktree(wsFrontend, join(tmpDir, "frontend"))).toBe(true);

        // Simulate: delete the worktree directory WITHOUT git cleanup
        // This leaves a stale registration in frontend/.git/worktrees/
        rmSync(wsFrontend, { recursive: true, force: true });

        // Put non-worktree content back (simulating submodule re-init)
        mkdirSync(wsFrontend);
        writeFileSync(join(wsFrontend, "app.ts"), "submodule version");
        writeFileSync(join(wsFrontend, ".git"), "gitdir: /some/fake/modules/path\n");

        // Without prune, git worktree add would fail because "stale-wt" is
        // still registered. With prune (in fixBrokenWorktree), it should succeed.
        const result = fixBrokenWorktree(tmpDir, wsResult.workspacePath, "frontend", "stale-wt");

        expect(result).not.toBeNull();
        expect(result!.name).toBe("frontend");

        // Should be a valid worktree now
        expect(isValidWorktree(wsFrontend, join(tmpDir, "frontend"))).toBe(true);

        // Content should be preserved
        expect(existsSync(join(wsFrontend, "app.ts"))).toBe(true);
    });
});

describe("removeWorkspace (unified mode)", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = join(tmpdir(), `ccc-test-${randomUUID()}`);
        mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it("removes unified worktree", () => {
        initRepo(tmpDir);

        const wsResult = createWorkspace(tmpDir, "to-remove");
        expect(existsSync(wsResult.workspacePath)).toBe(true);

        const removeResult = removeWorkspace(tmpDir, "to-remove");
        expect(removeResult.errors).toHaveLength(0);
        expect(removeResult.removed).toHaveLength(1);
        expect(existsSync(wsResult.workspacePath)).toBe(false);
    });

    it("removes unified worktree with nested git repo worktrees", () => {
        initRepo(tmpDir);
        initRepo(join(tmpDir, "frontend"));

        const wsResult = createWorkspace(tmpDir, "nested-rm");
        expect(existsSync(wsResult.workspacePath)).toBe(true);
        expect(existsSync(join(wsResult.workspacePath, "frontend"))).toBe(true);

        const removeResult = removeWorkspace(tmpDir, "nested-rm");
        expect(removeResult.errors).toHaveLength(0);
        expect(removeResult.removed).toContain("frontend");
        expect(existsSync(wsResult.workspacePath)).toBe(false);
    });
});

// === getWorktreeGitMounts Tests ===

describe("getWorktreeGitMounts", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = join(tmpdir(), `wt-mounts-${randomUUID()}`);
        mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns empty for regular git repo (not a worktree)", () => {
        const repoPath = join(tmpDir, "repo");
        initRepo(repoPath);

        const mounts = getWorktreeGitMounts(repoPath);
        expect(mounts).toEqual([]);
    });

    it("returns empty for non-existent directory", () => {
        const mounts = getWorktreeGitMounts(join(tmpDir, "nonexistent"));
        expect(mounts).toEqual([]);
    });

    it("returns empty for non-git directory", () => {
        const dirPath = join(tmpDir, "plain");
        mkdirSync(dirPath);
        writeFileSync(join(dirPath, "file.txt"), "hello");

        const mounts = getWorktreeGitMounts(dirPath);
        expect(mounts).toEqual([]);
    });

    it("returns mounts for a worktree directory", () => {
        const repoPath = join(tmpDir, "source");
        initRepo(repoPath);

        const wtPath = join(tmpDir, "source--feat");
        spawnSync("git", ["worktree", "add", "-b", "feat", wtPath], {
            cwd: repoPath,
            stdio: "pipe",
        });

        const mounts = getWorktreeGitMounts(wtPath);
        expect(mounts.length).toBeGreaterThanOrEqual(1);

        // Should include mount at the absolute host path of source .git
        const sourceGitDir = join(repoPath, ".git");
        const absoluteMount = mounts.find((m) => m.hostPath === sourceGitDir && m.containerPath === sourceGitDir);
        expect(absoluteMount).toBeDefined();

        // Should include mount at /project/<basename>/.git for relative refs
        const relativeMount = mounts.find((m) => m.containerPath === "/project/source/.git");
        expect(relativeMount).toBeDefined();
        expect(relativeMount!.hostPath).toBe(sourceGitDir);
    });

    it("includes nested git repo mounts", () => {
        const repoPath = join(tmpDir, "parent");
        initRepo(repoPath);

        // Create nested git repo
        const nestedPath = join(repoPath, "nested-repo");
        initRepo(nestedPath);

        // Gitignore the nested repo in parent
        writeFileSync(join(repoPath, ".gitignore"), "nested-repo/\n");
        spawnSync("git", ["add", ".gitignore"], { cwd: repoPath, stdio: "pipe" });
        spawnSync("git", ["commit", "-m", "ignore nested"], { cwd: repoPath, stdio: "pipe" });

        // Create worktree of parent
        const wtPath = join(tmpDir, "parent--feat");
        spawnSync("git", ["worktree", "add", "-b", "feat", wtPath], {
            cwd: repoPath,
            stdio: "pipe",
        });

        const mounts = getWorktreeGitMounts(wtPath);

        // Should have mounts for parent .git
        const parentGitDir = join(repoPath, ".git");
        expect(mounts.some((m) => m.hostPath === parentGitDir)).toBe(true);

        // Should have mounts for nested repo .git
        const nestedGitDir = join(nestedPath, ".git");
        expect(mounts.some((m) => m.hostPath === nestedGitDir)).toBe(true);

        // Should have relative mount for nested repo
        expect(mounts.some((m) => m.containerPath === "/project/parent/nested-repo/.git")).toBe(true);
    });

    it("deduplicates identical mounts", () => {
        const repoPath = join(tmpDir, "dedup");
        initRepo(repoPath);

        const wtPath = join(tmpDir, "dedup--feat");
        spawnSync("git", ["worktree", "add", "-b", "feat", wtPath], {
            cwd: repoPath,
            stdio: "pipe",
        });

        const mounts = getWorktreeGitMounts(wtPath);
        const keys = mounts.map((m) => `${m.hostPath}:${m.containerPath}`);
        const uniqueKeys = new Set(keys);
        expect(keys.length).toBe(uniqueKeys.size);
    });
});
