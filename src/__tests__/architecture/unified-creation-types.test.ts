import { describe, expect, it } from "vitest";
import { createUnifiedWorkspaceCreation } from "../../application/workspace/unified-creation.js";
import type { UnifiedCreationPorts, UnifiedCreationRequest } from "../../ports/workspace/unified-creation.js";
import type { UnifiedCreationPorts as ApplicationPorts, UnifiedCreationRequest as ApplicationRequest, WorktreeResult as ApplicationResult } from "../../application/workspace/unified-creation.js";
import type { WorktreeCreationAction, WorktreeRepoResult, WorktreeResult } from "../../domain/workspace/creation-result.js";
import type { WorktreeAdditionAction, WorktreeAdditionPorts } from "../../ports/workspace/worktree-addition.js";
import { createWorkspace } from "../../worktree.js";
import type { WorktreeRepoResult as LegacyRepoResult, WorktreeResult as LegacyResult } from "../../worktree.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Prepared = { readonly prepared: unique symbol };
type Receipt = { readonly receipt: unique symbol };
function contracts(ports: UnifiedCreationPorts<Prepared, Receipt>, request: UnifiedCreationRequest, result: WorktreeResult) {
    const create = createUnifiedWorkspaceCreation(ports);
    const proof: [
        Equal<ApplicationPorts<Prepared, Receipt>, UnifiedCreationPorts<Prepared, Receipt>>,
        Equal<ApplicationRequest, UnifiedCreationRequest>,
        Equal<ApplicationResult, WorktreeResult>,
        Equal<LegacyResult, WorktreeResult>,
        Equal<LegacyRepoResult, WorktreeRepoResult>,
        Equal<WorktreeAdditionAction, WorktreeCreationAction>,
        Equal<WorktreeCreationAction, "worktree-existing" | "worktree-remote" | "worktree-new">,
        Equal<Parameters<typeof create>, [request: UnifiedCreationRequest]>,
        Equal<ReturnType<typeof create>, WorktreeResult>,
        Equal<Parameters<typeof createWorkspace>, [sourcePath: string, branch: string]>,
        Equal<ReturnType<typeof createWorkspace>, WorktreeResult>,
        Equal<Parameters<typeof ports.requireRootRegistration>, [receipt: Receipt | null, request: UnifiedCreationRequest]>,
        Equal<ReturnType<typeof ports.requireRootRegistration>, Receipt>,
        Equal<ReturnType<typeof ports.repairNestedWorktrees>, WorktreeRepoResult[]>,
        Equal<Parameters<typeof ports.removeRegisteredRoot>, [request: UnifiedCreationRequest, registration: Receipt]>,
        Equal<Parameters<typeof ports.rollbackCreatedRootBranch>, [request: UnifiedCreationRequest, action: WorktreeCreationAction, prepared: Prepared]>,
    ] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true];
    void proof;
    const addition: WorktreeAdditionPorts<Prepared, Receipt> = ports;
    void addition;
    // All public legacy result fields and arrays remain mutable.
    result.workspacePath = "another path";
    result.created.push({ name: "another", branch: "another", action: "worktree-new" });
    result.created[0].name = "renamed";
    result.created[0].branch = "changed branch";
    result.created[0].action = "worktree-remote";
    result.created = [];
    result.copied.push("copied entry");
    result.copied = [];
    // @ts-expect-error The operation has no implicit native ports.
    createUnifiedWorkspaceCreation();
    // @ts-expect-error Every semantic port is required.
    createUnifiedWorkspaceCreation({});
    const { observeBranch: _observe, ...noObserve } = ports;
    const { prepareAddition: _prepare, ...noPrepare } = ports;
    const { addPrepared: _add, ...noAdd } = ports;
    const { compensateFailedAddition: _compensate, ...noCompensate } = ports;
    const { requireRootRegistration: _registration, ...noRegistration } = ports;
    const { sourceWorkspaceName: _name, ...noName } = ports;
    const { repairNestedWorktrees: _repair, ...noRepair } = ports;
    const { rootWorktreeMatches: _matches, ...noMatches } = ports;
    const { removeRegisteredRoot: _remove, ...noRemove } = ports;
    const { rollbackCreatedRootBranch: _rollback, ...noRollback } = ports;
    // @ts-expect-error Required addition observation.
    createUnifiedWorkspaceCreation(noObserve);
    // @ts-expect-error Required opaque preparation.
    createUnifiedWorkspaceCreation(noPrepare);
    // @ts-expect-error Required prepared addition.
    createUnifiedWorkspaceCreation(noAdd);
    // @ts-expect-error Required addition compensation.
    createUnifiedWorkspaceCreation(noCompensate);
    // @ts-expect-error Required registration validation.
    createUnifiedWorkspaceCreation(noRegistration);
    // @ts-expect-error Required name derivation.
    createUnifiedWorkspaceCreation(noName);
    // @ts-expect-error Required nested repair.
    createUnifiedWorkspaceCreation(noRepair);
    // @ts-expect-error Required ownership observation.
    createUnifiedWorkspaceCreation(noMatches);
    // @ts-expect-error Required registered root removal.
    createUnifiedWorkspaceCreation(noRemove);
    // @ts-expect-error Required branch rollback.
    createUnifiedWorkspaceCreation(noRollback);
    void [_observe, _prepare, _add, _compensate, _registration, _name, _repair, _matches, _remove, _rollback];
    // @ts-expect-error Observation must be synchronous.
    createUnifiedWorkspaceCreation({ ...ports, observeBranch: async () => "none" });
    // @ts-expect-error Opaque preparation cannot become a promise.
    createUnifiedWorkspaceCreation<Prepared, Receipt>({ ...ports, prepareAddition: async () => ports.prepareAddition({ ...request, failureContext: { kind: "unified" } }, "worktree-new") });
    // @ts-expect-error Receipt validation must return the declared opaque receipt.
    createUnifiedWorkspaceCreation<Prepared, Receipt>({ ...ports, requireRootRegistration: async () => ({} as Receipt) });
    // @ts-expect-error Name derivation must be synchronous.
    createUnifiedWorkspaceCreation({ ...ports, sourceWorkspaceName: async () => "name" });
    // @ts-expect-error Repair returns an array synchronously.
    createUnifiedWorkspaceCreation({ ...ports, repairNestedWorktrees: async () => [] });
    // @ts-expect-error Ownership must be observed synchronously.
    createUnifiedWorkspaceCreation({ ...ports, rootWorktreeMatches: async () => true });
    for (const name of ["observeBranch", "prepareAddition", "addPrepared", "compensateFailedAddition", "requireRootRegistration", "sourceWorkspaceName", "repairNestedWorktrees", "rootWorktreeMatches", "removeRegisteredRoot", "rollbackCreatedRootBranch"] as const) {
        // @ts-expect-error Ports are readonly, including native compensation methods.
        ports[name] = ports[name];
    }
    // @ts-expect-error Request fields remain readonly.
    request.branch = "mutated";
    // @ts-expect-error The synchronous operation requires a request.
    create();
    // @ts-expect-error No action outside the canonical union.
    const invalid: WorktreeCreationAction = "copy";
    // @ts-expect-error Public caller returns a result, never a promise.
    const asynchronous: Promise<WorktreeResult> = createWorkspace("source", "branch");
    void [invalid, asynchronous];
}
void contracts;

describe("unified creation opaque compile contracts", () => {
    it("supports non-native opaque values with no OID, inode or registration field requirements", () => {
        const prepared = Symbol("prepared");
        const receipt = Symbol("receipt");
        const create = createUnifiedWorkspaceCreation({
            observeBranch: () => "none",
            prepareAddition: () => prepared,
            addPrepared: () => ({ status: 0, registrationReceipt: receipt }),
            compensateFailedAddition: () => {},
            requireRootRegistration: value => { expect(value).toBe(receipt); return receipt; },
            sourceWorkspaceName: () => "source",
            repairNestedWorktrees: () => [],
            rootWorktreeMatches: () => true,
            removeRegisteredRoot: () => {},
            rollbackCreatedRootBranch: () => {},
        });
        const result: LegacyResult = create({ repositoryPath: "source", destinationPath: "destination", branch: "topic" });
        expect(result).toEqual({ workspacePath: "destination", created: [{ name: "source", branch: "topic", action: "worktree-new" }], copied: [] });
        expect(result).not.toHaveProperty("then");
    });
});
