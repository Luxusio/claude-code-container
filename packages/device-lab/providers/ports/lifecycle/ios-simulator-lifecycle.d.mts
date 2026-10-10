export interface IosSimulatorLifecycleInput {
    backend?: string; name?: string; deviceId?: string; simulatorName?: string;
    deviceType?: string; runtime?: string; udid?: string; createSimulator?: boolean;
    force?: boolean; deleteSimulator?: boolean; waitForBoot?: boolean; bootTimeoutMs?: number;
}
export interface IosSimulatorLifecycleClaim { runtimeId: string; operation: string; claimedAt: string; }
export interface IosSimulatorRecording {
    pid?: number; active?: boolean; stagingPath?: string; processIdentity?: unknown;
    endedAt?: string; [key: string]: unknown;
}
export interface IosSimulatorAppium {
    runtimeId?: string; processOwner?: string; startedBy?: string; serverPid?: number;
    processIdentity?: unknown; serverUrl?: string; sessionId?: string; [key: string]: unknown;
}
export interface IosSimulatorDevice {
    id?: string; name?: string; backend?: string; ownerId?: string; simulatorName?: string;
    deviceType?: string | null; runtime?: string | null; udid?: string | null;
    status?: string; recording?: IosSimulatorRecording | null; appium?: IosSimulatorAppium | null;
    lifecycle?: IosSimulatorLifecycleClaim | null; bootReady?: boolean;
    createdAt?: string; updatedAt?: string; [key: string]: unknown;
}
export interface IosSimulatorCommandResult {
    status: number | null; stdout: string; stderr: string; error?: unknown; [key: string]: unknown;
}
export interface IosSimulatorDiscovery { xcrun: string | null; available: boolean; missing: string[]; }
export interface IosSimulatorTransition { matched: boolean; found: boolean; [key: string]: unknown; }
export interface IosSimulatorHost { name?: string; udid?: string; state?: string; [key: string]: unknown; }
export interface IosSimulatorInventoryValue { devices?: Record<string, IosSimulatorHost[]>; [key: string]: unknown; }
export type IosSimulatorInventory = { error: IosSimulatorCommandResult; value?: never } | { value: IosSimulatorInventoryValue; error?: never };
export interface IosSimulatorBoot {
    ready: boolean; skipped: boolean; status?: number | null; stdout?: string; stderr?: string; error?: unknown;
}
export interface IosSimulatorSettlement { exited: boolean; signaled?: boolean; reason?: string; error?: string; [key: string]: unknown; }
export interface IosSimulatorLifecyclePorts<Result> {
    iosDeviceId(name: string | undefined): string;
    readIosDevices(): IosSimulatorDevice[];
    findIosDevice(deviceId: string | undefined): IosSimulatorDevice | null | undefined;
    ownerSimulatorPrefix(): string;
    slug(name: string | undefined): string;
    isOwnedSimulatorName(name: unknown): boolean;
    iosDiscovery(): IosSimulatorDiscovery;
    simctlJson(xcrun: string | null, args: string[]): IosSimulatorInventory;
    run(executable: string | null, args: (string | undefined)[]): IosSimulatorCommandResult;
    runWithTimeout(executable: string | null, args: (string | undefined)[], timeoutMs: number): IosSimulatorCommandResult;
    ownerId(): string;
    appiumPortForIosDevice(id: string): number;
    claimIosDevice(device: IosSimulatorDevice): { ok: boolean; existing?: IosSimulatorDevice; field?: string; value?: unknown };
    transitionIosDevice(deviceId: string | undefined, expected: IosSimulatorDevice, replacement: IosSimulatorDevice | null): IosSimulatorTransition;
    signalOwnedRuntimeProcess(runtime: IosSimulatorRecording, signal: string): { signaled: boolean; reason?: string; [key: string]: unknown };
    waitForProcessExit(pid: number | undefined, timeoutMs: number): Promise<boolean>;
    inspectProcessIdentity(identity: unknown, pid: number | undefined): { status: string; [key: string]: unknown };
    deleteAppiumSession(appium: IosSimulatorAppium | null | undefined): Promise<void>;
    terminateOwnedAppiumProcess(appium: IosSimulatorAppium, label: string, timeoutMs?: number): Promise<IosSimulatorSettlement>;
    discardLocalOutputStage(path: string, options: { label: string; stageParent: string; stagePrefix: string }): { ok: boolean; message?: string };
    iosRecordingDir(device: IosSimulatorDevice): string;
    withTargetStatus(device: IosSimulatorDevice): unknown;
    textResult(ok: boolean, text: string | undefined): Result;
    jsonResult(payload: unknown): Result;
    fail(result: IosSimulatorCommandResult): Result;
    runtimeId(): string;
    wallTimestamp(): string;
}
