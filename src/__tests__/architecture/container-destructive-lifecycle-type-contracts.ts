import { createContainerDestructiveLifecycle } from "../../application/container-destructive-lifecycle.js";
import { createNativeContainerDestructiveLifecycle } from "../../composition/container-destructive-lifecycle.js";
import { removeProjectContainer, stopProjectContainer } from "../../docker.js";
import type {
    ContainerDestructiveCommandObservation,
    ContainerDestructiveLifecycleEvidence,
    ContainerDestructiveLifecycleOptions,
    ContainerDestructiveLifecycleOutcome,
    ContainerDestructiveLifecyclePorts,
    ContainerDeviceCleanupObservation,
    DestructiveContainerIdentity,
} from "../../ports/container-destructive-lifecycle.js";

declare const ports: ContainerDestructiveLifecyclePorts;
declare const evidence: ContainerDestructiveLifecycleEvidence;
const app = createContainerDestructiveLifecycle(ports);
const stopped: ContainerDestructiveLifecycleOutcome = app.stop("project");
const removed: ContainerDestructiveLifecycleOutcome = app.remove("project", "profile", { force: true });
const identity: DestructiveContainerIdentity | null = ports.managedIdentity("name", "path");
const claims: readonly string[] = ports.sessionClaims("prefix");
const command: ContainerDestructiveCommandObservation = ports.stop("pinned-id");
const cleanup: ContainerDeviceCleanupObservation = ports.cleanupDevices("project", 5000);
const completed: ContainerDestructiveLifecycleOutcome = { kind: "completed", value: evidence };
const locked: ContainerDestructiveLifecycleOutcome = ports.withLifecycleLock("prefix", () => completed);
const options: ContainerDestructiveLifecycleOptions = {};
const publicStop: void = stopProjectContainer("project");
const publicRemove: void = removeProjectContainer("project");
declare const nativePorts: Parameters<typeof createNativeContainerDestructiveLifecycle>[0];
const nativeStop: void = createNativeContainerDestructiveLifecycle(nativePorts).stop("project");
const nativeRemove: void = createNativeContainerDestructiveLifecycle(nativePorts).remove("project");
void [stopped, removed, identity, claims, command, cleanup, locked, options, publicStop, publicRemove, nativeStop, nativeRemove];

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
// @ts-expect-error Every required observation and effect must be supplied.
createContainerDestructiveLifecycle({ stop: ports.stop });
// @ts-expect-error Native subprocess results cannot stand in for normalized command acknowledgement.
createContainerDestructiveLifecycle({ ...ports, stop: () => ({ status: 0 }) });
// @ts-expect-error Commands require a synchronous observation rather than a void effect.
createContainerDestructiveLifecycle({ ...ports, remove: (): void => {} });
// @ts-expect-error Commands require a synchronous observation rather than a Promise.
createContainerDestructiveLifecycle({ ...ports, stop: async () => ({ kind: "completed" }) });
// @ts-expect-error Cleanup requires finite normalized counts rather than the helper's raw report.
createContainerDestructiveLifecycle({ ...ports, cleanupDevices: () => ({ ownerId: "owner", results: [] }) });
// @ts-expect-error Cleanup cannot erase its observation with void.
createContainerDestructiveLifecycle({ ...ports, cleanupDevices: (): void => {} });
// @ts-expect-error Async cleanup cannot authorize synchronous destruction.
createContainerDestructiveLifecycle({ ...ports, cleanupDevices: async () => ({ kind: "unavailable" }) });
// @ts-expect-error Async identity cannot authorize synchronous destruction.
createContainerDestructiveLifecycle({ ...ports, managedIdentity: async () => null });
// @ts-expect-error The lock must return its callback's closed lifecycle result.
createContainerDestructiveLifecycle({ ...ports, withLifecycleLock: (_prefix, callback): void => { callback(); } });
// @ts-expect-error A raw subprocess result cannot become lock authority.
createContainerDestructiveLifecycle({ ...ports, withLifecycleLock: () => ({ status: 0 }) });
// @ts-expect-error An asynchronous critical section cannot satisfy the synchronous lock.
createContainerDestructiveLifecycle({ ...ports, withLifecycleLock: async (_prefix, callback) => callback() });
// @ts-expect-error A Promise callback cannot be admitted into the critical section.
ports.withLifecycleLock("prefix", async () => completed);
// @ts-expect-error A void callback cannot prove a closed lifecycle outcome.
ports.withLifecycleLock("prefix", (): void => {});
// @ts-expect-error A raw native receipt cannot be admitted as an application result.
ports.withLifecycleLock("prefix", () => ({ status: 0 }));
// @ts-expect-error Warnings accept only normalized cleanup observations.
ports.reportDeviceCleanupFailure(new Error("private helper failure"));
// @ts-expect-error Claim rejection must throw rather than return permission.
createContainerDestructiveLifecycle({ ...ports, throwSessionClaims: () => undefined });
// @ts-expect-error Stopping presentation requires both name and selected workspace.
ports.reportStopping("selected-name");
// @ts-expect-error Removal presentation requires both name and selected workspace.
ports.reportRemoving("selected-name");
// @ts-expect-error Presentation effects must be synchronously undefined.
createContainerDestructiveLifecycle({ ...ports, reportStopped: (): void => {} });
// @ts-expect-error Public force is boolean rather than a truthy string.
app.remove("project", undefined, { force: "true" });
// @ts-expect-error Initial identity requires both unique ID and running observation.
const invalidIdentity: DestructiveContainerIdentity = { containerId: "id" };
// @ts-expect-error Lifecycle command evidence cannot claim a fresh runtime state.
const invalidEvidence: ContainerDestructiveLifecycleEvidence = { ...evidence, stop: "stopped" };
// @ts-expect-error The application exposes a reusable outcome, not void.
const erased: void = app.stop("project");
void [invalidIdentity, invalidEvidence, erased];
