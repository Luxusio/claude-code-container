import { describe, expect, it } from "vitest";
import { createBrokenWorkspaceRepair } from "../../application/workspace/repair-broken.js";
import type { BrokenWorkspaceRepairPorts } from "../../ports/workspace/repair-broken.js";
import type { WorkspaceRepairAuthority } from "../../domain/workspace/repair-authority.js";
import type { WorktreeRepoResult } from "../../domain/workspace/creation-result.js";

function contracts(ports: BrokenWorkspaceRepairPorts<WorkspaceRepairAuthority>) {
    const result: WorktreeRepoResult | null = createBrokenWorkspaceRepair(ports).fixBrokenWorktreeSanitized("source", "workspace", "repo", "branch", true, {});
    if (result) result.name = "mutable";
    // @ts-expect-error No ambient native defaults.
    createBrokenWorkspaceRepair();
    // @ts-expect-error Compensation capability is required.
    createBrokenWorkspaceRepair({ ...ports, rollbackQuarantinedPath: undefined });
    // @ts-expect-error Preserved-content observation is synchronous.
    createBrokenWorkspaceRepair({ ...ports, readDirectoryEntries: async () => [] });
    // @ts-expect-error Confirmation remains boolean.
    createBrokenWorkspaceRepair(ports).fixBrokenWorktreeSanitized("source", "workspace", "repo", "branch", "yes", {});
    // @ts-expect-error Repair retains its synchronous result.
    const pending: Promise<WorktreeRepoResult | null> = result;
    void pending;
}
void contracts;
describe("broken repair compile contracts", () => { it("requires explicit scoped native capabilities", () => { expect(createBrokenWorkspaceRepair.length).toBe(1); }); });
