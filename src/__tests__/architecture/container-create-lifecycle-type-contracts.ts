import { createContainerCreateLifecycle } from "../../application/container-create-lifecycle.js";
import type { ContainerCreateLifecyclePorts, ContainerCreateLifecycleRequest, ContainerCreateResult } from "../../ports/container-create-lifecycle.js";

interface Prepared { readonly fixture: unique symbol }
declare const ports: ContainerCreateLifecyclePorts<Prepared>;
const app = createContainerCreateLifecycle(ports);
const request: ContainerCreateLifecycleRequest = { containerName: "name", projectMountIdentity: "identity" };
const result: string = app.run(request);
const created: ContainerCreateResult = { kind: "created", containerId: null };
const failed: ContainerCreateResult = { kind: "failed" };
const timedOut: ContainerCreateResult = { kind: "failed", cause: new Error("native timeout") };
void [result, created, failed, timedOut];
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
// @ts-expect-error Failure presentation cannot return and authorize continuation.
createContainerCreateLifecycle({ ...ports, failCreate: () => undefined });
// @ts-expect-error Requests require physical project ownership.
app.run({ containerName: "name" });
void [raw, missing];
