import type { RuntimeName } from "../domain/container-runtime.js";

export type DockerOperatingSystemObservation = "unavailable" | "desktop" | "other";

export interface RuntimeCapabilitiesPorts {
    selectRuntime(): RuntimeName;
    readPlatform(): string;
    observeVersion(runtime: RuntimeName): string | null;
    observeDockerOperatingSystem(): DockerOperatingSystemObservation;
    readSelectedDockerEndpoint(): string | null;
    observePodmanRemote(): boolean;
    observeDockerSecurityOptions(): boolean;
    observePodmanRootless(): boolean | null;
    readWslDistributionName(): string | undefined;
    observeWslMirroredLoopback(): boolean;
    readRuntimeSocketOverride(): string | undefined;
    readXdgRuntimeDirectory(): string | undefined;
    readEffectiveUidOrDefault(defaultUid: number): number;
    joinPodmanSocketPath(xdg: string): string;
}

export type RuntimeCapabilitiesObservationPorts = Omit<RuntimeCapabilitiesPorts, "selectRuntime">;
