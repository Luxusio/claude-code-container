import { describe, expect, it } from "vitest";
import { createNestedWorkspaceRepair } from "../../application/workspace/repair-nested.js";
import type { NestedWorkspaceRepairPorts } from "../../ports/workspace/repair-nested.js";
import type { WorkspaceRepairAuthority, WorkspaceRepairGitObservation } from "../../domain/workspace/repair-authority.js";
import type { WorktreeRepoResult } from "../../domain/workspace/creation-result.js";

function contracts(ports: NestedWorkspaceRepairPorts<WorkspaceRepairAuthority>) {
    const completion: WorkspaceRepairGitObservation = { succeeded: false, failureReason: "classified failure" };
    const add: ReturnType<typeof ports.runPreparedWorktreeAdd> = { result: completion, registrationFence: null };
    // @ts-expect-error Native process framing must be classified by the binding.
    const raw: ReturnType<typeof ports.runPreparedWorktreeAdd> = { result: { status: 0, stdout: "", stderr: "" }, registrationFence: null };
    void [add, raw];
    const repaired: WorktreeRepoResult[] = createNestedWorkspaceRepair(ports).repairWorkspace("source", "workspace", "branch");
    repaired.push({ name: "mutable", branch: "branch", action: "worktree-new" });
    // @ts-expect-error No production native defaults.
    createNestedWorkspaceRepair();
    // @ts-expect-error Required source authority cannot be missing.
    createNestedWorkspaceRepair({ ...ports, captureNestedRepositoryIdentity: undefined });
    // @ts-expect-error Inventory remains synchronous.
    createNestedWorkspaceRepair({ ...ports, scanUnifiedNestedRepositories: async () => [] });
    // @ts-expect-error Public repair remains synchronous.
    const pending: Promise<WorktreeRepoResult[]> = createNestedWorkspaceRepair(ports).repairWorkspace("source", "workspace", "branch");
    void pending;
}
void contracts;
describe("nested repair compile contract", () => { it("requires explicit native authority ports", () => { expect(createNestedWorkspaceRepair.length).toBe(1); }); });
