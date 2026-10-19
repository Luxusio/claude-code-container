import { afterEach, describe, expect, it, vi } from "vitest";

import {
    executeDeviceLabHyperVVmCreation,
    type DeviceLabHyperVVmCreationOptions,
} from "@ccc/device-lab/device-lab/broker/hyper-v/vm-create-adapter.js";
import type { HyperVCreateEffect, HyperVCreateVirtualMachineRequest } from "@ccc/hyper-v/lifecycle/index.js";
import {
    parseHyperVMacAddress,
    parseHyperVVirtualMachineId,
    parseHyperVVirtualSwitchId,
    parseHyperVVirtualSwitchName,
    type HyperVVMNetworkAdapter,
} from "@ccc/hyper-v/low-level/index.js";

const VM_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER_VM_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const DISK_PATH = "C:\\ccc\\device-1\\disks\\root.vhdx";
const MANAGED_MAC = "02:15:5D:01:1A:2C";
const BOOTSTRAP_MAC = "0A-2B-3C-4D-5E-6F";
const BOOTSTRAP_NETWORK = {
    kind: "managed-and-bootstrap",
    switchName: "CCC Switch",
    adapterName: "CCC Device Network",
    macAddress: MANAGED_MAC,
    bootstrapSwitchName: "Default Switch",
    bootstrapAdapterName: "CCC Bootstrap DHCP",
    bootstrapMacAddress: BOOTSTRAP_MAC,
} as const;

afterEach(() => { vi.restoreAllMocks(); });

function request(overrides: Partial<HyperVCreateVirtualMachineRequest> = {}): HyperVCreateVirtualMachineRequest {
    return {
        vmName: "ccc-device-1",
        firmware: { generation: 2, secureBoot: { enabled: true, template: "MicrosoftWindows" } },
        memoryStartupBytes: 4 * 1024 * 1024 * 1024,
        processorCount: 2,
        notes: "ccc-device-lab:owner:device:incarnation",
        checkpointType: "ProductionOnly",
        deviceRoot: "C:\\ccc\\device-1",
        diskPath: DISK_PATH,
        baseImagePath: "C:\\ccc\\images\\base.vhdx",
        baseImageSha256: "a".repeat(64),
        network: { kind: "none" },
        ...overrides,
    };
}

function adapter(name: string, switchName: string, macAddress: string): HyperVVMNetworkAdapter {
    return {
        vmId: parseHyperVVirtualMachineId(VM_ID),
        vmName: "ccc-device-1",
        name,
        switchId: parseHyperVVirtualSwitchId(switchName === "Default Switch"
            ? "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
            : "cccccccc-cccc-cccc-cccc-cccccccccccc"),
        switchName,
        status: "Ok",
        managementOperatingSystem: false,
        macAddress: parseHyperVMacAddress(macAddress),
        ipAddresses: [],
    };
}

