import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import childProcess, { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { isolateGitFixture } from "./helpers/git-fixture.js";
import { assertWorkspaceRootOwnership, createWorkspace, isValidWorktree, repairWorkspaceRootOwnership } from "../worktree.js";

describe("existing root worktree branch recovery", () => {
    let home: string;
    let restoreEnvironment: () => void;
    let root: string;
    let source: string;

    const git = (cwd: string, ...args: string[]): string => {
        const result = spawnSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        return result.stdout;
    };

    beforeAll(() => {
        home = mkdtempSync(join(tmpdir(), "ccc-root-repair-home-"));
        restoreEnvironment = isolateGitFixture(home);
    });
    afterAll(() => {
        restoreEnvironment();
        rmSync(home, { recursive: true, force: true });
    });
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "ccc-root-branch-repair-"));
        source = join(root, "source");
        mkdirSync(source);
        git(source, "init", "--initial-branch=master");
        git(source, "config", "user.name", "CCC Test");
        git(source, "config", "user.email", "test@localhost");
        git(source, "config", "commit.gpgsign", "false");
        writeFileSync(join(source, "tracked.txt"), "committed\n");
        git(source, "add", "tracked.txt");
        git(source, "commit", "-m", "initial");
    });
    afterEach(() => {
        vi.restoreAllMocks();
        syncBuiltinESMExports();
        rmSync(root, { recursive: true, force: true });
    });

    function fixture(independent = true) {
        const requested = "directory-alias";
        const { workspacePath: workspace } = createWorkspace(source, requested);
        if (independent) git(workspace, "switch", "-c", "actual-selected-branch");
        const gitFile = join(workspace, ".git");
        const management = resolve(workspace, readFileSync(gitFile, "utf-8").trim().replace(/^gitdir:\s*/, ""));
        const head = join(management, "HEAD");
        const backpointer = join(management, "gitdir");
        writeFileSync(join(workspace, "tracked.txt"), "unstaged work\n");
        writeFileSync(join(workspace, "staged.txt"), "staged work\n");
        git(workspace, "add", "staged.txt");
        writeFileSync(join(workspace, "untracked.txt"), "untracked work\n");
        const capture = () => ({
            gitFile: readFileSync(gitFile),
            head: readFileSync(head),
            index: readFileSync(join(management, "index")),
            refs: git(source, "show-ref", "--heads"),
            files: ["tracked.txt", "staged.txt", "untracked.txt"].map(name => readFileSync(join(workspace, name))),
        });
        const stale = `${join(root, "absent-container-path", ".git")}\n`;
        writeFileSync(backpointer, stale);
        return { requested, workspace, management, head, backpointer, stale, capture };
    }

    it.each([false, true])("repairs the stale backpointer while preserving checkout state (independent branch: %s)", independent => {
        const f = fixture(independent);
        const before = f.capture();
        expect(isValidWorktree(f.workspace, source)).toBe(false);
        expect(repairWorkspaceRootOwnership(f.workspace, source, f.requested)).toBe(true);
        expect(f.capture()).toEqual(before);
        expect(isValidWorktree(f.workspace, source)).toBe(true);
        expect(() => assertWorkspaceRootOwnership(f.workspace, source)).not.toThrow();
        expect(git(f.workspace, "branch", "--show-current").trim()).toBe(independent ? "actual-selected-branch" : f.requested);
        expect(git(f.workspace, "status", "--short")).toContain(" M tracked.txt");
        expect(git(f.workspace, "status", "--short")).toContain("A  staged.txt");
        expect(git(f.workspace, "status", "--short")).toContain("?? untracked.txt");
    });

    it("refuses a renamed root branch that is also checked out in the source", () => {
        const f = fixture();
        git(source, "switch", "--ignore-other-worktrees", "actual-selected-branch");
        const before = f.capture();
        expect(() => repairWorkspaceRootOwnership(f.workspace, source, f.requested)).toThrow("refusing unsafe shared-branch worktree");
        expect(f.capture()).toEqual(before);
        expect(readFileSync(f.backpointer, "utf-8")).toBe(f.stale);
    });

    it.each(["before-publication", "after-publication"] as const)("refuses a replaced administrative HEAD %s", phase => {
        const f = fixture();
        const before = f.capture();
        const originalSpawn = childProcess.spawnSync;
        let probes = 0;
        let replaced = false;
        vi.spyOn(childProcess, "spawnSync").mockImplementation(((command: string, args: string[], options: unknown) => {
            const result = originalSpawn(command, args, options as never);
            if (command === "git" && args[0] === "rev-parse" && args.includes("refs/heads/actual-selected-branch^{commit}")) {
                probes++;
                if (probes === (phase === "before-publication" ? 1 : 2)) {
                    renameSync(f.head, join(f.management, "preserved-old-HEAD"));
                    writeFileSync(f.head, before.head);
                    replaced = true;
                }
            }
            return result;
        }) as typeof childProcess.spawnSync);
        syncBuiltinESMExports();
        expect(repairWorkspaceRootOwnership(f.workspace, source, f.requested)).toBe(false);
        expect(replaced).toBe(true);
        expect(f.capture()).toEqual(before);
        expect(readFileSync(f.backpointer, "utf-8")).toBe(f.stale);
    });
});
