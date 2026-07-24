import { isAbsolute, relative, resolve, sep } from "path";

export type HyperVProviderCommand = {
    mode: "exec";
    provider: "hyper-v" | "hyper-v-ssh" | "hyper-v-scp";
    executable: string;
    args: string[];
    input?: string;
};

export type HyperVReadiness = {
    ok: boolean;
    available: boolean;
    platform: string;
    moduleAvailable: boolean;
    hypervisorPresent: boolean;
    vmmsRunning: boolean;
    rebootPending: boolean;
    totalMemoryMb: number;
    freeMemoryMb: number;
    logicalProcessors: number;
    missing: string[];
    hyperVAdministratorsMember?: boolean;
    managementAccess?: boolean;
    sessionRefreshRequired?: boolean;
    detail?: string;
};

export type HyperVSetupObservation = {
    ok: boolean;
    featureName: "Microsoft-Hyper-V-All";
    beforeState: string;
    afterState: string;
    changed: boolean;
    elevated: boolean;
    rebootRequired: boolean;
    hyperVAdministratorsMember?: boolean;
    membershipChanged?: boolean;
    managementAccess?: boolean;
    sessionRefreshRequired?: boolean;
    network?: HyperVNetworkObservation;
};

export const HYPER_V_NETWORK_SWITCH = "CCC Device Lab";
export const HYPER_V_NETWORK_NAT = "CCCDeviceLab";
export const HYPER_V_NETWORK_MARKER = "ccc-device-lab:hyper-v-network:v1";
export const HYPER_V_NETWORK_PREFIX = "172.29.0.0/24";
export const HYPER_V_NETWORK_GATEWAY = "172.29.0.1";
export const HYPER_V_NETWORK_PREFIX_LENGTH = 24;

export type HyperVVmObservation = {
    ok: boolean;
    vmId: string;
    vmName: string;
    state: string;
    status: string;
    uptimeMs?: number;
    diskPath?: string;
    switchName?: string;
    snapshots?: HyperVSnapshotObservation[];
};

export type HyperVDeleteObservation = HyperVVmObservation & {
    deleted: true;
};

export type HyperVSnapshotObservation = {
    ok: boolean;
    snapshotId: string;
    snapshotName: string;
    state?: string;
    snapshotType?: string;
};

export type HyperVSnapshotDeleteObservation = HyperVSnapshotObservation & {
    deleted: true;
};

export type HyperVGuestExecObservation = {
    ok: boolean;
    status: number;
    stdout: string;
    stderr: string;
};

export type HyperVGuestTransferObservation = {
    ok: boolean;
    localPath: string;
    remotePath: string;
    bytes: number;
};

export type HyperVGuestProvisionObservation = {
    ok: boolean;
    vmId: string;
    vmName: string;
    guestUsername: string;
    credentialPath: string;
    unattendPath: string;
};

export type HyperVGuestReadyObservation = {
    ok: boolean;
    vmId: string;
    vmName: string;
    computerName: string;
    attempts: number;
    networkAddress?: string;
};

export type HyperVBaseImageObservation = {
    ok: boolean;
    profile: "windows-11" | "windows-server" | "ubuntu-lts";
    imagePath: string;
    sha256: string;
    sizeBytes: number;
    virtualSizeBytes: number;
    vhdType: string;
    reused: boolean;
};

export type HyperVNetworkObservation = {
    ok: boolean;
    switchName: string;
    switchId: string;
    natName: string;
    natInstanceId: string;
    prefix: string;
    gateway: string;
    interfaceIndex: number;
    createdSwitch: boolean;
    createdNat: boolean;
};

export type HyperVNetworkCleanupObservation = {
    ok: boolean;
    removedSwitch: boolean;
    removedNat: boolean;
    removedGateway: boolean;
    alreadyMissing: boolean;
};

export type HyperVRecoveryObservation = {
    ok: boolean;
    recoveredVm: boolean;
    removedDisk: boolean;
};

type HyperVCommandOptions = {
    executable: string;
    ownerId: string;
    deviceId: string;
    incarnationId: string;
    vmName: string;
    vmId?: string | null;
    diskPath?: string | null;
    auxiliaryDiskPaths?: string[];
    auxiliaryMediaPaths?: string[];
};

type HyperVCreateOptions = HyperVCommandOptions & {
    baseImagePath: string;
    baseImageSha256: string;
    baseImageRoot: string;
    deviceRoot: string;
    memoryMb: number;
    cpus: number;
    diskMaxBytes: number;
    switchName?: string | null;
    macAddress?: string | null;
    networking?: boolean;
    secureBootTemplate?: "MicrosoftWindows" | "MicrosoftUEFICertificateAuthority";
};

type HyperVStartOptions = HyperVCommandOptions & {
    memoryMb: number;
    cpus: number;
};

type HyperVRebootOptions = HyperVCommandOptions & {
    force?: boolean;
    startIfStopped?: boolean;
};

type HyperVSnapshotOptions = HyperVCommandOptions & {
    snapshotName: string;
    snapshotId?: string | null;
    force?: boolean;
};

type HyperVGuestOptions = HyperVCommandOptions & {
    deviceRoot: string;
    privateRoot?: string;
    credentialPath: string;
};

type HyperVGuestExecOptions = HyperVGuestOptions & {
    guestCommand: string;
};

type HyperVGuestTransferOptions = HyperVGuestOptions & {
    localPath: string;
    remotePath: string;
    maxBytes?: number;
};

type HyperVGuestProvisionOptions = HyperVGuestOptions & {
    provisioningMediaPath: string;
    guestUsername: string;
    guestPassword: string;
    networkAddress?: string | null;
    networkGateway?: string | null;
    networkPrefixLength?: number | null;
};

type HyperVGuestReadyOptions = HyperVGuestOptions & {
    timeoutMs: number;
    expectedNetworkAddress?: string | null;
    provisioningMediaPath?: string | null;
};

type HyperVBaseImageOptions = {
    executable: string;
    profile: "windows-11" | "windows-server" | "ubuntu-lts";
    sourceImagePath: string;
    sourceRoot: string;
    imagePath: string;
    imageRoot: string;
};

export type HyperVAutomaticBaseImageProfile = "windows-server" | "ubuntu-lts";

export type HyperVAcquireBaseImageOptions = {
    executable: string;
    profile: HyperVAutomaticBaseImageProfile;
    imageRoot: string;
};

type HyperVLinuxSeedOptions = HyperVCommandOptions & {
    deviceRoot: string;
    privateRoot: string;
    seedDiskPath: string;
    sshPrivateKeyPath: string;
    sshPublicKeyPath: string;
    sshHostPrivateKeyPath: string;
    sshHostPublicKeyPath: string;
    knownHostsPath: string;
    guestUsername: string;
    networkAddress: string;
    networkGateway: string;
    networkPrefixLength: number;
    dnsServers?: string[];
};

type HyperVLinuxSshOptions = {
    executable: string;
    deviceRoot: string;
    privateRoot?: string;
    sshPrivateKeyPath: string;
    knownHostsPath: string;
    guestUsername: string;
    networkAddress: string;
    timeoutMs?: number;
};

export type HyperVNetworkOptions = {
    executable: string;
    switchName: string;
    natName: string;
    prefix: string;
    gateway: string;
    prefixLength: number;
    marker: string;
    allowExistingNat?: boolean;
    expectedSwitchId?: string;
    expectedNatInstanceId?: string;
    elevated?: boolean;
    elevatedDeadlineUnixMs?: number;
};

type HyperVNetworkCleanupOptions = HyperVNetworkOptions & {
    removeNat?: boolean;
};

const OWNER_ID_PATTERN = /^[a-f0-9]{16}$/;
const DEVICE_ID_PATTERN = /^(?!\.\.?$)[A-Za-z0-9._:-]{1,128}$/;
const INCARNATION_ID_PATTERN = /^[a-f0-9]{32}$/;
const VM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SNAPSHOT_NAME_PATTERN = /^(?!\.\.?$)[A-Za-z0-9._-]{1,64}$/;

function psQuote(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function encodedPowerShell(script: string): string {
    return Buffer.from(script, "utf16le").toString("base64");
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
    if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`hyper-v-${label}-invalid`);
    return value;
}

function assertIdentity(options: HyperVCommandOptions): void {
    if (!OWNER_ID_PATTERN.test(options.ownerId)) throw new Error("hyper-v-owner-id-invalid");
    if (!DEVICE_ID_PATTERN.test(options.deviceId)) throw new Error("hyper-v-device-id-invalid");
    if (!INCARNATION_ID_PATTERN.test(options.incarnationId)) throw new Error("hyper-v-incarnation-id-invalid");
    if (options.vmName !== hyperVVmName(options.ownerId, options.deviceId, options.incarnationId)) throw new Error("hyper-v-vm-name-not-owner-scoped");
    if (options.vmId && !VM_ID_PATTERN.test(options.vmId)) throw new Error("hyper-v-vm-id-invalid");
}

function assertPlainPath(value: string, label: string): string {
    if (!value || value.includes("\0") || !isAbsolute(value)) throw new Error(`hyper-v-${label}-invalid`);
    return resolve(value);
}

function assertPathInside(root: string, candidate: string, label: string): string {
    const resolvedRoot = assertPlainPath(root, `${label}-root`);
    const resolvedCandidate = assertPlainPath(candidate, label);
    const rel = relative(resolvedRoot, resolvedCandidate);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error(`hyper-v-${label}-outside-owner-root`);
    }
    return resolvedCandidate;
}

function ownershipMarker(ownerId: string, deviceId: string, incarnationId: string): string {
    return `ccc-device-lab:${ownerId}:${deviceId}:${incarnationId}`;
}

function jsonScript(lines: string[]): string {
    return [
        "$ErrorActionPreference = 'Stop'",
        "$ProgressPreference = 'SilentlyContinue'",
        "$TrustedModuleRoot = Join-Path $PSHOME 'Modules'",
        "$env:PSModulePath = $TrustedModuleRoot",
        "Import-Module Hyper-V -ErrorAction Stop",
        "function Assert-NoReparsePath([string]$Path) {",
        "  $FullPath = [IO.Path]::GetFullPath($Path)",
        "  $PathRoot = [IO.Path]::GetPathRoot($FullPath)",
        "  if (-not $PathRoot) { throw 'hyper-v-path-root-invalid' }",
        "  $Current = $PathRoot",
        "  $Remainder = $FullPath.Substring($PathRoot.Length)",
        "  foreach ($Segment in @($Remainder -split '[\\\\/]' | Where-Object { $_ })) {",
        "    $Current = Join-Path $Current $Segment",
        "    if (Test-Path -LiteralPath $Current) {",
        "      $Item = Get-Item -LiteralPath $Current -Force -ErrorAction Stop",
        "      if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'hyper-v-path-reparse-point-rejected' }",
        "    }",
        "  }",
        "}",
        ...lines,
    ].join("\n");
}

function command(executable: string, script: string, input?: string): HyperVProviderCommand {
    const encodedScript = input === undefined
        ? script
        : ["$CccCommandInput = [Console]::In.ReadToEnd()", script].join("\n");
    const encoded = encodedPowerShell(encodedScript);
    if (encoded.length > 24000) {
        const program = input === undefined
            ? script
            : [
                `$CccCommandInputBase64 = ${psQuote(Buffer.from(input, "utf8").toString("base64"))}`,
                "$CccCommandInput = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($CccCommandInputBase64))",
                "$CccCommandInputBase64 = $null",
                script,
            ].join("\n");
        const loader = [
            "$ErrorActionPreference = 'Stop'",
            "$CccEncodedProgram = [Console]::In.ReadToEnd().Trim()",
            "if (-not $CccEncodedProgram -or $CccEncodedProgram.Length -gt 16777216) { throw 'hyper-v-powershell-program-invalid' }",
            "$CccProgramBytes = [Convert]::FromBase64String($CccEncodedProgram)",
            "if ($CccProgramBytes.Length -eq 0 -or $CccProgramBytes.Length -gt 12582912) { throw 'hyper-v-powershell-program-invalid' }",
            "$CccProgram = [Text.Encoding]::UTF8.GetString($CccProgramBytes)",
            "$CccEncodedProgram = $null",
            "$CccProgramBytes = $null",
            "& ([ScriptBlock]::Create($CccProgram))",
        ].join("\n");
        return {
            mode: "exec",
            provider: "hyper-v",
            executable,
            args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedPowerShell(loader)],
            input: Buffer.from(program, "utf8").toString("base64"),
        };
    }
    return {
        mode: "exec",
        provider: "hyper-v",
        executable,
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
        ...(input !== undefined ? { input } : {}),
    };
}

function isoWriterLines(): string[] {
    return [
        "if (-not ('CccIsoStreamWriter' -as [type])) {",
        "  Add-Type -TypeDefinition @'",
        "using System;",
        "using System.IO;",
        "using System.Runtime.InteropServices;",
        "using System.Runtime.InteropServices.ComTypes;",
        "public static class CccIsoStreamWriter {",
        "  [DllImport(\"shlwapi.dll\", CharSet = CharSet.Unicode, PreserveSig = true)]",
        "  private static extern int SHCreateStreamOnFileEx(string path, uint mode, uint attributes, bool create, IStream template, out IStream stream);",
        "  public static void Write(object source, string destination, int blockSize, long totalBlocks) {",
        "    if (blockSize <= 0 || blockSize > 1048576) throw new ArgumentOutOfRangeException(\"blockSize\", \"hyper-v-provisioning-media-block-invalid\");",
        "    if (totalBlocks <= 0 || totalBlocks > (long.MaxValue / blockSize)) throw new ArgumentOutOfRangeException(\"totalBlocks\", \"hyper-v-provisioning-media-block-invalid\");",
        "    IStream input = source as IStream;",
        "    if (input == null) throw new InvalidCastException(\"hyper-v-provisioning-media-stream-invalid\");",
        "    long expectedBytes = checked((long)blockSize * totalBlocks);",
        "    IStream output = null;",
        "    IntPtr readPointer = Marshal.AllocHGlobal(sizeof(long));",
        "    IntPtr writtenPointer = Marshal.AllocHGlobal(sizeof(long));",
        "    try {",
        "      const uint STGM_WRITE_CREATE_EXCLUSIVE = 0x00001011;",
        "      const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;",
        "      int result = SHCreateStreamOnFileEx(destination, STGM_WRITE_CREATE_EXCLUSIVE, FILE_ATTRIBUTE_NORMAL, true, null, out output);",
        "      if (result < 0 || output == null) throw new IOException(\"hyper-v-provisioning-media-output-open-failed\");",
        "      Marshal.WriteInt64(readPointer, 0);",
        "      Marshal.WriteInt64(writtenPointer, 0);",
        "      input.CopyTo(output, expectedBytes, readPointer, writtenPointer);",
        "      long readBytes = Marshal.ReadInt64(readPointer);",
        "      long writtenBytes = Marshal.ReadInt64(writtenPointer);",
        "      if (readBytes != expectedBytes || writtenBytes != expectedBytes) throw new EndOfStreamException(\"hyper-v-provisioning-media-copy-incomplete\");",
        "      output.Commit(0);",
        "    } finally {",
        "      if (output != null && Marshal.IsComObject(output)) { try { Marshal.FinalReleaseComObject(output); } catch {} }",
        "      Marshal.FreeHGlobal(readPointer);",
        "      Marshal.FreeHGlobal(writtenPointer);",
        "    }",
        "  }",
        "}",
        "'@ -Language CSharp -ErrorAction Stop",
        "}",
        "function Assert-NoReparseTree([string]$Path) {",
        "  Assert-NoReparsePath $Path",
        "  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw 'hyper-v-provisioning-source-missing' }",
        "  $Pending = New-Object 'System.Collections.Generic.Stack[string]'",
        "  $Pending.Push([IO.Path]::GetFullPath($Path))",
        "  while ($Pending.Count -gt 0) {",
        "    $Current = $Pending.Pop()",
        "    foreach ($Child in @(Get-ChildItem -LiteralPath $Current -Force -ErrorAction Stop)) {",
        "      if (($Child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'hyper-v-provisioning-source-reparse-point-rejected' }",
        "      if ($Child.PSIsContainer) { $Pending.Push($Child.FullName) }",
        "    }",
        "  }",
        "}",
        "function Write-CccIso([string]$SourceRoot, [string]$IsoPath, [string]$VolumeName) {",
        "  Assert-NoReparsePath $SourceRoot",
        "  Assert-NoReparsePath $IsoPath",
        "  if (-not (Test-Path -LiteralPath $SourceRoot -PathType Container)) { throw 'hyper-v-provisioning-source-missing' }",
        "  if (Test-Path -LiteralPath $IsoPath) { Remove-Item -LiteralPath $IsoPath -Force -ErrorAction Stop }",
        "  $Image = $null",
        "  $ImageRoot = $null",
        "  $ResultImage = $null",
        "  $ImageStream = $null",
        "  try {",
        "    try { $Image = New-Object -ComObject IMAPI2FS.MsftFileSystemImage } catch { throw 'hyper-v-provisioning-media-com-unavailable' }",
        "    try {",
        "      $Image.ChooseImageDefaultsForMediaType(1)",
        "      $Image.FileSystemsToCreate = 3",
        "      $Image.VolumeName = $VolumeName",
        "    } catch { throw 'hyper-v-provisioning-media-configure-failed' }",
        "    try { Assert-NoReparseTree $SourceRoot; $ImageRoot = $Image.Root; $ImageRoot.AddTree($SourceRoot, $false) } catch {",
        "      if ([string]$_.Exception.Message -eq 'hyper-v-provisioning-source-reparse-point-rejected') { throw }",
        "      throw 'hyper-v-provisioning-media-source-tree-failed'",
        "    }",
        "    try { $ResultImage = $Image.CreateResultImage() } catch { throw 'hyper-v-provisioning-media-result-image-failed' }",
        "    $ImageStream = $ResultImage.ImageStream",
        "    [CccIsoStreamWriter]::Write($ImageStream, $IsoPath, [int]$ResultImage.BlockSize, [long]$ResultImage.TotalBlocks)",
        "  } catch {",
        "    if (Test-Path -LiteralPath $IsoPath) { Remove-Item -LiteralPath $IsoPath -Force -ErrorAction SilentlyContinue }",
        "    $Cause = $_.Exception",
        "    for ($Depth = 0; $Cause -and $Depth -lt 8; $Depth++) {",
        "      $CauseMessage = [string]$Cause.Message",
        "      if ($CauseMessage -match '\\b(hyper-v-provisioning-(?:source-reparse-point-rejected|media-(?:block-invalid|stream-invalid|output-open-failed|copy-incomplete|com-unavailable|configure-failed|source-tree-failed|result-image-failed)))\\b') { throw [string]$Matches[1] }",
        "      $Cause = $Cause.InnerException",
        "    }",
        "    throw 'hyper-v-provisioning-media-create-failed'",
        "  } finally {",
        "    foreach ($ComObject in @($ImageStream, $ResultImage, $ImageRoot, $Image)) {",
        "      if ($null -ne $ComObject -and [Runtime.InteropServices.Marshal]::IsComObject($ComObject)) {",
        "        try { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($ComObject) | Out-Null } catch {}",
        "      }",
        "    }",
        "    $ImageStream = $null; $ResultImage = $null; $ImageRoot = $null; $Image = $null",
        "  }",
        "  $IsoItem = Get-Item -LiteralPath $IsoPath -Force -ErrorAction Stop",
        "  if ($IsoItem.Length -le 0 -or $IsoItem.Length -gt 32MB -or ($IsoItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {",
        "    Remove-Item -LiteralPath $IsoPath -Force -ErrorAction SilentlyContinue",
        "    throw 'hyper-v-provisioning-media-invalid'",
        "  }",
        "}",
    ];
}

