import { describe, expect, it } from "vitest";
import { createMultiWorkspaceCreation } from "../../application/workspace/multi-creation.js";
import type { MultiCreationPorts, MultiCreationRequest } from "../../ports/workspace/multi-creation.js";
import type { WorkspaceEntry } from "../../domain/workspace/source-entry.js";

const request: MultiCreationRequest = Object.freeze({ repositoryPath: "source", destinationPath: "workspace", branch: "topic" });
const names = ["observeBranch", "prepareAddition", "addPrepared", "compensateFailedAddition", "scanSource", "destinationPath", "ensureWorkspaceParent", "createWorkspaceExclusive", "captureWorkspaceIdentity", "requireRegistration", "pathExists", "worktreeMatches", "removeRegisteredWorktree", "rollbackCreatedBranch", "assertWorkspaceIdentity", "workspaceEntryCount", "quarantineWorkspace", "copyEntry", "captureCopiedIdentity", "quarantineCopiedEntry"] as const;
function thrown(run: () => unknown): unknown {
    try { run(); } catch (error) { return error; }
    throw new Error("Expected operation to throw");
}
function fixture() {
    const trace: string[] = [];
    const entries: WorkspaceEntry[] = [
        { name: "plain", path: "source/plain", isGitRepo: false },
        { name: "a", path: "source/a", isGitRepo: true },
        { name: "b", path: "source/b", isGitRepo: true },
        { name: "last", path: "source/last", isGitRepo: false },
    ];
    const prepared = new Map(["a", "b"].map(name => [name, Symbol(`prepared ${name}`)]));
    const receipts = new Map(["a", "b"].map(name => [name, Symbol(`receipt ${name}`)]));
    const copies = new Map(["plain", "last"].map(name => [name, Symbol(`copy ${name}`)]));
    const workspace = Symbol("workspace identity");
    const present = new Set(["workspace/a", "workspace/b"]);
    const nameFrom = (path: string) => path.slice(path.lastIndexOf("/") + 1);
    const parent = (actual: MultiCreationRequest) => expect(actual).toBe(request);
    const ports: MultiCreationPorts<symbol, symbol, symbol, symbol> = {
        scanSource(actual) { parent(actual); trace.push("scan"); return entries; },
        destinationPath(actual, name) { parent(actual); trace.push(`destination:${name}`); return `workspace/${name}`; },
        ensureWorkspaceParent(actual) { parent(actual); trace.push("parent"); },
        createWorkspaceExclusive(actual) { parent(actual); trace.push("mkdir"); },
        captureWorkspaceIdentity(actual) { parent(actual); trace.push("workspace-identity"); return workspace; },
        observeBranch(actual) { trace.push(`observe:${nameFrom(actual.repositoryPath)}`); expect(actual).toEqual({ repositoryPath: actual.repositoryPath, destinationPath: `workspace/${nameFrom(actual.repositoryPath)}`, branch: "topic", failureContext: { kind: "multi-repo", repositoryName: nameFrom(actual.repositoryPath) } }); return "none"; },
        prepareAddition(actual, action) { const name = nameFrom(actual.repositoryPath); trace.push(`prepare:${name}`); expect(action).toBe("worktree-new"); return prepared.get(name)!; },
        addPrepared(actual, value) { const name = nameFrom(actual.repositoryPath); trace.push(`add:${name}`); expect(value).toBe(prepared.get(name)); return { status: 0, registrationReceipt: receipts.get(name)! }; },
        compensateFailedAddition() { trace.push("addition-rollback"); },
        requireRegistration(receipt, destination) { const name = nameFrom(destination); trace.push(`registration:${name}`); expect(receipt).toBe(receipts.get(name)); return receipt!; },
        pathExists(path) { trace.push(`exists:${nameFrom(path)}`); return present.has(path); },
        worktreeMatches(source, destination) { const name = nameFrom(source); trace.push(`matches:${name}`); expect(destination).toBe(`workspace/${name}`); return true; },
        removeRegisteredWorktree(actual, source, destination, receipt) { parent(actual); const name = nameFrom(source); trace.push(`remove:${name}`); expect(destination).toBe(`workspace/${name}`); expect(receipt).toBe(receipts.get(name)); present.delete(destination); },
        rollbackCreatedBranch(source, branch, action, value) { const name = nameFrom(source); trace.push(`branch:${name}`); expect(branch).toBe("topic"); expect(action).toBe("worktree-new"); expect(value).toBe(prepared.get(name)); },
        assertWorkspaceIdentity(actual, identity) { parent(actual); trace.push("assert-workspace"); expect(identity).toBe(workspace); },
        workspaceEntryCount(actual) { parent(actual); trace.push("count"); return 0; },
        quarantineWorkspace(actual, identity) { parent(actual); trace.push("quarantine-workspace"); expect(identity).toBe(workspace); },
        copyEntry(source, destination) { const name = nameFrom(source); trace.push(`copy:${name}`); expect(destination).toBe(`workspace/${name}`); present.add(destination); },
        captureCopiedIdentity(destination) { const name = nameFrom(destination); trace.push(`copy-identity:${name}`); return copies.get(name)!; },
        quarantineCopiedEntry(actual, destination, identity) { parent(actual); const name = nameFrom(destination); trace.push(`quarantine-copy:${name}`); expect(identity).toBe(copies.get(name)); present.delete(destination); },
    };
    return { trace, entries, ports, prepared, receipts, copies, workspace, present };
}
const repoPrefix = ["scan", "parent", "mkdir", "workspace-identity", "destination:a", "observe:a", "prepare:a", "add:a", "registration:a", "destination:b", "observe:b", "prepare:b", "add:b", "registration:b"];

