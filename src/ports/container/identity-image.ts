import type { ContainerIdentity, IdentityImageObservation } from "../../domain/container/identity-image.js";

export interface IdentityImagePorts {
    captureLabelsDigest(): (serializedLabels: string) => string;
    withIdentityLock(key: string, operation: () => string): string;
    inspectImage(name: string): IdentityImageObservation | null;
    observeAccount(image: IdentityImageObservation): string;
    tagBase(baseImageId: string, baseTag: string): undefined;
    buildImage(baseTag: string, name: string, identity: ContainerIdentity, labels: Record<string, string>): undefined;
    removeDerivedImage(name: string): undefined;
}
