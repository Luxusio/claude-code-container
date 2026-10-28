export interface IosAccessAppium {
    runtimeId?: string;
    authority?: string;
    processOwner?: string;
    startedBy?: string;
    serverUrl?: string;
    serverPid?: number | null;
    processIdentity?: unknown;
    sessionId?: string;
    automationName?: string;
    physical?: boolean;
    updatedAt?: string;
}
export interface IosAccessDevice {
    id: string;
    name?: string;
    simulatorName?: string;
    udid?: string;
    createdAt?: string;
    appiumPort?: number;
    appium?: IosAccessAppium | null;
    recording?: unknown;
    lifecycle?: { runtimeId?: string };
    leaseClaimId?: string;
    leaseClaimNonce?: string;
}
export interface IosAccessArgs {
    deviceId?: string;
    command?: string;
    argv?: string[];
    bundleId?: string;
    path?: string;
    limit?: number;
    containerType?: string;
    eraseSimulator?: boolean;
    text?: string;
    timeoutMs?: number;
    intervalMs?: number;
}
export interface IosAccessDiscovery {
    available: boolean;
    missing: string[];
}
export type IosAccessAppiumDiscovery = IosAccessDiscovery;
export interface IosAccessCommand {
    status: number | null;
    stdout: string;
    stderr: string;
    signal?: string | null;
    error?: { code?: unknown; message?: string };
    timedOut?: boolean;
}
export type IosAccessAppiumEffect =
    | { kind: "server-status"; serverUrl: string; timeoutMs?: number }
    | { kind: "session-status" | "delete-session"; serverUrl: string; sessionId: string }
    | { kind: "create-session"; serverUrl: string; target: string | undefined; deviceName: string; physical: boolean }
    | { kind: "source" | "screenshot" | "active-app"; serverUrl: string; sessionId: string; timeoutMs?: number };
export type IosAccessAppiumResult<Effect extends IosAccessAppiumEffect> =
    Effect extends { kind: "server-status" | "session-status" | "delete-session" } ? undefined :
    Effect extends { kind: "create-session" } ? { sessionId: string | null } :
    Effect extends { kind: "source" } ? { source: unknown } :
    Effect extends { kind: "screenshot" } ? { data: unknown } :
    Effect extends { kind: "active-app" } ? { bundleIds: readonly string[]; activeApp: unknown } :
    Effect extends { kind: "source" | "screenshot" | "active-app" } ? { source: unknown } | { data: unknown } | { bundleIds: readonly string[]; activeApp: unknown } : undefined;
export type IosAccessProbe = "bundle-process" | "name-process" | "user-services" | "gui-services" | "system-services";
export type IosAccessSimulatorEffect =
    | ({ kind: "exec"; target: string } & ({ command: string | undefined; argv?: never } | { argv: string[]; command?: never }))
    | { kind: "screenshot"; target: string; path: string }
    | { kind: "erase"; target: string }
    | { kind: "app-container"; target: string; bundleId: string; containerType: string }
    | { kind: "app-probe"; target: string; bundleId: string; probe: IosAccessProbe; timeoutMs: number };
export interface IosAccessProbeObservation {
    kind: "present" | "absent" | "failed";
    receipt: IosAccessCommand;
    pid?: string | null;
    observedBy?: string;
}
export type IosAccessSimulatorResult<Effect extends IosAccessSimulatorEffect> =
    Effect extends { kind: "app-probe" } ? IosAccessProbeObservation :
    Effect extends { kind: "app-container" } ? IosAccessCommand & { ok: boolean; path: string } :
    IosAccessCommand & { ok: boolean };
export interface IosAccessRuntime {
    runtimeId?: string;
    serverPid?: number | null;
    pid?: number | null;
    processIdentity?: unknown;
}
export type IosAccessTermination = {
    exited: true; signaled?: boolean; reason?: string; error?: string;
} | {
    exited: false; signaled?: boolean; reason?: string; error: string;
};
export interface IosAccessErasePublication {
    status: "stopped";
    bootReady: false;
    lastReset: { eraseSimulator: true; resetAt: string; stdout: string; stderr: string };
    updatedAt: string;
}
export interface IosAccessChild {
    readonly pid: number | undefined;
    onExit(operation: () => undefined): undefined;
    unref(): undefined;
    abortStartup(): undefined;
}
export interface IosAccessBudget {
    readonly timeoutMs: number;
    remaining(): number;
    requestTimeout(maximum?: number): number;
    pause(): Promise<void>;
}
export interface IosAccessSession<Device extends IosAccessDevice> {
    device: Device | null;
    serverUrl: string;
    sessionId: string;
}
export type IosAccessSessionOutcome<Device extends IosAccessDevice> =
    | { unknown: true; error?: never; device?: never; serverUrl?: never; sessionId?: never }
    | { error: string; unknown?: never; device?: never; serverUrl?: never; sessionId?: never }
    | (IosAccessSession<Device> & { unknown?: never; error?: never });
