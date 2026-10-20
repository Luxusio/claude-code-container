// Native authority and public composition for the complete clean operation.
import { ensureDockerRunning } from "./docker.js";
import { bindNativeRuntimeInvocation, getRuntimeInvocation, runWithNativeRuntimeInvocation } from "./container-runtime.js";
import { prompt, DOCKER_REGISTRY_IMAGE } from "./utils.js";
import { getSessionLockClaimsForContainer, withContainerLifecycleLock } from "./session.js";
import { createClean } from "./application/clean.js";
import type { CleanPorts, CleanRuntimePorts } from "./ports/clean.js";
import type { CleanFailure, CleanInventoryResult, CleanOptions, CleanProgress, ContainerInfo, ImageInfo } from "./domain/clean.js";

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
    captureRuntime: (): CleanRuntimePorts => {
        const invocation = getRuntimeInvocation();
        const runner = bindNativeRuntimeInvocation(invocation);
        const env = { ...process.env };
        const cwd = process.cwd();
        return {
            ensureRuntimeReady: () => {
                runWithNativeRuntimeInvocation(invocation, ensureDockerRunning);
                return undefined;
            },
            observeContainers: (): CleanInventoryResult<ContainerInfo> => {
                const result = runner.spawnSync(
                    ["ps", "-a", "--no-trunc", "--filter", "name=^ccc-", "--format", "{{.ID}}\t{{.Names}}\t{{.Status}}"],
                    { encoding: "utf-8", env, cwd });
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
            },
            observeImages: (repository: string): CleanInventoryResult<ImageInfo> => {
                const result = runner.spawnSync(
                    ["images", "--format", "{{.Repository}}\t{{.ID}}\t{{.Size}}", repository],
                    { encoding: "utf-8", env, cwd });
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
            },
            observeVolumes: (): CleanInventoryResult<string> => {
                const result = runner.spawnSync(
                    ["volume", "ls", "--filter", "name=^ccc-", "--format", "{{.Name}}"],
                    { encoding: "utf-8", env, cwd });
                if (result.error || result.status !== 0) return { kind: "unavailable" };
                const out = (result.stdout ?? "").trim();
                return { kind: "observed", items: out ? out.split("\n").map((v) => v.trim()).filter(Boolean) : [] };
            },
            stopContainer: (containerId: string) => {
                const result = runner.spawnSync(["stop", containerId], { stdio: "inherit", env, cwd });
                return { ok: !result.error && result.status === 0 };
            },
            removeContainer: (containerId: string) => {
                const result = runner.spawnSync(["rm", containerId], { stdio: "inherit", env, cwd });
                return { ok: !result.error && result.status === 0 };
            },
            removeImage: (imageId: string) => {
                const result = runner.spawnSync(["rmi", imageId], { stdio: "inherit", env, cwd });
                return { ok: !result.error && result.status === 0 };
            },
            removeVolume: (volumeName: string) => {
                const result = runner.spawnSync(["volume", "rm", volumeName], { stdio: "inherit", env, cwd });
                return { ok: !result.error && result.status === 0 };
            },
        };
    },
    get registryImage() { return DOCKER_REGISTRY_IMAGE; },
    get confirm() {
        const request = prompt;
        return () => request("\nProceed? [y/N] ", true);
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
};

const clean = createClean(nativePorts);

/** Public CLI projection; reusable cleanup policy never exits its caller. */
export async function cleanContainers(options: CleanOptions): Promise<void> {
    const outcome = await clean(options);
    if (outcome.kind === "failed") throw new Error(formatCleanFailure(outcome.failure));
    if (outcome.kind === "completed") process.exit(0);
}
