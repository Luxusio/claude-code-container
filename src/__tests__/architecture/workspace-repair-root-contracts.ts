import { createRootWorkspaceRepair } from "../../application/workspace/repair-root.js";
import type { RootWorkspaceRepairPorts } from "../../ports/workspace/repair-root.js";
import type { WorkspaceRepairAuthority, WorkspaceRepairGitObservation, WorkspaceRepairBranchHeadObservation } from "../../domain/workspace/repair-authority.js";

function contracts(ports: RootWorkspaceRepairPorts<WorkspaceRepairAuthority>) {
    const result: boolean = createRootWorkspaceRepair(ports).handleWorkspaceRootOwnership("workspace", "source", "branch", "inspect");
    // @ts-expect-error Recovery cannot select production defaults.
    createRootWorkspaceRepair();
    // @ts-expect-error Exact publication/rollback capability is required.
    createRootWorkspaceRepair({ ...ports, restoreMetadata: undefined });
    const completion: WorkspaceRepairGitObservation = { succeeded: true };
    const head: WorkspaceRepairBranchHeadObservation = { succeeded: true, oid: "opaque-object-id" };
    const snapshot: object = ports.captureMetadata("workspace/.git");
    const publication: object = ports.publishWorktreeBackpointer("management/gitdir", "workspace/.git", {} as WorkspaceRepairAuthority["DirectoryIdentity"], snapshot);
    ports.restoreMetadata("management/gitdir", snapshot, publication);
    // @ts-expect-error Raw Git process framing cannot cross the semantic port.
    const rawCompletion: WorkspaceRepairGitObservation = { status: 0, stdout: "oid" };
    // @ts-expect-error Branch-head observations require the classified OID.
    const rawHead: WorkspaceRepairBranchHeadObservation = { succeeded: true, stdout: "oid" };
    void [completion, head, rawCompletion, rawHead];
    // @ts-expect-error Native observation remains synchronous.
    createRootWorkspaceRepair({ ...ports, pathExistsStrict: async () => false });
    // @ts-expect-error Inspection does not return a Promise.
    const pending: Promise<boolean> = result;
    // @ts-expect-error Modes retain their existing exact values.
    createRootWorkspaceRepair(ports).handleWorkspaceRootOwnership("workspace", "source", "branch", "force");
    void pending;
}
void contracts;
