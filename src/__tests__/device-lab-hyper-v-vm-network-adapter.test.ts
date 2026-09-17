import { describe, expect, it, vi } from "vitest";

import {
    deviceLabHyperVBootstrapMacAddress,
    discoverDeviceLabHyperVBootstrapNetwork,
    teardownDeviceLabHyperVBootstrapNetwork,
    type DeviceLabHyperVOwnedVm,
} from "../device-lab/broker/hyper-v/vm-network-adapter.js";
import {
    parseHyperVInterfaceIndex,
    parseHyperVMacAddress,
    parseHyperVVirtualMachineId,
    parseHyperVVirtualMachineName,
    parseIPv4Address,
    parseIPv4PrefixLength,
    type HyperVVMNetworkAdapter,
    type HyperVWindowsNetworkClient,
} from "../hyper-v-windows/low-level/index.js";

const VM_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const MANAGED_MAC = "02:15:5d:01:1a:2c";
const BOOTSTRAP_MAC = parseHyperVMacAddress("06:15:5d:01:1a:2c");
const OWNED_VM: DeviceLabHyperVOwnedVm = {
    vmId: VM_ID,
    vmName: "ccc-device-lab-abc",
    ownershipMarker: "ccc-device-lab:owner-1:device-1:incarnation-1",
};

function adapter(overrides: Partial<HyperVVMNetworkAdapter> = {}): HyperVVMNetworkAdapter {
    return {
        vmId: parseHyperVVirtualMachineId(VM_ID),
        vmName: OWNED_VM.vmName,
        name: "CCC Bootstrap DHCP",
        switchId: null,
        switchName: "Default Switch",
        status: "Ok",
        managementOperatingSystem: false,
        macAddress: BOOTSTRAP_MAC,
        ipAddresses: [],
        ...overrides,
    };
}

type ClientOverrides = Partial<HyperVWindowsNetworkClient>;

function client(overrides: ClientOverrides = {}): HyperVWindowsNetworkClient {
    const base = {
        getVMsByExactNames: async () => [{
            id: parseHyperVVirtualMachineId(VM_ID),
            name: parseHyperVVirtualMachineName(OWNED_VM.vmName),
            notes: OWNED_VM.ownershipMarker,
        }],
        getVMNetworkAdapters: async () => [adapter({ ipAddresses: ["172.20.0.9"] })],
        getManagementNetworkAdapters: async () => [adapter({
            managementOperatingSystem: true,
            ipAddresses: ["172.20.0.1"],
        })],
        getNetIPAddresses: async () => [{
            interfaceIndex: parseHyperVInterfaceIndex(12),
            address: parseIPv4Address("172.20.0.1"),
            prefixLength: parseIPv4PrefixLength(20),
            prefixOrigin: "Dhcp",
            suffixOrigin: "Dhcp",
            addressState: "Preferred",
            interfaceAlias: "vEthernet (Default Switch)",
        }],
        getNetNeighbors: async () => [],
        getAllVMNetworkAdapters: async () => [],
        removeVMNetworkAdapter: async () => undefined,
    };
    return { ...base, ...overrides } as unknown as HyperVWindowsNetworkClient;
}

describe("Device Lab bootstrap MAC derivation", () => {
    // The two adapters of one device differ only in this prefix, so the derivation is what
    // keeps teardown from targeting the managed adapter the device actually runs on.
    it("derives the bootstrap address from the managed one", () => {
        expect(deviceLabHyperVBootstrapMacAddress(MANAGED_MAC)).toBe(BOOTSTRAP_MAC);
    });

    it.each([
        ["a managed address outside the locally administered range", "0a:15:5d:01:1a:2c"],
        ["an already-derived bootstrap address", "06:15:5d:01:1a:2c"],
        ["a bare hex address", "02155d011a2c"],
        ["nonsense", "not-a-mac"],
        ["nothing", ""],
    ])("refuses to derive from %s", (_label, managed) => {
        expect(() => deviceLabHyperVBootstrapMacAddress(managed)).toThrow("hyper-v-mac-address-invalid");
    });
});

describe("Device Lab bootstrap discovery", () => {
    it("reports the guest's address in the legacy observation shape", async () => {
        // No diagnostic key at all when nothing went wrong, matching the legacy shape the
        // broker consumes: it tests for presence, not for a null.
        await expect(discoverDeviceLabHyperVBootstrapNetwork(client(), OWNED_VM)).resolves.toEqual({
            ok: true,
            addresses: ["172.20.0.9"],
        });
    });

    it("asks the neighbour table only about interfaces on the bootstrap network", async () => {
        const getNetNeighbors = vi.fn(async () => []);
        await discoverDeviceLabHyperVBootstrapNetwork(
            client({
                getNetIPAddresses: async () => [
                    {
                        interfaceIndex: parseHyperVInterfaceIndex(12),
                        address: parseIPv4Address("172.20.0.1"),
                        prefixLength: parseIPv4PrefixLength(20),
                        prefixOrigin: "Dhcp",
                        suffixOrigin: "Dhcp",
                        addressState: "Preferred",
                        interfaceAlias: "vEthernet (Default Switch)",
                    },
                    // A completely unrelated host interface. Reading its neighbours would be
                    // asking about a network this decision has no business seeing.
                    {
                        interfaceIndex: parseHyperVInterfaceIndex(99),
                        address: parseIPv4Address("10.0.0.5"),
                        prefixLength: parseIPv4PrefixLength(24),
                        prefixOrigin: "Dhcp",
                        suffixOrigin: "Dhcp",
                        addressState: "Preferred",
                        interfaceAlias: "Ethernet",
                    },
                ],
                getNetNeighbors,
            } as ClientOverrides),
            OWNED_VM,
        );

        expect(getNetNeighbors.mock.calls).toEqual([[{ interfaceIndex: 12 }]]);
    });
});