function elevatedNetworkCommand(executable: string, networkScript: string, deadlineUnixMs: number): HyperVProviderCommand {
    if (!Number.isSafeInteger(deadlineUnixMs) || deadlineUnixMs <= 0) throw new Error("hyper-v-network-deadline-invalid");
    const programEncoded = Buffer.from(networkScript, "utf8").toString("base64");
    const innerScript = [
        "$ErrorActionPreference = 'Stop'",
        "$PipeName = '__CCC_HYPER_V_NETWORK_PIPE_NAME__'",
        `$DeadlineUnixMs = [long]${deadlineUnixMs}`,
        "$Envelope = $null",
        "$Watchdog = $null",
        "$WatchdogStartTicks = $null",
        "$TrustedModuleRoot = Join-Path $PSHOME 'Modules'",
        "$env:PSModulePath = $TrustedModuleRoot",
        "if ($PipeName -notmatch '^ccc-hyper-v-network-[a-f0-9]{32}$') { throw 'hyper-v-network-pipe-name-invalid' }",
        "$Pipe = [IO.Pipes.NamedPipeClientStream]::new('.', $PipeName, [IO.Pipes.PipeDirection]::InOut)",
        "$Pipe.Connect(5000)",
        "$Reader = [IO.StreamReader]::new($Pipe, [Text.UTF8Encoding]::new($false), $false, 4096, $true)",
        "$Writer = [IO.StreamWriter]::new($Pipe, [Text.UTF8Encoding]::new($false), 4096, $true)",
        "try {",
        "  $RemainingMs = $DeadlineUnixMs - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()",
        "  if ($RemainingMs -le 0) { throw 'hyper-v-network-operation-deadline-exceeded' }",
        "  $SelfStartTicks = (Get-Process -Id $PID -ErrorAction Stop).StartTime.ToUniversalTime().Ticks",
        "  $WatchdogDelayMs = [int][Math]::Min([long][int]::MaxValue, [Math]::Max([long]1, $RemainingMs))",
        "  $WatchdogSource = \"Start-Sleep -Milliseconds $WatchdogDelayMs; `$Target = Get-Process -Id $PID -ErrorAction SilentlyContinue; if (`$Target -and `$Target.StartTime.ToUniversalTime().Ticks -eq $SelfStartTicks) { Stop-Process -Id $PID -Force -ErrorAction SilentlyContinue }\"",
        "  $WatchdogEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($WatchdogSource))",
        "  $Watchdog = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',$WatchdogEncoded) -WindowStyle Hidden -PassThru -ErrorAction Stop",
        "  $WatchdogStartTicks = $Watchdog.StartTime.ToUniversalTime().Ticks",
        "  if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge $DeadlineUnixMs) { throw 'hyper-v-network-operation-deadline-exceeded' }",
        "  $ProgramEncoded = $Reader.ReadLine()",
        "  if (-not $ProgramEncoded -or $ProgramEncoded.Length -gt 16777216 -or $ProgramEncoded -notmatch '^[A-Za-z0-9+/]+={0,2}$') { throw 'hyper-v-network-program-invalid' }",
        "  $Program = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ProgramEncoded))",
        "  if (-not $Program -or $Program.Length -gt 12582912) { throw 'hyper-v-network-program-invalid' }",
        "  $Output = @(& ([ScriptBlock]::Create($Program)))",
        "  $OutputText = ($Output | Out-String -Width 4096).Trim()",
        "  if ($OutputText.Length -gt 65536) { throw 'hyper-v-network-result-too-large' }",
        "  $Envelope = [ordered]@{ ok = $true; output = $OutputText }",
        "} catch {",
        "  $Candidate = [string]$_.Exception.Message",
        "  $ErrorCode = if ($Candidate -match '^hyper-v-[a-z0-9:-]+$') { $Candidate } else { 'hyper-v-network-elevated-operation-failed' }",
        "  $Envelope = [ordered]@{ ok = $false; error = $ErrorCode }",
        "} finally {",
        "  try { $Writer.Write(($Envelope | ConvertTo-Json -Compress -Depth 5)); $Writer.Flush() } catch {}",
        "  try { $Reader.Dispose(); $Writer.Dispose(); $Pipe.Dispose() } catch {}",
        "  if ($Watchdog -and $WatchdogStartTicks) { $ObservedWatchdog = Get-Process -Id $Watchdog.Id -ErrorAction SilentlyContinue; if ($ObservedWatchdog -and $ObservedWatchdog.StartTime.ToUniversalTime().Ticks -eq $WatchdogStartTicks) { Stop-Process -Id $Watchdog.Id -Force -ErrorAction SilentlyContinue } }",
        "}",
        "if (-not $Envelope.ok) { exit 1 }",
    ].join("\n");
    const innerEncoded = encodedPowerShell(innerScript);
    const outerScript = [
        "$ErrorActionPreference = 'Stop'",
        "$ProgressPreference = 'SilentlyContinue'",
        `$Executable = ${psQuote(executable)}`,
        `$DeadlineUnixMs = [long]${deadlineUnixMs}`,
        `$InnerEncodedTemplate = ${psQuote(innerEncoded)}`,
        `$ProgramEncoded = ${psQuote(programEncoded)}`,
        "$PipeName = 'ccc-hyper-v-network-' + [Guid]::NewGuid().ToString('N')",
        "Add-Type -TypeDefinition @'",
        "using System;",
        "using System.Runtime.InteropServices;",
        "public static class CccHyperVNetworkPipeNative {",
        "  [DllImport(\"kernel32.dll\", SetLastError = true)]",
        "  [return: MarshalAs(UnmanagedType.Bool)]",
        "  public static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint clientProcessId);",
        "}",
        "'@",
        "$PipeSecurity = [IO.Pipes.PipeSecurity]::new()",
        "$AdministratorsSid = [Security.Principal.SecurityIdentifier]'S-1-5-32-544'",
        "$PipeRule = [IO.Pipes.PipeAccessRule]::new($AdministratorsSid, [IO.Pipes.PipeAccessRights]::ReadWrite, [Security.AccessControl.AccessControlType]::Allow)",
        "$PipeSecurity.SetAccessRule($PipeRule)",
        "$Pipe = [IO.Pipes.NamedPipeServerStream]::new($PipeName, [IO.Pipes.PipeDirection]::InOut, 1, [IO.Pipes.PipeTransmissionMode]::Byte, [IO.Pipes.PipeOptions]::Asynchronous, 4096, 4096, $PipeSecurity)",
        "$InnerSource = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($InnerEncodedTemplate)).Replace('__CCC_HYPER_V_NETWORK_PIPE_NAME__', $PipeName)",
        "$InnerEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($InnerSource))",
        "$Wait = $null",
        "$Child = $null",
        "$ChildStartTicks = $null",
        "$OperationCompleted = $false",
        "try {",
        "  $HandshakeRemainingMs = $DeadlineUnixMs - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()",
        "  if ($HandshakeRemainingMs -le 0) { throw 'hyper-v-network-operation-deadline-exceeded' }",
        "  $Wait = $Pipe.BeginWaitForConnection($null, $null)",
        "  try { $Child = Start-Process -FilePath $Executable -Verb RunAs -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',$InnerEncoded) -PassThru -ErrorAction Stop } catch { if ($_.Exception -is [ComponentModel.Win32Exception] -and $_.Exception.NativeErrorCode -eq 1223) { throw 'hyper-v-network-elevation-cancelled' }; $ElevationHResult = [Math]::Abs([long]$_.Exception.HResult); throw ('hyper-v-network-elevation-failed:' + $ElevationHResult) }",
        "  $ChildStartTicks = $Child.StartTime.ToUniversalTime().Ticks",
        "  $HandshakeWaitMs = [int][Math]::Min([long]120000, [Math]::Max([long]1, $HandshakeRemainingMs))",
        "  if (-not $Wait.AsyncWaitHandle.WaitOne($HandshakeWaitMs)) { throw 'hyper-v-network-pipe-handshake-timeout' }",
        "  $Pipe.EndWaitForConnection($Wait)",
        "  [uint32]$ClientProcessId = 0",
        "  if (-not [CccHyperVNetworkPipeNative]::GetNamedPipeClientProcessId($Pipe.SafePipeHandle.DangerousGetHandle(), [ref]$ClientProcessId) -or $ClientProcessId -ne [uint32]$Child.Id) { throw 'hyper-v-network-pipe-client-mismatch' }",
        "  $Writer = [IO.StreamWriter]::new($Pipe, [Text.UTF8Encoding]::new($false), 4096, $true)",
        "  $Writer.WriteLine($ProgramEncoded)",
        "  $Writer.Flush()",
        "  $Writer.Dispose()",
        "  $Reader = [IO.StreamReader]::new($Pipe, [Text.UTF8Encoding]::new($false), $false, 4096, $true)",
        "  $EnvelopeJson = $Reader.ReadToEnd()",
        "  $Reader.Dispose()",
        "  if (-not $EnvelopeJson -or $EnvelopeJson.Length -gt 131072) { throw 'hyper-v-network-result-invalid' }",
        "  $Envelope = $EnvelopeJson | ConvertFrom-Json -ErrorAction Stop",
        "  if (-not $Envelope.ok) { $ChildError = [string]$Envelope.error; if ($ChildError -notmatch '^hyper-v-[a-z0-9:-]+$') { $ChildError = 'hyper-v-network-elevated-operation-failed' }; throw $ChildError }",
        "  if (-not $Child.WaitForExit(10000) -or $Child.ExitCode -ne 0) { throw 'hyper-v-network-elevated-operation-failed' }",
        "  $OperationCompleted = $true",
        "  Write-Output ([string]$Envelope.output)",
        "} finally {",
        "  if ($Wait) { $Wait.AsyncWaitHandle.Dispose() }",
        "  if ($Pipe) { $Pipe.Dispose() }",
        "  if (-not $OperationCompleted -and $Child -and $ChildStartTicks) { $ObservedChild = Get-Process -Id $Child.Id -ErrorAction SilentlyContinue; if ($ObservedChild -and $ObservedChild.StartTime.ToUniversalTime().Ticks -eq $ChildStartTicks) { Stop-Process -Id $Child.Id -Force -ErrorAction SilentlyContinue } }",
        "  if (-not $OperationCompleted -and $Child) { try { if (-not $Child.WaitForExit(5000)) { throw 'hyper-v-network-elevated-child-termination-unconfirmed' } } catch { if ([string]$_.Exception.Message -eq 'hyper-v-network-elevated-child-termination-unconfirmed') { throw } } }",
        "}",
    ].join("\n");
    return command(executable, outerScript);
}

function ownedVmPrelude(options: HyperVCommandOptions): string[] {
    assertIdentity(options);
    if (!options.vmId) throw new Error("hyper-v-vm-id-missing");
    const marker = ownershipMarker(options.ownerId, options.deviceId, options.incarnationId);
    return [
        `$ExpectedId = [Guid]${psQuote(options.vmId)}`,
        `$ExpectedName = ${psQuote(options.vmName)}`,
        `$ExpectedMarker = ${psQuote(marker)}`,
        "$Vm = Get-VM -Id $ExpectedId -ErrorAction Stop",
        "if ($Vm.Name -ne $ExpectedName -or [string]$Vm.Notes -cne $ExpectedMarker) { throw 'hyper-v-vm-ownership-mismatch' }",
    ];
}

function ownedSnapshotPrelude(options: HyperVSnapshotOptions): string[] {
    const lines = ownedVmPrelude(options);
    const providerName = hyperVSnapshotName(options.ownerId, options.snapshotName);
    if (options.snapshotId && !VM_ID_PATTERN.test(options.snapshotId)) throw new Error("hyper-v-snapshot-id-invalid");
    return [
        ...lines,
        `$ExpectedSnapshotName = ${psQuote(providerName)}`,
        ...(options.snapshotId ? [`$ExpectedSnapshotId = [Guid]${psQuote(options.snapshotId)}`] : []),
        `$Snapshot = @(Get-VMSnapshot -VM $Vm -ErrorAction Stop | Where-Object { $_.Name -eq $ExpectedSnapshotName${options.snapshotId ? " -and $_.Id -eq $ExpectedSnapshotId" : ""} })`,
        "if ($Snapshot.Count -ne 1) { throw 'hyper-v-snapshot-ownership-mismatch' }",
        "$Snapshot = $Snapshot[0]",
    ];
}

function guestSessionPrelude(options: HyperVGuestOptions): string[] {
    const lines = ownedVmPrelude(options);
    const credentialPath = assertPathInside(options.privateRoot || options.deviceRoot, options.credentialPath, "guest-credential-path");
    return [
        ...lines,
        `$CredentialPath = ${psQuote(credentialPath)}`,
        "if ($Vm.State -ne 'Running') { throw 'hyper-v-guest-requires-running-vm' }",
        "if (-not (Test-Path -LiteralPath $CredentialPath -PathType Leaf)) { throw 'hyper-v-guest-credential-unavailable' }",
        "$Credential = Import-Clixml -LiteralPath $CredentialPath -ErrorAction Stop",
        "if ($Credential -isnot [System.Management.Automation.PSCredential]) { throw 'hyper-v-guest-credential-invalid' }",
        "$Session = New-PSSession -VMId $ExpectedId -Credential $Credential -ErrorAction Stop",
    ];
}

function assertGuestPath(value: string): string {
    if (!value || value.length > 4096 || value.includes("\0") || !/^[A-Za-z]:\\/.test(value)) {
        throw new Error("hyper-v-guest-path-invalid");
    }
    return value;
}

function assertLinuxGuestPath(value: string): string {
    if (!value || value.length > 4096 || !/^\/[A-Za-z0-9._/+~=-]*$/.test(value)) {
        throw new Error("hyper-v-linux-guest-path-invalid");
    }
    return value;
}

function assertLinuxUsername(value: string): string {
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(value)) throw new Error("hyper-v-linux-guest-username-invalid");
    return value;
}

function assertIpv4(value: string, label: string): string {
    const parts = value.split(".");
    if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) {
        throw new Error(`hyper-v-${label}-invalid`);
    }
    return value;
}

function sshBaseArgs(options: HyperVLinuxSshOptions): string[] {
    const privateRoot = options.privateRoot || options.deviceRoot;
    const privateKeyPath = assertPathInside(privateRoot, options.sshPrivateKeyPath, "linux-ssh-private-key");
    const knownHostsPath = assertPathInside(privateRoot, options.knownHostsPath, "linux-ssh-known-hosts");
    const username = assertLinuxUsername(options.guestUsername);
    const address = assertIpv4(options.networkAddress, "linux-network-address");
    const timeoutSec = Math.min(30, Math.max(1, Math.ceil((options.timeoutMs || 30000) / 1000)));
    return [
        "-F", "NUL",
        "-i", privateKeyPath,
        "-o", "BatchMode=yes",
        "-o", "IdentitiesOnly=yes",
        "-o", "StrictHostKeyChecking=yes",
        "-o", `UserKnownHostsFile=${knownHostsPath}`,
        "-o", `ConnectTimeout=${timeoutSec}`,
        "-o", "ConnectionAttempts=1",
        `${username}@${address}`,
    ];
}

export function hyperVVmName(ownerId: string, deviceId: string, incarnationId: string): string {
    if (!OWNER_ID_PATTERN.test(ownerId)) throw new Error("hyper-v-owner-id-invalid");
    if (!DEVICE_ID_PATTERN.test(deviceId)) throw new Error("hyper-v-device-id-invalid");
    if (!INCARNATION_ID_PATTERN.test(incarnationId)) throw new Error("hyper-v-incarnation-id-invalid");
    const suffix = deviceId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "vm";
    return `ccc-${ownerId}-${suffix}-${incarnationId}`;
}

export function hyperVSnapshotName(ownerId: string, snapshotName: string): string {
    if (!OWNER_ID_PATTERN.test(ownerId)) throw new Error("hyper-v-owner-id-invalid");
    if (!SNAPSHOT_NAME_PATTERN.test(snapshotName)) throw new Error("hyper-v-snapshot-name-invalid");
    return `ccc-${ownerId}-${snapshotName}`;
}

export function hyperVReadinessCommand(executable: string): HyperVProviderCommand {
    const script = [
        "$ModuleAvailable = [bool](Get-Module -ListAvailable -Name Hyper-V | Select-Object -First 1)",
        "$ComputerInfo = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue",
        "$OperatingSystem = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue",
        "$HypervisorPresent = [bool]$ComputerInfo.HypervisorPresent",
        "$Vmms = Get-Service -Name vmms -ErrorAction SilentlyContinue",
        "$VmmsRunning = [bool]($Vmms -and $Vmms.Status -eq 'Running')",
        "$HyperVAdministratorsMember = $false",
        "$ManagementAccess = $false",
        "$SessionRefreshRequired = $false",
        "$CurrentUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
        "try { $HyperVAdministratorsMember = [bool]@(Get-LocalGroupMember -SID ([Security.Principal.SecurityIdentifier]'S-1-5-32-578') -ErrorAction Stop | Where-Object { $_.SID.Value -eq $CurrentUserSid }).Count } catch { $HyperVAdministratorsMember = $false }",
        "if ($ModuleAvailable -and $VmmsRunning) { try { @(Get-VM -ErrorAction Stop) | Out-Null; $ManagementAccess = $true } catch { $ManagementAccess = $false } }",
        "$SessionRefreshRequired = $HyperVAdministratorsMember -and -not $ManagementAccess",
        "$RebootPending = (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending') -or (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired')",
        "$Missing = @()",
        "if (-not $ModuleAvailable) { $Missing += 'hyper-v-powershell-module' }",
        "if (-not $HypervisorPresent) { $Missing += 'hypervisor' }",
        "if (-not $VmmsRunning) { $Missing += 'vmms-service' }",
        "if ($ModuleAvailable -and $VmmsRunning -and -not $ManagementAccess) { $Missing += 'hyper-v-management-permission' }",
        "$TotalMemoryMb = if ($ComputerInfo) { [Math]::Floor([double]$ComputerInfo.TotalPhysicalMemory / 1MB) } else { 0 }",
        "$FreeMemoryMb = if ($OperatingSystem) { [Math]::Floor([double]$OperatingSystem.FreePhysicalMemory / 1KB) } else { 0 }",
        "$LogicalProcessors = if ($ComputerInfo) { [int]$ComputerInfo.NumberOfLogicalProcessors } else { 0 }",
        "$Result = [ordered]@{ ok = $true; available = ($Missing.Count -eq 0); platform = 'win32'; moduleAvailable = $ModuleAvailable; hypervisorPresent = $HypervisorPresent; vmmsRunning = $VmmsRunning; rebootPending = [bool]$RebootPending; totalMemoryMb = [long]$TotalMemoryMb; freeMemoryMb = [long]$FreeMemoryMb; logicalProcessors = $LogicalProcessors; missing = $Missing; hyperVAdministratorsMember = [bool]$HyperVAdministratorsMember; managementAccess = [bool]$ManagementAccess; sessionRefreshRequired = [bool]$SessionRefreshRequired }",
        "$Result | ConvertTo-Json -Compress -Depth 5",
    ].join("\n");
    return command(executable, script);
}

export function hyperVRebootCommand(options: HyperVRebootOptions): HyperVProviderCommand {
    return command(options.executable, jsonScript([
        ...ownedVmPrelude(options),
        `$Force = ${options.force === true ? "$true" : "$false"}`,
        `$StartIfStopped = ${options.startIfStopped === true ? "$true" : "$false"}`,
        "if ($Vm.State -eq 'Off') {",
        "  if (-not $StartIfStopped) { throw 'hyper-v-reboot-requires-running-vm' }",
        "  Start-VM -VM $Vm -ErrorAction Stop | Out-Null",
        "} elseif ($Vm.State -eq 'Running') {",
        "  Restart-VM -VM $Vm -Force:$Force -Confirm:$false -ErrorAction Stop | Out-Null",
        "} else { throw ('hyper-v-reboot-invalid-state:' + [string]$Vm.State) }",
        "$Vm = Get-VM -Id $ExpectedId -ErrorAction Stop",
        "$Disk = @(Get-VMHardDiskDrive -VM $Vm -ErrorAction Stop | Select-Object -First 1)",
        "$Switch = @(Get-VMNetworkAdapter -VM $Vm -ErrorAction SilentlyContinue | Select-Object -First 1)",
        "$Result = [ordered]@{ ok = $true; vmId = [string]$Vm.Id; vmName = $Vm.Name; state = [string]$Vm.State; status = [string]$Vm.Status; uptimeMs = [long]$Vm.Uptime.TotalMilliseconds; diskPath = if ($Disk) { [string]$Disk.Path } else { $null }; switchName = if ($Switch) { [string]$Switch.SwitchName } else { $null } }",
        "$Result | ConvertTo-Json -Compress -Depth 6",
    ]));
}

