import type {
    HyperVConfigureVMGuestBootRequest,
    HyperVWindowsClient,
    HyperVWindowsExecutionRequest,
} from "@ccc/hyper-v/low-level/index.js";

const identity = {
    selector: { kind: "id", id: "11111111-2222-3333-4444-555555555555" },
    expectedName: "tenant-linux",
    expectedNotes: "tenant-owner",
    osDiskPath: "C:\\tenant\\root.vhdx",
    mediaPath: "C:\\tenant\\seed.iso",
    bootSettings: { generation: 2, secureBoot: { enabled: false } },
} as const;
const expectations = {
    expectedBootstrapAdapterName: "Tenant DHCP",
    expectedBootstrapSwitchName: "Tenant Uplink",
    expectedBootstrapMacAddress: "00:AA:BB:CC:DD:EE",
} as const;
const windowsIdentity = {
    ...identity,
    bootSettings: { generation: 2, secureBoot: { enabled: true, template: "MicrosoftWindows" } },
} as const;
const envelope = { schemaVersion: 1, operation: "Configure-VMGuestBoot" } as const;

export const publicLinux: HyperVConfigureVMGuestBootRequest = {
    ...identity, guestKind: "linux", ...expectations,
};
export const publicImplicitWindows: HyperVConfigureVMGuestBootRequest = windowsIdentity;
export const publicExplicitWindows: HyperVConfigureVMGuestBootRequest = {
    ...windowsIdentity, guestKind: "windows",
};
export const executionLinux: HyperVWindowsExecutionRequest = { ...envelope, ...publicLinux };
export const executionImplicitWindows: HyperVWindowsExecutionRequest = { ...envelope, ...publicImplicitWindows };
export const executionExplicitWindows: HyperVWindowsExecutionRequest = { ...envelope, ...publicExplicitWindows };

export function publicLinuxNames(request: HyperVConfigureVMGuestBootRequest): readonly string[] {
    if (request.guestKind !== "linux") return [];
    const selectorKind: "id" = request.selector.kind;
    void selectorKind;
    return [request.expectedBootstrapAdapterName, request.expectedBootstrapSwitchName, request.expectedBootstrapMacAddress];
}

export function executionLinuxNames(request: HyperVWindowsExecutionRequest): readonly string[] {
    if (request.operation !== "Configure-VMGuestBoot" || request.guestKind !== "linux") return [];
    const selectorKind: "id" = request.selector.kind;
    void selectorKind;
    return [request.expectedBootstrapAdapterName, request.expectedBootstrapSwitchName, request.expectedBootstrapMacAddress];
}

declare const client: HyperVWindowsClient;
function acceptExecution(_request: HyperVWindowsExecutionRequest): void {}

