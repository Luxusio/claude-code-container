import { describe, expect, it } from "vitest";
import { createMultiWorkspaceRemoval } from "../../application/workspace/multi-removal.js";
import type { MultiRemovalPorts, MultiRemovalRequest } from "../../ports/workspace/multi-removal.js";
import type { RemoveResult } from "../../domain/workspace/removal-result.js";
import type { RemoveResult as LegacyResult } from "../../worktree.js";
import { removeWorkspace } from "../../worktree.js";
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type RequiredKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T];
type Names = "scanSource" | "destinationPath" | "pathExists" | "assertWorkspaceIdentity" | "worktreeMatches" | "unmanagedPathRefusal" | "captureWorktreeIdentity" | "captureRegistration" | "removeRegisteredEntry" | "scanWorkspace" | "captureCopiedIdentity" | "quarantineCopiedEntry" | "remainingNames" | "quarantineWorkspace" | "relayEntryError";
function contracts(ports: MultiRemovalPorts<number, boolean, symbol>, request: MultiRemovalRequest, result: RemoveResult) {
    const remove = createMultiWorkspaceRemoval(ports);
    const proof: [Equal<LegacyResult, RemoveResult>, Equal<ReturnType<typeof remove>, RemoveResult>, Equal<ReturnType<typeof removeWorkspace>, RemoveResult>, Equal<Parameters<typeof remove>, [request: MultiRemovalRequest, identity: number]>, Equal<RequiredKeys<typeof ports>, Names>, Equal<keyof typeof ports, Names>, Equal<RequiredKeys<MultiRemovalRequest>, "repositoryPath" | "destinationPath" | "branch" | "options">] = [true, true, true, true, true, true, true];
    void proof;
    result.removed = []; result.errors = []; result.removed.push("mutable"); result.errors.push("mutable");
    // @ts-expect-error Required options preserve undefined explicitly.
    remove({ repositoryPath: "source", destinationPath: "destination", branch: "topic" }, 0);
    // @ts-expect-error Workspace identity is mandatory.
    remove(request);
    // @ts-expect-error Every port is mandatory.
    createMultiWorkspaceRemoval({});
    // @ts-expect-error Factory has no ambient native default.
    createMultiWorkspaceRemoval();
    // @ts-expect-error Scan must be synchronous.
    createMultiWorkspaceRemoval({ ...ports, scanSource: async () => [] });
    // @ts-expect-error Declared proof identity must be returned synchronously.
    createMultiWorkspaceRemoval<number, boolean, symbol>({ ...ports, captureRegistration: async () => Symbol() });
    // @ts-expect-error Request is readonly.
    request.options = undefined;
    for (const name of ["scanSource", "destinationPath", "pathExists", "assertWorkspaceIdentity", "worktreeMatches", "unmanagedPathRefusal", "captureWorktreeIdentity", "captureRegistration", "removeRegisteredEntry", "scanWorkspace", "captureCopiedIdentity", "quarantineCopiedEntry", "remainingNames", "quarantineWorkspace", "relayEntryError"] as const) {
        // @ts-expect-error Every semantic port is readonly.
        ports[name] = ports[name];
    }
    // @ts-expect-error Native registration structure is opaque.
    ports.captureRegistration(request, "source", "destination", false).expectedBranchOid;
}
void contracts;
describe("multi removal public type parity", () => {
    it("accepts falsy opaque identities without application interpretation", () => {
        const ports: MultiRemovalPorts<number, boolean, number> = {
            scanSource: () => [{ name: "repo", path: "source/repo", isGitRepo: true }], destinationPath: () => "destination/repo", pathExists: path => path !== "destination", assertWorkspaceIdentity: (_r, identity) => { expect(identity).toBe(0); }, worktreeMatches: () => true, unmanagedPathRefusal: () => "refused", captureWorktreeIdentity: () => false,
            captureRegistration: (_r, _s, _d, identity) => { expect(identity).toBe(false); return 0; }, removeRegisteredEntry: (_r, _s, _d, identity, receipt) => { expect(identity).toBe(false); expect(receipt).toBe(0); }, scanWorkspace: () => [], captureCopiedIdentity: () => false, quarantineCopiedEntry: () => {}, remainingNames: () => [], quarantineWorkspace: () => {}, relayEntryError: () => "error",
        };
        expect(createMultiWorkspaceRemoval(ports)({ repositoryPath: "source", destinationPath: "destination", branch: "topic", options: undefined }, 0)).toEqual({ removed: ["repo"], errors: [] });
    });
});
