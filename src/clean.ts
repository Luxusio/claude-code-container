// Native authority and public composition for the complete clean operation.
import { spawnSync } from "child_process";
import { ensureDockerRunning } from "./docker.js";
import { runtimeCli } from "./container-runtime.js";
import { prompt, DOCKER_REGISTRY_IMAGE } from "./utils.js";
import { getSessionLockClaimsForContainer, withContainerLifecycleLock } from "./session.js";
import { createClean } from "./application/clean.js";
import type { CleanMutationPorts, CleanPorts } from "./ports/clean.js";

export type { CleanOptions } from "./domain/clean.js";

const nativePorts: CleanPorts = {
    get ensureRuntimeReady() {
        const ready = ensureDockerRunning;
        return () => { ready(); return undefined; };
    },
    get observeContainers() {
        const observe = spawnSync;
        return () => observe(runtimeCli(),
            ["ps", "-a", "--no-trunc", "--filter", "name=^ccc-", "--format", "{{.ID}}\t{{.Names}}\t{{.Status}}"],
            { encoding: "utf-8" });
    },
    get observeImages() {
        const observe = spawnSync;
        return (repository: string) => observe(runtimeCli(),
            ["images", "--format", "{{.Repository}}\t{{.ID}}\t{{.Size}}", repository],
            { encoding: "utf-8" });
    },
    get registryImage() { return DOCKER_REGISTRY_IMAGE; },
    get observeVolumes() {
        const observe = spawnSync;
        return () => observe(runtimeCli(),
            ["volume", "ls", "--filter", "name=^ccc-", "--format", "{{.Name}}"],
            { encoding: "utf-8" });
    },
    get confirm() {
        const request = prompt;
        return () => request("\nProceed? [y/N] ", true);
    },
    get captureMutationRuntime() {
        const selectedRuntime = runtimeCli;
        return (): CleanMutationPorts => {
            const cli = selectedRuntime();
            return {
                get stopContainer() {
                    const mutate = spawnSync;
                    return (containerId: string) => mutate(cli, ["stop", containerId], { stdio: "inherit" });
                },
                get removeContainer() {
                    const mutate = spawnSync;
                    return (containerId: string) => mutate(cli, ["rm", containerId], { stdio: "inherit" });
                },
                get removeImage() {
                    const mutate = spawnSync;
                    return (imageId: string) => mutate(cli, ["rmi", imageId], { stdio: "inherit" });
                },
                get removeVolume() {
                    const mutate = spawnSync;
                    return (volumeName: string) => mutate(cli, ["volume", "rm", volumeName], { stdio: "inherit" });
                },
            };
        };
    },
    get withLifecycleLock() {
        const guard = withContainerLifecycleLock;
        return (prefix: string, operation: () => undefined) => { guard(prefix, operation); return undefined; };
    },
    get sessionClaims() {
        const observe = getSessionLockClaimsForContainer;
        return (prefix: string) => observe(prefix);
    },
    capturePublication: () => {
        const receiver = console;
        const publish = receiver.log;
        return (text: string) => { Reflect.apply(publish, receiver, [text]); return undefined; };
    },
    get exitSuccess() {
        const receiver = process;
        const exit = receiver.exit;
        return (): never => Reflect.apply(exit, receiver, [0]) as never;
    },
};

// Export the named async application directly; an async forwarding wrapper
// would add a Promise assimilation boundary to the existing public behavior.
export const cleanContainers = createClean(nativePorts);
