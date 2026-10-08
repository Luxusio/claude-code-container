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
    PreservedContentMerge: {
        worktreeRoot: string;
        skippedIgnoredDependencyTrees: Array<{ destinationPath: string }>;
        conflicts: string[];
    };
}

export interface WorkspaceRepairGitObservation {
    status: number | null;
    stdout?: string | null;
    stderr?: string | null;
    error?: { message: string };
}

export interface WorkspaceRepairDestinationFence<Identity> {
    workspace: Identity;
    parents: Array<{ path: string; identity: Identity }>;
}
