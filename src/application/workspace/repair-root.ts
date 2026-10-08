import type { WorkspaceRepairAuthority } from "../../domain/workspace/repair-authority.js";
import type { RootWorkspaceRepairPorts } from "../../ports/workspace/repair-root.js";

export function createRootWorkspaceRepair<A extends WorkspaceRepairAuthority>(ports: RootWorkspaceRepairPorts<A>) {
    type DirectoryIdentity = A["DirectoryIdentity"];
    type FileIdentity = A["FileIdentity"];
    type NestedRepositoryIdentity = A["NestedRepositoryIdentity"];
    type CapturedDirectoryTree = A["CapturedDirectoryTree"];
    type MissingWorktreeRegistrationFence = A["MissingWorktreeRegistrationFence"];
    function recreateMissingWorkspaceRootRegistration(
        workspacePath: string,
        sourcePath: string,
        expectedBranch: string,
        commonGitDirectory: string,
        sourceIdentity: NestedRepositoryIdentity,
        staleGitDirectory: string,
        workspaceIdentity: DirectoryIdentity,
        gitFileIdentity: DirectoryIdentity,
        gitFileContent: string,
        mode: "inspect" | "confirmed",
        reportFailure?: (reason: string) => void,
        preflightFence?: () => void,
    ): boolean {
        const refuse = (stage: string, gitStderr?: string): false => {
            const reason = gitStderr ? ports.gitFailureReason(gitStderr) : undefined;
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
                if (ports.readMetadataText(() => ports.join(workspacePath, ".git")) !== gitFileContent) {
                    throw new Error("Workspace Git metadata changed during root registration recovery.");
                }
            }
            if (ownershipEvidence) ports.assertWorkspaceOwnershipEvidence(ownershipEvidence);
        };

        const expectedRef = `refs/heads/${expectedBranch}`;
        const sourceEnvironment = ports.pinnedNestedRepositoryEnvironment(sourceIdentity);
        const branchHead = ports.probeSourceBranchHead(sourceIdentity, sourceEnvironment, expectedRef);
        const expectedOid = (branchHead.stdout ?? "").trim();
        if (branchHead.error || branchHead.status !== 0 || !expectedOid) {
            return refuse("expected branch is unavailable", branchHead.stderr ?? undefined);
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
        let managementGitdirOriginal = "";
        let workspaceInstalledIdentity: DirectoryIdentity | null = null;
        let registrationInstalledIdentity: DirectoryIdentity | null = null;
        let workspaceInstalledContent = "";
        let registrationInstalledContent = "";
        let createdManagementIdentity: DirectoryIdentity | null = null;
        let createdManagementHeadIdentity: FileIdentity | null = null;
        let createdManagementTree: CapturedDirectoryTree | null = null;
        let managementRootIdentity: DirectoryIdentity | null = null;
        let temporaryGitFileIdentity: DirectoryIdentity | null = null;
        let temporaryGitFileContent = "";
        let failedRegistrationCommand = false;
        try {
            assertRecoveryAuthority();
            const registered = ports.registerTemporaryWorktree(sourceIdentity, sourceEnvironment, temporaryPath, expectedBranch);
            failedRegistrationCommand = Boolean(registered.error) || registered.status !== 0;
            if (failedRegistrationCommand) {
                return refuse("git worktree add failed", registered.stderr ?? registered.error?.message);
            }
            temporaryRegistered = true;

            const temporaryGitFile = ports.join(temporaryPath, ".git");
            const temporaryContent = ports.readMetadataText(() => temporaryGitFile);
            temporaryGitFileIdentity = ports.capturePathIdentity(temporaryGitFile);
            temporaryGitFileContent = temporaryContent;
            ports.assertPathIdentity(temporaryGitFile, temporaryGitFileIdentity);
            const temporaryMatch = temporaryContent.trim().match(/^gitdir:\s*(.+)$/);
            if (!temporaryMatch) return refuse("temporary Git link is invalid");
            const managementDirectory = ports.resolve(
                ports.dirname(temporaryGitFile),
                temporaryMatch[1].trim(),
            );
            const managementIdentity = ports.captureDirectoryIdentity(managementDirectory);
            createdManagementIdentity = managementIdentity;
            managementRootIdentity = ports.captureDirectoryIdentity(managementRoot);
            if (!ports.sameExistingObject(ports.dirname(managementIdentity.realpath), managementRootIdentity.realpath)
                || ports.pathExistsStrict(staleGitDirectory)) {
                return refuse("temporary registration is outside the source management root or the old entry reappeared");
            }
            const managementHead = ports.join(managementDirectory, "HEAD");
            managementGitdir = ports.join(managementDirectory, "gitdir");
            managementGitdirOriginal = ports.readMetadataText(() => managementGitdir);
            const managementHeadIdentity = ports.captureFileIdentity(managementHead);
            createdManagementHeadIdentity = managementHeadIdentity;
            const managementHeadContent = ports.readMetadataText(() => managementHead);
            createdManagementTree = ports.captureDirectoryTree(managementDirectory);
            if (!ports.sameExistingObject(ports.dirname(managementIdentity.realpath), managementRoot)
                || managementHeadContent.trim() !== `ref: ${expectedRef}`) {
                return refuse("temporary registration path or branch does not match");
            }
            const temporaryRepositoryIdentity = ports.captureNestedRepositoryIdentity(
                temporaryPath,
            );
            const temporaryEnvironment = ports.pinnedNestedRepositoryEnvironment(
                temporaryRepositoryIdentity,
            );
            const registeredHead = ports.readTemporaryHead(temporaryRepositoryIdentity, temporaryEnvironment);
            const currentBranchHead = ports.probeSourceBranchHead(sourceIdentity, sourceEnvironment, expectedRef);
            if (registeredHead.error || registeredHead.status !== 0) {
                return refuse("temporary registration HEAD could not be read",
                    (registeredHead.stderr ?? "").trim() || registeredHead.error?.message);
            }
            if (currentBranchHead.error || currentBranchHead.status !== 0) {
                return refuse("expected branch HEAD could not be read",
                    (currentBranchHead.stderr ?? "").trim() || currentBranchHead.error?.message);
            }
            if ((registeredHead.stdout ?? "").trim() !== expectedOid
                || (currentBranchHead.stdout ?? "").trim() !== expectedOid) {
                return refuse("temporary registration HEAD changed");
            }
            const initializedIndex = ports.initializeTemporaryIndex(temporaryRepositoryIdentity, temporaryEnvironment, expectedOid);
            createdManagementTree = ports.captureDirectoryTree(managementDirectory);
            if (initializedIndex.error || initializedIndex.status !== 0) {
                return refuse("git read-tree failed", initializedIndex.stderr ?? initializedIndex.error?.message);
            }
            const stagedDiff = ports.compareTemporaryIndex(temporaryRepositoryIdentity, temporaryEnvironment, expectedOid);
            if (stagedDiff.error || stagedDiff.status !== 0) {
                return refuse("temporary index does not match the expected branch", stagedDiff.stderr ?? stagedDiff.error?.message);
            }
            const managementIndex = ports.join(managementDirectory, "index");
            const managementIndexIdentity = ports.captureFileIdentity(managementIndex);
            const managementIndexContent = ports.captureIndexContent(managementIndex);
            ports.assertFileIdentity(managementHead, managementHeadIdentity);
            if (ports.readMetadataText(() => managementHead) !== managementHeadContent) {
                return refuse("temporary registration branch changed");
            }

            const portableGitDirectory = ports.portableInstalledGitDirectory(workspacePath, workspaceIdentity, managementDirectory, managementIdentity);
            assertRecoveryAuthority();
            if (!managementRootIdentity) return refuse("temporary management root identity is unavailable");
            ports.assertDirectoryIdentity(managementRoot, managementRootIdentity);
            if (ports.pathExistsStrict(staleGitDirectory)) return refuse("old management entry reappeared");
            ports.assertDirectoryIdentity(workspacePath, workspaceIdentity);
            workspaceInstalledContent = `gitdir: ${portableGitDirectory}\n`;
            ports.normalizeWorktreeMetadataFile(
                ports.join(workspacePath, ".git"),
                workspaceInstalledContent,
                gitFileIdentity,
                gitFileContent,
            );
            workspaceRewritten = true;
            workspaceInstalledIdentity = ports.capturePathIdentity(ports.join(workspacePath, ".git"));
            registrationInstalledContent = `${ports.portableWorktreeBackpointer(ports.join(workspacePath, ".git"))}\n`;
            ports.normalizeWorktreeMetadataFile(
                managementGitdir,
                registrationInstalledContent,
                ports.capturePathIdentity(managementGitdir),
                managementGitdirOriginal,
            );
            registrationRewritten = true;
            registrationInstalledIdentity = ports.capturePathIdentity(managementGitdir);

            if (!ports.withPinnedNestedRepository(
                sourceIdentity,
                () => ports.isValidWorktree(workspacePath, sourcePath,
                    (reason) => reportFailure?.(`relinked workspace validation failed: ${reason}`)),
            )) return false;
            const finalBranchHead = ports.probeSourceBranchHead(sourceIdentity, sourceEnvironment, expectedRef);
            if (finalBranchHead.error || finalBranchHead.status !== 0
                || (finalBranchHead.stdout ?? "").trim() !== expectedOid) {
                return refuse("expected branch changed after registration", finalBranchHead.stderr ?? undefined);
            }
            assertRecoveryAuthority(false);
            ports.assertDirectoryIdentity(managementRoot, managementRootIdentity);
            if (ports.pathExistsStrict(staleGitDirectory)) return refuse("old management entry reappeared after registration");
            ports.assertDirectoryIdentity(managementDirectory, managementIdentity);
            ports.assertFileIdentity(managementHead, managementHeadIdentity);
            ports.assertFileIdentity(managementIndex, managementIndexIdentity);
            if (ports.readMetadataText(() => managementHead) !== managementHeadContent
                || !ports.metadataIndexMatches(managementIndex, managementIndexContent)) {
                return refuse("temporary registration HEAD or index changed");
            }
            if (!workspaceInstalledIdentity || !registrationInstalledIdentity) {
                return refuse("installed Git metadata identity is unavailable");
            }
            ports.assertPathIdentity(ports.join(workspacePath, ".git"), workspaceInstalledIdentity);
            ports.assertPathIdentity(managementGitdir, registrationInstalledIdentity);
            if (ports.readMetadataText(() => ports.join(workspacePath, ".git"))
                    !== workspaceInstalledContent
                || ports.readMetadataText(() => managementGitdir)
                    !== registrationInstalledContent) return refuse("installed Git metadata changed");
            ports.assertDirectoryIdentity(temporaryPath, temporaryIdentity);
            if (ports.readDirectoryEntries(temporaryPath).some((entry) => entry !== ".git")) {
                return refuse("temporary workspace contains unexpected content");
            }
            if (!temporaryGitFileIdentity) return refuse("temporary Git link identity is unavailable");
            ports.assertPathIdentity(temporaryGitFile, temporaryGitFileIdentity);
            if (ports.readMetadataText(() => temporaryGitFile) !== temporaryGitFileContent) {
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
                        if (removed.error || removed.status !== 0
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
                    if (registrationRewritten && managementGitdir) {
                        if (!registrationInstalledIdentity) {
                            throw new Error("missing installed registration identity");
                        }
                        ports.normalizeWorktreeMetadataFile(
                            managementGitdir,
                            managementGitdirOriginal,
                            registrationInstalledIdentity,
                            registrationInstalledContent,
                        );
                    }
                    if (workspaceRewritten) {
                        if (!workspaceInstalledIdentity) {
                            throw new Error("missing installed workspace identity");
                        }
                        ports.normalizeWorktreeMetadataFile(
                            ports.join(workspacePath, ".git"),
                            gitFileContent,
                            workspaceInstalledIdentity,
                            workspaceInstalledContent,
                        );
                    }
                    ports.assertDirectoryIdentity(temporaryPath, temporaryIdentity);
                    if (ports.readDirectoryEntries(temporaryPath).some((entry) => entry !== ".git")) {
                        throw new Error("temporary registration directory contains unexpected content");
                    }
                    if (!temporaryGitFileIdentity) {
                        throw new Error("missing temporary Git file identity during rollback");
                    }
                    ports.assertPathIdentity(ports.join(temporaryPath, ".git"), temporaryGitFileIdentity);
                    if (ports.readMetadataText(() => ports.join(temporaryPath, ".git"))
                        !== temporaryGitFileContent) {
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
                        ports.captureFileIdentity(managementGitdir),
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
            const gitFileContent = ports.readMetadataText(() => gitFile);
            ports.assertPathIdentity(gitFile, gitFileIdentity);
            const gitFileMatch = gitFileContent.trim().match(/^gitdir:\s*(.+)$/);
            if (!gitFileMatch) return refuse("workspace Git link is invalid");
            const resolvedGitDirectory = ports.resolve(
                ports.dirname(gitFile),
                gitFileMatch[1].trim(),
            );

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
                    gitFileContent,
                    missingRegistrationMode,
                    reportFailure,
                    preflightFence,
                );
                if (ready && missingRegistrationMode === "inspect") {
                    onPreflightReady?.(() => {
                        ports.assertNestedRepositoryIdentity(resolvedSource, sourceIdentity);
                        ports.assertDirectoryIdentity(resolvedWorkspace, workspaceIdentity);
                        ports.assertPathIdentity(gitFile, gitFileIdentity);
                        if (ports.readMetadataText(() => gitFile) !== gitFileContent) {
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
            const commonDirContent = ports.readMetadataText(() => commonDirFile);
            const headContent = ports.readMetadataText(() => headFile);
            const managementGitdirContent = ports.readMetadataText(() => managementGitdir);
            const previousBackpointer = managementGitdirContent.trim();
            if (!previousBackpointer) return false;
            const previousGitFile = ports.isAbsolute(previousBackpointer)
                ? previousBackpointer
                : ports.resolve(ports.dirname(managementGitdir), previousBackpointer);
            if (ports.pathExistsStrict(previousGitFile)) return false;
            const commonDirectory = ports.captureDirectoryIdentity(ports.resolve(
                managementEntry.realpath,
                commonDirContent.trim(),
            ));
            if (!ports.sameExistingObject(commonDirectory.realpath, commonGitDirectory)) return false;

            const expectedRef = `refs/heads/${expectedBranch}`;
            if (headContent.trim() !== `ref: ${expectedRef}`) return false;
            const branchHead = ports.probeBackpointerBranchHead(sourceIdentity, expectedRef);
            const expectedOid = (branchHead.stdout ?? "").trim();
            if (branchHead.error || branchHead.status !== 0 || !expectedOid) {
                return false;
            }

            ports.assertDirectoryIdentity(resolvedWorkspace, workspaceIdentity);
            ports.assertNestedRepositoryIdentity(resolvedSource, sourceIdentity);
            ports.assertPathIdentity(gitFile, gitFileIdentity);
            if (ports.readMetadataText(() => gitFile) !== gitFileContent) return false;
            ports.assertDirectoryIdentity(managementEntry.realpath, managementEntry);
            ports.assertDirectoryIdentity(managementRoot.realpath, managementRoot);
            ports.assertFileIdentity(commonDirFile, commonDirIdentity);
            ports.assertFileIdentity(headFile, headIdentity);
            ports.assertFileIdentity(managementGitdir, managementGitdirIdentity);
            if (ports.readMetadataText(() => commonDirFile) !== commonDirContent
                || ports.readMetadataText(() => headFile) !== headContent
                || ports.readMetadataText(() => managementGitdir) !== managementGitdirContent) {
                return false;
            }

            const installedContent = `${ports.portableWorktreeBackpointer(gitFile)}\n`;
            let installedIdentity: DirectoryIdentity | null = null;
            let repaired = false;
            try {
                ports.normalizeWorktreeMetadataFile(
                    managementGitdir,
                    installedContent,
                    managementGitdirIdentity,
                    managementGitdirContent,
                );
                installedIdentity = ports.capturePathIdentity(managementGitdir);
                ports.assertDirectoryIdentity(resolvedWorkspace, workspaceIdentity);
                ports.assertNestedRepositoryIdentity(resolvedSource, sourceIdentity);
                ports.assertPathIdentity(gitFile, gitFileIdentity);
                if (ports.readMetadataText(() => gitFile) !== gitFileContent
                    || !ports.isValidWorktree(resolvedWorkspace, resolvedSource)) return false;
                const currentBranchHead = ports.probeBackpointerBranchHead(sourceIdentity, expectedRef);
                ports.assertDirectoryIdentity(resolvedWorkspace, workspaceIdentity);
                ports.assertNestedRepositoryIdentity(resolvedSource, sourceIdentity);
                ports.assertPathIdentity(gitFile, gitFileIdentity);
                ports.assertFileIdentity(managementGitdir, installedIdentity);
                if (currentBranchHead.error || currentBranchHead.status !== 0
                    || (currentBranchHead.stdout ?? "").trim() !== expectedOid
                    || ports.readMetadataText(() => gitFile) !== gitFileContent
                    || ports.readMetadataText(() => managementGitdir) !== installedContent) {
                    return false;
                }
                repaired = true;
                return true;
            } finally {
                if (!repaired && installedIdentity) {
                    try {
                        ports.normalizeWorktreeMetadataFile(
                            managementGitdir,
                            managementGitdirContent,
                            installedIdentity,
                            installedContent,
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
