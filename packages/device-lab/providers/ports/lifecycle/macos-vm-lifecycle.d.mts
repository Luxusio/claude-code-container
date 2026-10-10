/** Legacy records are mutable; raw native fields cross without serialization. */
export interface MacosVmLifecycleInput {
    backend?: string; name?: string; deviceId?: string; sourceDeviceId?: string;
    sourceImage?: string | null; image?: string | null; provider?: string;
    memoryMb?: number; cpus?: number; headless?: boolean; force?: boolean;
    sshHost?: string; sshPort?: number; sshUser?: string; sshKeyPath?: string; sshPassword?: string;
    waitForBoot?: boolean; bootTimeoutMs?: number;
}
export interface MacosVmSsh {
    host?: string | null; port?: number; user?: string | null;
    keyPath?: string | null; password?: string | null; [key: string]: unknown;
}
export interface MacosVmLifecycleClaim {
    runtimeId: string; operation: string; claimedAt: string; previousStatus?: string;
}
export interface MacosVmRuntime {
    runtimeId?: string; providerPid?: number | null; pid?: number; active?: boolean;
    processIdentity?: {pid: number; startToken: string; commandHash: string};
    remotePath?: string; [key: string]: unknown;
}
export interface MacosVmSnapshot {
    id: string; name?: string; provider?: string; providerInstance?: string; [key: string]: unknown;
}
export interface MacosVmRecovery {
    candidateProviderInstance?: string | null; supersededCandidateProviderInstances?: string[];
    [key: string]: unknown;
}
export interface MacosVmDevice {
    id: string; name?: string; backend?: string; ownerId?: string; provider?: string | null;
    providerInstance?: string; providerResourceManaged?: boolean; image?: string | null;
    memoryMb?: number; cpus?: number; headless?: boolean; softnet?: boolean;
    ssh?: MacosVmSsh | null; helper?: {provisioning?: unknown; [key: string]: unknown};
    status?: string; lifecycle?: MacosVmLifecycleClaim | null; runtime?: MacosVmRuntime | null;
    recording?: MacosVmRuntime | null; snapshots?: MacosVmSnapshot[]; restoreRecovery?: MacosVmRecovery | null;
    provisioning?: string; imageSource?: string; clonedFrom?: unknown; imageCreatedAt?: string; clonedAt?: string;
    bootReady?: boolean; lastBootCheck?: MacosVmBoot | null; [key: string]: unknown;
}
export interface MacosVmCommand { command: string; args: string[] }
export interface MacosVmCommandResult {
    status: number | null; stdout: string; stderr: string; signal?: string | null;
    error?: {message?: string; code?: string} | null;
}
export interface MacosVmProviderPlan {
    available: boolean; missing: string[]; selectedProvider: string | null;
    providerCommand: string | null; providerInstance: string;
    startCommand: MacosVmCommand | null; stopCommand: MacosVmCommand | null; [key: string]: unknown;
}
export interface MacosVmTransition {
    matched: boolean; found: boolean; device?: MacosVmDevice | null; [key: string]: unknown;
}
export type MacosVmClaimResult = {ok: true} | {
    ok: false; field: string; value: unknown; existing?: MacosVmDevice; [key: string]: unknown;
};
/** The actual native child retains its method receiver and process authority. */
export interface MacosVmProcessHandle { readonly pid?: number; unref(): unknown }
export interface MacosVmBoot {
    ready: boolean; skipped?: boolean; ip?: string; [key: string]: unknown;
}
export interface MacosVmProvision {
    ok: boolean; error?: string; command?: MacosVmCommandResult; provisioning?: unknown;
    [key: string]: unknown;
}
export interface MacosVmSignal { signaled: boolean; exited?: boolean; reason?: string }
export interface MacosVmRollback { ok: boolean; attempted?: boolean; [key: string]: unknown }

/** Required native leaves; no callback may perform an entire lifecycle. */
export interface MacosVmLifecyclePorts<Result, Child extends MacosVmProcessHandle = MacosVmProcessHandle> {
    read(): MacosVmDevice[];
    find(deviceId: string | undefined): MacosVmDevice | null;
    claim(device: MacosVmDevice): MacosVmClaimResult;
    transition(deviceId: string | undefined, expected: MacosVmDevice | null, replacement: MacosVmDevice | null): MacosVmTransition;
    owner(): string; deviceId(name: string | undefined): string;
    timestamp(): string; now(): number; runtimeId(): string; claimTtlMs(): number;
    parseLifecycleClaimedAt(value: string): number;
    validateSshKey(path: string | null | undefined): {ok: true; path: string | null} | {ok: false; message: string};
    helperMetadata(device: Partial<MacosVmDevice>): {provisioning?: unknown; [key: string]: unknown};
    providerPlan(device: MacosVmDevice): MacosVmProviderPlan;
    tartPlan(device: MacosVmDevice, toolName: string): {plan: MacosVmProviderPlan; error?: undefined} | {error: Result; plan?: undefined};
    publicDevice(device: MacosVmDevice): unknown;
    providerCommand(command: string | null, args: (string | null | undefined)[], kind: string): MacosVmCommandResult;
    commandTimedOut(result: MacosVmCommandResult): boolean;
    tartStartArgs(instance: string, device: MacosVmDevice): string[];
    supportsFeature(command: string, feature: string): boolean;
    spawn(command: string, args: string[]): Child;
    waitProviderStart(child: Child, label: string): Promise<Result | null>;
    waitBoot(plan: MacosVmProviderPlan, timeoutMs: number, deadlineAt: number): Promise<MacosVmBoot>;
    waitGuestHelper(device: MacosVmDevice, deadlineAt: number): Promise<MacosVmProvision>;
    provisionHelper(device: MacosVmDevice): MacosVmProvision;
    signalRecording(recording: MacosVmRuntime | null | undefined, signal: string): MacosVmSignal;
    waitRecordingExit(recording: MacosVmRuntime, timeoutMs: number): Promise<boolean>;
    sshBridge(device: MacosVmDevice, toolName: string): {error: Result; discovery?: undefined; target?: undefined} | {error?: undefined; discovery: {ssh: string}; target: string};
    sshBaseArgs(device: MacosVmDevice): string[];
    shellQuote(text: string): string;
    sshCommandOptions(device: MacosVmDevice): object;
    helperCommand(command: string, args: string[], timeoutMs: undefined, options: object): MacosVmCommandResult;
    textResult(ok: boolean, text: string): Result;
    jsonResult(value: unknown): Result;
    fail(result: MacosVmCommandResult): Result;
}
