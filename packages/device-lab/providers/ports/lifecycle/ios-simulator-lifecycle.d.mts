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
export type IosSimulatorInventory = { kind: "failed"; message: string; receipt: IosSimulatorCommandResult } | { kind: "listed"; devices: IosSimulatorHost[] };
export type IosSimulatorNativeResult = { kind: "succeeded"; receipt: IosSimulatorCommandResult } | { kind: "failed"; receipt: IosSimulatorCommandResult; message: string };
export type IosSimulatorLifecycleOutcome = { kind: "conflict"; payload: { ok: boolean; error: string; backend: string; deviceId: string | undefined; operation: string; found: boolean; rollback?: unknown } } | { kind: "text"; message: string | undefined } | { kind: "json"; payload: unknown } | { kind: "command-failure"; receipt: unknown };
export interface IosSimulatorBoot {
    ready: boolean; skipped: boolean; status?: number | null; stdout?: string; stderr?: string; error?: unknown;
}
export interface IosSimulatorSettlement { exited: boolean; signaled?: boolean; reason?: string; error?: string; [key: string]: unknown; }
export interface IosSimulatorLifecyclePorts {
    iosDeviceId(name: string | undefined): string;
    readIosDevices(): IosSimulatorDevice[];
    findIosDevice(deviceId: string | undefined): IosSimulatorDevice | null | undefined;
    ownerSimulatorPrefix(): string;
    slug(name: string | undefined): string;
    isOwnedSimulatorName(name: unknown): boolean;
    iosDiscovery(): IosSimulatorDiscovery;
    inventory(xcrun: string | null): IosSimulatorInventory;
    createSimulator(xcrun: string | null, name: string, deviceType: string, runtime: string): { kind: "created"; udid: string } | { kind: "failed"; receipt: IosSimulatorCommandResult; message: string };
    simulatorOperation(xcrun: string | null, operation: "boot" | "shutdown" | "delete", target: string): IosSimulatorNativeResult;
    waitForBoot(xcrun: string | null, target: string, timeoutMs: number): IosSimulatorBoot;
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
    runtimeId(): string;
    wallTimestamp(): string;
}
