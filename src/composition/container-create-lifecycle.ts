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

    function run(request: ContainerCreateLifecycleRequest): string {
        let createCause: CapturedCause | undefined;
        let primaryCause: CapturedCause | undefined;
        let removalCause: CapturedCause | undefined;
        let absenceCause: CapturedCause | undefined;

        function clearCauses() {
            createCause = primaryCause = removalCause = absenceCause = undefined;
        }

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
                        throw new Error("Failed to create container", { cause: createCause?.value });
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
                    primary = primaryCause?.value;
                    break;
            }
            const cleanup = outcome.cleanup;
            if (cleanup.kind === "attempted") {
                const failures = [primary];
                if (cleanup.removal === "failed") failures.push(removalCause?.value);
                if (cleanup.absence === "failed") failures.push(absenceCause?.value);
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

        const lifecycle = createContainerCreateLifecycle({
            ...ports,
            ...native,
            withFamilyLock(prefix, operation): ContainerCreateLifecycleOutcome {
                return {
                    kind: "completed",
                    value: ports.withFamilyLock.call(this, prefix, () => {
                        clearCauses();
                        try { return project(operation()); }
                        finally { clearCauses(); }
                    }),
                };
            },
            create(prepared) {
                return native.create(prepared, cause => { createCause = { value: cause }; });
            },
            assertProjectSources() {
                try { return ports.assertProjectSources.call(this); }
                catch (error) { primaryCause = { value: error }; throw error; }
            },
            assertDeviceSources() {
                try { return ports.assertDeviceSources.call(this); }
                catch (error) { primaryCause = { value: error }; throw error; }
            },
            assertFilesystemSources() {
                try { return ports.assertFilesystemSources.call(this); }
                catch (error) { primaryCause = { value: error }; throw error; }
            },
            verifyCreated(id) {
                try { return ports.verifyCreated.call(this, id); }
                catch (error) { primaryCause = { value: error }; throw error; }
            },
            removeRejected(id) {
                try { return native.removeRejected.call(this, id); }
                catch (error) { removalCause = { value: error }; throw error; }
            },
            explicitlyAbsent(id) {
                try { return native.explicitlyAbsent.call(this, id); }
                catch (error) { absenceCause = { value: error }; throw error; }
            },
        });

        try {
            // The native lock bridge always returns completed after projecting its callbacks.
            return (lifecycle.run(request) as Extract<ContainerCreateLifecycleOutcome, { kind: "completed" }>).value;
        } finally {
            clearCauses();
        }
    }

    return { run };
}
