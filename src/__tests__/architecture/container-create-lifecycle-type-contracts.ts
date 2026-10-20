import { createContainerCreateLifecycle } from "../../application/container-create-lifecycle.js";
import type {
    ContainerCreateFailure, ContainerCreateLifecycleOutcome, ContainerCreateLifecyclePorts,
    ContainerCreateLifecycleRequest, ContainerCreateResult, CreatedContainerRejection, RejectedContainerCleanup,
} from "../../ports/container-create-lifecycle.js";

interface Prepared { readonly fixture: unique symbol }
declare const ports: ContainerCreateLifecyclePorts<Prepared>;
const app = createContainerCreateLifecycle(ports);
const request: ContainerCreateLifecycleRequest = { containerName: "name", projectMountIdentity: "identity" };
const result: ContainerCreateLifecycleOutcome = app.run(request);
const created: ContainerCreateResult = { kind: "created", containerId: null };
const failed: ContainerCreateResult = { kind: "failed" };
const refusals = [
    { kind: "namespace-appeared", containerName: "name" },
    { kind: "collision", containerName: "owner", profile: "default" },
    { kind: "create-failed" }, { kind: "unpinned-session" },
] satisfies ContainerCreateFailure[];
const rejections = [
    { kind: "missing-id-verification" }, { kind: "verification-failed", reason: "mismatch" },
    { kind: "post-create-check-failed" },
] satisfies CreatedContainerRejection[];
const cleanup = [
    { kind: "not-authorized" },
    { kind: "attempted", containerId: "semantic-id", removal: "completed", absence: "proved" },
    { kind: "attempted", containerId: "semantic-id", removal: "failed", absence: "unproved" },
    { kind: "attempted", containerId: "semantic-id", removal: "failed", absence: "failed" },
] satisfies RejectedContainerCleanup[];
const outcomes = [
    { kind: "completed", value: "name" },
    { kind: "refused", failure: refusals[0] },
    { kind: "rejected", rejection: rejections[0], cleanup: cleanup[0] },
] satisfies ContainerCreateLifecycleOutcome[];
const locked: ContainerCreateLifecycleOutcome = ports.withFamilyLock("family", () => result);
void [result, created, failed, refusals, rejections, cleanup, outcomes, locked];
// @ts-expect-error Native argv cannot replace an opaque preparation.
ports.create(["run"]);
// @ts-expect-error Async observations cannot authorize synchronous creation.
createContainerCreateLifecycle({ ...ports, namespaceExists: async () => false });
// @ts-expect-error Preparation must preserve its opaque handle type.
createContainerCreateLifecycle<Prepared>({ ...ports, prepareCreate: () => ["run"] });
// @ts-expect-error Raw process output cannot cross the inward boundary.
const raw: ContainerCreateResult = { status: 0, stdout: "id" };
// @ts-expect-error Created observations require the nullable pinned identity.
const missing: ContainerCreateResult = { kind: "created" };
// @ts-expect-error Effects must prove synchronous completion.
createContainerCreateLifecycle({ ...ports, syncMcp: async () => undefined });
// @ts-expect-error Native causes stay outside semantic create results.
const timedOut: ContainerCreateResult = { kind: "failed", cause: new Error("native timeout") };
// @ts-expect-error Native primary causes stay outside closed post-create rejections.
const nativeRejection: CreatedContainerRejection = { kind: "post-create-check-failed", error: new Error("native") };
// @ts-expect-error Cleanup contains finite facts rather than a native removal exception.
const nativeCleanup: RejectedContainerCleanup = { kind: "attempted", containerId: "id", removal: "failed", absence: "failed", error: new Error("native") };
// @ts-expect-error Verification rejection is not a pre-create refusal.
const rejectedRefusal: ContainerCreateFailure = { kind: "verification-failed", reason: "mismatch" };
// @ts-expect-error Raw process results stay outside lifecycle outcomes.
const nativeOutcome: ContainerCreateLifecycleOutcome = { kind: "completed", value: { status: 0, stdout: "id" } };
// @ts-expect-error The semantic application returns an outcome rather than a native facade string.
const nativeString: string = app.run(request);
// @ts-expect-error The family lock must return a synchronous semantic outcome.
createContainerCreateLifecycle({ ...ports, withFamilyLock: async (_prefix, operation) => operation() });
// @ts-expect-error The family callback cannot return a promise.
ports.withFamilyLock("family", async () => result);
// @ts-expect-error Native string lock callbacks need an explicit composition bridge.
createContainerCreateLifecycle({ ...ports, withFamilyLock: (_prefix, _operation) => "native-string" });
// @ts-expect-error Create observations must remain synchronous.
createContainerCreateLifecycle({ ...ports, create: async () => failed });
// @ts-expect-error Explicit absence must remain synchronous.
createContainerCreateLifecycle({ ...ports, explicitlyAbsent: async () => true });
// @ts-expect-error Requests require physical project ownership.
app.run({ containerName: "name" });
void [raw, missing, timedOut, nativeRejection, nativeCleanup, rejectedRefusal, nativeOutcome, nativeString];
