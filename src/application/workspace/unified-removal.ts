import type { RemoveResult } from "../../domain/workspace/removal-result.js";
import type { GitMetadataKind, UnifiedRemovalPorts, UnifiedRemovalRequest } from "../../ports/workspace/unified-removal.js";

export type { RemoveResult } from "../../domain/workspace/removal-result.js";
export type { BranchObservation, GitMetadataKind, PathContent, RemovalStatus, RootStatusTarget, UnifiedRemovalPorts, UnifiedRemovalRequest } from "../../ports/workspace/unified-removal.js";

export function createUnifiedWorkspaceRemoval<D, S extends object | symbol, F, R, Q>(
    ports: UnifiedRemovalPorts<D, S, F, R, Q>,
): (request: UnifiedRemovalRequest, workspaceIdentity: D) => RemoveResult {
    for (const name of [
        "scanSource",
        "destinationPath",
        "pathExists",
        "captureSourceIdentity",
        "captureDestinationFence",
        "assertWorkspaceIdentity",
        "assertSourceIdentity",
        "assertDestinationFence",
        "metadataExists",
        "metadataKind",
        "unreachableRecordedPath",
        "isTrackedGitlink",
        "inspectNestedStatus",
        "worktreeMatches",
        "pathContent",
        "unmanagedPathRefusal",
        "unreadablePathRefusal",
        "captureDirectoryIdentity",
        "captureRegistration",
        "removeRegisteredNested",
        "relayEntryError",
        "assertRootOwnership",
        "inspectRootBranch",
        "inspectRootStatus",
        "workspaceName",
        "sourceName",
        "removeRegisteredRoot",
    ] as const) {
        if (typeof ports?.[name] !== "function") {
            throw new TypeError(`Unified workspace removal requires a callable ${name} port.`);
        }
    }

    return (request, workspaceIdentity) => {
        const removed: string[] = [];
        const errors: string[] = [];

        const sourceEntries = ports.scanSource(request);
        const rootStatus = ports.inspectRootStatus(request, sourceEntries, { kind: "workspace", stage: "pre" }, "ordinary");
        if (rootStatus.kind === "failed") {
            return {
                removed,
                errors: [
                    rootStatus.readDetail()
                    || "unable to inspect root worktree status",
                ],
            };
        }
        if (request.options?.force !== true && rootStatus.readContent()) {
            return {
                removed,
                errors: [
                    "root worktree contains modified or untracked files, use --force to delete it",
                ],
            };
        }
        const ignoredRootStatus = ports.inspectRootStatus(request, sourceEntries, { kind: "workspace", stage: "pre" }, "ignored");
        if (ignoredRootStatus.kind === "failed") {
            return {
                removed,
                errors: [
                    ignoredRootStatus.readDetail()
                    || "unable to inspect ignored root worktree content",
                ],
            };
        }
        if (request.options?.force !== true && ignoredRootStatus.readContent()) {
            return {
                removed,
                errors: [
                    "root worktree contains ignored files, use --force to delete it",
                ],
            };
        }

        // Remove every linked nested worktree before removing the parent.
        const workspaceRepositoryEntries = sourceEntries.map((sourceEntry) => ({
            ...sourceEntry,
            path: ports.destinationPath(request, sourceEntry.name),
        }));
        const sourceRepositoryIdentities = new Map(
            sourceEntries
                .filter((entry) => entry.isGitRepo)
                .map((entry) => [
                    entry.name,
                    ports.captureSourceIdentity(entry.path),
                ]),
        );
        for (const entry of [...sourceEntries].reverse()) {
            if (!entry.isGitRepo) continue;

            const nestedPath = ports.destinationPath(request, entry.name);
            if (!ports.pathExists(nestedPath)) continue;
            const sourceIdentity = sourceRepositoryIdentities.get(entry.name);
            if (!sourceIdentity) {
                errors.push(`${entry.name}: missing source repository fence`);
                continue;
            }
            let destinationFence: F;
            try {
                destinationFence = ports.captureDestinationFence(request, nestedPath);
            } catch (error) {
                errors.push(`${entry.name}: ${(error as Error).message}`);
                continue;
            }
            const operationGuard = (): void => {
                ports.assertWorkspaceIdentity(request, workspaceIdentity);
                ports.assertSourceIdentity(entry.path, sourceIdentity);
                ports.assertDestinationFence(request, nestedPath, destinationFence);
            };
            operationGuard();
            // `gitLinkKind` THROWS on metadata that names a path it cannot resolve here — which
            // is the container boundary, the state this whole task exists to handle. Calling it
            // raw made `ccc rm -f` die with `Unable to inspect worktree common directory '<path>'`
            // and exit 1, on the exact workspace whose no-force refusal had just told the operator
            // to re-run with -f. A message that sends someone to a command that crashes is the
            // defect this file keeps relearning, so the classification is answered rather than
            // raised: unreadable-from-here is not a tracked gitlink, and the checks below decide
            // what happens to it.
            let nestedKind: GitMetadataKind | null = null;
            if (ports.metadataExists(nestedPath)) {
                try {
                    nestedKind = ports.metadataKind(nestedPath);
                } catch (error) {
                    if (ports.unreachableRecordedPath(error) === null) throw error;
                }
            }
            if (nestedKind === "gitlink"
                && ports.isTrackedGitlink(
                    request,
                    workspaceRepositoryEntries,
                    {
                        ...entry,
                        path: nestedPath,
                    },
                )) {
                const nestedStatus = ports.inspectNestedStatus(nestedPath);
                if (nestedStatus.kind === "failed") {
                    errors.push(
                        `${entry.name}: ${
                            nestedStatus.readDetail()
                            || "unable to inspect tracked submodule status"
                        }`,
                    );
                } else if (
                    request.options?.force !== true
                    && nestedStatus.readContent()
                ) {
                    errors.push(
                        `${entry.name}: tracked submodule contains modified or untracked files, use --force to delete it`,
                    );
                }
                continue;
            }
            if (!ports.worktreeMatches(entry.path, nestedPath)) {
                // The SECOND veto. Lifting the first one and stopping there left `ccc rm -f`
                // refusing exactly the shape the change was written for: a tracked submodule's
                // path holding a directory with files and no `.git`. Measured before and after
                // that change, the result was identical — blocked, and now blocked with a
                // sentence that named no path, no cause and no remedy.
                //
                // There is no registration to deregister here, only files. Under -f the
                // workspace deletion below takes them with everything else, which is what -f
                // means. Without it, refuse in the same words as the other guard: naming the
                // path and naming -f is the whole safety story.
                const content = ports.pathContent(nestedPath);
                // One state survives -f, and not as policy. A directory with no read bit cannot
                // be enumerated, so `rm -rf` cannot empty it — measured. Letting -f through
                // anyway does not delete the workspace; it deletes as far as this directory and
                // stops, and what it gets through first is the workspace root: `.git`, the
                // tracked files, and any uncommitted work the operator had there. Measured on
                // this exact fixture, the operator was left with a gutted directory that ccc then
                // refused to touch at all, from a command that had printed an error and looked
                // like it had done nothing.
                //
                // So the refusal here is arithmetic, not a veto: the sequence cannot succeed, and
                // starting it costs work. The owner's decision is untouched — unmanaged is still
                // deletable under -f everywhere deletion can actually happen.
                if (request.options?.force !== true || content === "unreadable") {
                    errors.push(
                        content === "unreadable"
                            ? ports.unreadablePathRefusal(nestedPath)
                            : ports.unmanagedPathRefusal(nestedPath, content),
                    );
                }
                continue;
            }
            const nestedIdentity = ports.captureDirectoryIdentity(nestedPath);
            try {
                operationGuard();
                const registrationFence = ports.captureRegistration(
                    request,
                    entry.path,
                    nestedPath,
                    nestedIdentity,
                );
                ports.removeRegisteredNested(
                    request,
                    entry.path,
                    nestedPath,
                    nestedIdentity,
                    registrationFence,
                    request.options?.force === true,
                    sourceIdentity,
                    operationGuard,
                );
                operationGuard();
                removed.push(entry.name);
            } catch (error) {
                errors.push(ports.relayEntryError(entry.name, nestedPath, error));
            }
        }

        if (errors.length > 0) return { removed, errors };
        ports.assertWorkspaceIdentity(request, workspaceIdentity);
        ports.assertRootOwnership(request);
        const branchResult = ports.inspectRootBranch(request);
        const observedBranch = branchResult.observedBranch;
        if (branchResult.failed || observedBranch !== request.branch) {
            throw new Error(
                observedBranch
                    ? `Workspace belongs to branch '${observedBranch}', not '${request.branch}'.`
                    : `Unable to determine worktree branch in '${ports.workspaceName(request)}'.`,
            );
        }
        const finalRootStatus = ports.inspectRootStatus(request, sourceEntries, { kind: "workspace", stage: "final" }, "ordinary");
        if (finalRootStatus.kind === "failed") {
            return {
                removed,
                errors: [
                    finalRootStatus.readDetail()
                    || "unable to re-inspect root worktree status",
                ],
            };
        }
        if (request.options?.force !== true && finalRootStatus.readContent()) {
            return {
                removed,
                errors: [
                    "root worktree changed during removal, use --force to delete it",
                ],
            };
        }
        const finalIgnoredRootStatus = ports.inspectRootStatus(request, sourceEntries, { kind: "workspace", stage: "final" }, "ignored");
        if (finalIgnoredRootStatus.kind === "failed") {
            return {
                removed,
                errors: [
                    finalIgnoredRootStatus.readDetail()
                    || "unable to re-inspect ignored root worktree content",
                ],
            };
        }
        if (
            request.options?.force !== true
            && finalIgnoredRootStatus.readContent()
        ) {
            return {
                removed,
                errors: [
                    "root worktree gained ignored files during removal, use --force to delete it",
                ],
            };
        }
        try {
            const registrationFence = ports.captureRegistration(
                request,
                request.repositoryPath,
                request.destinationPath,
                workspaceIdentity,
            );
            ports.removeRegisteredRoot(
                request,
                workspaceIdentity,
                registrationFence,
                request.options?.force === true
                    ? undefined
                    : (quarantinedPath) => {
                        const quarantinedStatus = ports.inspectRootStatus(request, sourceEntries, { kind: "quarantined", root: quarantinedPath }, "ordinary");
                        if (
                            quarantinedStatus.kind === "failed"
                        ) {
                            throw new Error(
                                quarantinedStatus.readDetail()
                                || "unable to inspect quarantined root worktree status",
                            );
                        }
                        if (quarantinedStatus.readContent()) {
                            throw new Error(
                                "root worktree changed during removal, use --force to delete it",
                            );
                        }
                        const quarantinedIgnoredStatus = ports.inspectRootStatus(request, sourceEntries, { kind: "quarantined", root: quarantinedPath }, "ignored");
                        if (
                            quarantinedIgnoredStatus.kind === "failed"
                        ) {
                            throw new Error(
                                quarantinedIgnoredStatus.readDetail()
                                || "unable to inspect quarantined ignored root worktree content",
                            );
                        }
                        if (quarantinedIgnoredStatus.readContent()) {
                            throw new Error(
                                "root worktree gained ignored files during removal, use --force to delete it",
                            );
                        }
                    },
            );
            removed.push(ports.sourceName(request));
        } catch (error) {
            errors.push((error as Error).message);
        }

        return { removed, errors };
    };
}
