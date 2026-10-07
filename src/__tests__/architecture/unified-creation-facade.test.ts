import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { UnifiedCreationRequest } from "../../ports/workspace/unified-creation.js";

const interception = vi.hoisted(() => ({
    calls: [] as UnifiedCreationRequest[],
    repairFailure: undefined as undefined | ((request: UnifiedCreationRequest) => never),
}));
vi.mock("../../application/workspace/unified-creation.js", async () => {
    const actual = await vi.importActual<typeof import("../../application/workspace/unified-creation.js")>("../../application/workspace/unified-creation.js");
    const wrapped: typeof actual.createUnifiedWorkspaceCreation = ports => actual.createUnifiedWorkspaceCreation({
        ...ports,
        repairNestedWorktrees(request) {
            interception.calls.push(request);
            if (interception.repairFailure) return interception.repairFailure(request);
            return ports.repairNestedWorktrees(request);
        },
    });
    return { ...actual, createUnifiedWorkspaceCreation: wrapped };
});
import { createWorkspace, getWorkspacePath } from "../../worktree.js";

function git(repository: string, ...args: string[]): string {
    const result = spawnSync("git", args, { cwd: repository, encoding: "utf8", timeout: 15_000, windowsHide: true });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
}
function init(repository: string): void {
    mkdirSync(repository, { recursive: true });
    git(repository, "init");
    git(repository, "config", "user.name", "Unified workspace fixture");
    git(repository, "config", "user.email", "test@example.invalid");
    git(repository, "config", "commit.gpgsign", "false");
    writeFileSync(join(repository, "owned.txt"), "initial content\n");
    git(repository, "add", "owned.txt");
    git(repository, "commit", "-m", "initial");
}
function caught(run: () => unknown): Error {
    try { run(); } catch (error) { expect(error).toBeInstanceOf(Error); return error as Error; }
    throw new Error("Expected injected repair failure");
}
function branchExists(source: string, branch: string): boolean {
    const result = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: source, encoding: "utf8", timeout: 15_000, windowsHide: true });
    expect(result.error).toBeUndefined();
    expect([0, 1]).toContain(result.status);
    return result.status === 0;
}
function nativeMetadata(destination: string) {
    const gitFile = readFileSync(join(destination, ".git"), "utf8");
    const management = resolve(destination, gitFile.trim().replace(/^gitdir:\s*/, ""));
    return {
        gitFile,
        head: readFileSync(join(management, "HEAD"), "utf8"),
        backpointer: readFileSync(join(management, "gitdir"), "utf8"),
        index: readFileSync(join(management, "index")).toString("hex"),
    };
}

