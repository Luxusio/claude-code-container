// Checked by the normal strict architecture compiler; never invoked.
import { createWorkspaceRemoval } from "../../application/workspace/cli-removal.js";
import type { WorkspaceCliRemovalPorts, WorkspaceCliContainerIdentity, WorkspaceCliContainerRuntime } from "../../ports/workspace/cli-removal.js";
import type { RemoveResult, WorkspaceRemovalRequest, WorkspaceRemovalOutcome, WorkspaceRemovalProgress, WorkspaceStrandedRegistration } from "../../domain/workspace/removal-result.js";
import {removeWorkspaceThenContainers,prepareWorkspaceContainerRemovalPlan,removePreparedWorkspaceContainers,workspaceRemovalCompleted,withWorkspaceRemovalLifecycleLock} from "../../index.js";
import type {WorkspaceContainerRemoval} from "../../index.js";

function contracts(ports: WorkspaceCliRemovalPorts) {
    const operation: (request: WorkspaceRemovalRequest) => WorkspaceRemovalOutcome = createWorkspaceRemoval(ports);
    const request: WorkspaceRemovalRequest = { sourcePath: "source", branch: "branch", force: false };
    const result: WorkspaceRemovalOutcome = operation(request);
    void result;
    // @ts-expect-error Native composition is mandatory.
    createWorkspaceRemoval();
    // @ts-expect-error Source identity must bind before callbacks can change relative context.
    createWorkspaceRemoval({ ...ports, resolveSource: undefined });
    // @ts-expect-error Source binding remains synchronous.
    createWorkspaceRemoval({ ...ports, resolveSource: async source => source });
    // @ts-expect-error Family guard selection is mandatory.
    createWorkspaceRemoval({ ...ports, selectFamilyLock: undefined });
    // @ts-expect-error Claims cannot be replaced by a whole removal workflow.
    createWorkspaceRemoval({ ...ports, selectClaims: undefined });
    // @ts-expect-error Runtime readiness remains synchronous.
    createWorkspaceRemoval({ ...ports, selectRuntimeReadiness: async () => () => undefined });
    // @ts-expect-error A selected readiness effect cannot settle asynchronously.
    createWorkspaceRemoval({ ...ports, selectRuntimeReadiness: () => async () => undefined });
    // @ts-expect-error A selected ownership assertion cannot settle asynchronously.
    createWorkspaceRemoval({ ...ports, selectOwnershipAssertion: () => async () => undefined });
    // @ts-expect-error Semantic publication is required.
    createWorkspaceRemoval({ ...ports, publish: undefined });
    // @ts-expect-error A progress observer cannot settle asynchronously.
    createWorkspaceRemoval({ ...ports, publish: async () => undefined });
    // @ts-expect-error Publication must return undefined, not a general void capability.
    createWorkspaceRemoval({ ...ports, publish: (() => {}) as () => void });
    // @ts-expect-error Console selection is not an inward capability.
    createWorkspaceRemoval({ ...ports, selectLog: () => () => undefined });
    // @ts-expect-error Error rendering is not an inward capability.
    createWorkspaceRemoval({ ...ports, selectError: () => () => undefined });
    // @ts-expect-error Process termination is not an inward capability.
    createWorkspaceRemoval({ ...ports, selectExit: () => () => { throw new Error("exit"); } });
    // @ts-expect-error Terminal escaping belongs to the CLI.
    createWorkspaceRemoval({ ...ports, selectTerminalSafeLiteral: () => (text: string) => text });
    // @ts-expect-error Shell remedy construction belongs to the CLI.
    createWorkspaceRemoval({ ...ports, selectPasteableArgument: () => (text: string) => text });
    // @ts-expect-error Workspace removal remains a synchronous canonical result.
    createWorkspaceRemoval({ ...ports, selectRemoveWorkspace: () => async () => ({ removed: [], errors: [] }) });
    // @ts-expect-error Identity is inspected synchronously before workspace deletion.
    createWorkspaceRemoval({ ...ports, selectManagedIdentity: () => async () => null });
    const runtime: WorkspaceCliContainerRuntime = ports.selectContainerRuntime();
    // @ts-expect-error Runtime selection cannot settle asynchronously.
    createWorkspaceRemoval({ ...ports, selectContainerRuntime: async () => runtime });
    // @ts-expect-error Listing returns normalized facts synchronously, never a Promise.
    createWorkspaceRemoval({ ...ports, selectContainerRuntime: () => ({ ...runtime, listNames: async () => ({ kind: "listed", names: [] }) }) });
    // @ts-expect-error A stop effect must settle synchronously.
    createWorkspaceRemoval({ ...ports, selectContainerRuntime: () => ({ ...runtime, stop: async () => undefined }) });
    // @ts-expect-error A remove effect must settle synchronously.
    createWorkspaceRemoval({ ...ports, selectContainerRuntime: () => ({ ...runtime, remove: async () => undefined }) });
    // @ts-expect-error Native runners cannot replace semantic container operations.
    createWorkspaceRemoval({ ...ports, selectContainerRuntime: () => (_command: string, _args: string[]) => ({ status: 0 }) });
    // @ts-expect-error Native receipts cannot replace normalized inventory facts.
    createWorkspaceRemoval({ ...ports, selectContainerRuntime: () => ({ ...runtime, listNames: () => ({ status: 0, stdout: "base" }) }) });
    // @ts-expect-error Listing is required even when cleanup effects are supplied.
    createWorkspaceRemoval({ ...ports, selectContainerRuntime: () => ({ stop: runtime.stop, remove: runtime.remove }) });
    // @ts-expect-error Stop is required even if a particular plan contains stopped targets.
    createWorkspaceRemoval({ ...ports, selectContainerRuntime: () => ({ listNames: runtime.listNames, remove: runtime.remove }) });
    // @ts-expect-error Remove is required alongside listing and stop.
    createWorkspaceRemoval({ ...ports, selectContainerRuntime: () => ({ listNames: runtime.listNames, stop: runtime.stop }) });
    // @ts-expect-error A raw runner is no longer an inward port.
    createWorkspaceRemoval({ ...ports, selectRunner: () => () => ({ status: 0 }) });
    // @ts-expect-error Runtime command selection stays in native composition.
    createWorkspaceRemoval({ ...ports, selectRuntimeCli: () => () => "docker" });
    // @ts-expect-error Ownership admission is literally true.
    ports.selectOwnershipAssertion()("workspace", "branch", "source", { allowTrackedGitlinks: false });
    // @ts-expect-error Force keeps its public boolean signature.
    operation({ sourcePath: "source", branch: "branch", force: "truthy" });
    // @ts-expect-error Callers cannot inject an unrelated lock identity.
    operation({ ...request, projectId: "foreign-project" });
    // @ts-expect-error Callers cannot inject an unrelated workspace path.
    operation({ ...request, workspacePath: "foreign-workspace" });
    // @ts-expect-error The explicit source path is required.
    operation({ branch: "branch", force: false });
    // @ts-expect-error Opaque native workflows do not implement the semantic ports.
    createWorkspaceRemoval({ runNativeWorkflow: operation });
    const identity: WorkspaceCliContainerIdentity = { containerId: "id", running: true };
    void identity;

    void [operation, result, identity, request];
}
void contracts;

