import { readFileSync } from "fs";
import { join } from "path";

import { describe, expect, it, vi } from "vitest";

import {
    deviceLabHyperVBootstrapMacAddress,
    discoverDeviceLabHyperVBootstrapNetwork,
    teardownDeviceLabHyperVBootstrapNetwork,
    type DeviceLabHyperVOwnedVm,
} from "@ccc/device-lab/device-lab/broker/hyper-v/vm-network-adapter.js";
import {
    parseHyperVInterfaceIndex,
    parseHyperVMacAddress,
    parseHyperVVirtualMachineId,
    parseHyperVVirtualMachineName,
    parseIPv4Address,
    parseIPv4PrefixLength,
    type HyperVVMNetworkAdapter,
} from "@ccc/hyper-v/low-level/index.js";

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

type AdapterClient = Parameters<typeof discoverDeviceLabHyperVBootstrapNetwork>[0];
type ClientOverrides = Partial<AdapterClient>;

function client(overrides: ClientOverrides = {}): AdapterClient {
    const base: AdapterClient = {
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
    return { ...base, ...overrides };
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
    it("keeps an empty neighbor table retryable while the guest has no address", async () => {
        await expect(discoverDeviceLabHyperVBootstrapNetwork(
            client({ getVMNetworkAdapters: async () => [adapter()] } as ClientOverrides),
            OWNED_VM,
        )).resolves.toEqual({ ok: true, addresses: [] });
    });

    it("reports a failed neighbor read with the existing public diagnostic", async () => {
        await expect(discoverDeviceLabHyperVBootstrapNetwork(
            client({
                getNetNeighbors: async () => {
                    throw new Error("native transport failed");
                },
            } as ClientOverrides),
            OWNED_VM,
        )).rejects.toThrow("hyper-v-bootstrap-neighbor-inspection-failed");
    });

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

    it("applies the supported prefix floor before reading neighbours", async () => {
        const getNetNeighbors = vi.fn(async () => []);
        await discoverDeviceLabHyperVBootstrapNetwork(
            client({
                getNetIPAddresses: async () => [{
                    interfaceIndex: parseHyperVInterfaceIndex(12),
                    address: parseIPv4Address("10.0.0.1"),
                    prefixLength: parseIPv4PrefixLength(8),
                    prefixOrigin: "Dhcp",
                    suffixOrigin: "Dhcp",
                    addressState: "Preferred",
                    interfaceAlias: "vEthernet (Default Switch)",
                }],
                getNetNeighbors,
            }),
            OWNED_VM,
        );
        expect(getNetNeighbors).not.toHaveBeenCalled();
    });

    it("fails closed before reading an unbounded set of host interfaces", async () => {
        const getNetNeighbors = vi.fn(async () => []);
        await expect(discoverDeviceLabHyperVBootstrapNetwork(
            client({
                getNetIPAddresses: async () => Array.from({ length: 17 }, (_, index) => ({
                    interfaceIndex: parseHyperVInterfaceIndex(index + 1),
                    address: parseIPv4Address(`172.20.${index}.1`),
                    prefixLength: parseIPv4PrefixLength(24),
                    prefixOrigin: "Dhcp",
                    suffixOrigin: "Dhcp",
                    addressState: "Preferred",
                    interfaceAlias: "vEthernet (Default Switch)",
                })),
                getNetNeighbors,
            }),
            OWNED_VM,
        )).rejects.toThrow("hyper-v-bootstrap-neighbor-inspection-failed");
        expect(getNetNeighbors).not.toHaveBeenCalled();
    });
});

