import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
    hyperVAcquireBaseImageCommand,
    hyperVBootstrapNetworkCleanupCommand,
    hyperVBootstrapNetworkCommand,
    hyperVCleanupNetworkCommand,
    hyperVCreateCommand,
    hyperVDeleteCommand,
    hyperVEnsureNetworkCommand,
    hyperVGuestBootDiagnosticCommand,
    hyperVGuestDownloadCommand,
    hyperVGuestExecCommand,
    hyperVGuestProvisionCommand,
    hyperVGuestReadyCommand,
    hyperVGuestUploadCommand,
    hyperVLinuxScpDownloadCommand,
    hyperVLinuxScpUploadCommand,
    hyperVLinuxNetworkFinalizeCommand,
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
    parseHyperVBootstrapNetworkCleanupObservation,
    parseHyperVBootstrapNetworkObservation,
    parseHyperVDeleteObservation,
    parseHyperVGuestExecObservation,
    parseHyperVGuestBootDiagnosticObservation,
    parseHyperVGuestProvisionObservation,
    parseHyperVGuestReadyFailureObservation,
    parseHyperVGuestReadyObservation,
    parseHyperVGuestTransferObservation,
    parseHyperVNetworkObservation,
    parseHyperVNetworkCleanupObservation,
    parseHyperVSnapshotObservation,
    parseHyperVSnapshotDeleteObservation,
    parseHyperVSetupObservation,
    parseHyperVVmObservation,
} from "../host-control/hyper-v/index.js";
import { hyperVProviderDiagnosticCode } from "../device-lab/broker/hyper-v/public-response.js";

const ownerId = "0123456789abcdef";
const deviceId = "windows-ci-01";
const incarnationId = "11111111111111111111111111111111";
const vmId = "12345678-1234-1234-1234-123456789abc";
const baseImageSha256 = "a".repeat(64);

function scriptOf(command: { args: string[]; input?: string }): string {
    const fileIndex = command.args.indexOf("-File");
    if (fileIndex >= 0) {
        const file = command.args[fileIndex + 1];
        if (!file) throw new Error("missing PowerShell file path");
        return readFileSync(file, "utf8");
    }
    const encoded = command.args.at(-1);
    if (!encoded) throw new Error("missing encoded PowerShell script");
    const decoded = Buffer.from(encoded, "base64").toString("utf16le");
    if (decoded.includes("$E=[Console]::In.ReadToEnd().Trim()")) {
        if (!command.input) throw new Error("missing streamed PowerShell program");
        return Buffer.from(command.input, "base64").toString("utf8");
    }
    return decoded;
}

function loaderOf(command: { args: string[] }): string {
    const encoded = command.args.at(-1);
    if (!encoded) throw new Error("missing encoded PowerShell loader");
    return Buffer.from(encoded, "base64").toString("utf16le");
}

