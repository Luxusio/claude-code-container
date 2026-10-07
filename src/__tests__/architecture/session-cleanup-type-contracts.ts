import { createSessionCleanup } from "../../application/session-cleanup.js";
import type { SessionCleanupPorts } from "../../ports/session-cleanup.js";

const ports: SessionCleanupPorts = {
    projectId: () => "project-id",
    withLifecycleLock: <T>(_prefix: string, operation: () => T): T => operation(),
    hasOtherClaims: () => false,
    removeClaim: () => undefined,
    cleanupDevices: () => undefined,
    reportDeviceCleanupFailure: () => undefined,
    stopContainer: readContainerId => { const id: string | null = readContainerId(); void id; return undefined; },
};
const app = createSessionCleanup(ports);
app.setSession("own.lock", "/project");
app.setSession("own.lock", "/project", "", "");
app.setSessionContainerId("opaque-id");
app.setSessionContainerId(null);
app.setSessionCleanupEnabled(false);
app.setSessionCleanupEnabled(true);
// @ts-expect-error shutdown authorization requires an explicit boolean
app.setSessionCleanupEnabled("true");
const snapshot: { lockFile: string | null; projectPath: string | null; profile?: string; toolName: string | null } = app.getCurrentSession();
const cleanup: void = app.cleanupSession();
const clear: void = app.clearSession();
const projectId: string = ports.projectId("/project");
const foreign: boolean = ports.hasOtherClaims("project-id", "own.lock");
const removed: undefined = ports.removeClaim("own.lock");
const devices: undefined = ports.cleanupDevices("/project", 5000, "work");
const reported: undefined = ports.reportDeviceCleanupFailure({ reason: "devices" });
const stopped: undefined = ports.stopContainer(() => null);
const lockedNumber: number = ports.withLifecycleLock("project-id", () => 42);
// The synchronous generic implementation preserves T, including a callback that returns a promise.
const lockedPromise: Promise<number> = ports.withLifecycleLock("project-id", async () => 42);
void [snapshot, cleanup, clear, projectId, foreign, removed, devices, reported, stopped, lockedNumber, lockedPromise];

type RequiredNames = "projectId" | "withLifecycleLock" | "hasOtherClaims" | "removeClaim"
    | "cleanupDevices" | "reportDeviceCleanupFailure" | "stopContainer";
type Assert<T extends true> = T;
type AllRequired = Assert<{
    [K in RequiredNames]: {} extends Pick<SessionCleanupPorts, K> ? false : true
}[RequiredNames] extends true ? true : false>;
const allRequired: AllRequired = true;
void allRequired;

// @ts-expect-error There are no ambient or default effects.
createSessionCleanup();
// @ts-expect-error Explicit ports cannot be absent.
createSessionCleanup(undefined);
// @ts-expect-error Project identity must be callable.
createSessionCleanup({ ...ports, projectId: "project-id" });
// @ts-expect-error Lifecycle lock must be callable.
createSessionCleanup({ ...ports, withLifecycleLock: false });
// @ts-expect-error Raw query must be callable.
createSessionCleanup({ ...ports, hasOtherClaims: false });
// @ts-expect-error Removal must be callable.
createSessionCleanup({ ...ports, removeClaim: undefined });
// @ts-expect-error Device cleanup must be callable.
createSessionCleanup({ ...ports, cleanupDevices: null });
// @ts-expect-error Reporter must be callable.
createSessionCleanup({ ...ports, reportDeviceCleanupFailure: {} });
// @ts-expect-error Stop must be callable.
createSessionCleanup({ ...ports, stopContainer: "stop" });

// @ts-expect-error Project identity must return synchronously.
createSessionCleanup({ ...ports, projectId: async () => "project-id" });
// @ts-expect-error Generic lifecycle implementation must return T, not Promise<T>.
createSessionCleanup({ ...ports, withLifecycleLock: async <T>(_prefix: string, operation: () => T) => operation() });
// @ts-expect-error Raw authority must return a synchronous boolean.
createSessionCleanup({ ...ports, hasOtherClaims: async () => false });
// @ts-expect-error Explicit undefined effect return rejects asynchronous removal.
createSessionCleanup({ ...ports, removeClaim: async () => undefined });
// @ts-expect-error Explicit undefined effect return rejects asynchronous devices.
createSessionCleanup({ ...ports, cleanupDevices: async () => undefined });
// @ts-expect-error Explicit undefined effect return rejects asynchronous reporting.
createSessionCleanup({ ...ports, reportDeviceCleanupFailure: async () => undefined });
// @ts-expect-error Explicit undefined effect return rejects asynchronous stop.
createSessionCleanup({ ...ports, stopContainer: async () => undefined });

const voidEffect = (): void => {};
// @ts-expect-error Undefined removal results do not accept permissive void effects.
createSessionCleanup({ ...ports, removeClaim: voidEffect });
// @ts-expect-error Undefined device cleanup results do not accept permissive void effects.
createSessionCleanup({ ...ports, cleanupDevices: voidEffect });
// @ts-expect-error Undefined reporter results do not accept permissive void effects.
createSessionCleanup({ ...ports, reportDeviceCleanupFailure: voidEffect });
// @ts-expect-error Undefined stop results do not accept permissive void effects.
createSessionCleanup({ ...ports, stopContainer: voidEffect });
// @ts-expect-error Stop receives a lazy reader, not an eager ID string.
createSessionCleanup({ ...ports, stopContainer: (_id: string | null) => undefined });
// @ts-expect-error The reader cannot return an asynchronous ID.
ports.stopContainer(async () => "id");
// @ts-expect-error The container ID is intentionally absent from the public snapshot.
const exposedId = app.getCurrentSession().containerId;
// @ts-expect-error Cleanup is synchronous.
const asynchronousCleanup: Promise<void> = app.cleanupSession();
void [exposedId, asynchronousCleanup];
