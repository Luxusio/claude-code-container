import type { WorktreeRepoResult } from "../../domain/workspace/creation-result.js";

/** The original native cause and its field references, narrowed by native recognition. */
export interface WorkspaceContentRepairConflict {
    readonly conflicts: readonly string[];
    readonly worktreeRoot: string;
}

export interface WorkspaceContentRepairAdmissionPorts {
    repairConfirmed(cwd: string, workspacePath: string, name: string, branch: string, confirmed: true): WorktreeRepoResult | null;
    isContentConflict(cause: unknown): cause is WorkspaceContentRepairConflict;
    /** Capture only this statement's native console method and receiver. */
    selectLog(): (message: string) => void;
    /** Capture the bare native callee before application argument evaluation. */
    selectRelative(): (root: string, path: string) => string;
    prompt(question: string, normalize: true): Promise<string>;
    /** Capture before the original cause's fields are read again after the prompt. */
    selectSetAside(): (root: string, conflicts: readonly string[]) => string;
}
