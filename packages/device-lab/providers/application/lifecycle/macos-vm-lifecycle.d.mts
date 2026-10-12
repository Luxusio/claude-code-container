import type { MacosVmLifecycleInput, MacosVmLifecyclePorts, MacosVmProcessHandle, MacosVmDevice, MacosVmLifecycleClaim, MacosVmProviderPlan, MacosVmTransition, MacosVmCommandResult, MacosVmRollback, MacosCloneFailureEvidence, MacosVmNativePlan, MacosVmNativeObservation, MacosVmLifecycleOutcome, MacosNativeCloneFailureEvidence } from '../../ports/lifecycle/macos-vm-lifecycle.mjs';
export interface MacosVmLifecycle<Result> {
    create(input: MacosVmLifecycleInput): Result | undefined;
    createImage(input: MacosVmLifecycleInput): Result | undefined;
    start(input: MacosVmLifecycleInput): Promise<Result | undefined>;
    stop(input: MacosVmLifecycleInput): Promise<Result | undefined>;
    delete(input: MacosVmLifecycleInput): Promise<Result | undefined>;
    /** Shared helpers preserve existing snapshot/base-image callers without granting them whole-operation credit. */
    recoverStale(deviceId: string): {device?: MacosVmDevice | null; error?: Result};
    conflict(deviceId: string | undefined, operation: string, transition: {found: boolean; matched?: boolean}, rollback?: MacosVmRollback | null): Result;
    replacement(device: MacosVmDevice, lifecycle: MacosVmLifecycleClaim | null, updates?: Partial<MacosVmDevice>): MacosVmDevice;
    claimLifecycle(deviceId: string | undefined, device: MacosVmDevice, operation: string, updates?: Partial<MacosVmDevice>): {lifecycle: MacosVmLifecycleClaim; claimed: MacosVmDevice | null; transition: MacosVmTransition};
    currentLifecycleDevice(deviceId: string | undefined, lifecycle: MacosVmLifecycleClaim): MacosVmDevice | null;
    abortLifecycle(deviceId: string | undefined, lifecycle: MacosVmLifecycleClaim, original: MacosVmDevice, updates?: Partial<MacosVmDevice>): MacosVmTransition | {matched: false; found: boolean};
    transitionCurrent(deviceId: string | undefined, lifecycle: MacosVmLifecycleClaim, updater: (current: MacosVmDevice) => MacosVmDevice): MacosVmTransition | {matched: false; found: boolean};
    rollbackStarted(deviceId: string | undefined, lifecycle: MacosVmLifecycleClaim, plan: MacosVmProviderPlan): MacosVmRollback;
    rollbackCreated(deviceId: string | undefined, plan: MacosVmProviderPlan, instance: string): MacosVmRollback;
    clone(plan: MacosVmProviderPlan, source: string | null | undefined, target: string): {result: MacosVmCommandResult; cleanup: MacosVmCommandResult | null};
    cloneFailureEvidence(command: MacosVmCommandResult, cleanup: MacosVmCommandResult | null, target: string): MacosCloneFailureEvidence;
    cloneFailure(result: MacosVmCommandResult, cleanup: MacosVmCommandResult | null, target: string): Result;
}
export interface MacosVmNativeLifecycle extends Omit<MacosVmLifecycle<MacosVmLifecycleOutcome>,'clone'|'cloneFailure'|'cloneFailureEvidence'|'rollbackCreated'|'rollbackStarted'> {
    rollbackStarted(deviceId:string|undefined,lifecycle:MacosVmLifecycleClaim,plan:MacosVmNativePlan):MacosVmRollback;
    rollbackCreated(deviceId:string|undefined,plan:MacosVmNativePlan,instance:string):MacosVmRollback;
    clone(plan:MacosVmNativePlan,source:string|null|undefined,target:string):{result:MacosVmNativeObservation;cleanup:MacosVmNativeObservation|null};
    cloneFailure(result:MacosVmNativeObservation,cleanup:MacosVmNativeObservation|null,target:string):MacosVmLifecycleOutcome;
    cloneFailureEvidence(command:MacosVmNativeObservation,cleanup:MacosVmNativeObservation|null,target:string):MacosNativeCloneFailureEvidence;
}
export function createMacosVmLifecycleApplication<Child extends MacosVmProcessHandle = MacosVmProcessHandle>(ports: MacosVmLifecyclePorts<Child>): MacosVmNativeLifecycle;
