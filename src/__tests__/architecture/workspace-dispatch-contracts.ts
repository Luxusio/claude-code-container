import { createWorkspaceCreationDispatch, createWorkspaceRemovalDispatch } from "../../application/workspace/dispatch.js";
import type { WorkspaceCreationDispatchPorts, WorkspaceRemovalDispatchPorts } from "../../ports/workspace/dispatch.js";
import type { WorktreeResult } from "../../domain/workspace/creation-result.js";

function contracts(create: WorkspaceCreationDispatchPorts, remove: WorkspaceRemovalDispatchPorts<object, { entries: number }, { receipt: symbol }>) {
    const made: WorktreeResult = createWorkspaceCreationDispatch(create).createWorkspace("source", "branch");
    const outcome = createWorkspaceRemovalDispatch(remove).removeWorkspace("source", "branch", { force: true });
    void made;
    switch (outcome.kind) {
        case "missing": { const path: string = outcome.destinationPath; void path; break; }
        case "unmanaged": { const content: number = outcome.paths[0].content.entries; void content; break; }
        case "dispatched": { const receipt: symbol = outcome.result.receipt; void receipt; break; }
        default: { const exhaustive: never = outcome; void exhaustive; }
    }
    // @ts-expect-error Required creation effects have no native defaults.
    createWorkspaceCreationDispatch();
    // @ts-expect-error Required removal effects have no native defaults.
    createWorkspaceRemovalDispatch();
    // @ts-expect-error Selected callee is required.
    createWorkspaceCreationDispatch({ ...create, createMulti: undefined });
    // @ts-expect-error Selected removal capability is required.
    createWorkspaceRemovalDispatch({ ...remove, removeMulti: undefined });
    // @ts-expect-error Destination observation stays synchronous.
    createWorkspaceRemovalDispatch({ ...remove, destinationExists: async () => true });
    // @ts-expect-error Branch must remain a string.
    createWorkspaceCreationDispatch(create).createWorkspace("source", 1);
    // @ts-expect-error Admission remains synchronous.
    const pending: Promise<unknown> = createWorkspaceRemovalDispatch(remove).removeWorkspace("source", "branch");
    void pending;
}
void contracts;
