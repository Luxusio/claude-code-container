import type { MountVerification } from "../domain/container/mount-verification.js";

export interface ContainerCreateLifecycleRequest {
    containerName: string;
    projectMountIdentity: string;
    profile?: string;
    debug?: boolean;
}

export type ContainerCreateResult =
    | { kind: "created"; containerId: string | null }
    | { kind: "failed" };

export type ContainerCreateFailure =
    | { kind: "namespace-appeared"; containerName: string }
    | { kind: "collision"; containerName: string; profile: string }
    | { kind: "create-failed" }
    | { kind: "unpinned-session" };

export type CreatedContainerRejection =
    | { kind: "verification-failed"; reason: string }
    | { kind: "missing-id-verification" }
    | { kind: "post-create-check-failed" };

export type RejectedContainerCleanup =
    | { kind: "not-authorized" }
    | { kind: "attempted"; containerId: string; removal: "completed" | "failed"; absence: "proved" | "unproved" | "failed" };

export type ContainerCreateLifecycleOutcome =
    | { kind: "completed"; value: string }
    | { kind: "refused"; failure: ContainerCreateFailure }
    | { kind: "rejected"; rejection: CreatedContainerRejection; cleanup: RejectedContainerCleanup };

export type CreatedContainerMountVerification = MountVerification;

export interface ContainerCreateLifecyclePorts<PreparedCreate> {
    withFamilyLock(prefix: string, operation: () => ContainerCreateLifecycleOutcome): ContainerCreateLifecycleOutcome;
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
