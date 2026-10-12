import type { WorkspaceContentRepairAdmissionPorts } from "../../ports/workspace/content-repair-admission.js";

export function createWorkspaceContentRepairAdmission(ports: WorkspaceContentRepairAdmissionPorts) {
    return async function repairBrokenWorktree(
        cwd: string,
        wsPath: string,
        name: string,
        branch: string,
    ): Promise<void> {
        try {
            const fixed = ports.repairConfirmed(cwd, wsPath, name, branch, true);
            ports.report({ kind: "outcome", name, fixed: Boolean(fixed), afterSetAside: false });
            return;
        } catch (error) {
            if (!ports.isContentConflict(error)) {
                ports.report({ kind: "failure", name, cause: error });
                return;
            }
            ports.report({ kind: "conflicts", name, branch, cause: error });
            if (!await ports.confirmConflictRepair()) {
                ports.report({ kind: "refusal", name });
                return;
            }
            const preserved = ports.setAsideConflicts(error.worktreeRoot, error.conflicts);
            ports.report({ kind: "set-aside", name, preserved });
            try {
                const fixed = ports.repairConfirmed(cwd, wsPath, name, branch, true);
                ports.report({ kind: "outcome", name, fixed: Boolean(fixed), afterSetAside: true });
            } catch (retryError) {
                ports.report({ kind: "retry-failure", name, cause: retryError, preserved });
            }
        }
    };
}
