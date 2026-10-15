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
        // The directory rollback renames the quarantined content back INTO, which is the
        // destination's own parent — not the workspace root. Those are the same path only for a
        // top-level repository name; for a nested one such as `services/catchy-api` they never are,
        // so every rollback below threw `identity changed before deletion: <ws>/services` BEFORE
        // restoring anything, and the content stayed in the quarantine directory. The operator saw
        // it as `ccc` losing a submodule on every attempt: answering the repair prompt moved the
        // directory away and the failed rollback left it there.
        const destinationParentIdentity = ports.captureDirectoryIdentity(ports.dirname(destPath));
        const restoreStaleRegistration = (): void => {
            if (!quarantinedStaleRegistration) return;
            ports.restoreQuarantinedMissingWorktreeRegistration(quarantinedStaleRegistration);
            quarantinedStaleRegistration = null;
        };
        // Committing a quarantined registration DELETES it. That is right for the destination's
        // own stale entry — it describes this very path and this repair is what replaces it. It
        // is not right for one displaced from somewhere else: what we cannot reach, we cannot
        // prove is dead. Everything a worktree keeps outside its working directory lives in that
        // directory — HEAD, the index, per-worktree refs, the reflog, an in-progress rebase — so
        // deleting it on a wrong guess loses work that is not even on this machine to look at.
        // Kept in the quarantine instead, and the operator is told where.
        const displacedRegistration = staleRegistrationPath !== destPath;
        const settleStaleRegistration = (): void => {
            if (!quarantinedStaleRegistration) return;
            if (displacedRegistration) {
                ports.warnDisplacedWorktreeRegistration(
                    staleRegistrationPath,
                    quarantinedStaleRegistration.location.path,
                );
            } else {
                ports.commitQuarantinedMissingWorktreeRegistration(quarantinedStaleRegistration);
            }
            quarantinedStaleRegistration = null;
        };
        if (ports.pathExistsStrict(destPath)) {
            operationGuard();
            backupIdentity = ports.captureDirectoryIdentity(destPath);
            backup = ports.createPrivateQuarantine(destPath, ports.dirname(wsPath));
            try {
                operationGuard();
                ports.assertDirectoryIdentity(destPath, backupIdentity);
                ports.renameBrokenCheckout(destPath, backup.path);
                operationGuard();
                ports.assertQuarantinedIdentity(backup.path, backupIdentity, "directory");
            } catch (error) {
                if (!ports.pathExistsStrict(backup.path)) ports.removePrivateQuarantine(backup);
                throw error;
            }
        }

        if (staleRegistrationFence) {
            try {
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
            } catch (error) {
                if (backup && backupIdentity) {
                    operationGuard();
                    ports.rollbackQuarantinedPath(
                        destPath,
                        backup,
                        backupIdentity,
                        destinationParentIdentity,
                        "directory",
                    );
                    operationGuard();
                }
                throw error;
            }
        }

        // Create worktree
        operationGuard();
        const existence = ports.branchExistsInRepo(sourceRepo.path, branch);
        operationGuard();
        let action: WorktreeRepoResult["action"];

        switch (existence) {
            case "local":
                action = "worktree-existing";
                break;
            case "remote":
                action = "worktree-remote";
                break;
            case "none":
                action = "worktree-new";
                break;
        }
        let expectedBranchOid: BranchCreationFence;
        let destinationIdentity: DirectoryIdentity;
        try {
            ({
                expectedBranchOid,
                destinationIdentity,
            } = ports.withPinnedNestedRepository(
                sourceIdentity,
                () => ports.prepareWorktreeCreation(
                    sourceRepo.path,
                    destPath,
                    branch,
                    action,
                    operationGuard,
                    ports.dirname(wsPath),
                ),
            ));
        } catch (error) {
            if (backup && backupIdentity) {
                operationGuard();
                ports.rollbackQuarantinedPath(
                    destPath,
                    backup,
                    backupIdentity,
                    destinationParentIdentity,
                    "directory",
                );
                operationGuard();
            }
            restoreStaleRegistration();
            throw error;
        }
        const { result, registrationFence } = ports.runPreparedWorktreeAdd(
            sourceRepo.path,
            destPath,
            branch,
            expectedBranchOid.expectedOid,
            destinationIdentity,
            operationGuard,
            sourceIdentity,
        );

        if (!result.succeeded) {
            try {
                operationGuard();
                ports.rollbackFailedWorktreeAdd(
                    sourceRepo.path,
                    destPath,
                    branch,
                    action,
                    expectedBranchOid,
                    destinationIdentity,
                    registrationFence,
                    ports.dirname(wsPath),
                    sourceIdentity,
                    operationGuard,
                );
                operationGuard();
            } catch (rollbackError) {
                const preservation = backup
                    ? `; original content remains in '${backup.directory}'`
                    : "";
                throw new Error(
                    `Failed worktree repair rollback: ${(rollbackError as Error).message}${preservation}.`,
                    { cause: rollbackError },
                );
            }
            if (backup && backupIdentity) {
                operationGuard();
                const restored = ports.rollbackQuarantinedPath(
                    destPath,
                    backup,
                    backupIdentity,
                    destinationParentIdentity,
                    "directory",
                );
                operationGuard();
                if (!restored) {
                    throw new Error(
                        `Failed worktree creation could not restore original content from '${backup.directory}'.`,
                    );
                }
            }
            restoreStaleRegistration();
            ports.warnWorktreeRepairFailure(destPath, result.failureReason ?? "");
            return null;
        }
        const createdRegistrationFence = ports.requireWorktreeRegistrationFence(
            registrationFence,
            destPath,
        );

        if (backup && backupIdentity) {
            const preservedContentMerge: PreservedContentMerge = ports.createPreservedContentMerge(destPath);
            try {
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
            } catch (error) {
                if (ports.pathExistsStrict(destPath)) {
                    operationGuard();
                    if (!ports.isValidWorktree(destPath, sourceRepo.path)) {
                        throw new Error(
                            `${(error as Error).message}; created worktree ownership changed during rollback`,
                            { cause: error },
                        );
                    }
                    ports.removeRegisteredWorktree(
                        sourceRepo.path,
                        destPath,
                        createdRegistrationFence.destinationIdentity,
                        true,
                        ports.dirname(wsPath),
                        createdRegistrationFence,
                        ports.pinnedNestedRepositoryEnvironment(sourceIdentity),
                        operationGuard,
                    );
                    operationGuard();
                    ports.withPinnedNestedRepository(sourceIdentity, () => (
                        ports.rollbackFailedCreatedBranch(
                            sourceRepo.path,
                            branch,
                            action,
                            expectedBranchOid,
                        )
                    ));
                }
                operationGuard();
                ports.rollbackQuarantinedPath(
                    destPath,
                    backup,
                    backupIdentity,
                    destinationParentIdentity,
                    "directory",
                );
                operationGuard();
                restoreStaleRegistration();
                throw error;
            }

            // The replacement is now the authoritative worktree. Cleanup failures
            // must not roll it back after either quarantine has been settled.
            settleStaleRegistration();
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

        settleStaleRegistration();
        return { name: repoName, branch, action };
    }
    return { fixBrokenWorktreeSanitized };
}
