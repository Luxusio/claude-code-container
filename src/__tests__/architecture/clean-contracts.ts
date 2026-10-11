// Checked by the normal strict architecture compiler; never invoked.
import type { CleanOptions } from "../../clean.js";
import type { CleanPorts, CleanMutationPorts } from "../../ports/clean.js";
import type { CleanInventoryResult, CleanMutationResult } from "../../domain/clean.js";
import {createClean} from "../../application/clean.js";
import {cleanContainers} from "../../clean.js";

function contracts(ports: CleanPorts, mutation: CleanMutationPorts, clean: (options: CleanOptions) => Promise<void>) {
    const options: CleanOptions = { volumes: true, all: false, dryRun: true, yes: false };
    const promise: Promise<void> = clean(options);
    const raw: CleanInventoryResult = { status: null, stdout: null, error: { opaque: true } };
    const result: CleanMutationResult = mutation.removeContainer("captured-id");
    const sync: undefined = ports.withLifecycleLock("prefix", () => undefined);
    // @ts-expect-error No implicit options default in the public callable.
    clean();
    // @ts-expect-error Public flags remain booleans.
    const badOptions: CleanOptions = { yes: "yes" };
    // @ts-expect-error No new force option.
    const force: CleanOptions = { force: true };
    // @ts-expect-error Status is a required raw observation.
    const missingStatus: CleanInventoryResult = { stdout: "partial" };
    // @ts-expect-error Unknown status carriers are not accepted by strict consumers.
    const unknownStatus: CleanMutationResult = { status: {} as unknown };
    // @ts-expect-error Native-free stdout contract is not Buffer/unknown.
    const badStdout: CleanInventoryResult = { status: 0, stdout: {} };
    // @ts-expect-error No ambient optional effects: ports are complete.
    const missingPorts: CleanPorts = { ensureRuntimeReady: () => undefined };
    // @ts-expect-error Readiness is strictly synchronous, returning undefined.
    const asyncReady: CleanPorts = { ...ports, ensureRuntimeReady: async () => undefined };
    // @ts-expect-error Inventory observations are synchronous and raw.
    const asyncInventory: CleanPorts = { ...ports, observeContainers: async () => raw };
    // @ts-expect-error Unknown inventory results cannot silently pass admission.
    const unknownInventory: CleanPorts = { ...ports, observeImages: (): unknown => raw };
    // @ts-expect-error Raw claims are synchronous.
    const asyncClaims: CleanPorts = { ...ports, sessionClaims: async () => [] };
    // @ts-expect-error Mutation-runtime capture cannot be asynchronous.
    const asyncCapture: CleanPorts = { ...ports, captureMutationRuntime: async () => mutation };
    // @ts-expect-error Lock effect must return undefined synchronously.
    const asyncLock: CleanPorts = { ...ports, withLifecycleLock: async () => undefined };
    // @ts-expect-error Async critical sections are forbidden, including Promise<undefined>.
    ports.withLifecycleLock("prefix", async () => undefined);
    // @ts-expect-error Synchronous critical sections cannot return an opaque result.
    ports.withLifecycleLock("prefix", () => raw);
    // @ts-expect-error Publication capture is synchronous.
    const asyncPublication: CleanPorts = { ...ports, capturePublication: async () => () => undefined };
    // @ts-expect-error A captured publication is synchronous and returns undefined.
    const asyncLogger: CleanPorts = { ...ports, capturePublication: () => async () => undefined };
    // @ts-expect-error Raw mutation effects cannot become asynchronous.
    const asyncMutation: CleanMutationPorts = { ...mutation, stopContainer: async () => result };
    // @ts-expect-error Mutation results are not void.
    const missingRaw: CleanMutationPorts = { ...mutation, removeImage: () => undefined };
    // @ts-expect-error Successful native exit has a never return.
    const returningExit: CleanPorts = { ...ports, exitSuccess: () => undefined };
    // @ts-expect-error Readonly native effect boundaries cannot be overwritten by consumers.
    mutation.removeVolume = () => result;

    void [promise, raw, result, sync, badOptions, force, missingStatus, unknownStatus, badStdout, missingPorts, asyncReady, asyncInventory, unknownInventory, asyncClaims, asyncCapture, asyncLock, asyncPublication, asyncLogger, asyncMutation, missingRaw, returningExit, options];
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
