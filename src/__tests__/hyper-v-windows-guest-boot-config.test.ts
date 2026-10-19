import { readFileSync } from "fs";
import { describe, expect, it, vi } from "vitest";

import {
    createHyperVWindowsClient,
    type HyperVConfigureVMGuestBootRequest,
    type HyperVWindowsExecutionContext,
    type HyperVWindowsExecutionRequest,
} from "@ccc/hyper-v/low-level/index.js";

const vmId = "11111111-2222-3333-4444-555555555555";
const request: HyperVConfigureVMGuestBootRequest = {
    selector: { kind: "id", id: vmId.toUpperCase() },
    expectedName: "test-vm",
    expectedNotes: "opaque-owner-marker",
    osDiskPath: "C:\\Hyper-V\\os.vhdx",
    mediaPath: "C:\\Hyper-V\\provision.iso",
    bootSettings: { generation: 2, secureBoot: { enabled: true, template: "MicrosoftWindows" } },
};
const linuxRequest = {
    ...request,
    guestKind: "linux",
    expectedBootstrapAdapterName: " tenant DHCP Adapter ",
    expectedBootstrapSwitchName: " Tenant Uplink ",
    expectedBootstrapMacAddress: "00aabbccddee",
    bootSettings: { generation: 2, secureBoot: { enabled: false } },
} as const satisfies HyperVConfigureVMGuestBootRequest;
const bootstrapFields = [
    "expectedBootstrapAdapterName", "expectedBootstrapSwitchName", "expectedBootstrapMacAddress",
] as const;

