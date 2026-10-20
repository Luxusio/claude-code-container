import type { CleanFailure, CleanInventoryResult, CleanOptions, CleanOutcome, ContainerInfo, ImageInfo } from "../domain/clean.js";
import type { CleanPorts, CleanRuntimePorts } from "../ports/clean.js";

/** Factory construction performs no native getter/observation or future capture. */
export function createClean(ports: CleanPorts): (options: CleanOptions) => Promise<CleanOutcome> {
    function listImages(runtime: CleanRuntimePorts): CleanInventoryResult<ImageInfo> {
        const seen = new Set<string>();
        const images: ImageInfo[] = [];

        for (const repo of ["ccc", ports.registryImage]) {
            const result = runtime.observeImages(repo);
            if (result.kind === "unavailable") return result;
            for (const image of result.items) {
                if (image.id && !seen.has(image.id)) {
                    seen.add(image.id);
                    images.push(image);
                }
            }
        }
        return { kind: "observed", items: images };
    }

    return async function cleanContainers(options: CleanOptions): Promise<CleanOutcome> {
        const runtime = ports.captureRuntime();
        runtime.ensureRuntimeReady();

        // Incomplete observations never admit a cleanup plan.
        const containersResult = runtime.observeContainers();
        if (containersResult.kind === "unavailable") {
            return { kind: "failed", failure: { kind: "inventory-unavailable", inventory: "containers" }, removed: 0 };
        }
        const allContainers = containersResult.items.filter((container) =>
            /^[a-f0-9]{12,64}$/i.test(container.id) && container.name.startsWith("ccc-"));
        const imagesResult = listImages(runtime);
        if (imagesResult.kind === "unavailable") {
            return { kind: "failed", failure: { kind: "inventory-unavailable", inventory: "images" }, removed: 0 };
        }
        const images = imagesResult.items;
        let volumes: string[] = [];
        if (options.volumes || options.all) {
            const volumesResult = runtime.observeVolumes();
            if (volumesResult.kind === "unavailable") {
                return { kind: "failed", failure: { kind: "inventory-unavailable", inventory: "volumes" }, removed: 0 };
            }
            volumes = volumesResult.items;
        }

        // Determine which containers to remove
        let containersToStop: ContainerInfo[] = [];
        let containersToRemove: ContainerInfo[] = [];

        if (options.all) {
            // Remove everything including running containers
            containersToStop = allContainers.filter((c) => c.running);
            containersToRemove = allContainers;
        } else {
            // Default: only stopped containers
            containersToRemove = allContainers.filter((c) => !c.running);
        }

        const hasWork =
            containersToRemove.length > 0 ||
            images.length > 0 ||
            volumes.length > 0;

        if (!hasWork) {
            ports.capturePublication()({ kind: "nothing-to-clean" });
            return { kind: "nothing-to-clean" };
        }

        // Print plan
        if (containersToStop.length > 0) {
            ports.capturePublication()({ kind: "containers-to-stop" });
            for (const c of containersToStop) {
                ports.capturePublication()({ kind: "container-selected", name: c.name, status: c.status });
            }
        }
        if (containersToRemove.length > 0) {
            ports.capturePublication()({ kind: "containers-to-remove" });
            for (const c of containersToRemove) {
                ports.capturePublication()({ kind: "container-selected", name: c.name, status: c.status });
            }
        }
        if (images.length > 0) {
            ports.capturePublication()({ kind: "images-to-remove" });
            for (const img of images) {
                ports.capturePublication()({ kind: "image-selected", repository: img.repository, id: img.id, size: img.size });
            }
        }
        if (volumes.length > 0) {
            ports.capturePublication()({ kind: "volumes-to-remove" });
            for (const v of volumes) {
                ports.capturePublication()({ kind: "volume-selected", name: v });
            }
        }

        if (options.dryRun) {
            ports.capturePublication()({ kind: "dry-run" });
            return { kind: "dry-run" };
        }

        // Confirm unless --yes
        if (!options.yes) {
            const answer = await ports.confirm();
            if (answer !== "y" && answer !== "yes") {
                ports.capturePublication()({ kind: "aborted" });
                return { kind: "aborted" };
            }
        }

        let removed = 0;

        const stopNames = new Set(containersToStop.map((container) => container.name));
        for (const c of containersToRemove) {
            const containerPrefix = c.name.startsWith("ccc-") ? c.name.slice("ccc-".length) : "";
            if (!containerPrefix) {
                return { kind: "failed", failure: { kind: "unmanaged-container", name: c.name }, removed };
            }
            let failure: CleanFailure | undefined;
            ports.withLifecycleLock(containerPrefix, () => {
                const sessionClaims = ports.sessionClaims(containerPrefix);
                if (sessionClaims.length > 0) {
                    ports.capturePublication()({ kind: "container-claimed", name: c.name, claimCount: sessionClaims.length });
                    return undefined;
                }
                if (stopNames.has(c.name)) {
                    ports.capturePublication()({ kind: "stopping-container", name: c.name });
                    const stopped = runtime.stopContainer(c.id);
                    if (!stopped.ok) {
                        failure = { kind: "stop-container-failed", name: c.name };
                        return undefined;
                    }
                }
                ports.capturePublication()({ kind: "removing-container", name: c.name });
                const r = runtime.removeContainer(c.id);
                if (!r.ok) {
                    failure = { kind: "remove-container-failed", name: c.name };
                    return undefined;
                }
                removed++;
                return undefined;
            });
            if (failure) return { kind: "failed", failure, removed };
        }

        // Remove images
        for (const img of images) {
            ports.capturePublication()({ kind: "removing-image", repository: img.repository, id: img.id });
            const r = runtime.removeImage(img.id);
            if (!r.ok) {
                return { kind: "failed", failure: { kind: "remove-image-failed", repository: img.repository }, removed };
            }
            removed++;
        }

        // Remove volumes
        for (const v of volumes) {
            ports.capturePublication()({ kind: "removing-volume", name: v });
            const r = runtime.removeVolume(v);
            if (!r.ok) {
                return { kind: "failed", failure: { kind: "remove-volume-failed", name: v }, removed };
            }
            removed++;
        }

        ports.capturePublication()({ kind: "completed", removed });
        return { kind: "completed", removed };
    };
}
