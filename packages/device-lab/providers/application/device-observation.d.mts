import type { ObservationTarget, ObservationLease } from "../domain/device-observation.mjs";
import { observationTargetStatus, observationMacosPlan } from "../domain/device-observation.mjs";
import type { MacosVmDevice } from "../domain/lifecycle/macos-vm-lifecycle.mjs";
import type { QemuLab } from "../domain/qemu-lifecycle.mjs";
import type { TargetObservationPorts, ObservationRecord, ObservationOptions, AndroidFacts, IosFacts, IosPhysicalFacts, WindowsFacts, MacosFacts, SimulatorObservation, SimulatorInventory, AndroidCreationFacts, AndroidHostDevice, IosHostDevice, LinuxProviderStatus, AndroidObservationPorts, AndroidPhysicalObservationPorts, IosObservationPorts, IosPhysicalObservationPorts, WindowsObservationPorts, WindowsVmObservationPorts, MacosObservationPorts, LinuxObservationPorts } from "../ports/device-observation.mjs";
export type TargetOptions = NonNullable<Parameters<typeof observationTargetStatus>[2]>;
export type TargetStatus = ReturnType<typeof observationTargetStatus>;
export type PresentedTarget<Device extends ObservationTarget> = Device & TargetStatus & {
    targetStatus: TargetStatus;
};
export function normalizeDeviceTarget(target: ObservationTarget, options: TargetOptions | undefined, ports: TargetObservationPorts, snapshots?: Map<string, ObservationLease[]>): TargetStatus;
export function presentDeviceTarget<Device extends ObservationTarget>(target: Device, options: TargetOptions | undefined, ports: TargetObservationPorts, snapshots?: Map<string, ObservationLease[]>): PresentedTarget<Device>;
export function presentDeviceTargets<Device extends ObservationTarget>(targets: Device[], options: TargetOptions | undefined, ports: TargetObservationPorts): PresentedTarget<Device>[];
export interface DeviceBackendDescriptor {
    name: string;
    host: string;
    creatable: boolean;
    available: boolean;
    lazy: true;
    status: string;
    missing: string[];
    capabilities: readonly string[];
    attachable?: boolean;
    provider?: string;
    tools?: {
        adb?: string | null;
        emulator?: string | null;
        avdmanager?: string | null;
        xcrun?: string | null;
        xcodebuild?: string | null;
        wsb?: string | null;
        powershell?: string | null;
    };
    provisioning?: {
        available: boolean;
        missing: string[];
    };
    providers?: {
        name: string;
        command: string;
    }[];
}
export interface HostDevices<Device> {
    available: boolean;
    missing: string[];
    devices: Device[];
    error?: string;
}
export interface OwnedInventory<Device, Facts> {
    backend: string;
    ownerId: string;
    devices: Device[];
    discovery: Facts;
}
export type AndroidInventory = OwnedInventory<PresentedTarget<ObservationRecord>, AndroidFacts> & AndroidCreationFacts & {
    hostAvds: {
        available: boolean;
        missing: string[];
        avds: string[];
        error?: string;
    };
};
export type AndroidPhysicalInventory = OwnedInventory<PresentedTarget<ObservationRecord>, {
    adb: string | null;
    available: boolean;
    missing: string[];
}> & {
    hostDevices: HostDevices<AndroidHostDevice>;
};
export type IosInventory = OwnedInventory<PresentedTarget<ObservationRecord>, IosFacts> & {
    hostSimulators: {
        available: boolean;
        missing: string[];
        devices: NonNullable<SimulatorInventory["devices"]>;
        runtimes: NonNullable<SimulatorInventory["runtimes"]>;
        deviceTypes: NonNullable<SimulatorInventory["deviceTypes"]>;
        error?: string;
    };
};
export type IosPhysicalInventory = OwnedInventory<PresentedTarget<ObservationRecord>, IosPhysicalFacts> & {
    hostDevices: HostDevices<IosHostDevice>;
};
export type WindowsInventory = OwnedInventory<PresentedTarget<ObservationRecord>, WindowsFacts> & {
    hostSandboxes: {
        provider: string;
        available: boolean;
        command: string | null;
        missing: string[];
        lazy: true;
        singleton: true;
        lock: ReturnType<WindowsObservationPorts["singleton"]>;
        note: string;
    };
};
export type MacosInventory = OwnedInventory<PresentedTarget<MacosVmDevice>, MacosFacts> & {
    hostVms: {
        providers: {
            name: string;
            command: string;
        }[];
        available: boolean;
        missing: string[];
        lazy: true;
        note: string;
    };
};
export type LinuxDevice = QemuLab & {
    deviceId: string;
    backend: "linux-vm";
    provider: string;
    capabilities: readonly string[];
};
export interface LinuxLabs {
    ok: true;
    ownerId: string;
    labs: QemuLab[];
}
export type LinuxInventory = LinuxLabs & {
    backend: "linux-vm";
    devices: LinuxDevice[];
    discovery: LinuxProviderStatus;
};
export interface DeviceObservation<Facts, Device, Inventory> {
    discovery(): Facts;
    backend(facts?: Facts): DeviceBackendDescriptor;
    owned(options?: ObservationOptions): Device[];
    inventory(args?: {
        backend?: string;
    }): Inventory | undefined;
}
export function createDeviceObservation(ports: AndroidObservationPorts): DeviceObservation<AndroidFacts, PresentedTarget<ObservationRecord>, AndroidInventory>;
export function createDeviceObservation(ports: AndroidPhysicalObservationPorts): DeviceObservation<AndroidFacts, PresentedTarget<ObservationRecord>, AndroidPhysicalInventory>;
export function createDeviceObservation(ports: IosObservationPorts): DeviceObservation<IosFacts, ObservationRecord | PresentedTarget<ObservationRecord>, IosInventory> & {
    reconcile(device: ObservationRecord, facts: IosFacts, inventory?: SimulatorObservation): ObservationRecord;
};
export function createDeviceObservation(ports: IosPhysicalObservationPorts): DeviceObservation<IosPhysicalFacts, PresentedTarget<ObservationRecord>, IosPhysicalInventory> & {
    discovery(ios?: IosFacts): IosPhysicalFacts;
};
export function createDeviceObservation(ports: WindowsObservationPorts): DeviceObservation<WindowsFacts, PresentedTarget<ObservationRecord>, WindowsInventory>;
export function createDeviceObservation(ports: WindowsVmObservationPorts): DeviceObservation<{
    hostSupported: boolean;
    powershell: string | null;
    missing: string[];
    available: boolean;
}, ObservationRecord, never>;
export function createDeviceObservation(ports: MacosObservationPorts): DeviceObservation<MacosFacts, MacosVmDevice | PresentedTarget<MacosVmDevice>, MacosInventory> & {
    plan(device: MacosVmDevice, facts: MacosFacts): ReturnType<typeof observationMacosPlan>;
    project(device: MacosVmDevice, facts: MacosFacts): PresentedTarget<MacosVmDevice>;
};
export function createDeviceObservation(ports: LinuxObservationPorts): DeviceObservation<LinuxProviderStatus, LinuxDevice, LinuxInventory> & {
    labs(options?: ObservationOptions): LinuxLabs;
};
