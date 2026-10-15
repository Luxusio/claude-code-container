import type { WorkspaceRepairAuthority } from "../../domain/workspace/repair-authority.js";
import type { NestedWorkspaceRepairPorts } from "./repair-nested.js";

type SharedBrokenRepairOperations = "resolve" | "join" | "dirname" | "primarySourceRepositoryForWorktree"
    | "assertWorkspaceRootOwnership" | "scanUnifiedNestedRepositories" | "captureNestedRepositoryIdentity"
    | "assertNestedRepositoryIdentity" | "ensureNestedWorktreeParent" | "assertNestedWorktreeDestinationFence"
    | "pathExistsStrict" | "captureDirectoryIdentity" | "assertDirectoryIdentity" | "readDirectoryEntries"
    | "isValidWorktree" | "withPinnedNestedRepository" | "captureMissingWorktreeRegistrationFence"
    | "quarantineMissingWorktreeRegistration" | "restoreQuarantinedMissingWorktreeRegistration"
    | "branchExistsInRepo" | "prepareWorktreeCreation" | "runPreparedWorktreeAdd" | "requireWorktreeRegistrationFence"
    | "pinnedNestedRepositoryEnvironment" | "removeRegisteredWorktree" | "rollbackFailedCreatedBranch" | "rollbackFailedWorktreeAdd";

export interface BrokenWorkspaceRepairPorts<A extends WorkspaceRepairAuthority> extends Pick<NestedWorkspaceRepairPorts<A>, SharedBrokenRepairOperations> {
    registrationToDisplace(source: string, destination: string, branch: string): { path: string } | null;
    createPrivateQuarantine(path: string, base: string): A["QuarantineLocation"];
    assertQuarantinedIdentity(path: string, identity: A["DirectoryIdentity"], kind: "directory" | "entry"): void;
    renameBrokenCheckout(source: string, destination: string): void;
    rollbackQuarantinedPath(path: string, quarantine: A["QuarantineLocation"], identity: A["DirectoryIdentity"], parent: A["DirectoryIdentity"], kind: "directory" | "entry"): boolean;
    removePrivateQuarantine(quarantine: A["QuarantineLocation"]): void;
    commitQuarantinedMissingWorktreeRegistration(registration: A["QuarantinedMissingWorktreeRegistration"]): void;
    warnDisplacedWorktreeRegistration(path: string, quarantinePath: string): void;
    warnWorktreeRepairFailure(path: string, detail: string): void;
    createPreservedContentMerge(path: string): A["PreservedContentMerge"];
    mergePreservingContent(source: string, destination: string, merge: A["PreservedContentMerge"]): void;
    createContentConflictError(path: string, merge: A["PreservedContentMerge"]): Error;
    noticeSkippedDependencyTrees(path: string, merge: A["PreservedContentMerge"]): void;
    defaultRemoveMergedBackup(): (path: string) => void;
    unlinkMergeDependencyLinks(merge: A["PreservedContentMerge"]): void;
}