// These consumers compile with exactOptionalPropertyTypes. If a forbidden combination
// becomes writable, its @ts-expect-error becomes unused and fails the contract check.
if (false) {
    void client.configureVMGuestBoot(publicLinux);
    void client.configureVMGuestBoot(publicImplicitWindows);
    void client.configureVMGuestBoot(publicExplicitWindows);
    acceptExecution(executionLinux);
    acceptExecution(executionImplicitWindows);
    acceptExecution(executionExplicitWindows);

    // @ts-expect-error Linux requires its adapter name at the public client boundary
    void client.configureVMGuestBoot({ ...identity, guestKind: "linux", expectedBootstrapSwitchName: "Tenant Uplink", expectedBootstrapMacAddress: "00AABBCCDDEE" });
    // @ts-expect-error Linux requires its switch name at the public client boundary
    void client.configureVMGuestBoot({ ...identity, guestKind: "linux", expectedBootstrapAdapterName: "Tenant DHCP", expectedBootstrapMacAddress: "00AABBCCDDEE" });
    // @ts-expect-error Linux requires its MAC at the public client boundary
    void client.configureVMGuestBoot({ ...identity, guestKind: "linux", expectedBootstrapAdapterName: "Tenant DHCP", expectedBootstrapSwitchName: "Tenant Uplink" });

    // @ts-expect-error implicit Windows cannot carry an adapter expectation
    void client.configureVMGuestBoot({ ...windowsIdentity, expectedBootstrapAdapterName: "Tenant DHCP" });
    // @ts-expect-error implicit Windows cannot carry a switch expectation
    void client.configureVMGuestBoot({ ...windowsIdentity, expectedBootstrapSwitchName: "Tenant Uplink" });
    // @ts-expect-error implicit Windows cannot carry a MAC expectation
    void client.configureVMGuestBoot({ ...windowsIdentity, expectedBootstrapMacAddress: "00AABBCCDDEE" });
    // @ts-expect-error explicit Windows cannot carry an adapter expectation
    void client.configureVMGuestBoot({ ...windowsIdentity, guestKind: "windows", expectedBootstrapAdapterName: "Tenant DHCP" });
    // @ts-expect-error explicit Windows cannot carry a switch expectation
    void client.configureVMGuestBoot({ ...windowsIdentity, guestKind: "windows", expectedBootstrapSwitchName: "Tenant Uplink" });
    // @ts-expect-error explicit Windows cannot carry a MAC expectation
    void client.configureVMGuestBoot({ ...windowsIdentity, guestKind: "windows", expectedBootstrapMacAddress: "00AABBCCDDEE" });
    // @ts-expect-error an own undefined adapter expectation is still forbidden on Windows
    void client.configureVMGuestBoot({ ...windowsIdentity, expectedBootstrapAdapterName: undefined });
    // @ts-expect-error an own undefined switch expectation is still forbidden on Windows
    void client.configureVMGuestBoot({ ...windowsIdentity, guestKind: "windows", expectedBootstrapSwitchName: undefined });
    // @ts-expect-error an own undefined MAC expectation is still forbidden on Windows
    void client.configureVMGuestBoot({ ...windowsIdentity, expectedBootstrapMacAddress: undefined });

    // @ts-expect-error the execution union must preserve Linux's required adapter name
    acceptExecution({ ...envelope, ...identity, guestKind: "linux", expectedBootstrapSwitchName: "Tenant Uplink", expectedBootstrapMacAddress: "00AABBCCDDEE" });
    // @ts-expect-error the execution union must preserve Linux's required switch name
    acceptExecution({ ...envelope, ...identity, guestKind: "linux", expectedBootstrapAdapterName: "Tenant DHCP", expectedBootstrapMacAddress: "00AABBCCDDEE" });
    // @ts-expect-error the execution union must preserve Linux's required MAC
    acceptExecution({ ...envelope, ...identity, guestKind: "linux", expectedBootstrapAdapterName: "Tenant DHCP", expectedBootstrapSwitchName: "Tenant Uplink" });

    // @ts-expect-error implicit Windows cannot carry an adapter expectation on the wire
    acceptExecution({ ...envelope, ...windowsIdentity, expectedBootstrapAdapterName: "Tenant DHCP" });
    // @ts-expect-error implicit Windows cannot carry a switch expectation on the wire
    acceptExecution({ ...envelope, ...windowsIdentity, expectedBootstrapSwitchName: "Tenant Uplink" });
    // @ts-expect-error implicit Windows cannot carry a MAC expectation on the wire
    acceptExecution({ ...envelope, ...windowsIdentity, expectedBootstrapMacAddress: "00AABBCCDDEE" });
    // @ts-expect-error explicit Windows cannot carry an adapter expectation on the wire
    acceptExecution({ ...envelope, ...windowsIdentity, guestKind: "windows", expectedBootstrapAdapterName: "Tenant DHCP" });
    // @ts-expect-error explicit Windows cannot carry a switch expectation on the wire
    acceptExecution({ ...envelope, ...windowsIdentity, guestKind: "windows", expectedBootstrapSwitchName: "Tenant Uplink" });
    // @ts-expect-error explicit Windows cannot carry a MAC expectation on the wire
    acceptExecution({ ...envelope, ...windowsIdentity, guestKind: "windows", expectedBootstrapMacAddress: "00AABBCCDDEE" });
    // @ts-expect-error an own undefined adapter expectation is forbidden on Windows execution
    acceptExecution({ ...envelope, ...windowsIdentity, expectedBootstrapAdapterName: undefined });
    // @ts-expect-error an own undefined switch expectation is forbidden on Windows execution
    acceptExecution({ ...envelope, ...windowsIdentity, guestKind: "windows", expectedBootstrapSwitchName: undefined });
    // @ts-expect-error an own undefined MAC expectation is forbidden on Windows execution
    acceptExecution({ ...envelope, ...windowsIdentity, expectedBootstrapMacAddress: undefined });

    // @ts-expect-error public guest boot configuration selects an immutable VM id
    void client.configureVMGuestBoot({ ...publicLinux, selector: { kind: "name", name: "tenant-linux" } });
    // @ts-expect-error this execution arm must retain the public request's id-only selector
    acceptExecution({ ...executionLinux, selector: { kind: "name", name: "tenant-linux" } });
}
