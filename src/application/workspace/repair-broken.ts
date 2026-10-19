import type { WorktreeRepoResult } from "../../domain/workspace/creation-result.js";
import type { WorkspaceRepairAuthority } from "../../domain/workspace/repair-authority.js";
import type { BrokenWorkspaceRepairPorts } from "../../ports/workspace/repair-broken.js";

export function createBrokenWorkspaceRepair<A extends WorkspaceRepairAuthority>(ports: BrokenWorkspaceRepairPorts<A>) {
    type DirectoryIdentity = A["DirectoryIdentity"];
    type BranchCreationFence = A["BranchCreationFence"];
    type QuarantineLocation = A["QuarantineLocation"];
    type QuarantinedMissingWorktreeRegistration = A["QuarantinedMissingWorktreeRegistration"];
    type PreservedContentMerge = A["PreservedContentMerge"];
    function fixBrokenWorktreeSanitized(
        sourcePath: string,
        wsPath: string,
        repoName: string,
        branch: string,
        confirmed: boolean,
        cleanupOperations: {
            removeMergedBackup?: (path: string) => void;
        },
    ): WorktreeRepoResult | null {
        if (!confirmed) {
            throw new Error("Explicit confirmation is required to replace broken worktree content.");
        }
        const resolved = ports.resolve(sourcePath);
        ports.assertWorkspaceRootOwnership(wsPath, resolved);

        // Find the source repo
        const sourceEntries = ports.scanUnifiedNestedRepositories(
            resolved,
            {
                strict: true,
                allowRegisteredWorktrees: Boolean(
                    ports.primarySourceRepositoryForWorktree(resolved),
                ),
            },
        );
        const sourceRepo = sourceEntries.find((e) => e.name === repoName && e.isGitRepo);
        if (!sourceRepo) return null;
        const destPath = ports.join(wsPath, ...sourceRepo.name.split("/"));
        for (const ancestor of sourceEntries.filter((entry) => (
            entry.isGitRepo
            && sourceRepo.name.startsWith(`${entry.name}/`)
        ))) {
            const ancestorDestination = ports.join(wsPath, ...ancestor.name.split("/"));
            if (!ports.isValidWorktree(ancestorDestination, ancestor.path)) {
                throw new Error(
                    `Cannot repair '${repoName}' beneath unmanaged ancestor '${ancestor.name}'.`,
                );
            }
        }
        const sourceIdentity = ports.captureNestedRepositoryIdentity(sourceRepo.path);
        const createdParentDirectories = new Map<string, DirectoryIdentity>();
        const destinationFence = ports.ensureNestedWorktreeParent(
            wsPath,
            destPath,
            createdParentDirectories,
        );
        const operationGuard = (): void => {
            ports.assertNestedRepositoryIdentity(sourceRepo.path, sourceIdentity);
            ports.assertNestedWorktreeDestinationFence(wsPath, destPath, destinationFence);
        };
        operationGuard();
        // Not always destPath: see unreachableRegistrationPathHoldingBranch. Everything below
        // takes this path as "the path the registration records", which is what the quarantine
        // and its rollback have always keyed on — so displacing a container-side entry needs no
        // new machinery, only the right path.
        const staleRegistrationPath = ports.registrationToDisplace(
            sourceRepo.path,
            destPath,
            branch,
        )?.path ?? destPath;
        const staleRegistrationFence = ports.captureMissingWorktreeRegistrationFence(
            sourceRepo.path,
            staleRegistrationPath,
            branch,
        );
        operationGuard();

        let backup: QuarantineLocation | null = null;
        let backupIdentity: DirectoryIdentity | null = null;
        let quarantinedStaleRegistration: QuarantinedMissingWorktreeRegistration | null = null;
        let creation: {
            action: WorktreeRepoResult["action"];
            expectedBranchOid: BranchCreationFence;
            destinationIdentity: DirectoryIdentity;
        } | null = null;
        let registrationFence: A["WorktreeRegistrationFence"] | null = null;
        let rollbackAllowed = true;
        let failedAddReason: string | undefined;
        // The directory rollback renames the quarantined content back INTO, which is the
        // destination's own parent — not the workspace root. Those are the same path only for a
        // top-level repository name; for a nested one such as `services/catchy-api` they never are,
        // so every rollback below threw `identity changed before deletion: <ws>/services` BEFORE
        // restoring anything, and the content stayed in the quarantine directory. The operator saw
        // it as `ccc` losing a submodule on every attempt: answering the repair prompt moved the
        // directory away and the failed rollback left it there.
        const destinationParentIdentity = ports.captureDirectoryIdentity(ports.dirname(destPath));
        // Committing a quarantined registration DELETES it. That is right for the destination's
        // own stale entry — it describes this very path and this repair is what replaces it. It
        // is not right for one displaced from somewhere else: what we cannot reach, we cannot
        // prove is dead. Everything a worktree keeps outside its working directory lives in that
        // directory — HEAD, the index, per-worktree refs, the reflog, an in-progress rebase — so
        // deleting it on a wrong guess loses work that is not even on this machine to look at.
        // Kept in the quarantine instead, and the operator is told where.
        const displacedRegistration = staleRegistrationPath !== destPath;
        const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
        // Diagnostics observe the retained paths too: a failed registration restore may follow
        // a successful checkout restore, and late cleanup may already have removed the backup.
        const recoveryLocations = (): string => {
            const locations: string[] = [];
            if (backup && backupIdentity) {
                try {
                    if (ports.pathExistsStrict(backup.path)) {
                        ports.assertQuarantinedIdentity(backup.path, backupIdentity, "directory");
                        locations.push(rollbackAllowed
                            ? `original content remains in '${backup.directory}' (checkout '${backup.path}'; destination '${destPath}')`
                            : `remaining original-content backup is at '${backup.path}'`);
                    } else if (rollbackAllowed) {
                        ports.assertDirectoryIdentity(destPath, backupIdentity);
                        locations.push(`original content was restored to '${destPath}'`);
                    }
                } catch (error) {
                    locations.push(`original content location could not be verified at '${destPath}' or '${backup.path}': ${errorMessage(error)}`);
                }
            }
            if (quarantinedStaleRegistration && staleRegistrationFence) {
                const path = quarantinedStaleRegistration.location.path;
                try {
                    if (ports.pathExistsStrict(path)) {
                        ports.assertQuarantinedIdentity(path, staleRegistrationFence.managementIdentity, "directory");
                        locations.push(`original registration recovery location is '${path}'`);
                    } else {
                        locations.push(`original registration quarantine '${path}' is absent; restoration for '${staleRegistrationPath}' was not verified`);
                    }
                } catch (error) {
                    locations.push(`original registration recovery location '${path}' could not be verified: ${errorMessage(error)}`);
                }
            }
            if (!rollbackAllowed && creation) {
                try {
                    ports.assertDirectoryIdentity(destPath, creation.destinationIdentity);
                    locations.push(`authoritative replacement remains at '${destPath}'`);
                } catch (error) {
                    locations.push(`authoritative replacement location '${destPath}' could not be verified: ${errorMessage(error)}`);
                }
            }
            return locations.length ? `; ${locations.join("; ")}` : "";
        };
        try {
            if (ports.pathExistsStrict(destPath)) {
                operationGuard();
                backupIdentity = ports.captureDirectoryIdentity(destPath);
                backup = ports.createPrivateQuarantine(destPath, ports.dirname(wsPath));
                operationGuard();
                ports.assertDirectoryIdentity(destPath, backupIdentity);
                ports.renameBrokenCheckout(destPath, backup.path);
                operationGuard();
                ports.assertQuarantinedIdentity(backup.path, backupIdentity, "directory");
            }
            if (staleRegistrationFence) {
                operationGuard();
                quarantinedStaleRegistration = ports.withPinnedNestedRepository(
                    sourceIdentity,
                    () => ports.quarantineMissingWorktreeRegistration(
                        sourceRepo.path,
                        staleRegistrationPath,
                        staleRegistrationFence,
                    ),
                );
                operationGuard();
            }

            operationGuard();
            const existence = ports.branchExistsInRepo(sourceRepo.path, branch);
            operationGuard();
            const action: WorktreeRepoResult["action"] = existence === "local" ? "worktree-existing"
                : existence === "remote" ? "worktree-remote" : "worktree-new";
            creation = {
                action,
                ...ports.withPinnedNestedRepository(
                    sourceIdentity,
                    () => ports.prepareWorktreeCreation(
                        sourceRepo.path,
                        destPath,
                        branch,
                        action,
                        operationGuard,
                        ports.dirname(wsPath),
                    ),
                ),
            };
            const added = ports.runPreparedWorktreeAdd(
                sourceRepo.path,
                destPath,
                branch,
                creation.expectedBranchOid.expectedOid,
                creation.destinationIdentity,
                operationGuard,
                sourceIdentity,
            );
            registrationFence = added.registrationFence;
            if (!added.result.succeeded) {
                failedAddReason = added.result.failureReason ?? "";
                throw new Error(`Worktree creation failed: ${failedAddReason}`);
            }
            ports.requireWorktreeRegistrationFence(registrationFence, destPath);
            let preservedContentMerge: PreservedContentMerge | null = null;
            if (backup && backupIdentity) {
                preservedContentMerge = ports.createPreservedContentMerge(destPath);
                operationGuard();
                if (!ports.isValidWorktree(destPath, sourceRepo.path)) {
                    throw new Error("Created worktree ownership could not be verified.");
                }
                operationGuard();
                ports.assertQuarantinedIdentity(backup.path, backupIdentity, "directory");
                for (const name of ports.readDirectoryEntries(backup.path)) {
                    if (name === ".git") continue;
                    ports.mergePreservingContent(
                        ports.join(backup.path, name),
                        ports.join(destPath, name),
                        preservedContentMerge,
                    );
                }
                if (preservedContentMerge.conflicts.length > 0) {
                    throw ports.createContentConflictError(destPath, preservedContentMerge);
                }
            }

            // Settlement can partly delete registration metadata before it throws. The new
            // worktree is authoritative BEFORE the first attempt, not after it succeeds.
            rollbackAllowed = false;
            if (quarantinedStaleRegistration) {
                if (displacedRegistration) {
                    ports.warnDisplacedWorktreeRegistration(
                        staleRegistrationPath,
                        quarantinedStaleRegistration.location.path,
                    );
                } else {
                    ports.commitQuarantinedMissingWorktreeRegistration(quarantinedStaleRegistration);
                    quarantinedStaleRegistration = null;
                }
            }
            if (backup && backupIdentity && preservedContentMerge) {
                if (preservedContentMerge.skippedIgnoredDependencyTrees.length > 0) {
                    ports.noticeSkippedDependencyTrees(destPath, preservedContentMerge);
                }
                const removeMergedBackup = cleanupOperations.removeMergedBackup
                    ?? (ports.defaultRemoveMergedBackup());
                operationGuard();
                ports.assertQuarantinedIdentity(backup.path, backupIdentity, "directory");
                ports.unlinkMergeDependencyLinks(preservedContentMerge);
                ports.assertQuarantinedIdentity(backup.path, backupIdentity, "directory");
                removeMergedBackup(backup.path);
                operationGuard();
                if (ports.pathExistsStrict(backup.path)) {
                    throw new Error(`Broken-worktree backup was not removed: ${backup.path}`);
                }
                ports.removePrivateQuarantine(backup);
            }
            return { name: repoName, branch, action };
        } catch (error) {
            if (!rollbackAllowed) {
                throw new Error(`Worktree repair cleanup failed: ${errorMessage(error)}${recoveryLocations()}.`, { cause: error });
            }
            const rollbackErrors: unknown[] = [];
            let creationRemoved = creation === null;
            if (creation) {
                try {
                    operationGuard();
                    // An add that throws without returning a receipt grants no registration
                    // authority. The native inverse preserves any such registration or successor.
                    ports.rollbackFailedWorktreeAdd(
                        sourceRepo.path,
                        destPath,
                        branch,
                        creation.action,
                        creation.expectedBranchOid,
                        creation.destinationIdentity,
                        registrationFence,
                        ports.dirname(wsPath),
                        sourceIdentity,
                        operationGuard,
                    );
                    creationRemoved = true;
                    operationGuard();
                } catch (rollbackError) {
                    rollbackErrors.push(rollbackError);
                }
            }
            let checkoutRestored = backup === null;
            if (backup && backupIdentity) {
                try {
                    operationGuard();
                    if (ports.pathExistsStrict(backup.path)) {
                        const restored = ports.rollbackQuarantinedPath(
                            destPath,
                            backup,
                            backupIdentity,
                            destinationParentIdentity,
                            "directory",
                        );
                        if (!restored) throw new Error(`Could not restore original content from '${backup.directory}'.`);
                    } else {
                        // A pre-rename failure left the original in place. Verify it before
                        // removing the still-empty private quarantine.
                        ports.assertDirectoryIdentity(destPath, backupIdentity);
                        if (ports.pathExistsStrict(backup.directory)) ports.removePrivateQuarantine(backup);
                    }
                    checkoutRestored = true;
                    operationGuard();
                } catch (rollbackError) {
                    rollbackErrors.push(rollbackError);
                }
            }
            if (creationRemoved && checkoutRestored && quarantinedStaleRegistration) {
                try {
                    operationGuard();
                    ports.restoreQuarantinedMissingWorktreeRegistration(quarantinedStaleRegistration);
                    quarantinedStaleRegistration = null;
                    operationGuard();
                } catch (rollbackError) {
                    rollbackErrors.push(rollbackError);
                }
            }
            if (rollbackErrors.length > 0) {
                throw new Error(
                    `Failed worktree repair rollback: ${rollbackErrors.map(errorMessage).join("; ")}; original failure: ${errorMessage(error)}${recoveryLocations()}.`,
                    { cause: error },
                );
            }
            if (failedAddReason !== undefined) {
                ports.warnWorktreeRepairFailure(destPath, failedAddReason);
                return null;
            }
            // In particular, the native conflict object is safe for the CLI set-aside
            // prompt only after both the original checkout and registration were restored.
            throw error;
        }
    }
    return { fixBrokenWorktreeSanitized };
}
