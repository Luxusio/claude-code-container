import type { BrokerWindowsSandboxRequest, BrokerWindowsSandboxResult, BrokerWindowsSandboxPublication, BrokerWindowsSandboxChange, BrokerWindowsSandboxPrepared } from '../../domain/lifecycle/windows-sandbox-lifecycle.js';
export interface BrokerWindowsSandboxAuxiliaryCleanup {
    result: {
        ok: boolean;
        changed: boolean;
        stateConflict?: boolean;
        appium: Record<string, unknown>;
        recording: Record<string, unknown>;
        minimizeWatchdog: Record<string, unknown>;
    };
    device: unknown;
    committed: boolean;
}
export interface BrokerWindowsSandboxHelperPaths {
    minimizeWatchdogCancelPath: string;
    minimizeWatchdogResultPath: string;
}
/** Native guarded leaves; lifecycle choices and response/compensation policy live inward. */
export interface BrokerWindowsSandboxLifecyclePorts<Prepared, Receipt> {
    prepare(ownerId:string,request:BrokerWindowsSandboxRequest,device:unknown):BrokerWindowsSandboxPrepared<Prepared>;
    run(handle:Prepared,options:{timeoutMs:number;outputLimit:number}):BrokerWindowsSandboxResult<Receipt>;
    listRuntime(handle:Prepared,options:{timeoutMs:number;outputLimit:number}):BrokerWindowsSandboxResult<Receipt>&{ids:string[]};
    isCanonicalConfig(ownerId: string, deviceId: string, path: string): boolean;
    writeConfig(ownerId: string, deviceId: string, device: Record<string, unknown>): undefined;
    claimSingleton(ownerId: string, device: unknown, sandboxId?: string): {
        ok: true;
    } | {
        ok: false;
        error: string;
        lock: Record<string, unknown> | null;
    };
    releaseSingleton(ownerId: string, device: unknown, sandboxId?: string): undefined;
    updateSingletonRuntimeId(ownerId: string, device: unknown, claimedId: string | undefined, runtimeId: string): undefined;
    helperPaths(ownerId: string, deviceId: string): BrokerWindowsSandboxHelperPaths;
    removeMarker(path: string): undefined;
    snapshotWindows(options:{timeoutMs:number;outputLimit:number}):BrokerWindowsSandboxResult<Receipt>&{handles:number[]|null};
    launchWatchdog(startedAfter:string,paths:BrokerWindowsSandboxHelperPaths,baseline:number[],options:{timeoutMs:number;outputLimit:number}):BrokerWindowsSandboxResult<Receipt>;
    waitForMinimizeConfirmation(path: string): BrokerWindowsSandboxResult<Receipt>;
    cancelWatchdog(ownerId: string, deviceId: string): {
        attempted: boolean;
        ok: boolean;
        cancelPath: string;
        error?: string;
    };
    cleanupAuxiliary(ownerId: string, parsed: BrokerWindowsSandboxRequest, expected: unknown): BrokerWindowsSandboxAuxiliaryCleanup;
    cleanArtifacts(ownerId: string, deviceId: string): {
        ok: boolean;
        removed: boolean;
        deviceRoot: string;
        error?: string;
    };
    inspectExpectedRecord(ownerId: string, stateKey: string, deviceId: string, expected: unknown): BrokerWindowsSandboxPublication;
    publish(ownerId: string, stateKey: string, deviceId: string, expected: unknown, change: BrokerWindowsSandboxChange): BrokerWindowsSandboxPublication;
    now(): number;
    timestampBefore(milliseconds: number): string;
    sleep(milliseconds: number): undefined;
    readonly platform: string;
    readonly commandTimeoutMs: number;
    readonly outputLimit: number;
}