export function hyperVSetupCommand(executable: string, networkOptions?: Omit<HyperVNetworkOptions, "executable" | "elevated" | "elevatedDeadlineUnixMs">): HyperVProviderCommand {
    const networkProgramEncoded = networkOptions
        ? Buffer.from(hyperVEnsureNetworkScript({ ...networkOptions, executable }), "utf8").toString("base64")
        : "";
    const trustedModulePrelude = [
        "$TrustedModuleRoot = Join-Path $PSHOME 'Modules'",
        "$env:PSModulePath = $TrustedModuleRoot",
        "$TrustedModulePrefix = $TrustedModuleRoot.TrimEnd('\\') + '\\'",
        "function Get-TrustedModuleManifest([string]$Name) {",
        "  $Candidates = @(Microsoft.PowerShell.Core\\Get-Module -ListAvailable -Name $Name | Where-Object { $_.Path -and $_.Path.StartsWith($TrustedModulePrefix, [StringComparison]::OrdinalIgnoreCase) } | Sort-Object Version -Descending)",
        "  if ($Candidates.Count -eq 0) { throw ('hyper-v-trusted-module-not-found:' + $Name) }",
        "  return [string]$Candidates[0].Path",
        "}",
        "$DismModule = Get-TrustedModuleManifest 'Dism'",
        "$LocalAccountsModule = Get-TrustedModuleManifest 'Microsoft.PowerShell.LocalAccounts'",
        "Microsoft.PowerShell.Core\\Import-Module -Name $DismModule -Force -ErrorAction Stop",
        "Microsoft.PowerShell.Core\\Import-Module -Name $LocalAccountsModule -Force -ErrorAction Stop",
    ];
    const innerScript = [
        "$ErrorActionPreference = 'Stop'",
        "$ProgressPreference = 'SilentlyContinue'",
        "$PipeName = '__CCC_HYPER_V_SETUP_PIPE_NAME__'",
        "$Envelope = $null",
        "$Watchdog = $null",
        "$WatchdogStartTicks = $null",
        "$ParentPid = [int]'__CCC_HYPER_V_SETUP_PARENT_PID__'",
        "$ParentStartTicks = [int64]'__CCC_HYPER_V_SETUP_PARENT_START_TICKS__'",
        "if ($PipeName -notmatch '^ccc-hyper-v-setup-[a-f0-9]{32}$') { throw 'hyper-v-setup-pipe-name-invalid' }",
        "$Pipe = [IO.Pipes.NamedPipeClientStream]::new('.', $PipeName, [IO.Pipes.PipeDirection]::InOut)",
        "$Pipe.Connect(5000)",
        "$Reader = [IO.StreamReader]::new($Pipe, [Text.UTF8Encoding]::new($false), $false, 4096, $true)",
        "$Writer = [IO.StreamWriter]::new($Pipe, [Text.UTF8Encoding]::new($false), 4096, $true)",
        "try {",
        "  $SelfStartTicks = (Get-Process -Id $PID -ErrorAction Stop).StartTime.ToUniversalTime().Ticks",
        "  $WatchdogSource = \"`$Deadline = (Get-Date).AddSeconds(780); while ((Get-Date) -lt `$Deadline) { Start-Sleep -Seconds 1; `$Parent = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue; if (-not `$Parent -or `$Parent.StartTime.ToUniversalTime().Ticks -ne $ParentStartTicks) { `$Target = Get-Process -Id $PID -ErrorAction SilentlyContinue; if (`$Target -and `$Target.StartTime.ToUniversalTime().Ticks -eq $SelfStartTicks) { Stop-Process -Id $PID -Force -ErrorAction SilentlyContinue }; exit } }; `$Target = Get-Process -Id $PID -ErrorAction SilentlyContinue; if (`$Target -and `$Target.StartTime.ToUniversalTime().Ticks -eq $SelfStartTicks) { Stop-Process -Id $PID -Force -ErrorAction SilentlyContinue }\"",
        "  $WatchdogEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($WatchdogSource))",
        "  $Watchdog = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',$WatchdogEncoded) -WindowStyle Hidden -PassThru -ErrorAction Stop",
        "  $WatchdogStartTicks = $Watchdog.StartTime.ToUniversalTime().Ticks",
        ...trustedModulePrelude.map((line) => `  ${line}`),
        "  $FeatureName = 'Microsoft-Hyper-V-All'",
        "  $FeatureInfo = Get-CimInstance -ClassName Win32_OptionalFeature -Filter \"Name='$FeatureName'\" -ErrorAction Stop",
        "  $BeforeState = if ($FeatureInfo -and [int]$FeatureInfo.InstallState -eq 1) { 'Enabled' } else { 'Disabled' }",
        "  $SetupUserSid = '__CCC_HYPER_V_SETUP_USER_SID__'",
        "  try { $SetupUserIdentifier = [Security.Principal.SecurityIdentifier]::new($SetupUserSid); $SetupUserAccount = $SetupUserIdentifier.Translate([Security.Principal.NTAccount]).Value } catch { throw 'hyper-v-setup-user-sid-invalid' }",
        "  $HyperVGroupSid = [Security.Principal.SecurityIdentifier]'S-1-5-32-578'",
        "  $WasMember = [bool]@(Microsoft.PowerShell.LocalAccounts\\Get-LocalGroupMember -SID $HyperVGroupSid -ErrorAction SilentlyContinue | Where-Object { $_.SID.Value -eq $SetupUserSid }).Count",
        "  if ($BeforeState -ne 'Enabled') { Dism\\Enable-WindowsOptionalFeature -Online -FeatureName $FeatureName -All -NoRestart -ErrorAction Stop | Out-Null }",
        "  $ExistingMember = @(Microsoft.PowerShell.LocalAccounts\\Get-LocalGroupMember -SID $HyperVGroupSid -ErrorAction Stop | Where-Object { $_.SID.Value -eq $SetupUserSid })",
        "  if ($ExistingMember.Count -eq 0) { Microsoft.PowerShell.LocalAccounts\\Add-LocalGroupMember -SID $HyperVGroupSid -Member $SetupUserAccount -ErrorAction Stop }",
        "  $AfterState = 'Enabled'",
        "  $AdministratorsMember = [bool]@(Microsoft.PowerShell.LocalAccounts\\Get-LocalGroupMember -SID $HyperVGroupSid -ErrorAction Stop | Where-Object { $_.SID.Value -eq $SetupUserSid }).Count",
        "  $Pending = (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending') -or (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired')",
        "  $Network = $null",
        "  $NetworkProgramEncoded = $Reader.ReadLine()",
        "  if ($NetworkProgramEncoded) {",
        "    if ($NetworkProgramEncoded.Length -gt 16777216 -or $NetworkProgramEncoded -notmatch '^[A-Za-z0-9+/]+={0,2}$') { throw 'hyper-v-setup-network-program-invalid' }",
        "    $NetworkProgram = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($NetworkProgramEncoded))",
        "    if (-not $NetworkProgram -or $NetworkProgram.Length -gt 12582912) { throw 'hyper-v-setup-network-program-invalid' }",
        "    $NetworkOutput = @(& ([ScriptBlock]::Create($NetworkProgram)))",
        "    $NetworkText = ($NetworkOutput | Out-String -Width 4096).Trim()",
        "    if (-not $NetworkText -or $NetworkText.Length -gt 65536) { throw 'hyper-v-setup-network-result-invalid' }",
        "    $Network = $NetworkText | ConvertFrom-Json -ErrorAction Stop",
        "    if (-not $Network.ok) { throw 'hyper-v-setup-network-failed' }",
        "  }",
        "  $Observation = [ordered]@{ ok = ($AfterState -eq 'Enabled' -and $AdministratorsMember); featureName = $FeatureName; beforeState = $BeforeState; afterState = $AfterState; changed = ($BeforeState -ne $AfterState); rebootRequired = [bool]$Pending; hyperVAdministratorsMember = [bool]$AdministratorsMember; membershipChanged = [bool](-not $WasMember -and $AdministratorsMember) }",
        "  if ($Network) { $Observation.network = $Network }",
        "  $Envelope = [ordered]@{ ok = $true; observation = $Observation }",
        "} catch {",
        "  $Candidate = [string]$_.Exception.Message",
        "  $ErrorCode = if ($Candidate -match '^hyper-v-[a-z0-9-]+$') { $Candidate } else { 'hyper-v-setup-elevated-operation-failed' }",
        "  $Envelope = [ordered]@{ ok = $false; error = $ErrorCode }",
        "} finally {",
        "  try {",
        "    $Writer.Write(($Envelope | ConvertTo-Json -Compress -Depth 8))",
        "    $Writer.Flush()",
        "    $Reader.Dispose()",
        "    $Writer.Dispose()",
        "    $Pipe.Dispose()",
        "  } catch {}",
        "  if ($Watchdog -and $WatchdogStartTicks) { $ObservedWatchdog = Get-Process -Id $Watchdog.Id -ErrorAction SilentlyContinue; if ($ObservedWatchdog -and $ObservedWatchdog.StartTime.ToUniversalTime().Ticks -eq $WatchdogStartTicks) { Stop-Process -Id $Watchdog.Id -Force -ErrorAction SilentlyContinue } }",
        "}",
        "if (-not $Envelope.ok) { exit 1 }",
    ].join("\n");
    const innerEncoded = encodedPowerShell(innerScript);
    const outerScript = [
        "$ErrorActionPreference = 'Stop'",
        "$ProgressPreference = 'SilentlyContinue'",
        `$Executable = ${psQuote(executable)}`,
        `$InnerEncoded = ${psQuote(innerEncoded)}`,
        `$NetworkProgramEncoded = ${psQuote(networkProgramEncoded)}`,
        "$IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
        "$SetupUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
        "$HyperVGroupSid = [Security.Principal.SecurityIdentifier]'S-1-5-32-578'",
        "$TokenHasHyperVGroup = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole($HyperVGroupSid)",
        "$PipeName = 'ccc-hyper-v-setup-' + [Guid]::NewGuid().ToString('N')",
        "Add-Type -TypeDefinition @'",
        "using System;",
        "using System.Runtime.InteropServices;",
        "public static class CccHyperVSetupPipeNative {",
        "  [DllImport(\"kernel32.dll\", SetLastError = true)]",
        "  [return: MarshalAs(UnmanagedType.Bool)]",
        "  public static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint clientProcessId);",
        "}",
        "'@",
        "$PipeSecurity = [IO.Pipes.PipeSecurity]::new()",
        "$ElevatedAdministratorsSid = [Security.Principal.SecurityIdentifier]'S-1-5-32-544'",
        "$PipeRule = [IO.Pipes.PipeAccessRule]::new($ElevatedAdministratorsSid, [IO.Pipes.PipeAccessRights]::ReadWrite, [Security.AccessControl.AccessControlType]::Allow)",
        "$PipeSecurity.SetAccessRule($PipeRule)",
        "$Pipe = [IO.Pipes.NamedPipeServerStream]::new($PipeName, [IO.Pipes.PipeDirection]::InOut, 1, [IO.Pipes.PipeTransmissionMode]::Byte, [IO.Pipes.PipeOptions]::Asynchronous, 4096, 4096, $PipeSecurity)",
        "$Wait = $null",
        "$Child = $null",
        "$ChildStartTicks = $null",
        "$OperationCompleted = $false",
        "$EnvelopeJson = $null",
        "$ParentStartTicks = (Get-Process -Id $PID -ErrorAction Stop).StartTime.ToUniversalTime().Ticks",
        "$InnerSource = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($InnerEncoded))",
        "$InnerSource = $InnerSource.Replace('__CCC_HYPER_V_SETUP_PIPE_NAME__', $PipeName).Replace('__CCC_HYPER_V_SETUP_USER_SID__', $SetupUserSid).Replace('__CCC_HYPER_V_SETUP_PARENT_PID__', [string]$PID).Replace('__CCC_HYPER_V_SETUP_PARENT_START_TICKS__', [string]$ParentStartTicks)",
        "$InnerEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($InnerSource))",
        "$InnerSource = $null",
        "try {",
        "  $Wait = $Pipe.BeginWaitForConnection($null, $null)",
        "  if ($IsAdmin) {",
        "    $Child = Start-Process -FilePath $Executable -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',$InnerEncoded) -PassThru -ErrorAction Stop",
        "  } else {",
        "    try { $Child = Start-Process -FilePath $Executable -Verb RunAs -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',$InnerEncoded) -PassThru -ErrorAction Stop } catch { throw 'hyper-v-setup-elevation-failed' }",
        "  }",
        "  $ChildStartTicks = $Child.StartTime.ToUniversalTime().Ticks",
        "  if (-not $Wait.AsyncWaitHandle.WaitOne(30000)) { try { if ($Child -and -not $Child.HasExited) { $Child.Kill() } } catch {}; throw 'hyper-v-setup-pipe-handshake-timeout' }",
        "  $Pipe.EndWaitForConnection($Wait)",
        "  [uint32]$ClientProcessId = 0",
        "  if (-not [CccHyperVSetupPipeNative]::GetNamedPipeClientProcessId($Pipe.SafePipeHandle.DangerousGetHandle(), [ref]$ClientProcessId) -or $ClientProcessId -ne [uint32]$Child.Id) { throw 'hyper-v-setup-pipe-client-mismatch' }",
        "  $Writer = [IO.StreamWriter]::new($Pipe, [Text.UTF8Encoding]::new($false), 4096, $true)",
        "  $Writer.WriteLine($NetworkProgramEncoded)",
        "  $Writer.Flush()",
        "  $Writer.Dispose()",
        "  $Reader = [IO.StreamReader]::new($Pipe, [Text.UTF8Encoding]::new($false), $false, 4096, $true)",
        "  $EnvelopeJson = $Reader.ReadToEnd()",
        "  $Reader.Dispose()",
        "  if (-not $EnvelopeJson -or $EnvelopeJson.Length -gt 65536) { throw 'hyper-v-setup-result-invalid' }",
        "  $Envelope = $EnvelopeJson | ConvertFrom-Json -ErrorAction Stop",
        "  if (-not $Envelope.ok) { $ChildError = [string]$Envelope.error; if ($ChildError -notmatch '^hyper-v-[a-z0-9-]+$') { $ChildError = 'hyper-v-setup-elevated-operation-failed' }; throw $ChildError }",
        "  if (-not $Child.WaitForExit(10000) -or $Child.ExitCode -ne 0) { throw 'hyper-v-setup-enable-failed' }",
        "  $Observation = $Envelope.observation",
        "  $ManagementAccess = $IsAdmin -or $TokenHasHyperVGroup",
        "  $SessionRefreshRequired = [bool]$Observation.hyperVAdministratorsMember -and -not $ManagementAccess",
        "  $Result = [ordered]@{ ok = [bool]$Observation.ok; featureName = [string]$Observation.featureName; beforeState = [string]$Observation.beforeState; afterState = [string]$Observation.afterState; changed = [bool]$Observation.changed; elevated = $IsAdmin; rebootRequired = [bool]$Observation.rebootRequired; hyperVAdministratorsMember = [bool]$Observation.hyperVAdministratorsMember; membershipChanged = [bool]$Observation.membershipChanged; managementAccess = [bool]$ManagementAccess; sessionRefreshRequired = [bool]$SessionRefreshRequired }",
        "  if ($Observation.network) { $Result.network = $Observation.network }",
        "  $OperationCompleted = $true",
        "  $Result | ConvertTo-Json -Compress -Depth 5",
        "} finally {",
        "  if ($Wait) { $Wait.AsyncWaitHandle.Dispose() }",
        "  if ($Pipe) { $Pipe.Dispose() }",
        "  if (-not $OperationCompleted -and $Child -and $ChildStartTicks) { $ObservedChild = Get-Process -Id $Child.Id -ErrorAction SilentlyContinue; if ($ObservedChild -and $ObservedChild.StartTime.ToUniversalTime().Ticks -eq $ChildStartTicks) { Stop-Process -Id $Child.Id -Force -ErrorAction SilentlyContinue } }",
        "  if (-not $OperationCompleted -and $Child) { try { if (-not $Child.WaitForExit(5000)) { throw 'hyper-v-setup-elevated-child-termination-unconfirmed' } } catch { if ([string]$_.Exception.Message -eq 'hyper-v-setup-elevated-child-termination-unconfirmed') { throw } } }",
        "}",
    ].join("\n");
    return command(executable, outerScript);
}

function hyperVEnsureNetworkScript(options: HyperVNetworkOptions): string {
    const switchName = String(options.switchName || "");
    const natName = String(options.natName || "");
    const prefix = String(options.prefix || "");
    const gateway = String(options.gateway || "");
    const marker = String(options.marker || "");
    if (!switchName || switchName.length > 64 || /[\u0000-\u001f]/.test(switchName)) throw new Error("hyper-v-network-switch-name-invalid");
    if (!natName || natName.length > 64 || !/^[A-Za-z0-9._-]+$/.test(natName)) throw new Error("hyper-v-network-nat-name-invalid");
    if (!/^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(prefix)) throw new Error("hyper-v-network-prefix-invalid");
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(gateway)) throw new Error("hyper-v-network-gateway-invalid");
    if (!/^ccc-device-lab:hyper-v-network:(?:v1|[a-f0-9]{24})$/.test(marker)) throw new Error("hyper-v-network-marker-invalid");
    const prefixLength = boundedInteger(options.prefixLength, 16, 30, "network-prefix-length");
    const allowExistingNat = options.allowExistingNat === true;
    const expectedSwitchId = String(options.expectedSwitchId || "").toLowerCase();
    const expectedNatInstanceId = String(options.expectedNatInstanceId || "");
    if (expectedSwitchId && !VM_ID_PATTERN.test(expectedSwitchId)) throw new Error("hyper-v-network-switch-id-invalid");
    if (expectedNatInstanceId && (expectedNatInstanceId.length > 256 || /[\u0000-\u001f]/.test(expectedNatInstanceId))) throw new Error("hyper-v-network-nat-instance-id-invalid");
    return jsonScript([
        `$SwitchName = ${psQuote(switchName)}`,
        `$NatName = ${psQuote(natName)}`,
        `$Prefix = ${psQuote(prefix)}`,
        `$Gateway = ${psQuote(gateway)}`,
        `$PrefixLength = ${prefixLength}`,
        `$AllowExistingNat = ${allowExistingNat ? "$true" : "$false"}`,
        `$ExpectedSwitchId = ${psQuote(expectedSwitchId)}`,
        `$ExpectedNatInstanceId = ${psQuote(expectedNatInstanceId)}`,
        `$Marker = ${psQuote(marker)}`,
        "function Convert-IPv4ToUInt32([string]$Address) { $Bytes = [Net.IPAddress]::Parse($Address).GetAddressBytes(); [Array]::Reverse($Bytes); return [BitConverter]::ToUInt32($Bytes, 0) }",
        "function Test-IPv4PrefixOverlap([string]$LeftAddress, [int]$LeftLength, [string]$RightAddress, [int]$RightLength) { $Length = [Math]::Min($LeftLength, $RightLength); $Mask = if ($Length -eq 0) { [uint32]0 } else { [uint32]([uint32]::MaxValue - [uint32]([Math]::Pow(2, 32 - $Length) - 1)) }; return ((Convert-IPv4ToUInt32 $LeftAddress) -band $Mask) -eq ((Convert-IPv4ToUInt32 $RightAddress) -band $Mask) }",
        "$CreatedSwitch = $false",
        "$CreatedGateway = $false",
        "$CreatedNat = $false",
        "$CreatedNatInstanceId = ''",
        "$Switches = @(Get-VMSwitch -Name $SwitchName -ErrorAction SilentlyContinue)",
        "if ($Switches.Count -gt 1) { throw 'hyper-v-network-switch-ambiguous' }",
        "$SwitchById = if ($ExpectedSwitchId) { Get-VMSwitch -Id ([Guid]$ExpectedSwitchId) -ErrorAction SilentlyContinue } else { $null }",
        "if ($ExpectedSwitchId -and ($Switches.Count -ne 1 -or -not $SwitchById -or $SwitchById.Name -ne $SwitchName -or $Switches[0].Id.ToString().ToLowerInvariant() -cne $ExpectedSwitchId)) { throw 'hyper-v-network-switch-identity-conflict' }",
        "$ExistingAdapterIndex = $null",
        "if ($Switches.Count -eq 1) { $ExistingAdapter = Get-NetAdapter -Name ('vEthernet (' + $SwitchName + ')') -ErrorAction SilentlyContinue; if ($ExistingAdapter) { $ExistingAdapterIndex = [int]$ExistingAdapter.ifIndex } }",
        "$PrefixParts = $Prefix.Split('/')",
        "$ForeignNats = @(Get-NetNat -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne $NatName })",
        "foreach ($ForeignNat in $ForeignNats) { $Parts = ([string]$ForeignNat.InternalIPInterfaceAddressPrefix).Split('/'); if ($Parts.Count -eq 2 -and (Test-IPv4PrefixOverlap $PrefixParts[0] $PrefixLength $Parts[0] ([int]$Parts[1]))) { throw 'hyper-v-network-subnet-conflict:nat' } }",
        "$ForeignAddresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254.*' -and ($null -eq $ExistingAdapterIndex -or [int]$_.InterfaceIndex -ne $ExistingAdapterIndex) })",
        "foreach ($ForeignAddress in $ForeignAddresses) { if (Test-IPv4PrefixOverlap $PrefixParts[0] $PrefixLength ([string]$ForeignAddress.IPAddress) ([int]$ForeignAddress.PrefixLength)) { throw 'hyper-v-network-subnet-conflict:interface' } }",
        "$Nats = @(Get-NetNat -Name $NatName -ErrorAction SilentlyContinue)",
        "if ($Nats.Count -gt 1) { throw 'hyper-v-network-nat-ambiguous' }",
        "if ($Nats.Count -eq 1 -and [string]$Nats[0].InternalIPInterfaceAddressPrefix -ne $Prefix) { throw 'hyper-v-network-nat-prefix-conflict' }",
        "if ($Nats.Count -eq 1 -and -not $AllowExistingNat) { throw 'hyper-v-network-nat-ownership-conflict' }",
        "if ($Nats.Count -eq 1 -and $ExpectedNatInstanceId -and ([string]$Nats[0].InstanceID -cne $ExpectedNatInstanceId)) { throw 'hyper-v-network-nat-identity-conflict' }",
        "$IsAdministrator = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
        "$GatewayExists = if ($ExistingAdapterIndex) { [bool]@(Get-NetIPAddress -InterfaceIndex $ExistingAdapterIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -eq $Gateway -and $_.PrefixLength -eq $PrefixLength }).Count } else { $false }",
        "$RequiresMutation = ($Switches.Count -eq 0) -or (-not $GatewayExists) -or ($Nats.Count -eq 0)",
        "if ($RequiresMutation -and -not $IsAdministrator) { throw 'hyper-v-network-elevation-required' }",
        "try {",
        "  if ($Switches.Count -eq 0) { $Switch = New-VMSwitch -Name $SwitchName -SwitchType Internal -Notes $Marker -ErrorAction Stop; $CreatedSwitch = $true; $Switch = Get-VMSwitch -Id $Switch.Id -ErrorAction Stop } else { $Switch = $Switches[0] }",
        "  if ([string]$Switch.SwitchType -ne 'Internal') { throw 'hyper-v-network-switch-type-conflict' }",
        "  if ([string]$Switch.Notes -ne $Marker) { throw 'hyper-v-network-switch-ownership-conflict' }",
        "  $Adapter = Get-NetAdapter -Name ('vEthernet (' + $SwitchName + ')') -ErrorAction Stop",
        "  $GatewayMatches = @(Get-NetIPAddress -InterfaceIndex $Adapter.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -eq $Gateway -and $_.PrefixLength -eq $PrefixLength })",
        "  if ($GatewayMatches.Count -eq 0) {",
        "    $AdapterAddresses = @(Get-NetIPAddress -InterfaceIndex $Adapter.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.PrefixOrigin -ne 'WellKnown' -and $_.IPAddress -ne '169.254.0.0' })",
        "    if ($AdapterAddresses.Count -gt 0) { throw 'hyper-v-network-gateway-conflict' }",
        "    New-NetIPAddress -InterfaceIndex $Adapter.ifIndex -IPAddress $Gateway -PrefixLength $PrefixLength -AddressFamily IPv4 -ErrorAction Stop | Out-Null; $CreatedGateway = $true",
        "  }",
        "  if ($Nats.Count -eq 0) { $Nat = New-NetNat -Name $NatName -InternalIPInterfaceAddressPrefix $Prefix -ErrorAction Stop; $CreatedNat = $true; $CreatedNatInstanceId = [string]$Nat.InstanceID; if (-not $CreatedNatInstanceId) { throw 'hyper-v-network-nat-identity-unavailable' } } else { $Nat = $Nats[0] }",
        "  if ([string]$Nat.InternalIPInterfaceAddressPrefix -ne $Prefix) { throw 'hyper-v-network-nat-prefix-conflict' }",
        "  $NatInstanceId = [string]$Nat.InstanceID",
        "  if (-not $NatInstanceId) { throw 'hyper-v-network-nat-identity-unavailable' }",
        "  $Result = [ordered]@{ ok = $true; switchName = $Switch.Name; switchId = [string]$Switch.Id; natName = $Nat.Name; natInstanceId = $NatInstanceId; prefix = [string]$Nat.InternalIPInterfaceAddressPrefix; gateway = $Gateway; interfaceIndex = [int]$Adapter.ifIndex; createdSwitch = $CreatedSwitch; createdNat = $CreatedNat }",
        "  $Result | ConvertTo-Json -Compress -Depth 5",
        "} catch {",
        "  if ($CreatedNat) { $RollbackNats = @(Get-NetNat -Name $NatName -ErrorAction SilentlyContinue); if ($RollbackNats.Count -ne 1 -or [string]$RollbackNats[0].InstanceID -cne $CreatedNatInstanceId) { throw 'hyper-v-network-nat-rollback-identity-conflict' }; Remove-NetNat -InputObject $RollbackNats[0] -Confirm:$false -ErrorAction Stop }",
        "  if ($CreatedGateway -and $Adapter) { Get-NetIPAddress -InterfaceIndex $Adapter.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -eq $Gateway -and $_.PrefixLength -eq $PrefixLength } | Remove-NetIPAddress -Confirm:$false -ErrorAction SilentlyContinue }",
        "  if ($CreatedSwitch -and $Switch) { Remove-VMSwitch -VMSwitch $Switch -Force -Confirm:$false -ErrorAction SilentlyContinue }",
        "  throw",
        "}",
    ]);
}

