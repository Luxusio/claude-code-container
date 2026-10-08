export type RuntimeName = "docker" | "podman";

export class ContainerEngineUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ContainerEngineUnavailableError";
    }
}

/** Transport diagnostics describe an unavailable engine, not a stopped container. */
export function containerEngineFailureHint(stderr: unknown): string | undefined {
    if (typeof stderr !== "string" || !/(?:request returned 5\d\d .*for API route and version|cannot connect to the docker daemon|error during connect:|connection refused.*(?:docker|podman)|(?:docker|podman).*connection refused)/i.test(stderr)) return undefined;
    return "Container engine is unavailable. Docker Desktop returned a transport/server error; CCC stopped without restarting or replacing the container. Check Docker Desktop engine diagnostics, then retry when the engine is healthy. The API-version text alone does not establish a version mismatch.";
}

export function parseRuntimeOverride(
    value: string | undefined | null,
    source: "cli" | "environment",
): RuntimeName | null {
    if (value == null || value === "") return null;
    if (value === "docker" || value === "podman") return value;

    const label = source === "cli" ? "--runtime" : "CCC_RUNTIME";
    throw new Error(
        `Invalid ${label} value: '${value}'. Allowed: 'docker' or 'podman'.`,
    );
}

/** A finite Docker size, including optional binary unit suffixes. */
export function validateContainerMemory(value: string): string {
    const match = /^(\d+(?:\.\d+)?)([bkmg]?)$/i.exec(value);
    const bytes = match ? Number(match[1]) * 1024 ** ("bkmg".indexOf((match[2] || "b").toLowerCase())) : NaN;
    if (!Number.isFinite(bytes) || bytes < 6 * 1024 * 1024) {
        throw new Error("CCC_CONTAINER_MEMORY must be a positive Docker memory size of at least 6 MiB (for example 2g or 8192m).");
    }
    return value;
}

export function containerMemoryLimit(flavor: string, engineMemoryBytes?: number, override?: string): string | undefined {
    if (override !== undefined) return validateContainerMemory(override);
    if (flavor !== "docker-desktop") return undefined;
    const observed = typeof engineMemoryBytes === "number" && Number.isFinite(engineMemoryBytes) && engineMemoryBytes > 0 ? engineMemoryBytes : NaN;
    const memoryMiB = Math.floor(Math.min(8 * 1024, observed / (4 * 1024 * 1024)));
    if (!Number.isFinite(memoryMiB) || memoryMiB < 6) {
        throw new Error("Cannot determine Docker Desktop VM memory safely. Check that Docker Desktop is healthy and docker info reports MemTotal, then retry; or set CCC_CONTAINER_MEMORY to an explicit positive size (for example 2g). CCC refused to create an unlimited container.");
    }
    return `${memoryMiB}m`;
}