describe("Hyper-V provider adapter", () => {
    it.skipIf(process.platform !== "win32")("creates provisioning ISO media from a fenced file tree", () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-hyper-v-media-probe-"));
        try {
            const generated = scriptOf(hyperVGuestProvisionCommand({
                executable: "powershell.exe",
                ownerId,
                deviceId,
                incarnationId,
                vmName: hyperVVmName(ownerId, deviceId, incarnationId),
                vmId,
                diskPath: join(root, "root.vhdx"),
                deviceRoot: root,
                credentialPath: join(root, "guest.credential.xml"),
                provisioningMediaPath: join(root, "autounattend.iso"),
                guestUsername: "ccc01234567",
                guestPassword: "Ccc!7this-is-a-long-disposable-password",
            }));
            const assertStart = generated.indexOf("function Assert-NoReparsePath");
            const assertEnd = generated.indexOf("\n$Vm =", assertStart);
            const typeStart = generated.indexOf("if (-not ('CccIsoStreamWriter' -as [type]))");
            const typeMarker = "'@ -Language CSharp -ErrorAction Stop\n}";
            const typeEnd = generated.indexOf(typeMarker, typeStart) + typeMarker.length;
            const writerStart = generated.indexOf("function Remove-CccIsoSourceRoot");
            const writerEnd = generated.indexOf("\n  Write-CccIso $IsoFiles", writerStart);
            expect({ assertStart, assertEnd, typeStart, typeEnd, writerStart, writerEnd }).toEqual(expect.objectContaining({
                assertStart: expect.any(Number),
                assertEnd: expect.any(Number),
                typeStart: expect.any(Number),
                typeEnd: expect.any(Number),
                writerStart: expect.any(Number),
                writerEnd: expect.any(Number),
            }));
            expect(Math.min(assertStart, assertEnd, typeStart, typeEnd, writerStart, writerEnd)).toBeGreaterThanOrEqual(0);
            const isoPath = join(root, "probe.iso").replace(/'/g, "''");
            const sourceRoot = join(root, "private", "probe.source").replace(/'/g, "''");
            const probeScript = [
                "$ErrorActionPreference = 'Stop'",
                generated.slice(assertStart, assertEnd),
                generated.slice(typeStart, typeEnd),
                generated.slice(writerStart, writerEnd),
                `$IsoPath = '${isoPath}'`,
                `$SourceRoot = '${sourceRoot}'`,
                "$IsoFiles = [ordered]@{ 'probe.txt' = [Text.Encoding]::UTF8.GetBytes('ccc-hyper-v-media-probe') }",
                "try {",
                "  Write-CccIso $IsoFiles $IsoPath 'CCC_PROBE' $SourceRoot",
                "  $IsoItem = Get-Item -LiteralPath $IsoPath -Force -ErrorAction Stop",
                "  $IsoText = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($IsoPath))",
                "  if ($IsoText.IndexOf('probe.txt', [StringComparison]::OrdinalIgnoreCase) -lt 0) { throw 'hyper-v-provisioning-media-probe-name-missing' }",
                "  if ($IsoText.IndexOf('ccc-hyper-v-media-probe', [StringComparison]::Ordinal) -lt 0) { throw 'hyper-v-provisioning-media-probe-content-missing' }",
                "  if (Test-Path -LiteralPath $SourceRoot) { throw 'hyper-v-provisioning-media-probe-source-residue' }",
                "  [ordered]@{ ok = $true; contentVerified = $true; length = [long]$IsoItem.Length } | ConvertTo-Json -Compress",
                "} finally {",
                "  Remove-Item -LiteralPath $IsoPath -Force -ErrorAction SilentlyContinue",
                "}",
            ].join("\n");
            const result = spawnSync("powershell.exe", [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-EncodedCommand",
                Buffer.from(probeScript, "utf16le").toString("base64"),
            ], {
                encoding: "utf8",
                timeout: 30_000,
                maxBuffer: 1024 * 1024,
                windowsHide: true,
            });
            expect(result.status, result.stderr || result.error?.message).toBe(0);
            expect(result.stdout).toContain('"ok":true');
            expect(result.stdout).toContain('"contentVerified":true');
            expect(result.stdout).toMatch(/"length":\d+/);

            const cleanupIsoPath = join(root, "cleanup-failure.iso").replace(/'/g, "''");
            const cleanupSourceRoot = join(root, "private", "cleanup-failure.source").replace(/'/g, "''");
            const primaryIsoPath = join(root, "primary-failure.iso").replace(/'/g, "''");
            const primarySourceRoot = join(root, "private", "primary-failure.source").replace(/'/g, "''");
            const cleanupFailureScript = [
                "$ErrorActionPreference = 'Stop'",
                generated.slice(assertStart, assertEnd),
                generated.slice(typeStart, typeEnd),
                generated.slice(writerStart, writerEnd),
                "$OriginalRemoveCccIsoSourceRoot = ${function:Remove-CccIsoSourceRoot}",
                "function Invoke-CccCleanupFailureCase([string]$IsoPath, [string]$SourceRoot, [Collections.IDictionary]$IsoFiles, [string]$ExpectedFailure) {",
                "  $script:CccCleanupCalls = 0",
                "  function Remove-CccIsoSourceRoot([string]$Candidate) {",
                "    $script:CccCleanupCalls++",
                "    if ($script:CccCleanupCalls -gt 1) { throw 'injected-cleanup-failure' }",
                "    & $OriginalRemoveCccIsoSourceRoot $Candidate",
                "  }",
                "  try {",
                "    Write-CccIso $IsoFiles $IsoPath 'CCC_PROBE' $SourceRoot",
                "    throw 'expected-write-ccc-iso-failure'",
                "  } catch {",
                "    if ([string]$_.Exception.Message -ne $ExpectedFailure) { throw }",
                "    [Console]::Out.WriteLine($ExpectedFailure)",
                "  } finally {",
                "    & $OriginalRemoveCccIsoSourceRoot $SourceRoot",
                "    Remove-Item -LiteralPath $IsoPath -Force -ErrorAction SilentlyContinue",
                "  }",
                "}",
                `$CleanupIsoPath = '${cleanupIsoPath}'`,
                `$CleanupSourceRoot = '${cleanupSourceRoot}'`,
                "$ValidFiles = [ordered]@{ 'probe.txt' = [Text.Encoding]::UTF8.GetBytes('cleanup-failure') }",
                "Invoke-CccCleanupFailureCase $CleanupIsoPath $CleanupSourceRoot $ValidFiles 'hyper-v-provisioning-media-source-cleanup-failed'",
                `$PrimaryIsoPath = '${primaryIsoPath}'`,
                `$PrimarySourceRoot = '${primarySourceRoot}'`,
                "$InvalidFiles = [ordered]@{ '../bad' = [Text.Encoding]::UTF8.GetBytes('primary-failure') }",
                "Invoke-CccCleanupFailureCase $PrimaryIsoPath $PrimarySourceRoot $InvalidFiles 'hyper-v-provisioning-media-source-entry-invalid'",
            ].join("\n");
            const cleanupFailureResult = spawnSync("powershell.exe", [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-EncodedCommand",
                Buffer.from(cleanupFailureScript, "utf16le").toString("base64"),
            ], {
                encoding: "utf8",
                timeout: 30_000,
                maxBuffer: 1024 * 1024,
                windowsHide: true,
            });
            expect(cleanupFailureResult.status, cleanupFailureResult.stderr || cleanupFailureResult.error?.message).toBe(0);
            expect(cleanupFailureResult.stdout).toContain("hyper-v-provisioning-media-source-cleanup-failed");
            expect(cleanupFailureResult.stdout).toContain("hyper-v-provisioning-media-source-entry-invalid");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("streams the standard Ubuntu acquisition program over stdin instead of the Windows command line", () => {
        const acquire = hyperVAcquireBaseImageCommand({
            executable: "powershell.exe",
            profile: "ubuntu-lts",
            imageRoot: "/cache",
            expectedGeneration: 2,
        });

        expect(acquire.args).toContain("-EncodedCommand");
        expect(acquire.args).not.toContain("-");
        const loader = Buffer.from(acquire.args.at(-1)!, "base64").toString("utf16le");
        expect(loader).toContain("$E=[Console]::In.ReadToEnd().Trim()");
        expect(loader).toContain("[ScriptBlock]::Create($P)");
        expect(loader).toContain("$env:CCC_HYPER_V_STAGE=$null");
        expect(loader).toContain("$S=$env:CCC_HYPER_V_STAGE");
        expect(acquire.input).toMatch(/^[A-Za-z0-9+/=]+$/);
        const acquireScript = scriptOf(acquire);
        expect(acquireScript).toContain("Save-BoundedDownload");
        expect(acquireScript).toContain("CCC_HYPER_V_RESULT_B64:");
        expect(acquireScript).toContain("function Set-CccAcquireStage");
        expect(acquireScript).toContain("$env:CCC_HYPER_V_STAGE = $script:CccAcquireStage");
        expect(acquireScript).toContain("$env:CCC_HYPER_V_STAGE = $Stage");
        expect(acquireScript).toContain("throw $script:CccAcquireStage");
        expect(acquireScript.indexOf("try {"))
            .toBeLessThan(acquireScript.indexOf("Import-Module Hyper-V -ErrorAction Stop"));
        const acquireStages = [
            "Set-CccAcquireStage 'hyper-v-base-image-download-failed'",
            "Set-CccAcquireStage 'hyper-v-base-image-hash-failed'",
            "Set-CccAcquireStage 'hyper-v-base-image-archive-check-failed'",
            "Set-CccAcquireStage 'hyper-v-base-image-extract-failed'",
            "Set-CccAcquireStage 'hyper-v-base-image-normalize-failed'",
            "Set-CccAcquireStage 'hyper-v-base-image-source-open-failed'",
            "Set-CccAcquireStage 'hyper-v-base-image-source-hash-failed'",
            "Set-CccAcquireStage 'hyper-v-base-image-source-inspection-failed'",
            "Set-CccAcquireStage 'hyper-v-base-image-copy-failed'",
            "Set-CccAcquireStage 'hyper-v-base-image-partial-open-failed'",
            "Set-CccAcquireStage 'hyper-v-base-image-partial-hash-failed'",
            "Set-CccAcquireStage 'hyper-v-base-image-partial-inspection-failed'",
            "Set-CccAcquireStage 'hyper-v-base-image-final-move-failed'",
            "Set-CccAcquireStage 'hyper-v-base-image-final-inspection-failed'",
            "Set-CccAcquireStage 'hyper-v-base-image-final-observation-failed'",
        ];
        for (let index = 1; index < acquireStages.length; index++) {
            expect(acquireScript.indexOf(acquireStages[index - 1]))
                .toBeLessThan(acquireScript.indexOf(acquireStages[index]));
        }
        expect(acquire.args.join(" ").length).toBeLessThan(2048);
        expect(acquireScript).toContain("ubuntu-noble-hyperv-amd64-ubuntu-desktop-hyperv.vhdx.zip");
    });

    it.skipIf(process.platform !== "win32")("classifies bounded-loader validation, parse, and execution failures on Windows PowerShell 5.1", () => {
        const acquire = hyperVAcquireBaseImageCommand({
            executable: "powershell.exe",
            profile: "ubuntu-lts",
            imageRoot: "C:\\ccc-loader-probe",
            expectedGeneration: 2,
        });
        const run = (input: string) => spawnSync(acquire.executable, acquire.args, {
            input,
            encoding: "utf8",
            windowsHide: true,
            timeout: 15_000,
        });
        const encoded = (program: string) => Buffer.from(program, "utf8").toString("base64");

        const success = run(encoded("Write-Output 'ccc-hyper-v-loader-ok'"));
        expect(success.status, success.stderr || success.error?.message).toBe(0);
        expect(success.stdout).toContain("ccc-hyper-v-loader-ok");

        const invalid = run("not-base64!");
        expect(invalid.status).toBe(1);
        expect(invalid.stderr).toContain("hyper-v-powershell-program-invalid");

        const parseFailure = run(encoded("if ("));
        expect(parseFailure.status).toBe(1);
        expect(parseFailure.stderr).toContain("hyper-v-powershell-parse-failed");

        const knownFailure = run(encoded("throw 'hyper-v-vm-ownership-mismatch'"));
        expect(knownFailure.status).toBe(1);
        expect(knownFailure.stderr).toContain("hyper-v-vm-ownership-mismatch");

        const runtimeFailure = run(encoded("throw 'untrusted secret-bearing failure'"));
        expect(runtimeFailure.status).toBe(1);
        expect(runtimeFailure.stderr).toContain("hyper-v-powershell-execution-failed");
        expect(runtimeFailure.stderr).not.toContain("secret-bearing");

        for (const stage of ["download", "hash", "archive-check", "extract", "normalize", "inspection", "finalize"]) {
            const diagnostic = `hyper-v-base-image-${stage}-failed`;
            const stageFailure = run(encoded([
                `$env:CCC_HYPER_V_STAGE = '${diagnostic}'`,
                "throw 'untrusted stage failure'",
            ].join("\n")));
            expect(stageFailure.status).toBe(1);
            expect(stageFailure.stderr).toContain(diagnostic);
            expect(stageFailure.stderr).not.toContain("untrusted stage failure");
        }

        const inheritedStage = spawnSync(acquire.executable, acquire.args, {
            input: encoded("throw 'untrusted inherited-stage failure'"),
            encoding: "utf8",
            windowsHide: true,
            timeout: 15_000,
            env: { ...process.env, CCC_HYPER_V_STAGE: "hyper-v-base-image-hash-failed" },
        });
        expect(inheritedStage.status).toBe(1);
        expect(inheritedStage.stderr).toContain("hyper-v-powershell-execution-failed");
        expect(inheritedStage.stderr).not.toContain("hyper-v-base-image-hash-failed");
    });

    it.skipIf(process.platform !== "win32")("keeps a Canonical ZIP readable by tar while a non-delete-sharing handle is held", () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-hyper-v-archive-lock-"));
        const payload = join(root, "payload.txt");
        const archive = join(root, "source.vhdx.zip");
        writeFileSync(payload, "archive-lock-probe");
        try {
            const created = spawnSync("tar.exe", ["-a", "-cf", archive, "-C", root, "payload.txt"], {
                encoding: "utf8",
                windowsHide: true,
                timeout: 30_000,
            });
            expect(created.status, created.stderr || created.error?.message).toBe(0);
            const escapedArchive = archive.replace(/'/g, "''");
            const probe = [
                "$ErrorActionPreference = 'Stop'",
                `$Archive = '${escapedArchive}'`,
                "$Handle = [IO.File]::Open($Archive, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)",
                "try { & tar.exe -tf $Archive; if ($LASTEXITCODE -ne 0) { throw 'tar-read-failed' } } finally { $Handle.Dispose() }",
            ].join("\n");
            const result = spawnSync("powershell.exe", [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-EncodedCommand",
                Buffer.from(probe, "utf16le").toString("base64"),
            ], {
                encoding: "utf8",
                windowsHide: true,
                timeout: 30_000,
            });
            expect(result.status, result.stderr || result.error?.message).toBe(0);
            expect(result.stdout).toContain("payload.txt");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it.skipIf(process.platform !== "win32")("creates an unencrypted SSH key through PowerShell 5.1 without native empty-argument rewriting", () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-hyper-v-keygen-probe-"));
        const privateKeyPath = join(root, "id_ed25519");
        try {
            const seed = hyperVLinuxSeedCommand({
                executable: "powershell.exe",
                ownerId,
                deviceId: "linux-keygen-probe",
                incarnationId,
                vmName: hyperVVmName(ownerId, "linux-keygen-probe", incarnationId),
                vmId,
                diskPath: join(root, "root.vhdx"),
                deviceRoot: root,
                privateRoot: root,
                seedDiskPath: join(root, "cidata.iso"),
                sshPrivateKeyPath: privateKeyPath,
                sshPublicKeyPath: `${privateKeyPath}.pub`,
                sshHostPrivateKeyPath: join(root, "ssh_host_ed25519_key"),
                sshHostPublicKeyPath: join(root, "ssh_host_ed25519_key.pub"),
                knownHostsPath: join(root, "known_hosts"),
                guestUsername: "ccc01234567",
                networkAddress: "172.29.0.10",
                networkGateway: "172.29.0.1",
                networkPrefixLength: 24,
                macAddress: "02:11:22:33:44:66",
            });
            const generated = scriptOf(seed);
            const functionStart = generated.indexOf("function New-CccSshKey");
            const functionEnd = generated.indexOf("\nif (-not (Test-Path", functionStart);
            expect(functionStart).toBeGreaterThanOrEqual(0);
            expect(functionEnd).toBeGreaterThan(functionStart);
            const escapedPath = privateKeyPath.replace(/'/g, "''");
            const probe = [
                "$ErrorActionPreference = 'Stop'",
                generated.slice(functionStart, functionEnd),
                "$SshKeygen = (Get-Command ssh-keygen.exe -ErrorAction Stop).Source",
                `$Status = New-CccSshKey $SshKeygen 'ccc-device-lab-${vmId}' '${escapedPath}'`,
                "if ($Status -ne 0) { throw 'hyper-v-linux-ssh-keygen-probe-failed' }",
            ].join("\n");
            const created = spawnSync("powershell.exe", [
                "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                "-EncodedCommand", Buffer.from(probe, "utf16le").toString("base64"),
            ], { encoding: "utf8", timeout: 30_000, windowsHide: true });
            expect(created.status, created.stderr || created.error?.message).toBe(0);

            const readable = spawnSync("ssh-keygen.exe", ["-y", "-f", privateKeyPath], {
                encoding: "utf8",
                timeout: 15_000,
                windowsHide: true,
            });
            expect(readable.status, readable.stderr || readable.error?.message).toBe(0);
            expect(readable.stdout).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
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
            generation: 2,
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
        expect(script.match(/-WindowStyle Hidden -PassThru/g)).toHaveLength(2);
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
        expect(script).toContain("function Get-CccVhdGeneration");
        expect(script).toContain("Mount-VHD -Path $Path -ReadOnly -NoDriveLetter");
        expect(script.match(/Get-CccVhdGeneration \$ImagePath/g)).toHaveLength(2);
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
            generation: 2,
            reused: false,
        }))).toEqual({
            ok: true,
            profile: "windows-11",
            imagePath: "/state/images/hyper-v/windows-11/base.vhdx",
            sha256: "a".repeat(64),
            sizeBytes: 1024,
            virtualSizeBytes: 64 * 1024 * 1024 * 1024,
            vhdType: "Dynamic",
            generation: 2,
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
            expectedGeneration: 2,
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
        expect(script.indexOf("Set-CccAcquireStage 'hyper-v-base-image-download-failed'"))
            .toBeLessThan(script.indexOf("Set-CccAcquireStage 'hyper-v-base-image-partial-open-failed'"));
        expect(script.indexOf("Set-CccAcquireStage 'hyper-v-base-image-partial-inspection-failed'"))
            .toBeLessThan(script.indexOf("Assert-BaseVhd $PartialPath"));
        expect(script.indexOf("Save-BoundedDownload $WindowsUrl $PartialPath"))
            .toBeLessThan(script.indexOf("Protect-CccImageDirectory $ProfileRoot", script.indexOf("Save-BoundedDownload $WindowsUrl $PartialPath")));
        expect(script.indexOf("Protect-CccImageDirectory $ProfileRoot", script.indexOf("Save-BoundedDownload $WindowsUrl $PartialPath")))
            .toBeLessThan(script.indexOf("$PartialGuard = [IO.File]::Open($PartialPath"));
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

    it("builds a fixed checksummed Canonical Ubuntu Hyper-V VHDX acquisition command", () => {
        const command = hyperVAcquireBaseImageCommand({
            executable: "powershell.exe",
            profile: "ubuntu-lts",
            imageRoot: "/state/images/hyper-v",
            expectedGeneration: 2,
        });
        const script = scriptOf(command);
        expect(script).toContain("$SourceArchivePath =");
        expect(script).toContain("function Protect-CccImageDirectory([string]$Path)");
        expect(script).toContain("$Security.SetAccessRuleProtection($true, $false)");
        expect(script).toContain("$Security.SetOwner($CurrentSid)");
        expect(script).toContain("[IO.Directory]::SetAccessControl($Target, $Security)");
        expect(script).toContain("[IO.File]::SetAccessControl($Target, $Security)");
        expect(script).toContain("$AllowedSids = @($CurrentSid.Value, $SystemSid.Value, $AdministratorsSid.Value)");
        expect(script).toContain("$Observed.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $CurrentSid.Value");
        expect(script).toContain("if ($ObservedRules.Count -ne $AllowedSids.Count) { throw 'hyper-v-base-image-acl-failed' }");
        expect(script).toContain("$Matching[0].FileSystemRights -ne $FullControl");
        expect(script).toContain("Get-ChildItem -LiteralPath $Parent -Force -ErrorAction Stop");
        expect(script).toContain("$Entry.Attributes -band [IO.FileAttributes]::ReparsePoint");
        expect(script).toContain("Protect-CccImageDirectory $ProfileRoot");
        expect(script.match(/Protect-CccImageDirectory \$ProfileRoot/g)).toHaveLength(5);
        expect(script).toContain("source.vhdx.zip");
        expect(script).toContain("$ArchiveDownloadPath = Join-Path $WorkPath 'source.download.vhdx.zip'");
        expect(script).toContain("Test-Path -LiteralPath $ArchivePath -PathType Container");
        expect(script).toContain("Test-Path -LiteralPath $ArchivePath -PathType Leaf");
        expect(script).toContain("$ArchiveReady = $CachedHash -eq $UbuntuArchiveSha256");
        expect(script).toContain("[IO.FileShare]::Read");
        expect(script).toContain("$ArchiveHandle = [IO.File]::Open($ArchivePath");
        expect(script).toContain("$LockedHash = (Get-FileHash -LiteralPath $ArchivePath");
        expect(script).toContain("$DiscardArchive = $true");
        expect(script).toContain("if ($ArchiveHandle) { $ArchiveHandle.Dispose(); $ArchiveHandle = $null }");
        expect(script).toContain("if ($DiscardArchive -and (Test-Path -LiteralPath $SourceArchivePath -PathType Leaf))");
        expect(script).toContain("Move-Item -LiteralPath $ArchiveDownloadPath -Destination $ArchivePath");
        expect(script.indexOf("Get-FileHash -LiteralPath $ArchiveDownloadPath"))
            .toBeLessThan(script.indexOf("Move-Item -LiteralPath $ArchiveDownloadPath -Destination $ArchivePath"));
        expect(script.indexOf("Move-Item -LiteralPath $ArchiveDownloadPath -Destination $ArchivePath"))
            .toBeLessThan(script.indexOf("$LockedHash = (Get-FileHash -LiteralPath $ArchivePath"));
        expect(script.indexOf("Move-Item -LiteralPath $ArchiveDownloadPath -Destination $ArchivePath"))
            .toBeLessThan(script.indexOf("Protect-CccImageDirectory $ProfileRoot", script.indexOf("Move-Item -LiteralPath $ArchiveDownloadPath -Destination $ArchivePath")));
        expect(script.indexOf("$LockedHash = (Get-FileHash -LiteralPath $ArchivePath"))
            .toBeLessThan(script.indexOf("tar.exe -tf $ArchivePath"));
        expect(script).toContain("tar.exe -tf $ArchivePath");
        expect(script).toContain("tar.exe -tvf $ArchivePath");
        expect(script).toContain("& tar.exe -xf $ArchivePath -C $ExtractPath");
        expect(script).not.toContain("--no-same-owner");
        expect(script).not.toContain("--no-same-permissions");
        expect(script).toContain("hyper-v-base-image-archive-path-invalid");
        expect(script).toContain("hyper-v-base-image-archive-entry-type-invalid");
        expect(script).toContain("https://partner-images.canonical.com/hyper-v/desktop/noble/20260731/ubuntu-noble-hyperv-amd64-ubuntu-desktop-hyperv.vhdx.zip");
        expect(script).not.toContain("azure.vhd");
        expect(script).toContain("fdf191eb93b0f3eff4526c203be1fc2232aaef51ab2eaf9c5714eb1bce7ec48f");
        expect(script).not.toContain("SHA256SUMS");
        expect(script).toContain("$UbuntuMaxBytes = [long]5GB");
        expect(script).toContain("DnsSafeHost.ToLowerInvariant() -eq 'partner-images.canonical.com'");
        expect(script).toContain("Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256");
        expect(script).toContain("hyper-v-base-image-checksum-mismatch");
        expect(script).toContain("hyper-v-base-image-hash-failed");
        expect(script).toContain("Set-CccAcquireStage 'hyper-v-base-image-hash-failed'");
        expect(script).toContain("hyper-v-base-image-archive-check-failed");
        expect(script).toContain("hyper-v-base-image-extract-failed");
        expect(script.indexOf("Set-CccAcquireStage 'hyper-v-base-image-archive-check-failed'"))
            .toBeLessThan(script.indexOf("& tar.exe -xf $ArchivePath -C $ExtractPath"));
        expect(script.indexOf("Set-CccAcquireStage 'hyper-v-base-image-extract-failed'"))
            .toBeLessThan(script.indexOf("& tar.exe -xf $ArchivePath -C $ExtractPath"));
        expect(script.indexOf("& tar.exe -xf $ArchivePath -C $ExtractPath"))
            .toBeLessThan(script.indexOf("if ($LASTEXITCODE -ne 0) { throw 'hyper-v-base-image-extract-failed' }"));
        expect(script).toContain("hyper-v-base-image-source-inspection-failed");
        expect(script).toContain("hyper-v-base-image-copy-failed");
        expect(script).toContain("hyper-v-base-image-partial-inspection-failed");
        expect(script).toContain("hyper-v-base-image-final-move-failed");
        expect(script).toContain("hyper-v-base-image-final-inspection-failed");
        expect(script).toContain("hyper-v-base-image-final-observation-failed");
        expect(script).toContain("$MaximumArchiveEntries = 64");
        expect(script).toContain("$MaximumRegularFiles = 8");
        expect(script).toContain("$MaximumExtractedBytes = [long]64GB");
        expect(script).toContain("$RequiredExtractionBytes = [long]$TotalExtractedBytes + [long]$ExpectedVhdBytes + [long]2GB");
        expect(script).toContain("if ([long]$ProfileDrive.AvailableFreeSpace -lt $RequiredExtractionBytes)");
        expect(script).toContain("hyper-v-base-image-archive-size-rejected");
        expect(script).toContain("hyper-v-base-image-archive-size-mismatch");
        expect(script).toContain("Get-ChildItem -LiteralPath $ExtractPath -Recurse -File -Force");
        expect(script).toContain("hyper-v-base-image-archive-file-count-mismatch");
        expect(script).toContain("hyper-v-base-image-archive-total-size-mismatch");
        expect(script).toContain("[IO.FileAttributes]::ReparsePoint");
        expect(script).toContain("if ($SourceVhds.Count -ne 1)");
        expect(script).toContain("[IO.FileAttributes]::SparseFile");
        expect(script).toContain("normalized-source.vhdx");
        expect(script).toContain("$OutputStream.Write($Buffer, 0, $Read)");
        expect(script).toContain("hyper-v-base-image-normalize-attributes-failed");
        expect(script).not.toContain("Move-Item -LiteralPath $SourcePath -Destination $PartialPath");
        expect(script).toContain("Copy-Item -LiteralPath $SourcePath -Destination $PartialPath");
        expect(script).not.toContain("Convert-VHD -Path $SourcePath");
        expect(script).toContain("$SourceGuard = [IO.File]::Open($SourcePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))");
        expect(script).toContain("$SourceHashBefore = (Get-FileHash -LiteralPath $SourcePath");
        expect(script).toContain("$SourceHashAfter = (Get-FileHash -LiteralPath $SourcePath");
        expect(script).toContain("if ($SourceHashAfter -ne $SourceHashBefore) { throw 'hyper-v-base-image-source-mutated' }");
        expect(script).toContain("$Vhd = Assert-BaseVhd $ImagePath");
        expect(script).toContain("$Generation = $ExpectedGeneration");
        expect(script).not.toContain("function Get-CccVhdGeneration");
        expect(script).not.toContain("Mount-VHD -Path $Path");
        expect(script).not.toContain("Get-Disk -ErrorAction Stop");
        expect(script).toContain("$ValidatedPartialHash = (Get-FileHash -LiteralPath $PartialPath");
        expect(script).toContain("$PartialGuard = [IO.File]::Open($PartialPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))");
        expect(script).toContain("$PartialHashBefore = (Get-FileHash -LiteralPath $PartialPath");
        expect(script).toContain("if ($ValidatedPartialHash -ne $PartialHashBefore) { throw 'hyper-v-base-image-partial-mutated' }");
        expect(script).not.toContain("$SourceGuard = [IO.File]::Open($SourcePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)");
        expect(script).not.toContain("$PartialGuard = [IO.File]::Open($PartialPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)");
        expect(script.indexOf("$SourceHashBefore = (Get-FileHash -LiteralPath $SourcePath"))
            .toBeLessThan(script.indexOf("$SourceVhd = Get-VHD -Path $SourcePath"));
        expect(script.indexOf("Copy-Item -LiteralPath $SourcePath"))
            .toBeLessThan(script.indexOf("$SourceHashAfter = (Get-FileHash -LiteralPath $SourcePath"));
        expect(script.indexOf("$SourceHashAfter = (Get-FileHash -LiteralPath $SourcePath"))
            .toBeLessThan(script.indexOf("Protect-CccImageDirectory $ProfileRoot", script.indexOf("$SourceHashAfter = (Get-FileHash -LiteralPath $SourcePath")));
        expect(script.indexOf("$PartialHashBefore = (Get-FileHash -LiteralPath $PartialPath"))
            .toBeLessThan(script.indexOf("$Vhd = Assert-BaseVhd $PartialPath"));
        const partialGuardDispose = script.indexOf("} finally { $PartialGuard.Dispose(); $PartialGuard = $null }");
        const catalogGeneration = script.indexOf("$Generation = $ExpectedGeneration");
        const reopenedPartialGuard = script.indexOf("$PartialGuard = [IO.File]::Open($PartialPath", catalogGeneration);
        expect(partialGuardDispose).toBeGreaterThan(script.indexOf("$Vhd = Assert-BaseVhd $PartialPath"));
        expect(partialGuardDispose).toBeLessThan(catalogGeneration);
        expect(reopenedPartialGuard).toBeGreaterThan(catalogGeneration);
        expect(reopenedPartialGuard).toBeLessThan(script.indexOf("$ValidatedPartialHash = (Get-FileHash -LiteralPath $PartialPath"));
        expect(script).toContain("if ($ExpectedHash -and $Hash -ne $ExpectedHash) { throw 'hyper-v-base-image-final-hash-mismatch' }");
        expect(script).toContain("if ($FinalHashBefore -ne $ValidatedPartialHash) { throw 'hyper-v-base-image-final-hash-mismatch' }");
        expect(script.indexOf("$FinalHashBefore = (Get-FileHash -LiteralPath $ImagePath"))
            .toBeLessThan(script.indexOf("$Vhd = Assert-BaseVhd $ImagePath"));
        expect(script.indexOf("Move-Item -LiteralPath $PartialPath -Destination $ImagePath"))
            .toBeLessThan(script.indexOf("Protect-CccImageDirectory $ProfileRoot", script.indexOf("Move-Item -LiteralPath $PartialPath -Destination $ImagePath")));
        expect(script).toContain("Write-BaseObservation $Vhd $Generation $false $ValidatedPartialHash");
        expect(script).toContain("hyper-v-base-image-archive-vhd-count-invalid");
        expect(script).toContain("$ExpectedGeneration = 2");
        expect(script).toContain("$Generation = $ExpectedGeneration");
        expect(script).not.toContain("hyper-v-base-image-generation-mismatch");
        expect(script).toContain("Write-BaseObservation $Vhd $Generation $false");
        expect(script).not.toContain("Mount-VHD -Path $ImagePath");
        expect(script).toContain("if (Test-Path -LiteralPath $WorkPath) { throw 'hyper-v-base-image-work-path-not-clean' }");
        expect(script).not.toContain("Remove-Item -LiteralPath $WorkPath -Recurse");
        expect(script).toContain("if ($FailureMessage -match '^hyper-v-[a-z0-9-]{3,128}$') { throw $FailureMessage }");
        expect(script).toContain("[Console]::Out.WriteLine(('CCC_HYPER_V_STAGE:' + $script:CccAcquireStage))");
        expect(script).toContain("throw $script:CccAcquireStage");
    });

    it("rejects non-automatic acquisition profiles and unsafe image roots", () => {
        expect(() => hyperVAcquireBaseImageCommand({
            executable: "powershell.exe",
            profile: "windows-11" as "windows-server",
            imageRoot: "/state/images/hyper-v",
            expectedGeneration: 1,
        })).toThrow("hyper-v-base-image-profile-not-automatic");
        expect(() => hyperVAcquireBaseImageCommand({
            executable: "powershell.exe",
            profile: "ubuntu-lts",
            imageRoot: "relative/images",
            expectedGeneration: 1,
        })).toThrow("hyper-v-base-image-root-invalid");
        expect(() => hyperVAcquireBaseImageCommand({
            executable: "powershell.exe",
            profile: "ubuntu-lts",
            imageRoot: "/state/images/hyper-v",
            expectedGeneration: 3 as 2,
        })).toThrow("hyper-v-base-image-generation-invalid");
        expect(() => hyperVAcquireBaseImageCommand({
            executable: "powershell.exe",
            profile: "ubuntu-lts",
            imageRoot: "/state/images/hyper-v",
            expectedGeneration: 1,
        })).toThrow("hyper-v-base-image-generation-mismatch");
        expect(() => hyperVAcquireBaseImageCommand({
            executable: "powershell.exe",
            profile: "windows-server",
            imageRoot: "/state/images/hyper-v",
            expectedGeneration: 1,
        })).toThrow("hyper-v-base-image-generation-mismatch");
    });

    it("creates an owner-scoped VM matching the boot disk generation with rollback and secure defaults", () => {
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
            baseImageGeneration: 2,
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
        expect(script).not.toContain("Mount-VHD -Path $DiskPath");
        expect(script).not.toContain("$BootDisk.PartitionStyle");
        expect(script).toContain("$VmGeneration = $ExpectedVmGeneration");
        expect(script).toContain("$ExpectedVmGeneration = 2");
        expect(script).toContain("Generation = $VmGeneration");
        expect(script).toContain("New-VHD -Path $DiskPath -ParentPath $BaseImage -Differencing");
        expect(script).toContain("[IO.FileShare]::Read");
        expect(script).toContain("$Hasher.ComputeHash($BaseImageStream)");
        expect(script).toContain("hyper-v-base-image-hash-mismatch");
        expect(script).toContain("hyper-v-created-disk-parent-mismatch");
        expect(script.indexOf("if ($BaseImageHash -ne $ExpectedBaseImageHash)"))
            .toBeLessThan(script.indexOf("$VmGeneration = $ExpectedVmGeneration"));
        expect(script.indexOf("hyper-v-created-disk-parent-mismatch"))
            .toBeLessThan(script.indexOf("$VmGeneration = $ExpectedVmGeneration"));
        expect(script.indexOf("$VmGeneration = $ExpectedVmGeneration"))
            .toBeLessThan(script.indexOf("$CreatedVm = New-VM"));
        const createStages = [
            "CCC_HYPER_V_STAGE:hyper-v-vm-preflight-failed",
            "CCC_HYPER_V_STAGE:hyper-v-base-image-hash-failed",
            "CCC_HYPER_V_STAGE:hyper-v-base-image-inspection-failed",
            "CCC_HYPER_V_STAGE:hyper-v-vm-disk-create-failed",
            "CCC_HYPER_V_STAGE:hyper-v-vm-create-failed",
            "CCC_HYPER_V_STAGE:hyper-v-vm-configure-failed",
        ];
        for (let index = 1; index < createStages.length; index++) {
            expect(script.indexOf(createStages[index - 1]))
                .toBeLessThan(script.indexOf(createStages[index]));
        }
        expect(script.indexOf("CCC_HYPER_V_STAGE:hyper-v-vm-preflight-failed"))
            .toBeLessThan(script.indexOf("$ComputerInfo = Get-CimInstance"));
        expect(script.indexOf("CCC_HYPER_V_STAGE:hyper-v-base-image-hash-failed"))
            .toBeLessThan(script.indexOf("$BaseImageStream = [IO.File]::Open"));
        expect(script.indexOf("CCC_HYPER_V_STAGE:hyper-v-base-image-inspection-failed"))
            .toBeLessThan(script.indexOf("$BaseVhd = Get-VHD"));
        expect(script).toContain(`ccc-device-lab:${ownerId}:${deviceId}:${incarnationId}`);
        expect(script).toContain("AutomaticCheckpointsEnabled $false");
        expect(script).toContain("CheckpointType ProductionOnly");
        expect(script).toContain("EnableSecureBoot On");
        expect(script).toContain("-FirstBootDevice $CreatedOsDisks[0]");
        expect(script).toContain("Set-VMBios -VM $CreatedVm -StartupOrder @('IDE','CD','LegacyNetworkAdapter','Floppy')");
        expect(script).toContain("Get-VMSwitch -Name $SwitchName");
        expect(script).toContain("Set-VMNetworkAdapter -VMNetworkAdapter $ManagedAdapter -StaticMacAddress");
        expect(script).toContain("02:11:22:33:44:55");
        expect(script).toContain("hyper-v-network-switch-unavailable");
        expect(script).toContain("$DiskReserveBytes = 10GB");
        expect(script).toContain("hyper-v-host-disk-capacity-exceeded");
        expect(script).toContain("Remove-VM -VM $CreatedVm -Force");
        expect(script).toContain("Remove-Item -LiteralPath $DiskPath -Force");
        expect(script).toContain("if (-not $DeviceRootExisted");
        const explicitFailureCodes = [...new Set(
            [...script.matchAll(/throw '(hyper-v-[a-z0-9-]+)'/g)]
                .map((match) => match[1]),
        )];
        expect(explicitFailureCodes.length).toBeGreaterThan(10);
        for (const code of explicitFailureCodes) {
            expect(hyperVProviderDiagnosticCode({ stderr: code, stdout: "" }))
                .toBe(code);
        }
        expect(hyperVProviderDiagnosticCode(
            { stderr: "hyper-v-untrusted-runtime-detail", stdout: "" },
            "hyper-v-provider-command-failed",
        )).toBe("hyper-v-provider-command-failed");
        expect(hyperVProviderDiagnosticCode({
            stdout: "CCC_HYPER_V_STAGE:hyper-v-guest-provision-media-build-command-failed",
            stderr: "hyper-v-powershell-execution-failed",
        })).toBe("hyper-v-guest-provision-media-build-command-failed");
        expect(hyperVProviderDiagnosticCode({
            error: "hyper-v-powershell-execution-failed",
            stdout: "",
            stderr: "hyper-v-base-image-archive-check-failed",
        })).toBe("hyper-v-base-image-archive-check-failed");
        for (const code of [
            "hyper-v-network-elevation-cancelled",
            "hyper-v-network-elevation-failed",
            "hyper-v-network-pipe-handshake-timeout",
            "hyper-v-network-subnet-conflict",
            "hyper-v-network-gateway-conflict",
            "hyper-v-network-nat-prefix-conflict",
        ]) {
            expect(hyperVProviderDiagnosticCode({
                error: "hyper-v-powershell-execution-failed",
                stdout: "",
                stderr: `${code}:bounded-detail`,
            })).toBe(code);
        }
        expect(() => hyperVCreateCommand({
            executable: "powershell.exe",
            ownerId,
            deviceId,
            incarnationId,
            vmName,
            baseImagePath: "/state/images/hyper-v/windows-11.vhdx",
            baseImageSha256,
            baseImageGeneration: 2,
            baseImageRoot: "/state/images/hyper-v",
            deviceRoot: "/state/owners/0123456789abcdef/windows-vm/windows-ci-01",
            diskPath: "/state/owners/0123456789abcdef/windows-vm/windows-ci-01/disks/root.vhdx",
            diskMaxBytes: 64 * 1024 * 1024 * 1024,
            memoryMb: 512,
            cpus: 2,
        })).toThrow("hyper-v-memory-mb-invalid");

        const linuxScript = scriptOf(hyperVCreateCommand({
            executable: "powershell.exe",
            ownerId,
            deviceId: "linux-ci-01",
            incarnationId,
            vmName: hyperVVmName(ownerId, "linux-ci-01", incarnationId),
            baseImagePath: "/state/images/hyper-v/ubuntu-lts.vhdx",
            baseImageSha256,
            baseImageGeneration: 2,
            baseImageRoot: "/state/images/hyper-v",
            deviceRoot: "/state/owners/0123456789abcdef/linux-vm/linux-ci-01",
            diskPath: "/state/owners/0123456789abcdef/linux-vm/linux-ci-01/disks/root.vhdx",
            diskMaxBytes: 64 * 1024 * 1024 * 1024,
            memoryMb: 4096,
            cpus: 2,
            switchName: "CCC Device Lab",
            macAddress: "02:11:22:33:44:66",
            bootstrapDhcp: true,
            secureBootTemplate: "MicrosoftUEFICertificateAuthority",
        }));
        expect(linuxScript).toContain("Get-VMSwitch -Name 'Default Switch'");
        expect(linuxScript).toContain("hyper-v-bootstrap-dhcp-switch-unavailable");
        expect(linuxScript).toContain("Rename-VMNetworkAdapter -VMNetworkAdapter $BootstrapAdapters[0] -NewName 'CCC Bootstrap DHCP'");
        expect(linuxScript).toContain("Add-VMNetworkAdapter -VM $CreatedVm -SwitchName $ResolvedSwitch.Name -Name 'CCC Device Network'");
        expect(linuxScript).toContain("Set-VMNetworkAdapter -VMNetworkAdapter $ManagedAdapter -StaticMacAddress");
        expect(linuxScript).toContain("SecureBootTemplate 'MicrosoftUEFICertificateAuthority'");
    });

    it("removes only the owner-fenced Default Switch bootstrap adapter", () => {
        const cleanup = hyperVBootstrapNetworkCleanupCommand({
            executable: "powershell.exe",
            ownerId,
            deviceId: "linux-ci-01",
            incarnationId,
            vmName: hyperVVmName(ownerId, "linux-ci-01", incarnationId),
            vmId,
        });
        const script = scriptOf(cleanup);
        expect(script).toContain("Get-VM -Id $ExpectedId");
        expect(script).toContain(`$ExpectedMarker = 'ccc-device-lab:${ownerId}:linux-ci-01:${incarnationId}'`);
        expect(script).toContain("$_.Name -eq 'CCC Bootstrap DHCP'");
        expect(script).toContain("[string]$BootstrapAdapters[0].SwitchName -ne 'Default Switch'");
        expect(script).toContain("Remove-VMNetworkAdapter -VMNetworkAdapter $BootstrapAdapters[0]");
        expect(parseHyperVBootstrapNetworkCleanupObservation('{"ok":true,"removed":true,"alreadyMissing":false}')).toEqual({
            ok: true,
            removed: true,
            alreadyMissing: false,
        });
        expect(parseHyperVBootstrapNetworkCleanupObservation('{"ok":true,"removed":false,"alreadyMissing":true}')).toEqual({
            ok: true,
            removed: false,
            alreadyMissing: true,
        });
        expect(parseHyperVBootstrapNetworkCleanupObservation('{"ok":true,"removed":"yes","alreadyMissing":false}')).toBeNull();
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
            diskPath: `${deviceRoot}/disks/root.vhdx`,
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
            macAddress: "02:11:22:33:44:66",
        });
        const seedScript = scriptOf(seed);
        expect(seedScript).toContain("IMAPI2FS.MsftFileSystemImage");
        expect(seedScript).toContain("Write-CccIso $IsoFiles $SeedDisk 'cidata' $MediaSourceRoot");
        expect(seedScript).toContain("Set-VMFirmware -VM $Vm -FirstBootDevice $OsDisks[0]");
        expect(seedScript).toContain("Set-VMBios -VM $Vm -StartupOrder @('IDE','CD','LegacyNetworkAdapter','Floppy')");
        expect(seedScript).toContain("$NormalizedVolumeName = ([string]$VolumeName).ToUpperInvariant()");
        expect(seedScript).toContain("$Image.FileSystemsToCreate = 7");
        expect(seedScript).toContain("try { $Image.ChooseImageDefaultsForMediaType(1) } catch");
        expect(seedScript).toContain("$Image.VolumeName = $NormalizedVolumeName");
        expect(seedScript).toContain("hyper-v-provisioning-media-filesystem-selection-failed");
        expect(seedScript).toContain("hyper-v-provisioning-media-volume-name-failed");
        expect(seedScript).toContain("configure-failed|filesystem-selection-failed|volume-name-invalid|volume-name-failed|source-entry-invalid");
        expect(seedScript).toContain("[int]$ResultImage.BlockSize, [long]$ResultImage.TotalBlocks");
        expect(seedScript).toContain("SHCreateStreamOnFileEx");
        expect(seedScript).toContain("input.CopyTo(output, expectedBytes, readPointer, writtenPointer)");
        expect(seedScript).toContain("readBytes != expectedBytes || writtenBytes != expectedBytes");
        expect(seedScript).toContain("@($ImageStream, $ResultImage, $ImageRoot, $Image)");
        expect(seedScript).toContain("FinalReleaseComObject($ComObject)");
        expect(seedScript).toContain("[IO.File]::WriteAllBytes($EntryPath, $EntryBytes)");
        expect(seedScript).toContain("$ImageRoot.AddTree($SourceRoot, $false)");
        expect(seedScript).toContain("[Console]::Out.WriteLine('hyper-v-provisioning-media-add-tree-failed')");
        expect(seedScript).toContain("[Console]::Out.WriteLine('hyper-v-provisioning-media-output-open-failed')");
        expect(seedScript).toContain("[Console]::Out.WriteLine($CccIsoFailure)");
        expect(seedScript).toContain("Assert-NoReparsePath $SourceRoot");
        expect(seedScript).toContain("function Remove-CccIsoSourceRoot");
        expect(seedScript).toContain("Get-ChildItem -LiteralPath $SourceRoot -Force");
        expect(seedScript).toContain("$CurrentChild = Get-Item -LiteralPath $SourceChild.FullName");
        expect(seedScript).toContain("$SourceAcl.SetAccessRuleProtection($true, $false)");
        expect(seedScript).toContain("[Security.AccessControl.FileSystemAccessRule]::new(");
        expect(seedScript).not.toContain("New-Object Security.AccessControl.FileSystemAccessRule(");
        expect(seedScript).toContain("hyper-v-provisioning-media-source-cleanup-failed");
        expect(seedScript.indexOf("if ($null -ne $CccIsoFailure) { [Console]::Out.WriteLine($CccIsoFailure); throw $CccIsoFailure }")).toBeGreaterThan(seedScript.indexOf("finally {"));
        expect(seedScript).not.toContain("Remove-Item -LiteralPath $SourceRoot -Recurse");
        expect(seedScript).not.toContain("ADODB.Stream");
        expect(seedScript).not.toContain("$SourceStream.Close()");
        expect(seedScript).not.toContain("CreateStreamOnHGlobal");
        expect(seedScript).not.toContain("[CccIsoStreamWriter]::CreateSource");
        expect(seedScript).not.toContain("$ImageRoot.AddFile(");
        expect(seedScript).not.toContain("input.Read(");
        expect(seedScript).toContain("network-config");
        const networkBase64 = seedScript.match(/\$NetworkBase64 = '([^']+)'/)?.[1];
        expect(networkBase64).toBeTruthy();
        const networkConfig = Buffer.from(networkBase64!, "base64").toString("utf8");
        expect(networkConfig).toContain("  ccc0:");
        expect(networkConfig).toContain("macaddress: '02:11:22:33:44:66'");
        expect(networkConfig).toContain("set-name: ccc0");
        expect(networkConfig).not.toContain("set-name: eth0");
        expect(networkConfig).not.toContain("name: 'e*'");
        expect(networkConfig.startsWith("version: 2\n")).toBe(true);
        const netplanBase64 = seedScript.match(/\$NetplanBase64 = '([^']+)'/)?.[1];
        expect(netplanBase64).toBeTruthy();
        const netplanConfig = Buffer.from(netplanBase64!, "base64").toString("utf8");
        expect(netplanConfig.startsWith("network:\n  version: 2\n")).toBe(true);
        expect(seedScript).toContain("('    content: ' + $NetplanBase64)");
        expect(seedScript).not.toContain("('    content: ' + $NetworkBase64)");
        expect(seedScript).not.toContain("<ns1:dscfg>");
        expect(seedScript).toContain("'ovf-env.xml' = [Convert]::FromBase64String($OvfEnvironmentBase64)");
        expect(seedScript).toContain("<ns1:LinuxProvisioningConfigurationSet>");
        expect(seedScript).toContain("('<ns1:CustomData>' + $UserDataBase64 + '</ns1:CustomData>')");
        expect(seedScript).toContain("<ns1:SSH><ns1:PublicKeys><ns1:PublicKey>");
        expect(seedScript).toContain("<ns1:Path>/home/' + $GuestUsername + '/.ssh/authorized_keys</ns1:Path>");
        expect(seedScript).toContain("<ns1:Value>' + $PublicKeyXml + '</ns1:Value>");
        expect(seedScript).toContain("<ns1:PlatformSettingsSection>");
        expect(seedScript).toContain("<ns1:PlatformSettings>");
        expect(seedScript).toContain("<ns1:ProvisionGuestAgent>false</ns1:ProvisionGuestAgent>");
        expect(seedScript).toContain("<ns1:GuestAgentPackageName xsi:nil=\"true\" />");
        expect(seedScript).toContain("<ns1:PreprovisionedVMType xsi:nil=\"true\" />");
        expect(seedScript.indexOf("</ns1:ProvisioningSection>")).toBeLessThan(seedScript.indexOf("<ns1:PlatformSettingsSection>"));
        expect(seedScript.indexOf("</ns1:PlatformSettingsSection>")).toBeLessThan(seedScript.indexOf("</ns0:Environment>"));
        expect(seedScript).not.toContain("apply_network_config: false");
        expect(seedScript).toContain("/etc/netplan/99-ccc-static.yaml");
        expect(seedScript).toContain("'  - [netplan, apply]'");
        expect(seedScript).toContain("ssh-keygen.exe");
        expect(seedScript).toContain("function New-CccSshKey");
        expect(seedScript).toContain("$StartInfo.Arguments = '-q -t ed25519 -N \"\"");
        expect(seedScript).toContain("[Diagnostics.Process]::Start($StartInfo)");
        expect(seedScript).not.toContain("& $SshKeygen.Source");
        expect(seedScript).toContain("function Set-CccProvisionStage");
        expect(seedScript).toContain("Set-CccProvisionStage 'vm-lookup'");
        expect(seedScript).toContain("Set-CccProvisionStage 'user-keygen'");
        expect(seedScript).toContain("Set-CccProvisionStage 'host-keygen'");
        expect(seedScript).toContain("Set-CccProvisionStage 'known-hosts'");
        expect(seedScript).toContain("Set-CccProvisionStage 'media-check'");
        expect(seedScript).toContain("Set-CccProvisionStage 'media-build'");
        expect(seedScript).toContain("Set-CccProvisionStage 'media-attach'");
        expect(seedScript).toContain("[Console]::Out.WriteLine(('CCC_HYPER_V_STAGE:hyper-v-linux-seed-' + $Stage + '-command-failed'))");
        expect(seedScript).toContain("hyper-v-linux-seed-' + $CccProvisionStage + '-command-failed");
        expect(seedScript).toContain("ssh_host_ed25519_key");
        expect(seedScript).toContain("ssh_deletekeys: true");
        expect(seedScript).toContain("sshHostKeyFingerprint");
        expect(seedScript).toContain("Add-VMDvdDrive -VM $Vm -Path $SeedDisk");
        expect(seedScript).not.toContain("$SeedSource");
        expect(seedScript).not.toContain("Mount-VHD");
        expect(seedScript).not.toContain("Initialize-Disk");
        expect(seedScript).toContain("Get-VM -Id $ExpectedId");
        expect(seedScript).not.toContain("cloud-init status --wait");

        const ssh = { executable: "ssh.exe", deviceRoot, privateRoot, sshPrivateKeyPath, knownHostsPath, guestUsername: "ccc01234567", networkAddress: "172.29.0.10" };
        expect(hyperVLinuxSshReadyCommand(ssh)).toMatchObject({ provider: "hyper-v-ssh", executable: "ssh.exe" });
        expect(hyperVLinuxSshReadyCommand(ssh).args).toContain("StrictHostKeyChecking=yes");
        expect(hyperVLinuxSshReadyCommand({ ...ssh, networkAddress: "172.20.1.8", hostKeyAlias: "172.29.0.10" }).args)
            .toContain("HostKeyAlias=172.29.0.10");
        const bootstrapNetwork = hyperVBootstrapNetworkCommand({
            executable: "powershell.exe",
            ownerId,
            deviceId: linuxDeviceId,
            incarnationId,
            vmName,
            vmId,
        });
        expect(bootstrapNetwork.args).toContain("-File");
        expect(JSON.parse(bootstrapNetwork.input || "{}")).toEqual({
            schemaVersion: 1,
            vmId,
            vmName,
            ownershipMarker: `ccc-device-lab:${ownerId}:${linuxDeviceId}:${incarnationId}`,
        });
        expect(scriptOf(bootstrapNetwork)).toContain("Get-CccLinuxBootstrapNetworkResult $Vm");
        expect(parseHyperVBootstrapNetworkObservation('{"ok":true,"addresses":["172.20.1.8"]}')).toEqual({
            ok: true,
            addresses: ["172.20.1.8"],
        });
        expect(parseHyperVBootstrapNetworkObservation('{"ok":true,"addresses":["169.254.1.8"]}')).toBeNull();
        const finalize = hyperVLinuxNetworkFinalizeCommand({
            ...ssh,
            networkAddress: "172.20.1.8",
            hostKeyAlias: "172.29.0.10",
            managedMacAddress: "02:11:22:33:44:66",
            managedNetworkAddress: "172.29.0.10",
            networkGateway: "172.29.0.1",
            networkPrefixLength: 24,
        });
        expect(finalize.args).toContain("HostKeyAlias=172.29.0.10");
        const finalizePayload = finalize.args.at(-1)?.match(/^printf %s ([A-Za-z0-9+/=]+) \| base64 -d \| bash$/)?.[1];
        expect(finalizePayload).toBeTruthy();
        expect(Buffer.from(finalizePayload || "", "base64").toString("utf8")).toContain("netplan apply");
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
        expect(script).toContain("Set-CccHyperVNetworkStage 'hyper-v-network-module-import-failed'");
        expect(script).toContain("Set-CccHyperVNetworkStage 'hyper-v-network-switch-name-inspection-failed'");
        expect(script).toContain("Set-CccHyperVNetworkStage 'hyper-v-network-switch-identity-inspection-failed'");
        expect(script.indexOf("Set-CccHyperVNetworkStage 'hyper-v-network-switch-name-inspection-failed'"))
            .toBeLessThan(script.indexOf("Get-VMSwitch -Name $SwitchName"));
        expect(script.indexOf("Set-CccHyperVNetworkStage 'hyper-v-network-switch-identity-inspection-failed'"))
            .toBeGreaterThan(script.indexOf("Get-VMSwitch -Name $SwitchName"));
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
        expect(script).toContain("$AllowCccOwnedNetworkAdoption = $false");
        expect(script).toContain("$AllowPersistedCccIdentityRepair = $false");
        expect(script).toContain(`$ExpectedSwitchId = '${vmId}'`);
        expect(script).not.toContain("Get-VMSwitch -Id ([Guid]$ExpectedSwitchId)");
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
        expect(script).toContain("$RequiresMutation = ($Switches.Count -eq 0) -or (-not $GatewayExists) -or ($Nats.Count -eq 0) -or $RepairPersistedSwitchMarker");
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

        const adoptionScript = scriptOf(hyperVEnsureNetworkCommand({
            executable: "powershell.exe",
            switchName: "CCC Device Lab",
            natName: "CCCDeviceLab",
            marker: "ccc-device-lab:hyper-v-network:v1",
            allowExistingNat: true,
            allowCccOwnedNetworkAdoption: true,
            prefix: "172.29.0.0/24",
            gateway: "172.29.0.1",
            prefixLength: 24,
        }));
        expect(adoptionScript).toContain("$AllowCccOwnedNetworkAdoption = $true");
        expect(adoptionScript).toContain("$AllowPersistedCccIdentityRepair = $false");
        expect(adoptionScript).toContain("[Convert]::ToString($ObservedNotes, [Globalization.CultureInfo]::InvariantCulture)");
        expect(adoptionScript).toContain("-not [string]::IsNullOrEmpty($ObservedMarker)");
        expect(adoptionScript).toContain("$ObservedTokenValue.ToCharArray()");
        expect(adoptionScript).toContain("$ObservedCode -ge 97 -and $ObservedCode -le 102");
        expect(adoptionScript).toContain("Set-CccHyperVNetworkStage 'hyper-v-network-switch-ownership-conflict'");
        expect(adoptionScript).toContain("if (-not $ObservedMarkerRecognized -and -not $CanRepairPersistedMarker) { throw 'hyper-v-network-switch-ownership-conflict' }");
        expect(adoptionScript).toContain("$NatName = 'CCCDeviceLab-' + $ObservedTokenValue");
        expect(adoptionScript).toContain("else { throw 'hyper-v-network-switch-ownership-conflict' }");
        expect(adoptionScript).not.toContain("Set-VMSwitch -VMSwitch $Switch -Notes $Marker");

        const persistedIdentityAdoptionScript = scriptOf(hyperVEnsureNetworkCommand({
            executable: "powershell.exe",
            switchName: "CCC Device Lab",
            natName: `CCCDeviceLab-${"a".repeat(24)}`,
            marker: `ccc-device-lab:hyper-v-network:${"a".repeat(24)}`,
            allowExistingNat: true,
            allowPersistedCccIdentityRepair: true,
            expectedSwitchId: vmId,
            expectedNatInstanceId: "ccc-nat-instance-1",
            prefix: "172.29.0.0/24",
            gateway: "172.29.0.1",
            prefixLength: 24,
        }));
        expect(persistedIdentityAdoptionScript).toContain("$AllowCccOwnedNetworkAdoption = $false");
        expect(persistedIdentityAdoptionScript).toContain("$AllowPersistedCccIdentityRepair = $true");
        expect(persistedIdentityAdoptionScript).toContain(`$ExpectedSwitchId = '${vmId}'`);
        expect(persistedIdentityAdoptionScript).toContain("$ExpectedNatInstanceId = 'ccc-nat-instance-1'");
        expect(persistedIdentityAdoptionScript).toContain("$ObservedMarker.Substring($MarkerPrefix.Length)");
        expect(persistedIdentityAdoptionScript).toContain("$ExpectedStable = $false");
        expect(persistedIdentityAdoptionScript).toContain("$ExpectedToken = $true");
        expect(persistedIdentityAdoptionScript).toContain(`$ExpectedTokenValue = '${"a".repeat(24)}'`);
        expect(persistedIdentityAdoptionScript).not.toContain("$Marker.Substring($MarkerPrefix.Length)");
        expect(persistedIdentityAdoptionScript).not.toContain("$ObservedTokenValue = if (");
        expect(persistedIdentityAdoptionScript).not.toContain("$ExpectedTokenValue = if (");
        expect(persistedIdentityAdoptionScript).toContain("Set-CccHyperVNetworkStage 'hyper-v-network-marker-inspection-failed'");
        expect(persistedIdentityAdoptionScript).toContain("Set-CccHyperVNetworkStage 'hyper-v-network-marker-classification-failed'");
        expect(persistedIdentityAdoptionScript).toContain("Set-CccHyperVNetworkStage 'hyper-v-network-identity-evidence-inspection-failed'");
        expect(persistedIdentityAdoptionScript).toContain("Set-CccHyperVNetworkStage 'hyper-v-network-identity-adoption-failed'");
        expect(persistedIdentityAdoptionScript).toContain("$CanRepairPersistedMarker = $AllowPersistedCccIdentityRepair -and $ExpectedSwitchId -and $ExpectedNatInstanceId");
        expect(persistedIdentityAdoptionScript).toContain("$RepairPersistedSwitchMarker = $true");
        expect(persistedIdentityAdoptionScript).toContain("Set-CccHyperVNetworkStage 'hyper-v-network-persisted-marker-repair-failed'");
        expect(persistedIdentityAdoptionScript).toContain("Set-VMSwitch -VMSwitch $Switch -Notes $Marker -ErrorAction Stop");
        expect(persistedIdentityAdoptionScript).toContain("Get-VMSwitch -Id ([Guid]$ExpectedSwitchId) -ErrorAction Stop");
        expect(persistedIdentityAdoptionScript).toContain("$RepairedSwitches[0].Id.ToString().ToLowerInvariant() -cne $ExpectedSwitchId");
        expect(persistedIdentityAdoptionScript).toContain("[string]$RepairedSwitches[0].Notes -cne $Marker");
        expect(persistedIdentityAdoptionScript).toContain("Set-CccHyperVNetworkStage 'hyper-v-network-persisted-marker-rollback-failed'");
        expect(persistedIdentityAdoptionScript).toContain("hyper-v-network-persisted-marker-rollback-conflict");
        expect(persistedIdentityAdoptionScript).toContain("Set-VMSwitch -VMSwitch $RollbackSwitches[0] -Notes $OriginalSwitchMarker -ErrorAction Stop");
        expect(persistedIdentityAdoptionScript).toContain("$RestoredSwitches = @(Get-VMSwitch -Id ([Guid]$ExpectedSwitchId) -ErrorAction Stop)");
        expect(persistedIdentityAdoptionScript).toContain("[string]$RestoredSwitches[0].Notes -cne $OriginalSwitchMarker");
        expect(persistedIdentityAdoptionScript.indexOf("if ($ExpectedNatInstanceId -and $Nats.Count -ne 1)"))
            .toBeLessThan(persistedIdentityAdoptionScript.indexOf("Set-VMSwitch -VMSwitch $Switch -Notes $Marker"));
        expect(persistedIdentityAdoptionScript.indexOf("[string]$Nats[0].InstanceID -cne $ExpectedNatInstanceId"))
            .toBeLessThan(persistedIdentityAdoptionScript.indexOf("Set-VMSwitch -VMSwitch $Switch -Notes $Marker"));
        expect(persistedIdentityAdoptionScript.indexOf("[string]$Nats[0].InternalIPInterfaceAddressPrefix -ne $Prefix"))
            .toBeLessThan(persistedIdentityAdoptionScript.indexOf("Set-VMSwitch -VMSwitch $Switch -Notes $Marker"));
        expect(persistedIdentityAdoptionScript).not.toContain("[regex]::Match");
        expect(persistedIdentityAdoptionScript).not.toContain(".Groups[1].Value");

        const stableToLegacyRepairScript = scriptOf(hyperVEnsureNetworkCommand({
            executable: "powershell.exe",
            switchName: "CCC Device Lab",
            natName: "CCCDeviceLab",
            marker: "ccc-device-lab:hyper-v-network:v1",
            allowExistingNat: true,
            allowPersistedCccIdentityRepair: true,
            expectedSwitchId: vmId,
            expectedNatInstanceId: "ccc-nat-instance-1",
            prefix: "172.29.0.0/24",
            gateway: "172.29.0.1",
            prefixLength: 24,
        }));
        expect(stableToLegacyRepairScript).toContain("$ExpectedStable = $true");
        expect(stableToLegacyRepairScript).toContain("$ExpectedToken = $false");
        expect(stableToLegacyRepairScript).toContain("$ExpectedTokenValue = ''");
        expect(stableToLegacyRepairScript).toContain("$StableToToken = $ExpectedStable -and $NatName -ceq 'CCCDeviceLab' -and $ObservedToken");
        expect(stableToLegacyRepairScript).toContain("-not $ExpectedSwitchId -or -not $ExpectedNatInstanceId");
        const requiredNatIdentityCheck = "if ($ExpectedNatInstanceId -and $Nats.Count -ne 1) { throw 'hyper-v-network-nat-identity-conflict' }";
        expect(stableToLegacyRepairScript).toContain(requiredNatIdentityCheck);
        expect(stableToLegacyRepairScript.indexOf(requiredNatIdentityCheck))
            .toBeLessThan(stableToLegacyRepairScript.indexOf("if ($Nats.Count -eq 0) { $Nat = New-NetNat"));
        expect(stableToLegacyRepairScript).toContain("if ($ObservedStable) { $NatName = 'CCCDeviceLab' } else { $NatName = 'CCCDeviceLab-' + $ObservedTokenValue }");
        expect(parseHyperVNetworkObservation(JSON.stringify({
            ok: true,
            switchName: "CCC Device Lab",
            switchId: vmId,
            marker: "foreign-marker",
            natName: "CCCDeviceLab",
            natInstanceId: "ccc-nat-instance-1",
            prefix: "172.29.0.0/24",
            gateway: "172.29.0.1",
            interfaceIndex: 42,
            createdSwitch: false,
            createdNat: false,
        }))).toBeNull();

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
        expect(cleanupScript).toContain("$RemoveSwitch = $true");
        expect(cleanupScript).toContain("$RemoveGateway = $true");
        expect(cleanupScript).toContain(`$ExpectedSwitchId = '${vmId}'`);
        expect(cleanupScript).toContain("hyper-v-network-nat-identity-conflict");
        expect(cleanupScript).toContain("hyper-v-network-switch-ownership-conflict");
        expect(cleanupScript).toContain("$DeferredReason = 'hyper-v-network-switch-in-use'");
        expect(cleanupScript).toContain("deferred = $true; reason = $DeferredReason");
        expect(cleanupScript).toContain("Get-VMNetworkAdapter -All -ErrorAction Stop");
        expect(cleanupScript).toContain("hyper-v-network-switch-attachment-inspection-failed");
        expect(cleanupScript.match(/Get-VMNetworkAdapter -All -ErrorAction Stop/g)).toHaveLength(2);
        expect(cleanupScript.indexOf("hyper-v-network-nat-identity-conflict"))
            .toBeLessThan(cleanupScript.indexOf("Remove-VMSwitch -VMSwitch"));
        expect(cleanupScript).toContain("Remove-NetNat");
        expect(cleanupScript).toContain("Remove-VMSwitch");
        expect(cleanupScript).toContain("$RequiresMutation = ($Switches.Count -eq 1 -and ($RemoveSwitch -or $RemoveGateway)) -or ($Nats.Count -eq 1 -and $RemoveNat)");
        expect(cleanupScript).toContain("[string]$Switch.Notes -cne $Marker");
        expect(cleanupScript).toContain("hyper-v-network-elevation-required");
        expect(() => hyperVCleanupNetworkCommand({
            executable: "powershell.exe",
            switchName: "CCC Device Lab",
            natName: "CCCDeviceLab",
            marker: "ccc-device-lab:hyper-v-network:v1",
            prefix: "172.29.0.0/24",
            gateway: "172.29.0.1",
            prefixLength: 24,
            removeSwitch: true,
        })).toThrow("hyper-v-network-switch-id-invalid");
        expect(parseHyperVNetworkCleanupObservation(JSON.stringify({ ok: true, removedSwitch: true, removedNat: true, removedGateway: true, alreadyMissing: false }))).toEqual(expect.objectContaining({ removedSwitch: true }));
        expect(parseHyperVNetworkCleanupObservation(JSON.stringify({ ok: true, removedSwitch: false, removedNat: false, removedGateway: false, alreadyMissing: false, deferred: true, reason: "hyper-v-network-switch-in-use" }))).toEqual(expect.objectContaining({ deferred: true, reason: "hyper-v-network-switch-in-use" }));
        expect(parseHyperVNetworkCleanupObservation(JSON.stringify({ ok: true, removedSwitch: false, removedNat: false, removedGateway: false, alreadyMissing: false, deferred: true, reason: "other-error" }))).toBeNull();
        expect(parseHyperVNetworkCleanupObservation('{"ok":true,"removedSwitch":true}')).toBeNull();

        const preserveForeignNat = scriptOf(hyperVCleanupNetworkCommand({
            executable: "powershell.exe",
            switchName: "CCC Device Lab",
            natName: "CCCDeviceLab",
            marker: "ccc-device-lab:hyper-v-network:v1",
            prefix: "172.29.0.0/24",
            gateway: "172.29.0.1",
            prefixLength: 24,
            expectedSwitchId: vmId,
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
        expect(elevated).toContain("-WindowStyle Hidden -PassThru");
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
        expect(elevatedInner).toContain("$Stage = [string]$env:CCC_HYPER_V_STAGE");
        expect(elevatedInner).toContain("elseif ($Stage -match '^hyper-v-[a-z0-9-]{3,128}$') { $Stage }");
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
        const networkDiagnosticCodes = [...new Set(
            [script, cleanupScript, elevated, elevatedInner]
                .flatMap((source) => [...source.matchAll(/\bhyper-v-network-[a-z0-9-]{3,128}\b/g)])
                .map((match) => match[0]),
        )];
        expect(networkDiagnosticCodes.length).toBeGreaterThan(20);
        for (const code of networkDiagnosticCodes) {
            expect(hyperVProviderDiagnosticCode({ stderr: code, stdout: "" }))
                .toBe(code);
        }
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
            baseImageGeneration: 2,
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
            baseImageGeneration: 2,
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
        expect(script).toContain("powershell-direct-authentication-failed");
        expect(script).toContain("$Failure | ConvertTo-Json");
        expect(script).toContain("hyper-v-vm-ownership-mismatch");
        expect(parseHyperVGuestReadyObservation(JSON.stringify({ ok: true, vmId: vmId.toUpperCase(), vmName, computerName: "CCC-WIN", attempts: 4 })))
            .toEqual({ ok: true, vmId, vmName, computerName: "CCC-WIN", attempts: 4 });
        expect(parseHyperVGuestReadyObservation(JSON.stringify({ ok: true, vmId, vmName, computerName: "", attempts: 0 }))).toBeNull();
        expect(parseHyperVGuestReadyFailureObservation(JSON.stringify({ ok: false, error: "hyper-v-guest-ready-timeout", reason: "powershell-direct-session-unavailable", attempts: 150 })))
            .toEqual({ ok: false, error: "hyper-v-guest-ready-timeout", reason: "powershell-direct-session-unavailable", attempts: 150 });
        expect(parseHyperVGuestReadyFailureObservation(JSON.stringify({ ok: false, error: "hyper-v-guest-ready-timeout", reason: "C:\\secret", attempts: 150 }))).toBeNull();
        expect(parseHyperVGuestReadyFailureObservation(JSON.stringify({ ok: false, error: "hyper-v-guest-ready-timeout", reason: `hyper-v-${"x".repeat(121)}`, attempts: 150 }))).toBeNull();
        const cappedCommand = hyperVGuestReadyCommand({
            executable: "powershell.exe",
            ownerId,
            deviceId,
            incarnationId,
            vmName,
            vmId,
            deviceRoot,
            credentialPath,
            provisioningMediaPath,
            timeoutMs: Number.MAX_SAFE_INTEGER,
        });
        expect(scriptOf(cappedCommand)).toContain("[DateTime]::UtcNow.AddMilliseconds(1200000)");
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

    it("collects bounded owner-fenced Hyper-V boot diagnostics", () => {
        const vmName = hyperVVmName(ownerId, deviceId, incarnationId);
        const command = hyperVGuestBootDiagnosticCommand({
            executable: "powershell.exe",
            ownerId,
            deviceId,
            incarnationId,
            vmName,
            vmId,
            diskPath: "/state/root.vhdx",
        });
        const script = scriptOf(command);
        expect(command.args).toContain("-File");
        expect(JSON.parse(command.input || "{}")).toEqual({
            schemaVersion: 1,
            vmId,
            vmName,
            ownershipMarker: `ccc-device-lab:${ownerId}:${deviceId}:${incarnationId}`,
        });
        expect(script).toContain("Get-CccGuestBootDiagnosticResult $Vm");
        expect(parseHyperVGuestBootDiagnosticObservation(JSON.stringify({
            ok: true,
            vmId: vmId.toUpperCase(),
            vmName,
            state: "Running",
            uptimeMs: 600123,
            generation: 2,
            secureBootEnabled: true,
            heartbeatEnabled: true,
            heartbeatPrimaryStatus: 2,
            heartbeatSecondaryStatus: 0,
            integrationServices: [{ name: "Heartbeat", enabled: true, primaryStatus: 2, secondaryStatus: 0 }],
            hardDiskCount: 1,
            dvdCount: 1,
            hardDiskControllers: ["scsi"],
            bootDeviceTypes: ["hard-disk", "dvd", "network"],
        }))).toEqual({
            ok: true,
            vmId,
            vmName,
            state: "Running",
            uptimeMs: 600123,
            generation: 2,
            secureBootEnabled: true,
            heartbeatEnabled: true,
            heartbeatPrimaryStatus: 2,
            heartbeatSecondaryStatus: 0,
            integrationServices: [{ name: "Heartbeat", enabled: true, primaryStatus: 2, secondaryStatus: 0 }],
            hardDiskCount: 1,
            dvdCount: 1,
            hardDiskControllers: ["scsi"],
            bootDeviceTypes: ["hard-disk", "dvd", "network"],
        });
        expect(parseHyperVGuestBootDiagnosticObservation(JSON.stringify({
            ok: true,
            vmId,
            vmName,
            state: "Running",
            uptimeMs: 1,
            generation: 2,
            secureBootEnabled: true,
            heartbeatEnabled: true,
            heartbeatPrimaryStatus: 2,
            heartbeatSecondaryStatus: 0,
            integrationServices: [],
            hardDiskCount: 1,
            dvdCount: 1,
            hardDiskControllers: ["scsi"],
            bootDeviceTypes: ["C:\\secret"],
        }))).toBeNull();
        expect(parseHyperVGuestBootDiagnosticObservation(JSON.stringify({
            ok: true,
            vmId,
            vmName,
            state: "Running",
            uptimeMs: 1,
            generation: 1,
            secureBootEnabled: null,
            heartbeatEnabled: true,
            heartbeatPrimaryStatus: 2,
            heartbeatSecondaryStatus: 0,
            integrationServices: [],
            hardDiskCount: 1,
            dvdCount: 1,
            hardDiskControllers: ["ide"],
            bootDeviceTypes: Array(9).fill("hard-disk"),
        }))).toBeNull();
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
        expect(script).toContain("Write-CccIso $IsoFiles $ProvisioningMedia 'CCC_UNATTEND' $MediaSourceRoot");
        expect(script).toContain("$NormalizedVolumeName = ([string]$VolumeName).ToUpperInvariant()");
        expect(script).toContain("$Image.FileSystemsToCreate = 7");
        expect(script).toContain("<settings pass=\"specialize\">");
        expect(script).toContain("<ComputerName>*</ComputerName>");
        expect(script).toContain("Microsoft-Windows-Deployment");
        expect(script).toContain("Create CCC PowerShell Direct account");
        expect(script).toContain("Get-LocalGroup -SID 'S-1-5-32-544'");
        expect(script).not.toContain("<UserAccounts>");
        expect(script.indexOf("<settings pass=\"specialize\">")).toBeLessThan(script.indexOf("<settings pass=\"oobeSystem\">"));
        expect(script).toContain("try { $Image.ChooseImageDefaultsForMediaType(1) } catch");
        expect(script).toContain("$Image.VolumeName = $NormalizedVolumeName");
        expect(script).toContain("hyper-v-provisioning-media-filesystem-selection-failed");
        expect(script).toContain("hyper-v-provisioning-media-volume-name-failed");
        expect(script).toContain("configure-failed|filesystem-selection-failed|volume-name-invalid|volume-name-failed|source-entry-invalid");
        expect(script).toContain("[int]$ResultImage.BlockSize, [long]$ResultImage.TotalBlocks");
        expect(script).toContain("SHCreateStreamOnFileEx");
        expect(script).toContain("input.CopyTo(output, expectedBytes, readPointer, writtenPointer)");
        expect(script).toContain("hyper-v-provisioning-media-copy-incomplete");
        expect(script).toContain("hyper-v-provisioning-media-result-image-failed");
        expect(script).toContain("@($ImageStream, $ResultImage, $ImageRoot, $Image)");
        expect(script).toContain("FinalReleaseComObject($ComObject)");
        expect(script).toContain("[IO.File]::WriteAllBytes($EntryPath, $EntryBytes)");
        expect(script).toContain("$ImageRoot.AddTree($SourceRoot, $false)");
        expect(script).toContain("[Console]::Out.WriteLine('hyper-v-provisioning-media-add-tree-failed')");
        expect(script).toContain("[Console]::Out.WriteLine('hyper-v-provisioning-media-output-open-failed')");
        expect(script).toContain("[Console]::Out.WriteLine($CccIsoFailure)");
        expect(script).toContain("Assert-NoReparsePath $SourceRoot");
        expect(script).toContain("function Remove-CccIsoSourceRoot");
        expect(script).toContain("Get-ChildItem -LiteralPath $SourceRoot -Force");
        expect(script).toContain("$CurrentChild = Get-Item -LiteralPath $SourceChild.FullName");
        expect(script).toContain("$SourceAcl.SetAccessRuleProtection($true, $false)");
        expect(script).toContain("[Security.AccessControl.FileSystemAccessRule]::new(");
        expect(script).not.toContain("New-Object Security.AccessControl.FileSystemAccessRule(");
        expect(script).toContain("hyper-v-provisioning-media-source-cleanup-failed");
        expect(script.indexOf("if ($null -ne $CccIsoFailure) { [Console]::Out.WriteLine($CccIsoFailure); throw $CccIsoFailure }")).toBeGreaterThan(script.indexOf("finally {"));
        expect(script).not.toContain("Remove-Item -LiteralPath $SourceRoot -Recurse");
        expect(script).not.toContain("ADODB.Stream");
        expect(script).not.toContain("$SourceStream.Close()");
        expect(script).not.toContain("CreateStreamOnHGlobal");
        expect(script).not.toContain("[CccIsoStreamWriter]::CreateSource");
        expect(script).not.toContain("$ImageRoot.AddFile(");
        expect(script).toContain("Remove-Item -LiteralPath $IsoPath -Force -ErrorAction SilentlyContinue");
        expect(script).not.toContain("input.Read(");
        expect(script).toContain("Add-VMDvdDrive -VM $Vm -Path $ProvisioningMedia");
        expect(script).not.toContain("$ProvisioningSource");
        expect(script).toContain("Get-VMHardDiskDrive -VM $Vm");
        expect(script).not.toContain("Mount-VHD -Path $DiskPath");
        expect(script).not.toContain("Add-PartitionAccessPath");
        expect(script).toContain("EnableSecureBoot On -SecureBootTemplate 'MicrosoftWindows'");
        expect(script).toContain("hyper-v-guest-secure-boot-not-enabled");
        expect(script).toContain("Enable-VMIntegrationService");
        expect(script).toContain("hyper-v-guest-integration-services-not-enabled");
        expect(script).not.toContain("$PantherDirectory");
        expect(script).toContain("Microsoft-Windows-Shell-Setup");
        expect(script).toContain("Export-Clixml -LiteralPath $CredentialPath");
        expect(script).toContain("Remove CCC bootstrap secrets");
        expect(script).toContain("function Set-CccProvisionStage");
        expect(script).toContain("Set-CccProvisionStage 'vm-lookup'");
        expect(script).toContain("Set-CccProvisionStage 'input-validation'");
        expect(script).toContain("Set-CccProvisionStage 'credential'");
        expect(script).toContain("Set-CccProvisionStage 'media-check'");
        expect(script).toContain("Set-CccProvisionStage 'media-content'");
        expect(script).toContain("Set-CccProvisionStage 'media-build'");
        expect(script).toContain("Set-CccProvisionStage 'media-attach'");
        expect(script).toContain("[Console]::Out.WriteLine(('CCC_HYPER_V_STAGE:hyper-v-guest-provision-' + $Stage + '-command-failed'))");
        expect(script).toContain("hyper-v-guest-provision-' + $CccProvisionStage + '-command-failed");
        expect(script).not.toContain(guestPassword);
        expect(command.args.join(" ")).not.toContain(guestPassword);
        const payloadBase64 = script.match(/\$CccCommandInputBase64 = '([A-Za-z0-9+/=]+)'/)?.[1];
        expect(payloadBase64).toBeTruthy();
        expect(JSON.parse(Buffer.from(payloadBase64!, "base64").toString("utf8")))
            .toEqual({ username: "ccc01234567", password: guestPassword });
        const loader = loaderOf(command);
        expect(loader).toContain("hyper-v-powershell-parse-failed");
        expect(loader).toContain("hyper-v-powershell-execution-failed");
        expect(loader).toContain("$env:CCC_HYPER_V_STAGE=$null");
        expect(loader).toContain("if($M-match'^hyper-v-[a-z0-9-]{3,128}$')");
        expect(loader).toContain("$S=$env:CCC_HYPER_V_STAGE;if($S-match'^hyper-v-[a-z0-9-]{3,128}$'){throw $S}");
        expect(loader).not.toContain(guestPassword);
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
