import type { QemuLab } from "../domain/qemu-lifecycle.mjs";
import type { MacosVmDevice } from "../domain/lifecycle/macos-vm-lifecycle.mjs";
export interface ObservationRecord {
    id: string;
    ownerId?: string;
    backend?: string;
    kind?: string;
    physical?: boolean;
    available?: boolean;
    status?: string;
    lifecycle?: string | {
        runtimeId?: string;
        operation?: string;
    } | null;
    creatable?: boolean;
    attachable?: boolean;
    hardwareId?: string;
    serial?: string;
    udid?: string;
    updatedAt?: string;
    simulatorName?: string;
    avdRoot?: string;
    appium?: {
        serverUrl?: string;
        serverPid?: number;
        sessionId?: string;
        updatedAt?: string;
    } | null;
    recording?: {
        active?: boolean;
        provider?: string;
        startedAt?: string;
    } | null;
    helper?: {
        status?: string;
        provisioning?: {
            status?: string;
            provider?: string;
        } | null;
    } | null;
}
export interface ObservationLease {
    hardwareId: string;
    ownerId: string;
    deviceId?: string;
    expiresAt?: string;
    heartbeatAt?: string;
}
export interface ObservationCommand {
    status: number | null;
    stdout: string;
    stderr: string;
}
export interface Prerequisites {
    available: boolean;
    missing: string[];
}
export interface AndroidFacts extends Prerequisites {
    adb: string | null;
    emulator: string | null;
    avdmanager: string | null;
    provisioningAvailable: boolean;
    provisioningMissing: string[];
}
export interface IosFacts extends Prerequisites {
    xcrun: string | null;
}
export interface IosPhysicalFacts extends IosFacts {
    xcodebuild: string | null;
}
export interface WindowsFacts extends Prerequisites {
    wsb: string | null;
}
export interface MacosProvider {
    name: string;
    command: string;
}
export interface MacosFacts extends Prerequisites {
    hostSupported: boolean;
    providers: MacosProvider[];
}
export interface Simulator {
    name?: string;
    udid?: string;
    state?: string;
    isAvailable?: boolean;
}
export interface SimulatorInventory {
    devices?: Record<string, Simulator[]>;
    runtimes?: {
        name?: string;
        identifier?: string;
        isAvailable?: boolean;
    }[];
    devicetypes?: {
        name?: string;
        identifier?: string;
    }[];
    deviceTypes?: {
        name?: string;
        identifier?: string;
    }[];
}
export type SimulatorObservation = {
    value: SimulatorInventory;
    error?: undefined;
} | {
    error: ObservationCommand;
    value?: undefined;
};
export interface AndroidHostDevice {
    serial: string;
    state: string;
    model?: string;
    product?: string;
    device?: string;
    transportId?: string;
    connection?: string;
    physical?: boolean;
}
export interface IosHostDevice {
    name: string;
    udid: string;
    version: string;
    connection: string;
    raw: string;
}
export interface AndroidCreationFacts {
    systemImages: string[];
    deviceProfiles: string[];
    creationDiscovery?: {
        diagnostics?: string[];
        truncated?: boolean;
    };
}
export interface MacosHelperPaths {
    workspaceDir: string;
    toolsDir: string;
    hostHelperScript: string;
}
export interface LinuxRunnerFacts {
    ownerId: string;
    stateRoot: string;
    runner?: string;
    runnerStatus?: string;
    unsupportedReason?: string;
    kvmPath: string;
    kvmAvailable: boolean;
    qemu: string | null;
    qemuImg: string | null;
}
export interface LinuxProviderStatus {
    ok: true;
    provider: string;
    available: boolean;
    status: string;
    unsupportedReason: string | null;
    ownerId: string;
    stateRoot: string;
    qemu: string | null;
    qemuImg: string | null;
    kvmPath: string;
    networkMode: string;
}
export interface TargetObservationPorts {
    ownerId(): string;
    now(): number;
    readPhysicalLeases(backend: string): ObservationLease[];
}
interface Common extends TargetObservationPorts {
    readonly capabilities: readonly string[];
}
export interface AndroidObservationPorts extends Common {
    readonly kind: "android-emulator";
    executable(name: "adb" | "emulator" | "avdmanager"): string | null;
    records(): ObservationRecord[];
    avdResult(emulator: string): ObservationCommand;
    creationFacts(facts: AndroidFacts): AndroidCreationFacts;
}
export interface AndroidPhysicalObservationPorts extends Common {
    readonly kind: "android-device";
    androidPrerequisites(): AndroidFacts;
    records(): ObservationRecord[];
    hostResult(adb: string): {
        available: boolean;
        missing: string[];
        devices: AndroidHostDevice[];
        error?: string;
    };
}
export interface IosObservationPorts extends Common {
    readonly kind: "ios-simulator";
    executable(name: "xcrun"): string | null;
    records(): ObservationRecord[];
    simulators(xcrun: string, args: string[]): SimulatorObservation;
    ownedTarget(xcrun: string, device: ObservationRecord, inventory?: SimulatorObservation): {
        error?: string;
        simulator?: Simulator;
    };
    publishObserved(device: ObservationRecord, status: string, simulatorName: string | undefined): ObservationRecord | null | undefined;
}
export interface IosPhysicalObservationPorts extends Common {
    readonly kind: "ios-device";
    simulatorPrerequisites(): IosFacts;
    executable(name: "xcodebuild"): string | null;
    records(): ObservationRecord[];
    hostResult(xcrun: string): ObservationCommand & {
        devices: IosHostDevice[];
    };
}
export interface WindowsObservationPorts extends Common {
    readonly kind: "windows-sandbox";
    executable(name: "wsb"): string | null;
    records(): ObservationRecord[];
    helperMetadata(device: ObservationRecord): ObservationRecord["helper"];
    configPath(device: ObservationRecord): string;
    singleton(): {
        ownerId?: string;
        deviceId?: string;
        sandboxId?: string;
        claimId?: string;
    } | null;
}
export interface WindowsVmObservationPorts extends Common {
    readonly kind: "windows-vm";
    readonly platform: string;
    executable(name: "powershell.exe" | "pwsh" | "powershell"): string | null;
    records(): ObservationRecord[];
}
export interface MacosObservationPorts extends Common {
    readonly kind: "macos-vm";
    platform(): string;
    readonly providerNames: readonly string[];
    executable(name: string): string | null;
    records(): MacosVmDevice[];
    helperPaths(device: MacosVmDevice): MacosHelperPaths;
}
export interface LinuxObservationPorts extends Common {
    readonly kind: "linux-vm";
    runnerFacts(): LinuxRunnerFacts;
    labsRootExists(): boolean;
    labEntries(): {
        name: string;
        isDirectory(): boolean;
    }[];
    readLab(name: string): {
        ok: boolean;
        lab?: QemuLab;
    };
}
export type DeviceObservationPorts = AndroidObservationPorts | AndroidPhysicalObservationPorts | IosObservationPorts | IosPhysicalObservationPorts | WindowsObservationPorts | WindowsVmObservationPorts | MacosObservationPorts | LinuxObservationPorts;
export type DeviceObservationFacts = AndroidFacts | IosFacts | IosPhysicalFacts | WindowsFacts | MacosFacts | LinuxProviderStatus | {
    hostSupported: boolean;
    powershell: string | null;
    missing: string[];
    available: boolean;
};
export interface ObservationOptions {
    identityOnly?: boolean;
    strictState?: boolean;
}
