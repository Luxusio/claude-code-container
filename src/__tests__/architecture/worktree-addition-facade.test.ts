import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { WorktreeAdditionRequest } from "../../ports/workspace/worktree-addition.js";

const interception = vi.hoisted(() => ({ requests: [] as WorktreeAdditionRequest[], receipts: [] as unknown[], snapshot: undefined as undefined | ((request: WorktreeAdditionRequest) => void) }));
vi.mock("../../application/workspace/worktree-addition.js", async () => {
    const actual = await vi.importActual<typeof import("../../application/workspace/worktree-addition.js")>("../../application/workspace/worktree-addition.js");
    const wrapped: typeof actual.createWorktreeAddition = ports => {
        const add = actual.createWorktreeAddition(ports);
        return request => {
            const result = add(request);
            interception.requests.push(request);
            interception.receipts.push(result.registrationReceipt);
            interception.snapshot?.(request);
            return { ...result, registrationReceipt: null };
        };
    };
    return { ...actual, createWorktreeAddition: wrapped };
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
    git(repository, "config", "user.name", "Worktree test");
    git(repository, "config", "user.email", "test@example.invalid");
    git(repository, "config", "commit.gpgsign", "false");
    writeFileSync(join(repository, "owned.txt"), "owned file\n");
    git(repository, "add", "owned.txt");
    git(repository, "commit", "-m", "initial");
}
function captured(run: () => unknown): Error {
    try { run(); } catch (error) { expect(error).toBeInstanceOf(Error); return error as Error; }
    throw new Error("Expected registration rejection");
}
function registrationSnapshot(request: WorktreeAdditionRequest) {
    const gitFile = readFileSync(join(request.destinationPath, ".git"), "utf8");
    const management = resolve(request.destinationPath, gitFile.trim().replace(/^gitdir:\s*/, ""));
    return {
        gitFile,
        managementHead: readFileSync(join(management, "HEAD"), "utf8"),
        backpointer: readFileSync(join(management, "gitdir"), "utf8"),
        index: readFileSync(join(management, "index")).toString("hex"),
        oid: git(request.repositoryPath, "rev-parse", `refs/heads/${request.branch}`),
        registrations: git(request.repositoryPath, "worktree", "list", "--porcelain"),
        owned: readFileSync(join(request.destinationPath, "owned.txt"), "utf8"),
    };
}

describe("real native worktree addition registration validation", () => {
    let root: string;
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "ccc-worktree-addition-"));
        interception.requests.length = 0;
        interception.receipts.length = 0;
        interception.snapshot = undefined;
    });
    afterEach(() => {
        interception.snapshot = undefined;
        rmSync(root, { recursive: true, force: true });
    });

    it("unified validates before nested repair and preserves the actual added root registration", () => {
        const source = join(root, "source");
        const child = join(root, "submodule-source");
        init(source);
        init(child);
        git(source, "-c", "protocol.file.allow=always", "submodule", "add", child, "nested");
        git(source, "commit", "-am", "nested repository");
        const branch = "unified-fixture";
        const destination = getWorkspacePath(source, branch);
        let before: ReturnType<typeof registrationSnapshot> | undefined;
        interception.snapshot = request => { before = registrationSnapshot(request); };
        const error = captured(() => createWorkspace(source, branch));
        expect(error.message).toBe(`Missing worktree registration ownership fence: ${destination}`);
        expect(error.cause).toBeUndefined();
        expect(interception.requests).toEqual([{ repositoryPath: source, destinationPath: destination, branch, failureContext: { kind: "unified" } }]);
        expect(interception.receipts[0]).not.toBeNull();
        expect(before).toBeDefined();
        expect(registrationSnapshot(interception.requests[0])).toEqual(before);
        expect(existsSync(join(destination, "nested", ".git"))).toBe(false);
        expect(git(child, "worktree", "list", "--porcelain")).not.toContain(destination);
    });

    it("multi records the actual child before validation and preserves it when outer rollback lacks a receipt", () => {
        const source = join(root, "collection");
        const repository = join(source, "owned-repo");
        init(repository);
        writeFileSync(join(source, "copy-later.txt"), "should not be copied");
        const branch = "multi-fixture";
        const workspace = getWorkspacePath(source, branch);
        const destination = join(workspace, "owned-repo");
        let before: ReturnType<typeof registrationSnapshot> | undefined;
        interception.snapshot = request => { before = registrationSnapshot(request); };
        const error = captured(() => createWorkspace(source, branch));
        const original = `Missing worktree registration ownership fence: ${destination}`;
        expect(error.message).toBe(`${original}; workspace rollback failed: owned-repo: missing worktree registration fence`);
        expect(error.cause).toBeInstanceOf(Error);
        expect((error.cause as Error).message).toBe(original);
        expect(interception.requests).toEqual([{ repositoryPath: repository, destinationPath: destination, branch, failureContext: { kind: "multi-repo", repositoryName: "owned-repo" } }]);
        expect(interception.receipts[0]).not.toBeNull();
        expect(before).toBeDefined();
        expect(registrationSnapshot(interception.requests[0])).toEqual(before);
        expect(existsSync(join(workspace, "copy-later.txt"))).toBe(false);
    });
});
