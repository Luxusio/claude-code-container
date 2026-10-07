import { createContainerExistingLifecycle } from "../../application/container-existing-lifecycle.js";
import type {
    ContainerExistingLifecyclePorts, ContainerExistingLifecycleResult,
    ContainerReplacementRequest, ExistingContainerIdentity, ExistingContainerListing,
} from "../../ports/container-existing-lifecycle.js";

declare const ports: ContainerExistingLifecyclePorts;
const app = createContainerExistingLifecycle(ports);
const result: ContainerExistingLifecycleResult = app.run({ containerName: "name" });
const replaced: boolean = app.replace({ containerName: "name", reason: "changed" });
const request: ContainerReplacementRequest = {
    containerName: "name", reason: "changed", expectedContainerId: "pinned",
    initiallyRunningContainerId: "pinned", managedProjectPath: "/project", debug: false,
    replacementGuard: operation => { operation(); return true; }, onRecreate: () => {},
};
app.run(request);
const identity: ExistingContainerIdentity | null = ports.identity("name");
const listed: ExistingContainerListing = ports.listContainer("name");
const started: undefined = ports.start("pinned");
const inspected: boolean | null = ports.inspectContract("pinned", reason => { const text: string = reason; void text; });
if (result.kind === "joined") {
    const joinedId: string = result.containerId;
    void joinedId;
} else {
    // @ts-expect-error Creation continuation cannot expose a stale lifecycle ID.
    const staleId = result.containerId;
    void staleId;
}
const verifiedBeforeSetup: undefined = ports.verifyBeforeSetup("pinned");
void [replaced, identity, listed, started, inspected, verifiedBeforeSetup];

type Assert<T extends true> = T;
type EveryPortRequired = Assert<{
    [K in keyof ContainerExistingLifecyclePorts]: {} extends Pick<ContainerExistingLifecyclePorts, K> ? false : true
}[keyof ContainerExistingLifecyclePorts] extends true ? true : false>;
type AsyncPort<T extends (...args: never[]) => unknown> = (...args: Parameters<T>) => Promise<ReturnType<T>>;
type EveryPortSynchronous = Assert<{
    [K in keyof ContainerExistingLifecyclePorts]:
        AsyncPort<ContainerExistingLifecyclePorts[K]> extends ContainerExistingLifecyclePorts[K] ? false : true
}[keyof ContainerExistingLifecyclePorts] extends true ? true : false>;
const required: EveryPortRequired = true;
const synchronous: EveryPortSynchronous = true;
void [required, synchronous];

// @ts-expect-error No ambient effects are supplied.
createContainerExistingLifecycle();
// @ts-expect-error Explicit ports cannot be absent.
createContainerExistingLifecycle(undefined);
// @ts-expect-error Construction requires every observation and effect.
createContainerExistingLifecycle({ identity: ports.identity });
// @ts-expect-error Ports must be callable.
createContainerExistingLifecycle({ ...ports, remove: "rm" });
// @ts-expect-error Listing must be a structural known/ID fact, not a native status.
createContainerExistingLifecycle({ ...ports, listContainer: () => ({ status: 0 }) });
// @ts-expect-error Async identity is not a synchronous observation.
createContainerExistingLifecycle({ ...ports, identity: async () => null });
// @ts-expect-error Native subprocess results cannot escape an effect.
createContainerExistingLifecycle({ ...ports, start: () => ({ status: 0 }) });
// @ts-expect-error Undefined effects reject async removal.
createContainerExistingLifecycle({ ...ports, remove: async () => undefined });
// @ts-expect-error Unsafe defer must throw rather than return permission.
createContainerExistingLifecycle({ ...ports, throwUnsafeDefer: () => undefined });
// @ts-expect-error Permissive void effects cannot stand in for synchronous undefined.
createContainerExistingLifecycle({ ...ports, finish: (): void => {} });
// @ts-expect-error The guard is a synchronous callback capability, not a boolean.
app.run({ containerName: "name", replacementGuard: true });
// @ts-expect-error A promise cannot authorize replacement.
app.run({ containerName: "name", replacementGuard: async () => true });
// @ts-expect-error Startup-running identity is an immutable ID fact, not a boolean authority.
app.run({ containerName: "name", initiallyRunningContainerId: true });
// @ts-expect-error Last-check replacement identity must include its observed running state.
createContainerExistingLifecycle({ ...ports, identity: () => ({ containerId: "pinned" }) });
// @ts-expect-error Runtime running state is an observation, not a truthy status string.
createContainerExistingLifecycle({ ...ports, identity: () => ({ containerId: "pinned", running: "false" }) });
// @ts-expect-error Replacement requires an explicit reason.
app.replace({ containerName: "name" });
// @ts-expect-error Joined identity is required.
const invalidJoined: ContainerExistingLifecycleResult = { kind: "joined" };
// @ts-expect-error No generic successful status replaces the discriminated result.
const nativeResult: ContainerExistingLifecycleResult = { status: 0 };
void [invalidJoined, nativeResult];

// @ts-expect-error Live verification cannot return a promise or permissive status.
createContainerExistingLifecycle({ ...ports, verifyBeforeSetup: async () => undefined });
// @ts-expect-error A boolean cannot replace required throwing verification.
createContainerExistingLifecycle({ ...ports, verifyBeforeSetup: () => true });
