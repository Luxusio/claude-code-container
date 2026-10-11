import { describe, expect, it } from "vitest";
import { createWorkspaceCreationDispatch, createWorkspaceRemovalDispatch } from "../../application/workspace/dispatch.js";
import type { WorkspaceCreationDispatchPorts, WorkspaceRemovalDispatchPorts } from "../../ports/workspace/dispatch.js";

function fixture(unified = true) {
    const trace: unknown[] = [];
    const identity = { native: "workspace" };
    const result = { nativeReceipt: Symbol("selected removal") };
    const content = { first: { entries: ["retained"] }, second: { entries: [] } };
    const created = { workspacePath: "workspace", created: [], copied: [] };
    const shared = {
        validateBranch(branch: string) { trace.push(["branch", branch]); },
        resolveSource(source: string) { trace.push(["resolve", source]); return "source"; },
        workspacePath(source: string, branch: string) { trace.push(["path", source, branch]); return "workspace"; },
        sourceHasGitMetadata(source: string) { trace.push(["metadata", source]); return unified; },
    };
    const create: WorkspaceCreationDispatchPorts = { ...shared,
        enclosingRepository(path) { trace.push(["enclosing", path]); return "enclosing"; },
        warnEnclosing(path, enclosing) { trace.push(["warn", path, enclosing]); },
        createUnified(request) { trace.push(["create-unified", request]); return created; },
        createMulti(request) { trace.push(["create-multi", request]); return created; },
    };
    const remove: WorkspaceRemovalDispatchPorts<typeof identity, typeof content.first, typeof result> = { ...shared,
        destinationExists(path) { trace.push(["exists", path]); return true; },
        assertRequestedBranch(...args) { trace.push(["assert", ...args]); },
        observeUnreachableRepositories(path, unreachable) { trace.push(["scan", path]); void unreachable; },
        observePathContent(path) { trace.push(["content", path]); return content[path as keyof typeof content]; },
        captureWorkspaceIdentity(path) { trace.push(["identity", path]); return identity; },
        removeUnified(request, receipt) { trace.push(["remove-unified", request, receipt]); return result; },
        removeMulti(request, receipt) { trace.push(["remove-multi", request, receipt]); return result; },
    };
    return { trace, identity, content, created, result, create, remove };
}

