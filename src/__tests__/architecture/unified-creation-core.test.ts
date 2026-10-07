import { describe, expect, it } from "vitest";
import { createUnifiedWorkspaceCreation } from "../../application/workspace/unified-creation.js";
import type { UnifiedCreationPorts, UnifiedCreationRequest } from "../../ports/workspace/unified-creation.js";
import type { WorktreeAdditionRequest } from "../../ports/workspace/worktree-addition.js";
import type { WorktreeRepoResult } from "../../domain/workspace/creation-result.js";

const request: UnifiedCreationRequest = Object.freeze({ repositoryPath: "source", destinationPath: "destination", branch: "topic" });
const names = ["observeBranch", "prepareAddition", "addPrepared", "compensateFailedAddition", "requireRootRegistration", "sourceWorkspaceName", "repairNestedWorktrees", "rootWorktreeMatches", "removeRegisteredRoot", "rollbackCreatedRootBranch"] as const;
function thrown(run: () => unknown): unknown {
    try { run(); } catch (error) { return error; }
    throw new Error("Expected operation to throw");
}
function fixture(existence: "local" | "remote" | "none" = "none") {
    const trace: string[] = [];
    const prepared = Symbol("opaque prepared");
    const receipt = Symbol("opaque receipt");
    const registration = Symbol("required registration");
    const nested: WorktreeRepoResult[] = [{ name: "nested", branch: "child-topic", action: "worktree-existing" }];
    let additionRequest: WorktreeAdditionRequest | undefined;
    const action = existence === "local" ? "worktree-existing" : existence === "remote" ? "worktree-remote" : "worktree-new";
    const parent = (actual: UnifiedCreationRequest) => expect(actual).toBe(request);
    const ports: UnifiedCreationPorts<symbol, symbol> = {
        observeBranch(actual) { trace.push("observe"); additionRequest = actual; expect(actual).toEqual({ ...request, failureContext: { kind: "unified" } }); return existence; },
        prepareAddition(actual, actualAction) { trace.push("prepare"); expect(actual).toBe(additionRequest); expect(actualAction).toBe(action); return prepared; },
        addPrepared(actual, actualPrepared) { trace.push("add"); expect(actual).toBe(additionRequest); expect(actualPrepared).toBe(prepared); return { status: 0, registrationReceipt: receipt }; },
        compensateFailedAddition(actual, actualAction, actualPrepared, actualReceipt) { trace.push("addition-rollback"); expect(actual).toBe(additionRequest); expect(actualAction).toBe(action); expect(actualPrepared).toBe(prepared); expect(actualReceipt).toBe(receipt); },
        requireRootRegistration(actualReceipt, actual) { trace.push("registration"); parent(actual); expect(actualReceipt).toBe(receipt); return registration; },
        sourceWorkspaceName(actual) { trace.push("name"); parent(actual); return "source-name"; },
        repairNestedWorktrees(actual) { trace.push("repair"); parent(actual); return nested; },
        rootWorktreeMatches(actual) { trace.push("matches"); parent(actual); return true; },
        removeRegisteredRoot(actual, actualRegistration) { trace.push("remove"); parent(actual); expect(actualRegistration).toBe(registration); },
        rollbackCreatedRootBranch(actual, actualAction, actualPrepared) { trace.push("branch"); parent(actual); expect(actualAction).toBe(action); expect(actualPrepared).toBe(prepared); },
    };
    return { trace, ports, prepared, receipt, registration, nested, action };
}

