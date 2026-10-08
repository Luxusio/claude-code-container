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
