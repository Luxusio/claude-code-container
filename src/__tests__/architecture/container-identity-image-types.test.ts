import { expect, expectTypeOf, it } from "vitest";
import { ensureIdentityImage, getIdentityCodexPackagesVolumeName, getIdentityLabels, getIdentityMiseVolumeName, normalizeImageId, resolveContainerIdentity, type ContainerIdentity as PublicIdentity } from "../../container-identity.js";
import { prepareIdentityImage } from "../../application/container/identity-image.js";
import type { ContainerIdentity, IdentityImageObservation } from "../../domain/container/identity-image.js";
import type { IdentityImagePorts } from "../../ports/container/identity-image.js";

function contracts(ports: IdentityImagePorts, publicIdentity: PublicIdentity, image: IdentityImageObservation) {
    const inward: ContainerIdentity = publicIdentity;
    const outward: PublicIdentity = inward;
    const id: string = prepareIdentityImage("a".repeat(64), outward, ports);
    ports.observeAccount(image);
    // @ts-expect-error Non-void undefined return rejects asynchronous tagging.
    const tag: IdentityImagePorts = { ...ports, tagBase: async () => undefined };
    // @ts-expect-error Builds must complete synchronously.
    const build: IdentityImagePorts = { ...ports, buildImage: async () => undefined };
    // @ts-expect-error Removal must complete synchronously before the validation error.
    const removal: IdentityImagePorts = { ...ports, removeDerivedImage: async () => undefined };
    // @ts-expect-error A lock cannot return a deferred result.
    const lock: IdentityImagePorts = { ...ports, withIdentityLock: async () => id };
    // @ts-expect-error Locked callbacks cannot defer their workflow.
    ports.withIdentityLock("key", async () => id);
    // @ts-expect-error Digest capture must occur synchronously before label serialization.
    const digest: IdentityImagePorts = { ...ports, captureLabelsDigest: async () => ports.captureLabelsDigest() };
    // @ts-expect-error A captured digest must produce the hash synchronously.
    const digestResult: IdentityImagePorts = { ...ports, captureLabelsDigest: () => async () => "hash" };
    // @ts-expect-error Inspection is synchronous and observes the original image.
    const inspect: IdentityImagePorts = { ...ports, inspectImage: async () => image };
    // @ts-expect-error The account probe retains the lazy inspected observation.
    ports.observeAccount("image-id");
    // @ts-expect-error Mutation cleanup is required, not optional.
    prepareIdentityImage(id, inward, { captureLabelsDigest: ports.captureLabelsDigest });
    void [tag, build, removal, lock, inspect, digest, digestResult];
    return id;
}

it("preserves public facade types and required synchronous inward ports", () => {
    expectTypeOf<PublicIdentity>().toEqualTypeOf<ContainerIdentity>();
    expectTypeOf(ensureIdentityImage).parameters.toEqualTypeOf<[string, ContainerIdentity]>();
    expectTypeOf(ensureIdentityImage).returns.toEqualTypeOf<string>();
    expectTypeOf(resolveContainerIdentity).returns.toEqualTypeOf<ContainerIdentity>();
    expectTypeOf(normalizeImageId).parameters.toEqualTypeOf<[string]>();
    expectTypeOf(getIdentityLabels).returns.toEqualTypeOf<Record<string, string>>();
    expectTypeOf(getIdentityMiseVolumeName).returns.toEqualTypeOf<string>();
    expectTypeOf(getIdentityCodexPackagesVolumeName).returns.toEqualTypeOf<string>();
    expectTypeOf<IdentityImagePorts["tagBase"]>().returns.toEqualTypeOf<undefined>();
    expect(typeof contracts).toBe("function");
});
