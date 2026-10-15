import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RootWorkspaceRepairPorts } from "../../ports/workspace/repair-root.js";
import type { WorkspaceRepairAuthority } from "../../domain/workspace/repair-authority.js";

const injection = vi.hoisted(() => ({
    captured: undefined as undefined | ((path: string) => void),
    beforePublication: undefined as undefined | ((path: string) => void),
    published: undefined as undefined | ((path: string) => void),
    metadataCleaned: undefined as undefined | ((path: string) => void),
    initializedIndex: undefined as undefined | (() => void),
    processError: false,
}));
vi.mock("fs", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("fs");
    return { ...actual, rmSync: ((...args: Parameters<typeof actual.rmSync>) => {
        actual.rmSync(...args);
        injection.metadataCleaned?.(String(args[0]));
    }) as typeof actual.rmSync };
});
vi.mock("child_process", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("child_process");
    return { ...actual, spawnSync: ((...args: unknown[]) => {
        const result = Reflect.apply(actual.spawnSync, undefined, args) as ReturnType<typeof actual.spawnSync>;
        const argv = args[1] as string[] | undefined;
        return injection.processError && argv?.[0] === "worktree" && argv[1] === "add"
            ? { ...result, error: new Error("root status-zero process error"), stderr: "  fatal: root native detail  \n" }
            : result;
    }) as typeof actual.spawnSync };
});
vi.mock("../../application/workspace/repair-root.js", async () => {
    const actual = await vi.importActual<typeof import("../../application/workspace/repair-root.js")>("../../application/workspace/repair-root.js");
    const wrapped: typeof actual.createRootWorkspaceRepair = ports => actual.createRootWorkspaceRepair({
        ...ports,
        captureMetadata(path) {
            const snapshot = ports.captureMetadata(path);
            injection.captured?.(path);
            return snapshot;
        },
        publishWorktreeGitLink(...args) {
            const path = join(args[0], ".git");
            injection.beforePublication?.(path);
            const publication = ports.publishWorktreeGitLink(...args);
            injection.published?.(path);
            return publication;
        },
        publishWorktreeBackpointer(...args) {
            injection.beforePublication?.(args[0]);
            const publication = ports.publishWorktreeBackpointer(...args);
            injection.published?.(args[0]);
            return publication;
        },
        initializeTemporaryIndex(...args) {
            const result = ports.initializeTemporaryIndex(...args);
            injection.initializedIndex?.();
            return result;
        },
    });
    return { ...actual, createRootWorkspaceRepair: wrapped };
});
import { createRootWorkspaceRepair } from "../../application/workspace/repair-root.js";
import { createWorkspace, isValidWorktree, repairWorkspaceRootOwnership } from "../../worktree.js";

function git(repository: string, ...args: string[]): string {
    const result = spawnSync("git", args, { cwd: repository, encoding: "utf8", timeout: 15_000, windowsHide: true });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
}

