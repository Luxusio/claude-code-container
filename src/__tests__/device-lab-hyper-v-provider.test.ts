import { spawnSync } from "child_process";
import { describe, expect, it } from "vitest";
import {
    hyperVAcquireBaseImageCommand,
    hyperVCleanupNetworkCommand,
    hyperVCreateCommand,
    hyperVDeleteCommand,
    hyperVEnsureNetworkCommand,
    hyperVGuestDownloadCommand,
    hyperVGuestExecCommand,
    hyperVGuestProvisionCommand,
    hyperVGuestReadyCommand,
    hyperVGuestUploadCommand,
    hyperVLinuxScpDownloadCommand,
    hyperVLinuxScpUploadCommand,
    hyperVLinuxSeedCommand,
    hyperVLinuxSshExecCommand,
    hyperVLinuxSshReadyCommand,
    hyperVPrepareBaseImageCommand,
    hyperVReadinessCommand,
    hyperVRebootCommand,
    hyperVRecoverOrphanCommand,
    hyperVSnapshotCreateCommand,
    hyperVSnapshotDeleteCommand,
    hyperVSnapshotName,
    hyperVSnapshotRestoreCommand,
    hyperVSetupCommand,
    hyperVStartCommand,
    hyperVStatusCommand,
    hyperVStopCommand,
    hyperVVmName,
    parseHyperVReadiness,
    parseHyperVRecoveryObservation,
    parseHyperVBaseImageObservation,
    parseHyperVDeleteObservation,
    parseHyperVGuestExecObservation,
    parseHyperVGuestProvisionObservation,
    parseHyperVGuestReadyObservation,
    parseHyperVGuestTransferObservation,
    parseHyperVNetworkObservation,
    parseHyperVNetworkCleanupObservation,
    parseHyperVSnapshotObservation,
    parseHyperVSnapshotDeleteObservation,
    parseHyperVSetupObservation,
    parseHyperVVmObservation,
} from "../device-lab/providers/hyper-v.js";

const ownerId = "0123456789abcdef";
const deviceId = "windows-ci-01";
const incarnationId = "11111111111111111111111111111111";
const vmId = "12345678-1234-1234-1234-123456789abc";
const baseImageSha256 = "a".repeat(64);

function scriptOf(command: { args: string[]; input?: string }): string {
    const encoded = command.args.at(-1);
    if (!encoded) throw new Error("missing encoded PowerShell script");
    const decoded = Buffer.from(encoded, "base64").toString("utf16le");
    if (decoded.includes("$CccEncodedProgram = [Console]::In.ReadToEnd().Trim()")) {
        if (!command.input) throw new Error("missing streamed PowerShell program");
        return Buffer.from(command.input, "base64").toString("utf8");
    }
    return decoded;
}

