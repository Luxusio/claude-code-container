import type { WorktreeRepoResult } from "../../domain/workspace/creation-result.js";

/** The original native cause and its field references, narrowed by native recognition. */
export interface WorkspaceContentRepairConflict {
    readonly conflicts: readonly string[];
    readonly worktreeRoot: string;
}

export type WorkspaceContentRepairReport =
    | { kind: "outcome"; name: string; fixed: boolean; afterSetAside: boolean }
    | { kind: "failure"; name: string; cause: unknown }
    | { kind: "conflicts"; name: string; branch: string; cause: WorkspaceContentRepairConflict }
    | { kind: "refusal"; name: string }
    | { kind: "set-aside"; name: string; preserved: string }
    | { kind: "retry-failure"; name: string; cause: unknown; preserved: string };

export interface WorkspaceContentRepairAdmissionPorts {
    repairConfirmed(cwd: string, workspacePath: string, name: string, branch: string, confirmed: true): WorktreeRepoResult | null;
    isContentConflict(cause: unknown): cause is WorkspaceContentRepairConflict;
    report(event: WorkspaceContentRepairReport): void;
    confirmConflictRepair(): Promise<boolean>;
    setAsideConflicts(root: string, conflicts: readonly string[]): string;
}
