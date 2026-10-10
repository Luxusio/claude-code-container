export type EnvironmentArguments = import("../domain/mobile-environment.mjs").EnvironmentArguments;
export type EnvironmentOperation = import("../domain/mobile-environment.mjs").EnvironmentOperation;
export type EnvironmentCommandReceipt = import("./android-control-transfer.mjs").CommandReceipt;
export type EnvironmentTargetObservation<Target> = import("./android-control-transfer.mjs").TargetObservation<Target>;

export interface EnvironmentDevice { id: string }
export interface AndroidEnvironmentTarget {
    device: EnvironmentDevice & { serial?: string; port?: number };
    adb: string;
}
export interface AndroidPhysicalEnvironmentPorts<Target extends AndroidEnvironmentTarget = AndroidEnvironmentTarget> {
    readonly variant: "physical";
    device(deviceId: string | undefined): EnvironmentDevice | undefined;
    target(deviceId: string | undefined): EnvironmentTargetObservation<Target>;
    /** Exactly one serial-qualified command, not an airplane/network workflow. */
    execute(target: Target, args: string[]): EnvironmentCommandReceipt;
}
export interface AndroidEmulatorEnvironmentPorts<Target extends AndroidEnvironmentTarget = AndroidEnvironmentTarget> {
    readonly variant: "emulator";
    target(deviceId: string | undefined): EnvironmentTargetObservation<Target>;
    execute(target: Target, args: string[]): EnvironmentCommandReceipt;
    serial(target: Target): string | null | undefined;
    /** One emulator command; native binding qualifies it with this selected serial. */
    executeEmulator(target: Target, serial: string, args: string[]): EnvironmentCommandReceipt;
}
export type AndroidEnvironmentPorts<Target extends AndroidEnvironmentTarget = AndroidEnvironmentTarget> =
    AndroidPhysicalEnvironmentPorts<Target> | AndroidEmulatorEnvironmentPorts<Target>;

export type IosEnvironmentDiscovery =
    | { available: true; xcrun: string; missing: string[] }
    | { available: false; xcrun?: string | null; missing: string[] };
export type IosEnvironmentTarget = { ok: true; target: string } | { ok: false; message: string };
export interface IosSimulatorEnvironmentPorts<Device extends EnvironmentDevice = EnvironmentDevice> {
    readonly variant: "simulator";
    device(deviceId: string | undefined): Device | undefined;
    discovery(): IosEnvironmentDiscovery;
    ownedTarget(xcrun: string, device: Device): IosEnvironmentTarget;
    execute(xcrun: string, args: string[]): EnvironmentCommandReceipt;
    executeWithInput(xcrun: string, args: string[], input: string): EnvironmentCommandReceipt;
}
export interface IosPhysicalEnvironmentPorts {
    readonly variant: "physical";
    device(deviceId: string | undefined): EnvironmentDevice | undefined;
}
export type IosEnvironmentPorts<Device extends EnvironmentDevice = EnvironmentDevice> =
    IosSimulatorEnvironmentPorts<Device> | IosPhysicalEnvironmentPorts;

export interface EnvironmentStreams { stdout?: string; stderr?: string; status: number | null }
export type EnvironmentPayload =
    | { location: { latitude: number | undefined; longitude: number | undefined; altitude?: number | null }; provider: "adb-emulator" | "simctl"; stdout?: string; stderr?: string; status?: number | null }
    | { battery: { level: number | null; status: number | null; charging: boolean | null }; results: EnvironmentStreams[]; provider: "adb" }
    | { airplaneMode: unknown; provider: "adb"; method: "connectivity-shell" | "legacy-broadcast"; stdout?: string; stderr?: string; status: number | null }
    | { network: { wifi: unknown; data: unknown; airplaneMode: unknown }; provider: "adb" }
    | { ok: false; error: "android-network-command-failed"; detail: string; applied?: string[]; status: number | null; stderr?: string; stdout?: string }
    | { clipboard: { set: true }; provider: "adb" | "simctl"; stdout?: string; stderr?: string; status?: number | null }
    | { text: string | undefined; provider: "adb" | "simctl"; stderr?: string; status: number | null };
export type EnvironmentOutcome =
    | { kind: "json"; payload: EnvironmentPayload }
    | { kind: "text"; message: string }
    | { kind: "command-failure"; command: EnvironmentCommandReceipt }
    | { kind: "missing-prerequisites"; discovery: IosEnvironmentDiscovery };
