import { describe, expect, it } from "vitest";
import { createWorktreeAddition } from "../../application/workspace/worktree-addition.js";
import type { WorktreeAdditionAction, WorktreeAdditionObservation, WorktreeAdditionPorts, WorktreeAdditionRequest, WorktreeAdditionResult } from "../../ports/workspace/worktree-addition.js";
import type { WorktreeAdditionPorts as ApplicationPorts } from "../../application/workspace/worktree-addition.js";
import { createWorkspace } from "../../worktree.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Prepared = { readonly prepared: unique symbol };
type Receipt = { readonly receipt: unique symbol };
function contracts(ports: WorktreeAdditionPorts<Prepared, Receipt>, request: WorktreeAdditionRequest) {
    const add = createWorktreeAddition(ports);
    const proof: [
        Equal<ApplicationPorts<Prepared, Receipt>, WorktreeAdditionPorts<Prepared, Receipt>>,
        Equal<Parameters<typeof add>, [request: WorktreeAdditionRequest]>,
        Equal<ReturnType<typeof add>, WorktreeAdditionResult<Prepared, Receipt>>,
        Equal<ReturnType<typeof ports.observeBranch>, "local" | "remote" | "none">,
        Equal<ReturnType<typeof ports.prepareAddition>, Prepared>,
        Equal<ReturnType<typeof ports.addPrepared>, WorktreeAdditionObservation<Receipt>>,
        Equal<Parameters<typeof ports.compensateFailedAddition>, [request: WorktreeAdditionRequest, action: WorktreeAdditionAction, prepared: Prepared, registrationReceipt: Receipt | null]>,
        Equal<Parameters<typeof createWorkspace>, [sourcePath: string, branch: string]>,
    ] = [true, true, true, true, true, true, true, true];
    void proof;
    // @ts-expect-error All semantic ports are explicitly required.
    createWorktreeAddition();
    // @ts-expect-error No native implicit port defaults.
    createWorktreeAddition({});
    // @ts-expect-error Observation cannot be asynchronous.
    createWorktreeAddition({ ...ports, observeBranch: async () => "none" });
    // @ts-expect-error Preparation cannot replace the declared opaque type with a promise.
    createWorktreeAddition<Prepared, Receipt>({ ...ports, prepareAddition: async () => ports.prepareAddition(request, "worktree-new") });
    // @ts-expect-error Addition cannot return a promise.
    createWorktreeAddition({ ...ports, addPrepared: async () => ({ status: 0, registrationReceipt: null }) });
    // @ts-expect-error Compensation is required.
    createWorktreeAddition({ observeBranch: ports.observeBranch, prepareAddition: ports.prepareAddition, addPrepared: ports.addPrepared });
    // @ts-expect-error Semantic port properties are readonly.
    ports.observeBranch = () => "none";
    // @ts-expect-error Semantic port properties are readonly.
    ports.prepareAddition = () => ({} as Prepared);
    // @ts-expect-error Semantic port properties are readonly.
    ports.addPrepared = () => ({ status: 0, registrationReceipt: null });
    // @ts-expect-error Semantic port properties are readonly.
    ports.compensateFailedAddition = () => {};
    // @ts-expect-error The operation requires its request.
    add();
    // @ts-expect-error A multi-repo failure context requires the repository name.
    add({ ...request, failureContext: { kind: "multi-repo" } });
    // @ts-expect-error The public native facade remains synchronous.
    const asynchronous: Promise<unknown> = createWorkspace("source", "branch");
    void asynchronous;
}
void contracts;

describe("worktree addition compile contracts", () => {
    it("returns a synchronous callable with inferred opaque result types", () => {
        const prepared = { token: Symbol("prepared") };
        const receipt = { token: Symbol("receipt") };
        const add = createWorktreeAddition({ observeBranch: () => "none", prepareAddition: () => prepared, addPrepared: () => ({ status: 0, registrationReceipt: receipt }), compensateFailedAddition: () => {} });
        const result = add({ repositoryPath: "source", destinationPath: "destination", branch: "branch", failureContext: { kind: "unified" } });
        expect(result.prepared).toBe(prepared);
        expect(result.registrationReceipt).toBe(receipt);
        expect(result).not.toHaveProperty("then");
    });
});
