import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NestedWorkspaceRepairPorts } from "../../ports/workspace/repair-nested.js";
import type { WorkspaceRepairAuthority } from "../../domain/workspace/repair-authority.js";

const injection = vi.hoisted(() => ({
    processError: false,
    semanticFailure: false,
    addedReceipt: undefined as unknown,
    compensatedReceipt: undefined as unknown,
}));
vi.mock("child_process", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("child_process");
    return { ...actual, spawnSync: ((...args: unknown[]) => {
        const result = Reflect.apply(actual.spawnSync, undefined, args) as ReturnType<typeof actual.spawnSync>;
        const argv = args[1] as string[] | undefined;
        return injection.processError && argv?.[0] === "checkout" && argv[1] === "--force"
            ? { ...result, error: new Error("nested process error"), stderr: "  fatal: nested native detail  \n" }
            : result;
    }) as typeof actual.spawnSync };
});
vi.mock("../../application/workspace/repair-nested.js", async () => {
    const actual = await vi.importActual<typeof import("../../application/workspace/repair-nested.js")>("../../application/workspace/repair-nested.js");
    const wrapped: typeof actual.createNestedWorkspaceRepair = ports => actual.createNestedWorkspaceRepair({
        ...ports,
        runPreparedWorktreeAdd(...args) {
            const observation = ports.runPreparedWorktreeAdd(...args);
            injection.addedReceipt = observation.registrationFence;
            return injection.semanticFailure
                ? { ...observation, result: Object.freeze({ succeeded: false, failureReason: "classified nested refusal" }) }
                : observation;
        },
        rollbackFailedWorktreeAdd(...args) {
            injection.compensatedReceipt = args[6];
            return ports.rollbackFailedWorktreeAdd(...args);
        },
    });
    return { ...actual, createNestedWorkspaceRepair: wrapped };
});
import { createNestedWorkspaceRepair } from "../../application/workspace/repair-nested.js";
import { createWorkspace, isValidWorktree, repairWorkspace } from "../../worktree.js";

function git(repository: string, ...args: string[]): string {
    const result = spawnSync("git", args, { cwd: repository, encoding: "utf8", timeout: 15_000, windowsHide: true });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
}
function init(repository: string): void {
    mkdirSync(repository, { recursive: true });
    git(repository, "init");
    git(repository, "config", "user.name", "Nested repair fixture");
    git(repository, "config", "user.email", "test@example.invalid");
    git(repository, "config", "commit.gpgsign", "false");
    writeFileSync(join(repository, "owned.txt"), "original nested content\n");
    git(repository, "add", "owned.txt");
    git(repository, "commit", "-m", "initial");
}

describe("nested repair semantic decisions with native compensation", () => {
    let root: string;
    beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ccc-nested-repair-")); });
    afterEach(() => {
        injection.processError = false;
        injection.semanticFailure = false;
        injection.addedReceipt = undefined;
        injection.compensatedReceipt = undefined;
        rmSync(root, { recursive: true, force: true });
    });

    function missingNested() {
        const source = join(root, "source");
        const origin = join(root, "nested-origin");
        init(source); init(origin);
        git(source, "-c", "protocol.file.allow=always", "submodule", "add", origin, "nested");
        git(source, "commit", "-am", "nested");
        const branch = "nested-topic";
        const workspace = createWorkspace(source, branch).workspacePath;
        const nestedSource = join(source, "nested");
        const destination = join(workspace, "nested");
        git(nestedSource, "worktree", "remove", "--force", destination);
        git(nestedSource, "branch", "-D", branch);
        writeFileSync(join(workspace, "operator.txt"), "preserve root content\n");
        return { source, workspace, nestedSource, destination, branch };
    }

    it("returns a mutable empty result for a source without Git metadata", () => {
        const admission: Pick<NestedWorkspaceRepairPorts<WorkspaceRepairAuthority>, "resolve" | "hasGitMetadata"> = { resolve: path => path, hasGitMetadata: () => false };
        const ports = admission as NestedWorkspaceRepairPorts<WorkspaceRepairAuthority>;
        const result = createNestedWorkspaceRepair(ports).repairWorkspace("source", "workspace", "branch");
        expect(result).toEqual([]);
        result.push({ name: "mutable", branch: "branch", action: "worktree-existing" });
        expect(result).toHaveLength(1);
    });

    it("creates a missing nested worktree without changing the source or existing root content", () => {
        const f = missingNested();
        expect(repairWorkspace(f.source, f.workspace, f.branch)).toEqual([{ name: "nested", branch: f.branch, action: "worktree-new" }]);
        expect(isValidWorktree(f.destination, f.nestedSource)).toBe(true);
        expect(readFileSync(join(f.workspace, "operator.txt"), "utf8")).toBe("preserve root content\n");
        expect(git(f.nestedSource, "status", "--porcelain")).toBe("");
    });

    it.each(["semantic", "native process error"] as const)("compensates the exact side-effecting addition receipt after %s failure", kind => {
        const f = missingNested();
        injection.addedReceipt = undefined;
        injection.semanticFailure = kind === "semantic";
        injection.processError = kind === "native process error";
        const detail = kind === "semantic" ? "classified nested refusal" : "fatal: nested native detail";
        expect(() => repairWorkspace(f.source, f.workspace, f.branch)).toThrow(`Failed to create nested worktree for nested: ${detail}`);
        injection.processError = false;
        expect(injection.addedReceipt).toBeDefined();
        expect(injection.addedReceipt).not.toBeNull();
        expect(injection.compensatedReceipt).toBe(injection.addedReceipt);
        expect(existsSync(f.destination)).toBe(false);
        expect(git(f.nestedSource, "worktree", "list", "--porcelain")).not.toContain(f.destination);
        expect(spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${f.branch}`], { cwd: f.nestedSource, stdio: "pipe" }).status).toBe(1);
        expect(readFileSync(join(f.workspace, "operator.txt"), "utf8")).toBe("preserve root content\n");
        expect(readFileSync(join(f.nestedSource, "owned.txt"), "utf8")).toBe("original nested content\n");
    });
});
