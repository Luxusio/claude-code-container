import type { MacosVmLifecycleInput, MacosVmDevice, MacosVmProviderPlan, MacosVmCommandResult, MacosVmClaimResult, MacosVmTransition, MacosVmRuntime, MacosVmSignal, MacosCloneFailureEvidence } from "./lifecycle/macos-vm-lifecycle.mjs";
export interface MacosImageInput extends MacosVmLifecycleInput { snapshotName?: string; snapshotId?: string; }
/** Native observations/effects only; lifecycle claim and clone policy is an inward peer. */
export interface MacosImageSnapshotsPorts<Result> {
    read(): MacosVmDevice[];
    find(deviceId: string | undefined): MacosVmDevice | null | undefined;
    claim(device: MacosVmDevice): MacosVmClaimResult;
    transition(deviceId: string | undefined, expected: MacosVmDevice, replacement: MacosVmDevice): MacosVmTransition;
    owner(): string;
    deviceId(name: string | undefined): string;
    snapshotId(name: string): string;
    timestamp(): string;
    runtimeId(): string;
    validateSshKey(path: string | null | undefined): { ok: true; path: string | null } | { ok: false; message: string };
    helperMetadata(device: Partial<MacosVmDevice>): MacosVmDevice["helper"];
    providerPlan(device: MacosVmDevice): MacosVmProviderPlan;
    providerCommand(command: string | null, args: (string | null | undefined)[], kind: string): MacosVmCommandResult;
    publicDevice(device: MacosVmDevice | null | undefined): unknown;
    signalRecording(recording: MacosVmRuntime | null | undefined, signal: string): MacosVmSignal;
    waitRecordingExit(recording: MacosVmRuntime | null | undefined, timeoutMs: number): Promise<boolean>;
    textResult(ok: boolean, message: string): Result;
    jsonResult(value: unknown): Result;
    presentRestoreFailure(evidence: MacosCloneFailureEvidence | null, fallbackError: string, candidate: string): Result;
    fail(command: MacosVmCommandResult): Result;
}
