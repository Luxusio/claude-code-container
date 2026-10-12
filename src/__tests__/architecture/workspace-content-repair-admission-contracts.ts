// Checked by the normal strict architecture compiler; never invoked.
import { createWorkspaceContentRepairAdmission } from "../../application/workspace/content-repair-admission.js";
import type { WorkspaceContentRepairAdmissionPorts, WorkspaceContentRepairConflict } from "../../ports/workspace/content-repair-admission.js";

function contracts(ports: WorkspaceContentRepairAdmissionPorts) {
    const operation: (cwd: string, wsPath: string, name: string, branch: string) => Promise<void> = createWorkspaceContentRepairAdmission(ports);
    // @ts-expect-error Native defaults are not an application composition.
    createWorkspaceContentRepairAdmission();
    // @ts-expect-error Repair capability is mandatory.
    createWorkspaceContentRepairAdmission({ ...ports, repairConfirmed: undefined });
    // @ts-expect-error Native classification capability is mandatory.
    createWorkspaceContentRepairAdmission({ ...ports, isContentConflict: undefined });
    // @ts-expect-error Semantic reporting is mandatory.
    createWorkspaceContentRepairAdmission({ ...ports, report: undefined });
    // @ts-expect-error Confirmation is mandatory.
    createWorkspaceContentRepairAdmission({ ...ports, confirmConflictRepair: undefined });
    // @ts-expect-error Set-aside capability is mandatory.
    createWorkspaceContentRepairAdmission({ ...ports, setAsideConflicts: undefined });
    // @ts-expect-error Initial repair is synchronous.
    createWorkspaceContentRepairAdmission({ ...ports, repairConfirmed: async () => null });
    // @ts-expect-error Confirmation settles asynchronously.
    createWorkspaceContentRepairAdmission({ ...ports, confirmConflictRepair: () => true });
    // @ts-expect-error Native adapter normalizes text to boolean.
    createWorkspaceContentRepairAdmission({ ...ports, confirmConflictRepair: async () => "yes" });
    // @ts-expect-error Set-aside returns its saved path synchronously.
    createWorkspaceContentRepairAdmission({ ...ports, setAsideConflicts: async () => "backup" });
    // @ts-expect-error Native repair authorization is literal true.
    ports.repairConfirmed("source", "workspace", "repo", "branch", false);
    // @ts-expect-error Whole workflows cannot substitute finite ports.
    createWorkspaceContentRepairAdmission({ runNativeWorkflow: operation });
    const conflict: WorkspaceContentRepairConflict = { worktreeRoot: "root", conflicts: ["file"] };
    // @ts-expect-error Core cannot mutate the native conflict list.
    conflict.conflicts.push("second");
    ports.report({ kind: "retry-failure", name: "repo", cause: conflict, preserved: "backup" });
    // @ts-expect-error Retry failure retains the saved location.
    ports.report({ kind: "retry-failure", name: "repo", cause: conflict });
    // @ts-expect-error Reports are a finite semantic union.
    ports.report({ kind: "log", message: "native text" });
    void operation;
}
void contracts;
