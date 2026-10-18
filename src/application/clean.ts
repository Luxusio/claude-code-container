import type { CleanInventoryResult, CleanOptions, ContainerInfo, ImageInfo } from "../domain/clean.js";
import type { CleanPorts } from "../ports/clean.js";

/** Factory construction performs no native getter/observation or future capture. */
export function createClean(ports: CleanPorts): (options: CleanOptions) => Promise<void> {
    /** Incomplete observations never admit a cleanup plan. */
    function admitInventory<T>(result: CleanInventoryResult<T>, inventory: "containers" | "images" | "volumes"): T[] {
        if (result.kind === "unavailable") {
            throw ports.failureError({ kind: "inventory-unavailable", inventory });
        }
        return result.items;
    }

    function listContainers(): ContainerInfo[] {
        return admitInventory(ports.observeContainers(), "containers").filter((container) =>
            /^[a-f0-9]{12,64}$/i.test(container.id) && container.name.startsWith("ccc-"));
    }

    function listImages(): ImageInfo[] {
        const seen = new Set<string>();
        const images: ImageInfo[] = [];

        for (const repo of ["ccc", ports.registryImage]) {
            for (const image of admitInventory(ports.observeImages(repo), "images")) {
                if (image.id && !seen.has(image.id)) {
                    seen.add(image.id);
                    images.push(image);
                }
            }
        }
        return images;
    }

    function listVolumes(): string[] {
        return admitInventory(ports.observeVolumes(), "volumes");
    }

    return async function cleanContainers(options: CleanOptions): Promise<void> {
        ports.ensureRuntimeReady();

        const allContainers = listContainers();
        const images = listImages();
        const volumes = options.volumes || options.all ? listVolumes() : [];

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
            return;
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
            return;
        }

        // Confirm unless --yes
        if (!options.yes) {
            const answer = await ports.confirm();
            if (answer !== "y" && answer !== "yes") {
                ports.capturePublication()({ kind: "aborted" });
                return;
            }
        }

        let removed = 0;

        const mutations = ports.captureMutationRuntime();

        const stopNames = new Set(containersToStop.map((container) => container.name));
        for (const c of containersToRemove) {
            const containerPrefix = c.name.startsWith("ccc-") ? c.name.slice("ccc-".length) : "";
            if (!containerPrefix) throw ports.failureError({ kind: "unmanaged-container", name: c.name });
            ports.withLifecycleLock(containerPrefix, () => {
                const sessionClaims = ports.sessionClaims(containerPrefix);
                if (sessionClaims.length > 0) {
                    ports.capturePublication()({ kind: "container-claimed", name: c.name, claimCount: sessionClaims.length });
                    return undefined;
                }
                if (stopNames.has(c.name)) {
                    ports.capturePublication()({ kind: "stopping-container", name: c.name });
                    const stopped = mutations.stopContainer(c.id);
                    if (!stopped.ok) {
                        throw ports.failureError({ kind: "stop-container-failed", name: c.name });
                    }
                }
                ports.capturePublication()({ kind: "removing-container", name: c.name });
                const r = mutations.removeContainer(c.id);
                if (!r.ok) {
                    throw ports.failureError({ kind: "remove-container-failed", name: c.name });
                }
                removed++;
                return undefined;
            });
        }

        // Remove images
        for (const img of images) {
            ports.capturePublication()({ kind: "removing-image", repository: img.repository, id: img.id });
            const r = mutations.removeImage(img.id);
            if (!r.ok) {
                throw ports.failureError({ kind: "remove-image-failed", repository: img.repository });
            }
            removed++;
        }

        // Remove volumes
        for (const v of volumes) {
            ports.capturePublication()({ kind: "removing-volume", name: v });
            const r = mutations.removeVolume(v);
            if (!r.ok) {
                throw ports.failureError({ kind: "remove-volume-failed", name: v });
            }
            removed++;
        }

        ports.capturePublication()({ kind: "completed", removed });
        ports.exitSuccess();
    };
}