function fixture(createRequest: HyperVCreateVirtualMachineRequest) {
    const network = createRequest.network;
    const operations: string[] = [];
    const effects: HyperVCreateEffect[] = [{ kind: "file-created", path: DISK_PATH }];
    let created = false;
    let hostAdapterReads = 0;
    const virtualMachine = {
        id: VM_ID,
        name: createRequest.vmName,
        state: "Off",
        status: "Operating normally",
        notes: createRequest.notes,
        uptimeMilliseconds: 0,
        generation: createRequest.firmware.generation,
        checkpointType: createRequest.checkpointType,
    };
    const client: DeviceLabHyperVVmCreationOptions["client"] = {
        getVM: vi.fn(async () => { operations.push("Get-VM"); return created ? [virtualMachine] : []; }),
        getVMHardDiskDrives: vi.fn(async () => {
            operations.push("Get-VMHardDiskDrive");
            return [{ vmId: VM_ID, vmName: createRequest.vmName, path: DISK_PATH, controllerType: "SCSI", controllerNumber: 0, controllerLocation: 0, diskNumber: null }];
        }),
        newVM: vi.fn(async () => { operations.push("New-VM"); created = true; return { ...virtualMachine, notes: "" }; }),
        setVM: vi.fn(async () => { operations.push("Set-VM"); }),
        setVMMemory: vi.fn(async () => { operations.push("Set-VMMemory"); }),
        setVMProcessor: vi.fn(async () => { operations.push("Set-VMProcessor"); }),
        getVMFirmware: vi.fn(async () => { operations.push("Get-VMFirmware"); return { vmId: VM_ID, secureBoot: "On", secureBootTemplate: "MicrosoftWindows", firstBootDevicePath: DISK_PATH }; }),
        getVMBios: vi.fn(async () => { operations.push("Get-VMBios"); return { vmId: VM_ID, startupOrder: createRequest.firmware.generation === 1 ? createRequest.firmware.startupOrder : ["IDE"] as const }; }),
        setVMFirmware: vi.fn(async () => { operations.push("Set-VMFirmware"); }),
        setVMBios: vi.fn(async () => { operations.push("Set-VMBios"); }),
        addVMNetworkAdapter: vi.fn(async () => { operations.push("Add-VMNetworkAdapter"); }),
        renameVMNetworkAdapter: vi.fn(async () => { operations.push("Rename-VMNetworkAdapter"); }),
        setVMNetworkAdapter: vi.fn(async () => { operations.push("Set-VMNetworkAdapter"); }),
    };
    const networkClient: DeviceLabHyperVVmCreationOptions["networkClient"] = {
        getVMSwitches: vi.fn(async (selector) => {
            operations.push("Get-VMSwitch");
            if (selector.kind !== "name") return [];
            return [{ id: parseHyperVVirtualSwitchId(selector.name === "Default Switch"
                ? "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
                : "cccccccc-cccc-cccc-cccc-cccccccccccc"), name: parseHyperVVirtualSwitchName(selector.name), switchType: "Internal", notes: "" }];
        }),
        getAllVMNetworkAdapters: vi.fn(async () => {
            operations.push("Get-VMNetworkAdapter-All");
            hostAdapterReads += 1;
            return hostAdapterReads === 1 || network.kind !== "managed-and-bootstrap"
                ? []
                : [adapter(network.bootstrapAdapterName, network.bootstrapSwitchName, network.bootstrapMacAddress)];
        }),
        getVMNetworkAdapters: vi.fn(async () => {
            operations.push("Get-VMNetworkAdapter-VM");
            return network.kind === "managed-and-bootstrap"
                ? [adapter(network.bootstrapAdapterName, network.bootstrapSwitchName, network.bootstrapMacAddress), adapter(network.adapterName, network.switchName, network.macAddress)]
                : network.kind === "managed"
                    ? [adapter(network.adapterName, network.switchName, network.macAddress ?? MANAGED_MAC)]
                    : [];
        }),
    };
    return { client, networkClient, effects, operations };
}

