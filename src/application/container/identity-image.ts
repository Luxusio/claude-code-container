import { identityImageLabels, matchesIdentityImage, type ContainerIdentity } from "../../domain/container/identity-image.js";
import type { IdentityImagePorts } from "../../ports/container/identity-image.js";

function validatedImage(name: string, labels: Record<string, string>, identity: ContainerIdentity, ports: IdentityImagePorts): string | null {
    // Native inspect spawning remains outside the field/account catch.
    const image = ports.inspectImage(name);
    if (image === null) return null;
    try {
        if (!matchesIdentityImage(image, labels)) return null;
        const observed = ports.observeAccount(image);
        return observed === `${identity.uid}:${identity.gid}:/home/ccc:ccc` ? image.Id : null;
    } catch {
        return null;
    }
}

/** Entire cache/build/revalidation/derived-only compensation policy. */
export function prepareIdentityImage(baseImageId: string, identity: ContainerIdentity, ports: IdentityImagePorts): string {
    const labels = identityImageLabels(baseImageId, identity);
    const key = ports.labelsDigest(JSON.stringify(labels));
    const name = `ccc-identity:${key}`;
    return ports.withIdentityLock(key, () => {
        const cached = validatedImage(name, labels, identity, ports);
        if (cached) return cached;
        const baseTag = `ccc-identity-base:${labels["ccc.identity.base"].slice(7)}`;
        ports.tagBase(baseImageId, baseTag);
        ports.buildImage(baseTag, name, identity, labels);
        const built = validatedImage(name, labels, identity, ports);
        if (!built) {
            ports.removeDerivedImage(name);
            throw new Error("Built container identity image failed UID/GID, HOME, sudo or named-user validation. Retry after correcting the base image.");
        }
        return built;
    });
}
