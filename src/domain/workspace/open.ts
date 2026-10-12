import type { WorktreeResult, WorktreeRepoResult } from "./creation-result.js";

export interface WorkspaceRegistrationRepair {
    readonly checkoutPath: string;
    readonly sourcePath: string;
}
export interface WorkspaceDamage {
    message: string;
    repairs: readonly WorkspaceRegistrationRepair[];
}
export interface WorkspaceRegistrationPreflight {
    assertUnchanged: (() => undefined) | undefined;
}
export type WorkspaceOpenOutcome =
    | { kind: "opened"; path: string }
    | { kind: "refused"; reason: "branch-collision"; actualBranch: string; branch: string }
    | { kind: "refused"; reason: "invalid-branch" | "submodule-initialization-failed" | "creation-failed"; error: unknown };

export type WorkspaceOpenConfirmation =
    | { purpose: "missing-registration" | "broken-content" | "initialize-submodules" }
    | { purpose: "damaged-registration"; repairCount: number };

export type WorkspaceOpenEvent =
    | { kind: "missing-registration"; error: unknown }
    | { kind: "registration-recreated" | "existing"; path: string }
    | { kind: "nested-repaired"; repo: WorktreeRepoResult }
    | { kind: "broken-content"; entries: { name: string }[] }
    | { kind: "submodule-candidates"; repos: string[] }
    | { kind: "submodules-initialized" }
    | { kind: "creating"; branch: string }
    | { kind: "created"; result: WorktreeResult }
    | { kind: "damaged-registration"; damage: WorkspaceDamage }
    | { kind: "registration-repair"; repair: WorkspaceRegistrationRepair; outcome: { ok: boolean; detail: string } };
