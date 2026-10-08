import type { WorktreeRepoResult } from "../../domain/workspace/creation-result.js";
import type { WorkspaceRepairAuthority } from "../../domain/workspace/repair-authority.js";
import type { NestedWorkspaceRepairPorts } from "../../ports/workspace/repair-nested.js";

export function createNestedWorkspaceRepair<A extends WorkspaceRepairAuthority>(ports: NestedWorkspaceRepairPorts<A>) {
    type DirectoryIdentity = A["DirectoryIdentity"];
    type BranchCreationFence = A["BranchCreationFence"];
    type WorktreeRegistrationFence = A["WorktreeRegistrationFence"];
    type QuarantinedMissingWorktreeRegistration = A["QuarantinedMissingWorktreeRegistration"];
    function repairWorkspace(
        sourcePath: string,
        wsPath: string,
        branch: string,
    ): WorktreeRepoResult[] {
        const resolved = ports.resolve(sourcePath);

        // Only works in unified mode (source is a git repo)
        if (!ports.hasGitMetadata(resolved)) {
            return [];
        }
        const primarySource = ports.primarySourceRepositoryForWorktree(resolved);
        if (ports.gitLinkKind(ports.join(resolved, ".git")) === "worktree") {
            if (!primarySource) {
                throw new Error(
                    `Source worktree ownership could not be established: ${resolved}`,
                );
            }
            ports.assertWorkspaceOwnership(resolved, primarySource);
        }
        ports.assertWorkspaceRootOwnership(wsPath, resolved);

        // In unified mode, the root worktree does not populate nested repositories.
        // Initialized tracked submodules receive linked worktrees so the source
        // checkout is never reset by a submodule update. Ignored repositories are
        // intentionally outside the managed inventory.
        const created: WorktreeRepoResult[] = [];
        const rollbackOids = new Map<string, BranchCreationFence | null>();
        const registrationFences = new Map<string, WorktreeRegistrationFence>();
        const preservedStaleRegistrations: Array<{
            name: string;
            source: string;
            destination: string;
            registration: QuarantinedMissingWorktreeRegistration;
        }> = [];
        const removedEmptyDestinations: string[] = [];
        const createdParentDirectories = new Map<string, DirectoryIdentity>();
        const destinationFences = new Map<string, {
            workspace: DirectoryIdentity;
            parents: Array<{ path: string; identity: DirectoryIdentity }>;
        }>();
        const blockedRepositoryPrefixes: string[] = [];
        const sourceEntries = ports.scanUnifiedNestedRepositories(
            resolved,
            {
                strict: true,
                allowRegisteredWorktrees: Boolean(primarySource),
            },
        );
        const sourceRepositoryIdentities = new Map(
            sourceEntries
                .filter((entry) => entry.isGitRepo)
                .map((entry) => [
                    entry.name,
                    ports.captureNestedRepositoryIdentity(entry.path),
                ]),
        );

        let rollbackStarted = false;
        function rollbackNestedCreation(error: unknown): never {
            rollbackStarted = true;
            const rollbackErrors: string[] = [];
            for (const createdEntry of [...created].reverse()) {
                const sourceEntry = sourceEntries.find((entry) => (
                    entry.isGitRepo && entry.name === createdEntry.name
                ));
                const destination = ports.join(wsPath, createdEntry.name);
                if (!sourceEntry || !ports.pathExistsStrict(destination)) continue;
                const sourceIdentity = sourceRepositoryIdentities.get(createdEntry.name);
                if (!sourceIdentity) {
                    rollbackErrors.push(`${createdEntry.name}: missing source repository fence`);
                    continue;
                }
                const destinationFence = destinationFences.get(createdEntry.name);
                if (!destinationFence) {
                    rollbackErrors.push(`${createdEntry.name}: missing destination parent fence`);
                    continue;
                }
                try {
                    ports.assertNestedWorktreeDestinationFence(
                        wsPath,
                        destination,
                        destinationFence,
                    );
                } catch (rollbackError) {
                    rollbackErrors.push(
                        `${createdEntry.name}: ${(rollbackError as Error).message}`,
                    );
                    continue;
                }
                if (!ports.isValidWorktree(destination, sourceEntry.path)) {
                    rollbackErrors.push(
                        `${createdEntry.name}: worktree ownership changed during rollback`,
                    );
                    continue;
                }
                try {
                    ports.assertNestedRepositoryIdentity(sourceEntry.path, sourceIdentity);
                    const registrationFence = registrationFences.get(createdEntry.name);
                    if (!registrationFence) {
                        throw new Error("missing worktree registration fence");
                    }
                    ports.removeRegisteredWorktree(
                        sourceEntry.path,
                        destination,
                        registrationFence.destinationIdentity,
                        true,
                        ports.dirname(wsPath),
                        registrationFence,
                        ports.pinnedNestedRepositoryEnvironment(sourceIdentity),
                        () => {
                            ports.assertNestedRepositoryIdentity(
                                sourceEntry.path,
                                sourceIdentity,
                            );
                            ports.assertNestedWorktreeDestinationFence(
                                wsPath,
                                destination,
                                destinationFence,
                            );
                        },
                    );
                    ports.withPinnedNestedRepository(sourceIdentity, () => {
                        ports.rollbackFailedCreatedBranch(
                            sourceEntry.path,
                            branch,
                            createdEntry.action,
                            rollbackOids.get(createdEntry.name) ?? null,
                        );
                    });
                } catch (rollbackError) {
                    rollbackErrors.push(
                        `${createdEntry.name}: ${(rollbackError as Error).message}`,
                    );
                }
            }
            for (const preserved of [...preservedStaleRegistrations].reverse()) {
                try {
                    const sourceIdentity = sourceRepositoryIdentities.get(preserved.name);
                    if (!sourceIdentity) {
                        throw new Error("missing source repository fence");
                    }
                    ports.assertNestedRepositoryIdentity(preserved.source, sourceIdentity);
                    if (ports.registeredWorktreePath(preserved.source, preserved.destination)) {
                        throw new Error("replacement worktree registration remains in use");
                    }
                    ports.restoreQuarantinedMissingWorktreeRegistration(preserved.registration);
                } catch (rollbackError) {
                    rollbackErrors.push(
                        `${preserved.name}: failed to restore stale registration from ${preserved.registration.location.path}: ${(rollbackError as Error).message}`,
                    );
                }
            }
            for (const destination of removedEmptyDestinations) {
                if (ports.pathExistsStrict(destination)) continue;
                try {
                    const sourceEntry = sourceEntries.find((entry) => (
                        ports.join(wsPath, entry.name) === destination
                    ));
                    const destinationFence = sourceEntry
                        ? destinationFences.get(sourceEntry.name)
                        : null;
                    if (!destinationFence) {
                        throw new Error("missing destination parent fence");
                    }
                    ports.assertNestedWorktreeDestinationFence(
                        wsPath,
                        destination,
                        destinationFence,
                    );
                    ports.createEmptyDirectory(destination);
                    ports.assertNestedWorktreeDestinationFence(
                        wsPath,
                        destination,
                        destinationFence,
                    );
                } catch (rollbackError) {
                    rollbackErrors.push(
                        `${ports.basename(destination)}: failed to restore empty directory: ${(rollbackError as Error).message}`,
                    );
                }
            }
            for (const [parent, identity] of [...createdParentDirectories.entries()].reverse()) {
                if (!ports.pathExistsStrict(parent)) continue;
                try {
                    ports.assertDirectoryIdentity(parent, identity);
                    if (ports.readDirectoryEntries(parent).length === 0) {
                        ports.removeDirectoryByQuarantine(parent, identity, ports.dirname(parent), true);
                    }
                } catch (rollbackError) {
                    rollbackErrors.push(
                        `${parent}: failed to remove created parent: ${(rollbackError as Error).message}`,
                    );
                }
            }
            if (rollbackErrors.length > 0) {
                throw new Error(
                    `${(error as Error).message}; nested worktree rollback failed: ${rollbackErrors.join("; ")}`,
                    { cause: error },
                );
            }
            throw error;
        }

        try {
        for (const entry of sourceEntries) {
            if (!entry.isGitRepo) continue;
            if (blockedRepositoryPrefixes.some((prefix) => (
                entry.name.startsWith(`${prefix}/`)
            ))) {
                continue;
            }

            const destPath = ports.join(wsPath, entry.name);
            const sourceIdentity = sourceRepositoryIdentities.get(entry.name);
            if (!sourceIdentity) {
                rollbackNestedCreation(
                    new Error(`Missing source repository fence for ${entry.name}`),
                );
            }
            const sourceGuard = (): void => {
                ports.assertNestedRepositoryIdentity(entry.path, sourceIdentity);
            };
            let destinationFence: {
                workspace: DirectoryIdentity;
                parents: Array<{ path: string; identity: DirectoryIdentity }>;
            };
            try {
                destinationFence = ports.ensureNestedWorktreeParent(
                    wsPath,
                    destPath,
                    createdParentDirectories,
                );
                destinationFences.set(entry.name, destinationFence);
            } catch (error) {
                rollbackNestedCreation(error);
            }
            const operationGuard = (): void => {
                sourceGuard();
                ports.assertNestedWorktreeDestinationFence(
                    wsPath,
                    destPath,
                    destinationFence,
                );
            };

            // Check existing directory
            if (ports.pathExistsStrict(destPath)) {
                operationGuard();
                const destIdentity = ports.captureDirectoryIdentity(destPath);
                const contents = ports.readDirectoryEntries(destPath);
                if (contents.length > 0) {
                    if (!ports.isValidWorktree(destPath, entry.path)) {
                        blockedRepositoryPrefixes.push(entry.name);
                    }
                    operationGuard();
                    // Non-empty invalid entries and their descendants require the
                    // explicit repair prompt.
                    continue;
                }
                operationGuard();
                ports.removeDirectoryByQuarantine(destPath, destIdentity, ports.dirname(wsPath), true);
                operationGuard();
                removedEmptyDestinations.push(destPath);
            }

            // Git refuses to add a worktree when this exact absent destination is
            // still registered. Keep its management files outside Git's worktree
            // registry so they can be restored on any later creation failure.
            try {
                operationGuard();
                const staleFence = ports.withPinnedNestedRepository(sourceIdentity, () => (
                    ports.captureMissingWorktreeRegistrationFence(entry.path, destPath, branch)
                ));
                if (staleFence) {
                    const recordedGitFile = ports.managementGitdirBackpointer(
                        ports.join(staleFence.managementIdentity.realpath, "gitdir"),
                    );
                    const expectedGitFile = ports.join(destPath, ".git");
                    const sameName = ports.staleDestinationNameMatches(recordedGitFile, expectedGitFile, destPath);
                    if (!sameName || !ports.sameDirectExistingObject(
                        ports.dirname(ports.dirname(recordedGitFile)),
                        ports.dirname(destPath),
                    )) {
                        throw new Error(`Stale worktree registration path is not the requested destination: ${destPath}`);
                    }
                    if (ports.pathExistsStrict(ports.dirname(recordedGitFile)) || ports.pathExistsStrict(destPath)) {
                        throw new Error(`Stale worktree destination reappeared: ${destPath}`);
                    }
                    operationGuard();
                    const registration = ports.withPinnedNestedRepository(sourceIdentity, () => (
                        ports.quarantineMissingWorktreeRegistration(entry.path, destPath, staleFence, true)
                    ));
                    preservedStaleRegistrations.push({
                        name: entry.name,
                        source: entry.path,
                        destination: destPath,
                        registration,
                    });
                    operationGuard();
                }
            } catch (error) {
                rollbackNestedCreation(error);
            }

            sourceGuard();
            const nestedExistence = ports.branchExistsInRepo(entry.path, branch);
            sourceGuard();
            let nestedAction: WorktreeRepoResult["action"];

            switch (nestedExistence) {
                case "local":
                    nestedAction = "worktree-existing";
                    break;
                case "remote":
                    nestedAction = "worktree-remote";
                    break;
                case "none":
                    nestedAction = "worktree-new";
                    break;
            }
            let prepared: ReturnType<typeof ports.prepareWorktreeCreation>;
            try {
                prepared = ports.withPinnedNestedRepository(
                    sourceIdentity,
                    () => ports.prepareWorktreeCreation(
                        entry.path,
                        destPath,
                        branch,
                        nestedAction,
                        operationGuard,
                        ports.dirname(wsPath),
                    ),
                );
            } catch (error) {
                rollbackNestedCreation(error);
            }
            const { expectedBranchOid, destinationIdentity } = prepared;
            let addResult: ReturnType<typeof ports.runPreparedWorktreeAdd>;
            try {
                addResult = ports.runPreparedWorktreeAdd(
                    entry.path,
                    destPath,
                    branch,
                    expectedBranchOid.expectedOid,
                    destinationIdentity,
                    operationGuard,
                    sourceIdentity,
                );
            } catch (error) {
                rollbackNestedCreation(error);
            }
            const { result: nestedResult, registrationFence } = addResult;

            if (nestedResult.error || nestedResult.status !== 0) {
                const detail = (nestedResult.stderr ?? "").trim()
                    || nestedResult.error?.message
                    || `git exited with status ${String(nestedResult.status)}`;
                try {
                    operationGuard();
                    ports.rollbackFailedWorktreeAdd(
                        entry.path,
                        destPath,
                        branch,
                        nestedAction,
                        expectedBranchOid,
                        destinationIdentity,
                        registrationFence,
                        ports.dirname(wsPath),
                        sourceIdentity,
                        operationGuard,
                    );
                    operationGuard();
                } catch (rollbackError) {
                    rollbackNestedCreation(new Error(
                        `Failed to create nested worktree for ${entry.name}: ${detail}; rollback failed: ${(rollbackError as Error).message}`,
                        { cause: rollbackError },
                    ));
                }
                rollbackNestedCreation(
                    new Error(`Failed to create nested worktree for ${entry.name}: ${detail}`),
                );
            }
            created.push({ name: entry.name, branch, action: nestedAction });
            rollbackOids.set(entry.name, expectedBranchOid);
            try {
                registrationFences.set(
                    entry.name,
                    ports.requireWorktreeRegistrationFence(registrationFence, destPath),
                );
            } catch (error) {
                rollbackNestedCreation(error);
            }
        }
        } catch (error) {
            if (rollbackStarted) throw error;
            rollbackNestedCreation(error);
        }

        try {
            ports.normalizeOwnerVerifiedWorktreeGitLink(wsPath, resolved);
            for (const entry of sourceEntries) {
                if (!entry.isGitRepo) continue;
                const destination = ports.join(wsPath, entry.name);
                // Broken or foreign nested entries are preserved for the explicit
                // repair prompt and must never be mutated during normalization.
                if (!ports.isValidWorktree(destination, entry.path)) continue;
                ports.normalizeOwnerVerifiedWorktreeGitLink(destination, entry.path);
            }
        } catch (error) {
            rollbackNestedCreation(error);
        }
        for (const preserved of preservedStaleRegistrations) {
            ports.noticePreservedRegistration(preserved);
        }
        return created;
    }
    return { repairWorkspace };
}