describe("Hyper-V provider adapter", () => {
    it("streams the standard Ubuntu acquisition program over stdin instead of the Windows command line", () => {
        const acquire = hyperVAcquireBaseImageCommand({
            executable: "powershell.exe",
            profile: "ubuntu-lts",
            imageRoot: "/cache",
        });

        expect(acquire.args).toContain("-EncodedCommand");
        expect(acquire.args).not.toContain("-");
        const loader = Buffer.from(acquire.args.at(-1)!, "base64").toString("utf16le");
        expect(loader).toContain("$CccEncodedProgram = [Console]::In.ReadToEnd().Trim()");
        expect(loader).toContain("[ScriptBlock]::Create($CccProgram)");
        expect(acquire.input).toMatch(/^[A-Za-z0-9+/=]+$/);
        expect(scriptOf(acquire)).toContain("Save-BoundedDownload");
        expect(scriptOf(acquire)).toContain("CCC_HYPER_V_RESULT_B64:");
        expect(acquire.args.join(" ").length).toBeLessThan(2048);
        expect(scriptOf(acquire)).toContain("ubuntu-24.04-server-cloudimg-amd64-azure.vhd.tar.gz");
    });

    it.skipIf(process.platform !== "win32")("executes the bounded loader with Base64 stdin on Windows PowerShell 5.1", () => {
        const acquire = hyperVAcquireBaseImageCommand({
            executable: "powershell.exe",
            profile: "ubuntu-lts",
            imageRoot: "C:\\ccc-loader-probe",
        });
        const probe = "Write-Output 'ccc-hyper-v-loader-ok'";
        const result = spawnSync(acquire.executable, acquire.args, {
            input: Buffer.from(probe, "utf8").toString("base64"),
            encoding: "utf8",
            windowsHide: true,
            timeout: 15_000,
        });

        expect(result.status, result.stderr || result.error?.message).toBe(0);
        expect(result.stdout).toContain("ccc-hyper-v-loader-ok");
    });

    it("parses a framed base-image result from noisy Windows PowerShell stdin output", () => {
        const observation = {
            ok: true,
            profile: "ubuntu-lts",
            imagePath: "/state/images/hyper-v/ubuntu-lts/base.vhdx",
            sha256: "a".repeat(64),
            sizeBytes: 1024,
            virtualSizeBytes: 64 * 1024 * 1024 * 1024,
            vhdType: "Dynamic",
            reused: false,
        };
        const framed = Buffer.from(JSON.stringify(observation), "utf8").toString("base64");
        expect(parseHyperVBaseImageObservation(`PS C:\\> command text\r\nPS C:\\> CCC_HYPER_V_RESULT_B64:${framed}\r\nPS C:\\>`)).toEqual(observation);
        expect(parseHyperVBaseImageObservation("CCC_HYPER_V_RESULT_B64:not-base64")).toBeNull();
    });

    it("builds an explicit elevated Hyper-V setup command without automatic reboot", () => {
        const setup = hyperVSetupCommand("powershell.exe");
        const script = scriptOf(setup);
        expect(script).toContain("Start-Process -FilePath $Executable -Verb RunAs");
        const innerEncoded = /\$InnerEncoded = '([^']+)'/.exec(script)?.[1];
        expect(innerEncoded).toBeTruthy();
        const innerScript = Buffer.from(innerEncoded!, "base64").toString("utf16le");
        expect(innerScript).toContain("Microsoft-Hyper-V-All");
        expect(innerScript).toContain("S-1-5-32-578");
        expect(innerScript).toContain("SecurityIdentifier]::new($SetupUserSid)");
        expect(innerScript).toContain("Translate([Security.Principal.NTAccount])");
        expect(innerScript).not.toContain("S-1-5-21-");
        expect(innerScript).toContain("Add-LocalGroupMember");
        expect(innerScript).toContain("-All -NoRestart");
        expect(innerScript).not.toContain("Restart-Computer");
        expect(script).not.toContain("Restart-Computer");
        expect(parseHyperVSetupObservation(JSON.stringify({
            ok: true,
            featureName: "Microsoft-Hyper-V-All",
            beforeState: "Disabled",
            afterState: "Enabled",
            changed: true,
            elevated: true,
            rebootRequired: true,
            hyperVAdministratorsMember: true,
            membershipChanged: true,
            managementAccess: false,
            sessionRefreshRequired: true,
        }))).toEqual({
            ok: true,
            featureName: "Microsoft-Hyper-V-All",
            beforeState: "Disabled",
            afterState: "Enabled",
            changed: true,
            elevated: true,
            rebootRequired: true,
            hyperVAdministratorsMember: true,
            membershipChanged: true,
            managementAccess: false,
            sessionRefreshRequired: true,
        });
        expect(parseHyperVSetupObservation('{"ok":true,"featureName":"Other"}')).toBeNull();
        expect(parseHyperVSetupObservation(JSON.stringify({
            ok: true,
            featureName: "Microsoft-Hyper-V-All",
            beforeState: "Enabled",
            afterState: "Enabled",
            changed: false,
            elevated: false,
            rebootRequired: false,
            sessionRefreshRequired: "false",
        }))).toBeNull();

        const networkSetup = hyperVSetupCommand("powershell.exe", {
            switchName: "CCC Device Lab",
            natName: "CCCDeviceLab",
            marker: "ccc-device-lab:hyper-v-network:v1",
            prefix: "172.29.0.0/24",
            gateway: "172.29.0.1",
            prefixLength: 24,
            allowExistingNat: true,
        });
        const networkOuter = scriptOf(networkSetup);
        expect(networkOuter).toContain("[IO.Pipes.PipeDirection]::InOut");
        expect(networkOuter).toContain("$Writer.WriteLine($NetworkProgramEncoded)");
        expect(networkOuter.indexOf("$ClientProcessId -ne [uint32]$Child.Id"))
            .toBeLessThan(networkOuter.indexOf("$Writer.WriteLine($NetworkProgramEncoded)"));
        const networkInnerEncoded = networkOuter.match(/\$InnerEncoded = '([^']+)'/)?.[1];
        expect(networkInnerEncoded).toBeTruthy();
        const networkInner = Buffer.from(networkInnerEncoded!, "base64").toString("utf16le");
        expect(networkInner).toContain("$NetworkProgramEncoded = $Reader.ReadLine()");
        expect(networkInner).toContain("hyper-v-setup-network-program-invalid");
        expect(networkInner).not.toContain("New-NetIPAddress");
        expect(networkOuter).not.toContain("New-NetIPAddress");
        expect(networkSetup.args.join(" ").length).toBeLessThan(2048);

        const parsedNetwork = parseHyperVSetupObservation(JSON.stringify({
            ok: true,
            featureName: "Microsoft-Hyper-V-All",
            beforeState: "Enabled",
            afterState: "Enabled",
            changed: false,
            elevated: true,
            rebootRequired: false,
            network: {
                ok: true,
                switchName: "CCC Device Lab",
                switchId: vmId,
                natName: "CCCDeviceLab",
                natInstanceId: "ccc-network-instance-1",
                prefix: "172.29.0.0/24",
                gateway: "172.29.0.1",
                interfaceIndex: 42,
                createdSwitch: false,
                createdNat: false,
            },
        }));
        expect(parsedNetwork?.network).toEqual(expect.objectContaining({
            switchId: vmId,
            natInstanceId: "ccc-network-instance-1",
        }));
    });

    it("imports immutable base VHDX files with hash and format verification", () => {
        const command = hyperVPrepareBaseImageCommand({
            executable: "powershell.exe",
            profile: "windows-11",
            sourceImagePath: "/project/images/windows-11.vhdx",
            sourceRoot: "/project",
            imagePath: "/state/images/hyper-v/windows-11/base.vhdx",
            imageRoot: "/state/images/hyper-v",
        });
        const script = scriptOf(command);
        expect(script).toContain("Get-FileHash -LiteralPath $SourceImage -Algorithm SHA256");
        expect(script).toContain("Get-VHD -Path $TempPath");
        expect(script).toContain("hyper-v-base-image-profile-conflict");
        expect(script.match(/hyper-v-base-image-invalid-parent/g)).toHaveLength(2);
        expect(script).toContain("hyper-v-base-image-copy-hash-mismatch");
        expect(script).toContain("Remove-Item -LiteralPath $TempPath -Force");
        expect(script).toContain("Move-Item -LiteralPath $TempPath -Destination $ImagePath");
        expect(() => hyperVPrepareBaseImageCommand({
            executable: "powershell.exe",
            profile: "windows-11",
            sourceImagePath: "/foreign/windows-11.vhdx",
            sourceRoot: "/project",
            imagePath: "/state/images/hyper-v/windows-11/base.vhdx",
            imageRoot: "/state/images/hyper-v",
        })).toThrow("hyper-v-base-image-source-outside-owner-root");
        expect(() => hyperVPrepareBaseImageCommand({
            executable: "powershell.exe",
            profile: "windows-11",
            sourceImagePath: "/project/images/windows-11.vhdx",
            sourceRoot: "/project",
            imagePath: "/foreign/base.vhdx",
            imageRoot: "/state/images/hyper-v",
        })).toThrow("hyper-v-base-image-target-outside-owner-root");
        expect(parseHyperVBaseImageObservation(JSON.stringify({
            ok: true,
            profile: "windows-11",
            imagePath: "/state/images/hyper-v/windows-11/base.vhdx",
            sha256: "A".repeat(64),
            sizeBytes: 1024,
            virtualSizeBytes: 64 * 1024 * 1024 * 1024,
            vhdType: "Dynamic",
            reused: false,
        }))).toEqual({
            ok: true,
            profile: "windows-11",
            imagePath: "/state/images/hyper-v/windows-11/base.vhdx",
            sha256: "a".repeat(64),
            sizeBytes: 1024,
            virtualSizeBytes: 64 * 1024 * 1024 * 1024,
            vhdType: "Dynamic",
            reused: false,
        });
        expect(parseHyperVBaseImageObservation('{"ok":true,"profile":"linux"}')).toBeNull();
        expect(parseHyperVBaseImageObservation(JSON.stringify({ ok: true, profile: "windows-11", imagePath: "/state/base.vhdx", sha256: "a".repeat(64), sizeBytes: 1, virtualSizeBytes: 64, vhdType: "Differencing", reused: true }))).toBeNull();
    });

    it("builds a fixed Microsoft Windows Server VHDX acquisition command", () => {
        const command = hyperVAcquireBaseImageCommand({
            executable: "powershell.exe",
            profile: "windows-server",
            imageRoot: "/state/images/hyper-v",
        });
        const script = scriptOf(command);
        expect(command).toMatchObject({ mode: "exec", provider: "hyper-v", executable: "powershell.exe" });
        expect(script).toContain("https://go.microsoft.com/fwlink/?clcid=0x409&country=us&culture=en-us&linkid=2345826");
        expect(script).toContain("$WindowsMaxBytes = [long]16GB");
        expect(script).toContain("ResponseHeadersRead");
        expect(script).toContain("$Response.Content.Headers.ContentLength");
        expect(script).toContain("$Handler.AllowAutoRedirect = $false");
        expect(script).toContain("Add-Type -AssemblyName System.Net.Http -ErrorAction Stop");
        expect(script).toContain("for ($Redirects = 0; $Redirects -le 10; $Redirects++)");
        expect(script).toContain("& $ValidateHopUri $CurrentUri");
        expect(script).toContain("[Uri]::new($CurrentUri, $Response.Headers.Location)");
        expect(script).toContain("$HostName -eq 'aka.ms'");
        expect(script).toContain(".download.microsoft.com");
        expect(script).toContain("software-static.download.prss.microsoft.com");
        expect(script).not.toContain("$HostName.EndsWith('.microsoft.com')");
        expect(script).not.toMatch(/\$ValidateMicrosoftVhdx[^\n]+aka\.ms/);
        expect(script).toContain("AbsolutePath.EndsWith('.vhdx'");
        expect(script).toContain("Assert-BaseVhd $PartialPath");
        expect(script).toContain("base.partial.vhdx");
        expect(script).toContain("hyper-v-base-image-unmanaged-existing");
        expect(script).not.toContain("Write-BaseObservation $ExistingVhd $true");
        expect(script).toContain("Move-Item -LiteralPath $PartialPath -Destination $ImagePath");
        expect(script).toContain("Remove-Item -LiteralPath $PartialPath -Force -ErrorAction SilentlyContinue");
        expect(script).toContain("function Assert-NoReparsePath");
        expect(script).toContain("hyper-v-path-reparse-point-rejected");
        expect(script).not.toContain("$SourceUrl =");
    });

    it("builds a fixed checksummed Canonical Ubuntu VHD conversion command", () => {
        const command = hyperVAcquireBaseImageCommand({
            executable: "powershell.exe",
            profile: "ubuntu-lts",
            imageRoot: "/state/images/hyper-v",
        });
        const script = scriptOf(command);
        expect(script).toContain("tar.exe -tzf $ArchivePath");
        expect(script).toContain("tar.exe -tvzf $ArchivePath");
        expect(script).toContain("hyper-v-base-image-archive-path-invalid");
        expect(script).toContain("hyper-v-base-image-archive-entry-type-invalid");
        expect(script).toContain("https://cloud-images.ubuntu.com/releases/noble/release-20260705/ubuntu-24.04-server-cloudimg-amd64-azure.vhd.tar.gz");
        expect(script).toContain("05b7b5bb6172e5b0dd1248d5598c1bc27927c4625ba4c09c0442d4751725c43f");
        expect(script).not.toContain("SHA256SUMS");
        expect(script).toContain("$UbuntuMaxBytes = [long]2GB");
        expect(script).toContain("DnsSafeHost.ToLowerInvariant() -eq 'cloud-images.ubuntu.com'");
        expect(script).toContain("Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256");
        expect(script).toContain("hyper-v-base-image-checksum-mismatch");
        expect(script).toContain("$MaximumArchiveEntries = 64");
        expect(script).toContain("$MaximumRegularFiles = 8");
        expect(script).toContain("$MaximumExtractedBytes = [long]64GB");
        expect(script).toContain("hyper-v-base-image-archive-size-rejected");
        expect(script).toContain("hyper-v-base-image-archive-size-mismatch");
        expect(script).toContain("Get-ChildItem -LiteralPath $ExtractPath -Recurse -File -Force");
        expect(script).toContain("hyper-v-base-image-archive-file-count-mismatch");
        expect(script).toContain("hyper-v-base-image-archive-total-size-mismatch");
        expect(script).toContain("[IO.FileAttributes]::ReparsePoint");
        expect(script).toContain("if ($SourceVhds.Count -ne 1)");
        expect(script).toContain("[IO.FileAttributes]::SparseFile");
        expect(script).toContain("normalized-source.vhd");
        expect(script).toContain("$OutputStream.Write($Buffer, 0, $Read)");
        expect(script).toContain("hyper-v-base-image-normalize-attributes-failed");
        expect(script).toContain("Convert-VHD -Path $SourcePath -DestinationPath $PartialPath -VHDType Dynamic");
        expect(script).toContain("Remove-Item -LiteralPath $WorkPath -Recurse -Force -ErrorAction SilentlyContinue");
    });

    it("rejects non-automatic acquisition profiles and unsafe image roots", () => {
        expect(() => hyperVAcquireBaseImageCommand({
            executable: "powershell.exe",
            profile: "windows-11" as "windows-server",
            imageRoot: "/state/images/hyper-v",
        })).toThrow("hyper-v-base-image-profile-not-automatic");
        expect(() => hyperVAcquireBaseImageCommand({
            executable: "powershell.exe",
            profile: "ubuntu-lts",
            imageRoot: "relative/images",
        })).toThrow("hyper-v-base-image-root-invalid");
    });

    it("creates an owner-scoped generation 2 VM with rollback and secure defaults", () => {
        const vmName = hyperVVmName(ownerId, deviceId, incarnationId);
        expect(vmName).toBe(`ccc-${ownerId}-${deviceId}-${incarnationId}`);
        const command = hyperVCreateCommand({
            executable: "powershell.exe",
            ownerId,
            deviceId,
            incarnationId,
            vmName,
            baseImagePath: "/state/images/hyper-v/windows-11.vhdx",
            baseImageSha256,
            baseImageRoot: "/state/images/hyper-v",
            deviceRoot: "/state/owners/0123456789abcdef/windows-vm/windows-ci-01",
            diskPath: "/state/owners/0123456789abcdef/windows-vm/windows-ci-01/disks/root.vhdx",
            diskMaxBytes: 64 * 1024 * 1024 * 1024,
            memoryMb: 4096,
            cpus: 4,
            switchName: "Default Switch",
            macAddress: "02:11:22:33:44:55",
        });

        expect(command).toMatchObject({ mode: "exec", provider: "hyper-v", executable: "powershell.exe" });
        const script = scriptOf(command);
        expect(script).toContain("Generation = 2");
        expect(script).toContain("New-VHD -Path $DiskPath -ParentPath $BaseImage -Differencing");
        expect(script).toContain("[IO.FileShare]::Read");
        expect(script).toContain("$Hasher.ComputeHash($BaseImageStream)");
        expect(script).toContain("hyper-v-base-image-hash-mismatch");
        expect(script).toContain("hyper-v-created-disk-parent-mismatch");
        expect(script).toContain(`ccc-device-lab:${ownerId}:${deviceId}:${incarnationId}`);
        expect(script).toContain("AutomaticCheckpointsEnabled $false");
        expect(script).toContain("CheckpointType ProductionOnly");
        expect(script).toContain("EnableSecureBoot On");
        expect(script).toContain("Get-VMSwitch -Name $SwitchName");
        expect(script).toContain("Set-VMNetworkAdapter -VM $CreatedVm -StaticMacAddress");
        expect(script).toContain("02:11:22:33:44:55");
        expect(script).toContain("hyper-v-network-switch-unavailable");
        expect(script).toContain("$DiskReserveBytes = 10GB");
        expect(script).toContain("hyper-v-host-disk-capacity-exceeded");
        expect(script).toContain("Remove-VM -VM $CreatedVm -Force");
        expect(script).toContain("Remove-Item -LiteralPath $DiskPath -Force");
        expect(script).toContain("if (-not $DeviceRootExisted");
        expect(() => hyperVCreateCommand({
            executable: "powershell.exe",
            ownerId,
            deviceId,
            incarnationId,
            vmName,
            baseImagePath: "/state/images/hyper-v/windows-11.vhdx",
            baseImageSha256,
            baseImageRoot: "/state/images/hyper-v",
            deviceRoot: "/state/owners/0123456789abcdef/windows-vm/windows-ci-01",
            diskPath: "/state/owners/0123456789abcdef/windows-vm/windows-ci-01/disks/root.vhdx",
            diskMaxBytes: 64 * 1024 * 1024 * 1024,
            memoryMb: 512,
            cpus: 2,
        })).toThrow("hyper-v-memory-mb-invalid");
    });

    it("provisions a fenced cloud-init seed and owner-scoped SSH transport for Linux guests", () => {
        const linuxDeviceId = "linux-ci-01";
        const vmName = hyperVVmName(ownerId, linuxDeviceId, incarnationId);
        const deviceRoot = "/state/owners/0123456789abcdef/linux-vm/linux-ci-01";
        const privateRoot = "/private/owners/0123456789abcdef/linux-vm/linux-ci-01";
        const seedDiskPath = `${deviceRoot}/disks/cidata.iso`;
        const sshPrivateKeyPath = `${privateRoot}/secrets/id_ed25519`;
        const sshPublicKeyPath = `${sshPrivateKeyPath}.pub`;
        const sshHostPrivateKeyPath = `${privateRoot}/secrets/ssh_host_ed25519_key`;
        const sshHostPublicKeyPath = `${sshHostPrivateKeyPath}.pub`;
        const knownHostsPath = `${privateRoot}/secrets/known_hosts`;
        const seed = hyperVLinuxSeedCommand({
            executable: "powershell.exe",
            ownerId,
            deviceId: linuxDeviceId,
            incarnationId,
            vmName,
            vmId,
            deviceRoot,
            privateRoot,
            seedDiskPath,
            sshPrivateKeyPath,
            sshPublicKeyPath,
            sshHostPrivateKeyPath,
            sshHostPublicKeyPath,
            knownHostsPath,
            guestUsername: "ccc01234567",
            networkAddress: "172.29.0.10",
            networkGateway: "172.29.0.1",
            networkPrefixLength: 24,
        });
        const seedScript = scriptOf(seed);
        expect(seedScript).toContain("IMAPI2FS.MsftFileSystemImage");
        expect(seedScript).toContain("Write-CccIso $SeedSource $SeedDisk 'cidata'");
        expect(seedScript).toContain("network-config");
        expect(seedScript).toContain("ssh-keygen.exe");
        expect(seedScript).toContain("ssh_host_ed25519_key");
        expect(seedScript).toContain("ssh_deletekeys: true");
        expect(seedScript).toContain("sshHostKeyFingerprint");
        expect(seedScript).toContain("Add-VMDvdDrive -VM $Vm -Path $SeedDisk");
        expect(seedScript).not.toContain("Mount-VHD");
        expect(seedScript).not.toContain("Initialize-Disk");
        expect(seedScript).toContain("Get-VM -Id $ExpectedId");
        expect(seedScript).not.toContain("cloud-init status --wait");

        const ssh = { executable: "ssh.exe", deviceRoot, privateRoot, sshPrivateKeyPath, knownHostsPath, guestUsername: "ccc01234567", networkAddress: "172.29.0.10" };
        expect(hyperVLinuxSshReadyCommand(ssh)).toMatchObject({ provider: "hyper-v-ssh", executable: "ssh.exe" });
        expect(hyperVLinuxSshReadyCommand(ssh).args).toContain("StrictHostKeyChecking=yes");
        expect(hyperVLinuxSshExecCommand({ ...ssh, guestCommand: "uname -a" }).args.at(-1)).toContain("base64 -d | bash");
        expect(hyperVLinuxScpUploadCommand({ ...ssh, executable: "scp.exe", localPath: `${deviceRoot}/uploads/in.txt`, remotePath: "/tmp/in.txt" }).args.at(-1)).toBe("ccc01234567@172.29.0.10:/tmp/in.txt");
        expect(hyperVLinuxScpDownloadCommand({ ...ssh, executable: "scp.exe", remotePath: "/tmp/out.txt", localPath: `${deviceRoot}/downloads/out.txt` }).args.at(-2)).toBe("ccc01234567@172.29.0.10:/tmp/out.txt");
        expect(() => hyperVLinuxScpUploadCommand({ ...ssh, executable: "scp.exe", localPath: "relative.txt", remotePath: "/tmp/in.txt" })).toThrow("hyper-v-linux-upload-source-invalid");
        expect(() => hyperVLinuxScpUploadCommand({ ...ssh, executable: "scp.exe", localPath: `${deviceRoot}/uploads/in.txt`, remotePath: "/tmp/out;whoami" })).toThrow("hyper-v-linux-guest-path-invalid");

        const deleteScript = scriptOf(hyperVDeleteCommand({
            executable: "powershell.exe",
            ownerId,
            deviceId: linuxDeviceId,
            incarnationId,
            vmName,
            vmId,
            diskPath: `${deviceRoot}/disks/root.vhdx`,
            auxiliaryMediaPaths: [seedDiskPath],
        }));
        expect(deleteScript).toContain("$ExpectedDisks");
        expect(deleteScript).toContain("Compare-Object");
        expect(deleteScript).toContain(seedDiskPath);
        expect(deleteScript).toContain("Assert-NoReparsePath $OwnedPath");

        const recoverScript = scriptOf(hyperVRecoverOrphanCommand({
            executable: "powershell.exe",
            ownerId,
            deviceId: linuxDeviceId,
            incarnationId,
            vmName,
            deviceRoot,
            diskPath: `${deviceRoot}/disks/root.vhdx`,
            auxiliaryMediaPaths: [seedDiskPath],
        }));
        expect(recoverScript).toContain("$ExpectedPaths -notcontains $_");
        expect(recoverScript).not.toContain("$AttachedPaths.Count -ne $ExpectedPaths.Count");
        expect(recoverScript).toContain("if ([string]$Vm.Notes -and [string]$Vm.Notes -cne $ExpectedMarker)");
        expect(() => hyperVRecoverOrphanCommand({
            executable: "powershell.exe",
            ownerId,
            deviceId: linuxDeviceId,
            incarnationId,
            vmName: hyperVVmName(ownerId, linuxDeviceId, "2".repeat(32)),
            deviceRoot,
            diskPath: `${deviceRoot}/disks/root.vhdx`,
            auxiliaryMediaPaths: [seedDiskPath],
        })).toThrow("hyper-v-vm-name-not-owner-scoped");
    });

    it("ensures the CCC internal switch and NAT with conflict fencing", () => {
        const command = hyperVEnsureNetworkCommand({
            executable: "powershell.exe",
            switchName: "CCC Device Lab",
            natName: "CCCDeviceLab",
            marker: "ccc-device-lab:hyper-v-network:v1",
            expectedSwitchId: vmId,
            expectedNatInstanceId: "ccc-nat-instance-1",
            allowExistingNat: true,
            prefix: "172.29.0.0/24",
            gateway: "172.29.0.1",
            prefixLength: 24,
        });
        const script = scriptOf(command);
        expect(script).toContain("New-VMSwitch -Name $SwitchName -SwitchType Internal -Notes $Marker");
        expect(script).not.toContain("Set-VMSwitch -VMSwitch $Switch -Notes $Marker");
        expect(script).toContain("hyper-v-network-switch-ownership-conflict");
        expect(script).toContain("hyper-v-network-switch-type-conflict");
        expect(script).toContain("New-NetIPAddress");
        expect(script).toContain("hyper-v-network-gateway-conflict");
        expect(script).toContain("New-NetNat");
        expect(script).toContain("hyper-v-network-nat-prefix-conflict");
        expect(script).toContain("hyper-v-network-nat-ownership-conflict");
        expect(script).toContain("$AllowExistingNat = $true");
        expect(script).toContain(`$ExpectedSwitchId = '${vmId}'`);
        expect(script).toContain("Get-VMSwitch -Id ([Guid]$ExpectedSwitchId)");
        expect(script).toContain("hyper-v-network-switch-identity-conflict");
        expect(script).toContain("$ExpectedNatInstanceId = 'ccc-nat-instance-1'");
        expect(script).toContain("if ($CreatedNat)");
        expect(script).toContain("$CreatedNatInstanceId = [string]$Nat.InstanceID");
        expect(script).toContain("[string]$RollbackNats[0].InstanceID -cne $CreatedNatInstanceId");
        expect(script).toContain("hyper-v-network-nat-rollback-identity-conflict");
        expect(script).toContain("Remove-NetNat -InputObject $RollbackNats[0]");
        expect(script).toContain("if ($CreatedGateway -and $Adapter)");
        expect(script).toContain("if ($CreatedSwitch -and $Switch)");
        expect(script).toContain("hyper-v-network-subnet-conflict:nat");
        expect(script).toContain("hyper-v-network-subnet-conflict:interface");
        expect(script).toContain("$RequiresMutation = ($Switches.Count -eq 0) -or (-not $GatewayExists) -or ($Nats.Count -eq 0)");
        expect(script).toContain("hyper-v-network-elevation-required");
        expect(script).toContain("[uint32]([uint32]::MaxValue - [uint32]([Math]::Pow(2, 32 - $Length) - 1))");
        expect(script).not.toContain("[uint64]0xffffffff");
        expect(parseHyperVNetworkObservation(`noise\n${JSON.stringify({
            ok: true,
            switchName: "CCC Device Lab",
            switchId: vmId,
            natName: "CCCDeviceLab",
            marker: "ccc-device-lab:hyper-v-network:v1",
            natInstanceId: "ccc-nat-instance-1",
            prefix: "172.29.0.0/24",
            gateway: "172.29.0.1",
            interfaceIndex: 42,
            createdSwitch: true,
            createdNat: false,
        })}`)).toMatchObject({ switchName: "CCC Device Lab", interfaceIndex: 42 });
        expect(parseHyperVNetworkObservation('{"ok":true,"switchName":"CCC Device Lab"}')).toBeNull();

        const cleanup = hyperVCleanupNetworkCommand({
            executable: "powershell.exe",
            switchName: "CCC Device Lab",
            natName: "CCCDeviceLab",
            marker: "ccc-device-lab:hyper-v-network:v1",
            prefix: "172.29.0.0/24",
            gateway: "172.29.0.1",
            prefixLength: 24,
            removeNat: true,
            expectedSwitchId: vmId,
            expectedNatInstanceId: "ccc-nat-instance-1",
        });
        const cleanupScript = scriptOf(cleanup);
        expect(cleanupScript).toContain("$RemoveNat = $true");
        expect(cleanupScript).toContain(`$ExpectedSwitchId = '${vmId}'`);
        expect(cleanupScript).toContain("hyper-v-network-nat-identity-conflict");
        expect(cleanupScript).toContain("hyper-v-network-switch-ownership-conflict");
        expect(cleanupScript).toContain("hyper-v-network-switch-in-use");
        expect(cleanupScript).toContain("Remove-NetNat");
        expect(cleanupScript).toContain("Remove-VMSwitch");
        expect(cleanupScript).toContain("$RequiresMutation = ($Switches.Count -eq 1) -or ($Nats.Count -eq 1 -and $RemoveNat)");
        expect(cleanupScript).toContain("hyper-v-network-elevation-required");
        expect(parseHyperVNetworkCleanupObservation(JSON.stringify({ ok: true, removedSwitch: true, removedNat: true, removedGateway: true, alreadyMissing: false }))).toEqual(expect.objectContaining({ removedSwitch: true }));
        expect(parseHyperVNetworkCleanupObservation('{"ok":true,"removedSwitch":true}')).toBeNull();

        const preserveForeignNat = scriptOf(hyperVCleanupNetworkCommand({
            executable: "powershell.exe",
            switchName: "CCC Device Lab",
            natName: "CCCDeviceLab",
            marker: "ccc-device-lab:hyper-v-network:v1",
            prefix: "172.29.0.0/24",
            gateway: "172.29.0.1",
            prefixLength: 24,
        }));
        expect(preserveForeignNat).toContain("$RemoveNat = $false");
        expect(preserveForeignNat).toContain("$Nats.Count -eq 1 -and $RemoveNat");

        const elevatedCommand = hyperVEnsureNetworkCommand({
            executable: "powershell.exe",
            switchName: "CCC Device Lab",
            natName: "CCCDeviceLab",
            marker: "ccc-device-lab:hyper-v-network:v1",
            prefix: "172.29.0.0/24",
            gateway: "172.29.0.1",
            prefixLength: 24,
            elevated: true,
            elevatedDeadlineUnixMs: Date.now() + 180000,
        });
        const elevated = scriptOf(elevatedCommand);
        expect(elevatedCommand.input).toMatch(/^[A-Za-z0-9+/=]+$/);
        expect(elevatedCommand.args.join(" ").length).toBeLessThan(2048);
        expect(elevated).toContain("Start-Process -FilePath $Executable -Verb RunAs");
        expect(elevated).toContain("GetNamedPipeClientProcessId");
        expect(elevated).toContain("$ClientProcessId -ne [uint32]$Child.Id");
        expect(elevated).toContain("$ChildStartTicks = $Child.StartTime.ToUniversalTime().Ticks");
        expect(elevated).toContain("-not $OperationCompleted");
        expect(elevated).toContain("$ObservedChild.StartTime.ToUniversalTime().Ticks -eq $ChildStartTicks");
        expect(elevated).toContain("$Child.WaitForExit(5000)");
        expect(elevated).toContain("hyper-v-network-elevated-child-termination-unconfirmed");
        expect(elevated).toContain("S-1-5-32-544");
        expect(elevated).toContain("hyper-v-network-pipe-handshake-timeout");
        expect(elevated).toContain("hyper-v-network-elevation-cancelled");
        expect(elevated).toContain("hyper-v-network-elevation-failed:' + $ElevationHResult");
        const elevatedInnerEncoded = elevated.match(/\$InnerEncodedTemplate = '([^']+)'/)?.[1];
        expect(elevatedInnerEncoded).toBeTruthy();
        const elevatedInner = Buffer.from(elevatedInnerEncoded!, "base64").toString("utf16le");
        expect(elevatedInner).toContain("$TrustedModuleRoot = Join-Path $PSHOME 'Modules'");
        expect(elevatedInner).toContain("$env:PSModulePath = $TrustedModuleRoot");
        expect(elevatedInner).toContain("[IO.Pipes.PipeDirection]::InOut");
        expect(elevatedInner).toContain("$ProgramEncoded = $Reader.ReadLine()");
        expect(elevatedInner).toContain("hyper-v-network-program-invalid");
        expect(elevatedInner).not.toContain("New-NetIPAddress");
        expect(elevatedInnerEncoded!.length).toBeLessThan(24_000);
        expect(elevated).toContain("[IO.Pipes.PipeDirection]::InOut");
        expect(elevated).toContain("$Writer.WriteLine($ProgramEncoded)");
        expect(elevated).toContain("$Writer.Flush()");
        expect(elevated.indexOf("$ClientProcessId -ne [uint32]$Child.Id")).toBeLessThan(elevated.indexOf("$Writer.WriteLine($ProgramEncoded)"));
        expect(elevatedInner).toContain("$RemainingMs = $DeadlineUnixMs - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()");
        expect(elevatedInner).toContain("Start-Sleep -Milliseconds $WatchdogDelayMs");
        expect(elevatedInner).toContain("hyper-v-network-operation-deadline-exceeded");
        expect(elevatedInner).toContain("StartTime.ToUniversalTime().Ticks -eq $SelfStartTicks");
        expect(elevatedInner).toContain("$ObservedWatchdog.StartTime.ToUniversalTime().Ticks -eq $WatchdogStartTicks");
        expect(elevated).not.toContain("RedirectStandardOutput");
    });

    it.skipIf(process.platform !== "win32")("computes IPv4 prefix masks on Windows PowerShell 5.1 without signed overflow", () => {
        const result = spawnSync("powershell.exe", [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$Length = 24; $Mask = [uint32]([uint32]::MaxValue - [uint32]([Math]::Pow(2, 32 - $Length) - 1)); if ($Mask -ne [uint32]4294967040) { exit 1 }; Write-Output $Mask",
        ], {
            encoding: "utf8",
            windowsHide: true,
            timeout: 15_000,
        });

        expect(result.status, result.stderr || result.error?.message).toBe(0);
        expect(result.stdout.trim()).toBe("4294967040");
    });

    it("rejects paths outside the owner device root and unsafe identities", () => {
        const vmName = hyperVVmName(ownerId, deviceId, incarnationId);
        expect(() => hyperVCreateCommand({
            executable: "powershell.exe",
            ownerId,
            deviceId,
            incarnationId,
            vmName,
            baseImagePath: "/state/images/hyper-v/windows-11.vhdx",
            baseImageSha256,
            baseImageRoot: "/state/images/hyper-v",
            deviceRoot: "/state/owners/0123456789abcdef/windows-vm/windows-ci-01",
            diskPath: "/state/owners/other/root.vhdx",
            diskMaxBytes: 64 * 1024 * 1024 * 1024,
            memoryMb: 4096,
            cpus: 2,
        })).toThrow("hyper-v-disk-path-outside-owner-root");
        expect(() => hyperVCreateCommand({
            executable: "powershell.exe",
            ownerId,
            deviceId,
            incarnationId,
            vmName,
            baseImagePath: "/foreign/windows-11.vhdx",
            baseImageSha256,
            baseImageRoot: "/state/images/hyper-v",
            deviceRoot: "/state/owners/0123456789abcdef/windows-vm/windows-ci-01",
            diskPath: "/state/owners/0123456789abcdef/windows-vm/windows-ci-01/disks/root.vhdx",
            diskMaxBytes: 64 * 1024 * 1024 * 1024,
            memoryMb: 4096,
            cpus: 2,
        })).toThrow("hyper-v-base-image-path-outside-owner-root");
        expect(() => hyperVStatusCommand({ executable: "powershell.exe", ownerId, deviceId, incarnationId, vmName: "foreign-vm", vmId })).toThrow("hyper-v-vm-name-not-owner-scoped");
        expect(() => hyperVVmName(ownerId, "../escape", incarnationId)).toThrow("hyper-v-device-id-invalid");
    });

    it("fences lifecycle commands by VM ID, owner marker, name, and disk", () => {
        const vmName = hyperVVmName(ownerId, deviceId, incarnationId);
        const options = { executable: "powershell.exe", ownerId, deviceId, incarnationId, vmName, vmId };
        for (const command of [hyperVStatusCommand(options), hyperVStartCommand({ ...options, memoryMb: 4096, cpus: 2 }), hyperVStopCommand(options), hyperVRebootCommand({ ...options, force: true })]) {
            const script = scriptOf(command);
            expect(script).toContain("Get-VM -Id $ExpectedId");
            expect(script).toContain("hyper-v-vm-ownership-mismatch");
            expect(script).toContain(`ccc-device-lab:${ownerId}:${deviceId}:${incarnationId}`);
        }
        const startScript = scriptOf(hyperVStartCommand({ ...options, memoryMb: 4096, cpus: 2 }));
        expect(startScript).toContain("FreePhysicalMemory");
        expect(startScript).toContain("hyper-v-host-memory-capacity-exceeded");
        expect(startScript).toContain("hyper-v-host-cpu-capacity-exceeded");
        const rebootScript = scriptOf(hyperVRebootCommand({ ...options, force: true, startIfStopped: true }));
        expect(rebootScript).toContain("Restart-VM -VM $Vm -Force:$Force -Confirm:$false");
        expect(rebootScript).toContain("hyper-v-reboot-requires-running-vm");
        expect(rebootScript).toContain("Start-VM -VM $Vm");
        const deleteScript = scriptOf(hyperVDeleteCommand({
            ...options,
            diskPath: "/state/root.vhdx",
            auxiliaryMediaPaths: ["/state/autounattend.iso"],
        }));
        expect(deleteScript).toContain("hyper-v-vm-disk-ownership-mismatch");
        expect(deleteScript).toContain("hyper-v-vm-media-ownership-mismatch");
        expect(deleteScript).toContain("$ExpectedMedia = @('/state/autounattend.iso')");
        expect(deleteScript).toContain("alreadyMissing = $true");
        expect(deleteScript).toContain("hyper-v-vm-identity-conflict");
        expect(deleteScript).toContain("Remove-VM -VM $Vm -Force");
    });

    it("requires an exact VM incarnation marker and rejects stale generation scripts", () => {
        const vmName = hyperVVmName(ownerId, deviceId, incarnationId);
        const staleIncarnationId = "22222222222222222222222222222222";
        const currentMarker = `ccc-device-lab:${ownerId}:${deviceId}:${incarnationId}`;
        const staleMarker = `ccc-device-lab:${ownerId}:${deviceId}:${staleIncarnationId}`;
        const currentScript = scriptOf(hyperVStatusCommand({ executable: "powershell.exe", ownerId, deviceId, incarnationId, vmName, vmId }));
        const staleVmName = hyperVVmName(ownerId, deviceId, staleIncarnationId);
        const staleScript = scriptOf(hyperVStatusCommand({ executable: "powershell.exe", ownerId, deviceId, incarnationId: staleIncarnationId, vmName: staleVmName, vmId }));

        expect(currentScript).toContain(`$ExpectedMarker = '${currentMarker}'`);
        expect(staleScript).toContain(`$ExpectedMarker = '${staleMarker}'`);
        expect(currentScript).not.toContain(staleMarker);
        expect(staleScript).not.toContain(currentMarker);
        for (const script of [currentScript, staleScript]) {
            expect(script).toContain("[string]$Vm.Notes -cne $ExpectedMarker");
            expect(script).not.toContain("$Vm.Notes -notlike");
        }

        const recoveryScript = scriptOf(hyperVRecoverOrphanCommand({
            executable: "powershell.exe",
            ownerId,
            deviceId,
            incarnationId,
            vmName,
            deviceRoot: "/state/owners/0123456789abcdef/windows-vm/windows-ci-01",
            diskPath: "/state/owners/0123456789abcdef/windows-vm/windows-ci-01/disks/root.vhdx",
        }));
        expect(recoveryScript).toContain("[string]$Vm.Notes -cne $ExpectedMarker");
        expect(recoveryScript).not.toContain("$Vm.Notes -notlike");

        expect(() => hyperVStatusCommand({ executable: "powershell.exe", ownerId, deviceId, incarnationId: "", vmName, vmId }))
            .toThrow("hyper-v-incarnation-id-invalid");
        expect(() => hyperVStatusCommand({ executable: "powershell.exe", ownerId, deviceId, incarnationId: `A${incarnationId.slice(1)}`, vmName, vmId }))
            .toThrow("hyper-v-incarnation-id-invalid");
    });

    it("recovers only owner-marked orphan VMs and fenced disks", () => {
        const vmName = hyperVVmName(ownerId, deviceId, incarnationId);
        const command = hyperVRecoverOrphanCommand({
            executable: "powershell.exe",
            ownerId,
            deviceId,
            incarnationId,
            vmName,
            deviceRoot: "/state/owners/0123456789abcdef/windows-vm/windows-ci-01",
            diskPath: "/state/owners/0123456789abcdef/windows-vm/windows-ci-01/disks/root.vhdx",
            auxiliaryMediaPaths: ["/state/owners/0123456789abcdef/windows-vm/windows-ci-01/disks/autounattend.iso"],
        });
        const script = scriptOf(command);
        expect(script).toContain("hyper-v-orphan-vm-ownership-mismatch");
        expect(script).toContain("hyper-v-orphan-vm-disk-mismatch");
        expect(script).toContain("hyper-v-orphan-vm-unmarked-disk-mismatch");
        expect(script).toContain("hyper-v-orphan-vm-media-mismatch");
        expect(script).toContain("$AttachedPaths.Count -ne 1");
        expect(script).toContain("$AttachedPaths[0] -cne [IO.Path]::GetFullPath($DiskPath)");
        expect(script).toContain("[IO.FileAttributes]::ReparsePoint");
        expect(parseHyperVRecoveryObservation('noise\n{"ok":true,"recoveredVm":true,"removedDisk":true}')).toEqual({ ok: true, recoveredVm: true, removedDisk: true });
        expect(parseHyperVRecoveryObservation('{"ok":true,"recoveredVm":true}')).toBeNull();
        expect(() => hyperVRecoverOrphanCommand({
            executable: "powershell.exe",
            ownerId,
            deviceId,
            incarnationId,
            vmName,
            deviceRoot: "/state/owners/0123456789abcdef/windows-vm/windows-ci-01",
            diskPath: "/state/owners/0123456789abcdef/windows-vm/windows-ci-01/disks/root.vhdx",
            auxiliaryMediaPaths: ["/state/owners/foreign/autounattend.iso"],
        })).toThrow("hyper-v-auxiliary-media-path-outside-owner-root");
    });

    it("uses owner-scoped production checkpoints and exact snapshot identity fencing", () => {
        const vmName = hyperVVmName(ownerId, deviceId, incarnationId);
        const snapshotId = "87654321-4321-4321-4321-cba987654321";
        const snapshotName = "before-install";
        const options = { executable: "powershell.exe", ownerId, deviceId, incarnationId, vmName, vmId, snapshotName };
        const createScript = scriptOf(hyperVSnapshotCreateCommand(options));
        expect(hyperVSnapshotName(ownerId, snapshotName)).toBe(`ccc-${ownerId}-${snapshotName}`);
        expect(createScript).toContain("Checkpoint-VM -VM $Vm");
        expect(createScript).toContain(`ccc-${ownerId}-${snapshotName}`);
        for (const command of [
            hyperVSnapshotRestoreCommand({ ...options, snapshotId }),
            hyperVSnapshotDeleteCommand({ ...options, snapshotId }),
        ]) {
            const script = scriptOf(command);
            expect(script).toContain("Get-VM -Id $ExpectedId");
            expect(script).toContain("$_.Id -eq $ExpectedSnapshotId");
            expect(script).toContain("hyper-v-snapshot-ownership-mismatch");
        }
        expect(() => hyperVSnapshotName(ownerId, "../foreign")).toThrow("hyper-v-snapshot-name-invalid");
        expect(parseHyperVSnapshotObservation(JSON.stringify({ ok: true, snapshotId, snapshotName: hyperVSnapshotName(ownerId, snapshotName), snapshotType: "Recovery" })))
            .toMatchObject({ ok: true, snapshotId, snapshotType: "Recovery" });
    });

    it("uses owner-fenced PowerShell Direct sessions for guest exec and transfer", () => {
        const vmName = hyperVVmName(ownerId, deviceId, incarnationId);
        const deviceRoot = "/state/owners/0123456789abcdef/windows-vm/windows-ci-01";
        const credentialPath = `${deviceRoot}/secrets/guest.credential.xml`;
        const base = { executable: "powershell.exe", ownerId, deviceId, incarnationId, vmName, vmId, deviceRoot, credentialPath };
        const execScript = scriptOf(hyperVGuestExecCommand({ ...base, guestCommand: "Write-Output ok" }));
        expect(execScript).toContain("Get-VM -Id $ExpectedId");
        expect(execScript).toContain("Import-Clixml -LiteralPath $CredentialPath");
        expect(execScript).toContain("New-PSSession -VMId $ExpectedId -Credential $Credential");
        expect(execScript).not.toContain("Write-Output ok");
        expect(execScript).toContain("Start-Process -FilePath 'powershell.exe'");

        const uploadScript = scriptOf(hyperVGuestUploadCommand({ ...base, localPath: "/project/in.txt", remotePath: "C:\\ccc\\in.txt" }));
        const downloadScript = scriptOf(hyperVGuestDownloadCommand({ ...base, localPath: "/project/out.txt", remotePath: "C:\\ccc\\out.txt" }));
        expect(uploadScript).toContain("-ToSession $Session");
        expect(downloadScript).not.toContain("-FromSession $Session");
        expect(downloadScript).toContain("[IO.File]::Open($Path");
        expect(downloadScript).toContain("[IO.FileShare]::Read");
        expect(downloadScript).toContain("if ($Stream.Length -gt $Limit)");
        expect(downloadScript).toContain("if ($Stream.ReadByte() -ge 0)");
        expect(downloadScript).toContain("[Convert]::FromBase64String");
        expect(() => hyperVGuestUploadCommand({ ...base, localPath: "/project/in.txt", remotePath: "..\\escape" })).toThrow("hyper-v-guest-path-invalid");
        expect(() => hyperVGuestExecCommand({ ...base, credentialPath: "/foreign/guest.xml", guestCommand: "whoami" })).toThrow("hyper-v-guest-credential-path-outside-owner-root");

        expect(parseHyperVGuestExecObservation(JSON.stringify({ ok: true, status: 0, stdout: "ok\r\n", stderr: "" })))
            .toEqual({ ok: true, status: 0, stdout: "ok\r\n", stderr: "" });
        expect(parseHyperVGuestTransferObservation(JSON.stringify({ ok: true, localPath: "/project/in.txt", remotePath: "C:\\ccc\\in.txt", bytes: 7 })))
            .toEqual({ ok: true, localPath: "/project/in.txt", remotePath: "C:\\ccc\\in.txt", bytes: 7 });
    });

    it("waits for an owner-fenced PowerShell Direct guest session", () => {
        const vmName = hyperVVmName(ownerId, deviceId, incarnationId);
        const deviceRoot = "/state/owners/0123456789abcdef/windows-vm/windows-ci-01";
        const credentialPath = `${deviceRoot}/secrets/guest.credential.xml`;
        const provisioningMediaPath = `${deviceRoot}/disks/autounattend.iso`;
        const command = hyperVGuestReadyCommand({
            executable: "powershell.exe",
            ownerId,
            deviceId,
            incarnationId,
            vmName,
            vmId,
            deviceRoot,
            credentialPath,
            provisioningMediaPath,
            timeoutMs: 300000,
        });
        const script = scriptOf(command);
        expect(script).toContain("[DateTime]::UtcNow.AddMilliseconds(300000)");
        expect(script).toContain("New-PSSession -VMId $ExpectedId -Credential $Credential");
        expect(script).toContain("Invoke-Command -Session $Session");
        expect(script).toContain("Remove-VMDvdDrive -VMDvdDrive $ProvisioningDrives[0]");
        expect(script).toContain("Remove-Item -LiteralPath $ProvisioningMedia");
        expect(script).toContain("hyper-v-guest-ready-timeout");
        expect(script).toContain("hyper-v-vm-ownership-mismatch");
        expect(parseHyperVGuestReadyObservation(JSON.stringify({ ok: true, vmId: vmId.toUpperCase(), vmName, computerName: "CCC-WIN", attempts: 4 })))
            .toEqual({ ok: true, vmId, vmName, computerName: "CCC-WIN", attempts: 4 });
        expect(parseHyperVGuestReadyObservation(JSON.stringify({ ok: true, vmId, vmName, computerName: "", attempts: 0 }))).toBeNull();
        expect(() => hyperVGuestReadyCommand({
            executable: "powershell.exe",
            ownerId,
            deviceId,
            incarnationId,
            vmName,
            vmId,
            deviceRoot,
            credentialPath,
            provisioningMediaPath: "/state/owners/foreign/autounattend.iso",
            timeoutMs: 300000,
        })).toThrow("hyper-v-guest-provisioning-media-path-outside-owner-root");
    });

    it("provisions a per-device Windows guest account without putting its password on the command line", () => {
        const vmName = hyperVVmName(ownerId, deviceId, incarnationId);
        const deviceRoot = "/state/owners/0123456789abcdef/windows-vm/windows-ci-01";
        const credentialPath = `${deviceRoot}/secrets/guest.credential.xml`;
        const provisioningMediaPath = `${deviceRoot}/disks/autounattend.iso`;
        const guestPassword = "Ccc!7this-is-a-long-disposable-password";
        const command = hyperVGuestProvisionCommand({
            executable: "powershell.exe",
            ownerId,
            deviceId,
            incarnationId,
            vmName,
            vmId,
            diskPath: `${deviceRoot}/disks/root.vhdx`,
            deviceRoot,
            credentialPath,
            provisioningMediaPath,
            guestUsername: "ccc01234567",
            guestPassword,
        });
        const script = scriptOf(command);
        expect(script).toContain("IMAPI2FS.MsftFileSystemImage");
        expect(script).toContain("Write-CccIso $ProvisioningSource $ProvisioningMedia 'CCC_UNATTEND'");
        expect(script).toContain("Add-VMDvdDrive -VM $Vm -Path $ProvisioningMedia");
        expect(script).not.toContain("Mount-VHD");
        expect(script).toContain("Microsoft-Windows-Shell-Setup");
        expect(script).toContain("Export-Clixml -LiteralPath $CredentialPath");
        expect(script).toContain("Remove CCC bootstrap secrets");
        expect(script).not.toContain(guestPassword);
        expect(command.args.join(" ")).not.toContain(guestPassword);
        const payloadBase64 = script.match(/\$CccCommandInputBase64 = '([A-Za-z0-9+/=]+)'/)?.[1];
        expect(payloadBase64).toBeTruthy();
        expect(JSON.parse(Buffer.from(payloadBase64!, "base64").toString("utf8")))
            .toEqual({ username: "ccc01234567", password: guestPassword });
        expect(parseHyperVGuestProvisionObservation(JSON.stringify({ ok: true, vmId, vmName, guestUsername: "ccc01234567", credentialPath, unattendPath: provisioningMediaPath })))
            .toEqual({ ok: true, vmId, vmName, guestUsername: "ccc01234567", credentialPath, unattendPath: provisioningMediaPath });
        expect(() => hyperVGuestProvisionCommand({
            executable: "powershell.exe",
            ownerId,
            deviceId,
            incarnationId,
            vmName,
            vmId,
            diskPath: `${deviceRoot}/disks/root.vhdx`,
            deviceRoot,
            credentialPath,
            provisioningMediaPath: "/state/owners/foreign/autounattend.iso",
            guestUsername: "ccc01234567",
            guestPassword,
        })).toThrow("hyper-v-guest-provisioning-media-path-outside-owner-root");
    });

    it("frames credentials inside streamed PowerShell when the provisioning script is too long to encode", () => {
        const vmName = hyperVVmName(ownerId, deviceId, incarnationId);
        const longTail = Array.from({ length: 320 }, (_, index) => `segment-${index}`).join("/");
        const deviceRoot = `/state/owners/${ownerId}/windows-vm/${deviceId}/${longTail}`;
        const credentialRoot = `/private/owners/${ownerId}/windows-vm/${deviceId}/${longTail}`;
        const guestPassword = "Ccc!7streamed-disposable-password";
        const command = hyperVGuestProvisionCommand({
            executable: "powershell.exe",
            ownerId,
            deviceId,
            incarnationId,
            vmName,
            vmId,
            diskPath: `${deviceRoot}/disks/root.vhdx`,
            deviceRoot,
            privateRoot: credentialRoot,
            credentialPath: `${credentialRoot}/secrets/guest.credential.xml`,
            provisioningMediaPath: `${deviceRoot}/disks/autounattend.iso`,
            guestUsername: "ccc01234567",
            guestPassword,
        });
        expect(command.args).toContain("-EncodedCommand");
        expect(command.args).not.toContain("-");
        expect(command.args.join(" ")).not.toContain(guestPassword);
        expect(command.input).not.toContain(guestPassword);
        const streamedScript = scriptOf(command);
        expect(streamedScript).toContain("$RawInput = $CccCommandInput");
        const payloadBase64 = streamedScript.match(/\$CccCommandInputBase64 = '([A-Za-z0-9+/=]+)'/)?.[1];
        expect(payloadBase64).toBeTruthy();
        expect(JSON.parse(Buffer.from(payloadBase64!, "base64").toString("utf8"))).toEqual({ username: "ccc01234567", password: guestPassword });
    });

    it("parses bounded readiness and VM observations from the final JSON line", () => {
        const readinessScript = scriptOf(hyperVReadinessCommand("powershell.exe"));
        expect(readinessScript).toContain("Get-Service -Name vmms");
        expect(readinessScript).toContain("Get-VM -ErrorAction Stop");
        expect(readinessScript).toContain("hyper-v-management-permission");
        expect(parseHyperVReadiness(`noise\n${JSON.stringify({ ok: true, available: true, platform: "win32", moduleAvailable: true, hypervisorPresent: true, vmmsRunning: true, rebootPending: false, totalMemoryMb: 65536, freeMemoryMb: 32768, logicalProcessors: 16, missing: [] })}\n`))
            .toEqual({ ok: true, available: true, platform: "win32", moduleAvailable: true, hypervisorPresent: true, vmmsRunning: true, rebootPending: false, totalMemoryMb: 65536, freeMemoryMb: 32768, logicalProcessors: 16, missing: [] });
        expect(parseHyperVReadiness(JSON.stringify({ ok: true, available: true, missing: [] }))).toBeNull();
        expect(parseHyperVVmObservation(JSON.stringify({ ok: true, vmId: vmId.toUpperCase(), vmName: hyperVVmName(ownerId, deviceId, incarnationId), state: "Running", status: "Operating normally", uptimeMs: 42 })))
            .toMatchObject({ ok: true, vmId, state: "Running", uptimeMs: 42 });
        expect(parseHyperVVmObservation('{"ok":true,"vmId":"not-a-guid","vmName":"x"}')).toBeNull();
        expect(parseHyperVDeleteObservation(JSON.stringify({ ok: true, vmId, vmName: hyperVVmName(ownerId, deviceId, incarnationId), deleted: true, diskPath: "/state/root.vhdx" })))
            .toMatchObject({ ok: true, vmId, deleted: true, diskPath: "/state/root.vhdx" });
        expect(parseHyperVDeleteObservation(JSON.stringify({ ok: true, vmId, vmName: hyperVVmName(ownerId, deviceId, incarnationId), deleted: false }))).toBeNull();
        expect(parseHyperVDeleteObservation(JSON.stringify({ ok: true, vmId, vmName: hyperVVmName(ownerId, deviceId, incarnationId) }))).toBeNull();
        expect(parseHyperVSnapshotDeleteObservation(JSON.stringify({ ok: true, snapshotId: vmId, snapshotName: "ccc-owner-baseline", deleted: true })))
            .toMatchObject({ ok: true, snapshotId: vmId, snapshotName: "ccc-owner-baseline", deleted: true });
        expect(parseHyperVSnapshotDeleteObservation(JSON.stringify({ ok: true, snapshotId: vmId, snapshotName: "ccc-owner-baseline", deleted: false }))).toBeNull();
        expect(parseHyperVSnapshotDeleteObservation(JSON.stringify({ ok: true, snapshotId: vmId, snapshotName: "ccc-owner-baseline" }))).toBeNull();
    });
});
