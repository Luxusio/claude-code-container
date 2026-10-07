import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MultiCreationRequest } from "../../ports/workspace/multi-creation.js";

const interception = vi.hoisted(() => ({
    calls: [] as MultiCreationRequest[],
    rejectRegistration: false,
    partialCopy: false,
}));
vi.mock("../../application/workspace/multi-creation.js", async () => {
    const actual = await vi.importActual<typeof import("../../application/workspace/multi-creation.js")>("../../application/workspace/multi-creation.js");
    const wrapped: typeof actual.createMultiWorkspaceCreation = ports => {
        const operation = actual.createMultiWorkspaceCreation({
            ...ports,
            requireRegistration(receipt, destination) {
                if (interception.rejectRegistration) return ports.requireRegistration(null, destination);
                return ports.requireRegistration(receipt, destination);
            },
            copyEntry(source, destination) {
                if (interception.partialCopy) {
                    writeFileSync(destination, "unsafe partial copy\n");
                    throw new Error("injected partial copy failure");
                }
                return ports.copyEntry(source, destination);
            },
        });
        return request => { interception.calls.push(request); return operation(request); };
    };
    return { ...actual, createMultiWorkspaceCreation: wrapped };
});
import { createWorkspace, getWorkspacePath } from "../../worktree.js";

function git(repository: string, ...args: string[]): string {
    const result = spawnSync("git", args, { cwd: repository, encoding: "utf8", timeout: 15_000, windowsHide: true });
    expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
}
function init(repository: string): void {
    mkdirSync(repository);
    git(repository, "init");
    git(repository, "config", "user.name", "Multi workspace fixture");
    git(repository, "config", "user.email", "test@example.invalid");
    git(repository, "config", "commit.gpgsign", "false");
    writeFileSync(join(repository, "tracked.txt"), "original\n");
    git(repository, "add", "tracked.txt"); git(repository, "commit", "-m", "initial");
}
function thrown(run: () => unknown): Error {
    try { run(); } catch (error) { expect(error).toBeInstanceOf(Error); return error as Error; }
    throw new Error("Expected operation to throw");
}
function branchExists(source: string, branch: string): boolean {
    const result = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: source, encoding: "utf8", timeout: 15_000, windowsHide: true });
    expect(result.error).toBeUndefined(); expect([0, 1]).toContain(result.status);
    return result.status === 0;
}

describe("multi creation facade using real Git and native ownership", () => {
    let root: string;
    let source: string;
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "ccc-multi-creation-"));
        const home = join(root, "home"); mkdirSync(home);
        vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", home);
        vi.stubEnv("GIT_CONFIG_GLOBAL", join(home, "gitconfig")); vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
        source = join(root, "source"); mkdirSync(source);
        init(join(source, "alpha")); init(join(source, "beta"));
        writeFileSync(join(source, "plain.txt"), "plain content\n");
        interception.calls.length = 0; interception.rejectRegistration = false; interception.partialCopy = false;
    });
    afterEach(() => {
        interception.rejectRegistration = false; interception.partialCopy = false;
        rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs();
    });
    it("routes multiple repos and ordinary files through application with synchronous mutable legacy results", () => {
        const branch = "multi-success"; const destination = getWorkspacePath(source, branch);
        const result = createWorkspace(source, branch);
        expect(interception.calls).toEqual([{ repositoryPath: source, destinationPath: destination, branch }]);
        expect(result.workspacePath).toBe(destination);
        expect(result.created).toEqual(["alpha", "beta"].map(name => ({ name, branch, action: "worktree-new" })));
        expect(result.copied).toEqual(["plain.txt"]);
        for (const name of ["alpha", "beta"]) {
            expect(git(join(destination, name), "branch", "--show-current")).toBe(branch);
            expect(git(join(source, name), "worktree", "list", "--porcelain")).toContain(join(destination, name));
        }
        expect(readFileSync(join(destination, "plain.txt"), "utf8")).toBe("plain content\n");
        result.created[0].name = "mutable"; result.copied.push("mutable");
        expect(result).not.toHaveProperty("then");
    });
    it("retains side-effecting successful add and branch when registration receipt validation fails", () => {
        interception.rejectRegistration = true;
        const branch = "unreceipted-add"; const destination = getWorkspacePath(source, branch);
        const error = thrown(() => createWorkspace(source, branch));
        expect(error.message).toContain("workspace rollback failed: alpha: missing worktree registration fence");
        expect(error.cause).toBeInstanceOf(Error);
        expect(existsSync(join(destination, "alpha", ".git"))).toBe(true);
        expect(branchExists(join(source, "alpha"), branch)).toBe(true);
        expect(git(join(source, "alpha"), "worktree", "list", "--porcelain")).toContain(join(destination, "alpha"));
        expect(branchExists(join(source, "beta"), branch)).toBe(false);
        expect(existsSync(join(destination, "beta"))).toBe(false);
    });
    it("compensates owned new branches and worktrees but preserves unsafe partial copied content", () => {
        interception.partialCopy = true;
        const branch = "partial-copy"; const destination = getWorkspacePath(source, branch);
        const error = thrown(() => createWorkspace(source, branch));
        expect(error.message).toBe("injected partial copy failure; workspace rollback failed: plain.txt: partial copied content was preserved");
        expect((error.cause as Error).message).toBe("injected partial copy failure");
        expect(readFileSync(join(destination, "plain.txt"), "utf8")).toBe("unsafe partial copy\n");
        for (const name of ["alpha", "beta"]) {
            expect(existsSync(join(destination, name))).toBe(false);
            expect(branchExists(join(source, name), branch)).toBe(false);
            expect(git(join(source, name), "worktree", "list", "--porcelain")).not.toContain(join(destination, name));
            expect(readFileSync(join(source, name, "tracked.txt"), "utf8")).toBe("original\n");
        }
    });
    it("compensates owned worktrees while preserving pre-existing branch OIDs", () => {
        const branch = "existing-branches";
        const oids = ["alpha", "beta"].map(name => { git(join(source, name), "branch", branch); return git(join(source, name), "rev-parse", `refs/heads/${branch}`); });
        interception.partialCopy = true;
        thrown(() => createWorkspace(source, branch));
        for (const [index, name] of ["alpha", "beta"].entries()) {
            expect(git(join(source, name), "rev-parse", `refs/heads/${branch}`)).toBe(oids[index]);
            expect(existsSync(join(getWorkspacePath(source, branch), name))).toBe(false);
        }
    });
});
