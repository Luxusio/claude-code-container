import type { RuntimeName } from "../domain/container-runtime.js";
import type { RuntimeInfo } from "../domain/runtime-capabilities.js";

/** Raw probe object: result identity and lazy property accesses are retained. */
export interface RuntimeCapabilityProbeResult {
    readonly status: number | null;
    readonly stdout: string | null | undefined;
}

export interface RuntimeCapabilitiesPorts {
    readCachedInfo(): RuntimeInfo | null;
    publishCachedInfo(info: RuntimeInfo): undefined;
    readVitestFlag(): string | undefined;
    readExplicitOverride(): RuntimeName | null;
    selectRuntime(): RuntimeName;
    readPlatform(): string;
    observeVersion(runtime: RuntimeName): RuntimeCapabilityProbeResult;
    observeDockerOperatingSystem(): RuntimeCapabilityProbeResult;
    readSelectedDockerEndpoint(): string | null;
    observePodmanRemote(): RuntimeCapabilityProbeResult;
    observeDockerSecurityOptions(): RuntimeCapabilityProbeResult;
    observePodmanRootless(): RuntimeCapabilityProbeResult;
    readWslDistributionName(): string | undefined;
    observeWslMirroredLoopback(): boolean;
    readRuntimeSocketOverride(): string | undefined;
    readXdgRuntimeDirectory(): string | undefined;
    readEffectiveUidOrDefault(defaultUid: number): number;
    joinPodmanSocketPath(xdg: string): string;
}

export type RuntimeCapabilitiesObservationPorts = Pick<RuntimeCapabilitiesPorts,
    | "readPlatform" | "observeVersion" | "observeDockerOperatingSystem"
    | "readSelectedDockerEndpoint" | "observePodmanRemote"
    | "observeDockerSecurityOptions" | "observePodmanRootless"
    | "readWslDistributionName" | "observeWslMirroredLoopback"
    | "readRuntimeSocketOverride" | "readXdgRuntimeDirectory"
    | "readEffectiveUidOrDefault" | "joinPodmanSocketPath">;
