import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { UnifiedRemovalRequest } from "../../ports/workspace/unified-removal.js";
const interception = vi.hoisted(() => ({
    calls: [] as UnifiedRemovalRequest[],
    lateContent: false,
    replacement: undefined as "destination" | "source" | "registration" | undefined,
    savedPath: "",
    successorPath: "",
    successorSnapshot: undefined as { head: string; refs: string; config: string; file: string } | undefined,
    successorFiles: undefined as Record<string, string> | undefined,
}));
vi.mock("../../application/workspace/unified-removal.js", async () => {
    const actual = await vi.importActual<typeof import("../../application/workspace/unified-removal.js")>("../../application/workspace/unified-removal.js");
    const wrapped: typeof actual.createUnifiedWorkspaceRemoval = ports => {
        const remove = actual.createUnifiedWorkspaceRemoval({
            ...ports,
            removeRegisteredNested(request, source, destination, identity, registration, force, sourceIdentity, guard) {
                const replacement = interception.replacement;
                if (replacement) {
                    // This seam runs after both directory and registration capture. The
                    // original native binding receives every original receipt and guard.
                    const path = replacement === "destination" ? destination
                        : replacement === "source" ? source
                        : git(destination, "rev-parse", "--absolute-git-dir");
                    interception.successorPath = path;
                    renameSync(path, interception.savedPath);
                    if (replacement === "registration") {
                        cpSync(interception.savedPath, path, { recursive: true });
                        writeFileSync(join(path, "successor-marker"), "successor registration\n");
                        interception.successorFiles = files(path);
                    } else {
                        init(path);
                        writeFileSync(join(path, "successor-marker"), "successor repository\n");
                        interception.successorSnapshot = snapshot(path);
                    }
                }
                return ports.removeRegisteredNested(request, source, destination, identity, registration, force, sourceIdentity, guard);
            },
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
function files(path: string): Record<string, string> {
    const result: Record<string, string> = {};
    const visit = (directory: string, prefix: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const name = `${prefix}${entry.name}`;
            if (entry.isDirectory()) visit(join(directory, entry.name), `${name}/`);
            else result[name] = readFileSync(join(directory, entry.name)).toString("hex");
        }
    };
    visit(path, "");
    return result;
}
function quarantinePaths(path: string): string[] {
    const result: string[] = [];
    const visit = (directory: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const child = join(directory, entry.name);
            if (entry.name.startsWith(".ccc-worktree-quarantine-") || entry.name.startsWith(".ccc-delete-")) result.push(child);
            visit(child);
        }
    };
    visit(path);
    return result.sort();
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
        interception.replacement = undefined;
        interception.savedPath = join(root, "saved-object");
        interception.successorPath = "";
        interception.successorSnapshot = undefined;
        interception.successorFiles = undefined;
    });
    afterEach(() => {
        interception.lateContent = false;
        interception.replacement = undefined;
        rmSync(root, {
            recursive: true,
            force: true
        });
        vi.unstubAllEnvs();
    });
    it.each(["destination", "source", "registration"] as const)("preserves an actual %s successor appearing after ownership capture", replacement => {
        const branch = `replace-${replacement}`;
        createWorkspace(source, branch);
        const destination = getWorkspacePath(source, branch);
        const nestedSource = join(source, "nested");
        const nestedDestination = join(destination, "nested");
        const sourceBefore = snapshot(source);
        const nestedBefore = snapshot(nestedSource);
        const registrationPath = git(nestedDestination, "rev-parse", "--absolute-git-dir");
        const registrationBefore = files(registrationPath);
        const registryBefore = git(nestedSource, "worktree", "list", "--porcelain");
        const rootRegistryBefore = git(source, "worktree", "list", "--porcelain");
        const quarantinesBefore = quarantinePaths(root);
        interception.replacement = replacement;

        const result = removeWorkspace(source, branch, { force: true });

        expect(result.removed).toEqual([]);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toMatch(/changed|replaced|ownership|identity/i);
        expect(interception.calls).toHaveLength(1);
        expect(existsSync(destination)).toBe(true);
        expect(snapshot(source)).toEqual(sourceBefore);
        expect(git(source, "worktree", "list", "--porcelain")).toBe(rootRegistryBefore);
        if (replacement === "registration") {
            expect(files(registrationPath)).toEqual(interception.successorFiles);
            expect(files(interception.savedPath)).toEqual(registrationBefore);
            expect(snapshot(nestedSource)).toEqual(nestedBefore);
            expect(git(nestedSource, "worktree", "list", "--porcelain")).toBe(registryBefore);
            expect(readFileSync(join(nestedDestination, "tracked.txt"), "utf8")).toBe("original\n");
        } else {
            expect(snapshot(interception.successorPath)).toEqual(interception.successorSnapshot);
            expect(readFileSync(join(interception.successorPath, "successor-marker"), "utf8")).toBe("successor repository\n");
            if (replacement === "source") {
                expect(snapshot(interception.savedPath)).toEqual(nestedBefore);
                const savedRegistration = join(interception.savedPath, ".git", "worktrees", basename(registrationPath));
                expect(files(savedRegistration)).toEqual(registrationBefore);
                expect(readFileSync(join(nestedDestination, "tracked.txt"), "utf8")).toBe("original\n");
            } else {
                expect(snapshot(nestedSource)).toEqual(nestedBefore);
                expect(files(registrationPath)).toEqual(registrationBefore);
                expect(git(nestedSource, "worktree", "list", "--porcelain")).toBe(registryBefore);
                expect(readFileSync(join(interception.savedPath, "tracked.txt"), "utf8")).toBe("original\n");
            }
        }
        expect(quarantinePaths(root)).toEqual(quarantinesBefore);
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
