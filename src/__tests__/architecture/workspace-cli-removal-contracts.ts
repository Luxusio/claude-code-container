// Checked by the normal strict architecture compiler; never invoked.
import { createWorkspaceCliRemoval } from "../../application/workspace/cli-removal.js";
import type { WorkspaceCliRemovalPorts, WorkspaceCliContainerIdentity, WorkspaceCliContainerRuntime } from "../../ports/workspace/cli-removal.js";
import {removeWorkspaceThenContainers,prepareWorkspaceContainerRemovalPlan,removePreparedWorkspaceContainers,workspaceRemovalCompleted,withWorkspaceRemovalLifecycleLock} from "../../index.js";
import type {WorkspaceContainerRemoval} from "../../index.js";

function contracts(ports: WorkspaceCliRemovalPorts) {
    const operation: (cwd: string, branch: string, force: boolean) => void = createWorkspaceCliRemoval(ports);
    const result: void = operation("source", "branch", false);
    void result;
    // @ts-expect-error Native composition is mandatory.
    createWorkspaceCliRemoval();
    // @ts-expect-error Family guard selection is mandatory.
    createWorkspaceCliRemoval({ ...ports, selectFamilyLock: undefined });
    // @ts-expect-error Claims cannot be replaced by a whole removal workflow.
    createWorkspaceCliRemoval({ ...ports, selectClaims: undefined });
    // @ts-expect-error Runtime readiness remains synchronous.
    createWorkspaceCliRemoval({ ...ports, selectRuntimeReadiness: async () => () => undefined });
    // @ts-expect-error A selected readiness effect cannot settle asynchronously.
    createWorkspaceCliRemoval({ ...ports, selectRuntimeReadiness: () => async () => undefined });
    // @ts-expect-error A selected ownership assertion cannot settle asynchronously.
    createWorkspaceCliRemoval({ ...ports, selectOwnershipAssertion: () => async () => undefined });
    // @ts-expect-error A selected console log effect cannot settle asynchronously.
    createWorkspaceCliRemoval({ ...ports, selectLog: () => async () => undefined });
    // @ts-expect-error A selected console error effect cannot settle asynchronously.
    createWorkspaceCliRemoval({ ...ports, selectError: () => async () => undefined });
    // @ts-expect-error Workspace removal remains a synchronous canonical result.
    createWorkspaceCliRemoval({ ...ports, selectRemoveWorkspace: () => async () => ({ removed: [], errors: [] }) });
    // @ts-expect-error Identity is inspected synchronously before workspace deletion.
    createWorkspaceCliRemoval({ ...ports, selectManagedIdentity: () => async () => null });
    const runtime: WorkspaceCliContainerRuntime = ports.selectContainerRuntime();
    // @ts-expect-error Runtime selection cannot settle asynchronously.
    createWorkspaceCliRemoval({ ...ports, selectContainerRuntime: async () => runtime });
    // @ts-expect-error Listing returns normalized facts synchronously, never a Promise.
    createWorkspaceCliRemoval({ ...ports, selectContainerRuntime: () => ({ ...runtime, listNames: async () => ({ kind: "listed", names: [] }) }) });
    // @ts-expect-error A stop effect must settle synchronously.
    createWorkspaceCliRemoval({ ...ports, selectContainerRuntime: () => ({ ...runtime, stop: async () => undefined }) });
    // @ts-expect-error A remove effect must settle synchronously.
    createWorkspaceCliRemoval({ ...ports, selectContainerRuntime: () => ({ ...runtime, remove: async () => undefined }) });
    // @ts-expect-error Native runners cannot replace semantic container operations.
    createWorkspaceCliRemoval({ ...ports, selectContainerRuntime: () => (_command: string, _args: string[]) => ({ status: 0 }) });
    // @ts-expect-error Native receipts cannot replace normalized inventory facts.
    createWorkspaceCliRemoval({ ...ports, selectContainerRuntime: () => ({ ...runtime, listNames: () => ({ status: 0, stdout: "base" }) }) });
    // @ts-expect-error Listing is required even when cleanup effects are supplied.
    createWorkspaceCliRemoval({ ...ports, selectContainerRuntime: () => ({ stop: runtime.stop, remove: runtime.remove }) });
    // @ts-expect-error Stop is required even if a particular plan contains stopped targets.
    createWorkspaceCliRemoval({ ...ports, selectContainerRuntime: () => ({ listNames: runtime.listNames, remove: runtime.remove }) });
    // @ts-expect-error Remove is required alongside listing and stop.
    createWorkspaceCliRemoval({ ...ports, selectContainerRuntime: () => ({ listNames: runtime.listNames, stop: runtime.stop }) });
    // @ts-expect-error A raw runner is no longer an inward port.
    createWorkspaceCliRemoval({ ...ports, selectRunner: () => () => ({ status: 0 }) });
    // @ts-expect-error Runtime command selection stays in native composition.
    createWorkspaceCliRemoval({ ...ports, selectRuntimeCli: () => () => "docker" });
    // @ts-expect-error Console selection occurs synchronously before coercion.
    createWorkspaceCliRemoval({ ...ports, selectLog: async () => () => undefined });
    // @ts-expect-error Native exit must not become a returning function.
    createWorkspaceCliRemoval({ ...ports, selectExit: () => () => undefined });
    // @ts-expect-error Ownership admission is literally true.
    ports.selectOwnershipAssertion()("workspace", "branch", "source", { allowTrackedGitlinks: false });
    // @ts-expect-error Force keeps its public boolean signature.
    operation("source", "branch", "truthy");
    // @ts-expect-error Opaque native workflows do not implement the semantic ports.
    createWorkspaceCliRemoval({ runNativeWorkflow: operation });
    const identity: WorkspaceCliContainerIdentity = { containerId: "id", running: true };
    void identity;

    void [operation, result, identity];
}
void contracts;
function publicContracts() {
    const value={errors: [] as string[],extra: 123};
    const completed=removeWorkspaceThenContainers(()=>value,()=>['container']);
    const same: typeof value = completed.result;
    const names: string[] = completed.removedContainers;
    const plan: WorkspaceContainerRemoval[] = prepareWorkspaceContainerRemovalPlan('workspace');
    const removals:string[]=removePreparedWorkspaceContainers(plan);
    const result:boolean=workspaceRemovalCompleted(value);
    const receipt: {exact:true}=withWorkspaceRemovalLifecycleLock('project',false,()=>({exact:true as const}));

    // @ts-expect-error child result is synchronous
    removeWorkspaceThenContainers(async()=>value,()=>[]);
    // @ts-expect-error container removals synchronous
    removeWorkspaceThenContainers(()=>value,async()=>[]);
    // @ts-expect-error force retains boolean public signature
    withWorkspaceRemovalLifecycleLock('project','truthy',()=>null);
    // @ts-expect-error workspacePath required
    prepareWorkspaceContainerRemovalPlan();
    // @ts-expect-error synchronous identity probe
    prepareWorkspaceContainerRemovalPlan('workspace',()=>[],async()=>null);
    // @ts-expect-error canonical errors field required
    workspaceRemovalCompleted({removed:[]});
    // @ts-expect-error readonly plan cannot be mutated
    const writable: WorkspaceContainerRemoval[] = [] as readonly WorkspaceContainerRemoval[];
    void writable;

    void [same, names, removals, result, receipt, value, completed, plan, writable];
}
void publicContracts;
