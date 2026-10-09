import type { CleanInventoryResult, CleanMutationResult } from "../domain/clean.js";

/** Private captured runtime authority; getters select each native callee lazily. */
export interface CleanMutationPorts {
    readonly stopContainer: (containerId: string) => CleanMutationResult;
    readonly removeContainer: (containerId: string) => CleanMutationResult;
    readonly removeImage: (imageId: string) => CleanMutationResult;
    readonly removeVolume: (volumeName: string) => CleanMutationResult;
}

/** Required semantic observations/effects, with no ambient native defaults. */
export interface CleanPorts {
    readonly ensureRuntimeReady: () => undefined;
    readonly observeContainers: () => CleanInventoryResult;
    readonly observeImages: (repository: string) => CleanInventoryResult;
    readonly registryImage: string;
    readonly observeVolumes: () => CleanInventoryResult;
    readonly confirm: () => Promise<string>;
    readonly captureMutationRuntime: () => CleanMutationPorts;
    readonly withLifecycleLock: (prefix: string, operation: () => undefined) => undefined;
    readonly sessionClaims: (prefix: string) => string[];
    readonly capturePublication: () => (computedText: string) => undefined;
    readonly exitSuccess: () => never;
}
