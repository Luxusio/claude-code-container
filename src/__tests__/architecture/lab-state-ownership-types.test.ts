import { describe, expect, it } from "vitest";
import { createLabStateOwnershipPreparation } from "../../application/container/lab-state-ownership.js";
import type {
    LabOwnershipApplication, LabOwnershipHelperScope, LabPreviousPrincipal, LabStatePrincipal,
    LabVolumePresence, LabVolumeUse,
} from "../../domain/container/lab-state-ownership.js";
import type { LabStateOwnershipPorts } from "../../ports/container/lab-state-ownership.js";
import { prepareLabStateOwnership } from "../../lab-state-ownership.js";
import type { ContainerIdentity } from "../../container-identity.js";

function compileContracts(ports: LabStateOwnershipPorts, scope: LabOwnershipHelperScope, principal: LabStatePrincipal, full: ContainerIdentity) {
    const app = createLabStateOwnershipPreparation(ports);
    const result: undefined = app.run("volume", "image", principal, "old");
    const publicResult: void = prepareLabStateOwnership("volume", "image", full);
    const present: LabVolumePresence = ports.observeVolume("volume");
    const users: LabVolumeUse = ports.observeVolumeUsers("volume");
    const previous: LabPreviousPrincipal = ports.observePreviousAccount(scope, "old");
    const applied: LabOwnershipApplication = ports.applyOwnership(scope, "volume", "image", principal, { kind: "verify" });
    createLabStateOwnershipPreparation({
        ...ports, observeVolume: () => "present", observeVolumeUsers: () => "idle",
        observePreviousAccount: () => ({ kind: "known", principal }), applyOwnership: () => "applied",
    });
    void [result, publicResult, present, users, previous, applied];
    // @ts-expect-error Explicit ports are required.
    createLabStateOwnershipPreparation();
    // @ts-expect-error Undefined supplies no native defaults.
    createLabStateOwnershipPreparation(undefined);
    // @ts-expect-error Normalization must be synchronous.
    createLabStateOwnershipPreparation({ ...ports, normalizeImageId: async () => "image" });
    // @ts-expect-error Volume observation must be synchronous.
    createLabStateOwnershipPreparation({ ...ports, observeVolume: async () => "present" });
    // @ts-expect-error Users must be synchronous.
    createLabStateOwnershipPreparation({ ...ports, observeVolumeUsers: async () => "idle" });
    // @ts-expect-error Scope capture must be synchronous.
    createLabStateOwnershipPreparation({ ...ports, captureHelperScope: async () => scope });
    // @ts-expect-error Account observation must be synchronous.
    createLabStateOwnershipPreparation({ ...ports, observePreviousAccount: async () => ({ kind: "known", principal }) });
    // @ts-expect-error Ownership consumes a synchronous confirmation.
    createLabStateOwnershipPreparation({ ...ports, applyOwnership: async () => "applied" });
    // @ts-expect-error The final confirmation cannot be discarded as void.
    createLabStateOwnershipPreparation({ ...ports, applyOwnership: (): void => {} });
    // @ts-expect-error The final confirmation cannot be discarded as undefined.
    createLabStateOwnershipPreparation({ ...ports, applyOwnership: () => undefined });
    // @ts-expect-error Required primitive cannot be omitted.
    createLabStateOwnershipPreparation({ normalizeImageId: ports.normalizeImageId, observeVolume: ports.observeVolume, observeVolumeUsers: ports.observeVolumeUsers, captureHelperScope: ports.captureHelperScope, observePreviousAccount: ports.observePreviousAccount });
    // @ts-expect-error Required primitive must be callable.
    createLabStateOwnershipPreparation({ ...ports, applyOwnership: {} });
    // @ts-expect-error Scope cannot be fabricated structurally from argv.
    createLabStateOwnershipPreparation({ ...ports, captureHelperScope: () => ["run", "--rm"] });
    // @ts-expect-error Scope requires trusted native evidence.
    ports.observePreviousAccount({}, "image");
    // @ts-expect-error A string is not a scope.
    ports.observePreviousAccount("run", "image");
    // @ts-expect-error A native volume command result is not a presence fact.
    createLabStateOwnershipPreparation({ ...ports, observeVolume: () => ({ status: 0, stdout: "volume" }) });
    // @ts-expect-error A native users command result is not a use fact.
    createLabStateOwnershipPreparation({ ...ports, observeVolumeUsers: () => ({ status: 0, stdout: "" }) });
    // @ts-expect-error The account adapter must decode a native result before crossing inward.
    createLabStateOwnershipPreparation({ ...ports, observePreviousAccount: () => ({ status: 0, stdout: "1:2" }) });
    // @ts-expect-error A zero native exit is not an ownership confirmation fact.
    createLabStateOwnershipPreparation({ ...ports, applyOwnership: () => ({ status: 0 }) });
    // @ts-expect-error Unknown presence must use the explicit unavailable state.
    createLabStateOwnershipPreparation({ ...ports, observeVolume: () => "unknown" });
    // @ts-expect-error Known prior ownership requires a numeric principal.
    createLabStateOwnershipPreparation({ ...ports, observePreviousAccount: () => ({ kind: "known" }) });
    // @ts-expect-error Generic shell/argv is not an ownership intent.
    ports.applyOwnership(scope, "volume", "image", principal, { kind: "exec", argv: ["rm"] });
    // @ts-expect-error Migration needs both proven prior numeric principals.
    ports.applyOwnership(scope, "volume", "image", principal, { kind: "migrate", oldUid: 1 });
    // @ts-expect-error Principals are numeric.
    app.run("volume", "image", { uid: "1", gid: 2 });
    // @ts-expect-error Preparation requires image and principal.
    app.run("volume");
    // @ts-expect-error Preparation is synchronous.
    const promise: Promise<undefined> = app.run("volume", "image", principal);
    // @ts-expect-error Successful preparation has no boolean result.
    const success: boolean = app.run("volume", "image", principal);
    // @ts-expect-error Public full ContainerIdentity contract remains required.
    prepareLabStateOwnership("volume", "image", principal);
    // @ts-expect-error Public return remains void.
    const publicPromise: Promise<void> = prepareLabStateOwnership("volume", "image", full);
    void [promise, success, publicPromise];
}
void compileContracts;

describe("Lab ownership strict synchronous contracts", () => {
    it("completes absent-volume preparation synchronously using no native defaults", () => {
        const app = createLabStateOwnershipPreparation({
            normalizeImageId: image => image,
            observeVolume: () => "absent",
            observeVolumeUsers: () => { throw new Error("must not observe absent volume"); },
            captureHelperScope: () => { throw new Error("must not capture absent volume"); },
            observePreviousAccount: () => { throw new Error("must not probe absent volume"); },
            applyOwnership: () => { throw new Error("must not mutate absent volume"); },
        });
        expect(app.run("volume", "image", { uid: 1, gid: 2 })).toBeUndefined();
    });
});
