import { createNativeContainerCreatePorts } from "../adapters/container-create-lifecycle.js";
import type { NativeContainerCreateLifecycleContext } from "../adapters/container-create-lifecycle.js";
import { createContainerCreateLifecycle } from "../application/container-create-lifecycle.js";
import type {
    ContainerCreateLifecycleOutcome,
    ContainerCreateLifecyclePorts,
    ContainerCreateLifecycleRequest,
} from "../ports/container-create-lifecycle.js";

export type { NativeContainerCreateLifecycleContext } from "../adapters/container-create-lifecycle.js";

type CapturedCause = { value: unknown };

export function createNativeContainerCreateLifecycle(
    ports: Omit<ContainerCreateLifecyclePorts<{ cli: string; args: string[] }>, keyof ReturnType<typeof createNativeContainerCreatePorts> | "withFamilyLock"> & {
        withFamilyLock(prefix: string, operation: () => string): string;
    },
    context: NativeContainerCreateLifecycleContext,
) {
    for (const name of [
        "withFamilyLock", "namespaceExists", "findCollision",
        "assertProjectSources", "assertDeviceSources", "assertFilesystemSources",
        "verifyCreated", "syncMcp", "fixSsh", "syncGit", "finish",
    ] as const) {
        if (typeof ports?.[name] !== "function") {
            throw new TypeError(`Container create lifecycle requires a callable ${name} port.`);
        }
    }
    const native = createNativeContainerCreatePorts(context);
    const receiver = { ...ports, ...native };
    let causes = {
        createCause: undefined as CapturedCause | undefined,
        primaryCause: undefined as CapturedCause | undefined,
        removalCause: undefined as CapturedCause | undefined,
        absenceCause: undefined as CapturedCause | undefined,
    };

    function project(outcome: ContainerCreateLifecycleOutcome): string {
        if (outcome.kind === "completed") return outcome.value;
        if (outcome.kind === "refused") {
            const failure = outcome.failure;
            switch (failure.kind) {
                case "namespace-appeared":
                    throw new Error(`Container namespace ${failure.containerName} appeared during creation preflight; refusing replacement.`);
                case "collision":
                    throw new Error(
                        `CCC container ${failure.containerName} already owns this physical project `
                        + `for profile ${failure.profile}; refusing duplicate container creation. `
                        + "The existing container was preserved.",
                    );
                case "create-failed":
                    throw new Error("Failed to create container", { cause: causes.createCause?.value });
                case "unpinned-session":
                    throw new Error("Container runtime did not return the created container ID; refusing an unpinned session.");
            }
        }

        let primary: unknown;
        switch (outcome.rejection.kind) {
            case "missing-id-verification":
                primary = new Error("created container bind mount identity verification failed (container runtime did not return an exact 64-hex container ID)");
                break;
            case "verification-failed":
                primary = new Error(`created container bind mount identity verification failed (${outcome.rejection.reason})`);
                break;
            case "post-create-check-failed":
                primary = causes.primaryCause?.value;
                break;
        }
        const cleanup = outcome.cleanup;
        if (cleanup.kind === "attempted") {
            const failures = [primary];
            if (cleanup.removal === "failed") failures.push(causes.removalCause?.value);
            if (cleanup.absence === "failed") failures.push(causes.absenceCause?.value);
            if (failures.length > 1) {
                throw new AggregateError(failures,
                    "Created container verification and rejected-container cleanup failed", { cause: primary });
            }
            if (cleanup.absence !== "proved") {
                throw new Error(
                    `${(primary as Error).message}; failed to remove rejected container ${cleanup.containerId}`,
                    { cause: primary },
                );
            }
        }
        throw primary;
    }

    function capture<Value>(slot: "primaryCause" | "removalCause" | "absenceCause", operation: () => Value): Value {
        try { return operation(); }
        catch (error) {
            causes[slot] = { value: error };
            throw error;
        }
    }

    const lifecycle = createContainerCreateLifecycle<{ cli: string; args: string[] }>({
        withFamilyLock(prefix, operation): ContainerCreateLifecycleOutcome {
            return {
                kind: "completed",
                value: receiver.withFamilyLock(prefix, () => {
                    const previous = causes;
                    causes = { createCause: undefined, primaryCause: undefined, removalCause: undefined, absenceCause: undefined };
                    try { return project(operation()); }
                    finally {
                        causes.createCause = causes.primaryCause = causes.removalCause = causes.absenceCause = undefined;
                        causes = previous;
                    }
                }),
            };
        },
        namespaceExists(name) {
            return receiver.namespaceExists(name);
        },
        findCollision() {
            return receiver.findCollision();
        },
        reportCreating(name, debug) {
            return receiver.reportCreating(name, debug);
        },
        reportLabWarning() {
            return receiver.reportLabWarning();
        },
        reportCreateFailure() {
            return receiver.reportCreateFailure();
        },
        prepareCreate() {
            return receiver.prepareCreate();
        },
        create(prepared) {
            return receiver.create(prepared, cause => { causes.createCause = { value: cause }; });
        },
        assertProjectSources() {
            return capture("primaryCause", () => receiver.assertProjectSources());
        },
        assertDeviceSources() {
            return capture("primaryCause", () => receiver.assertDeviceSources());
        },
        assertFilesystemSources() {
            return capture("primaryCause", () => receiver.assertFilesystemSources());
        },
        verifyCreated(id) {
            return capture("primaryCause", () => receiver.verifyCreated(id));
        },
        removeRejected(id) {
            return capture("removalCause", () => receiver.removeRejected(id));
        },
        explicitlyAbsent(id) {
            return capture("absenceCause", () => receiver.explicitlyAbsent(id));
        },
        syncMcp(id) {
            return receiver.syncMcp(id);
        },
        fixSsh(id) {
            return receiver.fixSsh(id);
        },
        syncGit(id) {
            return receiver.syncGit(id);
        },
        finish(id) {
            return receiver.finish(id);
        },
    });

    function run(request: ContainerCreateLifecycleRequest): string {
        // The native lock bridge always returns completed after projecting its callbacks.
        return (lifecycle.run(request) as Extract<ContainerCreateLifecycleOutcome, { kind: "completed" }>).value;
    }

    return { run };
}
