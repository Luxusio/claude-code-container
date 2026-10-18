// Native authority and public composition for the complete clean operation.
import { spawnSync } from "child_process";
import { ensureDockerRunning } from "./docker.js";
import { runtimeCli } from "./container-runtime.js";
import { prompt, DOCKER_REGISTRY_IMAGE } from "./utils.js";
import { getSessionLockClaimsForContainer, withContainerLifecycleLock } from "./session.js";
import { createClean } from "./application/clean.js";
import type { CleanMutationPorts, CleanPorts } from "./ports/clean.js";
import type { CleanFailure, CleanInventoryResult, CleanProgress, ContainerInfo, ImageInfo } from "./domain/clean.js";

export type { CleanOptions } from "./domain/clean.js";

function formatCleanProgress(progress: CleanProgress): string {
    switch (progress.kind) {
        case "nothing-to-clean": return "Nothing to clean.";
        case "containers-to-stop": return "\nContainers to stop:";
        case "containers-to-remove": return "\nContainers to remove:";
        case "container-selected": return `  ${progress.name}  (${progress.status})`;
        case "images-to-remove": return "\nImages to remove:";
        case "image-selected": return `  ${progress.repository}  ${progress.id}  (${progress.size})`;
        case "volumes-to-remove": return "\nVolumes to remove:";
        case "volume-selected": return `  ${progress.name}`;
        case "dry-run": return "\n(dry run - no changes made)";
        case "aborted": return "Aborted.";
        case "container-claimed": return `Skipping ${progress.name}: ${progress.claimCount} CCC session ownership claim(s).`;
        case "stopping-container": return `Stopping ${progress.name}...`;
        case "removing-container": return `Removing container ${progress.name}...`;
        case "removing-image": return `Removing image ${progress.repository} (${progress.id})...`;
        case "removing-volume": return `Removing volume ${progress.name}...`;
        case "completed": return `\nDone. Removed ${progress.removed} item(s).`;
    }
}

function formatCleanFailure(failure: CleanFailure): string {
    switch (failure.kind) {
        case "inventory-unavailable": return `Failed to list ${failure.inventory}; cleanup aborted.`;
        case "unmanaged-container": return `Refusing to clean unmanaged container name: ${failure.name}`;
        case "stop-container-failed": return `Failed to stop container ${failure.name}; cleanup aborted.`;
        case "remove-container-failed": return `Failed to remove container ${failure.name}; cleanup aborted.`;
        case "remove-image-failed": return `Failed to remove image ${failure.repository}; cleanup aborted.`;
        case "remove-volume-failed": return `Failed to remove volume ${failure.name}; cleanup aborted.`;
    }
}

const nativePorts: CleanPorts = {
    get ensureRuntimeReady() {
        const ready = ensureDockerRunning;
        return () => { ready(); return undefined; };
    },
    get observeContainers() {
        const observe = spawnSync;
        return (): CleanInventoryResult<ContainerInfo> => {
            const result = observe(runtimeCli(),
                ["ps", "-a", "--no-trunc", "--filter", "name=^ccc-", "--format", "{{.ID}}\t{{.Names}}\t{{.Status}}"],
                { encoding: "utf-8" });
            if (result.error || result.status !== 0) return { kind: "unavailable" };
            const out = (result.stdout ?? "").trim();
            return {
                kind: "observed",
                items: out ? out.split("\n").map((line) => {
                    const [id, name, ...rest] = line.split("\t");
                    const status = rest.join("\t").trim();
                    return {
                        id: (id ?? "").trim(),
                        name: (name ?? "").trim(),
                        status,
                        running: status.toLowerCase().startsWith("up"),
                    };
                }) : [],
            };
        };
    },
    get observeImages() {
        const observe = spawnSync;
        return (repository: string): CleanInventoryResult<ImageInfo> => {
            const result = observe(runtimeCli(),
                ["images", "--format", "{{.Repository}}\t{{.ID}}\t{{.Size}}", repository],
                { encoding: "utf-8" });
            if (result.error || result.status !== 0) return { kind: "unavailable" };
            const out = (result.stdout ?? "").trim();
            return {
                kind: "observed",
                items: out ? out.split("\n").map((line) => {
                    const parts = line.split("\t");
                    return {
                        repository: (parts[0] ?? "").trim(),
                        id: (parts[1] ?? "").trim(),
                        size: (parts[2] ?? "").trim(),
                    };
                }) : [],
            };
        };
    },
    get registryImage() { return DOCKER_REGISTRY_IMAGE; },
    get observeVolumes() {
        const observe = spawnSync;
        return (): CleanInventoryResult<string> => {
            const result = observe(runtimeCli(),
                ["volume", "ls", "--filter", "name=^ccc-", "--format", "{{.Name}}"],
                { encoding: "utf-8" });
            if (result.error || result.status !== 0) return { kind: "unavailable" };
            const out = (result.stdout ?? "").trim();
            return { kind: "observed", items: out ? out.split("\n").map((v) => v.trim()).filter(Boolean) : [] };
        };
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
                    return (containerId: string) => {
                        const result = mutate(cli, ["stop", containerId], { stdio: "inherit" });
                        return { ok: !result.error && result.status === 0 };
                    };
                },
                get removeContainer() {
                    const mutate = spawnSync;
                    return (containerId: string) => {
                        const result = mutate(cli, ["rm", containerId], { stdio: "inherit" });
                        return { ok: !result.error && result.status === 0 };
                    };
                },
                get removeImage() {
                    const mutate = spawnSync;
                    return (imageId: string) => {
                        const result = mutate(cli, ["rmi", imageId], { stdio: "inherit" });
                        return { ok: !result.error && result.status === 0 };
                    };
                },
                get removeVolume() {
                    const mutate = spawnSync;
                    return (volumeName: string) => {
                        const result = mutate(cli, ["volume", "rm", volumeName], { stdio: "inherit" });
                        return { ok: !result.error && result.status === 0 };
                    };
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
        return (progress: CleanProgress) => {
            const text = formatCleanProgress(progress);
            Reflect.apply(publish, receiver, [text]);
            return undefined;
        };
    },
    get failureError() {
        const Failure = Error;
        return (failure: CleanFailure) => new Failure(formatCleanFailure(failure));
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
