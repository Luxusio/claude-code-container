export interface ExistingContainerIdentity {
    containerId: string;
    running: boolean;
}

export interface ExistingContainerListing {
    known: boolean;
    containerId: string | null;
}

export interface ContainerExistingLifecycleRequest {
    containerName: string;
    debug?: boolean;
    managedProjectPath?: string;
    initiallyRunningContainerId?: string;
    replacementGuard?: (recreate: () => void) => boolean;
    onRecreate?: () => void;
}

export interface ContainerReplacementRequest extends ContainerExistingLifecycleRequest {
    reason: string;
    expectedContainerId?: string;
}

export type ContainerExistingLifecycleResult =
    | { kind: "joined"; containerId: string }
    | { kind: "continue-to-create" };

export interface ContainerExistingLifecyclePorts {
    listContainer(name: string): ExistingContainerListing;
    identity(target: string): ExistingContainerIdentity | null;
    managedIdentity(id: string, projectPath: string): ExistingContainerIdentity | null;
    assertProjectSources(): undefined;
    assertDeviceSources(): undefined;
    assertFilesystemSources(): undefined;
    // Preflight may use static evidence only for the exact inspected stopped ID.
    // A match never authorizes setup; verifyBeforeSetup is mandatory before helpers.
    inspectContract(id: string, reportReason: (reason: string) => void): boolean | null;
    verifyBeforeSetup(id: string): undefined;
    safeToDefer(id: string, reportReason: (reason: string) => void): boolean;
    isRunning(name: string): boolean;
    canExec(id: string): boolean;
    canExecAfterBriefRetry(id: string): boolean;
    deviceSourcesMatch(): boolean;
    syncMcp(id: string): undefined;
    fixSsh(id: string): undefined;
    syncGit(id: string): undefined;
    start(id: string): undefined;
    stop(id: string): undefined;
    remove(id: string): undefined;
    reportContractMismatch(name: string): undefined;
    reportContractMatch(name: string): undefined;
    reportRestart(name: string): undefined;
    reportRecreation(reason: string): undefined;
    reportDeferred(reason: string): undefined;
    throwUnsafeDefer(reason: string): never;
    finish(id: string): undefined;
}
