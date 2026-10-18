// Checked by the normal strict architecture compiler; never invoked.
import type { CleanOptions } from "../../clean.js";
import type { CleanPorts, CleanMutationPorts } from "../../ports/clean.js";
import type { ContainerInfo, ImageInfo, CleanInventoryResult, CleanMutationResult, CleanProgress, CleanFailure } from "../../domain/clean.js";
import {createClean} from "../../application/clean.js";
import {cleanContainers} from "../../clean.js";

function contracts(ports: CleanPorts, mutation: CleanMutationPorts, clean: (options: CleanOptions) => Promise<void>) {
    const options: CleanOptions = { volumes: true, all: false, dryRun: true, yes: false };
    const promise: Promise<void> = clean(options);
    const container: ContainerInfo = { id: "captured-id", name: "ccc-project", status: "Up 10 minutes", running: true };
    const observed: CleanInventoryResult<ContainerInfo> = { kind: "observed", items: [container] };
    const unavailable: CleanInventoryResult<ContainerInfo> = { kind: "unavailable" };
    const containers: CleanInventoryResult<ContainerInfo> = ports.observeContainers();
    const images: CleanInventoryResult<ImageInfo> = ports.observeImages("ccc");
    const volumes: CleanInventoryResult<string> = ports.observeVolumes();
    const success: CleanMutationResult = { ok: true };
    const result: CleanMutationResult = mutation.removeContainer("captured-id");
    const sync: undefined = ports.withLifecycleLock("prefix", () => undefined);
    const selected: CleanProgress = { kind: "container-selected", name: container.name, status: container.status };
    const completed: CleanProgress = { kind: "completed", removed: 2 };
    const failure: CleanFailure = { kind: "inventory-unavailable", inventory: "containers" };
    const publish: (progress: CleanProgress) => undefined = ports.capturePublication();
    const published: undefined = publish(selected);
    const failureError: Error = ports.failureError(failure);
    // @ts-expect-error No implicit options default in the public callable.
    clean();
    // @ts-expect-error Public flags remain booleans.
    const badOptions: CleanOptions = { yes: "yes" };
    // @ts-expect-error No new force option.
    const force: CleanOptions = { force: true };
    // @ts-expect-error Container running state is a required semantic fact.
    const missingRunning: ContainerInfo = { id: "captured-id", name: "ccc-project", status: "Up 10 minutes" };
    // @ts-expect-error An observed inventory requires its typed items.
    const missingItems: CleanInventoryResult<ContainerInfo> = { kind: "observed" };
    // @ts-expect-error Native process fields are not an inventory outcome.
    const rawInventory: CleanInventoryResult<ContainerInfo> = { status: 0, stdout: "partial" };
    // @ts-expect-error Container inventory cannot carry volume names.
    const wrongItems: CleanInventoryResult<ContainerInfo> = { kind: "observed", items: ["ccc-cache"] };
    // @ts-expect-error Mutation success must be a boolean.
    const invalidMutation: CleanMutationResult = { ok: "true" };
    // @ts-expect-error Native process status is not a mutation outcome.
    const rawMutation: CleanMutationResult = { status: 0 };
    // @ts-expect-error No ambient optional effects: ports are complete.
    const missingPorts: CleanPorts = { ensureRuntimeReady: () => undefined };
    // @ts-expect-error Readiness is strictly synchronous, returning undefined.
    const asyncReady: CleanPorts = { ...ports, ensureRuntimeReady: async () => undefined };
    // @ts-expect-error Inventory observations are synchronous and semantic.
    const asyncInventory: CleanPorts = { ...ports, observeContainers: async () => observed };
    // @ts-expect-error Unknown inventory results cannot silently pass admission.
    const unknownInventory: CleanPorts = { ...ports, observeImages: (): unknown => observed };
    // @ts-expect-error Raw claims are synchronous.
    const asyncClaims: CleanPorts = { ...ports, sessionClaims: async () => [] };
    // @ts-expect-error Mutation-runtime capture cannot be asynchronous.
    const asyncCapture: CleanPorts = { ...ports, captureMutationRuntime: async () => mutation };
    // @ts-expect-error Lock effect must return undefined synchronously.
    const asyncLock: CleanPorts = { ...ports, withLifecycleLock: async () => undefined };
    // @ts-expect-error Async critical sections are forbidden, including Promise<undefined>.
    ports.withLifecycleLock("prefix", async () => undefined);
    // @ts-expect-error Synchronous critical sections cannot return an opaque result.
    ports.withLifecycleLock("prefix", () => observed);
    // @ts-expect-error Publication capture is synchronous.
    const asyncPublication: CleanPorts = { ...ports, capturePublication: async () => () => undefined };
    // @ts-expect-error A captured publication is synchronous and returns undefined.
    const asyncLogger: CleanPorts = { ...ports, capturePublication: () => async () => undefined };
    // @ts-expect-error Terminal text is rendered outside the application contract.
    publish("Removing container ccc-project...");
    // @ts-expect-error Progress kinds are a closed operation-specific union.
    publish({ kind: "arbitrary-progress" });
    // @ts-expect-error A completed cleanup requires its semantic count.
    publish({ kind: "completed" });
    // @ts-expect-error A claim fact requires the number of ownership claims.
    publish({ kind: "container-claimed", name: "ccc-project" });
    // @ts-expect-error Native process fields cannot replace progress facts.
    const rawProgress: CleanProgress = { status: 0, stdout: "done" };
    // @ts-expect-error A string publisher cannot implement the semantic publication port.
    const textPublisher: CleanPorts = { ...ports, capturePublication: () => (_text: string) => undefined };
    const { failureError: omittedFailureMapper, ...withoutFailureMapper } = ports;
    // @ts-expect-error Native failure rendering is a required capability.
    createClean(withoutFailureMapper);
    // @ts-expect-error Native failure rendering must settle synchronously.
    const asyncFailure: CleanPorts = { ...ports, failureError: async () => new Error("failure") };
    // @ts-expect-error Failure rendering must produce the actual Error to throw.
    const textFailure: CleanPorts = { ...ports, failureError: () => "failure" };
    // @ts-expect-error Failure kinds are closed and do not carry terminal prose.
    const renderedFailure: CleanFailure = { kind: "message", text: "cleanup aborted" };
    // @ts-expect-error An unavailable inventory names one of the three admitted inventories.
    ports.failureError({ kind: "inventory-unavailable", inventory: "networks" });
    // @ts-expect-error Image removal failure requires repository identity.
    ports.failureError({ kind: "remove-image-failed", name: "image" });
    // @ts-expect-error Mutation effects cannot become asynchronous.
    const asyncMutation: CleanMutationPorts = { ...mutation, stopContainer: async () => result };
    // @ts-expect-error Mutation results are not void.
    const missingMutation: CleanMutationPorts = { ...mutation, removeImage: () => undefined };
    // @ts-expect-error Successful native exit has a never return.
    const returningExit: CleanPorts = { ...ports, exitSuccess: () => undefined };
    // @ts-expect-error Readonly native effect boundaries cannot be overwritten by consumers.
    mutation.removeVolume = () => result;

    void [promise, container, observed, unavailable, containers, images, volumes, success, result, sync, selected, completed, failure, published, failureError, badOptions, force, missingRunning, missingItems, rawInventory, wrongItems, invalidMutation, rawMutation, missingPorts, asyncReady, asyncInventory, unknownInventory, asyncClaims, asyncCapture, asyncLock, asyncPublication, asyncLogger, rawProgress, textPublisher, omittedFailureMapper, asyncFailure, textFailure, renderedFailure, asyncMutation, missingMutation, returningExit, options];
}
void contracts;
function publicContracts(ports: CleanPorts) {
     const app: (options: CleanOptions)=>Promise<void> = createClean(ports);
     const facade: typeof app = cleanContainers;
     void facade;
     // @ts-expect-error Application ports are required.
     createClean();

    void [app, facade];
}
void publicContracts;
