import type {
    ContainerImagePreparationOutcome,
    ContainerImagePreparationPorts,
    ContainerImagePreparationRequest,
} from "../ports/container-image-preparation.js";

export function createContainerImagePreparation(ports: ContainerImagePreparationPorts) {
    for (const name of [
        "exists", "label", "qualify", "pull", "tag", "reportStale", "reportPull",
        "reportFallback",
    ] as const) {
        if (typeof ports?.[name] !== "function") {
            throw new TypeError(`Container image preparation requires a callable ${name} port.`);
        }
    }

    function run(request: ContainerImagePreparationRequest): ContainerImagePreparationOutcome {
        const localExists = ports.exists();
        if (localExists) {
            const label = ports.label(request.imageName, "cli.version");
            if (label === null) return { kind: "completed", source: "development" };
            if (label === request.version) return { kind: "completed", source: "matching" };
            ports.reportStale(label, request.version);
        } else {
            ports.reportPull(request.version);
        }

        const remoteRef = ports.qualify(`${request.registryImage}:${request.version}`);
        if (ports.pull(remoteRef)) {
            const tagged = ports.tag(remoteRef, request.imageName);
            return tagged.kind === "completed" ? { kind: "completed", source: "registry" } : tagged;
        }
        if (localExists) {
            ports.reportFallback(remoteRef);
            return { kind: "completed", source: "fallback" };
        }
        return { kind: "failed", reason: "image-pull-failed", reference: remoteRef };
    }

    return { run };
}
