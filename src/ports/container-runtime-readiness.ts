import type { RuntimeName } from "../domain/container-runtime.js";

export type ContainerRuntimeRepairCategory =
    | "docker-desktop"
    | "docker-service"
    | "podman-machine"
    | "podman-rootless"
    | "podman-service";

export type ContainerRuntimeReadinessResult =
    | { kind: "ready" }
    | { kind: "refused"; runtime: RuntimeName; repairCategory: ContainerRuntimeRepairCategory };

export interface ContainerRuntimeReadinessPorts {
    isRunning(): boolean;
    runtimeInfo(): { runtime: RuntimeName; flavor: string };
}
