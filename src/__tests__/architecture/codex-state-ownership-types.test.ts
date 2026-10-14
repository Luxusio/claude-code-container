import { expect, it } from "vitest";
import { createCodexStateOwnershipMigration } from "../../application/credentials/codex-state-ownership.js";
import type { CodexStateOwnershipPorts } from "../../ports/credentials/codex-state-ownership.js";
import type { CodexStateAccount, CodexStatePrincipal, PreviousCodexStateContainer } from "../../domain/credentials/codex-state-ownership.js";
import type * as Native from "../../codex-state-ownership.js";
function contracts(ports: CodexStateOwnershipPorts, previous: PreviousCodexStateContainer, principal: CodexStatePrincipal, native: typeof Native,
    publicPrevious: Parameters<typeof Native.prepareCodexStateOwnership>[0]) {
    const app = createCodexStateOwnershipMigration(ports);
    const observePrevious = () => previous;
    const done: undefined = app.run(observePrevious, "image", principal);
    const publicDone: void = native.prepareCodexStateOwnership(publicPrevious, "image", principal, "profile", source => Boolean(source));
    const optionalUid: number | undefined = ports.effectiveUid();
    const account: CodexStateAccount = ports.previousAccount("image");
    // @ts-expect-error Factory requires explicit capabilities.
    createCodexStateOwnershipMigration();
    // @ts-expect-error Missing managed root.
    createCodexStateOwnershipMigration({ ...ports, managedRoot: undefined });
    // @ts-expect-error Missing native effect.
    createCodexStateOwnershipMigration({ ...ports, migrate: undefined });
    // @ts-expect-error Semantic account observation is required.
    createCodexStateOwnershipMigration({ ...ports, previousAccount: undefined });
    // @ts-expect-error Semantic active-container observation is required.
    createCodexStateOwnershipMigration({ ...ports, activeContainers: undefined });
    // @ts-expect-error Noncallable observation.
    createCodexStateOwnershipMigration({ ...ports, directory: 0 });
    // @ts-expect-error No native argv contract enters the core.
    ports.run(["docker", "chown"]);
    // @ts-expect-error Native ps text is not an inward port.
    ports.activeIds();
    // @ts-expect-error Native inspect text is not an inward port.
    ports.inspectActive(["a"]);
    // @ts-expect-error Host facts are synchronous.
    createCodexStateOwnershipMigration({ ...ports, runtime: async () => ports.runtime() });
    // @ts-expect-error Optional principal facts are synchronous.
    createCodexStateOwnershipMigration({ ...ports, effectiveUid: async () => 1000 });
    // @ts-expect-error Directory observations cannot be promises.
    createCodexStateOwnershipMigration({ ...ports, directory: async path => ports.directory(path) });
    // @ts-expect-error Old account observations are decoded facts, not UID:GID text.
    createCodexStateOwnershipMigration({ ...ports, previousAccount: () => "1001:1002" });
    // @ts-expect-error Semantic account facts are synchronous.
    createCodexStateOwnershipMigration({ ...ports, previousAccount: async () => ({ uid: 1001, gid: 1002 }) });
    // @ts-expect-error Account numeric fields cannot be encoded strings.
    createCodexStateOwnershipMigration({ ...ports, previousAccount: () => ({ uid: "1001", gid: "1002" }) });
    // @ts-expect-error Active-container observations cannot be serialized JSON.
    createCodexStateOwnershipMigration({ ...ports, activeContainers: () => "[]" });
    // @ts-expect-error Active-container observations are synchronous.
    createCodexStateOwnershipMigration({ ...ports, activeContainers: async () => [] });
    // @ts-expect-error Bind source is mandatory in semantic mount facts.
    createCodexStateOwnershipMigration({ ...ports, activeContainers: () => [{ id: "a", mounts: [{ kind: "bind", destination: "" }] }] });
    // @ts-expect-error Effect must complete synchronously.
    createCodexStateOwnershipMigration({ ...ports, migrate: async () => undefined });
    // @ts-expect-error Permissive void does not prove completion.
    createCodexStateOwnershipMigration({ ...ports, migrate: (): void => {} });
    // @ts-expect-error Native effect cannot return an outcome.
    createCodexStateOwnershipMigration({ ...ports, migrate: () => "okay" });
    // @ts-expect-error Receipt identities are the original strings, not numeric coercions.
    ports.migrate("root", "image", "1", "2", "3", "4", { dev: 1, ino: "2" });
    // @ts-expect-error Identity is required.
    app.run(observePrevious, "image");
    // @ts-expect-error Image input must be a string.
    app.run(observePrevious, 1, principal);
    // @ts-expect-error Prior observation must be lazy so unsupported host mapping cannot read it.
    app.run(previous, "image", principal);
    // @ts-expect-error Prior observations must complete synchronously.
    app.run(async () => previous, "image", principal);
    // @ts-expect-error Native previous-container representation does not cross inward.
    app.run(() => publicPrevious, "image", principal);
    // @ts-expect-error Source proof remains a Boolean callback.
    app.run(observePrevious, "image", principal, undefined, async () => true);
    // @ts-expect-error Application is synchronous.
    const pending: Promise<void> = app.run(observePrevious, "image", principal);
    // @ts-expect-error Existing public void cannot become strict undefined.
    const stricter: undefined = native.prepareCodexStateOwnership(publicPrevious, "image", principal);
    void [done, publicDone, optionalUid, account, pending, stricter];
}
void contracts;
it("has no ambient defaults and keeps the application and lazy prior observation synchronous", () => {
    const app = createCodexStateOwnershipMigration({
        managedRoot: () => "/private", nestedContainerMarker: () => "", runtime: () => ({ rootless: false, flavor: "native" }),
        platform: () => "linux", effectiveUid: () => undefined, effectiveGid: () => undefined, normalizeImage: value => value,
        previousAccount: () => ({ uid: 1, gid: 2 }), directory: () => { throw new Error("unexpected directory effect"); },
        parent: path => path, activeContainers: () => [], isAbsolute: () => true, realpath: path => path,
        separator: "/", migrate: () => undefined,
    });
    expect(app.run(() => { throw new Error("unexpected prior observation"); }, "unused", { uid: 1, gid: 1, mapping: "desktop", contractVersion: "1" })).toBeUndefined();
});
