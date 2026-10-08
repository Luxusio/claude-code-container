import type { RemoteActionResult, RemoteCommandResult, RemoteConfig, RemoteForwardedEnvPlan, RemoteHeartbeat, RemoteSignal, RemoteSshChannel } from "../domain/remote-services.js";

/** Required semantic effects; no native objects or whole-workflow callbacks. */
export interface RemoteServicesPorts {
    resolveProjectPath(path: string): string;
    getProjectId(path: string): string;
    getProjectHash(path: string): string;
    getMutagenSessionName(path: string): string;
    getContainerName(path: string, profile?: string): string;
    captureHashPath(): (value: string) => string;
    newReservationToken(): string;
    observeTool(tool: "tailscale" | "mutagen"): RemoteCommandResult;
    observeHostReachability(host: string): RemoteCommandResult;
    observeSync(name: string): RemoteCommandResult;
    startSyncDaemon(): RemoteActionResult;
    terminateSync(name: string): RemoteActionResult;
    resumeSync(name: string): RemoteActionResult;
    createSync(args: string[]): RemoteActionResult;
    pauseSync(name: string): RemoteActionResult;
    readCommonIgnoreDirs(): string[];
    readSettings(): Record<string, unknown>;
    captureLegacyConfigReader(hash: string): { exists(): boolean; readText(): string };
    updateSettings(callback: (settings: Record<string, unknown>) => undefined): undefined;
    readUser(): string | undefined;
    prompt(question: string, confirmation?: boolean): Promise<string>;
    captureLog(): (message: string) => undefined;
    captureError(): (message: string) => undefined;
    captureProgress(): (message: string) => undefined;
    observeRemoteImage(config: RemoteConfig): RemoteCommandResult;
    buildContainerStartShell(path: string, profile?: string): string;
    buildReservationShell(name: string, token: string, lease: number, command: string, pin: boolean): string;
    buildRefreshShell(name: string, token: string, lease: number, pin: boolean, expectedId?: string): string;
    buildReleaseShell(name: string, token: string): string;
    buildStopShell(name: string, token: string, expectedId: string): string;
    runReservation(config: RemoteConfig, buildBody: () => string): RemoteCommandResult;
    prepareRemoteProject(config: RemoteConfig, id: string, projectId: string): RemoteCommandResult;
    runRefresh(config: RemoteConfig, buildBody: () => string): RemoteCommandResult;
    runRelease(config: RemoteConfig, buildBody: () => string): RemoteCommandResult;
    runStop(config: RemoteConfig, buildBody: () => string): RemoteCommandResult;
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
    readContainerEnvKey(): string;
    readContainerEnvValue(): string;
    encodeProgram(program: string): string;
    startInteractiveSsh(config: RemoteConfig, command: string): RemoteSshChannel;
    now(): number;
    sleep(milliseconds: number): Promise<void>;
}

export type RemoteSyncPorts = Pick<RemoteServicesPorts, "resolveProjectPath" | "getProjectId" | "getMutagenSessionName" | "startSyncDaemon" | "observeSync" | "terminateSync" | "resumeSync" | "createSync" | "readCommonIgnoreDirs" | "captureLog" | "captureProgress" | "now" | "sleep">;
