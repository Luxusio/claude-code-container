import type { WindowsSandboxLifecycleDevice as Device, WindowsSandboxLifecycle as Lifecycle, WindowsSandboxTransition as Transition, WindowsSandboxWatchdogCleanup as WatchdogCleanup } from '../../domain/lifecycle/windows-sandbox-stop.mjs';
import type { WindowsSandboxStopPorts, WindowsSandboxLifecyclePorts, WindowsSandboxNativeResult, WindowsSandboxRegistration, WindowsSandboxRuntimeObservation } from '../../ports/lifecycle/windows-sandbox-stop.mjs';
export type WindowsSandboxClaim = {
    lifecycle: Lifecycle;
    claimed: Device;
    transition: Transition;
};
export type WindowsSandboxDeviceStopResult<Native extends object> = {
    ok: true;
    device: Device;
    watchdogCleanup: WatchdogCleanup;
} | {
    ok: false;
    error?: string;
    result?: Native;
    device?: Device;
    watchdogCleanup?: WatchdogCleanup;
};
export type WindowsSandboxStopOutcome<Native extends object> = {
    kind: 'unhandled';
} | {
    kind: 'completed';
    device: Device;
} | {
    kind: 'conflict';
    operation: string;
    transition: Transition;
} | {
    kind: 'refused';
    error?: string;
} | {
    kind: 'native-failure';
    evidence: Native;
};
export type WindowsSandboxLifecycleOutcome<Native extends object> = Exclude<WindowsSandboxStopOutcome<Native>, {kind: 'conflict'}> | {
    kind: 'deleted';
    deleted: string;
    scratchRemoved: string;
} | {
    kind: 'conflict';
    operation: string;
    transition: Transition;
    detail?: Record<string, unknown>;
} | {
    kind: 'registration-failed';
    registration: Extract<WindowsSandboxRegistration<Native>, {ok: false}>;
    ambiguous: boolean;
    cleanupIds: string[];
    cleanup: {ok: boolean; stopped: string[]; failed: {id: string; result: Native}[]; refused: boolean};
    cleanupVerify: WindowsSandboxRuntimeObservation<Native> | null;
    runtimeGone: boolean;
    releaseLockAfterFailure: boolean;
    watchdogCleanup: WatchdogCleanup;
} | {
    kind: 'singleton-conflict';
    deviceId: string;
    runtimeStopped: boolean;
    compensationRefused: boolean;
    watchdogCleaned: boolean;
};
export interface WindowsSandboxStopPolicy<Native extends object> {
    stop(deviceId: string): WindowsSandboxStopOutcome<Native>;
    claimLifecycle(deviceId: string, device: Device, operation: 'start' | 'stop' | 'delete'): WindowsSandboxClaim;
    currentLifecycleDevice(deviceId: string, lifecycle: Lifecycle): Device | null;
    abortLifecycle(deviceId: string, lifecycle: Lifecycle, original: Device, updates?: Partial<Device> | null): Transition;
    bindLifecycleSingleton(deviceId: string, claim: WindowsSandboxClaim, original: Device): {
        ok: true;
        claim: WindowsSandboxClaim;
    } | {
        ok: false;
        error?: string;
        conflict?: Transition;
    };
    cleanupWatchdogs(device: Device): WatchdogCleanup;
    stopDevice(device: Device): WindowsSandboxDeviceStopResult<Native>;
}
export function createWindowsSandboxStop<Binding extends object, Native extends object>(ports: WindowsSandboxStopPorts<Binding, Native>): WindowsSandboxStopPolicy<Native>;
export function createWindowsSandboxLifecycle<Binding extends object, Native extends WindowsSandboxNativeResult>(ports: WindowsSandboxLifecyclePorts<Binding, Native>): {
    start(args: {
        deviceId: string;
        minimized?: boolean;
    }): Promise<WindowsSandboxLifecycleOutcome<Native>>;
    stop(args: {
        deviceId: string;
    }): WindowsSandboxLifecycleOutcome<Native>;
    delete(args: {
        deviceId: string;
        force?: boolean;
    }): WindowsSandboxLifecycleOutcome<Native>;
};