export function hyperVEnsureNetworkCommand(options: HyperVNetworkOptions): HyperVProviderCommand {
    const script = hyperVEnsureNetworkScript(options);
    return options.elevated
        ? elevatedNetworkCommand(options.executable, script, Number(options.elevatedDeadlineUnixMs))
        : command(options.executable, script);
}

export function hyperVCleanupNetworkCommand(options: HyperVNetworkCleanupOptions): HyperVProviderCommand {
    const switchName = String(options.switchName || "");
    const natName = String(options.natName || "");
    const prefix = String(options.prefix || "");
    const gateway = String(options.gateway || "");
    const marker = String(options.marker || "");
    if (!switchName || switchName.length > 64 || /[\u0000-\u001f]/.test(switchName)) throw new Error("hyper-v-network-switch-name-invalid");
    if (!natName || natName.length > 64 || !/^[A-Za-z0-9._-]+$/.test(natName)) throw new Error("hyper-v-network-nat-name-invalid");
    if (!/^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(prefix)) throw new Error("hyper-v-network-prefix-invalid");
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(gateway)) throw new Error("hyper-v-network-gateway-invalid");
    if (!/^ccc-device-lab:hyper-v-network:(?:v1|[a-f0-9]{24})$/.test(marker)) throw new Error("hyper-v-network-marker-invalid");
    const prefixLength = boundedInteger(options.prefixLength, 16, 30, "network-prefix-length");
    const removeNat = options.removeNat === true;
    const expectedSwitchId = String(options.expectedSwitchId || "").toLowerCase();
    const expectedNatInstanceId = String(options.expectedNatInstanceId || "");
    if (expectedSwitchId && !VM_ID_PATTERN.test(expectedSwitchId)) throw new Error("hyper-v-network-switch-id-invalid");
    if (removeNat && (!expectedNatInstanceId || expectedNatInstanceId.length > 256 || /[\u0000-\u001f]/.test(expectedNatInstanceId))) throw new Error("hyper-v-network-nat-instance-id-invalid");
    const script = jsonScript([
        `$SwitchName = ${psQuote(switchName)}`,
        `$NatName = ${psQuote(natName)}`,
        `$Prefix = ${psQuote(prefix)}`,
        `$Gateway = ${psQuote(gateway)}`,
        `$PrefixLength = ${prefixLength}`,
        `$RemoveNat = ${removeNat ? "$true" : "$false"}`,
        `$ExpectedSwitchId = ${psQuote(expectedSwitchId)}`,
        `$ExpectedNatInstanceId = ${psQuote(expectedNatInstanceId)}`,
        `$Marker = ${psQuote(marker)}`,
        "$RemovedSwitch = $false",
        "$RemovedNat = $false",
        "$RemovedGateway = $false",
        "$Switches = @(Get-VMSwitch -Name $SwitchName -ErrorAction SilentlyContinue)",
        "if ($Switches.Count -gt 1) { throw 'hyper-v-network-switch-ambiguous' }",
        "$SwitchById = if ($ExpectedSwitchId) { Get-VMSwitch -Id ([Guid]$ExpectedSwitchId) -ErrorAction SilentlyContinue } else { $null }",
        "if ($ExpectedSwitchId -and (($Switches.Count -eq 1 -and (-not $SwitchById -or $SwitchById.Name -ne $SwitchName -or $Switches[0].Id.ToString().ToLowerInvariant() -cne $ExpectedSwitchId)) -or ($Switches.Count -eq 0 -and $SwitchById))) { throw 'hyper-v-network-switch-identity-conflict' }",
        "$Nats = @(Get-NetNat -Name $NatName -ErrorAction SilentlyContinue)",
        "if ($Nats.Count -gt 1) { throw 'hyper-v-network-nat-ambiguous' }",
        "if ($Switches.Count -eq 1) {",
        "  $Switch = $Switches[0]",
        "  if ([string]$Switch.SwitchType -ne 'Internal' -or [string]$Switch.Notes -ne $Marker) { throw 'hyper-v-network-switch-ownership-conflict' }",
        "  $Attached = @(Get-VMNetworkAdapter -All -ErrorAction SilentlyContinue | Where-Object { $_.SwitchName -eq $SwitchName })",
        "  if ($Attached.Count -gt 0) { throw 'hyper-v-network-switch-in-use' }",
        "}",
        "$IsAdministrator = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
        "$RequiresMutation = ($Switches.Count -eq 1) -or ($Nats.Count -eq 1 -and $RemoveNat)",
        "if ($RequiresMutation -and -not $IsAdministrator) { throw 'hyper-v-network-elevation-required' }",
        "if ($Nats.Count -eq 1 -and $RemoveNat) { if ([string]$Nats[0].InternalIPInterfaceAddressPrefix -ne $Prefix) { throw 'hyper-v-network-nat-prefix-conflict' }; if ([string]$Nats[0].InstanceID -cne $ExpectedNatInstanceId) { throw 'hyper-v-network-nat-identity-conflict' }; Remove-NetNat -InputObject $Nats[0] -Confirm:$false -ErrorAction Stop; $RemovedNat = $true }",
        "if ($Switches.Count -eq 1) {",
        "  $Adapter = Get-NetAdapter -Name ('vEthernet (' + $SwitchName + ')') -ErrorAction SilentlyContinue",
        "  if ($Adapter) { $GatewayMatches = @(Get-NetIPAddress -InterfaceIndex $Adapter.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -eq $Gateway -and $_.PrefixLength -eq $PrefixLength }); foreach ($Match in $GatewayMatches) { Remove-NetIPAddress -InputObject $Match -Confirm:$false -ErrorAction Stop; $RemovedGateway = $true } }",
        "  Remove-VMSwitch -VMSwitch $Switches[0] -Force -Confirm:$false -ErrorAction Stop",
        "  $RemovedSwitch = $true",
        "}",
        "$Result = [ordered]@{ ok = $true; removedSwitch = $RemovedSwitch; removedNat = $RemovedNat; removedGateway = $RemovedGateway; alreadyMissing = (-not $RemovedSwitch -and -not $RemovedNat -and -not $RemovedGateway) }",
        "$Result | ConvertTo-Json -Compress -Depth 5",
    ]);
    return options.elevated
        ? elevatedNetworkCommand(options.executable, script, Number(options.elevatedDeadlineUnixMs))
        : command(options.executable, script);
}

export function hyperVCreateCommand(options: HyperVCreateOptions): HyperVProviderCommand {
    assertIdentity(options);
    const baseImagePath = assertPathInside(options.baseImageRoot, options.baseImagePath, "base-image-path");
    if (!/\.vhdx$/i.test(baseImagePath)) throw new Error("hyper-v-base-image-format-unsupported");
    const baseImageSha256 = String(options.baseImageSha256 || "").toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(baseImageSha256)) throw new Error("hyper-v-base-image-sha256-invalid");
    const deviceRoot = assertPlainPath(options.deviceRoot, "device-root");
    const diskPath = assertPathInside(deviceRoot, String(options.diskPath || ""), "disk-path");
    if (!/\.vhdx$/i.test(diskPath)) throw new Error("hyper-v-disk-format-unsupported");
    const memoryMb = boundedInteger(options.memoryMb, 1024, 131072, "memory-mb");
    const cpus = boundedInteger(options.cpus, 1, 64, "cpus");
    const diskMaxBytes = boundedInteger(options.diskMaxBytes, 1024 * 1024 * 1024, Number.MAX_SAFE_INTEGER, "disk-max-bytes");
    const marker = ownershipMarker(options.ownerId, options.deviceId, options.incarnationId);
    const secureBootTemplate = options.secureBootTemplate || "MicrosoftWindows";
    const switchName = options.switchName ? String(options.switchName) : "";
    if (switchName.length > 128 || /[\u0000-\u001f]/.test(switchName)) throw new Error("hyper-v-switch-name-invalid");
    const macAddress = options.macAddress ? String(options.macAddress).toUpperCase() : "";
    if (macAddress && !/^02(?::[0-9A-F]{2}){5}$/.test(macAddress)) throw new Error("hyper-v-mac-address-invalid");
    const lines = [
        `$VmName = ${psQuote(options.vmName)}`,
        `$Marker = ${psQuote(marker)}`,
        `$BaseImage = ${psQuote(baseImagePath)}`,
        `$ExpectedBaseImageHash = ${psQuote(baseImageSha256)}`,
        `$DeviceRoot = ${psQuote(deviceRoot)}`,
        `$DiskPath = ${psQuote(diskPath)}`,
        `$DiskMaxBytes = [long]${diskMaxBytes}`,
        `$SwitchName = ${psQuote(switchName)}`,
        `$MacAddress = ${psQuote(macAddress)}`,
        `$Networking = ${options.networking === false ? "$false" : "$true"}`,
        "$ComputerInfo = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop",
        "$TotalMemoryMb = [Math]::Floor([double]$ComputerInfo.TotalPhysicalMemory / 1MB)",
        "$MemoryReserveMb = [Math]::Max(2048, [Math]::Floor($TotalMemoryMb * 0.10))",
        `if (${memoryMb} -gt ($TotalMemoryMb - $MemoryReserveMb)) { throw 'hyper-v-host-memory-capacity-exceeded' }`,
        `if (${cpus} -gt ([int]$ComputerInfo.NumberOfLogicalProcessors * 2)) { throw 'hyper-v-host-cpu-capacity-exceeded' }`,
        "$DiskRoot = [IO.Path]::GetPathRoot($DiskPath)",
        "$DiskDriveName = $DiskRoot.TrimEnd('\\').TrimEnd(':')",
        "$DiskDrive = Get-PSDrive -Name $DiskDriveName -PSProvider FileSystem -ErrorAction Stop",
        "$DiskReserveBytes = 10GB",
        "if ([long]$DiskDrive.Free -lt ($DiskMaxBytes + $DiskReserveBytes)) { throw 'hyper-v-host-disk-capacity-exceeded' }",
        "Assert-NoReparsePath $BaseImage",
        "Assert-NoReparsePath $DeviceRoot",
        "Assert-NoReparsePath $DiskPath",
        "if (-not (Test-Path -LiteralPath $BaseImage -PathType Leaf)) { throw 'hyper-v-base-image-not-found' }",
        "if (Get-VM -Name $VmName -ErrorAction SilentlyContinue) { throw 'hyper-v-vm-already-exists' }",
        "$DeviceRootExisted = Test-Path -LiteralPath $DeviceRoot",
        "New-Item -ItemType Directory -Path $DeviceRoot -Force | Out-Null",
        "$CreatedVm = $null",
        "$BaseImageStream = $null",
        "try {",
        "  $ResolvedSwitch = $null",
        "  if ($Networking) {",
        "    if ($SwitchName) {",
        "      $SwitchMatches = @(Get-VMSwitch -Name $SwitchName -ErrorAction SilentlyContinue)",
        "      if ($SwitchMatches.Count -ne 1) { throw 'hyper-v-network-switch-not-found' }",
        "      $ResolvedSwitch = $SwitchMatches[0]",
        "    } else {",
        "      $ResolvedSwitch = Get-VMSwitch -Name 'Default Switch' -ErrorAction SilentlyContinue | Select-Object -First 1",
        "      if (-not $ResolvedSwitch) { $ResolvedSwitch = Get-VMSwitch -ErrorAction Stop | Where-Object { $_.SwitchType -eq 'External' } | Sort-Object Name | Select-Object -First 1 }",
        "      if (-not $ResolvedSwitch) { $ResolvedSwitch = Get-VMSwitch -ErrorAction Stop | Where-Object { $_.SwitchType -eq 'Internal' } | Sort-Object Name | Select-Object -First 1 }",
        "      if (-not $ResolvedSwitch) { throw 'hyper-v-network-switch-unavailable' }",
        "    }",
        "  }",
        "  Assert-NoReparsePath $BaseImage",
        "  Assert-NoReparsePath $DiskPath",
        "  $BaseImageStream = [IO.File]::Open($BaseImage, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)",
        "  $Hasher = [Security.Cryptography.SHA256]::Create()",
        "  try { $BaseImageHash = ([BitConverter]::ToString($Hasher.ComputeHash($BaseImageStream))).Replace('-', '').ToLowerInvariant() } finally { $Hasher.Dispose() }",
        "  if ($BaseImageHash -ne $ExpectedBaseImageHash) { throw 'hyper-v-base-image-hash-mismatch' }",
        "  $BaseImageStream.Position = 0",
        "  $BaseVhd = Get-VHD -Path $BaseImage -ErrorAction Stop",
        "  if ([string]$BaseVhd.VhdType -eq 'Differencing' -or $BaseVhd.ParentPath) { throw 'hyper-v-base-image-parent-invalid' }",
        "  New-VHD -Path $DiskPath -ParentPath $BaseImage -Differencing -ErrorAction Stop | Out-Null",
        "  $CreatedDisk = Get-VHD -Path $DiskPath -ErrorAction Stop",
        "  if (-not $CreatedDisk.ParentPath -or [IO.Path]::GetFullPath([string]$CreatedDisk.ParentPath) -ne [IO.Path]::GetFullPath($BaseImage)) { throw 'hyper-v-created-disk-parent-mismatch' }",
        "  $BaseImageStream.Position = 0",
        "  $Hasher = [Security.Cryptography.SHA256]::Create()",
        "  try { $BaseImageHashAfterCreate = ([BitConverter]::ToString($Hasher.ComputeHash($BaseImageStream))).Replace('-', '').ToLowerInvariant() } finally { $Hasher.Dispose() }",
        "  if ($BaseImageHashAfterCreate -ne $ExpectedBaseImageHash) { throw 'hyper-v-base-image-hash-mismatch' }",
        `  $VmArgs = @{ Name = $VmName; Generation = 2; MemoryStartupBytes = ${memoryMb}MB; VHDPath = $DiskPath }`,
        "  if ($ResolvedSwitch) { $VmArgs.SwitchName = $ResolvedSwitch.Name }",
        "  $CreatedVm = New-VM @VmArgs -ErrorAction Stop",
        "  if ($MacAddress) { Set-VMNetworkAdapter -VM $CreatedVm -StaticMacAddress ($MacAddress.Replace(':', '')) -ErrorAction Stop }",
        `  Set-VMProcessor -VM $CreatedVm -Count ${cpus} -ErrorAction Stop`,
        "  Set-VM -VM $CreatedVm -AutomaticCheckpointsEnabled $false -CheckpointType ProductionOnly -Notes $Marker -ErrorAction Stop",
        `  Set-VMFirmware -VM $CreatedVm -EnableSecureBoot On -SecureBootTemplate ${psQuote(secureBootTemplate)} -ErrorAction Stop`,
        "  $BaseImageStream.Dispose()",
        "  $BaseImageStream = $null",
        "  $Result = [ordered]@{ ok = $true; vmId = [string]$CreatedVm.Id; vmName = $CreatedVm.Name; state = [string]$CreatedVm.State; diskPath = $DiskPath; switchName = if ($ResolvedSwitch) { $ResolvedSwitch.Name } else { $null } }",
        "  $Result | ConvertTo-Json -Compress -Depth 5",
        "} catch {",
        "  if ($BaseImageStream) { $BaseImageStream.Dispose() }",
        "  if ($CreatedVm) { Remove-VM -VM $CreatedVm -Force -ErrorAction SilentlyContinue }",
        "  Assert-NoReparsePath $DiskPath",
        "  if (Test-Path -LiteralPath $DiskPath) { Remove-Item -LiteralPath $DiskPath -Force -ErrorAction SilentlyContinue }",
        "  Assert-NoReparsePath $DeviceRoot",
        "  if (-not $DeviceRootExisted -and (Test-Path -LiteralPath $DeviceRoot)) { Remove-Item -LiteralPath $DeviceRoot -Recurse -Force -ErrorAction SilentlyContinue }",
        "  throw",
        "}",
    ];
    return command(options.executable, jsonScript(lines));
}

