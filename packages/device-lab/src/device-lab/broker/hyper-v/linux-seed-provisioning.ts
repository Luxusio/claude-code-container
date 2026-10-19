import { win32 } from "path";

import {
    createHyperVWindowsNetworkClient,
    HyperVWindowsError,
    parseHyperVMacAddress,
} from "@ccc/hyper-v/index.js";
import {
    createDeviceLabHyperVWindowsClient,
    createDeviceLabHyperVWindowsExecutor,
    type DeviceLabHyperVWindowsClientOptions,
} from "./lifecycle-adapter.js";

export type DeviceLabHyperVLinuxSeedTarget = DeviceLabHyperVWindowsClientOptions & {
    readonly vmId: string;
    readonly vmName: string;
    readonly expectedNotes: string;
    readonly generation: 1 | 2;
    readonly osDiskPath: string;
    readonly mediaPath: string;
    readonly managedMacAddress: string;
};

function fail(code: string): never {
    throw new Error(code);
}

export function linuxSeedBootstrapMacAddress(managedMacAddress: string): string {
    const managed = parseHyperVMacAddress(managedMacAddress);
    if (!managed.startsWith("02")) fail("hyper-v-mac-address-invalid");
    return `06${managed.slice(2)}`.toUpperCase();
}

export function linuxSeedFailureCode(cause: unknown, fallback: string): string {
    if (cause instanceof HyperVWindowsError
        && /^hyper-v-[a-z0-9-]{3,128}$/.test(cause.code)) return cause.code;
    if (cause instanceof Error
        && /^hyper-v-[a-z0-9-]{3,128}$/.test(cause.message)) return cause.message;
    return fallback;
}

export async function inspectDeviceLabHyperVLinuxSeedTarget(
    options: DeviceLabHyperVLinuxSeedTarget,
): Promise<void> {
    const expectedMac = linuxSeedBootstrapMacAddress(options.managedMacAddress).toLowerCase();
    const selector = { kind: "id" as const, id: options.vmId };
    const client = createDeviceLabHyperVWindowsClient(options);
    const network = createHyperVWindowsNetworkClient(createDeviceLabHyperVWindowsExecutor(options));
    const machines = await client.getVM(selector);
    if (machines.length !== 1 || machines[0].id !== options.vmId.toLowerCase()
        || machines[0].name !== options.vmName || machines[0].notes !== options.expectedNotes) {
        fail("hyper-v-vm-ownership-mismatch");
    }
    if (machines[0].state !== "Off" || machines[0].generation !== options.generation) {
        fail("hyper-v-linux-seed-requires-stopped-vm");
    }
    const adapters = await network.getVMNetworkAdapters({ selector });
    const bootstrap = adapters.filter((adapter) => adapter.name === "CCC Bootstrap DHCP");
    if (bootstrap.length !== 1 || bootstrap[0].switchName !== "Default Switch") {
        fail("hyper-v-linux-bootstrap-adapter-invalid");
    }
    if (bootstrap[0].vmId !== options.vmId.toLowerCase()
        || bootstrap[0].vmName !== options.vmName
        || bootstrap[0].macAddress !== expectedMac) {
        fail("hyper-v-linux-bootstrap-mac-identity-mismatch");
    }
    const allAdapters = await network.getAllVMNetworkAdapters();
    const matches = allAdapters.filter((adapter) => adapter.macAddress === expectedMac);
    if (matches.length !== 1 || matches[0].vmId !== options.vmId.toLowerCase()
        || matches[0].vmName !== options.vmName
        || matches[0].name !== "CCC Bootstrap DHCP"
        || matches[0].switchName !== "Default Switch") {
        fail("hyper-v-linux-bootstrap-mac-identity-mismatch");
    }
    const media = await client.getVMDvdDrives(selector);
    if (media.some((drive) => drive.path !== null
        && win32.normalize(drive.path).toLowerCase() === win32.normalize(options.mediaPath).toLowerCase())) {
        fail("hyper-v-linux-seed-media-already-attached");
    }
}

export async function attachDeviceLabHyperVLinuxSeedMedia(
    options: DeviceLabHyperVLinuxSeedTarget,
): Promise<void> {
    const client = createDeviceLabHyperVWindowsClient(options);
    await client.configureVMGuestBoot({
        selector: { kind: "id", id: options.vmId },
        expectedName: options.vmName,
        expectedNotes: options.expectedNotes,
        osDiskPath: options.osDiskPath,
        mediaPath: options.mediaPath,
        guestKind: "linux",
        expectedBootstrapAdapterName: "CCC Bootstrap DHCP",
        expectedBootstrapSwitchName: "Default Switch",
        expectedBootstrapMacAddress: linuxSeedBootstrapMacAddress(options.managedMacAddress),
        bootSettings: options.generation === 2
            ? { generation: 2, secureBoot: { enabled: false } }
            : { generation: 1, startupOrder: ["IDE", "CD", "LegacyNetworkAdapter", "Floppy"] },
    });
}
