import { describe, expect, it, vi } from "vitest";

import { provisionDeviceLabHyperVWindowsGuest } from "@ccc/device-lab/device-lab/broker/hyper-v/windows-guest-provisioning.js";
import type { DeviceLabHyperVCommandResult, DeviceLabHyperVCommandRunner } from "@ccc/device-lab/device-lab/broker/hyper-v/lifecycle-adapter.js";
import type { HyperVWindowsExecutionRequest } from "@ccc/hyper-v/index.js";
import { hyperVGuestProvisionCommand, hyperVGuestProvisionMediaCommand, hyperVVmName,
    type HyperVProviderCommand } from "@ccc/device-lab/host-control/hyper-v/index.js";

const id = "12345678-1234-1234-1234-123456789abc";
const vmName = "owned-vm";
const marker = "ccc-device-lab:owner:device:incarnation";
const credentialPath = "C:\\private\\guest.xml";
const mediaPath = "C:\\devices\\autounattend.iso";
const osDiskPath = "C:\\devices\\root.vhdx";
const guestUsername = "ccc12345678";
const mediaCommand = { mode: "exec" as const, provider: "hyper-v" as const,
    executable: "powershell.exe", args: ["-Command", "media"], input: "private-password" };

function requestOf(command: { input?: string }): HyperVWindowsExecutionRequest {
    const memory = JSON.parse(Buffer.from(command.input || "", "base64").toString("utf8")) as { input: string };
    return JSON.parse(memory.input) as HyperVWindowsExecutionRequest;
}

function success(request: HyperVWindowsExecutionRequest, items: unknown[]) {
    return { status: 0, stdout: JSON.stringify({ schemaVersion: 1, operation: request.operation, ok: true, items }) };
}

function vm(generation: 1 | 2, notes = marker) {
    return { id, name: vmName, notes, generation, state: "Off", status: "Operating normally",
        uptimeMilliseconds: 0, checkpointType: "ProductionOnly" };
}

function mediaResult() {
    return { status: 0, stdout: JSON.stringify({ ok: true, vmId: id, vmName, guestUsername, credentialPath,
        unattendPath: mediaPath }) };
}

function options(run: DeviceLabHyperVCommandRunner,
    generation: 1 | 2 = 2) {
    return { executable: "powershell.exe", mediaCommand, run, timeoutMilliseconds: () => 2000,
        vmId: id, vmName, expectedNotes: marker, generation, osDiskPath, mediaPath,
        credentialPath, guestUsername, outputLimit: 8192 };
}

