import type { RemoteConfig, RemoteEvent, RemoteForwardedEnvPlan, RemoteHeartbeat, RemoteOperationResult, RemotePrompt, RemoteReservationResult, RemoteSignal, RemoteSleep, RemoteSshChannel, RemoteStopResult, RemoteSyncAuthority, RemoteSyncInventory, RemoteTool, RemoteToolObservation } from "../domain/remote-services.js";

/** Semantic effects; native syntax, result interpretation and presentation stay outward. */
export interface RemoteServicesPorts<Evidence = unknown> {
    resolveProjectPath(path: string): string;
    getProjectId(path: string): string;
    getProjectHash(path: string): string;
    getMutagenSessionName(path: string): string;
    getScopedMutagenSessionName(authority: RemoteSyncAuthority): string;
    getContainerName(path: string, profile?: string): string;
    hashRemoteIdentity(value: string): string;
    newReservationToken(): string;
    observeTool(tool: RemoteTool): RemoteToolObservation;
    isHostReachable(host: string): boolean;
    remoteImagePresent(config: RemoteConfig): boolean;
    reserveContainer(request: { config: RemoteConfig; projectPath: string; profile?: string; token: string; leaseSeconds: number }): RemoteReservationResult<Evidence>;
    refreshReservation(request: { config: RemoteConfig; name: string; containerId: string; token: string; leaseSeconds: number }): boolean;
    releaseReservation(request: { config: RemoteConfig; name: string; token: string }): RemoteOperationResult<Evidence>;
    stopReservedContainer(request: { config: RemoteConfig; name: string; containerId: string; token: string }): RemoteStopResult<Evidence>;
    prepareRemoteProject(request: { config: RemoteConfig; containerId: string; projectId: string }): RemoteOperationResult<Evidence>;
    observeSyncInventory(remainingMs?: number): RemoteSyncInventory<Evidence>;
    createSync(request: { name: string; localPath: string; config: RemoteConfig; containerId: string; projectId: string }): RemoteOperationResult<Evidence>;
    resumeSync(identifier: string): RemoteOperationResult<Evidence>;
    terminateSync(identifier: string): RemoteOperationResult<Evidence>;
    pauseSync(identifier: string): RemoteOperationResult<Evidence>;
    startSyncDaemon(): void;
    readRemoteConfigs(): Record<string, unknown> | null;
    prepareLegacyConfigReader(hash: string): { exists(): boolean; readConfig(): RemoteConfig };
    saveRemoteConfig(hash: string, config: RemoteConfig): void;
    readUser(): string | undefined;
    prompt(request: { kind: "user"; defaultUser: string } | { kind: "cleanup" }): RemotePrompt;
    report(event: RemoteEvent<Evidence>): void;
    createSessionLock(prefix: string): string;
    removeSessionLock(file: string): undefined;
    removeSessionLockInHeldLifecycleLock(file: string): undefined;
    withLifecycleLock(prefix: string, operation: () => undefined): undefined;
    withLifecycleLockAsync<Value>(prefix: string, operation: () => Promise<Value>): Promise<Value>;
    startHeartbeat(callback: () => void, milliseconds: number): RemoteHeartbeat;
    onSignal(signal: RemoteSignal, callback: () => void): undefined;
    removeSignalListener(signal: RemoteSignal, callback: () => void): undefined;
    collectCurrentForwardedEnv(): RemoteForwardedEnvPlan;
    startInteractiveSession(request: { config: RemoteConfig; containerId: string; projectId: string; arguments: string[]; environment: Array<[string, string]> }): RemoteSshChannel;
    now(): number;
    sleep(milliseconds: number): RemoteSleep;
}

export type RemoteSyncPorts<Evidence = unknown> = Pick<RemoteServicesPorts<Evidence>,
    | "getProjectHash" | "getMutagenSessionName" | "getScopedMutagenSessionName"
    | "startSyncDaemon" | "observeSyncInventory" | "terminateSync" | "resumeSync" | "createSync"
    | "withLifecycleLockAsync" | "report" | "now" | "sleep"
>;
