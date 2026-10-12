import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceContentRepairAdmission } from "../../application/workspace/content-repair-admission.js";
import type { WorkspaceContentRepairAdmissionPorts, WorkspaceContentRepairReport } from "../../ports/workspace/content-repair-admission.js";
import { setAsideConflictingContent, WorktreeContentConflictError } from "../../worktree.js";

const directories: string[] = [];
afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
    const directory = mkdtempSync(join(tmpdir(), "ccc-repair-admission-"));
    directories.push(directory);
    const root = join(directory, "workspace");
    mkdirSync(root);
    const file = join(root, "local.txt");
    const bytes = Buffer.from([0, 255, 42, 10]);
    writeFileSync(file, bytes);
    return { root, file, bytes, conflict: new WorktreeContentConflictError(root, [file]) };
}

function harness(overrides: Partial<WorkspaceContentRepairAdmissionPorts> = {}) {
    const reports: WorkspaceContentRepairReport[] = [];
    const ports = {
        repairConfirmed: vi.fn<WorkspaceContentRepairAdmissionPorts["repairConfirmed"]>(() => null),
        isContentConflict: (cause: unknown): cause is WorktreeContentConflictError => cause instanceof WorktreeContentConflictError,
        report: (event: WorkspaceContentRepairReport) => { reports.push(event); },
        confirmConflictRepair: vi.fn(async () => false),
        setAsideConflicts: vi.fn(setAsideConflictingContent),
        ...overrides,
    };
    return { ports, reports, run: () => createWorkspaceContentRepairAdmission(ports)("source", "workspace", "repo", "branch") };
}

describe("workspace content repair admission", () => {
    it("decline preserves local bytes and prevents set-aside and retry", async () => {
        const { conflict, file, bytes } = fixture();
        const repair = vi.fn(() => { throw conflict; });
        const h = harness({ repairConfirmed: repair });
        await h.run();
        expect(readFileSync(file)).toEqual(bytes);
        expect(repair).toHaveBeenCalledTimes(1);
        expect(h.ports.setAsideConflicts).not.toHaveBeenCalled();
        expect(h.reports).toEqual([
            { kind: "conflicts", name: "repo", branch: "branch", cause: conflict },
            { kind: "refusal", name: "repo" },
        ]);
        expect((h.reports[0] as { cause: unknown }).cause).toBe(conflict);
    });

    it.each([false, true])("approval preserves bytes through retry, retry failure=%s", async (failRetry) => {
        const { conflict, root, file, bytes } = fixture();
        const retryCause = new Error("checkout failed after partial effect");
        const branchBytes = Buffer.from("branch version");
        const repair = vi.fn<WorkspaceContentRepairAdmissionPorts["repairConfirmed"]>()
            .mockImplementationOnce(() => { throw conflict; })
            .mockImplementationOnce(() => {
                expect(existsSync(file)).toBe(false);
                writeFileSync(file, branchBytes);
                if (failRetry) throw retryCause;
                return { name: "repo", branch: "branch", action: "worktree-existing" };
            });
        const h = harness({ repairConfirmed: repair, confirmConflictRepair: async () => true });
        await h.run();
        const saved = h.reports.find(event => event.kind === "set-aside");
        if (!saved || saved.kind !== "set-aside") throw new Error("Missing saved location");
        expect(readFileSync(join(saved.preserved, "local.txt"))).toEqual(bytes);
        expect(readFileSync(file)).toEqual(branchBytes);
        expect(h.ports.setAsideConflicts).toHaveBeenCalledWith(root, conflict.conflicts);
        expect(repair.mock.calls).toEqual([
            ["source", "workspace", "repo", "branch", true],
            ["source", "workspace", "repo", "branch", true],
        ]);
        expect(h.reports.at(-1)).toEqual(failRetry
            ? { kind: "retry-failure", name: "repo", cause: retryCause, preserved: saved.preserved }
            : { kind: "outcome", name: "repo", fixed: true, afterSetAside: true });
        if (failRetry) expect((h.reports.at(-1) as { cause: unknown }).cause).toBe(retryCause);
    });

    it.each(["prompt", "set-aside"])("%s rejection propagates without retry", async (stage) => {
        const { conflict, file, bytes } = fixture();
        const cause = new Error(`${stage} failed`);
        const repair = vi.fn(() => { throw conflict; });
        const setAside = vi.fn(() => { throw cause; });
        const h = harness({
            repairConfirmed: repair,
            confirmConflictRepair: async () => { if (stage === "prompt") throw cause; return true; },
            setAsideConflicts: setAside,
        });
        await expect(h.run()).rejects.toBe(cause);
        expect(repair).toHaveBeenCalledTimes(1);
        expect(setAside).toHaveBeenCalledTimes(stage === "prompt" ? 0 : 1);
        expect(readFileSync(file)).toEqual(bytes);
        expect(h.reports).toEqual([{ kind: "conflicts", name: "repo", branch: "branch", cause: conflict }]);
    });

    it("initial false outcome resolves without conflict admission", async () => {
        const h = harness();
        await h.run();
        expect(h.reports).toEqual([{ kind: "outcome", name: "repo", fixed: false, afterSetAside: false }]);
        expect(h.ports.confirmConflictRepair).not.toHaveBeenCalled();
        expect(h.ports.setAsideConflicts).not.toHaveBeenCalled();
    });

    it("ordinary initial failure resolves with the original cause", async () => {
        const cause = new Error("not a content conflict");
        const h = harness({ repairConfirmed: () => { throw cause; } });
        await expect(h.run()).resolves.toBeUndefined();
        expect(h.reports).toEqual([{ kind: "failure", name: "repo", cause }]);
        expect((h.reports[0] as { cause: unknown }).cause).toBe(cause);
        expect(h.ports.confirmConflictRepair).not.toHaveBeenCalled();
        expect(h.ports.setAsideConflicts).not.toHaveBeenCalled();
    });
});
