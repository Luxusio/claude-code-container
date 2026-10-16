import type { WorktreeResult, WorktreeRepoResult } from "../../domain/workspace/creation-result.js";
import type { WorkspaceDamage, WorkspaceRegistrationPreflight, WorkspaceRegistrationRepair, WorkspaceOpenConfirmation, WorkspaceOpenEvent } from "../../domain/workspace/open.js";
export interface WorkspaceOpenPorts {
    path(cwd: string, branch: string): string;
    projectId(path: string): string;
    family<T>(projectId: string, attempt: () => Promise<T>): Promise<T>;
    validateBranch(branch: string): undefined;
    exists(cwd: string, branch: string): boolean;
    hasGitMetadata(cwd: string): boolean;
    repairRoot(path: string, cwd: string, branch: string): undefined;
    assertOwner(path: string, cwd: string): undefined;
    missingRegistration(error: unknown): boolean;
    registrationPreflight(path: string, cwd: string, branch: string): WorkspaceRegistrationPreflight | null;
    recoverRegistration(path: string, cwd: string, branch: string, preflight: WorkspaceRegistrationPreflight): { repaired: boolean; failure?: string };
    recoveryError(path: string, failure?: string): Error;
    inspectWorkspace(path: string): undefined;
    assertWorkspace(path: string, cwd: string, allowTrackedGitlinks: boolean): undefined;
    repairNested(cwd: string, path: string, branch: string): WorktreeRepoResult[];
    broken(cwd: string, path: string): { name: string }[];
    repairContent(cwd: string, path: string, name: string, branch: string): Promise<void>;
    submoduleRepos(cwd: string): string[] | null;
    initSubmodules(cwd: string): undefined;
    create(cwd: string, branch: string): WorktreeResult;
    damage(error: unknown): WorkspaceDamage | null;
    repairRegistration(repair: WorkspaceRegistrationRepair): { ok: boolean; detail: string };
    confirm(request: WorkspaceOpenConfirmation): Promise<boolean>;
    report(event: WorkspaceOpenEvent): undefined;
}
