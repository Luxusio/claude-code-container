export interface ContainerCreateLifecycleRequest {
    containerName: string;
    projectMountIdentity: string;
    profile?: string;
    debug?: boolean;
}

export type ContainerCreateResult =
    | { kind: "created"; containerId: string | null }
    | { kind: "failed"; cause?: unknown };

export type ContainerCreateFailure =
    | { kind: "namespace-appeared"; containerName: string }
    | { kind: "collision"; containerName: string; profile: string }
    | { kind: "create-failed" }
    | { kind: "verification-failed"; reason: string }
    | { kind: "missing-id-verification" }
    | { kind: "rejected-removal-failed"; containerId: string; error: unknown }
    | { kind: "unpinned-session" };

export type CreatedContainerMountVerification =
    | { kind: "verified"; via: "shape" | "source" | "identity" | "daemon" }
    | { kind: "deferred"; reason: string; containerPath: string }
    | { kind: "retryable"; reason: string; containerPath?: string }
    | { kind: "mismatch"; reason: string; containerPath?: string };

export interface ContainerCreateLifecyclePorts<PreparedCreate> {
    failCreate(failure: ContainerCreateFailure): never;
    withFamilyLock(prefix: string, operation: () => string): string;
    namespaceExists(name: string): boolean;
    findCollision(): { containerName: string } | null;
    reportCreating(name: string, debug: boolean | undefined): undefined;
    reportLabWarning(): undefined;
    reportCreateFailure(): undefined;
    prepareCreate(): PreparedCreate;
    assertProjectSources(): undefined;
    assertDeviceSources(): undefined;
    assertFilesystemSources(): undefined;
    create(prepared: PreparedCreate): ContainerCreateResult;
    verifyCreated(id: string): CreatedContainerMountVerification;
    removeRejected(id: string): undefined;
    explicitlyAbsent(id: string): boolean;
    syncMcp(id: string): undefined;
    fixSsh(id: string): undefined;
    syncGit(id: string): undefined;
    finish(id: string): string;
}