function outcomeContracts(outcome: WorkspaceRemovalOutcome, progress: WorkspaceRemovalProgress) {
    const result: RemoveResult | null = outcome.result;
    switch (outcome.kind) {
        case "removed": {
            const original: RemoveResult = outcome.result;
            const containers: readonly string[] = outcome.removedContainers;
            const stranded: readonly WorkspaceStrandedRegistration[] = outcome.stranded;
            void [original, containers, stranded];
            break;
        }
        case "incomplete": {
            const original: RemoveResult = outcome.result;
            // @ts-expect-error An incomplete workspace result grants no container cleanup facts.
            void outcome.removedContainers;
            void original;
            break;
        }
        case "failed": {
            const error: unknown = outcome.error;
            const original: RemoveResult | null = outcome.result;
            // @ts-expect-error Native failures remain opaque until the caller narrows them.
            const rendered: string = outcome.error;
            void [error, original, rendered];
            break;
        }
        default: {
            const exhaustive: never = outcome;
            void exhaustive;
        }
    }
    switch (progress.kind) {
        case "started": {
            const branch: string = progress.branch;
            void branch;
            break;
        }
        case "containers-removed":
            // @ts-expect-error Progress arrays do not carry writable control authority.
            progress.names.push("another");
            break;
        case "result":
            // @ts-expect-error Progress cannot mutate the native removed rows.
            progress.removed.push("another");
            // @ts-expect-error Progress cannot mutate the native error rows.
            progress.errors.push("another");
            break;
        case "incomplete":
            // @ts-expect-error Summary arrays remain readonly.
            progress.removed.push("another");
            break;
        case "removed": break;
        default: {
            const exhaustive: never = progress;
            void exhaustive;
        }
    }
    void result;
}
void outcomeContracts;
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
