import { describe, expect, it } from "vitest";
import type { SpawnSyncReturns } from "node:child_process";
import { createLabStateOwnershipPreparation } from "../../application/container/lab-state-ownership.js";
import type { LabOwnershipHelperScope, LabStateCommandObservation, LabStateOwnershipObservation, LabStatePrincipal } from "../../domain/container/lab-state-ownership.js";
import type { LabStateOwnershipPorts } from "../../ports/container/lab-state-ownership.js";
import { prepareLabStateOwnership } from "../../lab-state-ownership.js";
import type { ContainerIdentity } from "../../container-identity.js";

function compileContracts(ports: LabStateOwnershipPorts, scope: LabOwnershipHelperScope, principal: LabStatePrincipal, native: SpawnSyncReturns<string>, full: ContainerIdentity) {
    const app = createLabStateOwnershipPreparation(ports);
    const result: undefined = app.run("volume", "image", principal, "old");
    const publicResult: void = prepareLabStateOwnership("volume", "image", full);
    const listed: LabStateCommandObservation = ports.listVolumeNames();
    const applied: LabStateOwnershipObservation = ports.applyOwnership(scope, "volume", "image", principal, { kind: "verify" });
    createLabStateOwnershipPreparation({ ...ports, listVolumeNames: () => native, applyOwnership: () => native });
    void [result, publicResult, listed, applied];
    // @ts-expect-error Explicit ports are required.
    createLabStateOwnershipPreparation();
    // @ts-expect-error Undefined supplies no native defaults.
    createLabStateOwnershipPreparation(undefined);
    // @ts-expect-error Normalization must be synchronous.
    createLabStateOwnershipPreparation({ ...ports, normalizeImageId: async () => "image" });
    // @ts-expect-error Listing must be synchronous.
    createLabStateOwnershipPreparation({ ...ports, listVolumeNames: async () => native });
    // @ts-expect-error Users must be synchronous.
    createLabStateOwnershipPreparation({ ...ports, observeVolumeUsers: async () => native });
    // @ts-expect-error Scope capture must be synchronous.
    createLabStateOwnershipPreparation({ ...ports, captureHelperScope: async () => scope });
    // @ts-expect-error Account observation must be synchronous.
    createLabStateOwnershipPreparation({ ...ports, observePreviousAccount: async () => native });
    // @ts-expect-error Ownership returns consumed synchronous facts, not a Promise.
    createLabStateOwnershipPreparation({ ...ports, applyOwnership: async () => ({ status: 0 }) });
    // @ts-expect-error The consumed final result cannot be discarded as void.
    createLabStateOwnershipPreparation({ ...ports, applyOwnership: (): void => {} });
    // @ts-expect-error The consumed final result cannot be discarded as undefined.
    createLabStateOwnershipPreparation({ ...ports, applyOwnership: () => undefined });
    // @ts-expect-error Required primitive cannot be omitted.
    createLabStateOwnershipPreparation({ normalizeImageId: ports.normalizeImageId, listVolumeNames: ports.listVolumeNames, observeVolumeUsers: ports.observeVolumeUsers, captureHelperScope: ports.captureHelperScope, observePreviousAccount: ports.observePreviousAccount });
    // @ts-expect-error Required primitive must be callable.
    createLabStateOwnershipPreparation({ ...ports, applyOwnership: {} });
    // @ts-expect-error Scope cannot be fabricated structurally from argv.
    createLabStateOwnershipPreparation({ ...ports, captureHelperScope: () => ["run", "--rm"] });
    // @ts-expect-error Scope requires trusted native evidence.
    ports.observePreviousAccount({}, "image");
    // @ts-expect-error A string is not a scope.
    ports.observePreviousAccount("run", "image");
    // @ts-expect-error Observation status remains number or null.
    createLabStateOwnershipPreparation({ ...ports, listVolumeNames: () => ({ status: "0", stdout: "volume" }) });
    // @ts-expect-error Command stdout is required.
    createLabStateOwnershipPreparation({ ...ports, listVolumeNames: () => ({ status: 0 }) });
    // @ts-expect-error Final status is required.
    createLabStateOwnershipPreparation({ ...ports, applyOwnership: () => ({ error: undefined }) });
    // @ts-expect-error Final status remains number or null.
    createLabStateOwnershipPreparation({ ...ports, applyOwnership: () => ({ status: undefined }) });
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
            listVolumeNames: () => ({ status: 0, stdout: "" }),
            observeVolumeUsers: () => { throw new Error("must not observe absent volume"); },
            captureHelperScope: () => { throw new Error("must not capture absent volume"); },
            observePreviousAccount: () => { throw new Error("must not probe absent volume"); },
            applyOwnership: () => { throw new Error("must not mutate absent volume"); },
        });
        expect(app.run("volume", "image", { uid: 1, gid: 2 })).toBeUndefined();
    });
});