describe("Device Lab typed Windows guest provisioning", () => {
    it("retains the credential and three-file OOBE media while leaving VM mutation to the typed client", () => {
        const input = { executable: "powershell.exe", ownerId: "0123456789abcdef", deviceId: "windows-ci-01",
            incarnationId: "11111111111111111111111111111111",
            vmName: hyperVVmName("0123456789abcdef", "windows-ci-01", "11111111111111111111111111111111"), vmId: id,
            diskPath: "/state/owners/0123456789abcdef/windows-vm/windows-ci-01/disks/root.vhdx",
            deviceRoot: "/state/owners/0123456789abcdef/windows-vm/windows-ci-01",
            credentialPath: "/state/owners/0123456789abcdef/windows-vm/windows-ci-01/secrets/guest.xml",
            provisioningMediaPath: "/state/owners/0123456789abcdef/windows-vm/windows-ci-01/disks/autounattend.iso",
            guestUsername, guestPassword: "Ccc!7test-password-with-sufficient-length",
            networkAddress: "192.168.100.50", networkGateway: "192.168.100.1", networkPrefixLength: 24 };
        const media = hyperVGuestProvisionMediaCommand(input);
        const legacy = hyperVGuestProvisionCommand(input);
        const scriptOf = (command: HyperVProviderCommand) => {
            const outer = Buffer.from(command.args.at(-1) || "", "base64").toString("utf16le");
            return outer.includes("$E=[Console]::In.ReadToEnd().Trim()") && command.input
                ? Buffer.from(command.input, "base64").toString("utf8") : outer;
        };
        const mediaScript = scriptOf(media);
        const legacyScript = scriptOf(legacy);
        expect(mediaScript.match(/\$CccCommandInputBase64 = '([A-Za-z0-9+/=]+)'/)?.[1])
            .toBe(legacyScript.match(/\$CccCommandInputBase64 = '([A-Za-z0-9+/=]+)'/)?.[1]);
        expect(mediaScript.match(/\$FirstLogonScriptBase64 = '([A-Za-z0-9+/=]+)'/)?.[1])
            .toBe(legacyScript.match(/\$FirstLogonScriptBase64 = '([A-Za-z0-9+/=]+)'/)?.[1]);
        expect(mediaScript).toContain("'Autounattend.xml' = $UnattendBytes; 'unattend.xml' = $UnattendBytes; 'ccc-first-logon.ps1' = $FirstLogonBytes");
        expect(mediaScript).toContain("Write-CccIso $IsoFiles $ProvisioningMedia 'CCC_UNATTEND' $MediaSourceRoot");
        expect(mediaScript).toContain("Export-Clixml -LiteralPath $CredentialPath -Force");
        expect(mediaScript).not.toContain("Add-VMDvdDrive -VM $Vm");
        expect(mediaScript).not.toContain("Set-VMFirmware -VM $Vm");
        expect(mediaScript).not.toContain("Set-VMBios -VM $Vm");
        expect(mediaScript).not.toContain("Enable-VMIntegrationService -ErrorAction Stop");
    });

    it.each([1, 2] as const)("preflights owner, builds media, and configures generation %i once before publishing facts", async (generation) => {
        const calls: string[] = [];
        const requests: HyperVWindowsExecutionRequest[] = [];
        const media = { ...mediaResult(), stdout: "media prepared\n" + JSON.stringify({ ok: true,
            vmId: id.toUpperCase(), vmName, guestUsername, credentialPath, unattendPath: mediaPath }) };
        let allowConfiguration!: () => void;
        const configuration = new Promise<void>((resolve) => { allowConfiguration = resolve; });
        let configurationStarted!: () => void;
        const configuring = new Promise<void>((resolve) => { configurationStarted = resolve; });
        const run = vi.fn(async (command: HyperVProviderCommand) => {
            if (command === mediaCommand) { calls.push("media"); return media; }
            const request = requestOf(command);
            requests.push(request);
            calls.push(request.operation);
            if (request.operation === "Configure-VMGuestBoot") {
                configurationStarted();
                await configuration;
            }
            return success(request, request.operation === "Get-VM" ? [vm(generation)] : []);
        });
        let published = false;
        const provisioning = provisionDeviceLabHyperVWindowsGuest(options(run, generation))
            .then((result) => { published = true; return result; });
        await Promise.race([configuring, provisioning]);
        expect(published).toBe(false);
        expect(calls).toEqual(["Get-VM", "Get-VMDvdDrive", "media", "Configure-VMGuestBoot"]);
        allowConfiguration();
        const result = await provisioning;
        expect(result).toEqual({ ok: true,
            observation: { ok: true, vmId: id, vmName, guestUsername, credentialPath, unattendPath: mediaPath },
            execution: { ...mediaCommand, ...media } });
        expect(calls).toEqual(["Get-VM", "Get-VMDvdDrive", "media", "Configure-VMGuestBoot"]);
        expect(run).toHaveBeenCalledTimes(4);
        expect(run).toHaveBeenCalledWith(mediaCommand, { timeoutMs: 2000, outputLimit: 8192 });
        expect(requests[2]).toMatchObject({ operation: "Configure-VMGuestBoot", selector: { kind: "id", id },
            expectedName: vmName, expectedNotes: marker, osDiskPath, mediaPath,
            bootSettings: generation === 2
                ? { generation: 2, secureBoot: { enabled: true, template: "MicrosoftWindows" } }
                : { generation: 1, startupOrder: ["IDE", "CD", "LegacyNetworkAdapter", "Floppy"] } });
    });

    it("rejects changed identity before writing credential or media", async () => {
        const calls: string[] = [];
        const run = vi.fn(async (command: HyperVProviderCommand) => {
            if (command === mediaCommand) { calls.push("media"); return mediaResult(); }
            const request = requestOf(command);
            calls.push(request.operation);
            return success(request, [vm(2, "other-owner")]);
        });
        const result = await provisionDeviceLabHyperVWindowsGuest(options(run));
        expect(result).toEqual({ ok: false, observation: null, execution: {
            mode: "exec", provider: "hyper-v", executable: "powershell.exe", args: [],
            status: 1, stdout: "", stderr: "hyper-v-vm-ownership-mismatch" } });
        expect(calls).toEqual(["Get-VM"]);
    });

    it("bounds a failed preflight without publishing facts or writing media", async () => {
        const calls: string[] = [];
        const run = vi.fn(async (command: HyperVProviderCommand) => {
            const request = requestOf(command);
            calls.push(request.operation);
            return { status: 1, stdout: "", stderr: "host path C:\\private\\guest.xml" };
        });
        const result = await provisionDeviceLabHyperVWindowsGuest(options(run));
        expect(result).toEqual({ ok: false, observation: null, execution: {
            mode: "exec", provider: "hyper-v", executable: "powershell.exe", args: [],
            status: 1, stdout: "", stderr: "hyper-v-guest-provision-vm-lookup-command-failed" } });
        expect(JSON.stringify(result)).not.toContain("private");
        expect(calls).toEqual(["Get-VM"]);
    });

    it("does not overwrite a provisioning ISO that is already attached", async () => {
        const calls: string[] = [];
        const run = vi.fn(async (command: HyperVProviderCommand) => {
            if (command === mediaCommand) { calls.push("media"); return mediaResult(); }
            const request = requestOf(command);
            calls.push(request.operation);
            return success(request, request.operation === "Get-VM" ? [vm(2)]
                : [{ vmId: id, vmName, path: mediaPath, controllerType: "SCSI",
                    controllerNumber: 0, controllerLocation: 1 }]);
        });
        const result = await provisionDeviceLabHyperVWindowsGuest(options(run));
        expect(result).toEqual({ ok: false, observation: null, execution: {
            mode: "exec", provider: "hyper-v", executable: "powershell.exe", args: [],
            status: 1, stdout: "", stderr: "hyper-v-guest-provisioning-media-already-attached" } });
        expect(calls).toEqual(["Get-VM", "Get-VMDvdDrive"]);
    });

    it.each([
        ["malformed", { status: 0, stdout: "not JSON" }],
        ["incomplete", { status: 0, stdout: JSON.stringify({ ok: true, vmId: id }) }],
        ...[
            { vmId: "87654321-1234-1234-1234-123456789abc" },
            { vmName: "other-vm" },
            { guestUsername: "other-user" },
            { credentialPath: "C:\\other\\guest.xml" },
            { unattendPath: "C:\\other\\autounattend.iso" },
        ].map((mismatch) => [Object.keys(mismatch)[0], { ...mediaResult(),
            stdout: JSON.stringify({ ...JSON.parse(mediaResult().stdout), ...mismatch }) }]),
    ] as [string, DeviceLabHyperVCommandResult][])("keeps successful native evidence but withholds %s media facts and configuration", async (_kind, media) => {
        const calls: string[] = [];
        const run = vi.fn(async (command: HyperVProviderCommand) => {
            if (command === mediaCommand) { calls.push("media"); return media; }
            const request = requestOf(command);
            calls.push(request.operation);
            return success(request, request.operation === "Get-VM" ? [vm(2)] : []);
        });
        const result = await provisionDeviceLabHyperVWindowsGuest(options(run));
        expect(result).toEqual({ ok: true, observation: null, execution: { ...mediaCommand, ...media } });
        expect(calls).toEqual(["Get-VM", "Get-VMDvdDrive", "media"]);
        expect(run).toHaveBeenCalledWith(mediaCommand, { timeoutMs: 2000, outputLimit: 8192 });
    });

    it.each([
        ["native status", { ...mediaResult(), status: 9, stderr: "bounded media diagnostic" }, {}],
        ["native error", { ...mediaResult(), error: "original-media-error" }, {}],
        ["timeout", { ...mediaResult(), timedOut: true },
            { status: 1, error: "hyper-v-guest-provision-media-build-command-failed" }],
        ["overflow", { ...mediaResult(), outputLimitExceeded: true },
            { status: 1, error: "hyper-v-guest-provision-media-build-command-failed" }],
        ["status before timeout", { ...mediaResult(), status: 9, timedOut: true }, {}],
        ["error before overflow", { ...mediaResult(), error: "original-media-error", outputLimitExceeded: true }, {}],
    ] as [string, DeviceLabHyperVCommandResult, DeviceLabHyperVCommandResult][])("preserves %s media failure precedence without configuring", async (_kind, media, expectedChanges) => {
        const calls: string[] = [];
        const run = vi.fn(async (command: HyperVProviderCommand) => {
            if (command === mediaCommand) { calls.push("media"); return media; }
            const request = requestOf(command);
            calls.push(request.operation);
            return success(request, request.operation === "Get-VM" ? [vm(2)] : []);
        });
        const result = await provisionDeviceLabHyperVWindowsGuest(options(run));
        expect(result).toEqual({ ok: false, observation: null, execution: {
            ...mediaCommand, ...media, ...expectedChanges,
        } });
        expect(calls).toEqual(["Get-VM", "Get-VMDvdDrive", "media"]);
        expect(run).toHaveBeenCalledWith(mediaCommand, { timeoutMs: 2000, outputLimit: 8192 });
    });

    it("bounds a thrown media failure without publishing facts or configuring", async () => {
        const calls: string[] = [];
        const run = vi.fn(async (command: HyperVProviderCommand) => {
            if (command === mediaCommand) {
                calls.push("media");
                throw new Error("host path C:\\private\\guest.xml");
            }
            const request = requestOf(command);
            calls.push(request.operation);
            return success(request, request.operation === "Get-VM" ? [vm(2)] : []);
        });
        const result = await provisionDeviceLabHyperVWindowsGuest(options(run));
        expect(result).toEqual({ ok: false, observation: null, execution: {
            mode: "exec", provider: "hyper-v", executable: "powershell.exe", args: [],
            status: 1, stdout: "", stderr: "hyper-v-guest-provision-media-build-command-failed" } });
        expect(JSON.stringify(result)).not.toContain("private");
        expect(calls).toEqual(["Get-VM", "Get-VMDvdDrive", "media"]);
        expect(run).toHaveBeenCalledWith(mediaCommand, { timeoutMs: 2000, outputLimit: 8192 });
    });

    it("does not replay configuration after an uncertain native result", async () => {
        const calls: string[] = [];
        const run = vi.fn(async (command: HyperVProviderCommand) => {
            if (command === mediaCommand) { calls.push("media"); return mediaResult(); }
            const request = requestOf(command);
            calls.push(request.operation);
            return request.operation === "Get-VM" ? success(request, [vm(2)])
                : request.operation === "Get-VMDvdDrive" ? success(request, [])
                : { status: null, stdout: "", error: "lost-response-with-host-path-C:\\private\\guest.xml" };
        });
        const result = await provisionDeviceLabHyperVWindowsGuest(options(run));
        expect(result).toEqual({ ok: false, observation: null, execution: {
            mode: "exec", provider: "hyper-v", executable: "powershell.exe", args: [],
            status: 1, stdout: "", stderr: "hyper-v-guest-provision-media-attach-command-failed" } });
        expect(JSON.stringify(result)).not.toContain("private");
        expect(calls).toEqual(["Get-VM", "Get-VMDvdDrive", "media", "Configure-VMGuestBoot"]);
        expect(run).toHaveBeenCalledTimes(4);
    });

    it("preserves fixed native boot failure codes without returning host stderr", async () => {
        const calls: string[] = [];
        const run = vi.fn(async (command: HyperVProviderCommand) => {
            if (command === mediaCommand) { calls.push("media"); return mediaResult(); }
            const request = requestOf(command);
            calls.push(request.operation);
            if (request.operation === "Get-VM") return success(request, [vm(2)]);
            if (request.operation === "Get-VMDvdDrive") return success(request, []);
            return { status: 1, stdout: JSON.stringify({ schemaVersion: 1, operation: request.operation,
                ok: false, errorCode: "hyper-v-guest-secure-boot-not-enabled" }),
            stderr: "host path C:\\secret\\guest.xml" };
        });
        const result = await provisionDeviceLabHyperVWindowsGuest(options(run));
        expect(result).toEqual({ ok: false, observation: null, execution: {
            mode: "exec", provider: "hyper-v", executable: "powershell.exe", args: [],
            status: 1, stdout: "", stderr: "hyper-v-guest-secure-boot-not-enabled" } });
        expect(JSON.stringify(result)).not.toContain("secret");
        expect(calls).toEqual(["Get-VM", "Get-VMDvdDrive", "media", "Configure-VMGuestBoot"]);
        expect(run).toHaveBeenCalledTimes(4);
    });
});
