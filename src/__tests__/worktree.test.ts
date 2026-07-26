import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
    mkdirSync,
    readdirSync,
    writeFileSync,
    rmSync,
    existsSync,
    symlinkSync,
    readFileSync,
    lstatSync,
    renameSync,
    statSync,
    chmodSync,
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
    containerGitSourceMountPath,
    portableWorktreeGitDirectory,
    assertWorkspaceBranch,
    detectWorktreeWorkspaceBranch,
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
    spawnSync("git", ["config", "commit.gpgsign", "false"], {
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

function installFailingCheckoutHook(repoPath: string): void {
    const hook = join(repoPath, ".git", "hooks", "post-checkout");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
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

    it("uses the documented exact-ref missing status for an absent branch", () => {
        const runner = vi.fn(() => ({
            pid: 1,
            output: [null, "", ""],
            stdout: "",
            stderr: "",
            status: 1,
            signal: null,
        })) as unknown as typeof spawnSync;

        expect(branchExistsInRepo(repoPath, "new-on-windows", runner)).toBe("none");
        expect(runner).toHaveBeenNthCalledWith(
            1,
            "git",
            ["show-ref", "--quiet", "--verify", "--", "refs/heads/new-on-windows"],
            expect.objectContaining({ cwd: repoPath }),
        );
        expect(runner).toHaveBeenNthCalledWith(
            2,
            "git",
            ["show-ref", "--quiet", "--verify", "--", "refs/remotes/origin/new-on-windows"],
            expect.objectContaining({ cwd: repoPath }),
        );
    });

    it("fails closed when Git for Windows cannot spawn exact-ref inspection", () => {
        const error = Object.assign(new Error("spawnSync git EINVAL"), { code: "EINVAL" });
        const runner = vi.fn(() => ({
            pid: 0,
            output: [null, null, null],
            stdout: null,
            stderr: null,
            status: null,
            signal: null,
            error,
        })) as unknown as typeof spawnSync;

        expect(() => branchExistsInRepo(repoPath, "new-on-windows", runner))
            .toThrow("Unable to inspect local branch 'new-on-windows' (spawn-EINVAL).");
    });

    it("fails closed when exact-ref inspection fails", () => {
        const runner = vi.fn(() => ({
            pid: 1,
            output: [null, "", "fatal"],
            stdout: "",
            stderr: "fatal",
            status: 128,
            signal: null,
        })) as unknown as typeof spawnSync;

        expect(() => branchExistsInRepo(repoPath, "new-on-windows", runner))
            .toThrow("Unable to inspect local branch 'new-on-windows' (exit-128).");
    });

    it("fails closed when remote exact-ref inspection fails", () => {
        const runner = (vi.fn()
            .mockReturnValueOnce({ pid: 1, output: [null, "", ""], stdout: "", stderr: "", status: 1, signal: null })
            .mockReturnValueOnce({ pid: 1, output: [null, "", "fatal"], stdout: "", stderr: "fatal", status: 128, signal: null })) as unknown as typeof spawnSync;

        expect(() => branchExistsInRepo(repoPath, "new-on-windows", runner))
            .toThrow("Unable to inspect remote branch 'new-on-windows' (exit-128).");
    });

    it("does not treat a missing exact ref as a prefix descendant", () => {
        const runner = (vi.fn()
            .mockReturnValueOnce({ pid: 1, output: [null, "", ""], stdout: "", stderr: "", status: 1, signal: null })
            .mockReturnValueOnce({ pid: 1, output: [null, "", ""], stdout: "", stderr: "", status: 1, signal: null })) as unknown as typeof spawnSync;

        expect(branchExistsInRepo(repoPath, "feature", runner)).toBe("none");
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
        expect(branchExistsInRepo(join(sourceDir, "repo-a"), "conflict-branch"))
            .toBe("none");
    });

    it("rolls back a unified workspace when nested worktree creation fails", () => {
        initRepo(sourceDir);
        const nestedRepo = join(sourceDir, "nested");
        initRepo(nestedRepo);
        spawnSync("git", ["switch", "-c", "nested-conflict"], {
            cwd: nestedRepo,
            stdio: "pipe",
        });

        expect(() => createWorkspace(sourceDir, "nested-conflict"))
            .toThrow("Failed to create nested worktree for nested");
        expect(existsSync(getWorkspacePath(sourceDir, "nested-conflict"))).toBe(false);
        expect(branchExistsInRepo(sourceDir, "nested-conflict")).toBe("none");
    });

    it("rolls back a side-effecting failed multi-repo worktree add", () => {
        const repoPath = join(sourceDir, "repo-a");
        initRepo(repoPath);
        installFailingCheckoutHook(repoPath);

        expect(() => createWorkspace(sourceDir, "hook-failure"))
            .toThrow("Failed to create worktree for repo-a");

        const wsPath = getWorkspacePath(sourceDir, "hook-failure");
        expect(existsSync(wsPath)).toBe(false);
        expect(branchExistsInRepo(repoPath, "hook-failure")).toBe("none");
        const listed = spawnSync("git", ["worktree", "list", "--porcelain"], {
            cwd: repoPath,
            encoding: "utf-8",
        });
        expect(listed.stdout).not.toContain(wsPath);
    });

    it.skipIf(process.platform === "win32")("preserves a replacement worktree during later multi-repo rollback", () => {
        const firstRepo = join(sourceDir, "a-first");
        const failingRepo = join(sourceDir, "z-failing");
        const branch = "later-rollback-race";
        const workspace = getWorkspacePath(sourceDir, branch);
        const firstDestination = join(workspace, "a-first");
        const movedFirstDestination = `${firstDestination}.owned`;
        const foreignWorktree = join(tmpDir, "foreign-replacement-worktree");
        initRepo(firstRepo);
        initRepo(failingRepo);
        spawnSync("git", ["worktree", "add", "-b", "foreign-replacement", foreignWorktree], {
            cwd: firstRepo,
            stdio: "pipe",
        });
        const hook = join(failingRepo, ".git", "hooks", "post-checkout");
        writeFileSync(
            hook,
            [
                "#!/bin/sh",
                `mv "${firstDestination}" "${movedFirstDestination}"`,
                `mv "${foreignWorktree}" "${firstDestination}"`,
                `git -C "${firstRepo}" worktree repair "${firstDestination}"`,
                "exit 1",
                "",
            ].join("\n"),
        );
        chmodSync(hook, 0o755);

        expect(() => createWorkspace(sourceDir, branch))
            .toThrow("registration ownership changed");
        expect(isValidWorktree(firstDestination, firstRepo)).toBe(true);
        expect(detectWorktreeWorkspaceBranch(firstDestination))
            .toBe("foreign-replacement");
        expect(branchExistsInRepo(firstRepo, branch)).toBe("local");

        rmSync(hook);
        spawnSync("git", ["worktree", "remove", "--force", firstDestination], {
            cwd: firstRepo,
            stdio: "pipe",
        });
        spawnSync("git", ["worktree", "repair", movedFirstDestination], {
            cwd: firstRepo,
            stdio: "pipe",
        });
        spawnSync("git", ["worktree", "remove", "--force", movedFirstDestination], {
            cwd: firstRepo,
            stdio: "pipe",
        });
        spawnSync("git", ["branch", "-D", branch], {
            cwd: firstRepo,
            stdio: "pipe",
        });
        rmSync(workspace, { recursive: true, force: true });
    });

    it.skipIf(process.platform === "win32")("fails and rolls back when a source entry cannot be copied safely", () => {
        initRepo(join(sourceDir, "repo-a"));
        const configDir = join(sourceDir, "config");
        mkdirSync(configDir);
        writeFileSync(join(configDir, "target.txt"), "target");
        symlinkSync("target.txt", join(configDir, "linked.txt"));

        expect(() => createWorkspace(sourceDir, "unsafe-copy"))
            .toThrow("symbolic link that cannot be copied safely");
        const workspace = getWorkspacePath(sourceDir, "unsafe-copy");
        expect(existsSync(workspace)).toBe(true);
        expect(existsSync(join(workspace, "config"))).toBe(true);
        expect(branchExistsInRepo(join(sourceDir, "repo-a"), "unsafe-copy"))
            .toBe("none");
        rmSync(workspace, { recursive: true, force: true });
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
        spawnSync("git", ["config", "commit.gpgsign", "false"], {
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
        spawnSync("git", ["config", "--local", "branch.autoSetupRebase", "remote"], {
            cwd: repoInSource,
            stdio: "pipe",
        });

        const wsResult = createWorkspace(sourceDir, "remote-only");
        expect(wsResult.created[0].action).toBe("worktree-remote");
        expect(wsResult.created[0].branch).toBe("remote-only");
        const upstream = spawnSync(
            "git",
            ["rev-parse", "--abbrev-ref", "remote-only@{upstream}"],
            { cwd: repoInSource, encoding: "utf-8" },
        );
        expect(upstream.status).toBe(0);
        expect(upstream.stdout.trim()).toBe("origin/remote-only");
        const rebase = spawnSync(
            "git",
            ["config", "--local", "--get", "branch.remote-only.rebase"],
            { cwd: repoInSource, encoding: "utf-8" },
        );
        expect(rebase.stdout.trim()).toBe("true");
    });

    it("restores pre-existing tracking config when remote worktree checkout fails", () => {
        const bareRepo = join(tmpDir, "rollback-origin.git");
        const publisher = join(tmpDir, "rollback-publisher");
        const repoInSource = join(sourceDir, "repo-remote-rollback");
        spawnSync("git", ["init", "--bare", bareRepo], { stdio: "pipe" });
        spawnSync("git", ["clone", bareRepo, publisher], { stdio: "pipe" });
        spawnSync("git", ["config", "user.email", "t@t.com"], {
            cwd: publisher,
            stdio: "pipe",
        });
        spawnSync("git", ["config", "user.name", "T"], {
            cwd: publisher,
            stdio: "pipe",
        });
        writeFileSync(join(publisher, "file.txt"), "content");
        spawnSync("git", ["add", "."], { cwd: publisher, stdio: "pipe" });
        spawnSync("git", ["commit", "-m", "init"], { cwd: publisher, stdio: "pipe" });
        spawnSync("git", ["switch", "-c", "remote-rollback"], {
            cwd: publisher,
            stdio: "pipe",
        });
        spawnSync("git", ["push", "origin", "remote-rollback"], {
            cwd: publisher,
            stdio: "pipe",
        });
        spawnSync("git", ["clone", bareRepo, repoInSource], { stdio: "pipe" });
        spawnSync("git", ["fetch", "origin"], { cwd: repoInSource, stdio: "pipe" });
        spawnSync("git", ["config", "--local", "branch.autoSetupRebase", "remote"], {
            cwd: repoInSource,
            stdio: "pipe",
        });
        spawnSync(
            "git",
            ["config", "--local", "--add", "branch.remote-rollback.remote", "pre-existing"],
            { cwd: repoInSource, stdio: "pipe" },
        );
        spawnSync(
            "git",
            ["config", "--local", "--add", "branch.remote-rollback.merge", "refs/heads/old"],
            { cwd: repoInSource, stdio: "pipe" },
        );
        const hook = join(repoInSource, ".git", "hooks", "post-checkout");
        writeFileSync(
            hook,
            [
                "#!/bin/sh",
                "git update-ref -d refs/heads/remote-rollback",
                "exit 1",
                "",
            ].join("\n"),
        );
        chmodSync(hook, 0o755);

        expect(() => createWorkspace(sourceDir, "remote-rollback"))
            .toThrow("Failed to create worktree");
        expect(branchExistsInRepo(repoInSource, "remote-rollback")).toBe("remote");
        const workspace = getWorkspacePath(sourceDir, "remote-rollback");
        expect(existsSync(workspace)).toBe(false);
        const listed = spawnSync("git", ["worktree", "list", "--porcelain"], {
            cwd: repoInSource,
            encoding: "utf-8",
        });
        expect(listed.stdout).not.toContain(workspace);
        const remote = spawnSync(
            "git",
            ["config", "--local", "--get-all", "branch.remote-rollback.remote"],
            { cwd: repoInSource, encoding: "utf-8" },
        );
        const merge = spawnSync(
            "git",
            ["config", "--local", "--get-all", "branch.remote-rollback.merge"],
            { cwd: repoInSource, encoding: "utf-8" },
        );
        const rebase = spawnSync(
            "git",
            ["config", "--local", "--get-all", "branch.remote-rollback.rebase"],
            { cwd: repoInSource, encoding: "utf-8" },
        );
        expect(remote.stdout.trim()).toBe("pre-existing");
        expect(merge.stdout.trim()).toBe("refs/heads/old");
        expect(rebase.status).toBe(1);
    });

    it("creates a new branch with autoSetupMerge enabled without leaking tracking config", () => {
        const repoPath = join(sourceDir, "repo-auto-merge");
        initRepo(repoPath);
        spawnSync("git", ["config", "--local", "branch.autoSetupMerge", "always"], {
            cwd: repoPath,
            stdio: "pipe",
        });

        const result = createWorkspace(sourceDir, "auto-merge-new");
        expect(result.created[0].action).toBe("worktree-new");
        const remote = spawnSync(
            "git",
            ["config", "--local", "--get-all", "branch.auto-merge-new.remote"],
            { cwd: repoPath, encoding: "utf-8" },
        );
        expect(remote.status).toBe(1);
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

describe("assertWorkspaceBranch", () => {
    let repoPath: string;

    beforeEach(() => {
        repoPath = join(tmpdir(), `wt-branch-guard-${randomUUID()}`);
        initRepo(repoPath);
    });

    afterEach(() => {
        rmSync(getWorkspacePath(repoPath, "feature-login"), { recursive: true, force: true });
        rmSync(repoPath, { recursive: true, force: true });
    });

    it("accepts only the exact checked-out branch", () => {
        const current = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
            cwd: repoPath,
            encoding: "utf-8",
        }).stdout.trim();
        expect(() => assertWorkspaceBranch(repoPath, current)).not.toThrow();
        expect(detectWorktreeWorkspaceBranch(repoPath)).toBeNull();
        expect(() => assertWorkspaceBranch(repoPath, "feature/login"))
            .toThrow("not 'feature/login'");
    });

    it("rejects a missing workspace before session registration or removal", () => {
        const missing = join(repoPath, "missing");
        expect(() => assertWorkspaceBranch(missing, "feature"))
            .toThrow("no longer exists");
    });

    it("rejects branch names that collide to the same workspace directory", () => {
        const slashBranch = getWorkspacePath(repoPath, "feature/login");
        const dashBranch = getWorkspacePath(repoPath, "feature-login");
        expect(slashBranch).toBe(dashBranch);

        spawnSync("git", ["branch", "feature-login"], { cwd: repoPath, stdio: "pipe" });
        spawnSync("git", ["worktree", "add", dashBranch, "feature-login"], {
            cwd: repoPath,
            stdio: "pipe",
        });

        expect(() => assertWorkspaceBranch(slashBranch, "feature/login"))
            .toThrow("belongs to branch 'feature-login'");
    });

    it("detects a unified workspace only when .git is a worktree file", () => {
        const workspace = getWorkspacePath(repoPath, "feature-login");
        spawnSync("git", ["branch", "feature-login"], { cwd: repoPath, stdio: "pipe" });
        spawnSync("git", ["worktree", "add", workspace, "feature-login"], {
            cwd: repoPath,
            stdio: "pipe",
        });

        expect(detectWorktreeWorkspaceBranch(workspace)).toBe("feature-login");
        expect(() => assertWorkspaceBranch(workspace, "feature-login")).not.toThrow();
    });

    it("validates every child repository in a multi-repo workspace", () => {
        const source = join(repoPath, "source");
        mkdirSync(source);
        initRepo(join(source, "frontend"));
        initRepo(join(source, "backend"));
        const result = createWorkspace(source, "feature");

        expect(() => assertWorkspaceBranch(result.workspacePath, "feature")).not.toThrow();
        expect(detectWorktreeWorkspaceBranch(result.workspacePath)).toBe("feature");

        spawnSync("git", ["switch", "-c", "wrong-branch"], {
            cwd: join(result.workspacePath, "backend"),
            stdio: "pipe",
        });
        expect(() => assertWorkspaceBranch(result.workspacePath, "feature"))
            .toThrow("repository 'backend' belongs to branch 'wrong-branch'");
        expect(() => detectWorktreeWorkspaceBranch(result.workspacePath))
            .toThrow("do not share one checked-out branch");
    });

    it("rejects a same-branch directory that is not owned by the source repositories", () => {
        const source = join(repoPath, "owned-source");
        const sourceRepo = join(source, "frontend");
        mkdirSync(source);
        initRepo(sourceRepo);
        spawnSync("git", ["branch", "feature"], { cwd: sourceRepo, stdio: "pipe" });

        const workspace = getWorkspacePath(source, "feature");
        const foreignRepo = join(workspace, "frontend");
        mkdirSync(workspace);
        initRepo(foreignRepo);
        spawnSync("git", ["switch", "-c", "feature"], { cwd: foreignRepo, stdio: "pipe" });

        expect(() => assertWorkspaceBranch(workspace, "feature", spawnSync, source))
            .toThrow("is not owned by its source repository");
    });

    it("validates independently managed nested worktrees in a unified workspace", () => {
        const nestedSource = join(repoPath, "nested");
        initRepo(nestedSource);
        const result = createWorkspace(repoPath, "nested-feature");
        const nestedWorkspace = join(result.workspacePath, "nested");

        expect(() => assertWorkspaceBranch(
            result.workspacePath,
            "nested-feature",
            spawnSync,
            repoPath,
        )).not.toThrow();

        spawnSync("git", ["switch", "-c", "wrong-nested"], {
            cwd: nestedWorkspace,
            stdio: "pipe",
        });
        expect(() => assertWorkspaceBranch(
            result.workspacePath,
            "nested-feature",
            spawnSync,
            repoPath,
        )).toThrow("repository 'nested' belongs to branch 'wrong-nested'");
        expect(() => detectWorktreeWorkspaceBranch(result.workspacePath))
            .toThrow("do not share one checked-out branch");
    });

    it("rejects a unified workspace when registered nested metadata disappears", () => {
        const nestedSource = join(repoPath, "nested");
        initRepo(nestedSource);
        const result = createWorkspace(repoPath, "nested-missing");
        rmSync(join(result.workspacePath, "nested", ".git"));

        expect(() => detectWorktreeWorkspaceBranch(result.workspacePath))
            .toThrow("Workspace Git metadata is missing or damaged");
        expect(() => assertWorkspaceBranch(
            result.workspacePath,
            "nested-missing",
            spawnSync,
            repoPath,
        )).toThrow("is not owned by its source repository");
    });

    it("rejects an unmanaged nested repository during direct worktree detection", () => {
        const result = createWorkspace(repoPath, "nested-foreign");
        const foreign = join(result.workspacePath, "foreign");
        initRepo(foreign);

        expect(() => detectWorktreeWorkspaceBranch(result.workspacePath))
            .toThrow("contains unmanaged Git repository 'foreign'");
    });

    it("rejects worktree metadata whose registration does not point back to the workspace", () => {
        const workspace = getWorkspacePath(repoPath, "feature-login");
        spawnSync("git", ["branch", "feature-login"], { cwd: repoPath, stdio: "pipe" });
        spawnSync("git", ["worktree", "add", workspace, "feature-login"], {
            cwd: repoPath,
            stdio: "pipe",
        });
        const gitDir = readFileSync(join(workspace, ".git"), "utf-8")
            .trim()
            .replace(/^gitdir:\s*/, "");
        writeFileSync(join(gitDir, "gitdir"), join(repoPath, ".git"));

        expect(() => detectWorktreeWorkspaceBranch(workspace))
            .toThrow("Unable to inspect worktree common directory");
    });

    it("rejects worktree metadata with a missing registration back-pointer", () => {
        const workspace = getWorkspacePath(repoPath, "feature-login");
        spawnSync("git", ["branch", "feature-login"], { cwd: repoPath, stdio: "pipe" });
        spawnSync("git", ["worktree", "add", workspace, "feature-login"], {
            cwd: repoPath,
            stdio: "pipe",
        });
        const gitDir = readFileSync(join(workspace, ".git"), "utf-8")
            .trim()
            .replace(/^gitdir:\s*/, "");
        rmSync(join(gitDir, "gitdir"));

        expect(() => detectWorktreeWorkspaceBranch(workspace))
            .toThrow("Unable to inspect worktree common directory");
    });

    it.skipIf(process.platform === "win32")("fails closed when root .git metadata is a symlink loop", () => {
        const workspace = getWorkspacePath(repoPath, "feature-login");
        spawnSync("git", ["branch", "feature-login"], { cwd: repoPath, stdio: "pipe" });
        spawnSync("git", ["worktree", "add", workspace, "feature-login"], {
            cwd: repoPath,
            stdio: "pipe",
        });
        const rootGit = join(workspace, ".git");
        rmSync(rootGit);
        symlinkSync(".git", rootGit);

        expect(() => detectWorktreeWorkspaceBranch(workspace))
            .toThrow("Invalid worktree metadata");
    });

    it("fails closed when a registered root worktree loses its .git metadata", () => {
        const workspace = getWorkspacePath(repoPath, "feature-login");
        spawnSync("git", ["branch", "feature-login"], { cwd: repoPath, stdio: "pipe" });
        spawnSync("git", ["worktree", "add", workspace, "feature-login"], {
            cwd: repoPath,
            stdio: "pipe",
        });
        rmSync(join(workspace, ".git"));

        expect(() => detectWorktreeWorkspaceBranch(workspace))
            .toThrow("Workspace Git metadata is missing or damaged");
    });

    it("rejects a regular root repository mixed with child worktrees", () => {
        const source = join(repoPath, "mixed-source");
        mkdirSync(source);
        initRepo(join(source, "frontend"));
        const result = createWorkspace(source, "feature");
        spawnSync("git", ["init"], { cwd: result.workspacePath, stdio: "pipe" });

        expect(() => detectWorktreeWorkspaceBranch(result.workspacePath))
            .toThrow("mixture of a root repository and child worktrees");
    });

    it("rejects a regular root repository when registered child metadata is missing", () => {
        const source = join(repoPath, "damaged-mixed-source");
        mkdirSync(source);
        initRepo(join(source, "frontend"));
        const result = createWorkspace(source, "feature");
        rmSync(join(result.workspacePath, "frontend", ".git"));
        spawnSync("git", ["init"], { cwd: result.workspacePath, stdio: "pipe" });

        expect(() => detectWorktreeWorkspaceBranch(result.workspacePath))
            .toThrow("mixture of a root repository and child worktrees");
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

    it("preserves a foreign same-branch sibling directory even with force", () => {
        initRepo(sourceDir);
        spawnSync("git", ["branch", "feature"], { cwd: sourceDir, stdio: "pipe" });
        const workspace = getWorkspacePath(sourceDir, "feature");
        initRepo(workspace);
        spawnSync("git", ["switch", "-c", "feature"], { cwd: workspace, stdio: "pipe" });

        expect(() => removeWorkspace(sourceDir, "feature", { force: true }))
            .toThrow("is not owned by source repository");
        expect(existsSync(workspace)).toBe(true);
    });

    it("preserves a valid multi-repo workspace containing an extra repository even with force", () => {
        initRepo(join(sourceDir, "repo-a"));
        const result = createWorkspace(sourceDir, "feature");
        const foreign = join(result.workspacePath, "foreign");
        initRepo(foreign);
        spawnSync("git", ["switch", "-c", "feature"], { cwd: foreign, stdio: "pipe" });

        expect(() => removeWorkspace(sourceDir, "feature", { force: true }))
            .toThrow("contains unowned Git repository 'foreign'");
        expect(existsSync(result.workspacePath)).toBe(true);
        expect(existsSync(foreign)).toBe(true);
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
        expect(readdirSync(tmpDir).some((name) => name.startsWith(".ccc-worktree-quarantine-")))
            .toBe(false);
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
        expect(readFileSync(
            join(wsResult.workspacePath, "repo-a", "dirty.txt"),
            "utf-8",
        )).toBe("uncommitted");
        expect(readdirSync(tmpDir).some((name) => name.startsWith(".ccc-worktree-quarantine-")))
            .toBe(false);

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
        spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: repoInWorkspace, stdio: "pipe" });
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

        writeFileSync(join(tmpDir, ".gitignore"), "frontend/\nbackend/\n");
        spawnSync("git", ["add", ".gitignore"], { cwd: tmpDir, stdio: "pipe" });
        spawnSync("git", ["commit", "-m", "ignore nested repos"], { cwd: tmpDir, stdio: "pipe" });

        // Create nested git repos (not submodules, gitignored by parent)
        initRepo(join(tmpDir, "frontend"));
        writeFileSync(join(tmpDir, "frontend", "app.ts"), "export default {}");
        spawnSync("git", ["add", "."], { cwd: join(tmpDir, "frontend"), stdio: "pipe" });
        spawnSync("git", ["commit", "-m", "add app"], { cwd: join(tmpDir, "frontend"), stdio: "pipe" });

        initRepo(join(tmpDir, "backend"));
        writeFileSync(join(tmpDir, "backend", "server.ts"), "export default {}");
        spawnSync("git", ["add", "."], { cwd: join(tmpDir, "backend"), stdio: "pipe" });
        spawnSync("git", ["commit", "-m", "add server"], { cwd: join(tmpDir, "backend"), stdio: "pipe" });

        expect(spawnSync("git", ["check-ignore", "frontend"], { cwd: tmpDir, stdio: "pipe" }).status).toBe(0);
        expect(spawnSync("git", ["check-ignore", "backend"], { cwd: tmpDir, stdio: "pipe" }).status).toBe(0);

        const result = createWorkspace(tmpDir, "feature");

        expect(existsSync(result.workspacePath)).toBe(true);

        // Nested repos should have worktrees created
        expect(
            existsSync(join(result.workspacePath, "frontend", "app.ts")),
        ).toBe(true);
        expect(
            existsSync(join(result.workspacePath, "backend", "server.ts")),
        ).toBe(true);
        expect(lstatSync(join(result.workspacePath, "frontend", ".git")).isFile())
            .toBe(true);
        expect(lstatSync(join(result.workspacePath, "backend", ".git")).isFile())
            .toBe(true);
        expect(isValidWorktree(
            join(result.workspacePath, "frontend"),
            join(tmpDir, "frontend"),
        )).toBe(true);
        expect(isValidWorktree(
            join(result.workspacePath, "backend"),
            join(tmpDir, "backend"),
        )).toBe(true);

        // Should report nested repos in created list
        const createdNames = result.created.map((c) => c.name).sort();
        expect(createdNames).toContain("frontend");
        expect(createdNames).toContain("backend");
        expect(branchExistsInRepo(tmpDir, "feature")).toBe("local");
        expect(branchExistsInRepo(join(tmpDir, "frontend"), "feature")).toBe("local");
        expect(branchExistsInRepo(join(tmpDir, "backend"), "feature")).toBe("local");
    });

    it("creates real worktrees for deeply nested ignored git repositories", () => {
        initRepo(tmpDir);
        writeFileSync(join(tmpDir, ".gitignore"), "services/private/\n");
        spawnSync("git", ["add", ".gitignore"], { cwd: tmpDir, stdio: "pipe" });
        spawnSync("git", ["commit", "-m", "ignore nested services"], {
            cwd: tmpDir,
            stdio: "pipe",
        });

        const nestedRepo = join(tmpDir, "services", "private", "api");
        initRepo(nestedRepo);
        writeFileSync(join(nestedRepo, "server.ts"), "export const api = true;");
        spawnSync("git", ["add", "."], { cwd: nestedRepo, stdio: "pipe" });
        spawnSync("git", ["commit", "-m", "add api"], {
            cwd: nestedRepo,
            stdio: "pipe",
        });

        const result = createWorkspace(tmpDir, "deep-feature");
        const nestedWorktree = join(result.workspacePath, "services", "private", "api");

        expect(result.created.map(({ name }) => name))
            .toContain("services/private/api");
        expect(readFileSync(join(nestedWorktree, "server.ts"), "utf-8"))
            .toBe("export const api = true;");
        expect(lstatSync(join(nestedWorktree, ".git")).isFile()).toBe(true);
        expect(isValidWorktree(nestedWorktree, nestedRepo)).toBe(true);

        const listed = spawnSync("git", ["worktree", "list", "--porcelain"], {
            cwd: nestedRepo,
            encoding: "utf-8",
            stdio: "pipe",
        });
        expect(listed.status).toBe(0);
        expect(listed.stdout).toContain(`worktree ${nestedWorktree}`);
        expect(detectWorktreeWorkspaceBranch(result.workspacePath))
            .toBe("deep-feature");

        const mounts = getWorktreeGitMounts(
            result.workspacePath,
            true,
            "/project/deep-feature",
        );
        expect(mounts.some(({ hostPath }) => (
            hostPath === join(nestedRepo, ".git")
        ))).toBe(true);
    });

    it("creates linked worktrees for repositories nested inside ignored repositories", () => {
        initRepo(tmpDir);
        writeFileSync(join(tmpDir, ".gitignore"), "vendor/\n");
        spawnSync("git", ["add", ".gitignore"], { cwd: tmpDir, stdio: "pipe" });
        spawnSync("git", ["commit", "-m", "ignore vendor"], {
            cwd: tmpDir,
            stdio: "pipe",
        });
        const outerRepo = join(tmpDir, "vendor", "platform");
        initRepo(outerRepo);
        writeFileSync(join(outerRepo, ".gitignore"), "plugins/\n");
        spawnSync("git", ["add", ".gitignore"], { cwd: outerRepo, stdio: "pipe" });
        spawnSync("git", ["commit", "-m", "ignore plugins"], {
            cwd: outerRepo,
            stdio: "pipe",
        });
        const innerRepo = join(outerRepo, "plugins", "tool");
        initRepo(innerRepo);

        const result = createWorkspace(tmpDir, "recursive-feature");
        const outerWorktree = join(result.workspacePath, "vendor", "platform");
        const innerWorktree = join(outerWorktree, "plugins", "tool");

        expect(result.created.map(({ name }) => name)).toEqual([
            basename(tmpDir),
            "vendor/platform",
            "vendor/platform/plugins/tool",
        ]);
        expect(isValidWorktree(outerWorktree, outerRepo)).toBe(true);
        expect(isValidWorktree(innerWorktree, innerRepo)).toBe(true);
        expect(detectWorktreeWorkspaceBranch(result.workspacePath))
            .toBe("recursive-feature");
    });

    it("initializes submodules owned by a newly created ignored repository", () => {
        const submoduleOrigin = join(dirname(tmpDir), `${basename(tmpDir)}-submodule-origin`);
        try {
            initRepo(tmpDir);
            writeFileSync(join(tmpDir, ".gitignore"), "vendor/\n");
            spawnSync("git", ["add", ".gitignore"], { cwd: tmpDir, stdio: "pipe" });
            spawnSync("git", ["commit", "-m", "ignore vendor"], {
                cwd: tmpDir,
                stdio: "pipe",
            });
            initRepo(submoduleOrigin);
            writeFileSync(join(submoduleOrigin, "child.txt"), "child");
            spawnSync("git", ["add", "child.txt"], {
                cwd: submoduleOrigin,
                stdio: "pipe",
            });
            spawnSync("git", ["commit", "-m", "add child"], {
                cwd: submoduleOrigin,
                stdio: "pipe",
            });
            const outerRepo = join(tmpDir, "vendor", "platform");
            initRepo(outerRepo);
            spawnSync("git", ["config", "protocol.file.allow", "always"], {
                cwd: outerRepo,
                stdio: "pipe",
            });
            const added = spawnSync(
                "git",
                [
                    "-c",
                    "protocol.file.allow=always",
                    "submodule",
                    "add",
                    submoduleOrigin,
                    "modules/child",
                ],
                { cwd: outerRepo, encoding: "utf-8", stdio: "pipe" },
            );
            expect(added.status, added.stderr).toBe(0);
            spawnSync("git", ["commit", "-am", "add child submodule"], {
                cwd: outerRepo,
                stdio: "pipe",
            });

            const previousAllowedProtocol = process.env.GIT_ALLOW_PROTOCOL;
            process.env.GIT_ALLOW_PROTOCOL = "file";
            let result: ReturnType<typeof createWorkspace>;
            try {
                result = createWorkspace(tmpDir, "nested-submodule");
            } finally {
                if (previousAllowedProtocol === undefined) {
                    delete process.env.GIT_ALLOW_PROTOCOL;
                } else {
                    process.env.GIT_ALLOW_PROTOCOL = previousAllowedProtocol;
                }
            }

            expect(readFileSync(join(
                result.workspacePath,
                "vendor",
                "platform",
                "modules",
                "child",
                "child.txt",
            ), "utf-8")).toBe("child");
        } finally {
            rmSync(submoduleOrigin, { recursive: true, force: true });
        }
    });

    it("rejects direct nested repositories whose git metadata is a symlink", () => {
        const externalRepo = join(dirname(tmpDir), `${basename(tmpDir)}-external`);
        try {
            initRepo(tmpDir);
            initRepo(externalRepo);
            const nestedRepo = join(tmpDir, "nested");
            mkdirSync(nestedRepo);
            symlinkSync(
                join(externalRepo, ".git"),
                join(nestedRepo, ".git"),
                process.platform === "win32" ? "junction" : "dir",
            );

            expect(() => createWorkspace(tmpDir, "metadata-symlink"))
                .toThrow("metadata is a symbolic link");
            expect(branchExistsInRepo(externalRepo, "metadata-symlink"))
                .toBe("none");
            expect(existsSync(getWorkspacePath(tmpDir, "metadata-symlink")))
                .toBe(false);
        } finally {
            rmSync(externalRepo, { recursive: true, force: true });
        }
    });

    it("rejects ignored repositories whose git file points at unrelated metadata", () => {
        const externalRepo = join(dirname(tmpDir), `${basename(tmpDir)}-external-gitfile`);
        try {
            initRepo(tmpDir);
            writeFileSync(join(tmpDir, ".gitignore"), "nested/\n");
            spawnSync("git", ["add", ".gitignore"], { cwd: tmpDir, stdio: "pipe" });
            spawnSync("git", ["commit", "-m", "ignore nested"], {
                cwd: tmpDir,
                stdio: "pipe",
            });
            initRepo(externalRepo);
            const nestedRepo = join(tmpDir, "nested");
            mkdirSync(nestedRepo);
            writeFileSync(
                join(nestedRepo, ".git"),
                `gitdir: ${join(externalRepo, ".git")}\n`,
            );

            expect(() => createWorkspace(tmpDir, "external-gitfile"))
                .toThrow("metadata is not owned");
            expect(branchExistsInRepo(externalRepo, "external-gitfile"))
                .toBe("none");
        } finally {
            rmSync(externalRepo, { recursive: true, force: true });
        }
    });

    it("does not mutate an ignored nested repository that is itself a worktree", () => {
        const externalRepo = join(dirname(tmpDir), `${basename(tmpDir)}-source-worktree`);
        try {
            initRepo(tmpDir);
            writeFileSync(join(tmpDir, ".gitignore"), "nested/\n");
            spawnSync("git", ["add", ".gitignore"], { cwd: tmpDir, stdio: "pipe" });
            spawnSync("git", ["commit", "-m", "ignore nested"], {
                cwd: tmpDir,
                stdio: "pipe",
            });
            initRepo(externalRepo);
            const nestedRepo = join(tmpDir, "nested");
            const added = spawnSync(
                "git",
                ["worktree", "add", "-b", "nested-source", nestedRepo],
                { cwd: externalRepo, encoding: "utf-8", stdio: "pipe" },
            );
            expect(added.status, added.stderr).toBe(0);

            expect(() => createWorkspace(tmpDir, "external-worktree"))
                .toThrow("metadata is not owned");
            expect(branchExistsInRepo(externalRepo, "external-worktree"))
                .toBe("none");
        } finally {
            rmSync(externalRepo, { recursive: true, force: true });
        }
    });

    it("supports repository chains deeper than twenty levels", () => {
        initRepo(tmpDir);
        writeFileSync(join(tmpDir, ".gitignore"), "level-01/\n");
        spawnSync("git", ["add", ".gitignore"], { cwd: tmpDir, stdio: "pipe" });
        spawnSync("git", ["commit", "-m", "ignore deep chain"], {
            cwd: tmpDir,
            stdio: "pipe",
        });

        let repository = tmpDir;
        const names: string[] = [];
        for (let depth = 1; depth <= 21; depth += 1) {
            const name = `level-${String(depth).padStart(2, "0")}`;
            repository = join(repository, name);
            names.push(name);
            initRepo(repository);
            if (depth < 21) {
                const next = `level-${String(depth + 1).padStart(2, "0")}`;
                writeFileSync(join(repository, ".gitignore"), `${next}/\n`);
                spawnSync("git", ["add", ".gitignore"], {
                    cwd: repository,
                    stdio: "pipe",
                });
                spawnSync("git", ["commit", "-m", `ignore ${next}`], {
                    cwd: repository,
                    stdio: "pipe",
                });
            }
        }

        const result = createWorkspace(tmpDir, "deep-chain");
        const deepestName = names.join("/");
        const deepestWorktree = join(result.workspacePath, ...names);

        expect(result.created.map(({ name }) => name)).toContain(deepestName);
        expect(isValidWorktree(deepestWorktree, repository)).toBe(true);
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

    it("repairs a deeply nested ignored repository added after workspace creation", () => {
        initRepo(tmpDir);
        writeFileSync(join(tmpDir, ".gitignore"), "services/private/\n");
        spawnSync("git", ["add", ".gitignore"], { cwd: tmpDir, stdio: "pipe" });
        spawnSync("git", ["commit", "-m", "ignore nested services"], {
            cwd: tmpDir,
            stdio: "pipe",
        });
        const wsResult = createWorkspace(tmpDir, "deep-repair");
        const nestedRepo = join(tmpDir, "services", "private", "api");
        initRepo(nestedRepo);

        const repaired = repairWorkspace(
            tmpDir,
            wsResult.workspacePath,
            "deep-repair",
        );
        const nestedWorktree = join(
            wsResult.workspacePath,
            "services",
            "private",
            "api",
        );

        expect(repaired.map(({ name }) => name))
            .toContain("services/private/api");
        expect(isValidWorktree(nestedWorktree, nestedRepo)).toBe(true);
    });

    it("does not create descendants beneath a broken nested repository", () => {
        initRepo(tmpDir);
        writeFileSync(join(tmpDir, ".gitignore"), "vendor/\n");
        spawnSync("git", ["add", ".gitignore"], { cwd: tmpDir, stdio: "pipe" });
        spawnSync("git", ["commit", "-m", "ignore vendor"], {
            cwd: tmpDir,
            stdio: "pipe",
        });
        const outerRepo = join(tmpDir, "vendor", "platform");
        initRepo(outerRepo);
        writeFileSync(join(outerRepo, ".gitignore"), "plugins/\n");
        spawnSync("git", ["add", ".gitignore"], { cwd: outerRepo, stdio: "pipe" });
        spawnSync("git", ["commit", "-m", "ignore plugins"], {
            cwd: outerRepo,
            stdio: "pipe",
        });
        const innerRepo = join(outerRepo, "plugins", "tool");
        initRepo(innerRepo);
        const wsResult = createWorkspace(tmpDir, "broken-parent");
        const outerWorktree = join(wsResult.workspacePath, "vendor", "platform");
        const innerWorktree = join(outerWorktree, "plugins", "tool");
        spawnSync("git", ["worktree", "remove", "--force", innerWorktree], {
            cwd: innerRepo,
            stdio: "pipe",
        });
        spawnSync("git", ["worktree", "remove", "--force", outerWorktree], {
            cwd: outerRepo,
            stdio: "pipe",
        });
        mkdirSync(outerWorktree, { recursive: true });
        writeFileSync(join(outerWorktree, "preserve.txt"), "preserve");

        const repaired = repairWorkspace(
            tmpDir,
            wsResult.workspacePath,
            "broken-parent",
        );

        expect(repaired).toEqual([]);
        expect(readFileSync(join(outerWorktree, "preserve.txt"), "utf-8"))
            .toBe("preserve");
        expect(existsSync(innerWorktree)).toBe(false);
    });

    it("rejects a nested destination whose parent is a symlink", () => {
        const external = join(dirname(tmpDir), `${basename(tmpDir)}-destination`);
        try {
            initRepo(tmpDir);
            writeFileSync(join(tmpDir, ".gitignore"), "services/private/\n");
            spawnSync("git", ["add", ".gitignore"], { cwd: tmpDir, stdio: "pipe" });
            spawnSync("git", ["commit", "-m", "ignore nested services"], {
                cwd: tmpDir,
                stdio: "pipe",
            });
            const wsResult = createWorkspace(tmpDir, "parent-symlink");
            mkdirSync(external);
            symlinkSync(
                external,
                join(wsResult.workspacePath, "services"),
                process.platform === "win32" ? "junction" : "dir",
            );
            initRepo(join(tmpDir, "services", "private", "api"));

            expect(() => repairWorkspace(
                tmpDir,
                wsResult.workspacePath,
                "parent-symlink",
            )).toThrow("not a safe directory");
            expect(readdirSync(external)).toEqual([]);
        } finally {
            rmSync(external, { recursive: true, force: true });
        }
    });

    it("rolls back nested worktrees created earlier in the same repair", () => {
        initRepo(tmpDir);
        initRepo(join(tmpDir, "a-first"));
        const failingRepo = join(tmpDir, "z-failing");
        initRepo(failingRepo);
        spawnSync("git", ["switch", "-c", "repair-conflict"], {
            cwd: failingRepo,
            stdio: "pipe",
        });
        const wsPath = getWorkspacePath(tmpDir, "repair-conflict");
        spawnSync("git", ["worktree", "add", "-b", "repair-conflict", wsPath], {
            cwd: tmpDir,
            stdio: "pipe",
        });

        expect(() => repairWorkspace(tmpDir, wsPath, "repair-conflict"))
            .toThrow("Failed to create nested worktree for z-failing");
        expect(existsSync(join(wsPath, "a-first"))).toBe(false);
        expect(existsSync(join(wsPath, "z-failing"))).toBe(false);
        expect(isValidWorktree(wsPath, tmpDir)).toBe(true);
        expect(branchExistsInRepo(join(tmpDir, "a-first"), "repair-conflict"))
            .toBe("none");
    });

    it("rolls back a side-effecting failed unified worktree add", () => {
        initRepo(tmpDir);
        installFailingCheckoutHook(tmpDir);

        expect(() => createWorkspace(tmpDir, "hook-failure"))
            .toThrow("Failed to create worktree");

        const wsPath = getWorkspacePath(tmpDir, "hook-failure");
        expect(existsSync(wsPath)).toBe(false);
        expect(branchExistsInRepo(tmpDir, "hook-failure")).toBe("none");
        const listed = spawnSync("git", ["worktree", "list", "--porcelain"], {
            cwd: tmpDir,
            encoding: "utf-8",
        });
        expect(listed.stdout).not.toContain(wsPath);
    });

    it("preserves unrelated stale registrations while rolling back a missing worktree", () => {
        initRepo(tmpDir);
        const unrelated = join(dirname(tmpDir), `${basename(tmpDir)}-unrelated-stale`);
        const movedUnrelated = `${unrelated}.moved`;
        const branch = "missing-worktree-rollback";
        const wsPath = getWorkspacePath(tmpDir, branch);
        const movedWorkspace = `${wsPath}.moved`;
        spawnSync("git", ["worktree", "add", "-b", "unrelated-stale", unrelated], {
            cwd: tmpDir,
            stdio: "pipe",
        });
        renameSync(unrelated, movedUnrelated);
        const hook = join(tmpDir, ".git", "hooks", "post-checkout");
        writeFileSync(
            hook,
            [
                "#!/bin/sh",
                `mv "$PWD" "${movedWorkspace}"`,
                "exit 1",
                "",
            ].join("\n"),
        );
        chmodSync(hook, 0o755);

        expect(() => createWorkspace(tmpDir, branch))
            .toThrow("Failed to create worktree");

        const listed = spawnSync("git", ["worktree", "list", "--porcelain"], {
            cwd: tmpDir,
            encoding: "utf-8",
        });
        expect(listed.stdout).toContain(`worktree ${unrelated}`);
        expect(listed.stdout).not.toContain(`worktree ${wsPath}`);
        expect(branchExistsInRepo(tmpDir, branch)).toBe("none");

        spawnSync("git", ["worktree", "remove", "--force", unrelated], {
            cwd: tmpDir,
            stdio: "pipe",
        });
        rmSync(movedUnrelated, { recursive: true, force: true });
        rmSync(movedWorkspace, { recursive: true, force: true });
    });

    it("preserves a failed-add branch when its ref changes concurrently", () => {
        initRepo(tmpDir);
        const original = spawnSync("git", ["rev-parse", "HEAD"], {
            cwd: tmpDir,
            encoding: "utf-8",
        }).stdout.trim();
        writeFileSync(join(tmpDir, "alternate.txt"), "alternate");
        spawnSync("git", ["add", "alternate.txt"], { cwd: tmpDir, stdio: "pipe" });
        spawnSync("git", ["commit", "-m", "alternate"], { cwd: tmpDir, stdio: "pipe" });
        const alternate = spawnSync("git", ["rev-parse", "HEAD"], {
            cwd: tmpDir,
            encoding: "utf-8",
        }).stdout.trim();
        spawnSync("git", ["reset", "--hard", original], { cwd: tmpDir, stdio: "pipe" });
        const hook = join(tmpDir, ".git", "hooks", "post-checkout");
        writeFileSync(
            hook,
            `#!/bin/sh\ngit update-ref refs/heads/hook-race ${alternate}\nexit 1\n`,
        );
        chmodSync(hook, 0o755);

        expect(() => createWorkspace(tmpDir, "hook-race"))
            .toThrow("foreign registration");

        const wsPath = getWorkspacePath(tmpDir, "hook-race");
        expect(existsSync(wsPath)).toBe(true);
        expect(branchExistsInRepo(tmpDir, "hook-race")).toBe("local");
        const preserved = spawnSync("git", ["rev-parse", "refs/heads/hook-race"], {
            cwd: tmpDir,
            encoding: "utf-8",
        });
        expect(preserved.stdout.trim()).toBe(alternate);

        rmSync(hook);
        spawnSync("git", ["worktree", "remove", "--force", wsPath], {
            cwd: tmpDir,
            stdio: "pipe",
        });
        spawnSync("git", ["branch", "-D", "hook-race"], {
            cwd: tmpDir,
            stdio: "pipe",
        });
    });

    it("rejects a successful checkout whose branch ref changes concurrently", () => {
        initRepo(tmpDir);
        const original = spawnSync("git", ["rev-parse", "HEAD"], {
            cwd: tmpDir,
            encoding: "utf-8",
        }).stdout.trim();
        writeFileSync(join(tmpDir, "alternate.txt"), "alternate");
        spawnSync("git", ["add", "alternate.txt"], { cwd: tmpDir, stdio: "pipe" });
        spawnSync("git", ["commit", "-m", "alternate"], { cwd: tmpDir, stdio: "pipe" });
        const alternate = spawnSync("git", ["rev-parse", "HEAD"], {
            cwd: tmpDir,
            encoding: "utf-8",
        }).stdout.trim();
        spawnSync("git", ["reset", "--hard", original], { cwd: tmpDir, stdio: "pipe" });
        const hook = join(tmpDir, ".git", "hooks", "post-checkout");
        writeFileSync(
            hook,
            `#!/bin/sh\ngit update-ref refs/heads/hook-success-race ${alternate}\nexit 0\n`,
        );
        chmodSync(hook, 0o755);

        expect(() => createWorkspace(tmpDir, "hook-success-race"))
            .toThrow("foreign registration");
        const workspace = getWorkspacePath(tmpDir, "hook-success-race");
        expect(existsSync(workspace)).toBe(true);
        const preserved = spawnSync(
            "git",
            ["rev-parse", "refs/heads/hook-success-race"],
            { cwd: tmpDir, encoding: "utf-8" },
        );
        expect(preserved.stdout.trim()).toBe(alternate);

        rmSync(hook);
        spawnSync("git", ["worktree", "remove", "--force", workspace], {
            cwd: tmpDir,
            stdio: "pipe",
        });
        spawnSync("git", ["branch", "-D", "hook-success-race"], {
            cwd: tmpDir,
            stdio: "pipe",
        });
    });

    it("preserves branch tracking config changed during failed checkout", () => {
        initRepo(tmpDir);
        const hook = join(tmpDir, ".git", "hooks", "post-checkout");
        writeFileSync(
            hook,
            [
                "#!/bin/sh",
                "git config --local branch.config-race.remote foreign-owner",
                "exit 1",
                "",
            ].join("\n"),
        );
        chmodSync(hook, 0o755);

        expect(() => createWorkspace(tmpDir, "config-race"))
            .toThrow("tracking configuration changed");
        expect(existsSync(getWorkspacePath(tmpDir, "config-race"))).toBe(false);
        expect(branchExistsInRepo(tmpDir, "config-race")).toBe("local");
        const preserved = spawnSync(
            "git",
            ["config", "--local", "--get", "branch.config-race.remote"],
            { cwd: tmpDir, encoding: "utf-8" },
        );
        expect(preserved.stdout.trim()).toBe("foreign-owner");

        rmSync(hook);
        spawnSync("git", ["branch", "-D", "config-race"], {
            cwd: tmpDir,
            stdio: "pipe",
        });
        spawnSync(
            "git",
            ["config", "--local", "--unset-all", "branch.config-race.remote"],
            { cwd: tmpDir, stdio: "pipe" },
        );
    });

    it("rejects a checkout attached to another branch at the same commit", () => {
        initRepo(tmpDir);
        spawnSync("git", ["branch", "same-oid-alternate"], {
            cwd: tmpDir,
            stdio: "pipe",
        });
        const hook = join(tmpDir, ".git", "hooks", "post-checkout");
        writeFileSync(
            hook,
            "#!/bin/sh\ngit symbolic-ref HEAD refs/heads/same-oid-alternate\nexit 0\n",
        );
        chmodSync(hook, 0o755);

        expect(() => createWorkspace(tmpDir, "same-oid-target"))
            .toThrow("worktree branch identity changed during checkout");
        const workspace = getWorkspacePath(tmpDir, "same-oid-target");
        expect(existsSync(workspace)).toBe(true);
        expect(detectWorktreeWorkspaceBranch(workspace)).toBe("same-oid-alternate");
        expect(branchExistsInRepo(tmpDir, "same-oid-target")).toBe("local");

        rmSync(hook);
        spawnSync("git", ["worktree", "remove", "--force", workspace], {
            cwd: tmpDir,
            stdio: "pipe",
        });
        spawnSync("git", ["branch", "-D", "same-oid-target"], {
            cwd: tmpDir,
            stdio: "pipe",
        });
    });

    it.skipIf(process.platform === "win32")("preserves a replacement path after worktree registration", () => {
        initRepo(tmpDir);
        const foreign = join(tmpDir, "foreign-destination");
        mkdirSync(foreign);
        writeFileSync(join(foreign, "marker.txt"), "preserve");
        const workspace = getWorkspacePath(tmpDir, "replacement-race");
        const movedWorkspace = `${workspace}.moved`;
        const hook = join(tmpDir, ".git", "hooks", "post-checkout");
        writeFileSync(
            hook,
            [
                "#!/bin/sh",
                `mv "$PWD" "${movedWorkspace}"`,
                `ln -s "${foreign}" "$PWD"`,
                "exit 0",
                "",
            ].join("\n"),
        );
        chmodSync(hook, 0o755);

        expect(() => createWorkspace(tmpDir, "replacement-race"))
            .toThrow("Workspace path");
        expect(readFileSync(join(foreign, "marker.txt"), "utf-8")).toBe("preserve");
        expect(lstatSync(workspace).isSymbolicLink()).toBe(true);
        expect(existsSync(movedWorkspace)).toBe(true);

        rmSync(hook);
        rmSync(workspace);
        renameSync(movedWorkspace, workspace);
        spawnSync("git", ["worktree", "remove", "--force", workspace], {
            cwd: tmpDir,
            stdio: "pipe",
        });
        spawnSync("git", ["branch", "-D", "replacement-race"], {
            cwd: tmpDir,
            stdio: "pipe",
        });
    });

    it("rolls back a side-effecting failed nested repair add", () => {
        initRepo(tmpDir);
        const failingRepo = join(tmpDir, "nested-hook");
        initRepo(failingRepo);
        installFailingCheckoutHook(failingRepo);
        const branch = "repair-hook-failure";
        const wsPath = getWorkspacePath(tmpDir, branch);
        const rootResult = spawnSync(
            "git",
            ["worktree", "add", "-b", branch, wsPath],
            { cwd: tmpDir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        );
        expect(rootResult.status).toBe(0);

        expect(() => repairWorkspace(tmpDir, wsPath, branch))
            .toThrow("Failed to create nested worktree for nested-hook");

        const nestedPath = join(wsPath, "nested-hook");
        expect(existsSync(nestedPath)).toBe(false);
        expect(branchExistsInRepo(failingRepo, branch)).toBe("none");
        const listed = spawnSync("git", ["worktree", "list", "--porcelain"], {
            cwd: failingRepo,
            encoding: "utf-8",
        });
        expect(listed.stdout).not.toContain(nestedPath);
        expect(isValidWorktree(wsPath, tmpDir)).toBe(true);
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

    it("leaves nested repos with content unchanged for explicit repair", () => {
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

        // Repair must not mutate non-empty content without explicit confirmation.
        const repaired = repairWorkspace(tmpDir, wsPath, "autofix-test");
        const repairedNames = repaired.map((r) => r.name);
        expect(repairedNames).not.toContain("frontend");

        expect(existsSync(join(destFrontend, "app.ts"))).toBe(true);
        const gitStat = lstatSync(join(destFrontend, ".git"));
        expect(gitStat.isDirectory()).toBe(true);
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

        // Repair must leave the invalid gitlink for the explicit repair prompt.
        const repaired = repairWorkspace(tmpDir, wsPath, "submod-fix");
        const repairedNames = repaired.map((r) => r.name);
        expect(repairedNames).not.toContain("backend");

        expect(isValidWorktree(destBackend, join(tmpDir, "backend"))).toBe(false);

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

    it("refuses to repair a same-branch workspace not owned by the source", () => {
        initRepo(tmpDir);
        const foreignWorkspace = getWorkspacePath(tmpDir, "foreign");
        initRepo(foreignWorkspace);
        spawnSync("git", ["switch", "-c", "foreign"], {
            cwd: foreignWorkspace,
            stdio: "pipe",
        });
        const marker = join(foreignWorkspace, "foreign-content.txt");
        writeFileSync(marker, "preserve");

        expect(() => repairWorkspace(tmpDir, foreignWorkspace, "foreign"))
            .toThrow("is not owned by source repository");
        expect(readFileSync(marker, "utf-8")).toBe("preserve");
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

    it("rejects a forged gitlink that reuses another worktree registration", () => {
        const sourceRepo = join(tmpDir, "source-forged");
        const realWorktree = join(tmpDir, "real-worktree");
        const forgedWorktree = join(tmpDir, "forged-worktree");
        initRepo(sourceRepo);
        spawnSync("git", ["worktree", "add", "-b", "forged-test", realWorktree], {
            cwd: sourceRepo,
            stdio: "pipe",
        });
        mkdirSync(forgedWorktree);
        writeFileSync(
            join(forgedWorktree, ".git"),
            readFileSync(join(realWorktree, ".git"), "utf-8"),
        );

        expect(isValidWorktree(realWorktree, sourceRepo)).toBe(true);
        expect(isValidWorktree(forgedWorktree, sourceRepo)).toBe(false);
    });

    it.skipIf(process.platform === "win32")("rejects a symlink alias to a valid worktree", () => {
        const sourceRepo = join(tmpDir, "source-alias");
        const realWorktree = join(tmpDir, "real-alias-worktree");
        const aliasWorktree = join(tmpDir, "alias-worktree");
        initRepo(sourceRepo);
        spawnSync("git", ["worktree", "add", "-b", "alias-test", realWorktree], {
            cwd: sourceRepo,
            stdio: "pipe",
        });
        symlinkSync(realWorktree, aliasWorktree, "dir");

        expect(isValidWorktree(realWorktree, sourceRepo)).toBe(true);
        expect(isValidWorktree(aliasWorktree, sourceRepo)).toBe(false);
    });

    it.skipIf(process.platform === "win32")("rejects symlinked worktree management metadata", () => {
        const sourceRepo = join(tmpDir, "source-symlinked");
        const realWorktree = join(tmpDir, "symlinked-worktree");
        initRepo(sourceRepo);
        spawnSync("git", ["worktree", "add", "-b", "symlinked-test", realWorktree], {
            cwd: sourceRepo,
            stdio: "pipe",
        });
        const gitFile = readFileSync(join(realWorktree, ".git"), "utf-8");
        const gitDir = gitFile.trim().replace(/^gitdir:\s*/, "");
        const movedGitDir = `${gitDir}.real`;
        renameSync(gitDir, movedGitDir);
        symlinkSync(movedGitDir, gitDir, "dir");

        expect(isValidWorktree(realWorktree, sourceRepo)).toBe(false);
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

    it("detects and fixes a deeply nested ignored worktree", () => {
        initRepo(tmpDir);
        writeFileSync(join(tmpDir, ".gitignore"), "services/private/\n");
        spawnSync("git", ["add", ".gitignore"], { cwd: tmpDir, stdio: "pipe" });
        spawnSync("git", ["commit", "-m", "ignore nested services"], {
            cwd: tmpDir,
            stdio: "pipe",
        });
        const nestedRepo = join(tmpDir, "services", "private", "api");
        initRepo(nestedRepo);
        const wsResult = createWorkspace(tmpDir, "deep-broken");
        const nestedWorktree = join(
            wsResult.workspacePath,
            "services",
            "private",
            "api",
        );
        spawnSync("git", ["worktree", "remove", "--force", nestedWorktree], {
            cwd: nestedRepo,
            stdio: "pipe",
        });
        mkdirSync(nestedWorktree);
        writeFileSync(join(nestedWorktree, "preserve.txt"), "preserve");

        const broken = detectBrokenWorktrees(tmpDir, wsResult.workspacePath);

        expect(broken.map(({ name }) => name))
            .toEqual(["services/private/api"]);
        const fixed = fixBrokenWorktree(
            tmpDir,
            wsResult.workspacePath,
            "services/private/api",
            "deep-broken",
            true,
        );
        expect(fixed?.name).toBe("services/private/api");
        expect(isValidWorktree(nestedWorktree, nestedRepo)).toBe(true);
        expect(readFileSync(join(nestedWorktree, "preserve.txt"), "utf-8"))
            .toBe("preserve");
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

    it("requires explicit confirmation before touching workspace content", () => {
        initRepo(tmpDir);
        const wsResult = createWorkspace(tmpDir, "confirmation");
        const marker = join(wsResult.workspacePath, "preserve.txt");
        writeFileSync(marker, "preserve");

        expect(() => fixBrokenWorktree(
            tmpDir,
            wsResult.workspacePath,
            "frontend",
            "confirmation",
        )).toThrow("Explicit confirmation");
        expect(readFileSync(marker, "utf-8")).toBe("preserve");
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

        const result = fixBrokenWorktree(tmpDir, wsResult.workspacePath, "frontend", "fix-broken", true);

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
        const result = fixBrokenWorktree(tmpDir, wsResult.workspacePath, "nonexistent", "no-repo", true);
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
        const result = fixBrokenWorktree(tmpDir, wsResult.workspacePath, "frontend", "fail-fix", true);

        // Should fail gracefully
        expect(result).toBeNull();

        // Content should be restored (not lost)
        expect(existsSync(join(wsResult.workspacePath, "frontend", "precious.ts"))).toBe(true);
        expect(readFileSync(join(wsResult.workspacePath, "frontend", "precious.ts"), "utf-8")).toBe("don't lose me");
    });
    it("repairs its stale registration without pruning unrelated worktrees", () => {
        initRepo(tmpDir);
        initRepo(join(tmpDir, "frontend"));
        writeFileSync(join(tmpDir, "frontend", "app.ts"), "original");
        spawnSync("git", ["add", "."], { cwd: join(tmpDir, "frontend"), stdio: "pipe" });
        spawnSync("git", ["commit", "-m", "add app"], { cwd: join(tmpDir, "frontend"), stdio: "pipe" });

        const wsResult = createWorkspace(tmpDir, "stale-wt");

        // frontend is now a worktree on branch "stale-wt"
        const wsFrontend = join(wsResult.workspacePath, "frontend");
        expect(isValidWorktree(wsFrontend, join(tmpDir, "frontend"))).toBe(true);
        const unrelated = join(dirname(tmpDir), `${basename(tmpDir)}-unrelated-stale`);
        const movedUnrelated = `${unrelated}.moved`;
        spawnSync(
            "git",
            ["worktree", "add", "-b", "unrelated-stale", unrelated],
            { cwd: join(tmpDir, "frontend"), stdio: "pipe" },
        );
        renameSync(unrelated, movedUnrelated);

        // Simulate: delete the worktree directory WITHOUT git cleanup
        // This leaves a stale registration in frontend/.git/worktrees/
        rmSync(wsFrontend, { recursive: true, force: true });

        // Put non-worktree content back (simulating submodule re-init)
        mkdirSync(wsFrontend);
        writeFileSync(join(wsFrontend, "app.ts"), "original");
        writeFileSync(join(wsFrontend, ".git"), "gitdir: /some/fake/modules/path\n");

        const result = fixBrokenWorktree(tmpDir, wsResult.workspacePath, "frontend", "stale-wt", true);

        expect(result).not.toBeNull();
        expect(result!.name).toBe("frontend");

        // Should be a valid worktree now
        expect(isValidWorktree(wsFrontend, join(tmpDir, "frontend"))).toBe(true);

        // Content should be preserved
        expect(existsSync(join(wsFrontend, "app.ts"))).toBe(true);
        const listed = spawnSync("git", ["worktree", "list", "--porcelain"], {
            cwd: join(tmpDir, "frontend"),
            encoding: "utf-8",
        });
        expect(listed.stdout).toContain(`worktree ${unrelated}`);

        spawnSync("git", ["worktree", "remove", "--force", unrelated], {
            cwd: join(tmpDir, "frontend"),
            stdio: "pipe",
        });
        rmSync(movedUnrelated, { recursive: true, force: true });
    });

    it("preserves broken content and a stale registration for another branch", () => {
        initRepo(tmpDir);
        initRepo(join(tmpDir, "frontend"));
        const wsResult = createWorkspace(tmpDir, "stale-collision");
        const nestedRepo = join(tmpDir, "frontend");
        const wsFrontend = join(wsResult.workspacePath, "frontend");
        spawnSync("git", ["branch", "-m", "foreign-stale"], {
            cwd: wsFrontend,
            stdio: "pipe",
        });
        rmSync(wsFrontend, { recursive: true, force: true });
        mkdirSync(wsFrontend);
        writeFileSync(join(wsFrontend, "user.txt"), "preserve");
        writeFileSync(join(wsFrontend, ".git"), "gitdir: /foreign/metadata\n");

        expect(() => fixBrokenWorktree(
            tmpDir,
            wsResult.workspacePath,
            "frontend",
            "stale-collision",
            true,
        )).toThrow("belongs to another branch");

        expect(readFileSync(join(wsFrontend, "user.txt"), "utf-8")).toBe("preserve");
        const listed = spawnSync("git", ["worktree", "list", "--porcelain"], {
            cwd: nestedRepo,
            encoding: "utf-8",
        });
        expect(listed.stdout).toContain(`worktree ${wsFrontend}`);
        expect(listed.stdout).toContain("branch refs/heads/foreign-stale");
    });

    it("restores stale registration and content when replacement merge fails", () => {
        initRepo(tmpDir);
        const nestedRepo = join(tmpDir, "frontend");
        initRepo(nestedRepo);
        writeFileSync(join(nestedRepo, "app.ts"), "tracked");
        spawnSync("git", ["add", "app.ts"], { cwd: nestedRepo, stdio: "pipe" });
        spawnSync("git", ["commit", "-m", "tracked app"], {
            cwd: nestedRepo,
            stdio: "pipe",
        });
        const wsResult = createWorkspace(tmpDir, "stale-atomic");
        const wsFrontend = join(wsResult.workspacePath, "frontend");
        rmSync(wsFrontend, { recursive: true, force: true });
        mkdirSync(wsFrontend);
        writeFileSync(join(wsFrontend, "app.ts"), "user work");
        writeFileSync(join(wsFrontend, ".git"), "gitdir: /broken/metadata\n");

        expect(() => fixBrokenWorktree(
            tmpDir,
            wsResult.workspacePath,
            "frontend",
            "stale-atomic",
            true,
        )).toThrow("Workspace content conflicts");

        expect(readFileSync(join(wsFrontend, "app.ts"), "utf-8")).toBe("user work");
        const listed = spawnSync("git", ["worktree", "list", "--porcelain"], {
            cwd: nestedRepo,
            encoding: "utf-8",
        });
        expect(listed.stdout).toContain(`worktree ${wsFrontend}`);
        expect(listed.stdout).toContain("branch refs/heads/stale-atomic");
    });

    it("keeps the committed replacement when backup cleanup fails", () => {
        initRepo(tmpDir);
        const nestedRepo = join(tmpDir, "frontend");
        initRepo(nestedRepo);
        const wsResult = createWorkspace(tmpDir, "stale-cleanup");
        const wsFrontend = join(wsResult.workspacePath, "frontend");
        rmSync(wsFrontend, { recursive: true, force: true });
        mkdirSync(wsFrontend);
        writeFileSync(join(wsFrontend, "user.txt"), "preserve");
        writeFileSync(join(wsFrontend, ".git"), "gitdir: /broken/metadata\n");
        let failedBackupPath = "";

        expect(() => fixBrokenWorktree(
            tmpDir,
            wsResult.workspacePath,
            "frontend",
            "stale-cleanup",
            true,
            {
                removeMergedBackup: (path) => {
                    failedBackupPath = path;
                    throw new Error("injected backup cleanup failure");
                },
            },
        )).toThrow("injected backup cleanup failure");

        expect(isValidWorktree(wsFrontend, nestedRepo)).toBe(true);
        expect(readFileSync(join(wsFrontend, "user.txt"), "utf-8")).toBe("preserve");
        const listed = spawnSync("git", ["worktree", "list", "--porcelain"], {
            cwd: nestedRepo,
            encoding: "utf-8",
        });
        expect(listed.stdout.match(new RegExp(`worktree ${wsFrontend}`, "g")))
            .toHaveLength(1);
        expect(listed.stdout).toContain("branch refs/heads/stale-cleanup");

        removeWorkspace(tmpDir, "stale-cleanup", { force: true });
        expect(basename(dirname(failedBackupPath)))
            .toMatch(/^\.ccc-worktree-quarantine-/);
        rmSync(dirname(failedBackupPath), { recursive: true, force: true });
    });

    it("restores the original directory when checked-out content conflicts", () => {
        initRepo(tmpDir);
        initRepo(join(tmpDir, "frontend"));
        writeFileSync(join(tmpDir, "frontend", "app.ts"), "tracked-base");
        spawnSync("git", ["add", "."], { cwd: join(tmpDir, "frontend"), stdio: "pipe" });
        spawnSync("git", ["commit", "-m", "add app"], {
            cwd: join(tmpDir, "frontend"),
            stdio: "pipe",
        });

        const wsResult = createWorkspace(tmpDir, "conflict");
        const wsFrontend = join(wsResult.workspacePath, "frontend");
        spawnSync("git", ["worktree", "remove", "--force", wsFrontend], {
            cwd: join(tmpDir, "frontend"),
            stdio: "pipe",
        });
        mkdirSync(wsFrontend);
        writeFileSync(join(wsFrontend, "app.ts"), "uncommitted-user-work");

        expect(() => fixBrokenWorktree(
            tmpDir,
            wsResult.workspacePath,
            "frontend",
            "conflict",
            true,
        )).toThrow("Workspace content conflicts");
        expect(readFileSync(join(wsFrontend, "app.ts"), "utf-8"))
            .toBe("uncommitted-user-work");
        expect(existsSync(join(wsFrontend, ".git"))).toBe(false);
    });

    it("removes a newly created nested branch after broken-content merge fails", () => {
        initRepo(tmpDir);
        const wsResult = createWorkspace(tmpDir, "new-conflict");
        const nestedRepo = join(tmpDir, "frontend");
        initRepo(nestedRepo);
        writeFileSync(join(nestedRepo, "app.ts"), "tracked-base");
        spawnSync("git", ["add", "app.ts"], { cwd: nestedRepo, stdio: "pipe" });
        spawnSync("git", ["commit", "-m", "tracked app"], {
            cwd: nestedRepo,
            stdio: "pipe",
        });
        const wsFrontend = join(wsResult.workspacePath, "frontend");
        mkdirSync(wsFrontend);
        writeFileSync(join(wsFrontend, "app.ts"), "uncommitted-user-work");

        expect(() => fixBrokenWorktree(
            tmpDir,
            wsResult.workspacePath,
            "frontend",
            "new-conflict",
            true,
        )).toThrow("Workspace content conflicts");
        expect(branchExistsInRepo(nestedRepo, "new-conflict")).toBe("none");
        expect(readFileSync(join(wsFrontend, "app.ts"), "utf-8"))
            .toBe("uncommitted-user-work");
        const listed = spawnSync("git", ["worktree", "list", "--porcelain"], {
            cwd: nestedRepo,
            encoding: "utf-8",
        });
        expect(listed.stdout).not.toContain(wsFrontend);
    });

    it("does not remove a pre-existing legacy backup path", () => {
        initRepo(tmpDir);
        initRepo(join(tmpDir, "frontend"));
        const wsResult = createWorkspace(tmpDir, "legacy-backup");
        const wsFrontend = join(wsResult.workspacePath, "frontend");
        spawnSync("git", ["worktree", "remove", "--force", wsFrontend], {
            cwd: join(tmpDir, "frontend"),
            stdio: "pipe",
        });
        mkdirSync(wsFrontend);
        writeFileSync(join(wsFrontend, "wip.ts"), "preserve");
        const legacyBackup = `${wsFrontend}.ccc-backup`;
        mkdirSync(legacyBackup);
        writeFileSync(join(legacyBackup, "foreign.txt"), "foreign");

        const result = fixBrokenWorktree(
            tmpDir,
            wsResult.workspacePath,
            "frontend",
            "legacy-backup",
            true,
        );

        expect(result).not.toBeNull();
        expect(readFileSync(join(legacyBackup, "foreign.txt"), "utf-8")).toBe("foreign");
    });

    it("refuses deep repair through a symlinked workspace parent", () => {
        const external = join(dirname(tmpDir), `${basename(tmpDir)}-repair-external`);
        try {
            initRepo(tmpDir);
            writeFileSync(join(tmpDir, ".gitignore"), "services/\n");
            spawnSync("git", ["add", ".gitignore"], { cwd: tmpDir, stdio: "pipe" });
            spawnSync("git", ["commit", "-m", "ignore services"], {
                cwd: tmpDir,
                stdio: "pipe",
            });
            const nestedRepo = join(tmpDir, "services", "private", "api");
            initRepo(nestedRepo);
            const wsResult = createWorkspace(tmpDir, "repair-parent-link");
            const nestedWorktree = join(
                wsResult.workspacePath,
                "services",
                "private",
                "api",
            );
            spawnSync("git", ["worktree", "remove", "--force", nestedWorktree], {
                cwd: nestedRepo,
                stdio: "pipe",
            });
            rmSync(join(wsResult.workspacePath, "services"), {
                recursive: true,
                force: true,
            });
            mkdirSync(join(external, "private", "api"), { recursive: true });
            writeFileSync(join(external, "private", "api", "preserve.txt"), "external");
            symlinkSync(
                external,
                join(wsResult.workspacePath, "services"),
                process.platform === "win32" ? "junction" : "dir",
            );

            expect(() => fixBrokenWorktree(
                tmpDir,
                wsResult.workspacePath,
                "services/private/api",
                "repair-parent-link",
                true,
            )).toThrow("parent is not a safe directory");
            expect(readFileSync(
                join(external, "private", "api", "preserve.txt"),
                "utf-8",
            )).toBe("external");
        } finally {
            rmSync(external, { recursive: true, force: true });
        }
    });

    it("initializes nested submodules while replacing broken content", () => {
        const submoduleOrigin = join(dirname(tmpDir), `${basename(tmpDir)}-repair-submodule`);
        try {
            initRepo(tmpDir);
            writeFileSync(join(tmpDir, ".gitignore"), "vendor/\n");
            spawnSync("git", ["add", ".gitignore"], { cwd: tmpDir, stdio: "pipe" });
            spawnSync("git", ["commit", "-m", "ignore vendor"], {
                cwd: tmpDir,
                stdio: "pipe",
            });
            initRepo(submoduleOrigin);
            writeFileSync(join(submoduleOrigin, "child.txt"), "child");
            spawnSync("git", ["add", "child.txt"], {
                cwd: submoduleOrigin,
                stdio: "pipe",
            });
            spawnSync("git", ["commit", "-m", "add child"], {
                cwd: submoduleOrigin,
                stdio: "pipe",
            });
            const nestedRepo = join(tmpDir, "vendor", "platform");
            initRepo(nestedRepo);
            const added = spawnSync(
                "git",
                [
                    "-c",
                    "protocol.file.allow=always",
                    "submodule",
                    "add",
                    submoduleOrigin,
                    "modules/child",
                ],
                { cwd: nestedRepo, encoding: "utf-8", stdio: "pipe" },
            );
            expect(added.status, added.stderr).toBe(0);
            spawnSync("git", ["commit", "-am", "add child submodule"], {
                cwd: nestedRepo,
                stdio: "pipe",
            });
            const previousAllowedProtocol = process.env.GIT_ALLOW_PROTOCOL;
            process.env.GIT_ALLOW_PROTOCOL = "file";
            try {
                const wsResult = createWorkspace(tmpDir, "repair-submodule");
                const nestedWorktree = join(wsResult.workspacePath, "vendor", "platform");
                spawnSync("git", ["worktree", "remove", "--force", nestedWorktree], {
                    cwd: nestedRepo,
                    stdio: "pipe",
                });
                mkdirSync(nestedWorktree, { recursive: true });
                writeFileSync(join(nestedWorktree, "preserve.txt"), "preserve");
                mkdirSync(join(nestedWorktree, "modules", "child"), {
                    recursive: true,
                });
                writeFileSync(
                    join(nestedWorktree, "modules", "child", ".git"),
                    "gitdir: /unowned/stale/metadata\n",
                );

                const fixed = fixBrokenWorktree(
                    tmpDir,
                    wsResult.workspacePath,
                    "vendor/platform",
                    "repair-submodule",
                    true,
                );

                expect(fixed).not.toBeNull();
                expect(readFileSync(
                    join(nestedWorktree, "modules", "child", "child.txt"),
                    "utf-8",
                )).toBe("child");
                expect(readFileSync(join(nestedWorktree, "preserve.txt"), "utf-8"))
                    .toBe("preserve");
                expect(readFileSync(
                    join(nestedWorktree, "modules", "child", ".git"),
                    "utf-8",
                )).not.toContain("/unowned/stale/metadata");
            } finally {
                if (previousAllowedProtocol === undefined) {
                    delete process.env.GIT_ALLOW_PROTOCOL;
                } else {
                    process.env.GIT_ALLOW_PROTOCOL = previousAllowedProtocol;
                }
            }
        } finally {
            rmSync(submoduleOrigin, { recursive: true, force: true });
        }
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

    it("removes unified worktrees for deeply nested ignored repositories", () => {
        initRepo(tmpDir);
        writeFileSync(join(tmpDir, ".gitignore"), "services/private/\n");
        spawnSync("git", ["add", ".gitignore"], { cwd: tmpDir, stdio: "pipe" });
        spawnSync("git", ["commit", "-m", "ignore nested services"], {
            cwd: tmpDir,
            stdio: "pipe",
        });
        const nestedRepo = join(tmpDir, "services", "private", "api");
        initRepo(nestedRepo);

        const wsResult = createWorkspace(tmpDir, "deep-nested-rm");
        const nestedWorktree = join(
            wsResult.workspacePath,
            "services",
            "private",
            "api",
        );
        expect(isValidWorktree(nestedWorktree, nestedRepo)).toBe(true);

        const removeResult = removeWorkspace(tmpDir, "deep-nested-rm");

        expect(removeResult.errors, removeResult.errors.join("; ")).toHaveLength(0);
        expect(removeResult.removed).toContain("services/private/api");
        expect(existsSync(wsResult.workspacePath)).toBe(false);
        const listed = spawnSync("git", ["worktree", "list", "--porcelain"], {
            cwd: nestedRepo,
            encoding: "utf-8",
            stdio: "pipe",
        });
        expect(listed.stdout).not.toContain(nestedWorktree);
    });

    it("removes nested repository worktrees from the deepest repository first", () => {
        initRepo(tmpDir);
        writeFileSync(join(tmpDir, ".gitignore"), "vendor/\n");
        spawnSync("git", ["add", ".gitignore"], { cwd: tmpDir, stdio: "pipe" });
        spawnSync("git", ["commit", "-m", "ignore vendor"], {
            cwd: tmpDir,
            stdio: "pipe",
        });
        const outerRepo = join(tmpDir, "vendor", "platform");
        initRepo(outerRepo);
        writeFileSync(join(outerRepo, ".gitignore"), "plugins/\n");
        spawnSync("git", ["add", ".gitignore"], { cwd: outerRepo, stdio: "pipe" });
        spawnSync("git", ["commit", "-m", "ignore plugins"], {
            cwd: outerRepo,
            stdio: "pipe",
        });
        const innerRepo = join(outerRepo, "plugins", "tool");
        initRepo(innerRepo);
        const wsResult = createWorkspace(tmpDir, "recursive-remove");

        const removeResult = removeWorkspace(tmpDir, "recursive-remove");

        expect(removeResult.errors).toEqual([]);
        expect(removeResult.removed.slice(0, 2)).toEqual([
            "vendor/platform/plugins/tool",
            "vendor/platform",
        ]);
        expect(existsSync(wsResult.workspacePath)).toBe(false);
    });

    it("does not remove an external worktree through a symlinked parent", () => {
        const external = join(dirname(tmpDir), `${basename(tmpDir)}-remove-external`);
        try {
            initRepo(tmpDir);
            writeFileSync(join(tmpDir, ".gitignore"), "services/\n");
            spawnSync("git", ["add", ".gitignore"], { cwd: tmpDir, stdio: "pipe" });
            spawnSync("git", ["commit", "-m", "ignore services"], {
                cwd: tmpDir,
                stdio: "pipe",
            });
            const nestedRepo = join(tmpDir, "services", "private", "api");
            initRepo(nestedRepo);
            const wsResult = createWorkspace(tmpDir, "external-remove");
            const nestedWorktree = join(
                wsResult.workspacePath,
                "services",
                "private",
                "api",
            );
            const externalWorktree = join(external, "private", "api");
            mkdirSync(dirname(externalWorktree), { recursive: true });
            renameSync(nestedWorktree, externalWorktree);
            const repaired = spawnSync(
                "git",
                ["worktree", "repair", externalWorktree],
                { cwd: nestedRepo, encoding: "utf-8", stdio: "pipe" },
            );
            expect(repaired.status, repaired.stderr).toBe(0);
            rmSync(join(wsResult.workspacePath, "services"), {
                recursive: true,
                force: true,
            });
            symlinkSync(
                external,
                join(wsResult.workspacePath, "services"),
                process.platform === "win32" ? "junction" : "dir",
            );

            const removeResult = removeWorkspace(tmpDir, "external-remove", {
                force: true,
            });

            expect(removeResult.errors.join("; "))
                .toContain("parent is not a safe directory");
            expect(isValidWorktree(externalWorktree, nestedRepo)).toBe(true);
        } finally {
            rmSync(external, { recursive: true, force: true });
        }
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

    it("fails closed when required worktree metadata disappears", () => {
        const missing = join(tmpDir, "missing-worktree");
        mkdirSync(missing);

        expect(() => getWorktreeGitMounts(missing, true))
            .toThrow("Required worktree metadata is missing");
    });

    it("fails closed when required worktree metadata is a regular repository directory", () => {
        const repoPath = join(tmpDir, "regular");
        initRepo(repoPath);

        expect(() => getWorktreeGitMounts(repoPath, true))
            .toThrow("Required worktree metadata is invalid");
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

    it("maps a Windows gitdir to a valid absolute Linux container destination", () => {
        expect(containerGitSourceMountPath(
            "/project/repo--feature-id",
            "../repo/.git/worktrees/repo--feature",
            "win32",
        )).toBe("/project/repo/.git");
    });

    it("rejects cross-volume Windows worktree metadata", () => {
        expect(() => portableWorktreeGitDirectory(
            "D:\\work\\repo--feature",
            "C:\\source\\repo\\.git\\worktrees\\repo--feature",
            "win32",
        )).toThrow("crosses incompatible filesystem roots");
    });

    it("accepts case aliases for the same Windows worktree metadata path", () => {
        expect(portableWorktreeGitDirectory(
            "C:\\Work\\repo--feature",
            "c:\\work\\repo\\.git\\worktrees\\repo--feature",
            "win32",
        )).toBe("../repo/.git/worktrees/repo--feature");
    });

    it("normalizes worktree metadata for host and container portability", () => {
        const repoPath = join(tmpDir, "portable-source");
        initRepo(repoPath);
        const wtPath = join(tmpDir, "portable-source--feat");
        spawnSync("git", ["worktree", "add", "-b", "portable-feat", wtPath], {
            cwd: repoPath,
            stdio: "pipe",
        });
        const gitFile = join(wtPath, ".git");
        expect(readFileSync(gitFile, "utf-8")).toContain(join(repoPath, ".git"));

        const mounts = getWorktreeGitMounts(
            wtPath,
            true,
            "/project/portable-source--feat-id",
        );

        const gitLink = readFileSync(gitFile, "utf-8").trim();
        expect(gitLink).toMatch(/^gitdir: \.\.\/portable-source\/\.git\/worktrees\//);
        expect(gitLink).not.toMatch(/[A-Za-z]:[\\/]/);
        expect(mounts.some((mount) => (
            mount.hostPath === join(repoPath, ".git")
            && mount.containerPath === "/project/portable-source/.git"
        ))).toBe(true);
        expect(mounts.every((mount) => (
            mount.containerPath.startsWith("/")
            && !/[A-Za-z]:[\\/]/.test(mount.containerPath)
        ))).toBe(true);

        expect(() => getWorktreeGitMounts(
            wtPath,
            true,
            "/project/portable-source--feat-id",
        )).not.toThrow();
        expect(readdirSync(wtPath).filter((entry) => (
            entry.includes(".git.ccc-")
            && (entry.endsWith(".tmp") || entry.endsWith(".backup"))
        ))).toEqual([]);

        const status = spawnSync("git", ["status", "--short"], {
            cwd: wtPath,
            encoding: "utf-8",
        });
        expect(status.status).toBe(0);
    });

    it("returns verified mounts for every repository in a multi-repo workspace", () => {
        const sourcePath = join(tmpDir, "multi-source");
        mkdirSync(sourcePath);
        initRepo(join(sourcePath, "repo-a"));
        initRepo(join(sourcePath, "repo-b"));
        const result = createWorkspace(sourcePath, "multi-mounts");

        const mounts = getWorktreeGitMounts(result.workspacePath, true);
        expect(mounts.some((mount) => (
            mount.hostPath === join(sourcePath, "repo-a", ".git")
        ))).toBe(true);
        expect(mounts.some((mount) => (
            mount.hostPath === join(sourcePath, "repo-b", ".git")
        ))).toBe(true);
    });

    it("uses unique compatibility mounts for deep repositories with the same basename", () => {
        const sourcePath = join(tmpDir, "duplicate-basename-source");
        initRepo(sourcePath);
        writeFileSync(join(sourcePath, ".gitignore"), "services/\n");
        spawnSync("git", ["add", ".gitignore"], {
            cwd: sourcePath,
            stdio: "pipe",
        });
        spawnSync("git", ["commit", "-m", "ignore services"], {
            cwd: sourcePath,
            stdio: "pipe",
        });
        initRepo(join(sourcePath, "services", "a", "api"));
        initRepo(join(sourcePath, "services", "b", "api"));
        const result = createWorkspace(sourcePath, "duplicate-api");

        const mounts = getWorktreeGitMounts(result.workspacePath, true);

        expect(mounts.some(({ containerPath }) => (
            containerPath === "/project/services/a/api/.git"
        ))).toBe(true);
        expect(mounts.some(({ containerPath }) => (
            containerPath === "/project/services/b/api/.git"
        ))).toBe(true);
    });

    it("rejects mount metadata copied from a different registered worktree", () => {
        const repoPath = join(tmpDir, "source-forged");
        const target = join(tmpDir, "target");
        const foreign = join(tmpDir, "foreign");
        initRepo(repoPath);
        spawnSync("git", ["worktree", "add", "-b", "target", target], {
            cwd: repoPath,
            stdio: "pipe",
        });
        spawnSync("git", ["worktree", "add", "-b", "foreign", foreign], {
            cwd: repoPath,
            stdio: "pipe",
        });
        writeFileSync(join(target, ".git"), readFileSync(join(foreign, ".git"), "utf-8"));

        expect(() => getWorktreeGitMounts(target, true))
            .toThrow(/worktree metadata is invalid|ownership could not be verified/i);
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

        const wtPath = createWorkspace(repoPath, "feat").workspacePath;

        const mounts = getWorktreeGitMounts(
            wtPath,
            true,
            "/project/parent--feat-id",
        );

        // Should have mounts for parent .git
        const parentGitDir = join(repoPath, ".git");
        expect(mounts.some((m) => m.hostPath === parentGitDir)).toBe(true);

        // Should have mounts for nested repo .git
        const nestedGitDir = join(nestedPath, ".git");
        expect(mounts.some((m) => m.hostPath === nestedGitDir)).toBe(true);

        // Should have relative mount for nested repo
        expect(mounts.some((m) => m.containerPath === "/project/parent/nested-repo/.git")).toBe(true);
        expect(mounts.every((mount) => (
            mount.containerPath.startsWith("/")
            && !/[A-Za-z]:[\\/]/.test(mount.containerPath)
        ))).toBe(true);
    });

    it("rejects different Git sources targeting the same container path", () => {
        const repoPath = join(tmpDir, "same-name");
        initRepo(repoPath);
        const nestedPath = join(repoPath, "same-name");
        initRepo(nestedPath);
        writeFileSync(join(repoPath, ".gitignore"), "same-name/\n");
        spawnSync("git", ["add", ".gitignore"], { cwd: repoPath, stdio: "pipe" });
        spawnSync("git", ["commit", "-m", "ignore nested"], {
            cwd: repoPath,
            stdio: "pipe",
        });
        const wtPath = createWorkspace(repoPath, "mount-conflict").workspacePath;

        expect(() => getWorktreeGitMounts(
            wtPath,
            true,
            "/project/same-name--mount-conflict-id",
        )).toThrow("Conflicting Git mount sources target '/project/same-name/.git'");
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
