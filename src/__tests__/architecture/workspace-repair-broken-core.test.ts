import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrokenWorkspaceRepairPorts } from "../../ports/workspace/repair-broken.js";
import type { WorkspaceRepairAuthority } from "../../domain/workspace/repair-authority.js";

const injection = vi.hoisted(() => ({
    processStatus: undefined as undefined | number,
    semanticFailure: false,
    rollbackFailure: false,
    addedReceipt: undefined as unknown,
    compensatedReceipt: undefined as unknown,
    diagnostic: undefined as undefined | string,
}));
vi.mock("child_process", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("child_process");
    return { ...actual, spawnSync: ((...args: unknown[]) => {
        const result = Reflect.apply(actual.spawnSync, undefined, args) as ReturnType<typeof actual.spawnSync>;
        const argv = args[1] as string[] | undefined;
        return injection.processStatus !== undefined && argv?.[0] === "checkout" && argv[1] === "--force"
            ? { ...result, status: injection.processStatus, error: new Error("broken native process error"), stderr: "  fatal: broken native detail  \n" }
            : result;
    }) as typeof actual.spawnSync };
});
vi.mock("../../application/workspace/repair-broken.js", async () => {
    const actual = await vi.importActual<typeof import("../../application/workspace/repair-broken.js")>("../../application/workspace/repair-broken.js");
    const wrapped: typeof actual.createBrokenWorkspaceRepair = ports => actual.createBrokenWorkspaceRepair({
        ...ports,
        runPreparedWorktreeAdd(...args) {
            const observation = ports.runPreparedWorktreeAdd(...args);
            injection.addedReceipt = observation.registrationFence;
            return injection.semanticFailure
                ? { ...observation, result: Object.freeze({ succeeded: false, failureReason: "  classified broken refusal  \n" }) }
                : observation;
        },
        rollbackFailedWorktreeAdd(...args) {
            injection.compensatedReceipt = args[6];
            if (injection.rollbackFailure) throw new Error("owned repair compensation refused");
            return ports.rollbackFailedWorktreeAdd(...args);
        },
        warnWorktreeRepairFailure(path, detail) {
            injection.diagnostic = detail;
            return ports.warnWorktreeRepairFailure(path, detail);
        },
    });
    return { ...actual, createBrokenWorkspaceRepair: wrapped };
});
import { createBrokenWorkspaceRepair } from "../../application/workspace/repair-broken.js";
import { createWorkspace, fixBrokenWorktree, isValidWorktree } from "../../worktree.js";

function git(repository: string, ...args: string[]): string {
    const result = spawnSync("git", args, { cwd: repository, encoding: "utf8", timeout: 15_000, windowsHide: true });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
}
function init(repository: string): void {
    mkdirSync(repository, { recursive: true });
    git(repository, "init");
    git(repository, "config", "user.name", "Broken repair fixture");
    git(repository, "config", "user.email", "test@example.invalid");
    git(repository, "config", "commit.gpgsign", "false");
    writeFileSync(join(repository, "owned.txt"), "original source content\n");
    git(repository, "add", "owned.txt");
    git(repository, "commit", "-m", "initial");
}

describe("broken repair semantic admission and native compensation", () => {
    let root: string;
    beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ccc-broken-repair-")); });
    afterEach(() => {
        injection.processStatus = undefined;
        injection.semanticFailure = false;
        injection.rollbackFailure = false;
        injection.addedReceipt = undefined;
        injection.compensatedReceipt = undefined;
        injection.diagnostic = undefined;
        rmSync(root, { recursive: true, force: true });
    });

    function brokenCheckout() {
        const source = join(root, "source");
        const nestedSource = join(source, "nested");
        init(source); init(nestedSource);
        const branch = "broken-topic";
        const workspace = createWorkspace(source, branch).workspacePath;
        const destination = join(workspace, "nested");
        git(nestedSource, "worktree", "remove", "--force", destination);
        git(nestedSource, "branch", "-D", branch);
        mkdirSync(destination);
        writeFileSync(join(destination, "operator.txt"), "preserve broken content\n");
        const originalInode = lstatSync(destination).ino;
        const registrations = git(nestedSource, "worktree", "list", "--porcelain");
        return { source, nestedSource, workspace, destination, branch, originalInode, registrations };
    }

    it("requires explicit confirmation before considering repair", () => {
        const ports = {} as BrokenWorkspaceRepairPorts<WorkspaceRepairAuthority>;
        expect(() => createBrokenWorkspaceRepair(ports).fixBrokenWorktreeSanitized("source", "workspace", "repo", "branch", false, {}))
            .toThrow("Explicit confirmation is required to replace broken worktree content.");
    });

    it("preserves status-only acceptance when a completed native add also carries a process error", () => {
        const f = brokenCheckout();
        injection.processStatus = 0;
        expect(fixBrokenWorktree(f.source, f.workspace, "nested", f.branch, true))
            .toEqual({ name: "nested", branch: f.branch, action: "worktree-new" });
        injection.processStatus = undefined;
        expect(isValidWorktree(f.destination, f.nestedSource)).toBe(true);
        expect(readFileSync(join(f.destination, "operator.txt"), "utf8")).toBe("preserve broken content\n");
        expect(readFileSync(join(f.destination, "owned.txt"), "utf8")).toBe("original source content\n");
        expect(git(f.nestedSource, "status", "--porcelain")).toBe("");
        expect(injection.compensatedReceipt).toBeUndefined();
    });

    it.each(["semantic", "native"] as const)("restores the exact broken checkout after a side-effecting %s refusal", kind => {
        const f = brokenCheckout();
        injection.semanticFailure = kind === "semantic";
        injection.processStatus = kind === "native" ? 1 : undefined;
        expect(fixBrokenWorktree(f.source, f.workspace, "nested", f.branch, true)).toBeNull();
        injection.processStatus = undefined;
        expect(injection.addedReceipt).toBeDefined();
        expect(injection.addedReceipt).not.toBeNull();
        expect(injection.compensatedReceipt).toBe(injection.addedReceipt);
        expect(injection.diagnostic).toBe(kind === "semantic" ? "  classified broken refusal  \n" : "  fatal: broken native detail  \n");
        expect(lstatSync(f.destination).ino).toBe(f.originalInode);
        expect(readFileSync(join(f.destination, "operator.txt"), "utf8")).toBe("preserve broken content\n");
        expect(existsSync(join(f.destination, ".git"))).toBe(false);
        expect(git(f.nestedSource, "worktree", "list", "--porcelain")).toBe(f.registrations);
        expect(spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${f.branch}`], { cwd: f.nestedSource, stdio: "pipe" }).status).toBe(1);
        expect(readFileSync(join(f.nestedSource, "owned.txt"), "utf8")).toBe("original source content\n");
    });

    it("reports failed compensation and preserves original content in its quarantine", () => {
        const f = brokenCheckout();
        injection.semanticFailure = true;
        injection.rollbackFailure = true;
        let failure: Error | undefined;
        try { fixBrokenWorktree(f.source, f.workspace, "nested", f.branch, true); }
        catch (error) { failure = error as Error; }
        expect(failure).toBeInstanceOf(Error);
        expect(failure!.message).toContain("Failed worktree repair rollback: owned repair compensation refused");
        const preserved = /original content remains in '([^']+)'/.exec(failure!.message)?.[1];
        expect(preserved).toBeDefined();
        expect(readFileSync(join(preserved!, "nested", "operator.txt"), "utf8")).toBe("preserve broken content\n");
        expect(isValidWorktree(f.destination, f.nestedSource)).toBe(true);
        expect(injection.diagnostic).toBeUndefined();
    });
});
