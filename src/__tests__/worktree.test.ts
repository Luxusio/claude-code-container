import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
    mkdirSync,
    writeFileSync,
    rmSync,
    existsSync,
    symlinkSync,
    readFileSync,
    lstatSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { spawnSync } from "child_process";
import {
    parseWorktreeArg,
    getWorkspacePath,
    validateBranchName,
    WORKTREE_SEPARATOR,
    METADATA_FILE,
    scanDirectory,
    workspaceExists,
    listWorkspaces,
    readWorkspaceMetadata,
    branchExistsInRepo,
    createWorkspace,
    removeWorkspace,
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

describe("readWorkspaceMetadata", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = join(tmpdir(), `ccc-test-${randomUUID()}`);
        mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns null when metadata file does not exist", () => {
        expect(readWorkspaceMetadata(tmpDir)).toBeNull();
    });

    it("returns metadata when file exists", () => {
        const meta = {
            branch: "feature/login",
            sourcePath: "/projects",
            createdAt: "2025-01-01T00:00:00.000Z",
        };
        writeFileSync(join(tmpDir, METADATA_FILE), JSON.stringify(meta));
        const result = readWorkspaceMetadata(tmpDir);
        expect(result).toEqual(meta);
    });

    it("returns null for invalid JSON", () => {
        writeFileSync(join(tmpDir, METADATA_FILE), "not json");
        expect(readWorkspaceMetadata(tmpDir)).toBeNull();
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
        writeFileSync(
            join(wsDir, METADATA_FILE),
            JSON.stringify({
                branch: "feature/login",
                sourcePath: sourceDir,
                createdAt: "2025-01-01T00:00:00.000Z",
            }),
        );

        const workspaces = listWorkspaces(sourceDir);
        expect(workspaces).toHaveLength(1);
        // Original branch name preserved via metadata
        expect(workspaces[0].branch).toBe("feature/login");
    });

    it("falls back to dirname when no metadata", () => {
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

    it("writes metadata file with original branch name", () => {
        initRepo(join(sourceDir, "repo-a"));

        const result = createWorkspace(sourceDir, "feature/login");

        const metaPath = join(result.workspacePath, METADATA_FILE);
        expect(existsSync(metaPath)).toBe(true);

        const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
        expect(meta.branch).toBe("feature/login");
        expect(meta.sourcePath).toBe(join(tmpDir, "projects"));
        expect(meta.createdAt).toBeTruthy();
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

    it("removes metadata file during cleanup", () => {
        initRepo(join(sourceDir, "repo-a"));

        const wsResult = createWorkspace(sourceDir, "meta-clean");
        expect(
            existsSync(join(wsResult.workspacePath, METADATA_FILE)),
        ).toBe(true);

        const removeResult = removeWorkspace(sourceDir, "meta-clean");
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
        expect(result.created).toHaveLength(1);

        // .claude should exist in worktree (tracked by parent git repo)
        expect(
            existsSync(join(result.workspacePath, ".claude", "settings.json")),
        ).toBe(true);
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
});