export interface IosAccessCommonPorts<Device extends IosAccessDevice, Result> {
    findDevice(id: string | undefined): Device | null;
    discovery(): IosAccessDiscovery;
    appiumDiscovery(discovery?: IosAccessDiscovery): IosAccessAppiumDiscovery;
    backend(discovery: IosAccessDiscovery): object;
    targetStatus(device: Device): object;
    withDeviceOperation<T>(id: string | undefined, operation: () => T | Promise<T>): Promise<T>;
    waitBudget(timeoutMs?: number, intervalMs?: number): IosAccessBudget;
    appiumEffect<Effect extends IosAccessAppiumEffect>(effect: Effect): Promise<IosAccessAppiumResult<Effect>>;
    spawnServer(port: number): IosAccessChild;
    inspectRuntime(runtime: IosAccessRuntime): { status: string };
    waitIdentity(pid: number, timeoutMs: number): Promise<unknown | null>;
    refreshRuntime(runtime: IosAccessRuntime): IosAccessRuntime;
    terminateRuntime(runtime: IosAccessRuntime | null, label: string): Promise<IosAccessTermination>;
    isAlive(pid: number): boolean;
    publishAppium(id: string | undefined, expected: IosAccessAppium | null, replacement: IosAccessAppium | null, timestamp: string): { committed: boolean; device: Device | null };
    updateAppiumPort(id: string | undefined, runtimeId: string, port: number, timestamp: string): Device | null;
    guardObservation(id: string | undefined, original: Device, session: IosAccessSession<Device>, budget: IosAccessBudget): undefined;
    checkObservation(id: string | undefined, original: Device, session: IosAccessSession<Device>): undefined;
    timestamp(): string;
    runtimeId(): string;
    portForDevice(id: string): number;
    serverUrlForPort(port: number): string;
    pause(milliseconds: number): Promise<void>;
    diagnostic(text: string, maximumBytes: number): string;
    jsonResult(value: object): Result;
    textResult(ok: boolean, message: string): Result;
    commandFailure(command: IosAccessCommand | { status: number | null; stderr: string }): Result;
    imageResult(data: unknown): Result;
}
export interface IosSimulatorAccessPorts<Device extends IosAccessDevice, Result> extends IosAccessCommonPorts<Device, Result> {
    kind: "simulator";
    verifyTarget(device: Device): { target: string; error?: never } | { error: string; target?: never };
    simulatorEffect<Effect extends IosAccessSimulatorEffect>(effect: Effect): IosAccessSimulatorResult<Effect>;
    missingPrerequisites(discovery: IosAccessDiscovery): Result;
    reconcileDevice(device: Device, discovery: IosAccessDiscovery): Device;
    pathInContainer(root: string, requested: string): { path: string; error?: never } | { error: string; path?: never };
    guardRead(root: string, path: string): { error?: string };
    listArgumentError(args: IosAccessArgs): string | null;
    listDirectory(root: string, requested: string, limit: number): object;
    stageScreenshot(): { path: string; dispose(): undefined };
    readScreenshot(path: string): Result;
    publishErased(id: string | undefined, change: IosAccessErasePublication): Device | null;
}
export interface IosPhysicalAccessPorts<Device extends IosAccessDevice, Result> extends IosAccessCommonPorts<Device, Result> {
    kind: "physical";
    refreshLease(device: Device, budget?: IosAccessBudget): { ok: true } | { ok: false; error: string };
    hostDevices(discovery: IosAccessDiscovery): { udid?: string }[];
}
export type IosObservationAccessPorts<Device extends IosAccessDevice, Result> = IosSimulatorAccessPorts<Device, Result> | IosPhysicalAccessPorts<Device, Result>;
