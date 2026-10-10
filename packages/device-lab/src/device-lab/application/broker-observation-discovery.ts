import { hyperVLinuxImageBlockers, type DiscoveryReadiness, type DiscoveryMacosProvider, type HostBackendDiscoveryConfiguration,
    type HostBackendDiscoveryRequest } from "../domain/broker-observation.js";
import type { HostBackendDiscoveryPorts } from "../ports/broker-observation.js";

export function createHostBackendDiscovery(ports: HostBackendDiscoveryPorts, configuration: HostBackendDiscoveryConfiguration) {
    return async function discover({ ownerId, platform, commandTimeoutMs }: HostBackendDiscoveryRequest) {
        const adb = ports.executable("adb");
        const emulator = ports.executable("emulator");
        const avdmanager = ports.executable("avdmanager");
        const xcrun = ports.executable("xcrun");
        const xcodebuild = ports.executable("xcodebuild");
        const wsb = ports.executable("wsb");
        const powershell = ports.executable("powershell.exe") || ports.executable("pwsh") || ports.executable("powershell");
        const ssh = ports.executable("ssh.exe") || ports.executable("ssh");
        const scp = ports.executable("scp.exe") || ports.executable("scp");
        const macosProviders = [...configuration.macosProviders]
            .map((name) => ({ name, command: ports.executable(name) }))
            .filter((provider): provider is { name: DiscoveryMacosProvider; command: string } => Boolean(provider.command));

        const androidMissing = [
            ...(adb ? [] : ["adb"]),
            ...(emulator ? [] : ["emulator"]),
        ];
        const androidProvisioningMissing = avdmanager ? [] : ["avdmanager"];
        const androidDeviceMissing = adb ? [] : ["adb"];
        const iosSimulatorMissing = xcrun ? [] : ["xcrun"];
        const iosDeviceMissing = [
            ...(xcrun ? [] : ["xcrun"]),
            ...(xcodebuild ? [] : ["xcodebuild"]),
        ];
        const windowsMissing = wsb ? [] : ["wsb"];
        let hyperVReadiness: DiscoveryReadiness | null = null;
        if (platform === "win32" && powershell) {
            hyperVReadiness = await ports.hyperVReadiness(powershell, Math.min(15000, commandTimeoutMs));
        }
        const hyperVMissing = platform !== "win32"
            ? ["windows-host"]
            : !powershell
                ? ["powershell"]
                : hyperVReadiness
                    ? hyperVReadiness.missing
                    : ["hyper-v-readiness"];
        // qemu-img blocks linux-vm only when create would have to acquire the ubuntu-lts image; the
        // cache is read from the private root and owner create uses.
        const hyperVLinuxImage = platform === "win32"
            ? hyperVLinuxImageBlockers(hyperVReadiness, ports.ubuntuImageCache(ownerId))
            : null;
        const hyperVLinuxMissing = [
            ...hyperVMissing,
            ...(hyperVLinuxImage?.blockers || []),
            ...(ssh ? [] : ["ssh"]),
            ...(scp ? [] : ["scp"]),
        ];
        const macosMissing = platform !== "darwin"
            ? ["macos-host"]
            : (macosProviders.length > 0 ? [] : ["macos-vm-provider"]);

        return {
            ownerId,
            hostId: ports.hostId(),
            platform: platform,
            source: "host-broker-provider-discovery",
            startsDevices: false,
            backends: [
                {
                    name: "android-emulator",
                    host: "host-or-container",
                    creatable: true,
                    available: androidMissing.length === 0,
                    lazy: true,
                    status: androidMissing.length === 0 ? "available" : "missing-prerequisites",
                    missing: androidMissing,
                    tools: { adb, emulator, avdmanager },
                    provisioning: { available: androidProvisioningMissing.length === 0, missing: androidProvisioningMissing },
                    capabilities: configuration.capabilities.androidEmulator,
                },
                {
                    name: "android-device",
                    host: "host-usb-adb",
                    creatable: false,
                    attachable: true,
                    available: androidDeviceMissing.length === 0,
                    lazy: true,
                    status: androidDeviceMissing.length === 0 ? "available" : "missing-prerequisites",
                    missing: androidDeviceMissing,
                    tools: { adb },
                    capabilities: configuration.capabilities.androidDevice,
                },
                {
                    name: "ios-simulator",
                    host: "macos-host",
                    creatable: true,
                    available: iosSimulatorMissing.length === 0,
                    lazy: true,
                    status: iosSimulatorMissing.length === 0 ? "available" : "missing-prerequisites",
                    missing: iosSimulatorMissing,
                    tools: { xcrun },
                    capabilities: configuration.capabilities.iosSimulator,
                },
                {
                    name: "ios-device",
                    host: "macos-host-usb-xcode",
                    creatable: false,
                    attachable: true,
                    available: iosDeviceMissing.length === 0,
                    lazy: true,
                    status: iosDeviceMissing.length === 0 ? "available" : "missing-prerequisites",
                    missing: iosDeviceMissing,
                    tools: { xcrun, xcodebuild },
                    capabilities: configuration.capabilities.iosDevice,
                },
                {
                    name: "windows-sandbox",
                    host: "windows-host",
                    creatable: true,
                    available: windowsMissing.length === 0,
                    lazy: true,
                    status: windowsMissing.length === 0 ? "available" : "missing-prerequisites",
                    missing: windowsMissing,
                    tools: { wsb },
                    capabilities: configuration.capabilities.windowsSandbox,
                },
                {
                    name: "windows-vm",
                    host: "windows-host",
                    creatable: true,
                    available: hyperVMissing.length === 0,
                    lazy: true,
                    status: hyperVMissing.length === 0 ? "available" : "missing-prerequisites",
                    missing: hyperVMissing,
                    provider: "hyper-v",
                    tools: { powershell },
                    readiness: hyperVReadiness,
                    capabilities: configuration.capabilities.windowsVm,
                },
                ...(hyperVLinuxImage ? [{
                    name: "linux-vm",
                    host: "windows-host",
                    creatable: true,
                    available: hyperVLinuxMissing.length === 0,
                    lazy: true,
                    status: hyperVLinuxMissing.length === 0 ? "available" : "missing-prerequisites",
                    missing: hyperVLinuxMissing,
                    provider: "hyper-v",
                    guestTransport: "ssh",
                    tools: { powershell, ssh, scp },
                    readiness: hyperVReadiness,
                    baseImage: hyperVLinuxImage.baseImage,
                    imageAcquisition: hyperVLinuxImage.imageAcquisition,
                    capabilities: configuration.capabilities.linuxVm,
                }] : []),
                {
                    name: "macos-vm",
                    host: "macos-host",
                    creatable: true,
                    available: macosMissing.length === 0,
                    lazy: true,
                    status: macosMissing.length === 0 ? "available" : "missing-prerequisites",
                    missing: macosMissing,
                    providers: macosProviders,
                    capabilities: configuration.capabilities.macosVm,
                },
            ],
        };
    };
}