describe("typed Hyper-V creation mutation phase", () => {
    it("executes Windows generation 2 steps in order and returns the exact VM identity", async () => {
        const createRequest = request();
        const host = fixture(createRequest);

        const result = await executeDeviceLabHyperVVmCreation({ request: createRequest, ...host, deadlineAt: Date.now() + 30_000 });

        expect(result).toEqual({ vmId: VM_ID, vmName: createRequest.vmName, state: "Off", generation: 2, diskPath: DISK_PATH, switchName: null });
        expect(host.effects).toEqual([{ kind: "file-created", path: DISK_PATH }, { kind: "vm-created", vmId: VM_ID }]);
        expect(host.operations).toEqual([
            "Get-VM", "New-VM", "Set-VMProcessor", "Set-VMMemory", "Set-VM", "Set-VMFirmware",
            "Get-VM", "Get-VMHardDiskDrive", "Get-VMFirmware",
        ]);
        expect(host.client.newVM).toHaveBeenCalledWith(expect.objectContaining({ name: createRequest.vmName, generation: 2, vhdPath: DISK_PATH }));
        expect(host.client.setVM).toHaveBeenCalledWith(expect.objectContaining({ notes: createRequest.notes, checkpointType: "ProductionOnly", automaticCheckpointsEnabled: false }));
    });

    it("uses the supplied non-06 bootstrap MAC through assignment and readback while preserving order and checkpoints", async () => {
        const createRequest = request({
            firmware: { generation: 2, secureBoot: { enabled: false } },
            checkpointType: "Production",
            network: BOOTSTRAP_NETWORK,
        });
        const host = fixture(createRequest);

        const result = await executeDeviceLabHyperVVmCreation({ request: createRequest, ...host, deadlineAt: Date.now() + 30_000 });

        expect(result.switchName).toBe("CCC Switch");
        expect(host.operations).toEqual([
            "Get-VM", "Get-VMSwitch", "Get-VMSwitch", "Get-VMNetworkAdapter-All", "New-VM",
            "Rename-VMNetworkAdapter", "Set-VMNetworkAdapter", "Add-VMNetworkAdapter", "Set-VMNetworkAdapter",
            "Set-VMProcessor", "Set-VMMemory", "Set-VM", "Set-VMFirmware", "Get-VM",
            "Get-VMHardDiskDrive", "Get-VMFirmware", "Get-VMNetworkAdapter-VM", "Get-VMNetworkAdapter-All",
        ]);
        expect(host.client.newVM).toHaveBeenCalledWith(expect.objectContaining({ switchName: "Default Switch" }));
        expect(host.client.setVMNetworkAdapter).toHaveBeenNthCalledWith(1, {
            selector: { kind: "id", id: VM_ID },
            adapter: { kind: "name", name: "CCC Bootstrap DHCP" },
            staticMacAddress: BOOTSTRAP_MAC,
        });
        expect(host.client.setVMNetworkAdapter).toHaveBeenNthCalledWith(2, {
            selector: { kind: "id", id: VM_ID },
            adapter: { kind: "name", name: "CCC Device Network" },
            staticMacAddress: MANAGED_MAC,
        });
        expect(host.client.setVM).toHaveBeenCalledWith(expect.objectContaining({ checkpointType: "Production" }));
        expect(host.client.setVMFirmware).toHaveBeenCalledWith(expect.objectContaining({ secureBoot: { enabled: false } }));
    });

    it("records VM creation before a later configuration error can reach the caller", async () => {
        const createRequest = request();
        const host = fixture(createRequest);
        host.client.setVMProcessor = vi.fn(async () => { throw new Error("hyper-v-injected-config-failure"); });

        await expect(executeDeviceLabHyperVVmCreation({ request: createRequest, ...host, deadlineAt: Date.now() + 30_000 }))
            .rejects.toThrow("hyper-v-injected-config-failure");
        expect(host.effects.at(-1)).toEqual({ kind: "vm-created", vmId: VM_ID });
    });

    it("refuses the supplied non-06 bootstrap MAC already assigned before New-VM", async () => {
        const createRequest = request({ network: BOOTSTRAP_NETWORK });
        const host = fixture(createRequest);
        host.networkClient.getAllVMNetworkAdapters = vi.fn(async () => [adapter("other", "Default Switch", BOOTSTRAP_MAC)]);

        await expect(executeDeviceLabHyperVVmCreation({ request: createRequest, ...host, deadlineAt: Date.now() + 30_000 }))
            .rejects.toThrow("hyper-v-bootstrap-mac-address-conflict");
        expect(host.client.newVM).not.toHaveBeenCalled();
        expect(host.effects).toEqual([{ kind: "file-created", path: DISK_PATH }]);
        expect(host.client.setVMNetworkAdapter).not.toHaveBeenCalled();
    });

    it("refuses a managed switch that disappeared before New-VM", async () => {
        const createRequest = request({ network: { kind: "managed", switchName: "CCC Switch", adapterName: "CCC Device Network", macAddress: MANAGED_MAC } });
        const host = fixture(createRequest);
        host.networkClient.getVMSwitches = vi.fn(async () => []);

        await expect(executeDeviceLabHyperVVmCreation({ request: createRequest, ...host, deadlineAt: Date.now() + 30_000 }))
            .rejects.toThrow("hyper-v-network-switch-not-found");
        expect(host.client.newVM).not.toHaveBeenCalled();
    });

    it("refuses a bootstrap MAC claimed by another VM after assignment", async () => {
        const createRequest = request({ network: BOOTSTRAP_NETWORK });
        const host = fixture(createRequest);
        let reads = 0;
        host.networkClient.getAllVMNetworkAdapters = vi.fn(async () => {
            reads += 1;
            return reads === 1 ? [] : [{
                ...adapter("CCC Bootstrap DHCP", "Default Switch", BOOTSTRAP_MAC),
                vmId: parseHyperVVirtualMachineId(OTHER_VM_ID),
                vmName: "other-vm",
            }];
        });

        await expect(executeDeviceLabHyperVVmCreation({ request: createRequest, ...host, deadlineAt: Date.now() + 30_000 }))
            .rejects.toThrow("hyper-v-bootstrap-mac-address-conflict");
        expect(host.effects).toEqual([{ kind: "file-created", path: DISK_PATH }, { kind: "vm-created", vmId: VM_ID }]);
        expect(host.client.newVM).toHaveBeenCalledTimes(1);
    });

    it.each([
        ["same spelling", MANAGED_MAC],
        ["canonical alternate spelling", "02155d011a2c"],
    ])("rejects equal managed/bootstrap MACs with %s before native reads or mutations", async (_label, bootstrapMacAddress) => {
        const createRequest = request({ network: { ...BOOTSTRAP_NETWORK, bootstrapMacAddress } });
        const host = fixture(createRequest);

        await expect(executeDeviceLabHyperVVmCreation({ request: createRequest, ...host, deadlineAt: Date.now() + 30_000 }))
            .rejects.toThrow("hyper-v-create-bootstrap-mac-address-conflict");

        expect(host.operations).toEqual([]);
        expect(host.effects).toEqual([{ kind: "file-created", path: DISK_PATH }]);
    });

    it.each([
        ["missing", undefined, "hyper-v-create-bootstrap-mac-address-invalid"],
        ["zero", "000000000000", "hyper-v-mac-address-unassigned"],
    ])("rejects a %s bootstrap MAC before native reads or mutations", async (_label, bootstrapMacAddress, code) => {
        const createRequest = request({
            network: { ...BOOTSTRAP_NETWORK, bootstrapMacAddress } as unknown as HyperVCreateVirtualMachineRequest["network"],
        });
        const host = fixture(createRequest);

        await expect(executeDeviceLabHyperVVmCreation({ request: createRequest, ...host, deadlineAt: Date.now() + 30_000 }))
            .rejects.toThrow(code);

        expect(host.operations).toEqual([]);
        expect(host.effects).toEqual([{ kind: "file-created", path: DISK_PATH }]);
    });

    it("refuses readback of the former derived address when a different bootstrap MAC was supplied", async () => {
        const createRequest = request({ network: BOOTSTRAP_NETWORK });
        const host = fixture(createRequest);
        host.networkClient.getVMNetworkAdapters = vi.fn(async () => [
            adapter("CCC Bootstrap DHCP", "Default Switch", "06:15:5D:01:1A:2C"),
            adapter("CCC Device Network", "CCC Switch", MANAGED_MAC),
        ]);

        await expect(executeDeviceLabHyperVVmCreation({ request: createRequest, ...host, deadlineAt: Date.now() + 30_000 }))
            .rejects.toThrow("hyper-v-bootstrap-network-adapter-unavailable");

        expect(host.effects).toEqual([{ kind: "file-created", path: DISK_PATH }, { kind: "vm-created", vmId: VM_ID }]);
        expect(host.client.newVM).toHaveBeenCalledTimes(1);
    });

    it.each(["duplicate", "foreign VM"])("rejects %s bootstrap adapter readback and retains the created VM for compensation", async (observation) => {
        const createRequest = request({ network: BOOTSTRAP_NETWORK });
        const host = fixture(createRequest);
        const bootstrap = adapter("CCC Bootstrap DHCP", "Default Switch", BOOTSTRAP_MAC);
        host.networkClient.getVMNetworkAdapters = vi.fn(async () => [
            ...(observation === "duplicate" ? [bootstrap, bootstrap] : [{ ...bootstrap, vmId: parseHyperVVirtualMachineId(OTHER_VM_ID) }]),
            adapter("CCC Device Network", "CCC Switch", MANAGED_MAC),
        ]);

        await expect(executeDeviceLabHyperVVmCreation({ request: createRequest, ...host, deadlineAt: Date.now() + 30_000 }))
            .rejects.toThrow("hyper-v-bootstrap-network-adapter-unavailable");

        expect(host.effects).toEqual([{ kind: "file-created", path: DISK_PATH }, { kind: "vm-created", vmId: VM_ID }]);
        expect(host.client.newVM).toHaveBeenCalledTimes(1);
    });

    it("rejects duplicate host assignments of the supplied bootstrap MAC after assignment", async () => {
        const createRequest = request({ network: BOOTSTRAP_NETWORK });
        const host = fixture(createRequest);
        let reads = 0;
        host.networkClient.getAllVMNetworkAdapters = vi.fn(async () => {
            reads += 1;
            return reads === 1 ? [] : [
                adapter("CCC Bootstrap DHCP", "Default Switch", BOOTSTRAP_MAC),
                { ...adapter("other", "Default Switch", BOOTSTRAP_MAC), vmId: parseHyperVVirtualMachineId(OTHER_VM_ID) },
            ];
        });

        await expect(executeDeviceLabHyperVVmCreation({ request: createRequest, ...host, deadlineAt: Date.now() + 30_000 }))
            .rejects.toThrow("hyper-v-bootstrap-mac-address-conflict");

        expect(host.effects).toEqual([{ kind: "file-created", path: DISK_PATH }, { kind: "vm-created", vmId: VM_ID }]);
        expect(host.client.newVM).toHaveBeenCalledTimes(1);
    });

    it("leaves VM identity unresolved when New-VM loses its response", async () => {
        const createRequest = request();
        const host = fixture(createRequest);
        host.client.newVM = vi.fn(async () => { throw new Error("hyper-v-windows-session-exited"); });

        await expect(executeDeviceLabHyperVVmCreation({ request: createRequest, ...host, deadlineAt: Date.now() + 30_000 }))
            .rejects.toThrow("hyper-v-windows-session-exited");
        expect(host.effects).toEqual([{ kind: "file-created", path: DISK_PATH }]);
        expect(host.client.newVM).toHaveBeenCalledTimes(1);
    });

    it("checks generation 1 disk attachment even though BIOS has no disk selector", async () => {
        const createRequest = request({ firmware: { generation: 1, startupOrder: ["IDE", "CD", "LegacyNetworkAdapter", "Floppy"] } });
        const host = fixture(createRequest);
        host.client.getVMHardDiskDrives = vi.fn(async () => []);

        await expect(executeDeviceLabHyperVVmCreation({ request: createRequest, ...host, deadlineAt: Date.now() + 30_000 }))
            .rejects.toThrow("hyper-v-created-disk-attachment-mismatch");
        expect(host.client.setVMBios).toHaveBeenCalled();
        expect(host.client.getVMFirmware).not.toHaveBeenCalled();
    });

    it("rejects a generation 1 BIOS order that differs from the requested order", async () => {
        const createRequest = request({ firmware: { generation: 1, startupOrder: ["IDE", "CD", "LegacyNetworkAdapter", "Floppy"] } });
        const host = fixture(createRequest);
        host.client.getVMBios = vi.fn(async () => ({ vmId: VM_ID, startupOrder: ["CD", "IDE", "LegacyNetworkAdapter", "Floppy"] }));

        await expect(executeDeviceLabHyperVVmCreation({ request: createRequest, ...host, deadlineAt: Date.now() + 30_000 }))
            .rejects.toThrow("hyper-v-created-disk-boot-order-mismatch");
        expect(host.client.getVMBios).toHaveBeenCalledWith({ kind: "id", id: VM_ID });
    });

    it("rejects a wrong generation 2 first boot disk", async () => {
        const createRequest = request();
        const host = fixture(createRequest);
        host.client.getVMFirmware = vi.fn(async () => ({ vmId: VM_ID, secureBoot: "On", secureBootTemplate: "MicrosoftWindows", firstBootDevicePath: "C:\\other.vhdx" }));

        await expect(executeDeviceLabHyperVVmCreation({ request: createRequest, ...host, deadlineAt: Date.now() + 30_000 }))
            .rejects.toThrow("hyper-v-created-disk-boot-order-mismatch");
        expect(host.effects.at(-1)).toEqual({ kind: "vm-created", vmId: VM_ID });
    });

    it("expires before any native operation when the broker deadline has passed", async () => {
        const createRequest = request();
        const host = fixture(createRequest);

        await expect(executeDeviceLabHyperVVmCreation({ request: createRequest, ...host, deadlineAt: Date.now() - 1 }))
            .rejects.toThrow("hyper-v-operation-deadline-exceeded");
        expect(host.operations).toEqual([]);
    });

    it("stops further mutations after local expiry and retains a VM created across a backward wall jump", async () => {
        const createRequest = request();
        const host = fixture(createRequest);
        let wallNow = 1000;
        let monotonicNow = 1000;
        vi.spyOn(Date, "now").mockImplementation(() => wallNow);
        const newVM = host.client.newVM;
        host.client.newVM = vi.fn(async (...args: Parameters<typeof newVM>) => {
            const result = await newVM(...args);
            wallNow = 500;
            monotonicNow = 1002;
            return result;
        });

        await expect(executeDeviceLabHyperVVmCreation({
            request: createRequest, ...host, deadlineAt: 1001, now: () => monotonicNow,
        })).rejects.toThrow("hyper-v-operation-deadline-exceeded");

        expect(host.operations).toEqual(["Get-VM", "New-VM"]);
        expect(host.effects).toEqual([{ kind: "file-created", path: DISK_PATH }, { kind: "vm-created", vmId: VM_ID }]);
        expect(host.client.setVMProcessor).not.toHaveBeenCalled();
    });

    it("finishes creation within its local budget when the wall clock moves forward", async () => {
        const createRequest = request();
        const host = fixture(createRequest);
        let wallNow = 1000;
        let monotonicNow = 1000;
        vi.spyOn(Date, "now").mockImplementation(() => wallNow);
        const getVM = host.client.getVM;
        host.client.getVM = vi.fn(async (...args: Parameters<typeof getVM>) => {
            const result = await getVM(...args);
            wallNow = 10_000;
            monotonicNow += 1;
            return result;
        });

        await expect(executeDeviceLabHyperVVmCreation({
            request: createRequest, ...host, deadlineAt: 2000, now: () => monotonicNow,
        })).resolves.toEqual(expect.objectContaining({ vmId: VM_ID, diskPath: DISK_PATH }));

        expect(host.operations).toEqual([
            "Get-VM", "New-VM", "Set-VMProcessor", "Set-VMMemory", "Set-VM", "Set-VMFirmware",
            "Get-VM", "Get-VMHardDiskDrive", "Get-VMFirmware",
        ]);
        expect(host.effects.at(-1)).toEqual({ kind: "vm-created", vmId: VM_ID });
    });
});
