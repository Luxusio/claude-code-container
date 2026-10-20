export interface ContainerImagePreparationRequest {
    imageName: string;
    version: string;
    registryImage: string;
}

export type ImageTagOutcome =
    | { kind: "completed" }
    | { kind: "failed"; reason: "image-tag-failed" }
    | { kind: "indeterminate"; reason: "image-tag-unconfirmed" };

export type ContainerImagePreparationOutcome =
    | { kind: "completed"; source: "development" | "matching" | "registry" | "fallback" }
    | { kind: "failed"; reason: "image-pull-failed"; reference: string }
    | { kind: "failed"; reason: "image-tag-failed" }
    | { kind: "indeterminate"; reason: "image-tag-unconfirmed" };

export interface ContainerImagePreparationPorts {
    exists(): boolean;
    label(imageName: string, key: string): string | null;
    qualify(ref: string): string;
    pull(ref: string): boolean;
    tag(source: string, target: string): ImageTagOutcome;
    reportStale(label: string, version: string): undefined;
    reportPull(version: string): undefined;
    reportFallback(ref: string): undefined;
}
