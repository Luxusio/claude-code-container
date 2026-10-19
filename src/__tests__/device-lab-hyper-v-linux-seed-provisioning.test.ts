import { describe, expect, it, vi } from "vitest";

import {
    attachDeviceLabHyperVLinuxSeedMedia,
    inspectDeviceLabHyperVLinuxSeedTarget,
    linuxSeedBootstrapMacAddress,
    linuxSeedFailureCode,
} from "@ccc/device-lab/device-lab/broker/hyper-v/linux-seed-provisioning.js";
import type { HyperVProviderCommand } from "@ccc/device-lab/host-control/hyper-v/index.js";

const vmId = "12345678-1234-1234-1234-123456789abc";
const vmName = "ccc-owned-linux";
const expectedNotes = "ccc-device-lab:owner:device:incarnation";
const osDiskPath = "C:\\owned\\root.vhdx";
const mediaPath = "C:\\owned\\cidata.iso";
const managedMacAddress = "02:11:22:33:44:55";
const bootstrapMac = "061122334455";

function requestOf(command: HyperVProviderCommand): Record<string, any> {
    const memory = JSON.parse(Buffer.from(command.input || "", "base64").toString("utf8")) as { input: string };
    return JSON.parse(memory.input) as Record<string, any>;
}

function success(operation: string, items: unknown[] = []) {
    return { status: 0, stdout: JSON.stringify({ schemaVersion: 1, operation, ok: true, items }) };
}

function machine(generation: 1 | 2 = 2, notes = expectedNotes) {
    return { id: vmId, name: vmName, notes, generation, state: "Off", status: "Operating normally",
        uptimeMilliseconds: 0, checkpointType: "Production" };
}

function adapter(vm = vmId, mac = bootstrapMac) {
    return { vmId: vm, vmName, name: "CCC Bootstrap DHCP", switchId: null,
        switchName: "Default Switch", status: "Ok", managementOperatingSystem: false,
        macAddress: mac, ipAddresses: [] };
}

function target(run: (command: HyperVProviderCommand) => Promise<any>, generation: 1 | 2 = 2) {
    return { executable: "powershell.exe", run, timeoutMilliseconds: () => 3000,
        vmId, vmName, expectedNotes, generation, osDiskPath, mediaPath, managedMacAddress };
}

