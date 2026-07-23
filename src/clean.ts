// src/clean.ts - Clean stopped containers, images, and volumes

import { spawnSync } from "child_process";
import { ensureDockerRunning } from "./docker.js";
import { runtimeCli } from "./container-runtime.js";
import { prompt, DOCKER_REGISTRY_IMAGE } from "./utils.js";
import { getActiveSessionsForContainer, withContainerLifecycleLock } from "./session.js";

export interface CleanOptions {
    volumes?: boolean;   // also remove volumes
    all?: boolean;       // remove everything including running containers
    dryRun?: boolean;    // show plan without executing
    yes?: boolean;       // skip confirmation
}

interface ContainerInfo {
    id: string;
    name: string;
    status: string;
}

interface ImageInfo {
    repository: string;
    id: string;
    size: string;
}

function listContainers(): ContainerInfo[] {
    const result = spawnSync(
        runtimeCli(),
        ["ps", "-a", "--no-trunc", "--filter", "name=^ccc-", "--format", "{{.ID}}\t{{.Names}}\t{{.Status}}"],
        { encoding: "utf-8" },
    );
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

    for (const repo of ["ccc", DOCKER_REGISTRY_IMAGE]) {
        const result = spawnSync(
            runtimeCli(),
            ["images", "--format", "{{.Repository}}\t{{.ID}}\t{{.Size}}", repo],
            { encoding: "utf-8" },
        );
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
    const result = spawnSync(
        runtimeCli(),
        ["volume", "ls", "--filter", "name=^ccc-", "--format", "{{.Name}}"],
        { encoding: "utf-8" },
    );
    const out = (result.stdout ?? "").trim();
    if (!out) return [];
    return out.split("\n").map((v) => v.trim()).filter(Boolean);
}

export async function cleanContainers(options: CleanOptions): Promise<void> {
    ensureDockerRunning();

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
        console.log("Nothing to clean.");
        return;
    }

    // Print plan
    if (containersToStop.length > 0) {
        console.log("\nContainers to stop:");
        for (const c of containersToStop) {
            console.log(`  ${c.name}  (${c.status})`);
        }
    }
    if (containersToRemove.length > 0) {
        console.log("\nContainers to remove:");
        for (const c of containersToRemove) {
            console.log(`  ${c.name}  (${c.status})`);
        }
    }
    if (images.length > 0) {
        console.log("\nImages to remove:");
        for (const img of images) {
            console.log(`  ${img.repository}  ${img.id}  (${img.size})`);
        }
    }
    if (volumes.length > 0) {
        console.log("\nVolumes to remove:");
        for (const v of volumes) {
            console.log(`  ${v}`);
        }
    }

    if (options.dryRun) {
        console.log("\n(dry run - no changes made)");
        return;
    }

    // Confirm unless --yes
    if (!options.yes) {
        const answer = await prompt("\nProceed? [y/N] ", true);
        if (answer !== "y" && answer !== "yes") {
            console.log("Aborted.");
            return;
        }
    }

    let removed = 0;

    const cli = runtimeCli();

    const stopNames = new Set(containersToStop.map((container) => container.name));
    for (const c of containersToRemove) {
        const containerPrefix = c.name.startsWith("ccc-") ? c.name.slice("ccc-".length) : "";
        if (!containerPrefix) throw new Error(`Refusing to clean unmanaged container name: ${c.name}`);
        withContainerLifecycleLock(containerPrefix, () => {
            const activeSessions = getActiveSessionsForContainer(containerPrefix);
            if (activeSessions.length > 0) {
                console.log(`Skipping ${c.name}: ${activeSessions.length} active CCC session(s).`);
                return;
            }
            if (stopNames.has(c.name)) {
                console.log(`Stopping ${c.name}...`);
                const stopped = spawnSync(cli, ["stop", c.id], { stdio: "inherit" });
                if (stopped.error || stopped.status !== 0) {
                    throw new Error(`Failed to stop container ${c.name}; cleanup aborted.`);
                }
            }
            console.log(`Removing container ${c.name}...`);
            const r = spawnSync(cli, ["rm", c.id], { stdio: "inherit" });
            if (r.error || r.status !== 0) {
                throw new Error(`Failed to remove container ${c.name}; cleanup aborted.`);
            }
            removed++;
        });
    }

    // Remove images
    for (const img of images) {
        console.log(`Removing image ${img.repository} (${img.id})...`);
        const r = spawnSync(cli, ["rmi", img.id], { stdio: "inherit" });
        if (r.error || r.status !== 0) {
            throw new Error(`Failed to remove image ${img.repository}; cleanup aborted.`);
        }
        removed++;
    }

    // Remove volumes
    for (const v of volumes) {
        console.log(`Removing volume ${v}...`);
        const r = spawnSync(cli, ["volume", "rm", v], { stdio: "inherit" });
        if (r.error || r.status !== 0) {
            throw new Error(`Failed to remove volume ${v}; cleanup aborted.`);
        }
        removed++;
    }

    console.log(`\nDone. Removed ${removed} item(s).`);
    process.exit(0);
}
