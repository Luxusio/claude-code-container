import type { CleanInventoryResult, CleanOptions, ContainerInfo, ImageInfo } from "../domain/clean.js";
import type { CleanPorts } from "../ports/clean.js";

/** The only intentional behavior change: failed inventory never admits a plan. */
function admitInventory(result: CleanInventoryResult, kind: "containers" | "images" | "volumes"): void {
    if (result.error || result.status !== 0) {
        throw new Error(`Failed to list ${kind}; cleanup aborted.`);
    }
}

/** Factory construction performs no native getter/observation or future capture. */
export function createClean(ports: CleanPorts): (options: CleanOptions) => Promise<void> {
    function listContainers(): ContainerInfo[] {
        const result = ports.observeContainers();
        admitInventory(result, "containers");
        const out = (result.stdout ?? "").trim();
        if (!out) return [];
        return out.split("\n").flatMap((line) => {
            const [id, name, ...rest] = line.split("\t");
            const normalizedId = (id ?? "").trim();
            const normalizedName = (name ?? "").trim();
            if (!/^[a-f0-9]{12,64}$/i.test(normalizedId) || !normalizedName.startsWith("ccc-")) return [];
            return [{ id: normalizedId, name: normalizedName, status: rest.join("\t").trim() }];
        });
    }

    function listImages(): ImageInfo[] {
        const seen = new Set<string>();
        const images: ImageInfo[] = [];

        for (const repo of ["ccc", ports.registryImage]) {
            const result = ports.observeImages(repo);
            admitInventory(result, "images");
            const out = (result.stdout ?? "").trim();
            if (!out) continue;
            for (const line of out.split("\n")) {
                const parts = line.split("\t");
                const id = (parts[1] ?? "").trim();
                if (id && !seen.has(id)) {
                    seen.add(id);
                    images.push({
                        repository: (parts[0] ?? "").trim(),
                        id,
                        size: (parts[2] ?? "").trim(),
                    });
                }
            }
        }
        return images;
    }

    function listVolumes(): string[] {
        const result = ports.observeVolumes();
        admitInventory(result, "volumes");
        const out = (result.stdout ?? "").trim();
        if (!out) return [];
        return out.split("\n").map((v) => v.trim()).filter(Boolean);
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
            containersToStop = allContainers.filter((c) =>
                c.status.toLowerCase().startsWith("up"),
            );
            containersToRemove = allContainers;
        } else {
            // Default: only stopped containers
            containersToRemove = allContainers.filter(
                (c) => !c.status.toLowerCase().startsWith("up"),
            );
        }

        const hasWork =
            containersToRemove.length > 0 ||
            images.length > 0 ||
            volumes.length > 0;

        if (!hasWork) {
            ports.capturePublication()("Nothing to clean.");
            return;
        }

        // Print plan
        if (containersToStop.length > 0) {
            ports.capturePublication()("\nContainers to stop:");
            for (const c of containersToStop) {
                ports.capturePublication()(`  ${c.name}  (${c.status})`);
            }
        }
        if (containersToRemove.length > 0) {
            ports.capturePublication()("\nContainers to remove:");
            for (const c of containersToRemove) {
                ports.capturePublication()(`  ${c.name}  (${c.status})`);
            }
        }
        if (images.length > 0) {
            ports.capturePublication()("\nImages to remove:");
            for (const img of images) {
                ports.capturePublication()(`  ${img.repository}  ${img.id}  (${img.size})`);
            }
        }
        if (volumes.length > 0) {
            ports.capturePublication()("\nVolumes to remove:");
            for (const v of volumes) {
                ports.capturePublication()(`  ${v}`);
            }
        }

        if (options.dryRun) {
            ports.capturePublication()("\n(dry run - no changes made)");
            return;
        }

        // Confirm unless --yes
        if (!options.yes) {
            const answer = await ports.confirm();
            if (answer !== "y" && answer !== "yes") {
                ports.capturePublication()("Aborted.");
                return;
            }
        }

        let removed = 0;

        const mutations = ports.captureMutationRuntime();

        const stopNames = new Set(containersToStop.map((container) => container.name));
        for (const c of containersToRemove) {
            const containerPrefix = c.name.startsWith("ccc-") ? c.name.slice("ccc-".length) : "";
            if (!containerPrefix) throw new Error(`Refusing to clean unmanaged container name: ${c.name}`);
            ports.withLifecycleLock(containerPrefix, () => {
                const sessionClaims = ports.sessionClaims(containerPrefix);
                if (sessionClaims.length > 0) {
                    ports.capturePublication()(`Skipping ${c.name}: ${sessionClaims.length} CCC session ownership claim(s).`);
                    return undefined;
                }
                if (stopNames.has(c.name)) {
                    ports.capturePublication()(`Stopping ${c.name}...`);
                    const stopped = mutations.stopContainer(c.id);
                    if (stopped.error || stopped.status !== 0) {
                        throw new Error(`Failed to stop container ${c.name}; cleanup aborted.`);
                    }
                }
                ports.capturePublication()(`Removing container ${c.name}...`);
                const r = mutations.removeContainer(c.id);
                if (r.error || r.status !== 0) {
                    throw new Error(`Failed to remove container ${c.name}; cleanup aborted.`);
                }
                removed++;
                return undefined;
            });
        }

        // Remove images
        for (const img of images) {
            ports.capturePublication()(`Removing image ${img.repository} (${img.id})...`);
            const r = mutations.removeImage(img.id);
            if (r.error || r.status !== 0) {
                throw new Error(`Failed to remove image ${img.repository}; cleanup aborted.`);
            }
            removed++;
        }

        // Remove volumes
        for (const v of volumes) {
            ports.capturePublication()(`Removing volume ${v}...`);
            const r = mutations.removeVolume(v);
            if (r.error || r.status !== 0) {
                throw new Error(`Failed to remove volume ${v}; cleanup aborted.`);
            }
            removed++;
        }

        ports.capturePublication()(`\nDone. Removed ${removed} item(s).`);
        ports.exitSuccess();
    };
}
