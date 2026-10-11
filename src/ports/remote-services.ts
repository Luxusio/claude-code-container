import type { RemoteConfig, RemoteEvent, RemoteFailureKind, RemoteForwardedEnvPlan, RemoteHeartbeat, RemoteOperationResult, RemoteReservationResult, RemoteSignal, RemoteSshChannel, RemoteStopResult, RemoteSyncObservation, RemoteTool, RemoteToolObservation } from "../domain/remote-services.js";

/** Semantic effects; native syntax, result interpretation and presentation stay outward. */
export interface RemoteServicesPorts<Evidence = unknown> {
    resolveProjectPath(path: string): string;
    getProjectId(path: string): string;
    getProjectHash(path: string): string;
    getMutagenSessionName(path: string): string;
    getContainerName(path: string, profile?: string): string;
    hashRemoteIdentity(value: string): string;
    newReservationToken(): string;
    observeTool(tool: RemoteTool): RemoteToolObservation;
    isHostReachable(host: string): boolean;
    remoteImagePresent(config: RemoteConfig): boolean;
    reserveContainer(request: { config: RemoteConfig; projectPath: string; profile?: string; token: string; leaseSeconds: number }): RemoteReservationResult<Evidence>;
    refreshReservation(request: { config: RemoteConfig; name: string; containerId: string; token: string; leaseSeconds: number }): boolean;
    releaseReservation(request: { config: RemoteConfig; name: string; token: string }): void;
    stopReservedContainer(request: { config: RemoteConfig; name: string; containerId: string; token: string }): RemoteStopResult<Evidence>;
    prepareRemoteProject(request: { config: RemoteConfig; containerId: string; projectId: string }): RemoteOperationResult<Evidence>;
    observeSync(name: string, expectedContainerId?: string): RemoteSyncObservation<Evidence>;
    createSync(request: { name: string; localPath: string; config: RemoteConfig; containerId: string; projectId: string }): RemoteOperationResult<Evidence>;
    resumeSync(name: string): RemoteOperationResult<Evidence>;
    terminateStaleSync(name: string): RemoteOperationResult<Evidence>;
    terminateSync(name: string): void;
    pauseSync(name: string): void;
    startSyncDaemon(): void;
    readRemoteConfigs(): Record<string, unknown> | null;
    prepareLegacyConfigReader(hash: string): { exists(): boolean; readConfig(): RemoteConfig };
    saveRemoteConfig(hash: string, config: RemoteConfig): void;
    readUser(): string | undefined;
    prompt(request: { kind: "user"; defaultUser: string } | { kind: "cleanup" }): Promise<string>;
    report(event: RemoteEvent<Evidence>): void;
    fail(kind: RemoteFailureKind, evidence?: Evidence): never;
    createSessionLock(prefix: string): string;
    removeSessionLock(file: string): undefined;
    withLifecycleLock(prefix: string, operation: () => undefined): undefined;
    withLifecycleLockAsync<Value>(prefix: string, operation: () => Promise<Value>): Promise<Value>;
    startHeartbeat(callback: () => void, milliseconds: number): RemoteHeartbeat;
    onceSignal(signal: RemoteSignal, callback: () => void): undefined;
    removeSignalListener(signal: RemoteSignal, callback: () => void): undefined;
    resignalSelf(signal: RemoteSignal): boolean;
    exit(code: number): never;
    collectCurrentForwardedEnv(): RemoteForwardedEnvPlan;
    startInteractiveSession(request: { config: RemoteConfig; containerId: string; projectId: string; arguments: string[]; environment: Array<[string, string]> }): RemoteSshChannel;
    now(): number;
    sleep(milliseconds: number): Promise<void>;
}

export type RemoteSyncPorts<Evidence = unknown> = Pick<RemoteServicesPorts<Evidence>,
    | "resolveProjectPath" | "getProjectId" | "getMutagenSessionName"
    | "startSyncDaemon" | "observeSync" | "terminateStaleSync" | "resumeSync" | "createSync"
    | "report" | "fail" | "now" | "sleep"
>;
