import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { UnifiedRemovalRequest } from "../../ports/workspace/unified-removal.js";
const interception = vi.hoisted(() => ({
    calls: [] as UnifiedRemovalRequest[],
    lateContent: false
}));
vi.mock("../../application/workspace/unified-removal.js", async () => {
    const actual = await vi.importActual<typeof import("../../application/workspace/unified-removal.js")>("../../application/workspace/unified-removal.js");
    const wrapped: typeof actual.createUnifiedWorkspaceRemoval = ports => {
        const remove = actual.createUnifiedWorkspaceRemoval({
            ...ports,
            removeRegisteredRoot(request, identity, registration, veto) {
                if (interception.lateContent)
                    writeFileSync(join(request.destinationPath, "late.txt"), "late content\n");
                return ports.removeRegisteredRoot(request, identity, registration, veto);
            }
        });
        return (request, identity) => {
            interception.calls.push(request);
            return remove(request, identity);
        };
    };
    return {
        ...actual,
        createUnifiedWorkspaceRemoval: wrapped
    };
});
import { createWorkspace, getWorkspacePath, removeWorkspace } from "../../worktree.js";
function git(path: string, ...args: string[]): string {
    const r = spawnSync("git", args, {
        cwd: path,
        encoding: "utf8",
        timeout: 15000,
        windowsHide: true
    });
    expect(r.error).toBeUndefined();
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim();
}
function init(path: string): void {
    mkdirSync(path);
    git(path, "init");
    git(path, "config", "user.name", "Removal fixture");
    git(path, "config", "user.email", "test@example.invalid");
    git(path, "config", "commit.gpgsign", "false");
    writeFileSync(join(path, "tracked.txt"), "original\n");
    git(path, "add", "tracked.txt");
    git(path, "commit", "-m", "initial");
}
function snapshot(path: string) {
    return {
        head: git(path, "rev-parse", "HEAD"),
        refs: git(path, "show-ref"),
        config: readFileSync(join(path, ".git", "config"), "utf8"),
        file: readFileSync(join(path, "tracked.txt"), "utf8")
    };
}
describe("unified facade native removal", () => {
    let root: string, source: string;
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "ccc-unified-removal-"));
        const home = join(root, "home");
        mkdirSync(home);
        vi.stubEnv("HOME", home);
        vi.stubEnv("USERPROFILE", home);
        vi.stubEnv("GIT_CONFIG_GLOBAL", join(home, "gitconfig"));
        vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
        source = join(root, "source");
        init(source);
        init(join(source, "nested"));
        interception.calls.length = 0;
        interception.lateContent = false;
    });
    afterEach(() => {
        interception.lateContent = false;
        rmSync(root, {
            recursive: true,
            force: true
        });
        vi.unstubAllEnvs();
    });
    it("removes actual native root and nested registrations with exact request options and source preservation", () => {
        const branch = "success";
        createWorkspace(source, branch);
        const destination = getWorkspacePath(source, branch);
        const options = {
            force: false
        };
        const before = [source, join(source, "nested")].map(snapshot);
        const siblings = readdirSync(dirname(destination));
        expect(removeWorkspace(source, branch, options)).toEqual({
            removed: ["nested", "source"],
            errors: []
        });
        expect(existsSync(destination)).toBe(false);
        expect(interception.calls).toEqual([{
                repositoryPath: source,
                destinationPath: destination,
                branch,
                options
            }]);
        expect(interception.calls[0].options).toBe(options);
        for (const [index, p] of [source, join(source, "nested")].entries()) {
            expect(snapshot(p)).toEqual(before[index]);
            expect(git(p, "worktree", "list", "--porcelain")).not.toContain(destination);
        }
        expect(readdirSync(dirname(destination)).filter(n => n.startsWith(".ccc-"))).toEqual(siblings.filter(n => n.startsWith(".ccc-")));
    });
    it("runs native quarantine veto and rolls back root directory and registration after late content", () => {
        const branch = "late";
        createWorkspace(source, branch);
        const destination = getWorkspacePath(source, branch);
        const before = [source, join(source, "nested")].map(snapshot);
        const registrations = git(source, "worktree", "list", "--porcelain");
        const siblings = readdirSync(dirname(destination));
        interception.lateContent = true;
        expect(removeWorkspace(source, branch)).toEqual({
            removed: ["nested"],
            errors: ["root worktree changed during removal, use --force to delete it"]
        });
        expect(readFileSync(join(destination, "late.txt"), "utf8")).toBe("late content\n");
        expect(readFileSync(join(destination, "tracked.txt"), "utf8")).toBe("original\n");
        expect(git(source, "worktree", "list", "--porcelain")).toBe(registrations);
        expect(existsSync(join(destination, "nested"))).toBe(false);
        for (const [index, p] of [source, join(source, "nested")].entries())
            expect(snapshot(p)).toEqual(before[index]);
        expect(readdirSync(dirname(destination))).toEqual(siblings);
    });
    it("force still performs actual native removal of dirty root and nested worktrees", () => {
        const branch = "force";
        createWorkspace(source, branch);
        const destination = getWorkspacePath(source, branch);
        const before = [source, join(source, "nested")].map(snapshot);
        writeFileSync(join(destination, "tracked.txt"), "dirty root\n");
        writeFileSync(join(destination, "nested", "tracked.txt"), "dirty nested\n");
        expect(removeWorkspace(source, branch, {
            force: true
        })).toEqual({
            removed: ["nested", "source"],
            errors: []
        });
        expect(existsSync(destination)).toBe(false);
        for (const [index, p] of [source, join(source, "nested")].entries())
            expect(snapshot(p)).toEqual(before[index]);
    });
});