describe("multi workspace creation application boundaries", () => {
    it("constructs without invoking any semantic effect", () => {
        const f = fixture();
        expect(typeof createMultiWorkspaceCreation(f.ports)).toBe("function");
        expect(f.trace).toEqual([]);
    });
    it.each(names)("requires callable %s before effects", name => {
        const f = fixture();
        expect(thrown(() => createMultiWorkspaceCreation({ ...f.ports, [name]: undefined } as unknown as typeof f.ports))).toBeInstanceOf(TypeError);
        expect(f.trace).toEqual([]);
    });
    it.each([undefined, null])("requires a port object: %j", value => {
        expect(thrown(() => createMultiWorkspaceCreation(value as unknown as ReturnType<typeof fixture>["ports"]))).toBeInstanceOf(TypeError);
    });
    it("retains scan order while creating all repos before copying non-repos, returning mutable independent arrays", () => {
        const f = fixture();
        const result = createMultiWorkspaceCreation(f.ports)(request);
        expect(f.trace).toEqual([...repoPrefix, "destination:plain", "copy:plain", "exists:plain", "copy-identity:plain", "destination:last", "copy:last", "exists:last", "copy-identity:last"]);
        expect(result).toEqual({ workspacePath: "workspace", created: [{ name: "a", branch: "topic", action: "worktree-new" }, { name: "b", branch: "topic", action: "worktree-new" }], copied: ["plain", "last"] });
        result.created[0].name = "mutable";
        result.created.push({ name: "extra", branch: "other", action: "worktree-existing" });
        result.copied.push("extra");
        expect(f.entries.map(entry => entry.name)).toEqual(["plain", "a", "b", "last"]);
        expect(result).not.toHaveProperty("then");
    });
    it("rejects no repositories immediately after scanning", () => {
        const f = fixture(); f.entries.splice(1, 2);
        expect((thrown(() => createMultiWorkspaceCreation(f.ports)(request)) as Error).message).toBe("No git repositories found in current directory. Nothing to create worktrees for.");
        expect(f.trace).toEqual(["scan"]);
    });
    it.each(["scanSource", "ensureWorkspaceParent", "captureWorkspaceIdentity"] as const)("keeps %s outside repository compensation", name => {
        const f = fixture(); const original = Symbol(name);
        expect(thrown(() => createMultiWorkspaceCreation({ ...f.ports, [name]: () => { throw original; } })(request))).toBe(original);
        expect(f.trace.some(value => value.startsWith("remove:") || value.startsWith("branch:"))).toBe(false);
        expect(f.trace).not.toContain("quarantine-workspace");
    });
    it("translates EEXIST only at exclusive workspace mkdir", () => {
        const f = fixture(); const error = { code: "EEXIST" };
        expect((thrown(() => createMultiWorkspaceCreation({ ...f.ports, createWorkspaceExclusive: () => { throw error; } })(request)) as Error).message).toBe("Workspace already exists or is being created by another process: workspace");
        expect(thrown(() => createMultiWorkspaceCreation({ ...f.ports, ensureWorkspaceParent: () => { throw error; } })(request))).toBe(error);
        expect(f.trace).not.toContain("workspace-identity");
    });
    it.each([undefined, null])("preserves exclusive mkdir property-access failure for %j", original => {
        const f = fixture();
        expect(thrown(() => createMultiWorkspaceCreation({ ...f.ports, createWorkspaceExclusive: () => { throw original; } })(request))).toBeInstanceOf(TypeError);
    });
    it("publishes candidate and prepared receipt before registration validation; missing receipt blocks deletion", () => {
        const f = fixture(); const original = new Error("registration failed");
        const error = thrown(() => createMultiWorkspaceCreation({ ...f.ports, requireRegistration: () => { throw original; } })(request)) as Error;
        expect(error.message).toBe("registration failed; workspace rollback failed: a: missing worktree registration fence");
        expect(error.cause).toBe(original);
        expect(f.trace.slice(-3)).toEqual(["destination:a", "exists:a", "matches:a"]);
        expect(f.trace).not.toContain("remove:a");
        expect(f.trace).not.toContain("branch:a");
        expect(f.trace).not.toContain("assert-workspace");
    });
    it("compensates repo candidates forward and passes exact prepared references", () => {
        const f = fixture(); const original = new Error("third repo failed");
        f.entries.push({ name: "c", path: "source/c", isGitRepo: true });
        const ports = { ...f.ports, observeBranch: (actual: Parameters<typeof f.ports.observeBranch>[0]) => { if (actual.repositoryPath === "source/c") throw original; return f.ports.observeBranch(actual); } };
        expect(thrown(() => createMultiWorkspaceCreation(ports)(request))).toBe(original);
        expect(f.trace.slice(-13)).toEqual(["destination:a", "exists:a", "matches:a", "remove:a", "branch:a", "destination:b", "exists:b", "matches:b", "remove:b", "branch:b", "assert-workspace", "count", "quarantine-workspace"]);
    });
    it.each(["pathExists", "worktreeMatches"] as const)("forward %s observation failure supersedes original without aggregation", name => {
        const f = fixture(); const original = new Error("registration"); const observation = Symbol(name);
        expect(thrown(() => createMultiWorkspaceCreation({ ...f.ports, requireRegistration: () => { throw original; }, [name]: () => { throw observation; } })(request))).toBe(observation);
        expect(f.trace).not.toContain("assert-workspace");
    });
    it("forward rollback destination failure stays outside removal catch", () => {
        const f = fixture(); let count = 0; const sentinel = Symbol("rollback destination");
        expect(thrown(() => createMultiWorkspaceCreation({ ...f.ports, requireRegistration: () => { throw new Error("registration"); }, destinationPath: (actual, name) => { if (++count === 2) throw sentinel; return f.ports.destinationPath(actual, name); } })(request))).toBe(sentinel);
    });
    it.each(["absent", "foreign"] as const)("forward rollback preserves %s candidate instead of deleting it", mode => {
        const f = fixture(); const original = new Error("second failed");
        const ports = { ...f.ports, observeBranch: (actual: Parameters<typeof f.ports.observeBranch>[0]) => { if (actual.repositoryPath === "source/b") throw original; return f.ports.observeBranch(actual); }, pathExists: () => mode !== "absent", worktreeMatches: () => false, workspaceEntryCount: () => 1 };
        const error = thrown(() => createMultiWorkspaceCreation(ports)(request)) as Error;
        expect(error.message).toBe(mode === "foreign" ? "second failed; workspace rollback failed: a: worktree ownership changed during rollback" : "second failed; workspace rollback failed: workspace is not empty after worktree rollback");
        expect(f.trace).not.toContain("remove:a"); expect(f.trace).not.toContain("branch:a");
    });
    it.each(["removeRegisteredWorktree", "rollbackCreatedBranch"] as const)("forward %s error stops that branch and preserves ordered aggregate cause", name => {
        const f = fixture(); const original = new Error("third");
        f.entries.push({ name: "c", path: "source/c", isGitRepo: true });
        const error = thrown(() => createMultiWorkspaceCreation({ ...f.ports, observeBranch: actual => { if (actual.repositoryPath === "source/c") throw original; return f.ports.observeBranch(actual); }, [name]: () => { throw { message: ["one", "two"] }; } })(request)) as Error;
        expect(error.message).toBe("third; workspace rollback failed: a: one,two; b: one,two"); expect(error.cause).toBe(original);
        expect(f.trace).not.toContain("assert-workspace");
        if (name === "removeRegisteredWorktree") expect(f.trace).not.toContain("branch:a");
    });
    it.each([undefined, null, "unknown", 7, { message: "object" }])("rethrows original %j unchanged after successful forward compensation", original => {
        const f = fixture();
        expect(thrown(() => createMultiWorkspaceCreation({ ...f.ports, observeBranch: () => { throw original; } })(request))).toBe(original);
        expect(f.trace.slice(-3)).toEqual(["assert-workspace", "count", "quarantine-workspace"]);
    });
    it("preserves unknown message joining and original cause", () => {
        const f = fixture(); const original = "unknown";
        const error = thrown(() => createMultiWorkspaceCreation({ ...f.ports, observeBranch: () => { throw original; }, assertWorkspaceIdentity: () => { throw {}; } })(request)) as Error;
        expect(error.message).toBe("undefined; workspace rollback failed: "); expect(error.cause).toBe(original);
    });
    it("leaves copy destination calculation outside copy compensation", () => {
        const f = fixture(); const original = Symbol("copy destination");
        expect(thrown(() => createMultiWorkspaceCreation({ ...f.ports, destinationPath: (actual, name) => { if (name === "plain") throw original; return f.ports.destinationPath(actual, name); } })(request))).toBe(original);
        expect(f.trace).toEqual(repoPrefix);
    });
    it("copy failure compensates repos reverse without forward existence/matching prechecks, then copies reverse", () => {
        const f = fixture(); const original = new Error("copy last");
        expect(thrown(() => createMultiWorkspaceCreation({ ...f.ports, copyEntry: (source, destination) => { if (source === "source/last") { f.trace.push("copy-failure:last"); throw original; } return f.ports.copyEntry(source, destination); } })(request))).toBe(original);
        expect(f.trace.slice(-12)).toEqual(["destination:b", "remove:b", "branch:b", "destination:a", "remove:a", "branch:a", "destination:plain", "quarantine-copy:plain", "exists:last", "assert-workspace", "count", "quarantine-workspace"]);
        expect(f.trace).not.toContain("matches:a"); expect(f.trace).not.toContain("exists:a");
    });
    it("copy identity failure occurs after candidate publication but skips an unreceipted copy", () => {
        const f = fixture(); const original = new Error("identity failed");
        const error = thrown(() => createMultiWorkspaceCreation({ ...f.ports, captureCopiedIdentity: () => { throw original; } })(request)) as Error;
        expect(error.message).toBe("identity failed; workspace rollback failed: plain: partial copied content was preserved"); expect(error.cause).toBe(original);
        expect(f.trace).not.toContain("quarantine-copy:plain"); expect(f.present.has("workspace/plain")).toBe(true);
    });
    it("unsafe absent copy gets original safe-copy diagnostic and compensation", () => {
        const f = fixture();
        const error = thrown(() => createMultiWorkspaceCreation({ ...f.ports, copyEntry: () => {} })(request)) as Error;
        expect(error.message).toBe("Source entry could not be copied safely: source/plain");
        expect(f.trace).not.toContain("copy-identity:plain"); expect(f.trace.slice(-3)).toEqual(["assert-workspace", "count", "quarantine-workspace"]);
    });
    it("final partial-copy existence failure supersedes the original outside cleanup catch", () => {
        const f = fixture(); const sentinel = Symbol("existence");
        expect(thrown(() => createMultiWorkspaceCreation({ ...f.ports, copyEntry: () => { throw new Error("copy"); }, pathExists: () => { throw sentinel; } })(request))).toBe(sentinel);
        expect(f.trace.filter(value => value.startsWith("remove:"))).toEqual(["remove:b", "remove:a"]);
    });
    it("copy rollback preserves nonempty workspace silently while forward rollback reports an error", () => {
        const f = fixture(); const original = new Error("copy");
        expect(thrown(() => createMultiWorkspaceCreation({ ...f.ports, copyEntry: () => { throw original; }, workspaceEntryCount: () => 1 })(request))).toBe(original);
        expect(f.trace).toContain("assert-workspace"); expect(f.trace).not.toContain("quarantine-workspace");
    });
    it("reverse rollback aggregates repo and copied failures in original reverse order", () => {
        const f = fixture(); const original = new Error("last");
        const error = thrown(() => createMultiWorkspaceCreation({ ...f.ports, copyEntry: (source, destination) => { if (source === "source/last") throw original; f.ports.copyEntry(source, destination); }, removeRegisteredWorktree: (_actual, source) => { throw new Error(`refused ${source}`); }, quarantineCopiedEntry: () => { throw new Error("copy changed"); } })(request)) as Error;
        expect(error.message).toBe("last; workspace rollback failed: b: refused source/b; a: refused source/a; plain: copy changed"); expect(error.cause).toBe(original);
        expect(f.trace).not.toContain("branch:a"); expect(f.trace).not.toContain("assert-workspace");
    });
    it("keeps missing-source lookup ahead of forward existence checks", () => {
        const f = fixture(); const original = new Error("next repo");
        const error = thrown(() => createMultiWorkspaceCreation({ ...f.ports, observeBranch: actual => {
            if (actual.repositoryPath === "source/b") { f.entries[1].name = "renamed"; throw original; }
            return f.ports.observeBranch(actual);
        } })(request));
        expect(error).toBe(original);
        expect(f.trace).not.toContain("exists:a"); expect(f.trace).not.toContain("remove:a");
    });
    it("uses null fallback when the opaque prepared map value is undefined", () => {
        const f = fixture(); const original = new Error("next repo");
        expect(thrown(() => createMultiWorkspaceCreation({ ...f.ports,
            prepareAddition: () => undefined as unknown as symbol,
            addPrepared: () => ({ status: 0, registrationReceipt: f.receipts.get("a")! }),
            observeBranch: actual => { if (actual.repositoryPath === "source/b") throw original; return f.ports.observeBranch(actual); },
            rollbackCreatedBranch: (source, branch, action, prepared) => { expect(source).toBe("source/a"); expect(branch).toBe("topic"); expect(action).toBe("worktree-new"); expect(prepared).toBeNull(); },
        })(request))).toBe(original);
    });
    it("quarantines multiple successful copies in reverse after compensating repos", () => {
        const f = fixture(); const original = new Error("third copy");
        f.entries.push({ name: "failed", path: "source/failed", isGitRepo: false });
        expect(thrown(() => createMultiWorkspaceCreation({ ...f.ports, copyEntry: (source, destination) => {
            if (source === "source/failed") throw original;
            return f.ports.copyEntry(source, destination);
        } })(request))).toBe(original);
        expect(f.trace.slice(-14)).toEqual(["destination:b", "remove:b", "branch:b", "destination:a", "remove:a", "branch:a", "destination:last", "quarantine-copy:last", "destination:plain", "quarantine-copy:plain", "exists:failed", "assert-workspace", "count", "quarantine-workspace"]);
    });
    it("reverse destination failure is aggregated within removal catch", () => {
        const f = fixture(); const original = new Error("copy"); let rollback = false;
        const error = thrown(() => createMultiWorkspaceCreation({ ...f.ports,
            copyEntry: () => { rollback = true; throw original; },
            destinationPath: (actual, name) => { if (rollback && name === "b") throw new Error("destination refused"); return f.ports.destinationPath(actual, name); },
        })(request)) as Error;
        expect(error.message).toBe("copy; workspace rollback failed: b: destination refused"); expect(error.cause).toBe(original);
        expect(f.trace).toContain("remove:a"); expect(f.trace).not.toContain("remove:b");
    });
    it.each(["assertWorkspaceIdentity", "workspaceEntryCount", "quarantineWorkspace"] as const)("captures workspace cleanup %s failure without hiding the primary", name => {
        const f = fixture(); const original = new Error("repo");
        const error = thrown(() => createMultiWorkspaceCreation({ ...f.ports, observeBranch: () => { throw original; }, [name]: () => { throw new Error(name); } })(request)) as Error;
        expect(error.message).toBe(`repo; workspace rollback failed: ${name}`); expect(error.cause).toBe(original);
    });
    it.each([undefined, null])("preserves nullish cleanup message property failure: %j", rollback => {
        const f = fixture();
        expect(thrown(() => createMultiWorkspaceCreation({ ...f.ports, observeBranch: () => { throw new Error("repo"); }, assertWorkspaceIdentity: () => { throw rollback; } })(request))).toBeInstanceOf(TypeError);
    });
});
