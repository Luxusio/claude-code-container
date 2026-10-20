import type { CleanInventoryResult, CleanMutationResult, CleanProgress, ContainerInfo, ImageInfo } from "../domain/clean.js";

/** Mutation effects supplied by the captured cleanup runtime. */
export interface CleanMutationPorts {
    readonly stopContainer: (containerId: string) => CleanMutationResult;
    readonly removeContainer: (containerId: string) => CleanMutationResult;
    readonly removeImage: (imageId: string) => CleanMutationResult;
    readonly removeVolume: (volumeName: string) => CleanMutationResult;
}

/** Readiness, inventory and mutations share one operation's runtime authority. */
export interface CleanRuntimePorts extends CleanMutationPorts {
    readonly ensureRuntimeReady: () => undefined;
    readonly observeContainers: () => CleanInventoryResult<ContainerInfo>;
    readonly observeImages: (repository: string) => CleanInventoryResult<ImageInfo>;
    readonly observeVolumes: () => CleanInventoryResult<string>;
}

/** Required semantic observations/effects, with no ambient native defaults. */
export interface CleanPorts {
    readonly captureRuntime: () => CleanRuntimePorts;
    readonly registryImage: string;
    readonly confirm: () => Promise<string>;
    readonly withLifecycleLock: (prefix: string, operation: () => undefined) => undefined;
    readonly sessionClaims: (prefix: string) => string[];
    readonly capturePublication: () => (progress: CleanProgress) => undefined;
}
