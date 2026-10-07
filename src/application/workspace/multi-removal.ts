import type { RemoveResult } from "../../domain/workspace/removal-result.js";
import type { MultiRemovalPorts, MultiRemovalRequest } from "../../ports/workspace/multi-removal.js";

export type { RemoveResult } from "../../domain/workspace/removal-result.js";
export type { MultiRemovalPorts, MultiRemovalRequest } from "../../ports/workspace/multi-removal.js";

export function createMultiWorkspaceRemoval<WorkspaceIdentity, EntryIdentity, Registration>(
    ports: MultiRemovalPorts<WorkspaceIdentity, EntryIdentity, Registration>,
): (request: MultiRemovalRequest, workspaceIdentity: WorkspaceIdentity) => RemoveResult {
    for (const name of [
        "scanSource", "destinationPath", "pathExists", "assertWorkspaceIdentity",
        "worktreeMatches", "unmanagedPathRefusal", "captureWorktreeIdentity",
        "captureRegistration", "removeRegisteredEntry", "scanWorkspace",
        "captureCopiedIdentity", "quarantineCopiedEntry", "remainingNames",
        "quarantineWorkspace", "relayEntryError",
    ] as const) {
        if (typeof ports?.[name] !== "function") {
            throw new TypeError(`Multi workspace removal requires a callable ${name} port.`);
        }
    }

    return (request, workspaceIdentity) => {
        const removed: string[] = [];
        const errors: string[] = [];

        const sourceEntries = ports.scanSource(request);

        for (const entry of sourceEntries) {
            const wsEntryPath = ports.destinationPath(request, entry.name);
            if (!ports.pathExists(wsEntryPath)) {
                continue;
            }

            if (entry.isGitRepo) {
                ports.assertWorkspaceIdentity(request, workspaceIdentity);
                if (!ports.worktreeMatches(entry.path, wsEntryPath)) {
                    // Multi-repo mode's copy of the veto above, gated the same way for symmetry —
                    // but say plainly that this is not reachable today for the shape it was
                    // written for. `assertWorkspaceOwnership`, from `assertWorkspaceBranch`,
                    // raises `Workspace repository '<name>' is not owned by its source
                    // repository` on BOTH sides of the flag before this loop runs, so multi-repo
                    // never produces the refusal below and -f never gets here. Measured, and
                    // pinned by a test; relaxing that assert is a separate decision from the one
                    // this gate implements.
                    if (request.options?.force !== true) {
                        errors.push(ports.unmanagedPathRefusal(wsEntryPath));
                    }
                    continue;
                }
                const entryIdentity = ports.captureWorktreeIdentity(wsEntryPath);
                try {
                    const registrationFence = ports.captureRegistration(
                        request,
                        entry.path,
                        wsEntryPath,
                        entryIdentity,
                    );
                    ports.removeRegisteredEntry(
                        request,
                        entry.path,
                        wsEntryPath,
                        entryIdentity,
                        registrationFence,
                        request.options?.force === true,
                    );
                    removed.push(entry.name);
                } catch (error) {
                    errors.push(ports.relayEntryError(entry.name, wsEntryPath, error));
                }
            } else {
                try {
                    ports.assertWorkspaceIdentity(request, workspaceIdentity);
                    const current = ports.scanWorkspace(request)
                        .find((candidate) => candidate.name === entry.name);
                    if (current?.isGitRepo) {
                        errors.push(`${entry.name}: became a Git repository before deletion`);
                        continue;
                    }
                    const entryIdentity = ports.captureCopiedIdentity(wsEntryPath);
                    ports.quarantineCopiedEntry(request, wsEntryPath, entryIdentity);
                    if (ports.pathExists(wsEntryPath)) {
                        errors.push(`${entry.name}: path was recreated during deletion`);
                        continue;
                    }
                    removed.push(entry.name);
                } catch (error) {
                    errors.push(ports.relayEntryError(entry.name, wsEntryPath, error));
                }
            }
        }

        // Try to remove the workspace directory itself
        try {
            if (ports.pathExists(request.destinationPath)) {
                ports.assertWorkspaceIdentity(request, workspaceIdentity);
                if (errors.length > 0) return { removed, errors };
                const remaining = ports.remainingNames(request);
                if (remaining.length === 0) {
                    ports.quarantineWorkspace(request, workspaceIdentity);
                } else if (request.options?.force) {
                    const remainingRepositories = ports.scanWorkspace(request)
                        .filter((entry) => entry.isGitRepo);
                    if (remainingRepositories.length > 0) {
                        errors.push(
                            `Workspace ownership changed before deletion (${remainingRepositories.map(({ name }) => name).join(", ")}).`,
                        );
                        return { removed, errors };
                    }
                    ports.quarantineWorkspace(request, workspaceIdentity);
                } else {
                    errors.push(
                        `Workspace directory not empty (${remaining.length} items remaining). Use -f to force.`,
                    );
                }
            }
        } catch (e) {
            errors.push(
                `Failed to remove workspace directory: ${(e as Error).message}`,
            );
        }

        return { removed, errors };
    };
}
