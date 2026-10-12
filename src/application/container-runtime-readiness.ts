import type {
    ContainerRuntimeReadinessPorts,
    ContainerRuntimeReadinessResult,
    ContainerRuntimeRepairCategory,
} from "../ports/container-runtime-readiness.js";

export function createContainerRuntimeReadiness(ports: ContainerRuntimeReadinessPorts) {
    function run(): ContainerRuntimeReadinessResult {
        if (ports.isRunning()) return { kind: "ready" };

        const info = ports.runtimeInfo();
        let repairCategory: ContainerRuntimeRepairCategory;
        if (info.runtime === "docker") {
            repairCategory = info.flavor === "docker-desktop" ? "docker-desktop" : "docker-service";
        } else if (info.flavor === "podman-machine") {
            repairCategory = "podman-machine";
        } else if (info.flavor === "podman-rootless") {
            repairCategory = "podman-rootless";
        } else {
            repairCategory = "podman-service";
        }
        return { kind: "refused", runtime: info.runtime, repairCategory };
    }

    return { run };
}
