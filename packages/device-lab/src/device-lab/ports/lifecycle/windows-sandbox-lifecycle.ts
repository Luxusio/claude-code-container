import type { BrokerWindowsSandboxRequest, BrokerWindowsSandboxCommand, BrokerWindowsSandboxResult, BrokerWindowsSandboxPlannedCommand, BrokerWindowsSandboxPublication, BrokerWindowsSandboxChange } from '../../domain/lifecycle/windows-sandbox-lifecycle.js';
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
export interface BrokerWindowsSandboxLifecyclePorts {
    execute(command: BrokerWindowsSandboxCommand, options: {
        timeoutMs: number;
        outputLimit: number;
    }): BrokerWindowsSandboxResult;
    executable(name: 'wsb'): string | null;
    stopRuntimeId(ownerId: string, device: unknown): string | null;
    newRuntimeId(): string;
    readConfig(ownerId: string, deviceId: string, recordedPath: string | null): {
        ok: true;
        config: string;
    } | {
        ok: false;
        error: string;
        missing: string[];
    };
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
    runtimeIds(stdout: string): string[];
    windowSnapshotCommand(): BrokerWindowsSandboxCommand;
    windowHandles(stdout: string): number[] | null;
    watchdogCommand(startedAfter: string, paths: BrokerWindowsSandboxHelperPaths, baseline: number[]): BrokerWindowsSandboxCommand;
    waitForMinimizeConfirmation(path: string): BrokerWindowsSandboxResult;
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
    redactDevice(device: unknown): unknown;
    failureDetail(result: BrokerWindowsSandboxResult): string;
    now(): number;
    timestampBefore(milliseconds: number): string;
    sleep(milliseconds: number): undefined;
    readonly platform: string;
    readonly commandTimeoutMs: number;
    readonly outputLimit: number;
}
export type { BrokerWindowsSandboxPlannedCommand };