export function hyperVLinuxSeedCommand(options: HyperVLinuxSeedOptions): HyperVProviderCommand {
    assertIdentity(options);
    if (!options.vmId) throw new Error("hyper-v-vm-id-missing");
    const deviceRoot = assertPlainPath(options.deviceRoot, "device-root");
    const privateRoot = assertPlainPath(options.privateRoot, "private-root");
    const seedDiskPath = assertPathInside(deviceRoot, options.seedDiskPath, "linux-seed-disk");
    if (!/\.iso$/i.test(seedDiskPath)) throw new Error("hyper-v-linux-seed-media-format-invalid");
    const seedSourcePath = assertPathInside(deviceRoot, `${seedDiskPath}.source`, "linux-seed-source");
    const privateKeyPath = assertPathInside(privateRoot, options.sshPrivateKeyPath, "linux-ssh-private-key");
    const publicKeyPath = assertPathInside(privateRoot, options.sshPublicKeyPath, "linux-ssh-public-key");
    const hostPrivateKeyPath = assertPathInside(privateRoot, options.sshHostPrivateKeyPath, "linux-ssh-host-private-key");
    const hostPublicKeyPath = assertPathInside(privateRoot, options.sshHostPublicKeyPath, "linux-ssh-host-public-key");
    const knownHostsPath = assertPathInside(privateRoot, options.knownHostsPath, "linux-ssh-known-hosts");
    const username = assertLinuxUsername(options.guestUsername);
    const address = assertIpv4(options.networkAddress, "linux-network-address");
    const gateway = assertIpv4(options.networkGateway, "linux-network-gateway");
    const prefixLength = boundedInteger(options.networkPrefixLength, 16, 30, "linux-network-prefix-length");
    const dnsServers = (options.dnsServers?.length ? options.dnsServers : ["1.1.1.1", "8.8.8.8"])
        .map((server) => assertIpv4(server, "linux-dns-server"));
    const metadata = `instance-id: ${options.ownerId}-${options.deviceId}\nlocal-hostname: ${options.vmName}\n`;
    const network = [
        "version: 2",
        "ethernets:",
        "  eth0:",
        "    match:",
        "      name: 'e*'",
        "    set-name: eth0",
        `    addresses: [${address}/${prefixLength}]`,
        `    gateway4: ${gateway}`,
        `    nameservers: { addresses: [${dnsServers.join(", ")}] }`,
        "",
    ].join("\n");
    return command(options.executable, jsonScript([
        ...ownedVmPrelude(options),
        `$DeviceRoot = ${psQuote(deviceRoot)}`,
        `$SeedDisk = ${psQuote(seedDiskPath)}`,
        `$SeedSource = ${psQuote(seedSourcePath)}`,
        `$PrivateKey = ${psQuote(privateKeyPath)}`,
        `$PublicKey = ${psQuote(publicKeyPath)}`,
        `$HostPrivateKey = ${psQuote(hostPrivateKeyPath)}`,
        `$HostPublicKey = ${psQuote(hostPublicKeyPath)}`,
        `$KnownHosts = ${psQuote(knownHostsPath)}`,
        `$MetadataBase64 = ${psQuote(Buffer.from(metadata, "utf8").toString("base64"))}`,
        `$NetworkBase64 = ${psQuote(Buffer.from(network, "utf8").toString("base64"))}`,
        `$GuestUsername = ${psQuote(username)}`,
        "if ($Vm.State -ne 'Off') { throw 'hyper-v-linux-seed-requires-stopped-vm' }",
        "Assert-NoReparsePath $DeviceRoot",
        "Assert-NoReparsePath $SeedDisk",
        "Assert-NoReparsePath $SeedSource",
        "Assert-NoReparsePath $PrivateKey",
        "Assert-NoReparsePath $PublicKey",
        "Assert-NoReparsePath $HostPrivateKey",
        "Assert-NoReparsePath $HostPublicKey",
        "Assert-NoReparsePath $KnownHosts",
        "New-Item -ItemType Directory -Path (Split-Path -Parent $SeedDisk) -Force | Out-Null",
        "New-Item -ItemType Directory -Path (Split-Path -Parent $PrivateKey) -Force | Out-Null",
        "if (-not (Test-Path -LiteralPath $PrivateKey -PathType Leaf) -or -not (Test-Path -LiteralPath $PublicKey -PathType Leaf)) {",
        "  Remove-Item -LiteralPath $PrivateKey,$PublicKey -Force -ErrorAction SilentlyContinue",
        "  $SshKeygen = Get-Command ssh-keygen.exe -ErrorAction SilentlyContinue",
        "  if (-not $SshKeygen) { $SshKeygen = Get-Command ssh-keygen -ErrorAction SilentlyContinue }",
        "  if (-not $SshKeygen) { throw 'hyper-v-linux-ssh-keygen-unavailable' }",
        "  & $SshKeygen.Source -q -t ed25519 -N '\"\"' -C ('ccc-device-lab-' + $ExpectedId) -f $PrivateKey",
        "  if ($LASTEXITCODE -ne 0) { throw 'hyper-v-linux-ssh-keygen-failed' }",
        "}",
        "if (-not (Test-Path -LiteralPath $HostPrivateKey -PathType Leaf) -or -not (Test-Path -LiteralPath $HostPublicKey -PathType Leaf)) {",
        "  Remove-Item -LiteralPath $HostPrivateKey,$HostPublicKey -Force -ErrorAction SilentlyContinue",
        "  $SshKeygen = Get-Command ssh-keygen.exe -ErrorAction SilentlyContinue",
        "  if (-not $SshKeygen) { $SshKeygen = Get-Command ssh-keygen -ErrorAction SilentlyContinue }",
        "  if (-not $SshKeygen) { throw 'hyper-v-linux-ssh-keygen-unavailable' }",
        "  & $SshKeygen.Source -q -t ed25519 -N '\"\"' -C ('ccc-device-lab-host-' + $ExpectedId) -f $HostPrivateKey",
        "  if ($LASTEXITCODE -ne 0) { throw 'hyper-v-linux-ssh-host-keygen-failed' }",
        "}",
        "$PublicKeyText = (Get-Content -LiteralPath $PublicKey -Raw -ErrorAction Stop).Trim()",
        "if ($PublicKeyText -notmatch '^ssh-ed25519 [A-Za-z0-9+/=]+(?: .*)?$') { throw 'hyper-v-linux-ssh-public-key-invalid' }",
        "$HostPrivateKeyText = (Get-Content -LiteralPath $HostPrivateKey -Raw -ErrorAction Stop).TrimEnd()",
        "$HostPublicKeyText = (Get-Content -LiteralPath $HostPublicKey -Raw -ErrorAction Stop).Trim()",
        "if ($HostPublicKeyText -notmatch '^ssh-ed25519 ([A-Za-z0-9+/=]+)(?: .*)?$') { throw 'hyper-v-linux-ssh-host-public-key-invalid' }",
        "$HostFingerprint = 'SHA256:' + [Convert]::ToBase64String(([Security.Cryptography.SHA256]::Create()).ComputeHash([Convert]::FromBase64String($Matches[1]))).TrimEnd('=')",
        "$HostPrivateKeyBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($HostPrivateKeyText + [Environment]::NewLine))",
        "$HostPublicKeyBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($HostPublicKeyText + [Environment]::NewLine))",
        "Set-Content -LiteralPath $KnownHosts -Value (" + psQuote(address) + " + ' ' + $HostPublicKeyText) -Encoding ASCII -Force",
        "$UserData = @('#cloud-config', ('hostname: ' + $ExpectedName), 'manage_etc_hosts: true', ('user: ' + $GuestUsername), 'ssh_pwauth: false', 'disable_root: true', 'ssh_deletekeys: true', 'users:', '  - default', ('  - name: ' + $GuestUsername), '    groups: [adm, sudo]', '    sudo: ALL=(ALL) NOPASSWD:ALL', '    shell: /bin/bash', '    lock_passwd: true', '    ssh_authorized_keys:', ('      - ' + $PublicKeyText), 'write_files:', '  - path: /etc/ssh/ssh_host_ed25519_key', '    owner: root:root', \"    permissions: '0600'\", '    encoding: b64', ('    content: ' + $HostPrivateKeyBase64), '  - path: /etc/ssh/ssh_host_ed25519_key.pub', '    owner: root:root', \"    permissions: '0644'\", '    encoding: b64', ('    content: ' + $HostPublicKeyBase64), 'runcmd:', '  - [systemctl, restart, ssh]', 'package_update: false', '') -join [Environment]::NewLine",
        "$UserDataBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($UserData))",
        "$ExistingAttachment = @(Get-VMDvdDrive -VM $Vm -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $SeedDisk })",
        "if ($ExistingAttachment.Count -ne 0) { throw 'hyper-v-linux-seed-media-already-attached' }",
        "if ($ExistingAttachment.Count -eq 0) {",
        "  if (Test-Path -LiteralPath $SeedSource) { Remove-Item -LiteralPath $SeedSource -Recurse -Force -ErrorAction Stop }",
        "  New-Item -ItemType Directory -Path $SeedSource -Force | Out-Null",
        "  try {",
        "    [IO.File]::WriteAllBytes((Join-Path $SeedSource 'meta-data'), [Convert]::FromBase64String($MetadataBase64))",
        "    [IO.File]::WriteAllBytes((Join-Path $SeedSource 'network-config'), [Convert]::FromBase64String($NetworkBase64))",
        "    [IO.File]::WriteAllBytes((Join-Path $SeedSource 'user-data'), [Convert]::FromBase64String($UserDataBase64))",
        ...isoWriterLines(),
        "    Write-CccIso $SeedSource $SeedDisk 'cidata'",
        "  } finally {",
        "    Assert-NoReparsePath $SeedSource",
        "    if (Test-Path -LiteralPath $SeedSource) { Remove-Item -LiteralPath $SeedSource -Recurse -Force -ErrorAction Stop }",
        "  }",
        "  try { Add-VMDvdDrive -VM $Vm -Path $SeedDisk -ErrorAction Stop | Out-Null } catch { throw 'hyper-v-linux-seed-media-attach-failed' }",
        "}",
        "$Result = [ordered]@{ ok = $true; vmId = [string]$Vm.Id; vmName = $Vm.Name; seedDiskPath = $SeedDisk; sshPrivateKeyPath = $PrivateKey; sshPublicKeyPath = $PublicKey; sshHostPublicKeyPath = $HostPublicKey; sshHostKeyFingerprint = $HostFingerprint; knownHostsPath = $KnownHosts; guestUsername = $GuestUsername; networkAddress = " + psQuote(address) + " }",
        "$Result | ConvertTo-Json -Compress -Depth 5",
    ]));
}

export function hyperVLinuxSshReadyCommand(options: HyperVLinuxSshOptions): HyperVProviderCommand {
    return {
        mode: "exec",
        provider: "hyper-v-ssh",
        executable: options.executable,
        args: [...sshBaseArgs(options), "printf 'ccc-hyper-v-linux-ready\\n'"],
    };
}

export function hyperVLinuxSshExecCommand(options: HyperVLinuxSshOptions & { guestCommand: string }): HyperVProviderCommand {
    if (!options.guestCommand || options.guestCommand.length > 16384 || options.guestCommand.includes("\0")) throw new Error("hyper-v-linux-guest-command-invalid");
    const encoded = Buffer.from(options.guestCommand, "utf8").toString("base64");
    return {
        mode: "exec",
        provider: "hyper-v-ssh",
        executable: options.executable,
        args: [...sshBaseArgs(options), `printf %s ${encoded} | base64 -d | bash`],
    };
}

export function hyperVLinuxScpUploadCommand(options: HyperVLinuxSshOptions & { localPath: string; remotePath: string }): HyperVProviderCommand {
    const localPath = assertPlainPath(options.localPath, "linux-upload-source");
    const remotePath = assertLinuxGuestPath(options.remotePath);
    const sshArgs = sshBaseArgs(options);
    const target = sshArgs.pop();
    return { mode: "exec", provider: "hyper-v-scp", executable: options.executable, args: [...sshArgs, localPath, `${target}:${remotePath}`] };
}

export function hyperVLinuxScpDownloadCommand(options: HyperVLinuxSshOptions & { remotePath: string; localPath: string }): HyperVProviderCommand {
    const remotePath = assertLinuxGuestPath(options.remotePath);
    const localPath = assertPlainPath(options.localPath, "linux-download-target");
    const sshArgs = sshBaseArgs(options);
    const target = sshArgs.pop();
    return { mode: "exec", provider: "hyper-v-scp", executable: options.executable, args: [...sshArgs, `${target}:${remotePath}`, localPath] };
}

export function hyperVPrepareBaseImageCommand(options: HyperVBaseImageOptions): HyperVProviderCommand {
    const sourceImagePath = assertPathInside(options.sourceRoot, options.sourceImagePath, "base-image-source");
    const imagePath = assertPathInside(options.imageRoot, options.imagePath, "base-image-target");
    if (!/\.vhdx$/i.test(sourceImagePath) || !/\.vhdx$/i.test(imagePath)) throw new Error("hyper-v-base-image-format-unsupported");
    const tempPath = `${imagePath}.partial`;
    const script = jsonScript([
        `$Profile = ${psQuote(options.profile)}`,
        `$SourceImage = ${psQuote(sourceImagePath)}`,
        `$ImagePath = ${psQuote(imagePath)}`,
        `$TempPath = ${psQuote(tempPath)}`,
        "Assert-NoReparsePath $SourceImage",
        "Assert-NoReparsePath $ImagePath",
        "Assert-NoReparsePath $TempPath",
        "if (-not (Test-Path -LiteralPath $SourceImage -PathType Leaf)) { throw 'hyper-v-base-image-source-not-found' }",
        "$SourceHash = (Get-FileHash -LiteralPath $SourceImage -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()",
        "if (Test-Path -LiteralPath $ImagePath -PathType Leaf) {",
        "  $ExistingHash = (Get-FileHash -LiteralPath $ImagePath -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()",
        "  if ($ExistingHash -ne $SourceHash) { throw 'hyper-v-base-image-profile-conflict' }",
        "  $ExistingVhd = Get-VHD -Path $ImagePath -ErrorAction Stop",
        "  if ([string]$ExistingVhd.VhdFormat -ne 'VHDX' -or [string]$ExistingVhd.VhdType -eq 'Differencing' -or $ExistingVhd.ParentPath) { throw 'hyper-v-base-image-invalid-parent' }",
        "  $Result = [ordered]@{ ok = $true; profile = $Profile; imagePath = $ImagePath; sha256 = $ExistingHash; sizeBytes = [long](Get-Item -LiteralPath $ImagePath).Length; virtualSizeBytes = [long]$ExistingVhd.Size; vhdType = [string]$ExistingVhd.VhdType; reused = $true }",
        "  $Result | ConvertTo-Json -Compress -Depth 5",
        "  exit 0",
        "}",
        "New-Item -ItemType Directory -Path (Split-Path -Parent $ImagePath) -Force | Out-Null",
        "Assert-NoReparsePath $TempPath",
        "Remove-Item -LiteralPath $TempPath -Force -ErrorAction SilentlyContinue",
        "try {",
        "  Copy-Item -LiteralPath $SourceImage -Destination $TempPath -ErrorAction Stop",
        "  $Vhd = Get-VHD -Path $TempPath -ErrorAction Stop",
        "  if ([string]$Vhd.VhdFormat -ne 'VHDX' -or [string]$Vhd.VhdType -eq 'Differencing' -or $Vhd.ParentPath) { throw 'hyper-v-base-image-invalid-parent' }",
        "  $CopiedHash = (Get-FileHash -LiteralPath $TempPath -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()",
        "  if ($CopiedHash -ne $SourceHash) { throw 'hyper-v-base-image-copy-hash-mismatch' }",
        "  Assert-NoReparsePath $TempPath",
        "  Assert-NoReparsePath $ImagePath",
        "  Move-Item -LiteralPath $TempPath -Destination $ImagePath -ErrorAction Stop",
        "  $Result = [ordered]@{ ok = $true; profile = $Profile; imagePath = $ImagePath; sha256 = $CopiedHash; sizeBytes = [long](Get-Item -LiteralPath $ImagePath).Length; virtualSizeBytes = [long]$Vhd.Size; vhdType = [string]$Vhd.VhdType; reused = $false }",
        "  $Result | ConvertTo-Json -Compress -Depth 5",
        "} finally {",
        "  Assert-NoReparsePath $TempPath",
        "  Remove-Item -LiteralPath $TempPath -Force -ErrorAction SilentlyContinue",
        "}",
    ]);
    return command(options.executable, script);
}