describe("root repair semantic admission and native metadata ownership", () => {
    let root: string;
    let source: string;
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "ccc-root-repair-"));
        source = join(root, "source");
        mkdirSync(source);
        git(source, "init");
        git(source, "config", "user.name", "Root repair fixture");
        git(source, "config", "user.email", "test@example.invalid");
        git(source, "config", "commit.gpgsign", "false");
        writeFileSync(join(source, "owned.txt"), "original\n");
        git(source, "add", "owned.txt");
        git(source, "commit", "-m", "initial");
    });
    afterEach(() => {
        injection.captured = undefined;
        injection.beforePublication = undefined;
        injection.published = undefined;
        injection.metadataCleaned = undefined;
        injection.initializedIndex = undefined;
        injection.processError = false;
        rmSync(root, { recursive: true, force: true });
    });

    function brokenRoot(missing: boolean) {
        const branch = "repair-topic";
        const workspace = createWorkspace(source, branch).workspacePath;
        const gitFile = join(workspace, ".git");
        const management = resolve(workspace, readFileSync(gitFile, "utf8").trim().replace(/^gitdir:\s*/, ""));
        const target = missing ? gitFile : join(management, "gitdir");
        writeFileSync(join(workspace, "owned.txt"), "operator edit\n");
        writeFileSync(join(workspace, "untracked.txt"), "operator addition\n");
        if (missing) rmSync(management, { recursive: true });
        else writeFileSync(target, `${join(root, "old-location", ".git")}\n`);
        const original = readFileSync(target);
        const recover = (reportFailure?: (reason: string) => void) => repairWorkspaceRootOwnership(workspace, source, branch,
            missing ? { confirmedMissingRegistration: true, reportFailure } : undefined);
        const assertContent = () => {
            expect(readFileSync(join(workspace, "owned.txt"), "utf8")).toBe("operator edit\n");
            expect(readFileSync(join(workspace, "untracked.txt"), "utf8")).toBe("operator addition\n");
        };
        return { workspace, gitFile, management, target, original, recover, assertContent };
    }

    it("refuses an already-valid registration and reports the semantic admission reason", () => {
        const report = vi.fn();
        const admission: Pick<RootWorkspaceRepairPorts<WorkspaceRepairAuthority>, "isValidWorktree"> = { isValidWorktree: () => true };
        const ports = admission as RootWorkspaceRepairPorts<WorkspaceRepairAuthority>;
        expect(createRootWorkspaceRepair(ports).handleWorkspaceRootOwnership("workspace", "source", "branch", "confirmed", report)).toBe(false);
        expect(report).toHaveBeenCalledExactlyOnceWith("workspace registration is already valid");
    });

    it.each([false, true])("repairs root registration without changing operator files, missing=%s", missing => {
        const f = brokenRoot(missing);
        expect(f.recover()).toBe(true);
        expect(isValidWorktree(f.workspace, source)).toBe(true);
        expect(git(f.workspace, "diff", "--name-only")).toBe("owned.txt");
        f.assertContent();
    });

    it.each([
        [false, "native cleanup"], [true, "native cleanup"],
        [false, "port return"], [true, "port return"],
    ] as const)("refuses a same-byte inode successor, missing=%s, replacement after %s", (missing, stage) => {
        const f = brokenRoot(missing);
        let successor: { bytes: Buffer; ino: number | bigint } | undefined;
        const replace = () => {
            injection.published = undefined;
            injection.metadataCleaned = undefined;
            const bytes = readFileSync(f.target);
            const stagedInode = lstatSync(f.target).ino;
            const replacement = join(root, "metadata-successor");
            writeFileSync(replacement, bytes);
            renameSync(replacement, f.target);
            successor = { bytes, ino: lstatSync(f.target).ino };
            expect(successor.ino).not.toBe(stagedInode);
        };
        if (stage === "port return") injection.published = path => { if (path === f.target) replace(); };
        else injection.metadataCleaned = path => {
            if (dirname(path) === dirname(f.target)
                && basename(path).startsWith(`.${basename(f.target)}.ccc-`)
                && path.endsWith(".backup")) replace();
        };
        expect(() => f.recover()).toThrow(/recovery rollback failed/i);
        expect(successor).toBeDefined();
        expect(readFileSync(f.target)).toEqual(successor!.bytes);
        expect(lstatSync(f.target).ino).toBe(successor!.ino);
        f.assertContent();
    });

    it("compares original bytes when different invalid UTF-8 bytes decode to the same text", () => {
        const f = brokenRoot(false);
        const prefix = Buffer.from(`${join(root, "old-location")}/invalid-`);
        const before = Buffer.concat([prefix, Buffer.from([0x80]), Buffer.from("/.git\n")]);
        const successor = Buffer.concat([prefix, Buffer.from([0x81]), Buffer.from("/.git\n")]);
        expect(before.toString("utf8")).toBe(successor.toString("utf8"));
        writeFileSync(f.target, before);
        injection.captured = path => {
            if (path !== f.target) return;
            injection.captured = undefined;
            writeFileSync(path, successor);
        };
        expect(f.recover()).toBe(false);
        expect(readFileSync(f.target)).toEqual(successor);
        f.assertContent();
    });

    it("rejects a changed predecessor even when publication would otherwise be a no-op", () => {
        const f = brokenRoot(false);
        let successor: Buffer | undefined;
        injection.beforePublication = path => {
            if (path !== f.target) return;
            injection.beforePublication = undefined;
            successor = Buffer.from(`${f.gitFile}\n`);
            writeFileSync(path, successor);
        };
        expect(f.recover()).toBe(false);
        expect(successor).toBeDefined();
        expect(readFileSync(f.target)).toEqual(successor);
        f.assertContent();
    });

    it("refuses a temporary index that disagrees with the branch and cleans its registration", () => {
        const f = brokenRoot(true);
        const registrations = git(source, "worktree", "list", "--porcelain");
        injection.initializedIndex = () => {
            injection.initializedIndex = undefined;
            const managementRoot = join(source, ".git", "worktrees");
            const entries = readdirSync(managementRoot);
            expect(entries).toHaveLength(1);
            const temporaryGit = join(managementRoot, entries[0]);
            const result = spawnSync("git", ["--git-dir", temporaryGit, "read-tree", "--empty"], { encoding: "utf8", stdio: "pipe" });
            expect(result.status, result.stderr).toBe(0);
        };
        const failure = vi.fn();
        expect(f.recover(failure)).toBe(false);
        expect(failure).toHaveBeenCalledWith(expect.stringContaining("temporary index does not match the expected branch"));
        expect(git(source, "worktree", "list", "--porcelain")).toBe(registrations);
        expect(readFileSync(f.gitFile)).toEqual(f.original);
        f.assertContent();
    });

    it("retains root's error-plus-status refusal and diagnostic after a side-effecting status-zero add", () => {
        const f = brokenRoot(true);
        injection.processError = true;
        const failure = vi.fn();
        expect(f.recover(failure)).toBe(false);
        injection.processError = false;
        expect(failure).toHaveBeenCalledWith("git worktree add failed: fatal: root native detail");
        expect(git(source, "worktree", "list", "--porcelain")).not.toContain("ccc-register-");
        expect(readFileSync(f.gitFile)).toEqual(f.original);
        f.assertContent();
    });
});