describe("typed Hyper-V guest boot configuration", () => {
    it.each([undefined, "windows"] as const)("sends exact Windows generation policies with guestKind %s", async (guestKind) => {
        const execute = vi.fn(async (sent: HyperVWindowsExecutionRequest, _context: HyperVWindowsExecutionContext) => ({
            status: 0,
            stdout: JSON.stringify({ schemaVersion: 1, operation: sent.operation, ok: true, items: [] }),
        }));
        const client = createHyperVWindowsClient({ execute });
        const windowsRequest = guestKind === undefined ? request : { ...request, guestKind };
        const generation1Request = {
            ...windowsRequest,
            bootSettings: { generation: 1, startupOrder: ["IDE", "CD", "LegacyNetworkAdapter", "Floppy"] },
        } as const;
        await expect(client.configureVMGuestBoot(windowsRequest)).resolves.toBeUndefined();
        await expect(client.configureVMGuestBoot(generation1Request)).resolves.toBeUndefined();
        expect(execute).toHaveBeenCalledTimes(2);
        expect(execute.mock.calls[0][0]).toEqual({
            schemaVersion: 1,
            operation: "Configure-VMGuestBoot",
            ...windowsRequest,
            selector: { kind: "id", id: vmId },
        });
        expect(execute.mock.calls[1][0]).toEqual({
            schemaVersion: 1,
            operation: "Configure-VMGuestBoot",
            ...generation1Request,
            selector: { kind: "id", id: vmId },
        });
    });

    it("rejects ambiguous identity, unsafe paths, and invalid settings before native execution", async () => {
        const execute = vi.fn(async () => ({ status: 0, stdout: "" }));
        const client = createHyperVWindowsClient({ execute });
        const invalid: HyperVConfigureVMGuestBootRequest[] = [
            { ...request, selector: { kind: "name", name: "test-vm" } as never },
            { ...request, expectedNotes: "" },
            { ...request, osDiskPath: "relative.vhdx" },
            { ...request, mediaPath: "C:\\media\\[x].iso" },
            { ...request, bootSettings: { generation: 2, secureBoot: { enabled: false } } },
            { ...request, bootSettings: { generation: 1, startupOrder: ["IDE", "IDE"] } },
        ];
        for (const bad of invalid) await expect(client.configureVMGuestBoot(bad)).rejects.toMatchObject({ category: "validation" });
        expect(execute).not.toHaveBeenCalled();
    });

    it.each([1, 2] as const)("sends caller names and any nonzero MAC spelling exactly for Linux generation %i", async (generation) => {
        const execute = vi.fn(async (sent: HyperVWindowsExecutionRequest) => ({
            status: 0,
            stdout: JSON.stringify({ schemaVersion: 1, operation: sent.operation, ok: true, items: [] }),
        }));
        const client = createHyperVWindowsClient({ execute });
        const bootSettings = generation === 2 ? linuxRequest.bootSettings
            : { generation: 1, startupOrder: ["IDE", "CD", "LegacyNetworkAdapter", "Floppy"] } as const;
        for (const mac of ["00aabbccddee", "00:aa:bb:cc:dd:ee", "00-aa-bb-cc-dd-ee"]) {
            await client.configureVMGuestBoot({ ...linuxRequest, expectedBootstrapMacAddress: mac, bootSettings });
        }
        expect(execute).toHaveBeenCalledTimes(3);
        for (const [sent] of execute.mock.calls) expect(sent).toEqual({
            schemaVersion: 1,
            operation: "Configure-VMGuestBoot",
            ...linuxRequest,
            selector: { kind: "id", id: vmId },
            expectedBootstrapMacAddress: "00AABBCCDDEE",
            bootSettings,
        });
    });

    it.each(["expectedBootstrapAdapterName", "expectedBootstrapSwitchName"] as const)("preserves a 100-character %s", async (field) => {
        const execute = vi.fn(async (sent: HyperVWindowsExecutionRequest) => ({
            status: 0,
            stdout: JSON.stringify({ schemaVersion: 1, operation: sent.operation, ok: true, items: [] }),
        }));
        const supplied = { ...linuxRequest, [field]: "x".repeat(100) };
        await createHyperVWindowsClient({ execute }).configureVMGuestBoot(supplied);
        expect(execute).toHaveBeenCalledOnce();
        expect(execute.mock.calls[0][0]).toEqual({
            schemaVersion: 1,
            operation: "Configure-VMGuestBoot",
            ...supplied,
            selector: { kind: "id", id: vmId },
            expectedBootstrapMacAddress: "00AABBCCDDEE",
        });
    });

    it.each(bootstrapFields)("requires Linux %s before native execution", async (field) => {
        const execute = vi.fn(async () => ({ status: 0, stdout: "" }));
        const incomplete: Record<string, unknown> = { ...linuxRequest };
        delete incomplete[field];
        await expect(createHyperVWindowsClient({ execute }).configureVMGuestBoot(incomplete as HyperVConfigureVMGuestBootRequest))
            .rejects.toMatchObject({ category: "validation" });
        expect(execute).not.toHaveBeenCalled();
    });

    it.each(["expectedBootstrapAdapterName", "expectedBootstrapSwitchName"] as const)("rejects unsafe or non-string %s before native execution", async (field) => {
        const execute = vi.fn(async () => ({ status: 0, stdout: "" }));
        const client = createHyperVWindowsClient({ execute });
        const invalid: unknown[] = [
            undefined, null, 123, false, {}, [], Object("Tenant"), "", "x".repeat(101),
            "Tenant*", "Tenant?", "Tenant[", "Tenant]",
            ...Array.from({ length: 32 }, (_, code) => `Tenant${String.fromCharCode(code)}`),
        ];
        for (const value of invalid) {
            await expect(client.configureVMGuestBoot({ ...linuxRequest, [field]: value } as HyperVConfigureVMGuestBootRequest))
                .rejects.toMatchObject({ category: "validation" });
        }
        expect(execute).not.toHaveBeenCalled();
    });

    it("rejects malformed, mixed, zero, or control-terminated MACs before native execution", async () => {
        const execute = vi.fn(async () => ({ status: 0, stdout: "" }));
        const client = createHyperVWindowsClient({ execute });
        const invalid: unknown[] = [
            undefined, null, 123, {}, "", "000000000000", "00:00:00:00:00:00", "00-00-00-00-00-00",
            "00AABBCCDDE", "00AABBCCDDEEF", "00AABBCCDDEG", "00:aa-bb:cc:dd:ee", "00-aa:bb-cc-dd-ee",
            "0:0a:bb:cc:dd:eee", "0-0a-bb-cc-dd-eee",
            "00AABBCCDDEE\n", "00AABBCCDDEE\r\n", "00:AA:BB:CC:DD:EE\n", "00-AA-BB-CC-DD-EE\n",
            "00AABBCCDDEE\0", " 00AABBCCDDEE", "00AABBCCDDEE ",
        ];
        for (const value of invalid) {
            await expect(client.configureVMGuestBoot({ ...linuxRequest, expectedBootstrapMacAddress: value } as HyperVConfigureVMGuestBootRequest))
                .rejects.toMatchObject({ category: "validation" });
        }
        expect(execute).not.toHaveBeenCalled();
    });

    it.each(bootstrapFields)("forbids any own Windows %s, including undefined or null", async (field) => {
        const execute = vi.fn(async () => ({ status: 0, stdout: "" }));
        const client = createHyperVWindowsClient({ execute });
        for (const windowsRequest of [request, { ...request, guestKind: "windows" } as const]) {
            for (const value of [undefined, null, linuxRequest[field]]) {
                await expect(client.configureVMGuestBoot({ ...windowsRequest, [field]: value } as HyperVConfigureVMGuestBootRequest))
                    .rejects.toMatchObject({ category: "validation" });
            }
        }
        expect(execute).not.toHaveBeenCalled();
    });

    it("rejects extra policy fields and invalid Linux settings before native execution", async () => {
        const execute = vi.fn(async () => ({ status: 0, stdout: "" }));
        const client = createHyperVWindowsClient({ execute });
        const invalid = [
            { ...linuxRequest, bootstrapPolicy: "other" },
            { ...linuxRequest, bootSettings: { generation: 2, secureBoot: { enabled: true, template: "MicrosoftWindows" } } },
            { ...linuxRequest, bootSettings: { generation: 1, startupOrder: ["CD", "IDE"] } },
            { ...linuxRequest, bootSettings: { generation: 3, secureBoot: { enabled: false } } },
            { ...linuxRequest, guestKind: "other" },
        ];
        for (const bad of invalid) {
            await expect(client.configureVMGuestBoot(bad as HyperVConfigureVMGuestBootRequest))
                .rejects.toMatchObject({ category: "validation" });
        }
        expect(execute).not.toHaveBeenCalled();
    });

    it("rejects success payloads and never replays an uncertain native result", async () => {
        const execute = vi.fn(async () => ({
            status: 0,
            stdout: JSON.stringify({ schemaVersion: 1, operation: "Configure-VMGuestBoot", ok: true, items: [{ path: "C:\\secret" }] }),
        }));
        await expect(createHyperVWindowsClient({ execute }).configureVMGuestBoot(request))
            .rejects.toMatchObject({ category: "protocol", code: "result-ambiguous" });
        expect(execute).toHaveBeenCalledOnce();
    });

    it("does not retry an operation that timed out after it may have attached media", async () => {
        const execute = vi.fn(async () => ({ status: null, stdout: "", timedOut: true }));
        await expect(createHyperVWindowsClient({ execute }).configureVMGuestBoot(request))
            .rejects.toMatchObject({ category: "transport", code: "timeout" });
        expect(execute).toHaveBeenCalledOnce();
    });

    it("fences every mutation behind preflight and reads back postconditions", () => {
        const source = readFileSync(new URL("../../packages/hyper-v/powershell/Invoke-HyperVWindowsOperation.ps1", import.meta.url), "utf8");
        const branch = source.split('        "Configure-VMGuestBoot" {')[1]?.split('        "Get-VMHardDiskDrive" {')[0] ?? "";
        expect(branch).toContain("hyper-v-guest-provision-vm-identity-mismatch");
        expect(branch).toContain("hyper-v-guest-provision-requires-stopped-vm");
        expect(branch).toContain("$Disks.Count -ne 1");
        expect(branch).toContain("hyper-v-guest-provisioning-media-already-attached");
        expect(branch.indexOf("hyper-v-guest-provisioning-media-already-attached"))
            .toBeLessThan(branch.indexOf("Hyper-V\\Add-VMDvdDrive"));
        expect(branch).toContain("Hyper-V\\Set-VMFirmware");
        expect(branch).toContain("Hyper-V\\Get-VMFirmware");
        expect(branch).toContain("Hyper-V\\Set-VMBios");
        expect(branch).toContain("Hyper-V\\Get-VMBios");
        expect(branch).toContain("Hyper-V\\Enable-VMIntegrationService");
        expect(branch).toContain("$StillDisabled.Count -ne 0");
        expect(branch).toContain("Hyper-V\\Remove-VMDvdDrive -VMDvdDrive $CleanupAttachments[0]");
        expect(branch).toContain("$CleanupVirtualMachines = @(Get-HyperVWindowsVirtualMachines $Request.selector)");
        expect(branch.indexOf("cleanup-vm-identity-changed"))
            .toBeLessThan(branch.indexOf("Hyper-V\\Remove-VMDvdDrive -VMDvdDrive $CleanupAttachments[0]"));
        expect(branch).toContain("hyper-v-guest-provision-media-cleanup-failed");
        expect(branch).toContain("$FailureCode -cnotin $GuestBootFixedErrorCodes");
        expect(source).toContain('$Operation -eq "Configure-VMGuestBoot" -and $ErrorCode -cnotin $GuestBootFixedErrorCodes');
        expect(branch).not.toContain("$_.Exception.Message | ConvertTo-Json");
    });

    it("rechecks Linux identity and host-wide bootstrap MAC before attach, then preserves integration state", () => {
        const source = readFileSync(new URL("../../packages/hyper-v/powershell/Invoke-HyperVWindowsOperation.ps1", import.meta.url), "utf8");
        const branch = source.split('        "Configure-VMGuestBoot" {')[1]?.split('        "Get-VMHardDiskDrive" {')[0] ?? "";
        const preAttach = branch.split("$GuestBootStage = \"media-attach\"")[0] ?? "";
        expect(preAttach).toContain("$CurrentVirtualMachines = @(Get-HyperVWindowsVirtualMachines $Request.selector)");
        expect(preAttach).toContain("[Guid]$CurrentVirtualMachines[0].Id -ne [Guid][string]$Request.selector.id");
        expect(preAttach).toContain("Hyper-V\\Get-VMNetworkAdapter -VM $VirtualMachine");
        expect(preAttach).toContain("Hyper-V\\Get-VMNetworkAdapter -All");
        expect(preAttach).toContain("$HostBootstrapMacMatches.Count -ne 1");
        expect(preAttach).toContain("[string]$_.Name -ceq $ExpectedBootstrapAdapterName");
        expect(preAttach).toContain("[string]$BootstrapAdapters[0].SwitchName -cne $ExpectedBootstrapSwitchName");
        expect(preAttach).toContain("[string]$HostBootstrapMacMatches[0].Name -cne $ExpectedBootstrapAdapterName");
        expect(preAttach).toContain("[string]$HostBootstrapMacMatches[0].SwitchName -cne $ExpectedBootstrapSwitchName");
        expect(branch).not.toContain("CCC Bootstrap DHCP");
        expect(branch).not.toContain("Default Switch");
        expect(branch).not.toContain('.StartsWith("06"');
        expect(preAttach).toContain('$Generation -eq 1 -and [string]$Disks[0].ControllerType -ine "IDE"');
        expect(preAttach.indexOf('$Disks[0].ControllerType -ine "IDE"'))
            .toBeLessThan(branch.indexOf('Hyper-V\\Add-VMDvdDrive'));
        expect(branch).toContain("Hyper-V\\Set-VMFirmware -VM $VirtualMachine -EnableSecureBoot Off -FirstBootDevice $Disks[0]");
        expect(branch).toContain("[string]$Firmware.SecureBoot -cne \"Off\"");
        expect(branch).toContain('if ($GuestKind -ceq "windows") {\n                    $GuestBootStage = "integration-services"');
        expect(branch).toContain('if ($GuestBootMayHaveAttached -and $GuestKind -cne "linux") {');
        expect(branch.indexOf('if ($GuestBootMayHaveAttached -and $GuestKind -cne "linux") {'))
            .toBeLessThan(branch.indexOf("Hyper-V\\Remove-VMDvdDrive -VMDvdDrive $CleanupAttachments[0]"));
        expect(branch).toContain("Hyper-V\\Remove-VMDvdDrive -VMDvdDrive $CleanupAttachments[0]");
    });
});