describe("Device Lab typed Linux seed VM boundary", () => {
    it.each([1, 2] as const)("checks ownership and unique bootstrap MAC before media for generation %i", async (generation) => {
        const calls: string[] = [];
        const run = vi.fn(async (command: HyperVProviderCommand) => {
            const request = requestOf(command);
            calls.push(request.operation + (request.selector ? ":vm" : ":host"));
            return success(request.operation, request.operation === "Get-VM" ? [machine(generation)]
                : request.operation === "Get-VMNetworkAdapter" ? [adapter()] : []);
        });
        await inspectDeviceLabHyperVLinuxSeedTarget(target(run, generation));
        expect(calls).toEqual(["Get-VM:vm", "Get-VMNetworkAdapter:vm", "Get-VMNetworkAdapter:host", "Get-VMDvdDrive:vm"]);
        expect(linuxSeedBootstrapMacAddress(managedMacAddress)).toBe(bootstrapMac);
    });

    it("rejects a foreign VM before adapter or media work", async () => {
        const calls: string[] = [];
        const run = vi.fn(async (command: HyperVProviderCommand) => {
            const request = requestOf(command);
            calls.push(request.operation);
            return success(request.operation, [machine(2, "other-owner")]);
        });
        await expect(inspectDeviceLabHyperVLinuxSeedTarget(target(run)))
            .rejects.toThrow("hyper-v-vm-ownership-mismatch");
        expect(calls).toEqual(["Get-VM"]);
    });

    it("rejects a running VM before adapter or media work", async () => {
        const calls: string[] = [];
        const run = vi.fn(async (command: HyperVProviderCommand) => {
            const request = requestOf(command);
            calls.push(request.operation);
            return success(request.operation, [{ ...machine(), state: "Running" }]);
        });
        await expect(inspectDeviceLabHyperVLinuxSeedTarget(target(run)))
            .rejects.toThrow("hyper-v-linux-seed-requires-stopped-vm");
        expect(calls).toEqual(["Get-VM"]);
    });

    it.each(["foreign", "duplicate"] as const)("rejects a %s host-wide MAC match", async (kind) => {
        const calls: string[] = [];
        const run = vi.fn(async (command: HyperVProviderCommand) => {
            const request = requestOf(command);
            calls.push(request.operation);
            return success(request.operation, request.operation === "Get-VM" ? [machine()]
                : request.operation === "Get-VMNetworkAdapter" && request.selector ? [adapter()]
                    : request.operation === "Get-VMNetworkAdapter" ? kind === "foreign"
                        ? [adapter("87654321-4321-4321-4321-cba987654321")]
                        : [adapter(), adapter("87654321-4321-4321-4321-cba987654321")]
                        : []);
        });
        await expect(inspectDeviceLabHyperVLinuxSeedTarget(target(run)))
            .rejects.toThrow("hyper-v-linux-bootstrap-mac-identity-mismatch");
        expect(calls).not.toContain("Get-VMDvdDrive");
    });

    it("rejects a second named bootstrap adapter before host-wide lookup", async () => {
        const calls: string[] = [];
        const run = vi.fn(async (command: HyperVProviderCommand) => {
            const request = requestOf(command);
            calls.push(request.operation);
            return success(request.operation, request.operation === "Get-VM" ? [machine()]
                : request.operation === "Get-VMNetworkAdapter" ? [adapter(), {
                    ...adapter(), switchName: "Other Switch", macAddress: "061122334456",
                }] : []);
        });
        await expect(inspectDeviceLabHyperVLinuxSeedTarget(target(run)))
            .rejects.toThrow("hyper-v-linux-bootstrap-adapter-invalid");
        expect(calls).toEqual(["Get-VM", "Get-VMNetworkAdapter"]);
    });

    it("refuses an ISO already attached before media overwrite", async () => {
        const run = vi.fn(async (command: HyperVProviderCommand) => {
            const request = requestOf(command);
            return success(request.operation, request.operation === "Get-VM" ? [machine()]
                : request.operation === "Get-VMNetworkAdapter" ? [adapter()]
                    : [{ vmId, vmName, path: mediaPath, controllerType: "SCSI", controllerNumber: 0, controllerLocation: 1 }]);
        });
        await expect(inspectDeviceLabHyperVLinuxSeedTarget(target(run)))
            .rejects.toThrow("hyper-v-linux-seed-media-already-attached");
    });

    it.each([1, 2] as const)("sends a Linux-only typed attach policy for generation %i", async (generation) => {
        const requests: Record<string, any>[] = [];
        const run = vi.fn(async (command: HyperVProviderCommand) => {
            const request = requestOf(command);
            requests.push(request);
            return success(request.operation);
        });
        await attachDeviceLabHyperVLinuxSeedMedia(target(run, generation));
        expect(requests).toHaveLength(1);
        expect(requests[0]).toEqual({ schemaVersion: 1, operation: "Configure-VMGuestBoot", guestKind: "linux",
            selector: { kind: "id", id: vmId }, expectedName: vmName, expectedNotes, osDiskPath, mediaPath,
            expectedBootstrapAdapterName: "CCC Bootstrap DHCP", expectedBootstrapSwitchName: "Default Switch",
            expectedBootstrapMacAddress: bootstrapMac,
            bootSettings: generation === 2 ? { generation: 2, secureBoot: { enabled: false } }
                : { generation: 1, startupOrder: ["IDE", "CD", "LegacyNetworkAdapter", "Floppy"] } });
    });

    it("does not retry an uncertain attach result or expose transport details", async () => {
        const run = vi.fn(async () => ({ status: null, stdout: "", error: "host path C:\\private\\secret" }));
        let thrown: unknown;
        try { await attachDeviceLabHyperVLinuxSeedMedia(target(run)); } catch (cause) { thrown = cause; }
        expect(run).toHaveBeenCalledTimes(1);
        expect(linuxSeedFailureCode(thrown, "hyper-v-linux-seed-media-attach-command-failed"))
            .toBe("hyper-v-linux-seed-media-attach-command-failed");
        expect(JSON.stringify(thrown)).not.toContain("C:\\private");
    });
});
