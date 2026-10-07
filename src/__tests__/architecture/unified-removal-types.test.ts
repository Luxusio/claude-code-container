import { describe, expect, it } from "vitest";
import { createUnifiedWorkspaceRemoval } from "../../application/workspace/unified-removal.js";
import type { UnifiedRemovalPorts, UnifiedRemovalRequest, RemovalStatus, RootStatusTarget } from "../../ports/workspace/unified-removal.js";
import type { RemoveResult } from "../../domain/workspace/removal-result.js";
import type { RemoveResult as LegacyResult } from "../../worktree.js";
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type RequiredKeys<T> = {
    [K in keyof T]-?: {} extends Pick<T, K> ? never : K;
}[keyof T];
type Names = "scanSource" | "destinationPath" | "pathExists" | "captureSourceIdentity" | "captureDestinationFence" | "assertWorkspaceIdentity" | "assertSourceIdentity" | "assertDestinationFence" | "metadataExists" | "metadataKind" | "unreachableRecordedPath" | "isTrackedGitlink" | "inspectNestedStatus" | "worktreeMatches" | "pathContent" | "unmanagedPathRefusal" | "unreadablePathRefusal" | "captureDirectoryIdentity" | "captureRegistration" | "removeRegisteredNested" | "relayEntryError" | "assertRootOwnership" | "inspectRootBranch" | "inspectRootStatus" | "workspaceName" | "sourceName" | "removeRegisteredRoot";
function contracts(ports: UnifiedRemovalPorts<number, symbol, boolean, string, bigint>, request: UnifiedRemovalRequest, result: RemoveResult) {
    const remove = createUnifiedWorkspaceRemoval(ports);
    const proof: [
        Equal<LegacyResult, RemoveResult>,
        Equal<ReturnType<typeof remove>, RemoveResult>,
        Equal<Parameters<typeof remove>, [
            request: UnifiedRemovalRequest,
            workspaceIdentity: number
        ]>,
        Equal<RequiredKeys<typeof ports>, Names>,
        Equal<keyof typeof ports, Names>,
        Equal<RequiredKeys<UnifiedRemovalRequest>, "repositoryPath" | "destinationPath" | "branch" | "options">
    ] = [true, true, true, true, true, true];
    void proof;
    result.removed = [];
    result.errors.push("mutable");
    // @ts-expect-error Required original options reference.
    remove({
        repositoryPath: "source",
        destinationPath: "destination",
        branch: "topic"
    }, 0);
    // @ts-expect-error Identity is required.
    remove(request);
    // @ts-expect-error All semantic ports are required.
    createUnifiedWorkspaceRemoval({});
    // @ts-expect-error No ambient default.
    createUnifiedWorkspaceRemoval();
    // @ts-expect-error Source identity is truthy object or symbol, unlike other proofs.
    const falsySource: UnifiedRemovalPorts<number, boolean, boolean, string, bigint> = ports;
    void falsySource;
    createUnifiedWorkspaceRemoval({
        ...ports,
        // @ts-expect-error Scan observations are synchronous.
        scanSource: async () => []
    });
    createUnifiedWorkspaceRemoval({
        ...ports,
        // @ts-expect-error Status observations are synchronous.
        inspectNestedStatus: async () => ({
            kind: "observed",
            readContent: () => ""
        })
    });
    const asyncStatus: RemovalStatus = {
        kind: "observed",
        // @ts-expect-error Lazy observation operands are synchronous.
        readContent: async () => ""
    };
    void asyncStatus;
    createUnifiedWorkspaceRemoval<number, symbol, boolean, string, bigint>({
        ...ports,
        // @ts-expect-error Explicit registration receipt cannot be substituted by a promise.
        captureRegistration: async () => "receipt"
    });
    const target: RootStatusTarget<bigint> = {
        kind: "quarantined",
        // @ts-expect-error Opaque quarantine authority retains its declared type.
        root: "native-path"
    };
    void target;
    // @ts-expect-error Request fields are readonly.
    request.options = undefined;
    for (const name of ["scanSource", "destinationPath", "pathExists", "captureSourceIdentity", "captureDestinationFence", "assertWorkspaceIdentity", "assertSourceIdentity", "assertDestinationFence", "metadataExists", "metadataKind", "unreachableRecordedPath", "isTrackedGitlink", "inspectNestedStatus", "worktreeMatches", "pathContent", "unmanagedPathRefusal", "unreadablePathRefusal", "captureDirectoryIdentity", "captureRegistration", "removeRegisteredNested", "relayEntryError", "assertRootOwnership", "inspectRootBranch", "inspectRootStatus", "workspaceName", "sourceName", "removeRegisteredRoot"] as const) {
        // @ts-expect-error Every port is readonly.
        ports[name] = ports[name];
    }
    // @ts-expect-error Registration proof has no native structural fields.
    ports.captureRegistration(request, "source", "destination", 0).expectedBranchOid;
}
void contracts;
describe("unified removal declaration contract", () => {
    it("keeps required options explicitly undefined in requests", () => {
        const request: UnifiedRemovalRequest = {
            repositoryPath: "source",
            destinationPath: "destination",
            branch: "topic",
            options: undefined
        };
        expect(Object.hasOwn(request, "options")).toBe(true);
    });
});
