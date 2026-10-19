import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join, resolve } from "path";
import * as core from "../../application/workspace/cli-removal.js";
import type { WorkspaceCliContainerRuntime, WorkspaceCliRemovalPorts } from "../../ports/workspace/cli-removal.js";
import type { RemoveResult, WorkspaceRemovalProgress, WorkspaceRemovalRequest } from "../../domain/workspace/removal-result.js";

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
    it("snapshots scalar identity facts before the workspace effect can mutate the probe object", () => {
        const identity = { containerId: "captured-id", running: true };
        const plan = core.prepareWorkspaceContainerRemovalPlan("workspace", () => ["name"], () => identity, () => true);
        expect(plan).toEqual([{ containerName: "name", identity }]);
        const runtime = { stop: vi.fn(), remove: vi.fn() };
        core.removeWorkspaceThenContainers(() => {
            identity.containerId = "replacement-id";
            identity.running = false;
            return { removed: ["workspace"], errors: [] };
        }, () => core.removePreparedWorkspaceContainers(plan, runtime, () => true));
        expect(runtime.remove).toHaveBeenCalledExactlyOnceWith("captured-id");
        expect(runtime.stop).toHaveBeenCalledExactlyOnceWith("captured-id");
        expect(plan[0].identity).not.toBe(identity);
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
    it("pins one captured scalar ID while stop mutates the admitted identity object", () => {
        const identity = { containerId: "before-stop", running: true };
        const calls: string[] = [];
        const removed = core.removePreparedWorkspaceContainers([{ containerName: "name", identity }], {
            stop: (id): undefined => { calls.push(`stop:${id}`); identity.containerId = "after-stop"; },
            remove: (id): undefined => { calls.push(`remove:${id}`); },
        }, () => true);
        expect(removed).toEqual(["name"]);
        expect(calls).toEqual(["stop:before-stop", "remove:before-stop"]);
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
    it("retains the strict ownership admission option", () => {
        const assertion = vi.fn((): undefined => undefined);
        core.assertRemovableWorkspace("workspace", "branch", "source", assertion);
        expect(assertion).toHaveBeenCalledExactlyOnceWith("workspace", "branch", "source", { allowTrackedGitlinks: true });
    });
});

function removalFixture() {
    const trace: string[] = [];
    const events: WorkspaceRemovalProgress[] = [];
    const result: RemoveResult = { removed: ["nested"], errors: [] };
    let locked = false;
    const effect = (name: string): undefined => { expect(locked).toBe(true); trace.push(name); };
    const claims = vi.fn(() => { effect("claims"); return [] as string[]; });
    const ownership = vi.fn((_path: string, _branch: string, _source: string, _options: { allowTrackedGitlinks: true }) => effect("ownership"));
    const readiness = vi.fn(() => effect("ready"));
    const identity = { containerId: "captured-id", running: true };
    const inspect = vi.fn((_name: string, _workspace: string) => { effect("identity"); return identity as typeof identity | null; });
    const exists = vi.fn(() => { effect("exists"); return true; });
    const removeWorkspace = vi.fn((_source: string, _branch: string, _options: { force: boolean }) => { effect("workspace"); return result; });
    const stranded = vi.fn(() => {
        expect(locked).toBe(false); trace.push("stranded");
        return [{ repository: "source/nested", lockedPaths: ["old/workspace/nested"] }];
    });
    const runtime: WorkspaceCliContainerRuntime = {
        listNames: vi.fn(() => { effect("list"); return { kind: "listed" as const, names: ["base", "unrelated"] }; }),
        stop: vi.fn((id: string) => effect(`stop:${id}`)),
        remove: vi.fn((id: string) => effect(`remove:${id}`)),
    };
    const ports: WorkspaceCliRemovalPorts = {
        resolveSource: source => source,
        selectWorkspacePath: () => (source, branch) => { trace.push("path"); expect([source, branch]).toEqual(["source", "branch"]); return "workspace"; },
        selectProjectId: () => path => { trace.push("project"); expect(path).toBe("workspace"); return "project"; },
        selectFamilyLock: () => (project, operation) => {
            expect(project).toBe("project"); trace.push("lock"); locked = true;
            try { return operation(); } finally { locked = false; trace.push("unlock"); }
        },
        selectClaims: () => claims,
        selectOwnershipAssertion: () => ownership,
        selectRuntimeReadiness: () => readiness,
        selectContainerName: () => () => "base",
        selectManagedIdentity: () => inspect,
        selectExists: () => exists,
        selectContainerRuntime: () => runtime,
        selectRemoveWorkspace: () => removeWorkspace,
        selectStrandedRegistrations: () => stranded,
        publish: event => {
            expect(locked).toBe(event.kind === "started" || event.kind === "containers-removed");
            trace.push(`event:${event.kind}`); events.push(event); return undefined;
        },
    };
    const request: WorkspaceRemovalRequest = { sourcePath: "source", branch: "branch", force: false };
    return { ports, request, trace, events, result, identity, claims, ownership, readiness, inspect, exists, runtime, removeWorkspace, stranded, locked: () => locked };
}

describe("complete workspace removal application", () => {
    it("returns native facts and semantic progress without console or exit capabilities", () => {
        const f = removalFixture();
        const outcome = core.createWorkspaceRemoval(f.ports)(f.request);
        expect(outcome).toEqual({ kind: "removed", result: f.result, removedContainers: ["base"], stranded: [{ repository: "source/nested", lockedPaths: ["old/workspace/nested"] }] });
        expect(outcome.result).toBe(f.result);
        expect(f.events).toEqual([
            { kind: "started", branch: "branch" },
            { kind: "containers-removed", names: ["base"] },
            { kind: "result", removed: ["nested"], errors: [] },
            { kind: "removed" },
        ]);
        expect(f.trace).toEqual(["path", "project", "lock", "claims", "ownership", "ready", "event:started", "list", "identity", "workspace", "stop:captured-id", "remove:captured-id", "event:containers-removed", "unlock", "event:result", "event:removed", "stranded"]);
        expect(f.ownership).toHaveBeenCalledExactlyOnceWith("workspace", "branch", "source", { allowTrackedGitlinks: true });
        expect(f.inspect).toHaveBeenCalledExactlyOnceWith("base", "workspace");
        expect(f.removeWorkspace).toHaveBeenCalledExactlyOnceWith("source", "branch", { force: false });
        expect(f.locked()).toBe(false);
    });

    it.each([false, true])("observes active claims under the guard and admits removal only with force=%s", force => {
        const f = removalFixture();
        f.claims.mockImplementation(() => { expect(f.locked()).toBe(true); f.trace.push("claims"); return ["base-session", "profile-session"]; });
        const outcome = core.createWorkspaceRemoval(f.ports)({ ...f.request, force });
        expect(f.claims).toHaveBeenCalledExactlyOnceWith("project");
        if (force) {
            expect(outcome.kind).toBe("removed");
            expect(f.removeWorkspace).toHaveBeenCalledExactlyOnceWith("source", "branch", { force: true });
        } else {
            expect(outcome).toMatchObject({ kind: "failed", result: null, error: expect.objectContaining({ message: expect.stringContaining("ownership claim") }) });
            expect(f.ownership).not.toHaveBeenCalled();
            expect(f.readiness).not.toHaveBeenCalled();
            expect(f.runtime.listNames).not.toHaveBeenCalled();
            expect(f.removeWorkspace).not.toHaveBeenCalled();
            expect(f.events).toEqual([]);
        }
        expect(f.locked()).toBe(false);
    });

    it.each(["ownership", "readiness", "inventory", "identity", "workspace"] as const)("preserves the exact %s exception, releases the guard and stops later effects", stage => {
        const f = removalFixture();
        const failure = { stage, native: true };
        const fail = (): never => { throw failure; };
        if (stage === "ownership") f.ownership.mockImplementation(fail);
        if (stage === "readiness") f.readiness.mockImplementation(fail);
        if (stage === "inventory") vi.mocked(f.runtime.listNames).mockImplementation(fail);
        if (stage === "identity") f.inspect.mockImplementation(fail);
        if (stage === "workspace") f.removeWorkspace.mockImplementation(fail);
        const outcome = core.createWorkspaceRemoval(f.ports)(f.request);
        expect(outcome.kind).toBe("failed");
        if (outcome.kind !== "failed") throw new Error("expected failed outcome");
        expect(outcome.error).toBe(failure);
        expect(outcome.result).toBeNull();
        expect(f.runtime.stop).not.toHaveBeenCalled();
        expect(f.runtime.remove).not.toHaveBeenCalled();
        expect(f.stranded).not.toHaveBeenCalled();
        if (stage !== "workspace") expect(f.removeWorkspace).not.toHaveBeenCalled();
        expect(f.locked()).toBe(false);
    });

    it.each(["path", "project"] as const)("preserves the pre-catch %s resolution exception", stage => {
        const f = removalFixture();
        const failure = new Error(`${stage} resolution`);
        if (stage === "path") f.ports.selectWorkspacePath = () => () => { throw failure; };
        else f.ports.selectProjectId = () => () => { throw failure; };
        expect(() => core.createWorkspaceRemoval(f.ports)(f.request)).toThrow(failure);
        expect(f.trace).not.toContain("lock");
        expect(f.removeWorkspace).not.toHaveBeenCalled();
        expect(f.events).toEqual([]);
    });

    it("preserves a source-binding exception before guard admission", () => {
        const f = removalFixture();
        const failure = new Error("source resolution failed");
        f.ports.resolveSource = () => { throw failure; };
        expect(() => core.createWorkspaceRemoval(f.ports)(f.request)).toThrow(failure);
        expect(f.trace).toEqual([]);
        expect(f.removeWorkspace).not.toHaveBeenCalled();
    });

    it("pins relative source identity when progress changes the current directory", () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-removal-relative-source-"));
        try {
            const sourceA = join(root, "source-a");
            const sourceB = join(root, "source-b");
            let currentDirectory = sourceA;
            // The controlled native adapter retains node:path's actual relative resolution.
            const nativeWorkspacePath = (source: string, branch: string): string => {
                const absoluteSource = resolve(currentDirectory, source);
                return join(dirname(absoluteSource), `${basename(absoluteSource)}--${branch}`);
            };
            const workspaceA = nativeWorkspacePath(sourceA, "branch");
            const workspaceB = nativeWorkspacePath(sourceB, "branch");
            for (const path of [sourceA, sourceB, workspaceA, workspaceB]) mkdirSync(path);
            writeFileSync(join(workspaceA, "content.txt"), "workspace A");
            writeFileSync(join(workspaceB, "content.txt"), "active workspace B");
            const activeB = ["active-B-session"];
            const claims = new Map([[workspaceA, [] as string[]], [workspaceB, activeB]]);
            const locks: string[] = [];
            let heldLock: string | null = null;
            const observedClaims = vi.fn((project: string) => {
                expect(heldLock).toBe(project);
                return claims.get(project)!;
            });
            const ownership = vi.fn((): undefined => undefined);
            const inspect = vi.fn((_name: string, _workspace: string) => ({ containerId: "container-of-A", running: true }));
            const stop = vi.fn((_id: string): undefined => { expect(heldLock).toBe(workspaceA); return undefined; });
            const remove = vi.fn((_id: string): undefined => { expect(heldLock).toBe(workspaceA); return undefined; });
            const result: RemoveResult = { removed: [], errors: [] };
            const removeWorkspace = vi.fn((source: string, branch: string, _options: { force: boolean }) => {
                const path = nativeWorkspacePath(source, branch);
                rmSync(path, { recursive: true });
                result.removed.push(path);
                return result;
            });
            const stranded = vi.fn((_source: string, _branch: string) => []);
            const resolveSource = vi.fn((source: string) => resolve(currentDirectory, source));
            const ports: WorkspaceCliRemovalPorts = {
                resolveSource,
                selectWorkspacePath: () => nativeWorkspacePath,
                selectProjectId: () => path => path,
                selectFamilyLock: () => (project, operation) => {
                    locks.push(project); heldLock = project;
                    try { return operation(); } finally { heldLock = null; }
                },
                selectClaims: () => observedClaims,
                selectOwnershipAssertion: () => ownership,
                selectRuntimeReadiness: () => () => undefined,
                selectContainerName: () => path => path === workspaceA ? "container-A" : "container-B",
                selectManagedIdentity: () => inspect,
                selectExists: () => () => true,
                selectContainerRuntime: () => ({ listNames: () => ({ kind: "listed", names: ["container-A", "container-B"] }), stop, remove }),
                selectRemoveWorkspace: () => removeWorkspace,
                selectStrandedRegistrations: () => stranded,
                publish: event => { if (event.kind === "started") currentDirectory = sourceB; return undefined; },
            };
            const outcome = core.createWorkspaceRemoval(ports)({ sourcePath: ".", branch: "branch", force: false });
            expect(existsSync(workspaceB), "B has an active claim and must survive the A operation").toBe(true);
            expect(readFileSync(join(workspaceB, "content.txt"), "utf8")).toBe("active workspace B");
            expect(existsSync(workspaceA), "only the workspace admitted under A's family guard is deleted").toBe(false);
            expect(outcome).toEqual({ kind: "removed", result, removedContainers: ["container-A"], stranded: [] });
            expect(result.removed).toEqual([workspaceA]);
            expect(resolveSource).toHaveBeenCalledExactlyOnceWith(".");
            expect(locks).toEqual([workspaceA]);
            expect(observedClaims).toHaveBeenCalledExactlyOnceWith(workspaceA);
            expect(claims.get(workspaceB)).toBe(activeB);
            expect(activeB).toEqual(["active-B-session"]);
            expect(ownership).toHaveBeenCalledExactlyOnceWith(workspaceA, "branch", sourceA, { allowTrackedGitlinks: true });
            expect(inspect).toHaveBeenCalledExactlyOnceWith("container-A", workspaceA);
            expect(removeWorkspace).toHaveBeenCalledExactlyOnceWith(sourceA, "branch", { force: false });
            expect(stranded).toHaveBeenCalledExactlyOnceWith(sourceA, "branch");
            expect(stop).toHaveBeenCalledExactlyOnceWith("container-of-A");
            expect(remove).toHaveBeenCalledExactlyOnceWith("container-of-A");
            expect(heldLock).toBeNull();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it.each(["unavailable", "duplicate", "present-unknown", "confirmed-absent"] as const)("validates the complete inventory before workspace mutation: %s", inventory => {
        const f = removalFixture();
        if (inventory === "unavailable") vi.mocked(f.runtime.listNames).mockReturnValue({ kind: "unavailable" });
        if (inventory === "duplicate") vi.mocked(f.runtime.listNames).mockReturnValue({ kind: "listed", names: ["base", "base--p--work"] });
        if (inventory === "present-unknown" || inventory === "confirmed-absent") f.inspect.mockReturnValue(null);
        f.exists.mockReturnValue(inventory !== "confirmed-absent");
        const outcome = core.createWorkspaceRemoval(f.ports)(f.request);
        if (inventory === "confirmed-absent") {
            expect(outcome).toMatchObject({ kind: "removed", removedContainers: [] });
            expect(f.removeWorkspace).toHaveBeenCalledOnce();
        } else {
            expect(outcome).toMatchObject({ kind: "failed", result: null });
            expect(f.removeWorkspace).not.toHaveBeenCalled();
        }
        expect(f.runtime.stop).not.toHaveBeenCalled();
        expect(f.runtime.remove).not.toHaveBeenCalled();
        expect(f.locked()).toBe(false);
    });

    it("returns the exact incomplete workspace result and leaves every associated container intact", () => {
        const f = removalFixture();
        f.result.errors.push("dirty workspace");
        const outcome = core.createWorkspaceRemoval(f.ports)({ ...f.request, force: true });
        expect(outcome).toEqual({ kind: "incomplete", result: f.result });
        expect(outcome.result).toBe(f.result);
        expect(f.runtime.stop).not.toHaveBeenCalled();
        expect(f.runtime.remove).not.toHaveBeenCalled();
        expect(f.stranded).not.toHaveBeenCalled();
        expect(f.events).toEqual([{ kind: "started", branch: "branch" }, { kind: "result", removed: ["nested"], errors: ["dirty workspace"] }, { kind: "incomplete", removed: ["nested"] }]);
        expect(f.locked()).toBe(false);
    });

    it.each(["stop", "remove"] as const)("retains the genuine workspace result when %s fails and halts later container cleanup", stage => {
        const f = removalFixture();
        const failure = new Error(`${stage} failed after workspace removal`);
        vi.mocked(f.runtime.listNames).mockReturnValue({ kind: "listed", names: ["base", "base--p--later"] });
        f.inspect.mockImplementation(name => ({ containerId: name === "base" ? "first-id" : "later-id", running: true }));
        vi.mocked(f.runtime[stage]).mockImplementation(() => { throw failure; });
        const outcome = core.createWorkspaceRemoval(f.ports)(f.request);
        expect(outcome).toEqual({ kind: "failed", error: failure, result: f.result });
        if (outcome.kind !== "failed") throw new Error("expected failed outcome");
        expect(outcome.error).toBe(failure);
        expect(outcome.result).toBe(f.result);
        expect(f.runtime.stop).toHaveBeenCalledExactlyOnceWith("first-id");
        if (stage === "stop") expect(f.runtime.remove).not.toHaveBeenCalled();
        else expect(f.runtime.remove).toHaveBeenCalledExactlyOnceWith("first-id");
        expect(f.events).toEqual([{ kind: "started", branch: "branch" }]);
        expect(f.stranded).not.toHaveBeenCalled();
        expect(f.locked()).toBe(false);
    });

    it("retains scalar identities admitted before workspace deletion changes the probe object", () => {
        const f = removalFixture();
        f.removeWorkspace.mockImplementation(() => {
            f.identity.containerId = "replacement-after-workspace"; f.identity.running = false;
            return f.result;
        });
        expect(core.createWorkspaceRemoval(f.ports)(f.request).kind).toBe("removed");
        expect(f.runtime.stop).toHaveBeenCalledExactlyOnceWith("captured-id");
        expect(f.runtime.remove).toHaveBeenCalledExactlyOnceWith("captured-id");
    });

    it("captures request values before a semantic observer can change the caller's request", () => {
        const f = removalFixture();
        const publish = f.ports.publish;
        f.ports.publish = event => {
            if (event.kind === "started") Object.assign(f.request, { sourcePath: "foreign-source", branch: "other-branch", force: true });
            return publish(event);
        };
        expect(core.createWorkspaceRemoval(f.ports)(f.request).kind).toBe("removed");
        expect(f.removeWorkspace).toHaveBeenCalledExactlyOnceWith("source", "branch", { force: false });
        expect(f.stranded).toHaveBeenCalledExactlyOnceWith("source", "branch");
    });

    it("publishes array snapshots without surrendering native results or removed-container outcomes", () => {
        const f = removalFixture();
        f.ports.publish = event => {
            if (event.kind === "containers-removed") (event.names as string[]).push("invented-container");
            if (event.kind === "result") { (event.removed as string[]).push("invented-worktree"); (event.errors as string[]).push("invented-error"); }
            return undefined;
        };
        const outcome = core.createWorkspaceRemoval(f.ports)(f.request);
        expect(outcome).toMatchObject({ kind: "removed", removedContainers: ["base"] });
        expect(outcome.result).toBe(f.result);
        expect(f.result).toEqual({ removed: ["nested"], errors: [] });
    });

    it("decides incomplete from native facts before an observer changes the native error array", () => {
        const f = removalFixture();
        f.result.errors.push("dirty workspace");
        const publish = f.ports.publish;
        f.ports.publish = event => {
            if (event.kind === "result") f.result.errors.length = 0;
            if (event.kind === "incomplete") expect(event.removed).toEqual(["nested"]);
            return publish(event);
        };
        expect(core.createWorkspaceRemoval(f.ports)(f.request)).toEqual({ kind: "incomplete", result: f.result });
        expect(f.runtime.remove).not.toHaveBeenCalled();
        expect(f.stranded).not.toHaveBeenCalled();
    });

    it.each(["started", "containers-removed", "result"] as const)("returns the original %s observer failure without authorizing later effects", stage => {
        const f = removalFixture();
        const failure = new Error("semantic observer failed");
        const publish = f.ports.publish;
        f.ports.publish = event => { if (event.kind === stage) throw failure; return publish(event); };
        const outcome = core.createWorkspaceRemoval(f.ports)(f.request);
        expect(outcome).toEqual({ kind: "failed", error: failure, result: stage === "started" ? null : f.result });
        if (outcome.kind !== "failed") throw new Error("expected failed outcome");
        expect(outcome.error).toBe(failure);
        expect(outcome.result).toBe(stage === "started" ? null : f.result);
        if (stage === "started") { expect(f.runtime.listNames).not.toHaveBeenCalled(); expect(f.removeWorkspace).not.toHaveBeenCalled(); }
        expect(f.stranded).not.toHaveBeenCalled();
        expect(f.locked()).toBe(false);
    });

    it("preserves a native failure without publishing a replacement failure to the observer", () => {
        const f = removalFixture();
        const failure = new Error("native workspace failure");
        f.removeWorkspace.mockImplementation(() => { throw failure; });
        f.ports.publish = event => { if (event.kind !== "started") throw new Error("must not replace native failure"); return undefined; };
        const outcome = core.createWorkspaceRemoval(f.ports)(f.request);
        expect(outcome).toEqual({ kind: "failed", error: failure, result: null });
        if (outcome.kind !== "failed") throw new Error("expected failed outcome");
        expect(outcome.error).toBe(failure);
    });

    it("retains completed deletion facts when stranded observation fails after success progress", () => {
        const f = removalFixture();
        const failure = new Error("stranded registry unavailable");
        f.stranded.mockImplementation(() => { expect(f.locked()).toBe(false); throw failure; });
        const outcome = core.createWorkspaceRemoval(f.ports)(f.request);
        expect(outcome).toEqual({ kind: "failed", error: failure, result: f.result });
        if (outcome.kind !== "failed") throw new Error("expected failed outcome");
        expect(outcome.error).toBe(failure);
        expect(outcome.result).toBe(f.result);
        expect(f.events.at(-1)).toEqual({ kind: "removed" });
        expect(f.removeWorkspace).toHaveBeenCalledOnce();
        expect(f.runtime.remove).toHaveBeenCalledExactlyOnceWith("captured-id");
        expect(f.locked()).toBe(false);
    });
});
