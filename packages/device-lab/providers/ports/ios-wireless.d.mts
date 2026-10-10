export type IosWirelessArguments = import("../domain/ios-wireless.mjs").IosWirelessArguments;
export type IosWirelessDevice = import("../domain/ios-wireless.mjs").IosWirelessDevice;
export type IosWirelessInventory = import("../domain/ios-wireless.mjs").IosWirelessInventory;
export interface IosWirelessDiscovery { xcrun: string | null; then?: never; }
export interface IosWirelessPorts {
    discover(): IosWirelessDiscovery;
    listDevices(discovery: IosWirelessDiscovery): IosWirelessInventory;
}
export type IosWirelessOutcome =
    | { kind: "json"; payload: ReturnType<typeof import("../domain/ios-wireless.mjs").iosWirelessStatus> }
    | { kind: "text"; message: string };