// The generated PowerShell opened with an ownership prelude, and everything behind it reads
// or removes adapters by identity. Losing that fence would let a VM whose id was reused by a
// later incarnation be treated as this device's.
describe("Device Lab bootstrap VM ownership", () => {
    it.each([
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

    it("distinguishes a missing VM from an ownership mismatch", async () => {
        await expect(discoverDeviceLabHyperVBootstrapNetwork(
            client({ getVMsByExactNames: async () => [] }),
            OWNED_VM,
        )).rejects.toThrow("hyper-v-vm-not-found");
    });

    it("removes nothing when the VM fails the ownership check", async () => {
        const removeVMNetworkAdapter = vi.fn(async () => undefined);
        await expect(teardownDeviceLabHyperVBootstrapNetwork(
            client({ getVMsByExactNames: async () => [], removeVMNetworkAdapter } as ClientOverrides),
            OWNED_VM,
            MANAGED_MAC,
        )).rejects.toThrow("hyper-v-vm-not-found");
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
            expectedNotes: OWNED_VM.ownershipMarker,
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

    // Teardown decides from the VM's own adapters alone. It used to gather the host's
    // management adapters, addresses and neighbour tables too -- data no branch of the
    // decision reads -- and it runs on the success path of a device start, where anything it
    // throws turns a guest that booted and finalized into a reported failure. So a host read
    // that is broken, slow, or simply unavailable must not be able to fail a teardown.
    it("does not read host state it cannot decide from", async () => {
        const getManagementNetworkAdapters = vi.fn(async () => {
            throw new Error("host-read-must-not-be-reached");
        });
        const getNetIPAddresses = vi.fn(async () => {
            throw new Error("host-read-must-not-be-reached");
        });
        const getNetNeighbors = vi.fn(async () => {
            throw new Error("host-read-must-not-be-reached");
        });
        const removeVMNetworkAdapter = vi.fn(async () => undefined);
        await expect(teardownDeviceLabHyperVBootstrapNetwork(
            client({
                getManagementNetworkAdapters,
                getNetIPAddresses,
                getNetNeighbors,
                removeVMNetworkAdapter,
            } as ClientOverrides),
            OWNED_VM,
            MANAGED_MAC,
        )).resolves.toEqual({ ok: true, removed: true, alreadyMissing: false });

        expect(removeVMNetworkAdapter).toHaveBeenCalledTimes(1);
        expect(getManagementNetworkAdapters).not.toHaveBeenCalled();
        expect(getNetIPAddresses).not.toHaveBeenCalled();
        expect(getNetNeighbors).not.toHaveBeenCalled();
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

    it.each([parseHyperVMacAddress("06:15:5d:01:1a:2d"), null])(
        "refuses a named bootstrap adapter with a wrong or missing MAC (%s)", async (macAddress) => {
            const removeVMNetworkAdapter = vi.fn(async () => undefined);
            const getAllVMNetworkAdapters = vi.fn(async () => []);
            await expect(teardownDeviceLabHyperVBootstrapNetwork(
                client({
                    getVMNetworkAdapters: async () => [adapter({ macAddress })],
                    getAllVMNetworkAdapters,
                    removeVMNetworkAdapter,
                } as ClientOverrides),
                OWNED_VM,
                MANAGED_MAC,
            )).rejects.toThrow("hyper-v-bootstrap-network-adapter-identity-mismatch");
            expect(removeVMNetworkAdapter).not.toHaveBeenCalled();
            expect(getAllVMNetworkAdapters).not.toHaveBeenCalled();
        },
    );
});

// Slice 2B must never grow a UAC prompt: the VM already exists and its adapters belong to it,
// so every operation here runs at ordinary privilege. This is asserted against the source
// rather than a value, because the invariant is about what the code may reach -- elevation
// enters this codebase only through these two names, and neither may appear on this path.
describe("Device Lab bootstrap privilege", () => {
    const root = join(__dirname, "..", "..", "packages", "device-lab", "src");

    it.each([
        ["the bootstrap adapter", join("device-lab", "broker", "hyper-v", "vm-network-adapter.ts")],
        ["the bootstrap reconciliation", join("..", "..", "hyper-v", "src", "lifecycle", "vm-network-reconcile.ts")],
    ])("never reaches elevation from %s", (_label, relativePath) => {
        const source = readFileSync(join(root, relativePath), "utf8");
        expect(source).not.toContain("withAdministratorClient");
        expect(source).not.toContain("withElevatedHyperVNetworkExecutor");
        expect(source).not.toContain("elevated-network-session");
    });


});
