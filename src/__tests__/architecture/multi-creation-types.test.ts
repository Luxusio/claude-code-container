import { describe, expect, it } from "vitest";
import { createMultiWorkspaceCreation } from "../../application/workspace/multi-creation.js";
import type { MultiCreationPorts, MultiCreationRequest } from "../../ports/workspace/multi-creation.js";
import type { WorkspaceEntry } from "../../domain/workspace/source-entry.js";
import type { WorkspaceEntry as LegacyEntry, WorktreeResult as LegacyResult } from "../../worktree.js";
import type { WorktreeResult } from "../../domain/workspace/creation-result.js";
import type { WorktreeAdditionPorts } from "../../ports/workspace/worktree-addition.js";
import { createWorkspace } from "../../worktree.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Prepared = { readonly prepared: unique symbol };
type Receipt = { readonly receipt: unique symbol };
type Identity = { readonly identity: unique symbol };
type Copied = { readonly copied: unique symbol };
type PortNames = "observeBranch" | "prepareAddition" | "addPrepared" | "compensateFailedAddition" | "scanSource" | "destinationPath" | "ensureWorkspaceParent" | "createWorkspaceExclusive" | "captureWorkspaceIdentity" | "requireRegistration" | "pathExists" | "worktreeMatches" | "removeRegisteredWorktree" | "rollbackCreatedBranch" | "assertWorkspaceIdentity" | "workspaceEntryCount" | "quarantineWorkspace" | "copyEntry" | "captureCopiedIdentity" | "quarantineCopiedEntry";
type RequiredKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T];
// @ts-expect-error Registration cannot be a falsy numeric proof.
type NumericRegistration = MultiCreationPorts<Prepared, number, Identity, Copied>;
// @ts-expect-error Registration cannot be a falsy boolean proof.
type BooleanRegistration = MultiCreationPorts<Prepared, boolean, Identity, Copied>;
// @ts-expect-error Copied identity cannot be a falsy numeric proof.
type NumericCopiedIdentity = MultiCreationPorts<Prepared, Receipt, Identity, number>;
// @ts-expect-error Copied identity cannot be a falsy boolean proof.
type BooleanCopiedIdentity = MultiCreationPorts<Prepared, Receipt, Identity, boolean>;
function contracts(ports: MultiCreationPorts<Prepared, Receipt, Identity, Copied>, request: MultiCreationRequest, entry: WorkspaceEntry, result: WorktreeResult) {
    const create = createMultiWorkspaceCreation(ports);
    const proof: [Equal<LegacyEntry, WorkspaceEntry>, Equal<keyof WorkspaceEntry, "name" | "path" | "isGitRepo">, Equal<LegacyResult, WorktreeResult>, Equal<ReturnType<typeof create>, WorktreeResult>, Equal<Parameters<typeof create>, [request: MultiCreationRequest]>, Equal<ReturnType<typeof createWorkspace>, WorktreeResult>, Equal<Parameters<typeof ports.rollbackCreatedBranch>, [source: string, branch: string, action: "worktree-existing" | "worktree-remote" | "worktree-new", prepared: Prepared | null]>, Equal<Parameters<typeof ports.removeRegisteredWorktree>, [request: MultiCreationRequest, source: string, destination: string, receipt: Receipt]>, Equal<Parameters<typeof ports.quarantineCopiedEntry>, [request: MultiCreationRequest, destination: string, identity: Copied]>] = [true, true, true, true, true, true, true, true, true];
    const addition: WorktreeAdditionPorts<Prepared, Receipt> = ports;
    const allRequired: Equal<RequiredKeys<typeof ports>, PortNames> = true;
    const noExtraNativePorts: Equal<keyof typeof ports, PortNames> = true;
    void [proof, addition, allRequired, noExtraNativePorts];
    entry.name = "changed"; entry.path = "changed"; entry.isGitRepo = false;
    result.workspacePath = "changed"; result.created = []; result.copied = [];
    result.created.push({ name: "name", branch: "branch", action: "worktree-new" });
    result.created[0].action = "worktree-existing"; result.copied.push("name");
    // @ts-expect-error All semantic effects must be supplied.
    createMultiWorkspaceCreation({});
    // @ts-expect-error No implicit native adapter.
    createMultiWorkspaceCreation();
    // @ts-expect-error Factory registration cannot be numeric, including zero.
    createMultiWorkspaceCreation<Prepared, number, Identity, Copied>(ports as never);
    // @ts-expect-error Factory registration cannot be boolean, including false.
    createMultiWorkspaceCreation<Prepared, boolean, Identity, Copied>(ports as never);
    // @ts-expect-error Factory copied identity cannot be numeric, including zero.
    createMultiWorkspaceCreation<Prepared, Receipt, Identity, number>(ports as never);
    // @ts-expect-error Factory copied identity cannot be boolean, including false.
    createMultiWorkspaceCreation<Prepared, Receipt, Identity, boolean>(ports as never);
    // @ts-expect-error Scan remains synchronous.
    createMultiWorkspaceCreation({ ...ports, scanSource: async () => [] });
    // @ts-expect-error Opaque workspace identity remains synchronous.
    createMultiWorkspaceCreation<Prepared, Receipt, Identity, Copied>({ ...ports, captureWorkspaceIdentity: async () => ({} as Identity) });
    // @ts-expect-error Opaque copy identity remains synchronous.
    createMultiWorkspaceCreation<Prepared, Receipt, Identity, Copied>({ ...ports, captureCopiedIdentity: async () => ({} as Copied) });
    // @ts-expect-error Registration must return declared opaque type.
    createMultiWorkspaceCreation<Prepared, Receipt, Identity, Copied>({ ...ports, requireRegistration: () => ({}) });
    // @ts-expect-error Request is readonly.
    request.repositoryPath = "changed";
    // @ts-expect-error Request is mandatory.
    create();
    for (const name of ["observeBranch", "prepareAddition", "addPrepared", "compensateFailedAddition", "scanSource", "destinationPath", "ensureWorkspaceParent", "createWorkspaceExclusive", "captureWorkspaceIdentity", "requireRegistration", "pathExists", "worktreeMatches", "removeRegisteredWorktree", "rollbackCreatedBranch", "assertWorkspaceIdentity", "workspaceEntryCount", "quarantineWorkspace", "copyEntry", "captureCopiedIdentity", "quarantineCopiedEntry"] as const) {
        // @ts-expect-error Every semantic port is readonly.
        ports[name] = ports[name];
    }
    // @ts-expect-error Native fence details are not application requirements.
    ports.nativeRegistrationFence;
    // @ts-expect-error Prepared remains opaque.
    ports.prepareAddition({ ...request, failureContext: { kind: "multi-repo", repositoryName: "name" } }, "worktree-new").expectedBranchOid;
}
void contracts;
type InvalidProofDeclarations = [NumericRegistration, BooleanRegistration, NumericCopiedIdentity, BooleanCopiedIdentity];
const invalidDeclarationNames: keyof InvalidProofDeclarations = "length";
void invalidDeclarationNames;

