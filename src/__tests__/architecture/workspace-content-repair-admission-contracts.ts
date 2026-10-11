// Checked by the normal strict architecture compiler; never invoked.
import { createWorkspaceContentRepairAdmission } from "../../application/workspace/content-repair-admission.js";
import type { WorkspaceContentRepairAdmissionPorts, WorkspaceContentRepairConflict } from "../../ports/workspace/content-repair-admission.js";

function contracts(ports: WorkspaceContentRepairAdmissionPorts) {
    const operation: (cwd: string, wsPath: string, name: string, branch: string) => Promise<void> = createWorkspaceContentRepairAdmission(ports);
    const result: Promise<void> = operation("source", "workspace", "repo", "branch");
    void result;
    // @ts-expect-error Native defaults are not an application composition.
    createWorkspaceContentRepairAdmission();
    // @ts-expect-error Repair capability is mandatory.
    createWorkspaceContentRepairAdmission({ ...ports, repairConfirmed: undefined });
    // @ts-expect-error Fixed native classification capability is mandatory.
    createWorkspaceContentRepairAdmission({ ...ports, isContentConflict: undefined });
    // @ts-expect-error Native relative selection is mandatory.
    createWorkspaceContentRepairAdmission({ ...ports, selectRelative: undefined });
    // @ts-expect-error Native console selection is mandatory.
    createWorkspaceContentRepairAdmission({ ...ports, selectLog: undefined });
    // @ts-expect-error Native prompt is mandatory.
    createWorkspaceContentRepairAdmission({ ...ports, prompt: undefined });
    // @ts-expect-error Native quarantine selection is mandatory.
    createWorkspaceContentRepairAdmission({ ...ports, selectSetAside: undefined });
    // @ts-expect-error Synchronous initial repair must not become an async operation.
    createWorkspaceContentRepairAdmission({ ...ports, repairConfirmed: async () => null });
    // @ts-expect-error Log callee selection occurs synchronously.
    createWorkspaceContentRepairAdmission({ ...ports, selectLog: async () => () => undefined });
    // @ts-expect-error Relative callee selection occurs synchronously.
    createWorkspaceContentRepairAdmission({ ...ports, selectRelative: async () => (root: string, path: string) => root + path });
    // @ts-expect-error Set-aside callee selection occurs synchronously.
    createWorkspaceContentRepairAdmission({ ...ports, selectSetAside: async () => () => "backup" });
    // @ts-expect-error Native relative operation is synchronous.
    createWorkspaceContentRepairAdmission({ ...ports, selectRelative: () => async () => "relative" });
    // @ts-expect-error Native quarantine returns a saved path synchronously.
    createWorkspaceContentRepairAdmission({ ...ports, selectSetAside: () => async () => "backup" });
    // @ts-expect-error Prompt retains asynchronous settlement.
    createWorkspaceContentRepairAdmission({ ...ports, prompt: () => "yes" });
    // @ts-expect-error Native repair authorization is literal true.
    ports.repairConfirmed("source", "workspace", "repo", "branch", false);
    // @ts-expect-error Prompt normalization is literal true.
    ports.prompt("question", false);
    // @ts-expect-error Operation arguments remain strings.
    operation("source", "workspace", 1, "branch");
    // @ts-expect-error Whole native workflow callback cannot substitute semantic ports.
    createWorkspaceContentRepairAdmission({ runNativeWorkflow: operation });
    // @ts-expect-error Application outcome is asynchronous void, not a native repair result.
    const synchronous: null = operation("source", "workspace", "repo", "branch");
    void synchronous;
    const conflict: WorkspaceContentRepairConflict = { worktreeRoot: "root", conflicts: ["file"] };
    // @ts-expect-error A readonly native conflict reference cannot be mutated by core.
    conflict.conflicts.push("second");

    void [operation, result, synchronous, conflict];
}
void contracts;