describe("complete workspace admission and dispatch", () => {
    it.each([true, false])("preserves ordered creation and selected result identity (unified=%s)", unified => {
        const f = fixture(unified);
        expect(createWorkspaceCreationDispatch(f.create).createWorkspace("raw", "feature")).toBe(f.created);
        expect(f.trace.map(entry => (entry as unknown[])[0])).toEqual(["branch", "resolve", "path", "enclosing", "warn", "metadata", unified ? "create-unified" : "create-multi"]);
        expect(f.trace.at(-1)).toEqual([unified ? "create-unified" : "create-multi", { repositoryPath: "source", destinationPath: "workspace", branch: "feature" }]);
    });
    it("creates without a warning when no enclosing repository exists", () => {
        const f = fixture();
        f.create.enclosingRepository = path => { f.trace.push(["enclosing", path]); return null; };
        expect(createWorkspaceCreationDispatch(f.create).createWorkspace("raw", "feature")).toBe(f.created);
        expect(f.trace.map(entry => (entry as unknown[])[0])).toEqual(["branch", "resolve", "path", "enclosing", "metadata", "create-unified"]);
    });
    it.each(["create", "remove"] as const)("rejects an invalid branch before resolving or effects (%s)", operation => {
        const f = fixture();
        const error = new Error("invalid branch");
        const validate = (branch: string) => { f.trace.push(["branch", branch]); throw error; };
        f.create.validateBranch = validate;
        f.remove.validateBranch = validate;
        const call = operation === "create"
            ? () => createWorkspaceCreationDispatch(f.create).createWorkspace("raw", "invalid")
            : () => createWorkspaceRemovalDispatch(f.remove).removeWorkspace("raw", "invalid");
        expect(call).toThrow(error);
        expect(f.trace).toEqual([["branch", "invalid"]]);
    });
    it("returns a missing destination before branch checks or removal effects", () => {
        const f = fixture();
        f.remove.destinationExists = path => { f.trace.push(["exists", path]); return false; };
        expect(createWorkspaceRemovalDispatch(f.remove).removeWorkspace("raw", "feature")).toEqual({ kind: "missing", destinationPath: "workspace" });
        expect(f.trace).toEqual([["branch", "feature"], ["resolve", "raw"], ["path", "source", "feature"], ["exists", "workspace"]]);
    });
    it("rejects the wrong requested branch before inventory or removal effects", () => {
        const f = fixture();
        const error = new Error("wrong requested branch");
        f.remove.assertRequestedBranch = (...args) => { f.trace.push(["assert", ...args]); throw error; };
        expect(() => createWorkspaceRemovalDispatch(f.remove).removeWorkspace("raw", "feature")).toThrow(error);
        expect(f.trace).toEqual([["branch", "feature"], ["resolve", "raw"], ["path", "source", "feature"], ["exists", "workspace"], ["assert", "workspace", "feature", "source"]]);
    });
    it.each([true, false])("forwards original removal options and opaque identity (unified=%s)", unified => {
        const f = fixture(unified);
        const options = { force: true };
        const outcome = createWorkspaceRemovalDispatch(f.remove).removeWorkspace("raw", "feature", options);
        expect(outcome.kind).toBe("dispatched");
        if (outcome.kind !== "dispatched") throw new Error("Expected selected removal");
        expect(outcome.result).toBe(f.result);
        const last = f.trace.at(-1) as [string, { options: object }, object];
        expect(last[1].options).toBe(options);
        expect(last[1]).toEqual({ repositoryPath: "source", destinationPath: "workspace", branch: "feature", options });
        expect(last[2]).toBe(f.identity);
        expect(f.trace.map(entry => (entry as unknown[])[0])).toEqual(["branch", "resolve", "path", "exists", "assert", "identity", "metadata", unified ? "remove-unified" : "remove-multi"]);
    });
    it.each([undefined, false, "truthy", 1, null])("strict force %s does not bypass unreachable inventory", force => {
        const f = fixture();
        f.remove.observeUnreachableRepositories = (_path, unreachable) => { f.trace.push(["scan"]); unreachable.push("first", "second"); };
        const result = createWorkspaceRemovalDispatch(f.remove).removeWorkspace("raw", "feature", { force } as { force?: boolean });
        expect(result).toEqual({ kind: "unmanaged", paths: [{ path: "first", content: f.content.first }, { path: "second", content: f.content.second }] });
        if (result.kind !== "unmanaged") throw new Error("Expected inventory refusal");
        expect(result.paths[0].content).toBe(f.content.first);
        expect(result.paths[1].content).toBe(f.content.second);
        expect(f.trace).toEqual([["branch", "feature"], ["resolve", "raw"], ["path", "source", "feature"], ["exists", "workspace"], ["assert", "workspace", "feature", "source"], ["scan"], ["content", "first"], ["content", "second"]]);
    });
    it.each([true, false])("scans reachable removal before identity and selected dispatch (unified=%s)", unified => {
        const f = fixture(unified);
        const outcome = createWorkspaceRemovalDispatch(f.remove).removeWorkspace("raw", "feature");
        expect(outcome.kind).toBe("dispatched");
        if (outcome.kind !== "dispatched") throw new Error("Expected selected removal");
        expect(outcome.result).toBe(f.result);
        expect(f.trace.map(entry => (entry as unknown[])[0])).toEqual(["branch", "resolve", "path", "exists", "assert", "scan", "identity", "metadata", unified ? "remove-unified" : "remove-multi"]);
        expect(f.trace.at(-1)).toEqual([unified ? "remove-unified" : "remove-multi", { repositoryPath: "source", destinationPath: "workspace", branch: "feature", options: undefined }, f.identity]);
    });
    it("propagates an inventory observation failure before identity or dispatch", () => {
        const f = fixture();
        const error = { observation: "inventory" };
        f.remove.observeUnreachableRepositories = path => { f.trace.push(["scan", path]); throw error; };
        let caught: unknown;
        try { createWorkspaceRemovalDispatch(f.remove).removeWorkspace("raw", "feature"); } catch (failure) { caught = failure; }
        expect(caught).toBe(error);
        expect(f.trace.map(entry => (entry as unknown[])[0])).toEqual(["branch", "resolve", "path", "exists", "assert", "scan"]);
    });
});
