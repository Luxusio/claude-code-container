import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MultiRemovalRequest } from "../../ports/workspace/multi-removal.js";
const interception = vi.hoisted(() => ({ calls: [] as MultiRemovalRequest[], refuseFinalScan: false }));
vi.mock("../../application/workspace/multi-removal.js", async () => {
    const actual = await vi.importActual<typeof import("../../application/workspace/multi-removal.js")>("../../application/workspace/multi-removal.js");
    const wrapped: typeof actual.createMultiWorkspaceRemoval = ports => {
        const operation = actual.createMultiWorkspaceRemoval({ ...ports, remainingNames(request) {
            if (interception.refuseFinalScan) {
                const foreign = join(request.destinationPath, "stray"); init(foreign);
            }
            return ports.remainingNames(request);
        } });
        return (request, identity) => { interception.calls.push(request); return operation(request, identity); };
    };
    return { ...actual, createMultiWorkspaceRemoval: wrapped };
});
import { createWorkspace, getWorkspacePath, removeWorkspace } from "../../worktree.js";
function git(repository: string, ...args: string[]): string {
    const result = spawnSync("git", args, { cwd: repository, encoding: "utf8", timeout: 15_000, windowsHide: true });
    expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0); return result.stdout.trim();
}
function init(repository: string): void {
    mkdirSync(repository); git(repository, "init"); git(repository, "config", "user.name", "Removal fixture"); git(repository, "config", "user.email", "test@example.invalid"); git(repository, "config", "commit.gpgsign", "false");
    writeFileSync(join(repository, "tracked.txt"), "original\n"); git(repository, "add", "tracked.txt"); git(repository, "commit", "-m", "initial");
}
describe("multi removal facade retains native ownership", () => {
    let root: string, source: string;
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "ccc-multi-removal-")); const home = join(root, "home"); mkdirSync(home);
        vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", home); vi.stubEnv("GIT_CONFIG_GLOBAL", join(home, "gitconfig")); vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
        source = join(root, "source"); mkdirSync(source); init(join(source, "alpha")); init(join(source, "beta")); writeFileSync(join(source, "plain.txt"), "plain\n");
        interception.calls.length = 0; interception.refuseFinalScan = false;
    });
    afterEach(() => { interception.refuseFinalScan = false; rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
    it("composes actual native removal with original options and preserves source files/config/refs", () => {
        const branch = "remove-success"; createWorkspace(source, branch); const destination = getWorkspacePath(source, branch); const options = { force: false };
        const before = ["alpha", "beta"].map(name => ({ head: git(join(source, name), "rev-parse", "HEAD"), refs: git(join(source, name), "show-ref"), config: readFileSync(join(source, name, ".git", "config"), "utf8") }));
        const result = removeWorkspace(source, branch, options);
        expect(interception.calls).toEqual([{ repositoryPath: source, destinationPath: destination, branch, options }]); expect(interception.calls[0].options).toBe(options);
        expect(result).toEqual({ removed: ["alpha", "beta", "plain.txt"], errors: [] }); expect(existsSync(destination)).toBe(false);
        for (const [index, name] of ["alpha", "beta"].entries()) {
            expect(git(join(source, name), "rev-parse", "HEAD")).toBe(before[index].head); expect(git(join(source, name), "show-ref")).toBe(before[index].refs);
            expect(readFileSync(join(source, name, ".git", "config"), "utf8")).toBe(before[index].config); expect(readFileSync(join(source, name, "tracked.txt"), "utf8")).toBe("original\n");
            expect(git(join(source, name), "worktree", "list", "--porcelain")).not.toContain(destination);
        }
        expect(readFileSync(join(source, "plain.txt"), "utf8")).toBe("plain\n"); result.removed.push("mutable"); result.errors = ["mutable"];
    });
    it("refuses a foreign replacement before entering application even with force", () => {
        const branch = "foreign"; createWorkspace(source, branch); const destination = getWorkspacePath(source, branch);
        git(join(source, "alpha"), "worktree", "remove", join(destination, "alpha")); init(join(destination, "alpha"));
        expect(() => removeWorkspace(source, branch, { force: true })).toThrow(/not owned by its source repository/);
        expect(interception.calls).toEqual([]); expect(readFileSync(join(destination, "alpha", "tracked.txt"), "utf8")).toBe("original\n"); expect(existsSync(join(destination, "beta"))).toBe(true);
    });
    it("keeps dirty registered worktrees until force is explicitly true", () => {
        const branch = "dirty"; createWorkspace(source, branch); const destination = getWorkspacePath(source, branch); writeFileSync(join(destination, "alpha", "tracked.txt"), "dirty\n");
        const refused = removeWorkspace(source, branch); expect(refused.errors.length).toBeGreaterThan(0); expect(refused.removed).toEqual(["beta", "plain.txt"]); expect(readFileSync(join(destination, "alpha", "tracked.txt"), "utf8")).toBe("dirty\n");
        expect(existsSync(join(destination, "beta"))).toBe(false); expect(existsSync(join(destination, "plain.txt"))).toBe(false);
        const callsBeforeRetry = interception.calls.length;
        expect(() => removeWorkspace(source, branch, { force: true })).toThrow(/not owned by its source repository/);
        expect(interception.calls).toHaveLength(callsBeforeRetry); expect(readFileSync(join(destination, "alpha", "tracked.txt"), "utf8")).toBe("dirty\n");
    });
    it("force removes a complete dirty workspace through native registered removal", () => {
        const branch = "dirty-force"; createWorkspace(source, branch); const destination = getWorkspacePath(source, branch); writeFileSync(join(destination, "alpha", "tracked.txt"), "dirty\n");
        expect(removeWorkspace(source, branch, { force: true })).toEqual({ removed: ["alpha", "beta", "plain.txt"], errors: [] }); expect(existsSync(destination)).toBe(false);
        expect(readFileSync(join(source, "alpha", "tracked.txt"), "utf8")).toBe("original\n");
        expect(git(join(source, "alpha"), "worktree", "list", "--porcelain")).not.toContain(destination);
    });
    it("uses a fresh native final scan to preserve a Git repository appearing after child removals", () => {
        const branch = "late-repository"; createWorkspace(source, branch); const destination = getWorkspacePath(source, branch); interception.refuseFinalScan = true;
        expect(removeWorkspace(source, branch, { force: true })).toEqual({ removed: ["alpha", "beta", "plain.txt"], errors: ["Workspace ownership changed before deletion (stray)."] });
        expect(interception.calls).toHaveLength(1); expect(readFileSync(join(destination, "stray", "tracked.txt"), "utf8")).toBe("original\n"); expect(existsSync(join(destination, "stray", ".git"))).toBe(true);
    });
    it("keeps unified dispatch outside multi application", () => {
        const unified = join(root, "unified"); init(unified); const branch = "unified-remove"; createWorkspace(unified, branch);
        expect(removeWorkspace(unified, branch).errors).toEqual([]); expect(interception.calls).toEqual([]); expect(existsSync(getWorkspacePath(unified, branch))).toBe(false);
    });
});