describe("unified workspace creation orchestration", () => {
    it("constructs a synchronous operation without invoking any of its ten ports", () => {
        const f = fixture();
        expect(typeof createUnifiedWorkspaceCreation(f.ports)).toBe("function");
        expect(f.trace).toEqual([]);
    });
    it.each(names)("requires callable %s without native effects", name => {
        const f = fixture();
        const broken = { ...f.ports, [name]: undefined } as unknown as UnifiedCreationPorts<symbol, symbol>;
        expect(thrown(() => createUnifiedWorkspaceCreation(broken))).toBeInstanceOf(TypeError);
        expect(f.trace).toEqual([]);
    });
    it("rejects an absent port object without effects", () => {
        expect(thrown(() => createUnifiedWorkspaceCreation(undefined as unknown as UnifiedCreationPorts<symbol, symbol>))).toBeInstanceOf(TypeError);
    });
    it.each(["local", "remote", "none"] as const)("preserves %s addition action, opaque values, parent request and root-first result", existence => {
        const f = fixture(existence);
        const create = createUnifiedWorkspaceCreation(f.ports);
        const result = create(request);
        expect(f.trace).toEqual(["observe", "prepare", "add", "registration", "name", "repair"]);
        expect(result).toEqual({ workspacePath: request.destinationPath, created: [{ name: "source-name", branch: request.branch, action: f.action }, ...f.nested], copied: [] });
        expect(result.created[1]).toBe(f.nested[0]);
        expect(result.created).not.toBe(f.nested);
        expect(result.copied).not.toBe(create(request).copied);
        expect(result).not.toHaveProperty("then");
    });
    it.each(["observeBranch", "prepareAddition", "addPrepared", "requireRootRegistration", "sourceWorkspaceName"] as const)("leaves %s failure outside repair compensation", name => {
        const f = fixture();
        const sentinel = Symbol(name);
        const ports = { ...f.ports, [name]: () => { f.trace.push("failure"); throw sentinel; } };
        expect(thrown(() => createUnifiedWorkspaceCreation(ports)(request))).toBe(sentinel);
        expect(f.trace).not.toContain("repair");
        expect(f.trace).not.toContain("matches");
        expect(f.trace).not.toContain("remove");
        expect(f.trace).not.toContain("branch");
        expect(f.trace).not.toContain("addition-rollback");
    });
    it("passes a missing addition receipt to registration validation without inventing compensation", () => {
        const f = fixture();
        const sentinel = new Error("missing receipt");
        const ports = { ...f.ports, addPrepared: () => ({ status: 0, registrationReceipt: null }), requireRootRegistration: (receipt: symbol | null, actual: UnifiedCreationRequest): symbol => { expect(receipt).toBeNull(); expect(actual).toBe(request); throw sentinel; } };
        expect(thrown(() => createUnifiedWorkspaceCreation(ports)(request))).toBe(sentinel);
        expect(f.trace).toEqual(["observe", "prepare"]);
    });
    it("inherits addition failure diagnostics and delegates only addition compensation", () => {
        const f = fixture();
        const ports = { ...f.ports, addPrepared: (actual: WorktreeAdditionRequest, prepared: symbol) => { f.ports.addPrepared(actual, prepared); return { status: null, stderr: "  failed add  ", registrationReceipt: f.receipt }; } };
        const error = thrown(() => createUnifiedWorkspaceCreation(ports)(request));
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("Failed to create worktree: failed add");
        expect(f.trace).toEqual(["observe", "prepare", "add", "addition-rollback"]);
    });
    it("inherits addition rollback error and cause without unified repair compensation", () => {
        const f = fixture();
        const rollback = new Error("add compensation refused");
        const ports = { ...f.ports, addPrepared: () => ({ status: 1, stderr: "add failed", registrationReceipt: f.receipt }), compensateFailedAddition: () => { throw rollback; } };
        const error = thrown(() => createUnifiedWorkspaceCreation(ports)(request)) as Error;
        expect(error.message).toBe("Failed to create worktree: add failed; rollback failed: add compensation refused");
        expect(error.cause).toBe(rollback);
        expect(f.trace).toEqual(["observe", "prepare"]);
    });
    it.each(["local", "remote", "none"] as const)("compensates repair failure in exact order for %s then rethrows original identity", existence => {
        const f = fixture(existence);
        const original = new Error("repair failed");
        const ports = { ...f.ports, repairNestedWorktrees: (actual: UnifiedCreationRequest): WorktreeRepoResult[] => { f.ports.repairNestedWorktrees(actual); throw original; } };
        expect(thrown(() => createUnifiedWorkspaceCreation(ports)(request))).toBe(original);
        expect(f.trace).toEqual(["observe", "prepare", "add", "registration", "name", "repair", "matches", "remove", "branch"]);
    });
    it.each(["rootWorktreeMatches", "removeRegisteredRoot", "rollbackCreatedRootBranch"] as const)("stops after throwing %s and keeps original repair cause", name => {
        const f = fixture();
        const original = new Error("repair failed");
        const rollback = new Error(`failed ${name}`);
        const ports = { ...f.ports, repairNestedWorktrees: (): WorktreeRepoResult[] => { f.trace.push("repair"); throw original; }, [name]: () => { f.trace.push("rollback-failure"); throw rollback; } };
        const error = thrown(() => createUnifiedWorkspaceCreation(ports)(request)) as Error;
        expect(error.message).toBe(`repair failed; workspace rollback failed: failed ${name}`);
        expect(error.cause).toBe(original);
        const prefix = ["observe", "prepare", "add", "registration", "name", "repair"];
        expect(f.trace).toEqual([...prefix, ...(name === "rootWorktreeMatches" ? [] : ["matches"]), ...(name === "rollbackCreatedRootBranch" ? ["remove"] : []), "rollback-failure"]);
    });
    it("does not remove or roll back a branch after a negative ownership observation", () => {
        const f = fixture();
        const original = new Error("repair failed");
        const ports = { ...f.ports, repairNestedWorktrees: (): WorktreeRepoResult[] => { throw original; }, rootWorktreeMatches: () => { f.trace.push("matches"); return false; } };
        const error = thrown(() => createUnifiedWorkspaceCreation(ports)(request)) as Error;
        expect(error.message).toBe("repair failed; workspace rollback failed: root worktree ownership changed during rollback");
        expect(error.cause).toBe(original);
        expect(f.trace).toEqual(["observe", "prepare", "add", "registration", "name", "matches"]);
    });
    it("leaves result iteration failures outside the repair catch", () => {
        const f = fixture();
        const original = Symbol("iterator failure");
        const nested = [] as WorktreeRepoResult[];
        nested[Symbol.iterator] = () => { throw original; };
        const ports = { ...f.ports, repairNestedWorktrees: () => nested };
        expect(thrown(() => createUnifiedWorkspaceCreation(ports)(request))).toBe(original);
        expect(f.trace).toEqual(["observe", "prepare", "add", "registration", "name"]);
    });
    it.each([undefined, null, "repair string", 7, { message: "custom message" }])("rethrows non-Error repair value %j unchanged after successful compensation", original => {
        const f = fixture();
        expect(thrown(() => createUnifiedWorkspaceCreation({ ...f.ports, repairNestedWorktrees: (): WorktreeRepoResult[] => { throw original; } })(request))).toBe(original);
        expect(f.trace.slice(-3)).toEqual(["matches", "remove", "branch"]);
    });
    it.each([{}, "rollback string", 7, { message: "" }, { message: null }])("preserves message property and array-join formatting for rollback %j", rollback => {
        const f = fixture();
        const original = "repair string";
        const error = thrown(() => createUnifiedWorkspaceCreation({ ...f.ports, repairNestedWorktrees: (): WorktreeRepoResult[] => { throw original; }, removeRegisteredRoot: () => { throw rollback; } })(request)) as Error;
        expect(error.message).toBe("undefined; workspace rollback failed: ");
        expect(error.cause).toBe(original);
        expect(f.trace).not.toContain("branch");
    });
    it("uses the original message property and array join for non-Error message values", () => {
        const f = fixture();
        const original = { message: "object repair failure" };
        const rollback = { message: ["first", "second"] };
        const error = thrown(() => createUnifiedWorkspaceCreation({ ...f.ports, repairNestedWorktrees: (): WorktreeRepoResult[] => { throw original; }, removeRegisteredRoot: () => { throw rollback; } })(request)) as Error;
        expect(error.message).toBe("object repair failure; workspace rollback failed: first,second");
        expect(error.cause).toBe(original);
        expect(f.trace).not.toContain("branch");
    });
    it.each([undefined, null])("preserves baseline TypeError for nullish rollback value %j", rollback => {
        const f = fixture();
        const error = thrown(() => createUnifiedWorkspaceCreation({ ...f.ports, repairNestedWorktrees: (): WorktreeRepoResult[] => { throw new Error("repair"); }, removeRegisteredRoot: () => { throw rollback; } })(request));
        expect(error).toBeInstanceOf(TypeError);
        expect(f.trace).not.toContain("branch");
    });
    it.each([undefined, null])("preserves baseline TypeError when formatting nullish original value %j after rollback failure", original => {
        const f = fixture();
        const error = thrown(() => createUnifiedWorkspaceCreation({ ...f.ports, repairNestedWorktrees: (): WorktreeRepoResult[] => { throw original; }, removeRegisteredRoot: () => { throw new Error("rollback"); } })(request));
        expect(error).toBeInstanceOf(TypeError);
    });
});
