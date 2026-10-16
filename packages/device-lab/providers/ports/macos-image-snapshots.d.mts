import type { MacosVmLifecycleInput, MacosVmDevice, MacosVmNativePlan, MacosVmNativeObservation, MacosVmClaimResult, MacosVmTransition } from "./lifecycle/macos-vm-lifecycle.mjs";
export interface MacosImageInput extends MacosVmLifecycleInput { snapshotName?: string; snapshotId?: string; }
/** Native observations/effects only; lifecycle claim and clone policy is an inward peer. */
export interface MacosImageSnapshotsPorts {
    read(): MacosVmDevice[];
    find(deviceId: string | undefined): MacosVmDevice | null | undefined;
    claim(device: MacosVmDevice): MacosVmClaimResult;
    transition(deviceId: string | undefined, expected: MacosVmDevice, replacement: MacosVmDevice): MacosVmTransition;
    owner(): string;
    deviceId(): string;
    snapshotId(name: string): string;
    timestamp(): string;
    runtimeId(): string;
    validateSshKey(path: string | null | undefined): { ok: true; path: string | null } | { ok: false; message: string };
    helperMetadata(device: Partial<MacosVmDevice>): MacosVmDevice["helper"];
    providerPlan(device: MacosVmDevice): MacosVmNativePlan;
    stopInstance(plan: MacosVmNativePlan): MacosVmNativeObservation;
    deleteInstance(plan: MacosVmNativePlan, instance: string | undefined): MacosVmNativeObservation;
    /** Persisted operation/cleanup diagnostics exclude native Error.message. */
    imageDiagnostic(observation: MacosVmNativeObservation, kind: "operation" | "cleanup" | "output"): string;
}
