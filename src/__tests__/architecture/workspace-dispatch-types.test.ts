import { describe, expect, it } from "vitest";
import { createWorkspaceCreationDispatch, createWorkspaceRemovalDispatch } from "../../application/workspace/dispatch.js";
import type { WorkspaceCreationDispatchPorts, WorkspaceRemovalDispatchPorts } from "../../ports/workspace/dispatch.js";
import type { WorktreeResult } from "../../domain/workspace/creation-result.js";
import type { RemoveResult } from "../../domain/workspace/removal-result.js";

function contracts(create: WorkspaceCreationDispatchPorts, remove: WorkspaceRemovalDispatchPorts<object, string>) {
    const made: WorktreeResult = createWorkspaceCreationDispatch(create).createWorkspace("source", "branch");
    const removed: RemoveResult = createWorkspaceRemovalDispatch(remove).removeWorkspace("source", "branch", { force: true });
    made.created.push({ name: "repo", branch: "branch", action: "worktree-new" }); removed.errors.push("mutable");
    // @ts-expect-error Required creation effects have no native defaults.
    createWorkspaceCreationDispatch();
    // @ts-expect-error Required removal effects have no native defaults.
    createWorkspaceRemovalDispatch();
    // @ts-expect-error Selected callee is required.
    createWorkspaceCreationDispatch({ ...create, createMulti: undefined });
    // @ts-expect-error Native identity observation stays synchronous.
    createWorkspaceRemovalDispatch({ ...remove, destinationExists: async () => true });
    // @ts-expect-error Branch must remain a string.
    createWorkspaceCreationDispatch(create).createWorkspace("source", 1);
    // @ts-expect-error Admission remains synchronous.
    const pending: Promise<RemoveResult> = createWorkspaceRemovalDispatch(remove).removeWorkspace("source", "branch");
    void pending;
}
void contracts;

describe("workspace admission compile contract", () => {
    it("declares no ambient executor defaults", () => { expect(createWorkspaceCreationDispatch.length).toBe(1); expect(createWorkspaceRemovalDispatch.length).toBe(1); });
});
