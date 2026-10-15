import type { WorkspaceRepairAuthority } from "../../domain/workspace/repair-authority.js";
import type { RootWorkspaceRepairPorts } from "../../ports/workspace/repair-root.js";

export function createRootWorkspaceRepair<A extends WorkspaceRepairAuthority>(ports: RootWorkspaceRepairPorts<A>) {
    type DirectoryIdentity = A["DirectoryIdentity"];
    type FileIdentity = A["FileIdentity"];
    type NestedRepositoryIdentity = A["NestedRepositoryIdentity"];
    type CapturedDirectoryTree = A["CapturedDirectoryTree"];
    type MissingWorktreeRegistrationFence = A["MissingWorktreeRegistrationFence"];
    type MetadataSnapshot = A["MetadataSnapshot"];
    type MetadataPublication = A["MetadataPublication"];
    function recreateMissingWorkspaceRootRegistration(
        workspacePath: string,
        sourcePath: string,
        expectedBranch: string,
        commonGitDirectory: string,
        sourceIdentity: NestedRepositoryIdentity,
        staleGitDirectory: string,
        workspaceIdentity: DirectoryIdentity,
        gitFileIdentity: DirectoryIdentity,
        gitFileSnapshot: MetadataSnapshot,
        mode: "inspect" | "confirmed",
        reportFailure?: (reason: string) => void,
        preflightFence?: () => void,
    ): boolean {
        const refuse = (stage: string, reason?: string): false => {
            reportFailure?.(reason ? `${stage}: ${reason}` : stage);
            return false;
        };
        const managementRoot = ports.resolve(commonGitDirectory, "worktrees");
        const managementName = ports.basename(staleGitDirectory);
        const workspaceManagementName = ports.basename(workspacePath);
        const workspaceDigest = ports.workspaceRegistrationDigest(workspaceIdentity);
        const ownershipEvidence = ports.captureNestedWorkspaceOwnershipEvidence(
            workspacePath,
            sourcePath,
            expectedBranch,
        );
        const managementSuffix = managementName.slice(workspaceManagementName.length);
        const legacyManagementName = managementName.startsWith(workspaceManagementName)
            && (managementSuffix === "" || /^\d+$/.test(managementSuffix));
        const boundManagementName = new RegExp(
            `^[.-]ccc-register-${workspaceDigest}-[0-9a-f]{32}$`,
        ).test(managementName);
        if (!ports.isSourceWorktreeManagementRoot(ports.dirname(staleGitDirectory), commonGitDirectory)
            || (!legacyManagementName && !boundManagementName)
            || ports.pathExistsStrict(staleGitDirectory)) {
            return refuse("workspace Git link no longer names a missing direct child of the source management root");
        }

        const assertRecoveryAuthority = (expectOriginalGitFile = true): void => {
            if (expectOriginalGitFile) preflightFence?.();
            ports.assertNestedRepositoryIdentity(sourcePath, sourceIdentity);
            ports.assertDirectoryIdentity(workspacePath, workspaceIdentity);
            if (expectOriginalGitFile) {
                ports.assertPathIdentity(ports.join(workspacePath, ".git"), gitFileIdentity);
                if (!ports.metadataMatches(ports.join(workspacePath, ".git"), gitFileSnapshot)) {
                    throw new Error("Workspace Git metadata changed during root registration recovery.");
                }
            }
            if (ownershipEvidence) ports.assertWorkspaceOwnershipEvidence(ownershipEvidence);
        };

        const expectedRef = `refs/heads/${expectedBranch}`;
        const sourceEnvironment = ports.pinnedNestedRepositoryEnvironment(sourceIdentity);
        const branchHead = ports.probeSourceBranchHead(sourceIdentity, sourceEnvironment, expectedRef, "branch");
        const expectedOid = branchHead.oid;
        if (!branchHead.succeeded || !expectedOid) {
            return refuse("expected branch is unavailable", branchHead.failureReason);
        }
        ports.throwOnLiveWorkspaceBranchConflict(
            sourcePath,
            sourceIdentity,
            workspacePath,
            expectedRef,
        );
        assertRecoveryAuthority();
        if (mode === "inspect") return true;

        const temporaryPath = ports.temporaryRegistrationPath(workspacePath, workspaceIdentity, workspaceDigest);
        ports.createEmptyDirectory(temporaryPath);
        const temporaryIdentity = ports.captureDirectoryIdentity(temporaryPath);
        let temporaryRegistered = false;
        let workspaceRewritten = false;
        let registrationRewritten = false;
        let managementGitdir = "";
        let managementGitdirOriginal: MetadataSnapshot | null = null;
        let workspacePublication: MetadataPublication | null = null;
        let registrationPublication: MetadataPublication | null = null;
        let createdManagementIdentity: DirectoryIdentity | null = null;
        let createdManagementHeadIdentity: FileIdentity | null = null;
        let createdManagementTree: CapturedDirectoryTree | null = null;
        let managementRootIdentity: DirectoryIdentity | null = null;
        let temporaryGitFileIdentity: DirectoryIdentity | null = null;
        let temporaryGitFileSnapshot: MetadataSnapshot | null = null;
        let failedRegistrationCommand = false;
        try {
            assertRecoveryAuthority();
            const registered = ports.registerTemporaryWorktree(sourceIdentity, sourceEnvironment, temporaryPath, expectedBranch);
            failedRegistrationCommand = !registered.succeeded;
            if (failedRegistrationCommand) {
                return refuse("git worktree add failed", registered.failureReason);
            }
            temporaryRegistered = true;

            const temporaryGitFile = ports.join(temporaryPath, ".git");
            const temporarySnapshot = ports.captureMetadata(temporaryGitFile);
            temporaryGitFileIdentity = ports.capturePathIdentity(temporaryGitFile);
            temporaryGitFileSnapshot = temporarySnapshot;
            ports.assertPathIdentity(temporaryGitFile, temporaryGitFileIdentity);
            const managementDirectory = ports.worktreeGitDirectory(temporaryGitFile, temporarySnapshot);
            if (!managementDirectory) return refuse("temporary Git link is invalid");
            const managementIdentity = ports.captureDirectoryIdentity(managementDirectory);
            createdManagementIdentity = managementIdentity;
            managementRootIdentity = ports.captureDirectoryIdentity(managementRoot);
            if (!ports.sameExistingObject(ports.dirname(managementIdentity.realpath), managementRootIdentity.realpath)
                || ports.pathExistsStrict(staleGitDirectory)) {
                return refuse("temporary registration is outside the source management root or the old entry reappeared");
            }
            const managementHead = ports.join(managementDirectory, "HEAD");
            managementGitdir = ports.join(managementDirectory, "gitdir");
            managementGitdirOriginal = ports.captureMetadata(managementGitdir);
            const managementHeadIdentity = ports.captureFileIdentity(managementHead);
            createdManagementHeadIdentity = managementHeadIdentity;
            const managementHeadSnapshot = ports.captureMetadata(managementHead);
            createdManagementTree = ports.captureDirectoryTree(managementDirectory);
            if (!ports.sameExistingObject(ports.dirname(managementIdentity.realpath), managementRoot)
                || ports.metadataBranchRef(managementHeadSnapshot) !== expectedRef) {
                return refuse("temporary registration path or branch does not match");
            }
            const temporaryRepositoryIdentity = ports.captureNestedRepositoryIdentity(
                temporaryPath,
            );
            const temporaryEnvironment = ports.pinnedNestedRepositoryEnvironment(
                temporaryRepositoryIdentity,
            );
            const registeredHead = ports.readTemporaryHead(temporaryRepositoryIdentity, temporaryEnvironment);
            const currentBranchHead = ports.probeSourceBranchHead(sourceIdentity, sourceEnvironment, expectedRef, "read");
            if (!registeredHead.succeeded) {
                return refuse("temporary registration HEAD could not be read",
                    registeredHead.failureReason);
            }
            if (!currentBranchHead.succeeded) {
                return refuse("expected branch HEAD could not be read",
                    currentBranchHead.failureReason);
            }
            if (registeredHead.oid !== expectedOid
                || currentBranchHead.oid !== expectedOid) {
                return refuse("temporary registration HEAD changed");
            }
            const initializedIndex = ports.initializeTemporaryIndex(temporaryRepositoryIdentity, temporaryEnvironment, expectedOid);
            createdManagementTree = ports.captureDirectoryTree(managementDirectory);
            if (!initializedIndex.succeeded) {
                return refuse("git read-tree failed", initializedIndex.failureReason);
            }
            const stagedDiff = ports.compareTemporaryIndex(temporaryRepositoryIdentity, temporaryEnvironment, expectedOid);
            if (!stagedDiff.succeeded) {
                return refuse("temporary index does not match the expected branch", stagedDiff.failureReason);
            }
            const managementIndex = ports.join(managementDirectory, "index");
            const managementIndexIdentity = ports.captureFileIdentity(managementIndex);
            const managementIndexContent = ports.captureIndexContent(managementIndex);
            ports.assertFileIdentity(managementHead, managementHeadIdentity);
            if (!ports.metadataMatches(managementHead, managementHeadSnapshot)) {
                return refuse("temporary registration branch changed");
            }

            assertRecoveryAuthority();
            if (!managementRootIdentity) return refuse("temporary management root identity is unavailable");
            ports.assertDirectoryIdentity(managementRoot, managementRootIdentity);
            if (ports.pathExistsStrict(staleGitDirectory)) return refuse("old management entry reappeared");
            ports.assertDirectoryIdentity(workspacePath, workspaceIdentity);
            workspacePublication = ports.publishWorktreeGitLink(
                workspacePath,
                workspaceIdentity,
                managementDirectory,
                managementIdentity,
                gitFileIdentity,
                gitFileSnapshot,
            );
            workspaceRewritten = true;
            registrationPublication = ports.publishWorktreeBackpointer(
                managementGitdir,
                ports.join(workspacePath, ".git"),
                ports.capturePathIdentity(managementGitdir),
                managementGitdirOriginal,
            );
            registrationRewritten = true;

            if (!ports.withPinnedNestedRepository(
                sourceIdentity,
                () => ports.isValidWorktree(workspacePath, sourcePath,
                    (reason) => reportFailure?.(`relinked workspace validation failed: ${reason}`)),
            )) return false;
            const finalBranchHead = ports.probeSourceBranchHead(sourceIdentity, sourceEnvironment, expectedRef, "branch");
            if (!finalBranchHead.succeeded || finalBranchHead.oid !== expectedOid) {
                return refuse("expected branch changed after registration", finalBranchHead.failureReason);
            }
            assertRecoveryAuthority(false);
            ports.assertDirectoryIdentity(managementRoot, managementRootIdentity);
            if (ports.pathExistsStrict(staleGitDirectory)) return refuse("old management entry reappeared after registration");
            ports.assertDirectoryIdentity(managementDirectory, managementIdentity);
            ports.assertFileIdentity(managementHead, managementHeadIdentity);
            ports.assertFileIdentity(managementIndex, managementIndexIdentity);
            if (!ports.metadataMatches(managementHead, managementHeadSnapshot)
                || !ports.metadataIndexMatches(managementIndex, managementIndexContent)) {
                return refuse("temporary registration HEAD or index changed");
            }
            if (!workspacePublication || !registrationPublication) {
                return refuse("installed Git metadata identity is unavailable");
            }
            ports.assertMetadataPublication(ports.join(workspacePath, ".git"), workspacePublication);
            ports.assertMetadataPublication(managementGitdir, registrationPublication);
            if (!ports.metadataPublicationMatches(ports.join(workspacePath, ".git"), workspacePublication)
                || !ports.metadataPublicationMatches(managementGitdir, registrationPublication)) {
                return refuse("installed Git metadata changed");
            }
            ports.assertDirectoryIdentity(temporaryPath, temporaryIdentity);
            if (ports.readDirectoryEntries(temporaryPath).some((entry) => entry !== ".git")) {
                return refuse("temporary workspace contains unexpected content");
            }
            if (!temporaryGitFileIdentity || !temporaryGitFileSnapshot) return refuse("temporary Git link identity is unavailable");
            ports.assertPathIdentity(temporaryGitFile, temporaryGitFileIdentity);
            if (!ports.metadataMatches(temporaryGitFile, temporaryGitFileSnapshot)) {
                return refuse("temporary Git link changed");
            }
            ports.unlinkTemporaryLink(temporaryGitFile);
            ports.removeTemporaryDirectory(temporaryPath);
            temporaryRegistered = false;
            return true;
        } finally {
            if (failedRegistrationCommand && !temporaryRegistered) {
                try {
                    ports.assertNestedRepositoryIdentity(sourcePath, sourceIdentity);
                    ports.assertDirectoryIdentity(temporaryPath, temporaryIdentity);
                    const temporaryEntries = ports.readDirectoryEntries(temporaryPath);
                    if (temporaryEntries.length > 1
                        || (temporaryEntries.length === 1
                            && temporaryEntries[0] !== ".git")) {
                        throw new Error(
                            "failed registration left unexpected temporary workspace content",
                        );
                    }
                    if (temporaryEntries.length === 1
                        && !ports.temporaryGitLinkIsRegular(temporaryPath)) {
                        throw new Error(
                            "failed registration left unexpected temporary Git metadata",
                        );
                    }
                    if (ports.registeredWorktreePath(sourcePath, temporaryPath)) {
                        const removed = ports.removeFailedTemporaryRegistration(sourceIdentity, sourceEnvironment, temporaryPath);
                        if (!removed.succeeded
                            || ports.pathExistsStrict(temporaryPath)
                            || ports.registeredWorktreePath(sourcePath, temporaryPath)) {
                            throw new Error("failed registration could not be rolled back");
                        }
                    } else if (temporaryEntries.length === 1) {
                        const failedGitFile = ports.join(temporaryPath, ".git");
                        const failedGitFileIdentity = ports.capturePathIdentity(failedGitFile);
                        ports.assertPathIdentity(failedGitFile, failedGitFileIdentity);
                        ports.unlinkTemporaryLink(failedGitFile);
                        ports.assertDirectoryIdentity(temporaryPath, temporaryIdentity);
                        ports.removeTemporaryDirectory(temporaryPath);
                    }
                } catch (error) {
                    throw ports.createRecoveryRollbackError("Workspace root registration recovery rollback failed; workspace content was preserved.", error);
                }
            }
            if (temporaryRegistered) {
                try {
                    let managementGitdirAuthority: MetadataSnapshot | MetadataPublication | null = managementGitdirOriginal;
                    if (registrationRewritten && managementGitdir) {
                        if (!registrationPublication || !managementGitdirOriginal) {
                            throw new Error("missing installed registration identity");
                        }
                        managementGitdirAuthority = ports.restoreMetadata(
                            managementGitdir,
                            managementGitdirOriginal,
                            registrationPublication,
                        );
                    }
                    if (workspaceRewritten) {
                        if (!workspacePublication) {
                            throw new Error("missing installed workspace identity");
                        }
                        ports.restoreMetadata(
                            ports.join(workspacePath, ".git"),
                            gitFileSnapshot,
                            workspacePublication,
                        );
                    }
                    ports.assertDirectoryIdentity(temporaryPath, temporaryIdentity);
                    if (ports.readDirectoryEntries(temporaryPath).some((entry) => entry !== ".git")) {
                        throw new Error("temporary registration directory contains unexpected content");
                    }
                    if (!temporaryGitFileIdentity || !temporaryGitFileSnapshot) {
                        throw new Error("missing temporary Git file identity during rollback");
                    }
                    ports.assertPathIdentity(ports.join(temporaryPath, ".git"), temporaryGitFileIdentity);
                    if (!ports.metadataMatches(ports.join(temporaryPath, ".git"), temporaryGitFileSnapshot)) {
                        throw new Error("temporary Git file changed during rollback");
                    }
                    ports.unlinkTemporaryLink(ports.join(temporaryPath, ".git"));
                    ports.removeTemporaryDirectory(temporaryPath);
                    if (!createdManagementIdentity || !createdManagementHeadIdentity) {
                        throw new Error("missing created registration identity during rollback");
                    }
                    if (!createdManagementTree) {
                        throw new Error("missing created registration tree during rollback");
                    }
                    if (!managementGitdirAuthority) {
                        throw new Error("missing created registration metadata during rollback");
                    }
                    const managementIdentity = createdManagementIdentity;
                    const managementTree = createdManagementTree;
                    ports.assertDirectoryIdentity(
                        managementIdentity.realpath,
                        managementIdentity,
                    );
                    ports.assertFileIdentity(
                        ports.join(managementIdentity.realpath, "HEAD"),
                        createdManagementHeadIdentity,
                    );
                    const staleRegistration: MissingWorktreeRegistrationFence = ports.makeMissingRegistrationFence(
                        managementIdentity,
                        managementGitdirAuthority,
                        createdManagementHeadIdentity,
                        expectedOid,
                        expectedRef,
                    );
                    ports.withPinnedNestedRepository(sourceIdentity, () => {
                        if (!ports.missingWorktreeManagementMatches(
                            sourcePath,
                            temporaryPath,
                            staleRegistration,
                        )) throw new Error("created registration changed during rollback");
                        ports.assertCapturedDirectoryTree(
                            managementIdentity.realpath,
                            managementTree,
                            new Set(["gitdir"]),
                        );
                        ports.commitQuarantinedMissingWorktreeRegistration(
                            ports.quarantineMissingWorktreeRegistration(
                                sourcePath,
                                temporaryPath,
                                staleRegistration,
                            ),
                        );
                        if (ports.pathExistsStrict(staleRegistration.managementIdentity.realpath)
                            || ports.registeredWorktreePath(sourcePath, temporaryPath)) {
                            throw new Error("temporary registration reappeared during rollback");
                        }
                    });
                } catch (error) {
                    throw ports.createRecoveryRollbackError("Workspace root registration recovery rollback failed; workspace content was preserved.", error);
                }
            }
            if (ports.pathExistsStrict(temporaryPath)) {
                try {
                    ports.assertDirectoryIdentity(temporaryPath, temporaryIdentity);
                    if (ports.readDirectoryEntries(temporaryPath).length === 0) {
                        ports.removeTemporaryDirectory(temporaryPath);
                    }
                } catch {
                    // Preserve unexpected temporary content for explicit recovery.
                }
            }
        }
    }

    function handleWorkspaceRootOwnership(
        workspacePath: string,
        sourcePath: string,
        expectedBranch: string,
        missingRegistrationMode: "none" | "inspect" | "confirmed",
        reportFailure?: (reason: string) => void,
        onPreflightReady?: (assertUnchanged: () => void) => void,
        preflightFence?: () => void,
    ): boolean {
        const refuse = (reason: string): false => {
            if (missingRegistrationMode === "confirmed") reportFailure?.(reason);
            return false;
        };
        if (missingRegistrationMode === "confirmed" && preflightFence) {
            try {
                preflightFence();
            } catch {
                return refuse("workspace or Git metadata changed while awaiting confirmation");
            }
        }
        if (ports.isValidWorktree(workspacePath, sourcePath)) {
            return refuse("workspace registration is already valid");
        }

        const resolvedWorkspace = ports.resolve(workspacePath);
        const resolvedSource = ports.resolve(sourcePath);
        if (!ports.sameObservedPath(
            resolvedWorkspace,
            ports.getWorkspacePath(resolvedSource, expectedBranch),
        )) return refuse("workspace path no longer matches the requested branch");

        try {
            const workspaceIdentity = ports.captureDirectoryIdentity(resolvedWorkspace);
            const gitFile = ports.join(resolvedWorkspace, ".git");
            const gitFileIdentity = ports.capturePathIdentity(gitFile);
            const gitFileSnapshot = ports.captureMetadata(gitFile);
            ports.assertPathIdentity(gitFile, gitFileIdentity);
            const resolvedGitDirectory = ports.worktreeGitDirectory(gitFile, gitFileSnapshot);
            if (!resolvedGitDirectory) return refuse("workspace Git link is invalid");

            const sourceIdentity = ports.captureNestedRepositoryIdentity(resolvedSource);
            const commonGitDirectory = sourceIdentity.commonDirectory.realpath;
            ports.assertNestedRepositoryIdentity(resolvedSource, sourceIdentity);

            if (!ports.pathExistsStrict(resolvedGitDirectory)) {
                if (missingRegistrationMode === "none") return false;
                const ready = recreateMissingWorkspaceRootRegistration(
                    resolvedWorkspace,
                    resolvedSource,
                    expectedBranch,
                    commonGitDirectory,
                    sourceIdentity,
                    resolvedGitDirectory,
                    workspaceIdentity,
                    gitFileIdentity,
                    gitFileSnapshot,
                    missingRegistrationMode,
                    reportFailure,
                    preflightFence,
                );
                if (ready && missingRegistrationMode === "inspect") {
                    onPreflightReady?.(() => {
                        ports.assertNestedRepositoryIdentity(resolvedSource, sourceIdentity);
                        ports.assertDirectoryIdentity(resolvedWorkspace, workspaceIdentity);
                        ports.assertPathIdentity(gitFile, gitFileIdentity);
                        if (!ports.metadataMatches(gitFile, gitFileSnapshot)) {
                            throw new Error("Workspace Git metadata changed while awaiting confirmation.");
                        }
                    });
                }
                return ready;
            }

            if (missingRegistrationMode === "inspect") return false;
            if (missingRegistrationMode === "confirmed") {
                return refuse("missing management entry reappeared before recovery");
            }
            if (!ports.isSourceWorktreeManagementRoot(ports.dirname(resolvedGitDirectory), commonGitDirectory)) {
                return false;
            }

            const managementEntry = ports.captureDirectoryIdentity(
                resolvedGitDirectory,
            );
            const managementRoot = ports.captureDirectoryIdentity(ports.join(
                commonGitDirectory,
                "worktrees",
            ));
            if (!ports.sameExistingObject(ports.dirname(managementEntry.realpath), managementRoot.realpath)) {
                return false;
            }
            const commonDirFile = ports.join(managementEntry.realpath, "commondir");
            const headFile = ports.join(managementEntry.realpath, "HEAD");
            const managementGitdir = ports.join(managementEntry.realpath, "gitdir");
            const commonDirIdentity = ports.captureFileIdentity(commonDirFile);
            const headIdentity = ports.captureFileIdentity(headFile);
            const managementGitdirIdentity = ports.capturePathIdentity(managementGitdir);
            const commonDirSnapshot = ports.captureMetadata(commonDirFile);
            const headSnapshot = ports.captureMetadata(headFile);
            const managementGitdirSnapshot = ports.captureMetadata(managementGitdir);
            const previousGitFile = ports.worktreeBackpointer(managementGitdir, managementGitdirSnapshot);
            if (!previousGitFile) return false;
            if (ports.pathExistsStrict(previousGitFile)) return false;
            const commonDirectory = ports.captureDirectoryIdentity(ports.worktreeCommonDirectory(
                managementEntry.realpath,
                commonDirSnapshot,
            ));
            if (!ports.sameExistingObject(commonDirectory.realpath, commonGitDirectory)) return false;

            const expectedRef = `refs/heads/${expectedBranch}`;
            if (ports.metadataBranchRef(headSnapshot) !== expectedRef) return false;
            const branchHead = ports.probeBackpointerBranchHead(sourceIdentity, expectedRef);
            const expectedOid = branchHead.oid;
            if (!branchHead.succeeded || !expectedOid) {
                return false;
            }

            ports.assertDirectoryIdentity(resolvedWorkspace, workspaceIdentity);
            ports.assertNestedRepositoryIdentity(resolvedSource, sourceIdentity);
            ports.assertPathIdentity(gitFile, gitFileIdentity);
            if (!ports.metadataMatches(gitFile, gitFileSnapshot)) return false;
            ports.assertDirectoryIdentity(managementEntry.realpath, managementEntry);
            ports.assertDirectoryIdentity(managementRoot.realpath, managementRoot);
            ports.assertFileIdentity(commonDirFile, commonDirIdentity);
            ports.assertFileIdentity(headFile, headIdentity);
            ports.assertFileIdentity(managementGitdir, managementGitdirIdentity);
            if (!ports.metadataMatches(commonDirFile, commonDirSnapshot)
                || !ports.metadataMatches(headFile, headSnapshot)
                || !ports.metadataMatches(managementGitdir, managementGitdirSnapshot)) {
                return false;
            }

            let installedPublication: MetadataPublication | null = null;
            let repaired = false;
            try {
                installedPublication = ports.publishWorktreeBackpointer(
                    managementGitdir,
                    gitFile,
                    managementGitdirIdentity,
                    managementGitdirSnapshot,
                );
                ports.assertDirectoryIdentity(resolvedWorkspace, workspaceIdentity);
                ports.assertNestedRepositoryIdentity(resolvedSource, sourceIdentity);
                ports.assertPathIdentity(gitFile, gitFileIdentity);
                if (!ports.metadataMatches(gitFile, gitFileSnapshot)
                    || !ports.isValidWorktree(resolvedWorkspace, resolvedSource)) return false;
                const currentBranchHead = ports.probeBackpointerBranchHead(sourceIdentity, expectedRef);
                ports.assertDirectoryIdentity(resolvedWorkspace, workspaceIdentity);
                ports.assertNestedRepositoryIdentity(resolvedSource, sourceIdentity);
                ports.assertPathIdentity(gitFile, gitFileIdentity);
                ports.assertMetadataPublication(managementGitdir, installedPublication);
                if (!currentBranchHead.succeeded
                    || currentBranchHead.oid !== expectedOid
                    || !ports.metadataMatches(gitFile, gitFileSnapshot)
                    || !ports.metadataPublicationMatches(managementGitdir, installedPublication)) {
                    return false;
                }
                repaired = true;
                return true;
            } finally {
                if (!repaired && installedPublication) {
                    try {
                        ports.restoreMetadata(
                            managementGitdir,
                            managementGitdirSnapshot,
                            installedPublication,
                        );
                    } catch (error) {
                        throw ports.createRecoveryRollbackError("Workspace root backpointer recovery rollback failed; workspace content was preserved.", error);
                    }
                }
            }
        } catch (error) {
            if (ports.isExceptionalRecoveryError(error)) throw error;
            if (missingRegistrationMode === "confirmed") {
                reportFailure?.(error instanceof Error ? error.message : String(error));
            }
            return false;
        }
    }
    return { handleWorkspaceRootOwnership, recreateMissingWorkspaceRootRegistration };
}