export function hyperVAcquireBaseImageCommand(options: HyperVAcquireBaseImageOptions): HyperVProviderCommand {
    const imageRoot = assertPlainPath(options.imageRoot, "base-image-root");
    if (options.profile !== "windows-server" && options.profile !== "ubuntu-lts") {
        throw new Error("hyper-v-base-image-profile-not-automatic");
    }
    const profileRoot = resolve(imageRoot, options.profile);
    const imagePath = resolve(profileRoot, "base.vhdx");
    const partialPath = resolve(profileRoot, "base.partial.vhdx");
    const workPath = resolve(profileRoot, ".acquire-work");
    const script = jsonScript([
        `$Profile = ${psQuote(options.profile)}`,
        `$ImageRoot = ${psQuote(imageRoot)}`,
        `$ProfileRoot = ${psQuote(profileRoot)}`,
        `$ImagePath = ${psQuote(imagePath)}`,
        `$PartialPath = ${psQuote(partialPath)}`,
        `$WorkPath = ${psQuote(workPath)}`,
        "Assert-NoReparsePath $ImageRoot",
        "Assert-NoReparsePath $ProfileRoot",
        "Assert-NoReparsePath $ImagePath",
        "Assert-NoReparsePath $PartialPath",
        "Assert-NoReparsePath $WorkPath",
        "$WindowsUrl = 'https://go.microsoft.com/fwlink/?clcid=0x409&country=us&culture=en-us&linkid=2345826'",
        "$UbuntuArchiveUrl = 'https://cloud-images.ubuntu.com/releases/noble/release-20260705/ubuntu-24.04-server-cloudimg-amd64-azure.vhd.tar.gz'",
        "$UbuntuArchiveSha256 = '05b7b5bb6172e5b0dd1248d5598c1bc27927c4625ba4c09c0442d4751725c43f'",
        "$WindowsMaxBytes = [long]16GB",
        "$UbuntuMaxBytes = [long]2GB",
        "Add-Type -AssemblyName System.Net.Http -ErrorAction Stop",
        "function Assert-BaseVhd([string]$Path) {",
        "  $Vhd = Get-VHD -Path $Path -ErrorAction Stop",
        "  if ([string]$Vhd.VhdFormat -ne 'VHDX' -or [string]$Vhd.VhdType -eq 'Differencing' -or $Vhd.ParentPath) { throw 'hyper-v-base-image-invalid-parent' }",
        "  return $Vhd",
        "}",
        "function Write-BaseObservation([object]$Vhd, [bool]$Reused) {",
        "  $Hash = (Get-FileHash -LiteralPath $ImagePath -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()",
        "  $Result = [ordered]@{ ok = $true; profile = $Profile; imagePath = $ImagePath; sha256 = $Hash; sizeBytes = [long](Get-Item -LiteralPath $ImagePath -ErrorAction Stop).Length; virtualSizeBytes = [long]$Vhd.Size; vhdType = [string]$Vhd.VhdType; reused = $Reused }",
        "  $Json = $Result | ConvertTo-Json -Compress -Depth 5",
        `  [Console]::Out.WriteLine('${HYPER_V_RESULT_MARKER}' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Json)))`,
        "}",
        "function Save-BoundedDownload([string]$Uri, [string]$Destination, [long]$MaximumBytes, [scriptblock]$ValidateHopUri, [scriptblock]$ValidateFinalUri) {",
        "  $Handler = [System.Net.Http.HttpClientHandler]::new()",
        "  $Handler.AllowAutoRedirect = $false",
        "  $Client = [System.Net.Http.HttpClient]::new($Handler)",
        "  $Response = $null",
        "  $InputStream = $null",
        "  $OutputStream = $null",
        "  try {",
        "    $CurrentUri = [Uri]$Uri",
        "    for ($Redirects = 0; $Redirects -le 10; $Redirects++) {",
        "      if (-not (& $ValidateHopUri $CurrentUri)) { throw 'hyper-v-base-image-download-host-rejected' }",
        "      $Response = $Client.GetAsync($CurrentUri, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()",
        "      if ([int]$Response.StatusCode -ge 300 -and [int]$Response.StatusCode -lt 400) {",
        "        if ($Redirects -eq 10 -or $null -eq $Response.Headers.Location) { throw 'hyper-v-base-image-download-redirect-invalid' }",
        "        $CurrentUri = [Uri]::new($CurrentUri, $Response.Headers.Location)",
        "        $Response.Dispose()",
        "        $Response = $null",
        "        continue",
        "      }",
        "      break",
        "    }",
        "    if (-not $Response.IsSuccessStatusCode) { throw ('hyper-v-base-image-download-http-' + [int]$Response.StatusCode) }",
        "    $FinalUri = $CurrentUri",
        "    if (-not (& $ValidateFinalUri $FinalUri)) { throw 'hyper-v-base-image-download-host-rejected' }",
        "    $ContentLength = $Response.Content.Headers.ContentLength",
        "    if ($null -eq $ContentLength -or [long]$ContentLength -le 0 -or [long]$ContentLength -gt $MaximumBytes) { throw 'hyper-v-base-image-download-size-rejected' }",
        "    $InputStream = $Response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()",
        "    $OutputStream = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)",
        "    $Buffer = New-Object byte[] 1048576",
        "    $Written = [long]0",
        "    while (($Read = $InputStream.Read($Buffer, 0, $Buffer.Length)) -gt 0) {",
        "      $Written += $Read",
        "      if ($Written -gt $MaximumBytes) { throw 'hyper-v-base-image-download-size-rejected' }",
        "      $OutputStream.Write($Buffer, 0, $Read)",
        "    }",
        "    if ($Written -ne [long]$ContentLength) { throw 'hyper-v-base-image-download-length-mismatch' }",
        "  } finally {",
        "    if ($OutputStream) { $OutputStream.Dispose() }",
        "    if ($InputStream) { $InputStream.Dispose() }",
        "    if ($Response) { $Response.Dispose() }",
        "    $Client.Dispose()",
        "    $Handler.Dispose()",
        "  }",
        "}",
        "New-Item -ItemType Directory -Path $ProfileRoot -Force | Out-Null",
        "Assert-NoReparsePath $PartialPath",
        "Remove-Item -LiteralPath $PartialPath -Force -ErrorAction SilentlyContinue",
        "Assert-NoReparsePath $WorkPath",
        "Remove-Item -LiteralPath $WorkPath -Recurse -Force -ErrorAction SilentlyContinue",
        "if (Test-Path -LiteralPath $ImagePath) { throw 'hyper-v-base-image-unmanaged-existing' }",
        "try {",
        "  if ($Profile -eq 'windows-server') {",
        "    $ValidateMicrosoftHop = { param([Uri]$CandidateUri) $HostName = $CandidateUri.DnsSafeHost.ToLowerInvariant(); return ($CandidateUri.Scheme -eq 'https' -and ($HostName -eq 'go.microsoft.com' -or $HostName -eq 'aka.ms' -or $HostName -eq 'download.microsoft.com' -or $HostName.EndsWith('.download.microsoft.com') -or $HostName -eq 'software-static.download.prss.microsoft.com')) }",
        "    $ValidateMicrosoftVhdx = { param([Uri]$FinalUri) $HostName = $FinalUri.DnsSafeHost.ToLowerInvariant(); return ($FinalUri.Scheme -eq 'https' -and $FinalUri.AbsolutePath.EndsWith('.vhdx', [StringComparison]::OrdinalIgnoreCase) -and ($HostName -eq 'download.microsoft.com' -or $HostName.EndsWith('.download.microsoft.com') -or $HostName -eq 'software-static.download.prss.microsoft.com')) }",
        "    Save-BoundedDownload $WindowsUrl $PartialPath $WindowsMaxBytes $ValidateMicrosoftHop $ValidateMicrosoftVhdx",
        "  } else {",
        "    New-Item -ItemType Directory -Path $WorkPath -Force | Out-Null",
        "    $ArchivePath = Join-Path $WorkPath 'ubuntu-24.04-server-cloudimg-amd64-azure.vhd.tar.gz'",
        "    $ExtractPath = Join-Path $WorkPath 'extract'",
        "    $ValidateCanonical = { param([Uri]$FinalUri) return ($FinalUri.Scheme -eq 'https' -and $FinalUri.DnsSafeHost.ToLowerInvariant() -eq 'cloud-images.ubuntu.com') }",
        "    Save-BoundedDownload $UbuntuArchiveUrl $ArchivePath $UbuntuMaxBytes $ValidateCanonical $ValidateCanonical",
        "    $ActualHash = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()",
        "    if ($ActualHash -ne $UbuntuArchiveSha256) { throw 'hyper-v-base-image-checksum-mismatch' }",
        "    $ArchiveEntries = @(& tar.exe -tzf $ArchivePath)",
        "    $MaximumArchiveEntries = 64",
        "    $MaximumRegularFiles = 8",
        "    $MaximumExtractedBytes = [long]64GB",
        "    if ($LASTEXITCODE -ne 0 -or $ArchiveEntries.Count -eq 0 -or $ArchiveEntries.Count -gt $MaximumArchiveEntries) { throw 'hyper-v-base-image-archive-list-invalid' }",
        "    $ArchiveTypes = @(& tar.exe -tvzf $ArchivePath)",
        "    if ($LASTEXITCODE -ne 0 -or $ArchiveTypes.Count -ne $ArchiveEntries.Count) { throw 'hyper-v-base-image-archive-list-invalid' }",
        "    $SeenEntries = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)",
        "    $RegularFileCount = 0",
        "    $TotalExtractedBytes = [long]0",
        "    $ExpectedVhdBytes = [long]-1",
        "    for ($Index = 0; $Index -lt $ArchiveEntries.Count; $Index++) {",
        "      $Entry = [string]$ArchiveEntries[$Index]",
        "      $NormalizedEntry = $Entry.Replace('\\', '/')",
        "      if (-not $NormalizedEntry -or $NormalizedEntry -match '[\\x00-\\x1f]' -or $NormalizedEntry.StartsWith('/') -or $NormalizedEntry -match '^[A-Za-z]:' -or @($NormalizedEntry.Split('/') | Where-Object { $_ -eq '..' }).Count -gt 0 -or -not $SeenEntries.Add($NormalizedEntry)) { throw 'hyper-v-base-image-archive-path-invalid' }",
        "      $TypeLine = [string]$ArchiveTypes[$Index]",
        "      if (-not $TypeLine -or ($TypeLine[0] -ne '-' -and $TypeLine[0] -ne 'd')) { throw 'hyper-v-base-image-archive-entry-type-invalid' }",
        "      if ($TypeLine[0] -eq '-') {",
        "        $RegularFileCount += 1",
        "        if ($RegularFileCount -gt $MaximumRegularFiles) { throw 'hyper-v-base-image-archive-entry-count-invalid' }",
        "        $SizeText = $null",
        "        if ($TypeLine -match '^\\S+\\s+\\d+\\s+\\S+\\s+\\S+\\s+(\\d+)\\s+') { $SizeText = $Matches[1] }",
        "        elseif ($TypeLine -match '^\\S+\\s+\\S+\\s+(\\d+)\\s+') { $SizeText = $Matches[1] }",
        "        if ($null -eq $SizeText) { throw 'hyper-v-base-image-archive-size-invalid' }",
        "        $EntryBytes = [long]::Parse($SizeText, [Globalization.CultureInfo]::InvariantCulture)",
        "        if ($EntryBytes -lt 0 -or $EntryBytes -gt $MaximumExtractedBytes -or $TotalExtractedBytes -gt ($MaximumExtractedBytes - $EntryBytes)) { throw 'hyper-v-base-image-archive-size-rejected' }",
        "        $TotalExtractedBytes += $EntryBytes",
        "        if ($NormalizedEntry.EndsWith('.vhd', [StringComparison]::OrdinalIgnoreCase)) {",
        "          if ($ExpectedVhdBytes -ge 0) { throw 'hyper-v-base-image-archive-vhd-count-invalid' }",
        "          $ExpectedVhdBytes = $EntryBytes",
        "        }",
        "      }",
        "    }",
        "    if ($ExpectedVhdBytes -le 0) { throw 'hyper-v-base-image-archive-vhd-count-invalid' }",
        "    New-Item -ItemType Directory -Path $ExtractPath -Force | Out-Null",
        "    & tar.exe -xzf $ArchivePath -C $ExtractPath --no-same-owner --no-same-permissions",
        "    if ($LASTEXITCODE -ne 0) { throw 'hyper-v-base-image-extract-failed' }",
        "    $ExtractedFiles = @(Get-ChildItem -LiteralPath $ExtractPath -Recurse -File -Force -ErrorAction Stop)",
        "    if ($ExtractedFiles.Count -ne $RegularFileCount) { throw 'hyper-v-base-image-archive-file-count-mismatch' }",
        "    $ActualExtractedBytes = [long]0",
        "    foreach ($ExtractedFile in $ExtractedFiles) {",
        "      if (($ExtractedFile.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'hyper-v-base-image-archive-entry-type-invalid' }",
        "      $ExtractedBytes = [long]$ExtractedFile.Length",
        "      if ($ExtractedBytes -lt 0 -or $ExtractedBytes -gt $MaximumExtractedBytes -or $ActualExtractedBytes -gt ($MaximumExtractedBytes - $ExtractedBytes)) { throw 'hyper-v-base-image-archive-size-rejected' }",
        "      $ActualExtractedBytes += $ExtractedBytes",
        "    }",
        "    if ($ActualExtractedBytes -ne $TotalExtractedBytes) { throw 'hyper-v-base-image-archive-total-size-mismatch' }",
        "    $SourceVhds = @($ExtractedFiles | Where-Object { $_.Extension -eq '.vhd' })",
        "    if ($SourceVhds.Count -ne 1) { throw 'hyper-v-base-image-archive-vhd-count-invalid' }",
        "    if ([long]$SourceVhds[0].Length -ne $ExpectedVhdBytes -or [long]$SourceVhds[0].Length -gt $MaximumExtractedBytes) { throw 'hyper-v-base-image-archive-size-mismatch' }",
        "    $SourcePath = $SourceVhds[0].FullName",
        "    $UnsupportedVhdAttributes = [IO.FileAttributes]::SparseFile -bor [IO.FileAttributes]::Compressed -bor [IO.FileAttributes]::Encrypted",
        "    $SourceAttributes = [IO.File]::GetAttributes($SourcePath)",
        "    if (($SourceAttributes -band $UnsupportedVhdAttributes) -ne 0) {",
        "      $NormalizedSourcePath = Join-Path $WorkPath 'normalized-source.vhd'",
        "      Assert-NoReparsePath $NormalizedSourcePath",
        "      $InputStream = $null",
        "      $OutputStream = $null",
        "      try {",
        "        $InputStream = [IO.File]::Open($SourcePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)",
        "        $OutputStream = [IO.File]::Open($NormalizedSourcePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)",
        "        $Buffer = New-Object byte[] (8MB)",
        "        while (($Read = $InputStream.Read($Buffer, 0, $Buffer.Length)) -gt 0) { $OutputStream.Write($Buffer, 0, $Read) }",
        "        $OutputStream.Flush($true)",
        "      } finally {",
        "        if ($OutputStream) { $OutputStream.Dispose() }",
        "        if ($InputStream) { $InputStream.Dispose() }",
        "      }",
        "      $NormalizedAttributes = [IO.File]::GetAttributes($NormalizedSourcePath)",
        "      if (($NormalizedAttributes -band [IO.FileAttributes]::Compressed) -ne 0) { & compact.exe /U /A /F /I /Q $NormalizedSourcePath | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'hyper-v-base-image-normalize-compression-failed' } }",
        "      if (($NormalizedAttributes -band [IO.FileAttributes]::Encrypted) -ne 0) { & cipher.exe /D $NormalizedSourcePath | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'hyper-v-base-image-normalize-encryption-failed' } }",
        "      $NormalizedAttributes = [IO.File]::GetAttributes($NormalizedSourcePath)",
        "      if (($NormalizedAttributes -band $UnsupportedVhdAttributes) -ne 0) { throw 'hyper-v-base-image-normalize-attributes-failed' }",
        "      if ([long](Get-Item -LiteralPath $NormalizedSourcePath -Force).Length -ne $ExpectedVhdBytes) { throw 'hyper-v-base-image-normalize-size-mismatch' }",
        "      $SourcePath = $NormalizedSourcePath",
        "    }",
        "    $SourceVhd = Get-VHD -Path $SourcePath -ErrorAction Stop",
        "    if ([string]$SourceVhd.VhdType -eq 'Differencing' -or $SourceVhd.ParentPath) { throw 'hyper-v-base-image-invalid-parent' }",
        "    Convert-VHD -Path $SourcePath -DestinationPath $PartialPath -VHDType Dynamic -ErrorAction Stop",
        "  }",
        "  $Vhd = Assert-BaseVhd $PartialPath",
        "  Assert-NoReparsePath $PartialPath",
        "  Assert-NoReparsePath $ImagePath",
        "  Move-Item -LiteralPath $PartialPath -Destination $ImagePath -ErrorAction Stop",
        "  $Vhd = Get-VHD -Path $ImagePath -ErrorAction Stop",
        "  Write-BaseObservation $Vhd $false",
        "} finally {",
        "  Assert-NoReparsePath $PartialPath",
        "  Remove-Item -LiteralPath $PartialPath -Force -ErrorAction SilentlyContinue",
        "  Assert-NoReparsePath $WorkPath",
        "  Remove-Item -LiteralPath $WorkPath -Recurse -Force -ErrorAction SilentlyContinue",
        "}",
    ]);
    return command(options.executable, script);
}

export function hyperVStatusCommand(options: HyperVCommandOptions): HyperVProviderCommand {
    return command(options.executable, jsonScript([
        ...ownedVmPrelude(options),
        "$Disk = Get-VMHardDiskDrive -VM $Vm -ErrorAction SilentlyContinue | Select-Object -First 1",
        "$Snapshots = @(Get-VMSnapshot -VM $Vm -ErrorAction SilentlyContinue | Where-Object { $_.Name -like ('ccc-' + $ExpectedMarker.Split(':')[1] + '-*') } | ForEach-Object { [ordered]@{ snapshotId = [string]$_.Id; snapshotName = [string]$_.Name; snapshotType = [string]$_.SnapshotType } })",
        "$Result = [ordered]@{ ok = $true; vmId = [string]$Vm.Id; vmName = $Vm.Name; state = [string]$Vm.State; status = [string]$Vm.Status; uptimeMs = [Math]::Floor($Vm.Uptime.TotalMilliseconds); diskPath = if ($Disk) { $Disk.Path } else { $null }; snapshots = $Snapshots }",
        "$Result | ConvertTo-Json -Compress -Depth 5",
    ]));
}

export function hyperVStartCommand(options: HyperVStartOptions): HyperVProviderCommand {
    const memoryMb = boundedInteger(options.memoryMb, 1024, 131072, "memory-mb");
    const cpus = boundedInteger(options.cpus, 1, 64, "cpus");
    return command(options.executable, jsonScript([
        ...ownedVmPrelude(options),
        "if ($Vm.State -ne 'Running') {",
        "  $ComputerInfo = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop",
        "  $OperatingSystem = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop",
        "  $TotalMemoryMb = [Math]::Floor([double]$ComputerInfo.TotalPhysicalMemory / 1MB)",
        "  $FreeMemoryMb = [Math]::Floor([double]$OperatingSystem.FreePhysicalMemory / 1KB)",
        "  $MemoryReserveMb = [Math]::Max(2048, [Math]::Floor($TotalMemoryMb * 0.10))",
        `  if (${memoryMb} -gt ($FreeMemoryMb - $MemoryReserveMb)) { throw 'hyper-v-host-memory-capacity-exceeded' }`,
        `  if (${cpus} -gt ([int]$ComputerInfo.NumberOfLogicalProcessors * 2)) { throw 'hyper-v-host-cpu-capacity-exceeded' }`,
        "  Start-VM -VM $Vm -ErrorAction Stop | Out-Null",
        "}",
        "$Vm = Get-VM -Id $ExpectedId -ErrorAction Stop",
        "$Result = [ordered]@{ ok = $true; vmId = [string]$Vm.Id; vmName = $Vm.Name; state = [string]$Vm.State; status = [string]$Vm.Status }",
        "$Result | ConvertTo-Json -Compress -Depth 5",
    ]));
}

export function hyperVGuestReadyCommand(options: HyperVGuestReadyOptions): HyperVProviderCommand {
    const credentialPath = assertPathInside(options.privateRoot || options.deviceRoot, options.credentialPath, "guest-credential-path");
    const provisioningMediaPath = options.provisioningMediaPath
        ? assertPathInside(options.deviceRoot, options.provisioningMediaPath, "guest-provisioning-media-path")
        : "";
    const timeoutMs = Math.min(10 * 60 * 1000, Math.max(1000, Math.floor(options.timeoutMs)));
    const expectedNetworkAddress = options.expectedNetworkAddress ? String(options.expectedNetworkAddress) : "";
    if (expectedNetworkAddress && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(expectedNetworkAddress)) throw new Error("hyper-v-guest-network-address-invalid");
    return command(options.executable, jsonScript([
        ...ownedVmPrelude(options),
        `$CredentialPath = ${psQuote(credentialPath)}`,
        `$ProvisioningMedia = ${psQuote(provisioningMediaPath)}`,
        `$ExpectedNetworkAddress = ${psQuote(expectedNetworkAddress)}`,
        `$Deadline = [DateTime]::UtcNow.AddMilliseconds(${timeoutMs})`,
        "$Attempts = 0",
        "$LastFailure = $null",
        "if (-not (Test-Path -LiteralPath $CredentialPath -PathType Leaf)) { throw 'hyper-v-guest-credential-unavailable' }",
        "$Credential = Import-Clixml -LiteralPath $CredentialPath -ErrorAction Stop",
        "if ($Credential -isnot [System.Management.Automation.PSCredential]) { throw 'hyper-v-guest-credential-invalid' }",
        "while ([DateTime]::UtcNow -lt $Deadline) {",
        "  $Attempts++",
        "  $Session = $null",
        "  try {",
        "    $Vm = Get-VM -Id $ExpectedId -ErrorAction Stop",
        "    if ($Vm.Name -ne $ExpectedName -or [string]$Vm.Notes -cne $ExpectedMarker) { throw 'hyper-v-vm-ownership-mismatch' }",
        "    if ($Vm.State -ne 'Running') { throw ('hyper-v-guest-vm-state:' + [string]$Vm.State) }",
        "    $Session = New-PSSession -VMId $ExpectedId -Credential $Credential -ErrorAction Stop",
        "    $Probe = Invoke-Command -Session $Session -ScriptBlock { [ordered]@{ computerName = [Environment]::MachineName; addresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object IPAddress) } } -ErrorAction Stop",
        "    if ($ExpectedNetworkAddress -and $Probe.addresses -notcontains $ExpectedNetworkAddress) { throw 'hyper-v-guest-network-not-ready' }",
        "    if ($ProvisioningMedia) {",
        "      $ProvisioningDrives = @(Get-VMDvdDrive -VM $Vm -ErrorAction Stop | Where-Object { $_.Path -eq $ProvisioningMedia })",
        "      if ($ProvisioningDrives.Count -gt 1) { throw 'hyper-v-guest-provisioning-media-attachment-ambiguous' }",
        "      if ($ProvisioningDrives.Count -eq 1) { Remove-VMDvdDrive -VMDvdDrive $ProvisioningDrives[0] -ErrorAction Stop }",
        "      Assert-NoReparsePath $ProvisioningMedia",
        "      if (Test-Path -LiteralPath $ProvisioningMedia) { Remove-Item -LiteralPath $ProvisioningMedia -Force -ErrorAction Stop }",
        "    }",
        "    $Result = [ordered]@{ ok = $true; vmId = [string]$Vm.Id; vmName = $Vm.Name; computerName = [string]$Probe.computerName; attempts = $Attempts; networkAddress = $ExpectedNetworkAddress }",
        "    $Result | ConvertTo-Json -Compress -Depth 5",
        "    exit 0",
        "  } catch {",
        "    $LastFailure = $_.Exception.Message",
        "  } finally {",
        "    if ($Session) { Remove-PSSession -Session $Session -ErrorAction SilentlyContinue }",
        "  }",
        "  Start-Sleep -Seconds 2",
        "}",
        "throw ('hyper-v-guest-ready-timeout: ' + $LastFailure)",
    ]));
}