// The generated PowerShell opened with an ownership prelude, and everything behind it reads
// or removes adapters by identity. Losing that fence would let a VM whose id was reused by a
// later incarnation be treated as this device's.
describe("Device Lab bootstrap VM ownership", () => {
    it.each([
        ["no VM answers to the name", async () => []],
        ["two VMs answer to the name", async () => [
            { id: parseHyperVVirtualMachineId(VM_ID), name: parseHyperVVirtualMachineName(OWNED_VM.vmName), notes: OWNED_VM.ownershipMarker },
            { id: parseHyperVVirtualMachineId("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"), name: parseHyperVVirtualMachineName(OWNED_VM.vmName), notes: OWNED_VM.ownershipMarker },
        ]],
        ["the VM has a different id", async () => [
            { id: parseHyperVVirtualMachineId("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"), name: parseHyperVVirtualMachineName(OWNED_VM.vmName), notes: OWNED_VM.ownershipMarker },
        ]],
        ["the VM belongs to another incarnation", async () => [
            { id: parseHyperVVirtualMachineId(VM_ID), name: parseHyperVVirtualMachineName(OWNED_VM.vmName), notes: "ccc-device-lab:owner-1:device-1:incarnation-2" },
        ]],
        ["the VM is not a Device Lab VM at all", async () => [
            { id: parseHyperVVirtualMachineId(VM_ID), name: parseHyperVVirtualMachineName(OWNED_VM.vmName), notes: "" },
        ]],
    ])("refuses to discover when %s", async (_label, getVMsByExactNames) => {
        await expect(discoverDeviceLabHyperVBootstrapNetwork(
            client({ getVMsByExactNames } as ClientOverrides),
            OWNED_VM,
        )).rejects.toThrow("hyper-v-vm-ownership-mismatch");
    });

    it("removes nothing when the VM fails the ownership check", async () => {
        const removeVMNetworkAdapter = vi.fn(async () => undefined);
        await expect(teardownDeviceLabHyperVBootstrapNetwork(
            client({ getVMsByExactNames: async () => [], removeVMNetworkAdapter } as ClientOverrides),
            OWNED_VM,
            MANAGED_MAC,
        )).rejects.toThrow("hyper-v-vm-ownership-mismatch");
        expect(removeVMNetworkAdapter).not.toHaveBeenCalled();
    });
});

describe("Device Lab bootstrap teardown", () => {
    it("removes the adapter by its exact identity", async () => {
        const removeVMNetworkAdapter = vi.fn(async () => undefined);
        await expect(teardownDeviceLabHyperVBootstrapNetwork(
            client({ removeVMNetworkAdapter } as ClientOverrides),
            OWNED_VM,
            MANAGED_MAC,
        )).resolves.toEqual({ ok: true, removed: true, alreadyMissing: false });

        expect(removeVMNetworkAdapter.mock.calls).toEqual([[{
            selector: { kind: "id", id: VM_ID },
            adapterName: "CCC Bootstrap DHCP",
            macAddress: BOOTSTRAP_MAC,
        }]]);
    });

    it("succeeds without removing anything when the adapter is already gone", async () => {
        const removeVMNetworkAdapter = vi.fn(async () => undefined);
        await expect(teardownDeviceLabHyperVBootstrapNetwork(
            client({ getVMNetworkAdapters: async () => [], removeVMNetworkAdapter } as ClientOverrides),
            OWNED_VM,
            MANAGED_MAC,
        )).resolves.toEqual({ ok: true, removed: false, alreadyMissing: true });
        expect(removeVMNetworkAdapter).not.toHaveBeenCalled();
    });

    it("leaves the device's managed adapter alone", async () => {
        const removeVMNetworkAdapter = vi.fn(async () => undefined);
        await expect(teardownDeviceLabHyperVBootstrapNetwork(
            client({
                getVMNetworkAdapters: async () => [adapter({
                    name: "CCC Device Network",
                    switchName: "ccc-internal",
                    macAddress: parseHyperVMacAddress(MANAGED_MAC),
                })],
                removeVMNetworkAdapter,
            } as ClientOverrides),
            OWNED_VM,
            MANAGED_MAC,
        )).resolves.toEqual({ ok: true, removed: false, alreadyMissing: true });
        expect(removeVMNetworkAdapter).not.toHaveBeenCalled();
    });

    // The address must be free for the next device that derives the same one, so teardown is
    // not finished merely because this VM no longer holds it.
    it("fails when another VM on the host still carries the bootstrap address", async () => {
        await expect(teardownDeviceLabHyperVBootstrapNetwork(
            client({
                getAllVMNetworkAdapters: async () => [adapter({ vmName: "some-other-vm", name: "Network Adapter" })],
            } as ClientOverrides),
            OWNED_VM,
            MANAGED_MAC,
        )).rejects.toThrow("hyper-v-bootstrap-network-containment-failed");
    });

    it("refuses rather than guessing when the adapter sits on an unexpected switch", async () => {
        const removeVMNetworkAdapter = vi.fn(async () => undefined);
        await expect(teardownDeviceLabHyperVBootstrapNetwork(
            client({
                getVMNetworkAdapters: async () => [adapter({ switchName: "ccc-internal" })],
                removeVMNetworkAdapter,
            } as ClientOverrides),
            OWNED_VM,
            MANAGED_MAC,
        )).rejects.toThrow("hyper-v-bootstrap-network-adapter-identity-mismatch");
        expect(removeVMNetworkAdapter).not.toHaveBeenCalled();
    });
});
