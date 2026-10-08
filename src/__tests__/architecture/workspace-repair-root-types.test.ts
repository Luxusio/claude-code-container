import { describe, expect, it } from "vitest";
import { createRootWorkspaceRepair } from "../../application/workspace/repair-root.js";
import type { RootWorkspaceRepairPorts } from "../../ports/workspace/repair-root.js";
import type { WorkspaceRepairAuthority } from "../../domain/workspace/repair-authority.js";

function contracts(ports: RootWorkspaceRepairPorts<WorkspaceRepairAuthority>) {
    const result: boolean = createRootWorkspaceRepair(ports).handleWorkspaceRootOwnership("workspace", "source", "branch", "inspect");
    // @ts-expect-error Recovery cannot select production defaults.
    createRootWorkspaceRepair();
    // @ts-expect-error Exact publication/rollback capability is required.
    createRootWorkspaceRepair({ ...ports, normalizeWorktreeMetadataFile: undefined });
    // @ts-expect-error Native observation remains synchronous.
    createRootWorkspaceRepair({ ...ports, pathExistsStrict: async () => false });
    // @ts-expect-error Inspection does not return a Promise.
    const pending: Promise<boolean> = result;
    // @ts-expect-error Modes retain their existing exact values.
    createRootWorkspaceRepair(ports).handleWorkspaceRootOwnership("workspace", "source", "branch", "force");
    void pending;
}
void contracts;
describe("root repair compile contracts", () => { it("requires explicit native receipts and operations", () => { expect(createRootWorkspaceRepair.length).toBe(1); }); });
