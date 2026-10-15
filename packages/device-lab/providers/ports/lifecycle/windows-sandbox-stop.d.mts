import type { WindowsSandboxLifecycleDevice as Device, WindowsSandboxSingleton as Singleton, WindowsSandboxTransition as Transition, WindowsSandboxWatchdogCancellation as Cancellation, WindowsSandboxWatchdogLaunch as Watchdog, WindowsSandboxHelperSessionLaunch as Session, IsoTimestamp } from '../../domain/lifecycle/windows-sandbox-stop.mjs';
export interface WindowsSandboxStopPorts<Binding extends object, NativeResult extends object> {
    readSingleton(): Singleton | null;
    sameSingletonOwner(singleton: Singleton | null, device: Device, sandboxId?: string | null): boolean;
    newRuntimeId(): string;
    wallTimestamp(): IsoTimestamp;
    transitionDevice(deviceId: string, expected: Device, replacement: Device | null): Transition;
    findDevice(deviceId: string): Device | undefined;
    claimSingleton(device: Device, sandboxId: string, claimId: string): {
        ok: true;
        lock: Singleton;
    } | {
        ok: false;
        error: string;
    };
    releaseSingleton(device: Device, claimId?: string | null): boolean;
    singletonGenerationMatches(device: Device): boolean;
    watchdogCancelPath(device: Device): string;
    cancelWatchdog(path: string): Cancellation | null | undefined;
    discoverRuntime(): {
        available: boolean;
        missing: string[];
        binding: Binding;
    };
    stopOwnedRuntime(binding: Binding, device: Device, timeoutMs: number): {
        ok: boolean;
        evidence: NativeResult;
    };
}
/** Opaque native evidence, interpreted only by the composition binding/presenter. */
export type WindowsSandboxNativeResult = object;
export interface WindowsSandboxNativeObservation<NativeResult extends object> {
    ok: boolean;
    result: NativeResult;
}
export interface WindowsSandboxRuntimeObservation<NativeResult extends object> extends WindowsSandboxNativeObservation<NativeResult> {
    ids: string[];
}
export interface WindowsSandboxHelperMetadata {
    minimizeWatchdogCancelPath: string;
    minimizeWatchdogResultPath: string;
}
export type WindowsSandboxRegistration<NativeResult extends object> = {
    ok: true;
    sandboxId: string;
    skipped?: boolean;
    matchedRequested?: boolean;
    requestedSandboxId?: string;
    result?: NativeResult;
    observedIds?: string[];
    newIds?: string[];
} | {
    ok: false;
    error: string;
    result: NativeResult | null;
    lastObservationOk: boolean;
    observedIds: string[];
    newIds: string[];
};
export interface WindowsSandboxLifecyclePorts<Binding extends object, NativeResult extends object, Result> extends WindowsSandboxStopPorts<Binding, NativeResult> {
    readDevices(): Device[];
    helperMetadata(device: Device): WindowsSandboxHelperMetadata;
    writeConfig(device: Device): string;
    readConfig(path: string): string;
    resetHelperMarkers(helper: WindowsSandboxHelperMetadata): undefined;
    listRuntime(binding: Binding, timeoutMs: number): WindowsSandboxRuntimeObservation<NativeResult>;
    stopRuntime(binding: Binding, id: string, timeoutMs: number): WindowsSandboxNativeObservation<NativeResult>;
    registrationDiagnostic(result: NativeResult | null): string;
    timestampBefore(milliseconds: number): string;
    windowHandles(): number[] | null;
    launchConfig(path: string, minimized: boolean, timeoutMs: number): WindowsSandboxNativeObservation<NativeResult>;
    launchRuntime(binding: Binding, id: string, config: string, minimized: boolean, timeoutMs: number): WindowsSandboxNativeObservation<NativeResult>;
    launchWatchdog(startedAfter: string, cancelPath: string, timeoutMs: number, handles: number[] | null, resultPath: string): {
        ok: boolean;
        launch: Exclude<Watchdog, null | false | 0 | ''>;
        warning?: string;
    };
    updateSingletonRuntimeId(device: Device, claimedId: string, runtimeId: string, claimId?: string | null): boolean;
    waitForMinimizeConfirmation(path: string): Promise<{
        ok: boolean;
        warning?: string;
    }>;
    launchSession(binding: Binding, id: string, minimized: boolean): Session;
    scratchDirectory(device: Device): string;
    removeScratch(device: Device): undefined;
    readonly platform: string;
    now(): number;
    wait(milliseconds: number): Promise<void>;
    targetStatus(device: Device): unknown;
    lifecycleConflict(id: string, operation: string, transition: Transition, detail?: Record<string, unknown>): Result;
    textResult(ok: boolean, text: string | undefined): Result;
    jsonResult(value: unknown): Result;
    fail(result: NativeResult): Result;
}