describe("unified creation facade with real native ownership and Git", () => {
    let root: string;
    let source: string;
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "ccc-unified-creation-"));
        const home = join(root, "home");
        mkdirSync(home);
        vi.stubEnv("HOME", home);
        vi.stubEnv("USERPROFILE", home);
        vi.stubEnv("GIT_CONFIG_GLOBAL", join(home, "gitconfig"));
        vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
        interception.calls.length = 0;
        interception.repairFailure = undefined;
        source = join(root, "source");
        init(source);
    });
    afterEach(() => {
        interception.repairFailure = undefined;
        rmSync(root, { recursive: true, force: true });
        vi.unstubAllEnvs();
    });

    it("delegates real root and nested creation through the factory with root-first mutable results", () => {
        const child = join(root, "child-source");
        init(child);
        git(source, "-c", "protocol.file.allow=always", "submodule", "add", child, "nested");
        git(source, "commit", "-am", "nested repository");
        const branch = "unified-success";
        const destination = getWorkspacePath(source, branch);
        const result = createWorkspace(source, branch);
        expect(interception.calls).toEqual([{ repositoryPath: source, destinationPath: destination, branch }]);
        expect(result.workspacePath).toBe(destination);
        expect(result.created).toEqual([
            { name: "source", branch, action: "worktree-new" },
            { name: "nested", branch, action: "worktree-new" },
        ]);
        expect(result.copied).toEqual([]);
        expect(readFileSync(join(destination, "owned.txt"), "utf8")).toBe("initial content\n");
        expect(git(destination, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);
        expect(git(join(destination, "nested"), "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);
        result.copied.push("mutable");
        result.created[0].name = "mutable root name";
        expect(result.copied).toEqual(["mutable"]);
    });
    it("removes only its added root and new branch after native repair failure", () => {
        const branch = "compensated-new";
        const destination = getWorkspacePath(source, branch);
        const original = new Error("injected nested repair failure");
        interception.repairFailure = request => {
            expect(request).toEqual({ repositoryPath: source, destinationPath: destination, branch });
            expect(existsSync(join(destination, ".git"))).toBe(true);
            expect(branchExists(source, branch)).toBe(true);
            throw original;
        };
        expect(caught(() => createWorkspace(source, branch))).toBe(original);
        expect(interception.calls).toHaveLength(1);
        expect(existsSync(destination)).toBe(false);
        expect(branchExists(source, branch)).toBe(false);
        expect(git(source, "worktree", "list", "--porcelain")).not.toContain(destination);
        expect(readFileSync(join(source, "owned.txt"), "utf8")).toBe("initial content\n");
    });
    it("removes its failed root while retaining a pre-existing local branch", () => {
        const branch = "existing-root";
        git(source, "branch", branch);
        const oid = git(source, "rev-parse", `refs/heads/${branch}`);
        const original = new Error("injected repair failure");
        interception.repairFailure = () => { throw original; };
        expect(caught(() => createWorkspace(source, branch))).toBe(original);
        expect(existsSync(getWorkspacePath(source, branch))).toBe(false);
        expect(git(source, "rev-parse", `refs/heads/${branch}`)).toBe(oid);
    });
    it("preserves a replacement directory when native registration inode identity changes", () => {
        const branch = "inode-conflict";
        const destination = getWorkspacePath(source, branch);
        const saved = join(root, "saved-original-root");
        const original = new Error("injected repair failure");
        let registration = "";
        interception.repairFailure = () => {
            registration = readFileSync(join(destination, ".git"), "utf8");
            renameSync(destination, saved);
            mkdirSync(destination);
            copyFileSync(join(saved, ".git"), join(destination, ".git"));
            writeFileSync(join(destination, "replacement.txt"), "successor content\n");
            throw original;
        };
        const error = caught(() => createWorkspace(source, branch));
        expect(error.message).toContain("workspace rollback failed:");
        expect(error.cause).toBe(original);
        expect(readFileSync(join(destination, "replacement.txt"), "utf8")).toBe("successor content\n");
        expect(readFileSync(join(destination, ".git"), "utf8")).toBe(registration);
        expect(readFileSync(join(saved, "owned.txt"), "utf8")).toBe("initial content\n");
        expect(branchExists(source, branch)).toBe(true);
        expect(git(source, "worktree", "list", "--porcelain")).toContain(destination);
    });
    it("preserves changed ownership and its branch instead of deleting by path", () => {
        const foreign = join(root, "foreign");
        init(foreign);
        const branch = "ownership-conflict";
        const destination = getWorkspacePath(source, branch);
        const original = new Error("injected repair failure");
        const foreignGit = `gitdir: ${join(foreign, ".git")}\n`;
        interception.repairFailure = () => {
            writeFileSync(join(destination, ".git"), foreignGit);
            writeFileSync(join(destination, "successor.txt"), "foreign content\n");
            throw original;
        };
        const error = caught(() => createWorkspace(source, branch));
        expect(error.message).toBe("injected repair failure; workspace rollback failed: root worktree ownership changed during rollback");
        expect(error.cause).toBe(original);
        expect(readFileSync(join(destination, ".git"), "utf8")).toBe(foreignGit);
        expect(readFileSync(join(destination, "successor.txt"), "utf8")).toBe("foreign content\n");
        expect(branchExists(source, branch)).toBe(true);
        expect(git(foreign, "status", "--porcelain")).toBe("");
    });
    it("retains root registration and a changed branch ref when the native OID fence refuses removal", () => {
        const branch = "ref-conflict";
        const destination = getWorkspacePath(source, branch);
        const original = new Error("injected repair failure");
        let successor = "";
        let before: ReturnType<typeof nativeMetadata> | undefined;
        interception.repairFailure = () => {
            before = nativeMetadata(destination);
            writeFileSync(join(source, "later.txt"), "later commit\n");
            git(source, "add", "later.txt");
            git(source, "commit", "-m", "successor commit");
            successor = git(source, "rev-parse", "HEAD");
            git(source, "update-ref", `refs/heads/${branch}`, successor);
            throw original;
        };
        const error = caught(() => createWorkspace(source, branch));
        expect(error.message).toBe(`injected repair failure; workspace rollback failed: Worktree registration ownership changed before deletion: ${destination}`);
        expect(error.cause).toBe(original);
        expect(existsSync(destination)).toBe(true);
        expect(before).toBeDefined();
        expect(nativeMetadata(destination)).toEqual(before);
        expect(readFileSync(join(destination, "owned.txt"), "utf8")).toBe("initial content\n");
        expect(git(source, "rev-parse", `refs/heads/${branch}`)).toBe(successor);
        expect(git(source, "worktree", "list", "--porcelain")).toContain(destination);
    });
});
