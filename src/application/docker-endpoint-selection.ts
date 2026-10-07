import type { DockerEndpointSelectionPorts } from "../ports/docker-endpoint-selection.js";

export function createDockerEndpointResolver(
    ports: DockerEndpointSelectionPorts,
): () => string | null {
    for (const name of [
        "readContextOverride",
        "readHostOverride",
        "inspectContextEndpoint",
    ] as const) {
        if (typeof ports?.[name] !== "function") {
            throw new TypeError(`Docker endpoint selection requires a callable ${name} port.`);
        }
    }

    return () => {
        const context = ports.readContextOverride();
        if (context) return ports.inspectContextEndpoint(context);

        const host = ports.readHostOverride()?.trim();
        if (host) return host;

        return ports.inspectContextEndpoint(undefined);
    };
}
