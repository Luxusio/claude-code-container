import { createContainerDestructiveLifecycle } from "../../application/container-destructive-lifecycle.js";
import type {
    ContainerDestructiveLifecycleOptions,
    ContainerDestructiveLifecyclePorts,
    DestructiveContainerIdentity,
} from "../../ports/container-destructive-lifecycle.js";

declare const ports: ContainerDestructiveLifecyclePorts;
const app = createContainerDestructiveLifecycle(ports);
const stopped: void = app.stop("project");
const removed: void = app.remove("project", "profile", { force: true });
const identity: DestructiveContainerIdentity | null = ports.managedIdentity("name", "path");
const claims: readonly string[] = ports.sessionClaims("prefix");
const effect: undefined = ports.stop("pinned-id");
const stopping: undefined = ports.reportStopping("selected-name", "selected-path");
const removing: undefined = ports.reportRemoving("selected-name", "selected-path");
const locked: undefined = ports.withLifecycleLock("prefix", () => undefined);
const options: ContainerDestructiveLifecycleOptions = {};
void [stopped, removed, identity, claims, effect, stopping, removing, locked, options];

type Assert<T extends true> = T;
type StopPresentationTarget = Assert<Parameters<ContainerDestructiveLifecyclePorts["reportStopping"]> extends [string, string] ? true : false>;
type RemovePresentationTarget = Assert<Parameters<ContainerDestructiveLifecyclePorts["reportRemoving"]> extends [string, string] ? true : false>;
type ClaimGuardTarget = Assert<Parameters<ContainerDestructiveLifecyclePorts["throwSessionClaims"]> extends [number, string] ? true : false>;
type ClaimRejectionThrows = Assert<ReturnType<ContainerDestructiveLifecyclePorts["throwSessionClaims"]> extends never ? true : false>;
type EveryPortRequired = Assert<{
    [K in keyof ContainerDestructiveLifecyclePorts]: {} extends Pick<ContainerDestructiveLifecyclePorts, K> ? false : true
}[keyof ContainerDestructiveLifecyclePorts] extends true ? true : false>;
type AsyncPort<T extends (...args: never[]) => unknown> = (...args: Parameters<T>) => Promise<ReturnType<T>>;
type EveryPortSynchronous = Assert<{
    [K in keyof ContainerDestructiveLifecyclePorts]:
        AsyncPort<ContainerDestructiveLifecyclePorts[K]> extends ContainerDestructiveLifecyclePorts[K] ? false : true
}[keyof ContainerDestructiveLifecyclePorts] extends true ? true : false>;
const required: EveryPortRequired = true;
const synchronous: EveryPortSynchronous = true;
const presentation: [StopPresentationTarget, RemovePresentationTarget, ClaimGuardTarget, ClaimRejectionThrows] = [true, true, true, true];
void [required, synchronous, presentation];

// @ts-expect-error No ambient capabilities are supplied.
createContainerDestructiveLifecycle();
// @ts-expect-error Explicit capabilities cannot be absent.
createContainerDestructiveLifecycle(undefined);
// @ts-expect-error All required observations and effects must be supplied.
createContainerDestructiveLifecycle({ stop: ports.stop });
// @ts-expect-error Destructive dispatch must be callable.
createContainerDestructiveLifecycle({ ...ports, remove: "rm" });
// @ts-expect-error Async observations cannot authorize synchronous destruction.
createContainerDestructiveLifecycle({ ...ports, managedIdentity: async () => null });
// @ts-expect-error Native subprocess results cannot leak through an effect.
createContainerDestructiveLifecycle({ ...ports, stop: () => ({ status: 0 }) });
// @ts-expect-error Async effects cannot satisfy undefined-returning capabilities.
createContainerDestructiveLifecycle({ ...ports, cleanupDevices: async () => undefined });
// @ts-expect-error Claim rejection must throw rather than return permission.
createContainerDestructiveLifecycle({ ...ports, throwSessionClaims: () => undefined });
// @ts-expect-error Stopping presentation requires the selected workspace as well as its name.
ports.reportStopping("selected-name");
// @ts-expect-error Removal presentation requires the selected workspace as well as its name.
ports.reportRemoving("selected-name");
// @ts-expect-error Claim refusal requires the resolved guard workspace.
ports.throwSessionClaims(2);
// @ts-expect-error Permissive void callbacks do not prove synchronous undefined effects.
createContainerDestructiveLifecycle({ ...ports, reportStopped: (): void => {} });
// @ts-expect-error An asynchronous critical section cannot satisfy the synchronous lock.
createContainerDestructiveLifecycle({ ...ports, withLifecycleLock: async (_prefix: string, operation: () => undefined) => operation() });
// @ts-expect-error Promise callbacks cannot be admitted into the critical section.
ports.withLifecycleLock("prefix", async () => undefined);
// @ts-expect-error A void callback does not prove synchronous undefined completion.
ports.withLifecycleLock("prefix", (): void => {});
// @ts-expect-error Managed identity requires a proven string ID and running fact.
const invalidIdentity: DestructiveContainerIdentity = { containerId: "id" };
// @ts-expect-error Public force is boolean, not a truthy string.
app.remove("project", undefined, { force: "true" });
// @ts-expect-error Public operations retain void and cannot return lock authority.
const permission: boolean = app.stop("project");
void [invalidIdentity, permission];
