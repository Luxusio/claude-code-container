export interface WorkspaceRepairDirectoryIdentity {
    realpath: string;
    dev: string;
    ino: string;
}

/** Native receipts are carried by reference; these constraints expose only policy facts. */
export interface WorkspaceRepairAuthority {
    DirectoryIdentity: WorkspaceRepairDirectoryIdentity;
    FileIdentity: { dev: string; ino: string };
    NestedRepositoryIdentity: { directory: WorkspaceRepairDirectoryIdentity; commonDirectory: WorkspaceRepairDirectoryIdentity };
    BranchCreationFence: { expectedOid: string };
    WorktreeRegistrationFence: { destinationIdentity: WorkspaceRepairDirectoryIdentity };
    MissingWorktreeRegistrationFence: { managementIdentity: WorkspaceRepairDirectoryIdentity };
    QuarantineLocation: { path: string; directory: string };
    QuarantinedMissingWorktreeRegistration: { location: { path: string } };
    CapturedDirectoryTree: object;
    WorkspaceOwnershipEvidence: object;
    Environment: object;
    IndexContent: object;
    MetadataSnapshot: object;
    MetadataPublication: object;
    PreservedContentMerge: {
        worktreeRoot: string;
        skippedIgnoredDependencyTrees: Array<{ destinationPath: string }>;
        conflicts: string[];
    };
}

export interface WorkspaceRepairGitObservation {
    succeeded: boolean;
    failureReason?: string;
}

export interface WorkspaceRepairBranchHeadObservation extends WorkspaceRepairGitObservation {
    oid: string;
}

export interface WorkspaceRepairDestinationFence<Identity> {
    workspace: Identity;
    parents: Array<{ path: string; identity: Identity }>;
}