describe("multi creation generic and mutable legacy type contracts", () => {
    it("uses four unrelated symbol identities without native fence fields", () => {
        const prepared = Symbol("prepared"), receipt = Symbol("receipt"), workspace = Symbol("workspace"), copied = Symbol("copied");
        const result: LegacyResult = createMultiWorkspaceCreation({
            observeBranch: () => "none", prepareAddition: () => prepared,
            addPrepared: () => ({ status: 0, registrationReceipt: receipt }), compensateFailedAddition: () => {},
            scanSource: () => [{ name: "repo", path: "source/repo", isGitRepo: true }], destinationPath: (_request, name) => `destination/${name}`,
            ensureWorkspaceParent: () => {}, createWorkspaceExclusive: () => {}, captureWorkspaceIdentity: () => workspace,
            requireRegistration: actual => { expect(actual).toBe(receipt); return receipt; }, pathExists: () => true, worktreeMatches: () => true,
            removeRegisteredWorktree: () => {}, rollbackCreatedBranch: () => {}, assertWorkspaceIdentity: () => {}, workspaceEntryCount: () => 0,
            quarantineWorkspace: () => {}, copyEntry: () => {}, captureCopiedIdentity: () => copied, quarantineCopiedEntry: () => {},
        })({ repositoryPath: "source", destinationPath: "destination", branch: "topic" });
        expect(result).toEqual({ workspacePath: "destination", created: [{ name: "repo", branch: "topic", action: "worktree-new" }], copied: [] });
    });
    it.each([
        { kind: "object", registration: Object.freeze({ marker: "registration" }), copy: Object.freeze({ marker: "copy" }) },
        { kind: "symbol", registration: Symbol("registration"), copy: Symbol("copy") },
    ])("compensates $kind proof values by exact identity in repo-then-copy order", ({ registration, copy }) => {
        const trace: string[] = [];
        const original = new Error("failed final copy");
        const existing = new Set(["destination/repo"]);
        // Prepared and workspace identity deliberately remain unrestricted.
        const ports: MultiCreationPorts<number, typeof registration, boolean, typeof copy> = {
            observeBranch: () => "none", prepareAddition: () => 0,
            addPrepared: (_request, prepared) => { expect(prepared).toBe(0); return { status: 0, registrationReceipt: registration }; },
            compensateFailedAddition: () => { throw new Error("Unexpected addition failure"); },
            scanSource: () => [
                { name: "repo", path: "source/repo", isGitRepo: true },
                { name: "copied", path: "source/copied", isGitRepo: false },
                { name: "failed", path: "source/failed", isGitRepo: false },
            ],
            destinationPath: (_request, name) => `destination/${name}`,
            ensureWorkspaceParent: () => {}, createWorkspaceExclusive: () => {}, captureWorkspaceIdentity: () => false,
            requireRegistration: value => { expect(value).toBe(registration); return registration; },
            pathExists: path => existing.has(path),
            worktreeMatches: () => { throw new Error("Reverse cleanup must not add forward matching checks"); },
            removeRegisteredWorktree: (_request, source, destination, proof) => {
                expect(source).toBe("source/repo"); expect(destination).toBe("destination/repo"); expect(proof).toBe(registration);
                trace.push("remove-repo"); existing.delete(destination);
            },
            rollbackCreatedBranch: (source, branch, action, prepared) => {
                expect(source).toBe("source/repo"); expect(branch).toBe("topic"); expect(action).toBe("worktree-new"); expect(prepared).toBe(0);
                trace.push("branch");
            },
            copyEntry: (source, destination) => { if (source === "source/failed") throw original; existing.add(destination); },
            captureCopiedIdentity: destination => { expect(destination).toBe("destination/copied"); return copy; },
            quarantineCopiedEntry: (_request, destination, proof) => {
                expect(destination).toBe("destination/copied"); expect(proof).toBe(copy); trace.push("remove-copy"); existing.delete(destination);
            },
            assertWorkspaceIdentity: (_request, identity) => { expect(identity).toBe(false); trace.push("assert-workspace"); },
            workspaceEntryCount: () => { trace.push("count"); return existing.size; },
            quarantineWorkspace: (_request, identity) => { expect(identity).toBe(false); trace.push("remove-workspace"); },
        };
        let caught: unknown;
        try { createMultiWorkspaceCreation(ports)({ repositoryPath: "source", destinationPath: "destination", branch: "topic" }); }
        catch (error) { caught = error; }
        expect(caught).toBe(original);
        expect(trace).toEqual(["remove-repo", "branch", "remove-copy", "assert-workspace", "count", "remove-workspace"]);
    });
});