export function hyperVStopCommand(options: HyperVCommandOptions, force = false): HyperVProviderCommand {
    return command(options.executable, jsonScript([
        ...ownedVmPrelude(options),
        `if ($Vm.State -ne 'Off') { Stop-VM -VM $Vm ${force ? "-TurnOff" : "-Shutdown"} -Force -ErrorAction Stop | Out-Null }`,
        "$Vm = Get-VM -Id $ExpectedId -ErrorAction Stop",
        "$Result = [ordered]@{ ok = $true; vmId = [string]$Vm.Id; vmName = $Vm.Name; state = [string]$Vm.State; status = [string]$Vm.Status }",
        "$Result | ConvertTo-Json -Compress -Depth 5",
    ]));
}

export function hyperVDeleteCommand(options: HyperVCommandOptions): HyperVProviderCommand {
    assertIdentity(options);
    if (!options.vmId) throw new Error("hyper-v-vm-id-missing");
    if (!options.diskPath) throw new Error("hyper-v-disk-path-missing");
    const diskPath = assertPlainPath(options.diskPath, "disk-path");
    const auxiliaryDiskPaths = (options.auxiliaryDiskPaths || []).map((candidate) => assertPlainPath(candidate, "auxiliary-disk-path"));
    const auxiliaryMediaPaths = (options.auxiliaryMediaPaths || []).map((candidate) => assertPlainPath(candidate, "auxiliary-media-path"));
    if (new Set([diskPath, ...auxiliaryDiskPaths].map((candidate) => candidate.toLowerCase())).size !== auxiliaryDiskPaths.length + 1) {
        throw new Error("hyper-v-disk-path-duplicate");
    }
    if (new Set(auxiliaryMediaPaths.map((candidate) => candidate.toLowerCase())).size !== auxiliaryMediaPaths.length
        || auxiliaryMediaPaths.some((candidate) => [diskPath, ...auxiliaryDiskPaths].some((disk) => disk.toLowerCase() === candidate.toLowerCase()))) {
        throw new Error("hyper-v-media-path-duplicate");
    }
    const marker = ownershipMarker(options.ownerId, options.deviceId, options.incarnationId);
    return command(options.executable, jsonScript([
        `$ExpectedId = [Guid]${psQuote(options.vmId)}`,
        `$ExpectedName = ${psQuote(options.vmName)}`,
        `$ExpectedMarker = ${psQuote(marker)}`,
        `$ExpectedDisk = ${psQuote(diskPath)}`,
        `$ExpectedDisks = @(${[diskPath, ...auxiliaryDiskPaths].map(psQuote).join(", ")})`,
        `$ExpectedMedia = @(${auxiliaryMediaPaths.map(psQuote).join(", ")})`,
        "$Vm = Get-VM -Id $ExpectedId -ErrorAction SilentlyContinue",
        "if (-not $Vm) {",
        "  if (Get-VM -Name $ExpectedName -ErrorAction SilentlyContinue) { throw 'hyper-v-vm-identity-conflict' }",
        "  foreach ($OwnedPath in @($ExpectedDisks) + @($ExpectedMedia)) { Assert-NoReparsePath $OwnedPath; if (Test-Path -LiteralPath $OwnedPath) { Remove-Item -LiteralPath $OwnedPath -Force -ErrorAction Stop } }",
        "  $Result = [ordered]@{ ok = $true; vmId = [string]$ExpectedId; vmName = $ExpectedName; deleted = $true; alreadyMissing = $true; diskPath = $ExpectedDisk }",
        "  $Result | ConvertTo-Json -Compress -Depth 5",
        "  exit 0",
        "}",
        "if ($Vm.Name -ne $ExpectedName -or [string]$Vm.Notes -cne $ExpectedMarker) { throw 'hyper-v-vm-ownership-mismatch' }",
        "$Attached = @(Get-VMHardDiskDrive -VM $Vm -ErrorAction SilentlyContinue | ForEach-Object { $_.Path })",
        "if ($Attached.Count -ne $ExpectedDisks.Count -or @(Compare-Object -ReferenceObject @($ExpectedDisks | Sort-Object) -DifferenceObject @($Attached | Sort-Object)).Count -ne 0) { throw 'hyper-v-vm-disk-ownership-mismatch' }",
        "$AttachedMedia = @(Get-VMDvdDrive -VM $Vm -ErrorAction SilentlyContinue | Where-Object { $_.Path } | ForEach-Object { $_.Path })",
        "if (@($AttachedMedia | Where-Object { $ExpectedMedia -notcontains $_ }).Count -ne 0) { throw 'hyper-v-vm-media-ownership-mismatch' }",
        "if ($Vm.State -ne 'Off') { Stop-VM -VM $Vm -TurnOff -Force -ErrorAction Stop | Out-Null }",
        "Remove-VM -VM $Vm -Force -ErrorAction Stop",
        "foreach ($OwnedPath in @($ExpectedDisks) + @($ExpectedMedia)) { Assert-NoReparsePath $OwnedPath; if (Test-Path -LiteralPath $OwnedPath) { Remove-Item -LiteralPath $OwnedPath -Force -ErrorAction Stop } }",
        "$Result = [ordered]@{ ok = $true; vmId = [string]$ExpectedId; vmName = $ExpectedName; deleted = $true; diskPath = $ExpectedDisk }",
        "$Result | ConvertTo-Json -Compress -Depth 5",
    ]));
}

export function hyperVRecoverOrphanCommand(options: Omit<HyperVCommandOptions, "vmId"> & { deviceRoot: string; diskPath: string }): HyperVProviderCommand {
    if (!OWNER_ID_PATTERN.test(options.ownerId)) throw new Error("hyper-v-owner-id-invalid");
    if (!DEVICE_ID_PATTERN.test(options.deviceId)) throw new Error("hyper-v-device-id-invalid");
    if (!INCARNATION_ID_PATTERN.test(options.incarnationId)) throw new Error("hyper-v-incarnation-id-invalid");
    if (options.vmName !== hyperVVmName(options.ownerId, options.deviceId, options.incarnationId)) throw new Error("hyper-v-vm-name-not-owner-scoped");
    const deviceRoot = assertPlainPath(options.deviceRoot, "device-root");
    const diskPath = assertPathInside(deviceRoot, options.diskPath, "disk-path");
    const auxiliaryDiskPaths = (options.auxiliaryDiskPaths || []).map((candidate) => assertPathInside(deviceRoot, candidate, "auxiliary-disk-path"));
    const auxiliaryMediaPaths = (options.auxiliaryMediaPaths || []).map((candidate) => assertPathInside(deviceRoot, candidate, "auxiliary-media-path"));
    const expectedDisks = [diskPath, ...auxiliaryDiskPaths];
    if (new Set(expectedDisks.map((candidate) => candidate.toLowerCase())).size !== expectedDisks.length) throw new Error("hyper-v-disk-path-duplicate");
    if (new Set(auxiliaryMediaPaths.map((candidate) => candidate.toLowerCase())).size !== auxiliaryMediaPaths.length
        || auxiliaryMediaPaths.some((candidate) => expectedDisks.some((disk) => disk.toLowerCase() === candidate.toLowerCase()))) {
        throw new Error("hyper-v-media-path-duplicate");
    }
    const marker = ownershipMarker(options.ownerId, options.deviceId, options.incarnationId);
    return command(options.executable, jsonScript([
        `$VmName = ${psQuote(options.vmName)}`,
        `$ExpectedMarker = ${psQuote(marker)}`,
        `$DiskPath = ${psQuote(diskPath)}`,
        `$ExpectedDisks = @(${expectedDisks.map(psQuote).join(", ")})`,
        `$ExpectedMedia = @(${auxiliaryMediaPaths.map(psQuote).join(", ")})`,
        "$RecoveredVm = $false",
        "$RemovedDisk = $false",
        "$Matches = @(Get-VM -Name $VmName -ErrorAction SilentlyContinue)",
        "if ($Matches.Count -gt 1) { throw 'hyper-v-orphan-vm-ambiguous' }",
        "if ($Matches.Count -eq 1) {",
        "  $Vm = $Matches[0]",
        "  if ([string]$Vm.Notes -and [string]$Vm.Notes -cne $ExpectedMarker) { throw 'hyper-v-orphan-vm-ownership-mismatch' }",
        "  $AttachedDisks = @(Get-VMHardDiskDrive -VM $Vm -ErrorAction Stop)",
        "  $AttachedPaths = @($AttachedDisks | ForEach-Object { [IO.Path]::GetFullPath([string]$_.Path) } | Sort-Object)",
        "  $ExpectedPaths = @($ExpectedDisks | ForEach-Object { [IO.Path]::GetFullPath([string]$_) } | Sort-Object)",
        "  if (@($AttachedPaths | Where-Object { $ExpectedPaths -notcontains $_ }).Count -ne 0) { throw 'hyper-v-orphan-vm-disk-mismatch' }",
        "  if (-not [string]$Vm.Notes -and ($AttachedPaths.Count -ne 1 -or $AttachedPaths[0] -cne [IO.Path]::GetFullPath($DiskPath))) { throw 'hyper-v-orphan-vm-unmarked-disk-mismatch' }",
        "  $AttachedMedia = @(Get-VMDvdDrive -VM $Vm -ErrorAction SilentlyContinue | Where-Object { $_.Path } | ForEach-Object { [IO.Path]::GetFullPath([string]$_.Path) })",
        "  $ExpectedMediaPaths = @($ExpectedMedia | ForEach-Object { [IO.Path]::GetFullPath([string]$_) })",
        "  if (@($AttachedMedia | Where-Object { $ExpectedMediaPaths -notcontains $_ }).Count -ne 0) { throw 'hyper-v-orphan-vm-media-mismatch' }",
        "  if ($Vm.State -ne 'Off') { Stop-VM -VM $Vm -TurnOff -Force -ErrorAction Stop | Out-Null }",
        "  Remove-VM -VM $Vm -Force -ErrorAction Stop",
        "  $RecoveredVm = $true",
        "}",
        "foreach ($OwnedDisk in @($ExpectedDisks) + @($ExpectedMedia)) {",
        "  Assert-NoReparsePath $OwnedDisk",
        "  if (Test-Path -LiteralPath $OwnedDisk) {",
        "    $DiskItem = Get-Item -LiteralPath $OwnedDisk -Force -ErrorAction Stop",
        "    if ($DiskItem.PSIsContainer -or ($DiskItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'hyper-v-orphan-disk-invalid' }",
        "    Remove-Item -LiteralPath $OwnedDisk -Force -ErrorAction Stop",
        "    $RemovedDisk = $true",
        "  }",
        "}",
        "$Result = [ordered]@{ ok = $true; recoveredVm = $RecoveredVm; removedDisk = $RemovedDisk }",
        "$Result | ConvertTo-Json -Compress -Depth 4",
    ]));
}

export function hyperVSnapshotCreateCommand(options: HyperVSnapshotOptions): HyperVProviderCommand {
    const lines = ownedVmPrelude(options);
    const providerName = hyperVSnapshotName(options.ownerId, options.snapshotName);
    return command(options.executable, jsonScript([
        ...lines,
        `$SnapshotName = ${psQuote(providerName)}`,
        "if (@(Get-VMSnapshot -VM $Vm -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $SnapshotName }).Count -ne 0) { throw 'hyper-v-snapshot-already-exists' }",
        "Checkpoint-VM -VM $Vm -SnapshotName $SnapshotName -ErrorAction Stop",
        "$Snapshot = @(Get-VMSnapshot -VM $Vm -ErrorAction Stop | Where-Object { $_.Name -eq $SnapshotName })",
        "if ($Snapshot.Count -ne 1) { throw 'hyper-v-snapshot-create-invalid-result' }",
        "$Snapshot = $Snapshot[0]",
        "$Result = [ordered]@{ ok = $true; snapshotId = [string]$Snapshot.Id; snapshotName = [string]$Snapshot.Name; snapshotType = [string]$Snapshot.SnapshotType }",
        "$Result | ConvertTo-Json -Compress -Depth 5",
    ]));
}

export function hyperVSnapshotRestoreCommand(options: HyperVSnapshotOptions): HyperVProviderCommand {
    return command(options.executable, jsonScript([
        ...ownedSnapshotPrelude(options),
        ...(!options.force ? ["if ($Vm.State -ne 'Off') { throw 'hyper-v-snapshot-restore-requires-stopped-vm' }"] : ["if ($Vm.State -ne 'Off') { Stop-VM -VM $Vm -TurnOff -Force -ErrorAction Stop | Out-Null }"]),
        "Restore-VMSnapshot -VMSnapshot $Snapshot -Confirm:$false -ErrorAction Stop",
        "$Vm = Get-VM -Id $ExpectedId -ErrorAction Stop",
        "$Result = [ordered]@{ ok = $true; snapshotId = [string]$Snapshot.Id; snapshotName = [string]$Snapshot.Name; snapshotType = [string]$Snapshot.SnapshotType; state = [string]$Vm.State }",
        "$Result | ConvertTo-Json -Compress -Depth 5",
    ]));
}

export function hyperVSnapshotDeleteCommand(options: HyperVSnapshotOptions): HyperVProviderCommand {
    return command(options.executable, jsonScript([
        ...ownedSnapshotPrelude(options),
        "Remove-VMSnapshot -VMSnapshot $Snapshot -Confirm:$false -ErrorAction Stop",
        "$Result = [ordered]@{ ok = $true; snapshotId = [string]$Snapshot.Id; snapshotName = [string]$Snapshot.Name; deleted = $true }",
        "$Result | ConvertTo-Json -Compress -Depth 5",
    ]));
}

export function hyperVGuestExecCommand(options: HyperVGuestExecOptions): HyperVProviderCommand {
    if (!options.guestCommand || options.guestCommand.length > 4096 || options.guestCommand.includes("\0")) {
        throw new Error("hyper-v-guest-command-invalid");
    }
    const guestCommand = Buffer.from(options.guestCommand, "utf16le").toString("base64");
    return command(options.executable, jsonScript([
        ...guestSessionPrelude(options),
        "try {",
        `  $GuestCommand = ${psQuote(guestCommand)}`,
        "  $GuestResult = Invoke-Command -Session $Session -ArgumentList $GuestCommand -ScriptBlock {",
        "    param($EncodedCommand)",
        "    $StdoutPath = [IO.Path]::GetTempFileName()",
        "    $StderrPath = [IO.Path]::GetTempFileName()",
        "    try {",
        "      $Process = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',$EncodedCommand) -Wait -PassThru -RedirectStandardOutput $StdoutPath -RedirectStandardError $StderrPath",
        "      [ordered]@{ status = [int]$Process.ExitCode; stdout = [IO.File]::ReadAllText($StdoutPath); stderr = [IO.File]::ReadAllText($StderrPath) }",
        "    } finally {",
        "      Remove-Item -LiteralPath $StdoutPath,$StderrPath -Force -ErrorAction SilentlyContinue",
        "    }",
        "  } -ErrorAction Stop",
        "  $Result = [ordered]@{ ok = $true; status = [int]$GuestResult.status; stdout = [string]$GuestResult.stdout; stderr = [string]$GuestResult.stderr }",
        "  $Result | ConvertTo-Json -Compress -Depth 5",
        "} finally {",
        "  if ($Session) { Remove-PSSession -Session $Session -ErrorAction SilentlyContinue }",
        "}",
    ]));
}

export function hyperVGuestProvisionCommand(options: HyperVGuestProvisionOptions): HyperVProviderCommand {
    assertIdentity(options);
    if (!options.vmId) throw new Error("hyper-v-vm-id-missing");
    if (!options.diskPath) throw new Error("hyper-v-disk-path-missing");
    if (!/^[A-Za-z][A-Za-z0-9._-]{2,19}$/.test(options.guestUsername)) throw new Error("hyper-v-guest-username-invalid");
    if (options.guestPassword.length < 20 || options.guestPassword.length > 128 || options.guestPassword.includes("\0")) throw new Error("hyper-v-guest-password-invalid");
    const diskPath = assertPathInside(options.deviceRoot, options.diskPath, "guest-disk-path");
    const credentialPath = assertPathInside(options.privateRoot || options.deviceRoot, options.credentialPath, "guest-credential-path");
    const provisioningMediaPath = assertPathInside(options.deviceRoot, options.provisioningMediaPath, "guest-provisioning-media-path");
    if (!/\.iso$/i.test(provisioningMediaPath)) throw new Error("hyper-v-guest-provisioning-media-format-invalid");
    const provisioningSourcePath = assertPathInside(options.deviceRoot, `${provisioningMediaPath}.source`, "guest-provisioning-source-path");
    const input = JSON.stringify({ username: options.guestUsername, password: options.guestPassword });
    const networkAddress = options.networkAddress ? String(options.networkAddress) : "";
    const networkGateway = options.networkGateway ? String(options.networkGateway) : "";
    if ((networkAddress && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(networkAddress)) || (networkGateway && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(networkGateway))) throw new Error("hyper-v-guest-network-address-invalid");
    if (Boolean(networkAddress) !== Boolean(networkGateway)) throw new Error("hyper-v-guest-network-incomplete");
    const networkPrefixLength = networkAddress ? boundedInteger(Number(options.networkPrefixLength), 16, 30, "guest-network-prefix-length") : 0;
    const firstLogonScript = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        ...(networkAddress ? [
            `$NetworkAddress = ${psQuote(networkAddress)}`,
            `$NetworkGateway = ${psQuote(networkGateway)}`,
            `$NetworkPrefixLength = ${networkPrefixLength}`,
            "$NetworkAdapter = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.HardwareInterface } | Sort-Object ifIndex | Select-Object -First 1",
            "if ($NetworkAdapter) {",
            "  Get-NetIPAddress -InterfaceIndex $NetworkAdapter.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Remove-NetIPAddress -Confirm:$false -ErrorAction SilentlyContinue",
            "  New-NetIPAddress -InterfaceIndex $NetworkAdapter.ifIndex -IPAddress $NetworkAddress -PrefixLength $NetworkPrefixLength -DefaultGateway $NetworkGateway -ErrorAction SilentlyContinue | Out-Null",
            "  Set-DnsClientServerAddress -InterfaceIndex $NetworkAdapter.ifIndex -ServerAddresses @('1.1.1.1','8.8.8.8') -ErrorAction SilentlyContinue",
            "}",
        ] : []),
        "Remove-Item -LiteralPath 'C:\\Windows\\Panther\\unattend.xml' -Force -ErrorAction SilentlyContinue",
        "Remove-Item -LiteralPath 'C:\\Windows\\Panther\\Unattend\\unattend.xml' -Force -ErrorAction SilentlyContinue",
        "$Winlogon = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon'",
        "foreach ($Name in @('DefaultPassword','DefaultUserName','AutoAdminLogon','AutoLogonCount')) { Remove-ItemProperty -LiteralPath $Winlogon -Name $Name -Force -ErrorAction SilentlyContinue }",
        "Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue",
    ].join("\r\n");
    const firstLogonEncoded = Buffer.from(firstLogonScript, "utf16le").toString("base64");
    const script = jsonScript([
        ...ownedVmPrelude(options),
        `$DiskPath = ${psQuote(diskPath)}`,
        `$CredentialPath = ${psQuote(credentialPath)}`,
        `$ProvisioningMedia = ${psQuote(provisioningMediaPath)}`,
        `$ProvisioningSource = ${psQuote(provisioningSourcePath)}`,
        `$ExpectedUsername = ${psQuote(options.guestUsername)}`,
        `$FirstLogonEncoded = ${psQuote(firstLogonEncoded)}`,
        "if ($Vm.State -ne 'Off') { throw 'hyper-v-guest-provision-requires-stopped-vm' }",
        "$RawInput = $CccCommandInput",
        "$Provisioning = $RawInput | ConvertFrom-Json -ErrorAction Stop",
        "if ([string]$Provisioning.username -ne $ExpectedUsername) { throw 'hyper-v-guest-provision-username-mismatch' }",
        "$PlainPassword = [string]$Provisioning.password",
        "if ($PlainPassword.Length -lt 20 -or $PlainPassword.Length -gt 128) { throw 'hyper-v-guest-provision-password-invalid' }",
        "$CredentialDirectory = Split-Path -Parent $CredentialPath",
        "New-Item -ItemType Directory -Path $CredentialDirectory -Force | Out-Null",
        "$SecurePassword = ConvertTo-SecureString -String $PlainPassword -AsPlainText -Force",
        "$Credential = [System.Management.Automation.PSCredential]::new($ExpectedUsername, $SecurePassword)",
        "$Credential | Export-Clixml -LiteralPath $CredentialPath -Force",
        "$ExistingAttachment = @(Get-VMDvdDrive -VM $Vm -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $ProvisioningMedia })",
        "if ($ExistingAttachment.Count -ne 0) { throw 'hyper-v-guest-provisioning-media-already-attached' }",
        "try {",
        "  $PasswordXml = [Security.SecurityElement]::Escape($PlainPassword)",
        "  $UsernameXml = [Security.SecurityElement]::Escape($ExpectedUsername)",
        "  $Unattend = @\"",
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>",
        "<unattend xmlns=\"urn:schemas-microsoft-com:unattend\">",
        "  <settings pass=\"oobeSystem\">",
        "    <component name=\"Microsoft-Windows-Shell-Setup\" processorArchitecture=\"amd64\" publicKeyToken=\"31bf3856ad364e35\" language=\"neutral\" versionScope=\"nonSxS\" xmlns:wcm=\"http://schemas.microsoft.com/WMIConfig/2002/State\">",
        "      <OOBE><HideEULAPage>true</HideEULAPage><ProtectYourPC>3</ProtectYourPC><SkipMachineOOBE>true</SkipMachineOOBE><SkipUserOOBE>true</SkipUserOOBE></OOBE>",
        "      <UserAccounts><LocalAccounts><LocalAccount wcm:action=\"add\"><Password><Value>$PasswordXml</Value><PlainText>true</PlainText></Password><Description>CCC disposable guest</Description><DisplayName>CCC</DisplayName><Group>Administrators</Group><Name>$UsernameXml</Name></LocalAccount></LocalAccounts></UserAccounts>",
        "      <AutoLogon><Password><Value>$PasswordXml</Value><PlainText>true</PlainText></Password><Enabled>true</Enabled><LogonCount>1</LogonCount><Username>$UsernameXml</Username></AutoLogon>",
        "      <FirstLogonCommands><SynchronousCommand wcm:action=\"add\"><Order>1</Order><Description>Remove CCC bootstrap secrets</Description><CommandLine>powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $FirstLogonEncoded</CommandLine></SynchronousCommand></FirstLogonCommands>",
        "    </component>",
        "  </settings>",
        "</unattend>",
        "\"@",
        "  Assert-NoReparsePath $ProvisioningSource",
        "  if (Test-Path -LiteralPath $ProvisioningSource) { Remove-Item -LiteralPath $ProvisioningSource -Recurse -Force -ErrorAction Stop }",
        "  New-Item -ItemType Directory -Path $ProvisioningSource -Force | Out-Null",
        "  Set-Content -LiteralPath (Join-Path $ProvisioningSource 'Autounattend.xml') -Value $Unattend -Encoding UTF8 -Force",
        "  Set-Content -LiteralPath (Join-Path $ProvisioningSource 'unattend.xml') -Value $Unattend -Encoding UTF8 -Force",
        ...isoWriterLines(),
        "  Write-CccIso $ProvisioningSource $ProvisioningMedia 'CCC_UNATTEND'",
        "  try { Add-VMDvdDrive -VM $Vm -Path $ProvisioningMedia -ErrorAction Stop | Out-Null } catch { throw 'hyper-v-guest-provisioning-media-attach-failed' }",
        "} catch {",
        "  Remove-Item -LiteralPath $CredentialPath -Force -ErrorAction SilentlyContinue",
        "  Assert-NoReparsePath $ProvisioningMedia",
        "  Remove-Item -LiteralPath $ProvisioningMedia -Force -ErrorAction SilentlyContinue",
        "  throw",
        "} finally {",
        "  $PlainPassword = $null",
        "  $Provisioning = $null",
        "  $RawInput = $null",
        "  Assert-NoReparsePath $ProvisioningSource",
        "  if (Test-Path -LiteralPath $ProvisioningSource) { Remove-Item -LiteralPath $ProvisioningSource -Recurse -Force -ErrorAction Stop }",
        "}",
        "$Result = [ordered]@{ ok = $true; vmId = [string]$Vm.Id; vmName = $Vm.Name; guestUsername = $ExpectedUsername; credentialPath = $CredentialPath; unattendPath = $ProvisioningMedia }",
        "$Result | ConvertTo-Json -Compress -Depth 5",
    ]);
    return command(options.executable, script, input);
}

