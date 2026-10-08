import { describe, expect, it } from "vitest";
import { createWorkspaceCreationDispatch, createWorkspaceRemovalDispatch } from "../../application/workspace/dispatch.js";
import type { WorkspaceCreationDispatchPorts, WorkspaceRemovalDispatchPorts } from "../../ports/workspace/dispatch.js";

function fixture(unified = true) {
    const trace: unknown[] = [];
    const identity = { native: "workspace" };
    const result = { removed: ["workspace"], errors: [] };
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
    const remove: WorkspaceRemovalDispatchPorts<typeof identity, string> = { ...shared,
        destinationExists(path) { trace.push(["exists", path]); return true; },
        assertRequestedBranch(...args) { trace.push(["assert", ...args]); },
        observeUnreachableRepositories(path, unreachable) { trace.push(["scan", path]); void unreachable; },
        observePathContent(path) { trace.push(["content", path]); return "unreadable"; },
        formatUnmanagedRefusal(path, content) { trace.push(["refusal", path, content]); return `${path}:${content}`; },
        captureWorkspaceIdentity(path) { trace.push(["identity", path]); return identity; },
        removeUnified(request, receipt) { trace.push(["remove-unified", request, receipt]); return result; },
        removeMulti(request, receipt) { trace.push(["remove-multi", request, receipt]); return result; },
    };
    return { trace, identity, created, result, create, remove };
}

describe("complete workspace admission and dispatch", () => {
    it("does not read port getters during construction", () => {
        const ports = new Proxy({}, { get() { throw new Error("eager capability lookup"); } });
        createWorkspaceCreationDispatch(ports as WorkspaceCreationDispatchPorts);
        createWorkspaceRemovalDispatch(ports as WorkspaceRemovalDispatchPorts<object, string>);
    });
    it.each([true, false])("preserves ordered creation and selected result identity (unified=%s)", unified => {
        const f = fixture(unified);
        expect(createWorkspaceCreationDispatch(f.create).createWorkspace("raw", "feature")).toBe(f.created);
        expect(f.trace.map(entry => (entry as unknown[])[0])).toEqual(["branch", "resolve", "path", "enclosing", "warn", "metadata", unified ? "create-unified" : "create-multi"]);
    });
    it.each([true, false])("forwards original removal options and opaque identity (unified=%s)", unified => {
        const f = fixture(unified);
        const options = { force: true };
        expect(createWorkspaceRemovalDispatch(f.remove).removeWorkspace("raw", "feature", options)).toBe(f.result);
        const last = f.trace.at(-1) as [string, { options: object }, object];
        expect(last[1].options).toBe(options);
        expect(last[2]).toBe(f.identity);
        expect(f.trace.map(entry => (entry as unknown[])[0])).toEqual(["branch", "resolve", "path", "exists", "assert", "identity", "metadata", unified ? "remove-unified" : "remove-multi"]);
    });
    it.each([undefined, false, "truthy", 1, null])("strict force %s does not bypass unreachable inventory", force => {
        const f = fixture();
        f.remove.observeUnreachableRepositories = (_path, unreachable) => { f.trace.push(["scan"]); unreachable.push("first", "second"); };
        const result = createWorkspaceRemovalDispatch(f.remove).removeWorkspace("raw", "feature", { force } as { force?: boolean });
        expect(result).toEqual({ removed: [], errors: ["first:unreadable", "second:unreadable"] });
        expect(f.trace.map(entry => (entry as unknown[])[0])).toEqual(["branch", "resolve", "path", "exists", "assert", "scan", "content", "refusal", "content", "refusal"]);
    });
    it.each(["validateBranch", "resolveSource", "workspacePath", "destinationExists", "assertRequestedBranch", "observeUnreachableRepositories", "captureWorkspaceIdentity", "sourceHasGitMetadata", "removeUnified"] as const)("preserves a raw admission failure at %s", stage => {
        const f = fixture();
        const error = { stage };
        Object.assign(f.remove, { [stage]: () => { throw error; } });
        let caught: unknown;
        try { createWorkspaceRemovalDispatch(f.remove).removeWorkspace("raw", "feature"); } catch (failure) { caught = failure; }
        expect(caught).toBe(error);
    });
});
