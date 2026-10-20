// Checked by the normal strict architecture compiler; never invoked.
import type { CleanOptions } from "../../clean.js";
import type { CleanPorts, CleanRuntimePorts } from "../../ports/clean.js";
import type { ContainerInfo, CleanInventoryResult, CleanMutationResult, CleanProgress, CleanFailure, CleanOutcome } from "../../domain/clean.js";
import { createClean } from "../../application/clean.js";
import { cleanContainers } from "../../clean.js";

function contracts(ports: CleanPorts, runtime: CleanRuntimePorts) {
    const options: CleanOptions = { volumes: true, all: false, dryRun: true, yes: false };
    const app: (options: CleanOptions) => Promise<CleanOutcome> = createClean(ports);
    const facade: (options: CleanOptions) => Promise<void> = cleanContainers;
    const outcome: Promise<CleanOutcome> = app(options);
    const captured: CleanRuntimePorts = ports.captureRuntime();
    const container: ContainerInfo = { id: "captured-id", name: "ccc-project", status: "Up 10 minutes", running: true };
    const observed: CleanInventoryResult<ContainerInfo> = { kind: "observed", items: [container] };
    const containers: CleanInventoryResult<ContainerInfo> = captured.observeContainers();
    const result: CleanMutationResult = captured.removeContainer("captured-id");
    const sync: undefined = ports.withLifecycleLock("prefix", () => undefined);
    const publish: (progress: CleanProgress) => undefined = ports.capturePublication();
    const completed: CleanOutcome = { kind: "completed", removed: 2 };
    const failure: CleanFailure = { kind: "inventory-unavailable", inventory: "containers" };
    const failed: CleanOutcome = { kind: "failed", failure, removed: 1 };

    // @ts-expect-error Application ports are required.
    createClean();
    // @ts-expect-error Existing options remain explicit.
    app();
    // @ts-expect-error No new force or claim-bypass option.
    const force: CleanOptions = { force: true };
    // @ts-expect-error Native process fields cannot replace a semantic inventory.
    const rawInventory: CleanInventoryResult<ContainerInfo> = { status: 0, stdout: "partial" };
    // @ts-expect-error An observed inventory requires typed items.
    const missingItems: CleanInventoryResult<ContainerInfo> = { kind: "observed" };
    // @ts-expect-error A completed cleanup needs its successful removal count.
    const missingCount: CleanOutcome = { kind: "completed" };
    // @ts-expect-error Failed cleanup must describe the semantic failure.
    const missingFailure: CleanOutcome = { kind: "failed", removed: 0 };
    // @ts-expect-error Native errors are not operation outcomes.
    const nativeFailure: CleanOutcome = { kind: "failed", failure: new Error("failure"), removed: 0 };
    // @ts-expect-error Readiness is synchronous inside the captured authority.
    const asyncReady: CleanRuntimePorts = { ...runtime, ensureRuntimeReady: async () => undefined };
    // @ts-expect-error Inventories are synchronous and semantic.
    const asyncInventory: CleanRuntimePorts = { ...runtime, observeContainers: async () => observed };
    // @ts-expect-error Runtime capture is synchronous.
    const asyncCapture: CleanPorts = { ...ports, captureRuntime: async () => runtime };
    // @ts-expect-error Mutation effects are synchronous.
    const asyncMutation: CleanRuntimePorts = { ...runtime, removeImage: async () => result };
    // @ts-expect-error Native exit is not an application capability.
    const exitPort: CleanPorts = { ...ports, exitSuccess: () => { throw new Error("exit"); } };
    // @ts-expect-error Native Error construction is not an application capability.
    const errorPort: CleanPorts = { ...ports, failureError: () => new Error("failure") };
    // @ts-expect-error Inventory must be obtained through captured runtime authority.
    ports.observeContainers();
    // @ts-expect-error Raw session claims are synchronous.
    const asyncClaims: CleanPorts = { ...ports, sessionClaims: async () => [] };
    // @ts-expect-error Lifecycle critical sections cannot become asynchronous.
    ports.withLifecycleLock("prefix", async () => undefined);
    // @ts-expect-error Lock effects return undefined synchronously.
    const asyncLock: CleanPorts = { ...ports, withLifecycleLock: async () => undefined };
    // @ts-expect-error Native text stays outside the application publication boundary.
    publish("Removing container ccc-project...");
    // @ts-expect-error Failure inventory names remain a closed semantic set.
    const invalidInventory: CleanFailure = { kind: "inventory-unavailable", inventory: "networks" };
    // @ts-expect-error A native process result cannot be used as a mutation fact.
    const rawMutation: CleanMutationResult = { status: 0 };
    // @ts-expect-error Captured capabilities are readonly.
    runtime.removeVolume = () => result;

    void [facade, outcome, captured, containers, sync, completed, failed, force, rawInventory, missingItems, missingCount,
        missingFailure, nativeFailure, asyncReady, asyncInventory, asyncCapture, asyncMutation, exitPort, errorPort,
        asyncClaims, asyncLock, invalidInventory, rawMutation];
}
void contracts;