export function hyperVGuestUploadCommand(options: HyperVGuestTransferOptions): HyperVProviderCommand {
    const localPath = assertPlainPath(options.localPath, "guest-upload-local-path");
    const remotePath = assertGuestPath(options.remotePath);
    return command(options.executable, jsonScript([
        ...guestSessionPrelude(options),
        `$LocalPath = ${psQuote(localPath)}`,
        `$RemotePath = ${psQuote(remotePath)}`,
        "if (-not (Test-Path -LiteralPath $LocalPath -PathType Leaf)) { throw 'hyper-v-guest-upload-source-missing' }",
        "try {",
        "  $RemoteParent = [IO.Path]::GetDirectoryName($RemotePath)",
        "  Invoke-Command -Session $Session -ArgumentList $RemoteParent -ScriptBlock { param($Path) if ($Path) { New-Item -ItemType Directory -Path $Path -Force | Out-Null } } -ErrorAction Stop",
        "  Copy-Item -LiteralPath $LocalPath -Destination $RemotePath -ToSession $Session -Force -ErrorAction Stop",
        "  $Bytes = (Get-Item -LiteralPath $LocalPath -ErrorAction Stop).Length",
        "  $Result = [ordered]@{ ok = $true; localPath = $LocalPath; remotePath = $RemotePath; bytes = [long]$Bytes }",
        "  $Result | ConvertTo-Json -Compress -Depth 5",
        "} finally {",
        "  if ($Session) { Remove-PSSession -Session $Session -ErrorAction SilentlyContinue }",
        "}",
    ]));
}

export function hyperVGuestDownloadCommand(options: HyperVGuestTransferOptions): HyperVProviderCommand {
    const localPath = assertPlainPath(options.localPath, "guest-download-local-path");
    const remotePath = assertGuestPath(options.remotePath);
    const maxBytes = boundedInteger(options.maxBytes ?? 16 * 1024 * 1024, 1, 16 * 1024 * 1024, "guest-download-max-bytes");
    return command(options.executable, jsonScript([
        ...guestSessionPrelude(options),
        `$LocalPath = ${psQuote(localPath)}`,
        `$RemotePath = ${psQuote(remotePath)}`,
        "try {",
        `  $Encoded = Invoke-Command -Session $Session -ArgumentList $RemotePath,([long]${maxBytes}) -ScriptBlock { param($Path,$Limit) if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'hyper-v-guest-download-source-missing' }; $Stream = [IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); try { if ($Stream.Length -gt $Limit) { throw 'hyper-v-guest-download-source-too-large' }; $Buffer = New-Object byte[] ([int]$Stream.Length); $Offset = 0; while ($Offset -lt $Buffer.Length) { $Read = $Stream.Read($Buffer,$Offset,$Buffer.Length-$Offset); if ($Read -le 0) { throw 'hyper-v-guest-download-source-changed' }; $Offset += $Read }; if ($Stream.ReadByte() -ge 0) { throw 'hyper-v-guest-download-source-changed' }; [Convert]::ToBase64String($Buffer) } finally { $Stream.Dispose() } } -ErrorAction Stop`,
        "  $Payload = [Convert]::FromBase64String([string]$Encoded)",
        `  if ($Payload.Length -gt ${maxBytes}) { throw 'hyper-v-guest-download-source-too-large' }`,
        "  [IO.File]::WriteAllBytes($LocalPath,$Payload)",
        "  $Result = [ordered]@{ ok = $true; localPath = $LocalPath; remotePath = $RemotePath; bytes = [long]$Payload.Length }",
        "  $Result | ConvertTo-Json -Compress -Depth 5",
        "} finally {",
        "  if ($Session) { Remove-PSSession -Session $Session -ErrorAction SilentlyContinue }",
        "}",
    ]));
}

function parseLastJsonObject(stdout: string): Record<string, unknown> | null {
    for (const line of String(stdout || "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean).reverse()) {
        try {
            const parsed: unknown = JSON.parse(line);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
        } catch {
            // PowerShell may emit progress or module text before the JSON record.
        }
    }
    return null;
}

const HYPER_V_RESULT_MARKER = "CCC_HYPER_V_RESULT_B64:";

function parseMarkedJsonObject(stdout: string): Record<string, unknown> | null {
    const matches = Array.from(String(stdout || "").matchAll(/CCC_HYPER_V_RESULT_B64:([A-Za-z0-9+/=]+)/g));
    const encoded = matches.at(-1)?.[1];
    if (!encoded || encoded.length > 131072) return null;
    try {
        const decoded = Buffer.from(encoded, "base64");
        if (decoded.length === 0 || decoded.length > 65536 || decoded.toString("base64") !== encoded) return null;
        const parsed: unknown = JSON.parse(decoded.toString("utf8"));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

export function parseHyperVReadiness(stdout: string): HyperVReadiness | null {
    const parsed = parseLastJsonObject(stdout);
    if (!parsed || typeof parsed.available !== "boolean"
        || typeof parsed.totalMemoryMb !== "number" || !Number.isSafeInteger(parsed.totalMemoryMb) || parsed.totalMemoryMb < 0
        || typeof parsed.freeMemoryMb !== "number" || !Number.isSafeInteger(parsed.freeMemoryMb) || parsed.freeMemoryMb < 0
        || typeof parsed.logicalProcessors !== "number" || !Number.isSafeInteger(parsed.logicalProcessors) || parsed.logicalProcessors < 0) return null;
    return {
        ok: parsed.ok === true,
        available: parsed.available,
        platform: typeof parsed.platform === "string" ? parsed.platform : "win32",
        moduleAvailable: parsed.moduleAvailable === true,
        hypervisorPresent: parsed.hypervisorPresent === true,
        vmmsRunning: parsed.vmmsRunning === true,
        rebootPending: parsed.rebootPending === true,
        totalMemoryMb: parsed.totalMemoryMb,
        freeMemoryMb: parsed.freeMemoryMb,
        logicalProcessors: parsed.logicalProcessors,
        missing: Array.isArray(parsed.missing) ? parsed.missing.filter((item): item is string => typeof item === "string") : [],
        ...(typeof parsed.hyperVAdministratorsMember === "boolean" ? { hyperVAdministratorsMember: parsed.hyperVAdministratorsMember } : {}),
        ...(typeof parsed.managementAccess === "boolean" ? { managementAccess: parsed.managementAccess } : {}),
        ...(typeof parsed.sessionRefreshRequired === "boolean" ? { sessionRefreshRequired: parsed.sessionRefreshRequired } : {}),
        ...(typeof parsed.detail === "string" ? { detail: parsed.detail } : {}),
    };
}

export function parseHyperVSetupObservation(stdout: string): HyperVSetupObservation | null {
    const parsed = parseLastJsonObject(stdout);
    if (!parsed || typeof parsed.ok !== "boolean" || parsed.featureName !== "Microsoft-Hyper-V-All"
        || typeof parsed.beforeState !== "string" || !parsed.beforeState
        || typeof parsed.afterState !== "string" || !parsed.afterState
        || typeof parsed.changed !== "boolean" || typeof parsed.elevated !== "boolean"
        || typeof parsed.rebootRequired !== "boolean"
        || (parsed.hyperVAdministratorsMember !== undefined && typeof parsed.hyperVAdministratorsMember !== "boolean")
        || (parsed.membershipChanged !== undefined && typeof parsed.membershipChanged !== "boolean")
        || (parsed.managementAccess !== undefined && typeof parsed.managementAccess !== "boolean")
        || (parsed.sessionRefreshRequired !== undefined && typeof parsed.sessionRefreshRequired !== "boolean")) return null;
    const network = parsed.network === undefined ? undefined : parseHyperVNetworkObservation(JSON.stringify(parsed.network));
    if (parsed.network !== undefined && !network) return null;
    return {
        ok: parsed.ok,
        featureName: parsed.featureName,
        beforeState: parsed.beforeState,
        afterState: parsed.afterState,
        changed: parsed.changed,
        elevated: parsed.elevated,
        rebootRequired: parsed.rebootRequired,
        ...(typeof parsed.hyperVAdministratorsMember === "boolean" ? { hyperVAdministratorsMember: parsed.hyperVAdministratorsMember } : {}),
        ...(typeof parsed.membershipChanged === "boolean" ? { membershipChanged: parsed.membershipChanged } : {}),
        ...(typeof parsed.managementAccess === "boolean" ? { managementAccess: parsed.managementAccess } : {}),
        ...(typeof parsed.sessionRefreshRequired === "boolean" ? { sessionRefreshRequired: parsed.sessionRefreshRequired } : {}),
        ...(network ? { network } : {}),
    };
}

export function parseHyperVBaseImageObservation(stdout: string): HyperVBaseImageObservation | null {
    const parsed = parseMarkedJsonObject(stdout) || parseLastJsonObject(stdout);
    if (!parsed || parsed.ok !== true || (parsed.profile !== "windows-11" && parsed.profile !== "windows-server" && parsed.profile !== "ubuntu-lts") || typeof parsed.imagePath !== "string" || typeof parsed.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(parsed.sha256) || typeof parsed.sizeBytes !== "number" || !Number.isSafeInteger(parsed.sizeBytes) || parsed.sizeBytes <= 0 || typeof parsed.virtualSizeBytes !== "number" || !Number.isSafeInteger(parsed.virtualSizeBytes) || parsed.virtualSizeBytes < parsed.sizeBytes || (parsed.vhdType !== "Dynamic" && parsed.vhdType !== "Fixed") || typeof parsed.reused !== "boolean") return null;
    return {
        ok: true,
        profile: parsed.profile,
        imagePath: parsed.imagePath,
        sha256: parsed.sha256.toLowerCase(),
        sizeBytes: parsed.sizeBytes,
        virtualSizeBytes: parsed.virtualSizeBytes,
        vhdType: parsed.vhdType,
        reused: parsed.reused,
    };
}

export function parseHyperVDeleteObservation(stdout: string): HyperVDeleteObservation | null {
    const parsed = parseLastJsonObject(stdout);
    if (!parsed || parsed.deleted !== true) return null;
    const observation = parseHyperVVmObservation(JSON.stringify(parsed));
    return observation ? { ...observation, deleted: true } : null;
}

export function parseHyperVNetworkObservation(stdout: string): HyperVNetworkObservation | null {
    const parsed = parseLastJsonObject(stdout);
    if (!parsed || parsed.ok !== true
        || typeof parsed.switchName !== "string" || !parsed.switchName
        || typeof parsed.switchId !== "string" || !VM_ID_PATTERN.test(parsed.switchId)
        || typeof parsed.natName !== "string" || !parsed.natName
        || typeof parsed.natInstanceId !== "string" || !parsed.natInstanceId || parsed.natInstanceId.length > 256 || /[\u0000-\u001f]/.test(parsed.natInstanceId)
        || typeof parsed.prefix !== "string" || !/^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(parsed.prefix)
        || typeof parsed.gateway !== "string" || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(parsed.gateway)
        || typeof parsed.interfaceIndex !== "number" || !Number.isSafeInteger(parsed.interfaceIndex) || parsed.interfaceIndex <= 0
        || typeof parsed.createdSwitch !== "boolean" || typeof parsed.createdNat !== "boolean") return null;
    return parsed as HyperVNetworkObservation;
}

export function parseHyperVNetworkCleanupObservation(stdout: string): HyperVNetworkCleanupObservation | null {
    const parsed = parseLastJsonObject(stdout);
    if (!parsed || parsed.ok !== true
        || typeof parsed.removedSwitch !== "boolean"
        || typeof parsed.removedNat !== "boolean"
        || typeof parsed.removedGateway !== "boolean"
        || typeof parsed.alreadyMissing !== "boolean") return null;
    return parsed as HyperVNetworkCleanupObservation;
}

export function parseHyperVRecoveryObservation(stdout: string): HyperVRecoveryObservation | null {
    const parsed = parseLastJsonObject(stdout);
    if (!parsed || parsed.ok !== true || typeof parsed.recoveredVm !== "boolean" || typeof parsed.removedDisk !== "boolean") return null;
    return parsed as HyperVRecoveryObservation;
}

export function parseHyperVVmObservation(stdout: string): HyperVVmObservation | null {
    const parsed = parseLastJsonObject(stdout);
    if (!parsed || parsed.ok !== true || typeof parsed.vmId !== "string" || !VM_ID_PATTERN.test(parsed.vmId) || typeof parsed.vmName !== "string") return null;
    return {
        ok: true,
        vmId: parsed.vmId.toLowerCase(),
        vmName: parsed.vmName,
        state: typeof parsed.state === "string" ? parsed.state : "Unknown",
        status: typeof parsed.status === "string" ? parsed.status : "",
        ...(typeof parsed.uptimeMs === "number" && Number.isFinite(parsed.uptimeMs) ? { uptimeMs: parsed.uptimeMs } : {}),
        ...(typeof parsed.diskPath === "string" ? { diskPath: parsed.diskPath } : {}),
        ...(typeof parsed.switchName === "string" ? { switchName: parsed.switchName } : {}),
        ...(Array.isArray(parsed.snapshots) ? {
            snapshots: parsed.snapshots.flatMap((snapshot) => {
                if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return [];
                const record = snapshot as Record<string, unknown>;
                if (typeof record.snapshotId !== "string" || typeof record.snapshotName !== "string") return [];
                return [{
                    ok: true,
                    snapshotId: record.snapshotId,
                    snapshotName: record.snapshotName,
                    ...(typeof record.snapshotType === "string" ? { snapshotType: record.snapshotType } : {}),
                }];
            }),
        } : {}),
    };
}

export function parseHyperVSnapshotObservation(stdout: string): HyperVSnapshotObservation | null {
    const parsed = parseLastJsonObject(stdout);
    if (!parsed || parsed.ok !== true || typeof parsed.snapshotId !== "string" || typeof parsed.snapshotName !== "string") return null;
    if (!VM_ID_PATTERN.test(parsed.snapshotId)) return null;
    return {
        ok: true,
        snapshotId: parsed.snapshotId,
        snapshotName: parsed.snapshotName,
        ...(typeof parsed.state === "string" ? { state: parsed.state } : {}),
        ...(typeof parsed.snapshotType === "string" ? { snapshotType: parsed.snapshotType } : {}),
    };
}

export function parseHyperVSnapshotDeleteObservation(stdout: string): HyperVSnapshotDeleteObservation | null {
    const parsed = parseLastJsonObject(stdout);
    if (!parsed || parsed.deleted !== true) return null;
    const observation = parseHyperVSnapshotObservation(JSON.stringify(parsed));
    return observation ? { ...observation, deleted: true } : null;
}

export function parseHyperVGuestExecObservation(stdout: string): HyperVGuestExecObservation | null {
    const parsed = parseLastJsonObject(stdout);
    if (!parsed || parsed.ok !== true || typeof parsed.status !== "number" || !Number.isInteger(parsed.status)) return null;
    return {
        ok: true,
        status: parsed.status,
        stdout: typeof parsed.stdout === "string" ? parsed.stdout : "",
        stderr: typeof parsed.stderr === "string" ? parsed.stderr : "",
    };
}

export function parseHyperVGuestTransferObservation(stdout: string): HyperVGuestTransferObservation | null {
    const parsed = parseLastJsonObject(stdout);
    if (!parsed || parsed.ok !== true || typeof parsed.localPath !== "string" || typeof parsed.remotePath !== "string" || typeof parsed.bytes !== "number" || !Number.isFinite(parsed.bytes)) return null;
    return { ok: true, localPath: parsed.localPath, remotePath: parsed.remotePath, bytes: parsed.bytes };
}

export function parseHyperVGuestProvisionObservation(stdout: string): HyperVGuestProvisionObservation | null {
    const parsed = parseLastJsonObject(stdout);
    if (!parsed || parsed.ok !== true || typeof parsed.vmId !== "string" || !VM_ID_PATTERN.test(parsed.vmId) || typeof parsed.vmName !== "string" || typeof parsed.guestUsername !== "string" || typeof parsed.credentialPath !== "string" || typeof parsed.unattendPath !== "string") return null;
    return {
        ok: true,
        vmId: parsed.vmId.toLowerCase(),
        vmName: parsed.vmName,
        guestUsername: parsed.guestUsername,
        credentialPath: parsed.credentialPath,
        unattendPath: parsed.unattendPath,
    };
}

export function parseHyperVGuestReadyObservation(stdout: string): HyperVGuestReadyObservation | null {
    const parsed = parseLastJsonObject(stdout);
    if (!parsed || parsed.ok !== true || typeof parsed.vmId !== "string" || !VM_ID_PATTERN.test(parsed.vmId) || typeof parsed.vmName !== "string" || typeof parsed.computerName !== "string" || !parsed.computerName || typeof parsed.attempts !== "number" || !Number.isSafeInteger(parsed.attempts) || parsed.attempts < 1) return null;
    return {
        ok: true,
        vmId: parsed.vmId.toLowerCase(),
        vmName: parsed.vmName,
        computerName: parsed.computerName,
        attempts: parsed.attempts,
        ...(typeof parsed.networkAddress === "string" && parsed.networkAddress ? { networkAddress: parsed.networkAddress } : {}),
    };
}
