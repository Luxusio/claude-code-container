export type MobileAppArguments = import("../domain/mobile-app-management.mjs").MobileAppArguments;
export type AndroidAppVariant = import("../domain/mobile-app-management.mjs").AndroidAppVariant;
export type MobileCommandReceipt = import("../domain/mobile-app-management.mjs").MobileCommandReceipt;
export type AndroidAppPayload = import("../domain/mobile-app-management.mjs").AndroidAppPayload;
export type AndroidAppPlan = import("../domain/mobile-app-management.mjs").AndroidAppPlan;
export type MobileTargetObservation<Target> = import("./android-control-transfer.mjs").TargetObservation<Target>;

/** Guarded resource handle; full native records retain their identity and extra fields. */
export interface AndroidAppTarget {
    device: { id: string; serial?: string; port?: number };
    adb: string;
}
export interface AndroidAppManagementPorts<Target extends AndroidAppTarget = AndroidAppTarget> {
    readonly variant: AndroidAppVariant;
    target(deviceId: unknown): MobileTargetObservation<Target>;
    /** Native serial qualification and helper-timeout normalization remain here. */
    execute(target: Target, args: (string | undefined)[], helperTimeoutMs: unknown): MobileCommandReceipt;
}
export type AndroidAppOutcome =
    | { kind: "json"; payload: AndroidAppPayload & { stdout?: string; stderr?: string; status: number | null } }
    | { kind: "text"; message: string }
    | { kind: "command-failure"; command: MobileCommandReceipt };

export interface IosSimulatorAppDevice { id: string; simulatorName?: string; udid?: string }
export interface IosPhysicalAppDevice { id: string; udid: string }
export type IosSimulatorDiscovery =
    | { available: true; xcrun: string; missing: string[] }
    | { available: false; xcrun?: string | null; missing: string[] };
export type IosOwnedTarget = { ok: true; target: string } | { ok: false; message: string };
export type IosAppContainerObservation =
    | { ok: true; containerRoot: string }
    | { ok: false; command: MobileCommandReceipt };
export type IosAppContainment = { ok: true } | { ok: false; message: string };
export interface IosAppReset {
    bundleId: string;
    containerType: string;
    containerRoot: string;
    resetAt: string;
}
export interface IosSimulatorAppManagementPorts<Device extends IosSimulatorAppDevice = IosSimulatorAppDevice> {
    readonly variant: "simulator";
    device(deviceId: unknown): Device | undefined;
    discovery(): IosSimulatorDiscovery;
    ownedTarget(xcrun: string, device: Device): IosOwnedTarget;
    execute(xcrun: string, args: (string | undefined)[], timeoutMs: number | undefined): MobileCommandReceipt;
    resolveAppContainer(xcrun: string, target: string, bundleId: string, containerType: string): IosAppContainerObservation;
    containAppContainer(containerRoot: string): IosAppContainment;
    clearAppContainer(containerRoot: string): undefined;
    publishAppReset(deviceId: unknown, reset: IosAppReset, updatedAt: string): Device | undefined;
    clock(): string;
}
export interface IosVerifiedAppSession { serverUrl: string; sessionId: string }
export type IosAppSessionObservation<Session extends IosVerifiedAppSession> =
    | { kind: "unknown" }
    | { kind: "refused"; message: string }
    | { kind: "ready"; session: Session };
export interface IosTerminateAppRequest {
    script: "mobile: terminateApp";
    args: [{ bundleId: string }];
}
export interface IosPhysicalAppManagementPorts<Device extends IosPhysicalAppDevice = IosPhysicalAppDevice, Session extends IosVerifiedAppSession = IosVerifiedAppSession> {
    readonly variant: "physical";
    device(deviceId: unknown): Device | undefined;
    xcrun(): string | null;
    execute(xcrun: string, args: (string | undefined)[], timeoutMs: number | undefined): MobileCommandReceipt;
    /** Preserve actual owner/lease/process/session selection and its lock/refusal handling. */
    session(deviceId: unknown): Promise<IosAppSessionObservation<Session>>;
    /** Exactly one native POST; application supplies terminate body and owns success policy. */
    request(session: Session, path: "/execute/sync", body: IosTerminateAppRequest): Promise<unknown>;
}
export type IosAppManagementPorts<Device extends IosSimulatorAppDevice = IosSimulatorAppDevice, Session extends IosVerifiedAppSession = IosVerifiedAppSession> =
    IosSimulatorAppManagementPorts<Device> | IosPhysicalAppManagementPorts<Device & IosPhysicalAppDevice, Session>;
export type IosAppPayload<Device> =
    | { installed: string | undefined; stdout?: string; stderr?: string; udid?: string; provider?: "xcrun-devicectl" }
    | { launched: string | undefined; stdout?: string; stderr?: string; udid?: string; provider?: "xcrun-devicectl" }
    | { stopped: string; provider: "appium-xcuitest"; physical: true }
    | { stopped: string; stdout?: string; stderr?: string; provider: "simctl" }
    | { uninstalled: string; stdout?: string; stderr?: string; provider: "simctl" }
    | { openedUrl: string | undefined; stdout?: string; stderr?: string; provider: "simctl" }
    | { permission: { bundleId: string; service: string; action: "grant" | "revoke" }; stdout?: string; stderr?: string; provider: "simctl" }
    | { reset: { bundleId: string; containerType: string }; containerRoot: string; device: Device | undefined; provider: "simctl-app-container" };
export type IosAppOutcome<Device> =
    | { kind: "json"; payload: IosAppPayload<Device> }
    | { kind: "text"; message: string }
    | { kind: "command-failure"; command: MobileCommandReceipt };
