export type EnvironmentArguments = import("../domain/mobile-environment.mjs").EnvironmentArguments;
export type EnvironmentOperation = import("../domain/mobile-environment.mjs").EnvironmentOperation;
export type BatterySetting = import("../domain/mobile-environment.mjs").BatterySetting;
export type EnvironmentCommandReceipt = import("./android-control-transfer.mjs").CommandReceipt;
export type EnvironmentTargetObservation<Target> = import("./android-control-transfer.mjs").TargetObservation<Target>;
export type EnvironmentCommandObservation =
    | { kind: "succeeded"; command: EnvironmentCommandReceipt }
    | { kind: "failed"; command: EnvironmentCommandReceipt };
export interface EnvironmentDevice { id: string }
export interface EnvironmentLocation { latitude?: number; longitude?: number; altitude?: number }
export interface AndroidPhysicalEnvironmentPorts<Target = unknown> {
    readonly variant: "physical";
    device(deviceId: string | undefined): EnvironmentDevice | undefined;
    target(deviceId: string | undefined): EnvironmentTargetObservation<Target>;
    writeClipboard(target: Target, text: string): EnvironmentCommandObservation;
    readClipboard(target: Target): EnvironmentCommandObservation;
}
export interface AndroidEmulatorEnvironmentPorts<Target = unknown> {
    readonly variant: "emulator";
    target(deviceId: string | undefined): EnvironmentTargetObservation<Target>;
    setLocation(target: Target, location: EnvironmentLocation): EnvironmentCommandObservation | { kind: "unavailable" };
    setBattery(target: Target, setting: BatterySetting): EnvironmentCommandObservation;
    tryAirplaneMode(target: Target, enabled: unknown): EnvironmentCommandObservation;
    setAirplaneSetting(target: Target, enabled: unknown): EnvironmentCommandObservation;
    broadcastAirplaneMode(target: Target, enabled: unknown): EnvironmentCommandObservation;
    setRadio(target: Target, setting: "wifi" | "data", enabled: boolean): EnvironmentCommandObservation;
    writeClipboard(target: Target, text: string): EnvironmentCommandObservation;
    readClipboard(target: Target): EnvironmentCommandObservation;
}
export type AndroidEnvironmentPorts<Target = unknown> =
    AndroidPhysicalEnvironmentPorts<Target> | AndroidEmulatorEnvironmentPorts<Target>;
export type IosEnvironmentTargetObservation<Target> =
    | { kind: "ready"; target: Target }
    | { kind: "refused"; message: string }
    | { kind: "missing-prerequisites"; missing: string[] };
export interface IosSimulatorEnvironmentPorts<Target = unknown, Device extends EnvironmentDevice = EnvironmentDevice> {
    readonly variant: "simulator";
    device(deviceId: string | undefined): Device | undefined;
    target(device: Device): IosEnvironmentTargetObservation<Target>;
    setLocation(target: Target, location: Pick<EnvironmentLocation, "latitude" | "longitude">): EnvironmentCommandObservation;
    writeClipboard(target: Target, text: string): EnvironmentCommandObservation;
    readClipboard(target: Target): EnvironmentCommandObservation;
}
export interface IosPhysicalEnvironmentPorts {
    readonly variant: "physical";
    device(deviceId: string | undefined): EnvironmentDevice | undefined;
}
export type IosEnvironmentPorts<Target = unknown, Device extends EnvironmentDevice = EnvironmentDevice> =
    IosSimulatorEnvironmentPorts<Target, Device> | IosPhysicalEnvironmentPorts;
export type EnvironmentApplied = "airplane-setting" | "airplane" | "wifi" | "data";
export type EnvironmentOutcome =
    | { kind: "location-set"; location: { latitude: number | undefined; longitude: number | undefined; altitude?: number }; command: EnvironmentCommandReceipt }
    | { kind: "battery-set"; battery: { level: number | undefined; status: number | undefined; charging: boolean | undefined }; commands: EnvironmentCommandReceipt[] }
    | { kind: "airplane-set"; enabled: unknown; route: "modern" | "legacy"; command: EnvironmentCommandReceipt }
    | { kind: "network-set"; network: { wifi: unknown; data: unknown; airplaneMode: unknown } }
    | { kind: "network-failure"; stage: "airplane-setting" | "airplane-broadcast" | "wifi" | "data"; command: EnvironmentCommandReceipt; applied?: EnvironmentApplied[] }
    | { kind: "clipboard-set"; command: EnvironmentCommandReceipt }
    | { kind: "clipboard-read"; command: EnvironmentCommandReceipt }
    | { kind: "refused"; message: string }
    | { kind: "command-failure"; command: EnvironmentCommandReceipt }
    | { kind: "missing-prerequisites"; missing: string[] };
