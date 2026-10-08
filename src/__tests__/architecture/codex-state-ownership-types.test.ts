import { expect, it } from "vitest";
import { createCodexStateOwnershipMigration } from "../../application/credentials/codex-state-ownership.js";
import type { CodexStateOwnershipPorts } from "../../ports/credentials/codex-state-ownership.js";
import type { CodexStatePrincipal, PreviousCodexStateContainer } from "../../domain/credentials/codex-state-ownership.js";
import type * as Native from "../../codex-state-ownership.js";
function contracts(ports: CodexStateOwnershipPorts, previous: PreviousCodexStateContainer, principal: CodexStatePrincipal, native: typeof Native) {
    const app = createCodexStateOwnershipMigration(ports);
    const done: undefined = app.run(previous, "image", principal);
    const publicDone: void = native.prepareCodexStateOwnership(previous, "image", principal);
    const optionalUid: number | undefined = ports.effectiveUid();
    // @ts-expect-error Factory requires explicit capabilities.
    createCodexStateOwnershipMigration();
    // @ts-expect-error Missing managed root.
    createCodexStateOwnershipMigration({ ...ports, managedRoot: undefined });
    // @ts-expect-error Missing native effect.
    createCodexStateOwnershipMigration({ ...ports, migrate: undefined });
    // @ts-expect-error Noncallable observation.
    createCodexStateOwnershipMigration({ ...ports, directory: 0 });
    // @ts-expect-error No native argv contract enters the core.
    ports.run(["docker", "chown"]);
    // @ts-expect-error Host facts are synchronous.
    createCodexStateOwnershipMigration({ ...ports, runtime: async () => ports.runtime() });
    // @ts-expect-error Optional principal facts are synchronous.
    createCodexStateOwnershipMigration({ ...ports, effectiveUid: async () => 1000 });
    // @ts-expect-error Directory observations cannot be promises.
    createCodexStateOwnershipMigration({ ...ports, directory: async path => ports.directory(path) });
    // @ts-expect-error Old account observation must be a string.
    createCodexStateOwnershipMigration({ ...ports, previousAccount: () => 1000 });
    // @ts-expect-error Effect must complete synchronously.
    createCodexStateOwnershipMigration({ ...ports, migrate: async () => undefined });
    // @ts-expect-error Permissive void does not prove completion.
    createCodexStateOwnershipMigration({ ...ports, migrate: (): void => {} });
    // @ts-expect-error Native effect cannot return an outcome.
    createCodexStateOwnershipMigration({ ...ports, migrate: () => "okay" });
    // @ts-expect-error Receipt identities are the original strings, not numeric coercions.
    ports.migrate("root", "image", "1", "2", "3", "4", { dev: 1, ino: "2" });
    // @ts-expect-error Identity is required.
    app.run(previous, "image");
    // @ts-expect-error Image input must be a string.
    app.run(previous, 1, principal);
    // @ts-expect-error Source proof remains a Boolean callback.
    app.run(previous, "image", principal, undefined, async () => true);
    // @ts-expect-error Application is synchronous.
    const pending: Promise<void> = app.run(previous, "image", principal);
    // @ts-expect-error Existing public void cannot become strict undefined.
    const stricter: undefined = native.prepareCodexStateOwnership(previous, "image", principal);
    void [done, publicDone, optionalUid, pending, stricter];
}
void contracts;
it("has no ambient defaults and keeps the application synchronous", () => {
    const app = createCodexStateOwnershipMigration({
        managedRoot: () => "/private", nestedContainerMarker: () => "", runtime: () => ({ rootless: false, flavor: "native" }),
        platform: () => "linux", effectiveUid: () => undefined, effectiveGid: () => undefined, normalizeImage: value => value,
        previousAccount: () => "1:2", directory: () => { throw new Error("unexpected directory effect"); },
        parent: path => path, activeIds: () => "", inspectActive: () => "[]", isAbsolute: () => true, realpath: path => path,
        separator: "/", migrate: () => undefined,
    });
    expect(app.run({}, "unused", { uid: 1, gid: 1, mapping: "desktop", contractVersion: "1" })).toBeUndefined();
});
