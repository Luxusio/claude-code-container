import { describe, expect, it, vi } from "vitest";
import * as core from "../../application/workspace/cli-removal.js";
import type { WorkspaceCliContainerRuntime, WorkspaceCliRemovalPorts } from "../../ports/workspace/cli-removal.js";

describe("workspace CLI removal inward policy", () => {
    it("filters normalized names by exact base/profile prefix and retains duplicates", () => {
        const listNames = vi.fn(() => ({ kind: "listed" as const, names: ["base", "base--p--work", "base", "base-near", "other"] }));
        expect(core.listWorkspaceContainerNames("workspace", { listNames }, () => "base"))
            .toEqual(["base", "base--p--work", "base"]);
        expect(listNames).toHaveBeenCalledOnce();
    });
    it("refuses an unavailable inventory instead of treating it as empty", () => {
        expect(() => core.listWorkspaceContainerNames("workspace", { listNames: () => ({ kind: "unavailable" }) }, () => "base"))
            .toThrow("Unable to list workspace containers.");
    });
    it("retains the captured identity in a prepared removal plan", () => {
        const identity = { containerId: "captured-id", running: true };
        const plan = core.prepareWorkspaceContainerRemovalPlan("workspace", () => ["name"], () => identity, () => true);
        expect(plan).toEqual([{ containerName: "name", identity }]);
        expect(plan[0].identity).toBe(identity);
    });
    it("rejects duplicate captured IDs before any removal", () => {
        expect(() => core.prepareWorkspaceContainerRemovalPlan(
            "workspace", () => ["base", "base--p--work"], () => ({ containerId: "same-id", running: true }), () => true,
        )).toThrow("duplicate identity");
    });
    it.each([false, true])("has no cleanup authority after an unknown identity, present=%s", present => {
        const runtime = { stop: vi.fn(), remove: vi.fn() };
        const operation = () => core.removeWorkspaceContainerByIdentity("name", () => null, runtime, () => present);
        if (present) expect(operation).toThrow("identity inspection failed");
        else expect(operation()).toBe(false);
        expect(runtime.stop).not.toHaveBeenCalled();
        expect(runtime.remove).not.toHaveBeenCalled();
    });
    it.each([false, true])("removes only the captured ID, running=%s", running => {
        const calls: string[] = [];
        const runtime = {
            stop: (id: string): undefined => { calls.push(`stop:${id}`); },
            remove: (id: string): undefined => { calls.push(`remove:${id}`); },
        };
        expect(core.removeWorkspaceContainerByIdentity("name", () => ({ containerId: "captured-id", running }), runtime, () => true)).toBe(true);
        expect(calls).toEqual(running ? ["stop:captured-id", "remove:captured-id"] : ["remove:captured-id"]);
    });
    it("does not remove after stopping fails", () => {
        const failure = new Error("stop failed");
        const runtime = { stop: vi.fn((): undefined => { throw failure; }), remove: vi.fn() };
        expect(() => core.removeWorkspaceContainerByIdentity("name", () => ({ containerId: "captured-id", running: true }), runtime, () => true))
            .toThrow(failure);
        expect(runtime.stop).toHaveBeenCalledExactlyOnceWith("captured-id");
        expect(runtime.remove).not.toHaveBeenCalled();
    });
    it("stops the prepared batch after a removal fails", () => {
        const failure = new Error("remove failed");
        const runtime = { stop: vi.fn(), remove: vi.fn((): undefined => { throw failure; }) };
        const plan = ["first", "later"].map(name => ({ containerName: name, identity: { containerId: `${name}-id`, running: false } }));
        expect(() => core.removePreparedWorkspaceContainers(plan, runtime, () => true)).toThrow(failure);
        expect(runtime.stop).not.toHaveBeenCalled();
        expect(runtime.remove).toHaveBeenCalledExactlyOnceWith("first-id");
    });
    it("keeps the captured identity reference when stop updates it", () => {
        const identity = { containerId: "before-stop", running: true };
        const calls: string[] = [];
        const removed = core.removePreparedWorkspaceContainers([{ containerName: "name", identity }], {
            stop: (id): undefined => { calls.push(`stop:${id}`); identity.containerId = "after-stop"; },
            remove: (id): undefined => { calls.push(`remove:${id}`); },
        }, () => true);
        expect(removed).toEqual(["name"]);
        expect(calls).toEqual(["stop:before-stop", "remove:after-stop"]);
    });
    it("uses the workspace-scoped identity before cleanup", () => {
        const identityProbe = vi.fn(() => ({ containerId: "managed-id", running: false }));
        const runtime = { stop: vi.fn(), remove: vi.fn() };
        expect(core.removeManagedWorkspaceContainerByIdentity("name", "workspace", identityProbe, runtime, () => true)).toBe(true);
        expect(identityProbe).toHaveBeenCalledExactlyOnceWith("name", "workspace");
        expect(runtime.remove).toHaveBeenCalledExactlyOnceWith("managed-id");
    });
    it("retains discovery order and excludes entries that were not removed", () => {
        const remove = vi.fn((name: string, _workspace: string) => name !== "missing");
        expect(core.removeWorkspaceContainers("workspace", () => ["first", "missing", "last"], remove)).toEqual(["first", "last"]);
        expect(remove.mock.calls).toEqual([["first", "workspace"], ["missing", "workspace"], ["last", "workspace"]]);
    });
    it("cleans containers only after successful workspace removal", () => {
        const calls: string[] = [];
        const result = { errors: [], extra: { retained: true } };
        const removed = ["name"];
        const completed = core.removeWorkspaceThenContainers(
            () => { calls.push("workspace"); return result; },
            () => { calls.push("containers"); return removed; },
        );
        expect(calls).toEqual(["workspace", "containers"]);
        expect(completed.result).toBe(result);
        expect(completed.removedContainers).toBe(removed);
    });
    it("keeps containers after a partial workspace removal", () => {
        const cleanup = vi.fn(() => ["name"]);
        const result = { removed: ["nested"], errors: ["dirty workspace"] };
        expect(core.removeWorkspaceThenContainers(() => result, cleanup)).toEqual({ result, removedContainers: [] });
        expect(cleanup).not.toHaveBeenCalled();
    });
    it("retains the ownership admission option and empty stranded result", () => {
        const assertion = vi.fn((): undefined => undefined);
        core.assertRemovableWorkspace("workspace", "branch", "source", assertion);
        expect(assertion).toHaveBeenCalledExactlyOnceWith("workspace", "branch", "source", { allowTrackedGitlinks: true });
        const formatting = vi.fn(() => (text: string) => text);
        expect(core.strandedBranchNotice("branch", [], formatting, formatting)).toBe("");
        expect(formatting).not.toHaveBeenCalled();
    });
    it("observes claims under the family guard but skips all container cleanup when forced workspace removal fails", () => {
        const trace: string[] = [];
        let locked = false;
        const effect = (name: string): undefined => { expect(locked).toBe(true); trace.push(name); };
        const exit = new Error("exit:1");
        const runtime: WorkspaceCliContainerRuntime = {
            listNames: () => { effect("list"); return { kind: "listed", names: ["base"] }; },
            stop: vi.fn(), remove: vi.fn(),
        };
        const selectRuntime = vi.fn(() => { effect("runtime"); return runtime; });
        const ports: WorkspaceCliRemovalPorts = {
            selectWorkspacePath: () => () => "workspace",
            selectProjectId: () => () => "project",
            selectFamilyLock: () => (projectId, operation) => {
                expect(projectId).toBe("project"); trace.push("lock"); locked = true;
                try { return operation(); } finally { locked = false; trace.push("unlock"); }
            },
            selectClaims: () => projectId => { expect(projectId).toBe("project"); effect("claims"); return ["active-session"]; },
            selectOwnershipAssertion: () => () => effect("ownership"),
            selectRuntimeReadiness: () => () => effect("ready"),
            selectContainerName: () => () => "base",
            selectManagedIdentity: () => (name, workspace) => {
                expect([name, workspace]).toEqual(["base", "workspace"]); effect("identity");
                return { containerId: "captured-id", running: true };
            },
            selectExists: () => vi.fn(() => true),
            selectContainerRuntime: selectRuntime,
            selectRemoveWorkspace: () => (cwd, branch, options) => {
                expect([cwd, branch, options]).toEqual(["source", "branch", { force: true }]); effect("workspace");
                return { removed: ["nested"], errors: ["dirty workspace"] };
            },
            selectLog: () => () => undefined,
            selectError: () => () => undefined,
            selectExit: () => status => { expect(status).toBe(1); throw exit; },
            selectStrandedRegistrations: () => () => [],
            selectTerminalSafeLiteral: () => text => text,
            selectPasteableArgument: () => text => text,
        };
        expect(() => core.createWorkspaceCliRemoval(ports)("source", "branch", true)).toThrow(exit);
        expect(trace).toEqual(["lock", "claims", "ownership", "ready", "runtime", "list", "identity", "workspace", "unlock"]);
        expect(selectRuntime).toHaveBeenCalledOnce();
        expect(runtime.stop).not.toHaveBeenCalled();
        expect(runtime.remove).not.toHaveBeenCalled();
        expect(locked).toBe(false);
    });
});
