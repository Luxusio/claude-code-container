
import { isAbsolute, relative, resolve, sep } from "path";
import { hiddenWindowsPowerShellArgs } from "../../windows-system-powershell.js";

import {
    type HyperVProviderCommand,
    type HyperVCommandOptions,
    type HyperVSnapshotOptions,
    type HyperVGuestOptions,
    type HyperVLinuxSshOptions,
} from "./contracts.js";

export const HYPER_V_RESULT_MARKER = "CCC_HYPER_V_RESULT_B64:";
export const OWNER_ID_PATTERN = /^[a-f0-9]{16}$/;
export const DEVICE_ID_PATTERN = /^(?!\.\.?$)[A-Za-z0-9._:-]{1,128}$/;
export const INCARNATION_ID_PATTERN = /^[a-f0-9]{32}$/;
export const VM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SNAPSHOT_NAME_PATTERN = /^(?!\.\.?$)[A-Za-z0-9._-]{1,64}$/;

export function psQuote(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

export function encodedPowerShell(script: string): string {
    return Buffer.from(script, "utf16le").toString("base64");
}

export function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
    if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`hyper-v-${label}-invalid`);
    return value;
}

export function assertIdentity(options: HyperVCommandOptions): void {
    if (!OWNER_ID_PATTERN.test(options.ownerId)) throw new Error("hyper-v-owner-id-invalid");
    if (!DEVICE_ID_PATTERN.test(options.deviceId)) throw new Error("hyper-v-device-id-invalid");
    if (!INCARNATION_ID_PATTERN.test(options.incarnationId)) throw new Error("hyper-v-incarnation-id-invalid");
    if (options.vmName !== hyperVVmName(options.ownerId, options.deviceId, options.incarnationId)) throw new Error("hyper-v-vm-name-not-owner-scoped");
    if (options.vmId && !VM_ID_PATTERN.test(options.vmId)) throw new Error("hyper-v-vm-id-invalid");
}

export function assertPlainPath(value: string, label: string): string {
    if (!value || value.includes("\0") || !isAbsolute(value)) throw new Error(`hyper-v-${label}-invalid`);
    return resolve(value);
}

export function assertPathInside(root: string, candidate: string, label: string): string {
    const resolvedRoot = assertPlainPath(root, `${label}-root`);
    const resolvedCandidate = assertPlainPath(candidate, label);
    const rel = relative(resolvedRoot, resolvedCandidate);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error(`hyper-v-${label}-outside-owner-root`);
    }
    return resolvedCandidate;
}

export function ownershipMarker(ownerId: string, deviceId: string, incarnationId: string): string {
    return `ccc-device-lab:${ownerId}:${deviceId}:${incarnationId}`;
}

export function jsonScript(lines: string[], initialStage?: string, deferHyperVImport = false): string {
    if (initialStage && !/^hyper-v-[a-z0-9-]{3,128}$/.test(initialStage)) {
        throw new Error("hyper-v-diagnostic-stage-invalid");
    }
    return [
        "$ErrorActionPreference = 'Stop'",
        "$ProgressPreference = 'SilentlyContinue'",
        ...(initialStage
            ? [
                `$env:CCC_HYPER_V_STAGE = ${psQuote(initialStage)}`,
                `[Console]::Out.WriteLine(${psQuote(`CCC_HYPER_V_STAGE:${initialStage}`)})`,
            ]
            : []),
        "$TrustedModuleRoot = Join-Path $PSHOME 'Modules'",
        "$env:PSModulePath = $TrustedModuleRoot",
        ...(!deferHyperVImport ? ["Import-Module Hyper-V -ErrorAction Stop"] : []),
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

export function command(executable: string, script: string, input?: string): HyperVProviderCommand {
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
            "$ErrorActionPreference='Stop'",
            "$E=[Console]::In.ReadToEnd().Trim()",
            "if(!$E -or $E.Length -gt 16777216){throw 'hyper-v-powershell-program-invalid'}",
            "try{$D=[Convert]::FromBase64String($E)}catch{throw 'hyper-v-powershell-program-invalid'}",
            "if(!$D.Length -or $D.Length -gt 12582912){throw 'hyper-v-powershell-program-invalid'}",
            "$P=[Text.Encoding]::UTF8.GetString($D);$E=$null;$D=$null",
            "$env:CCC_HYPER_V_STAGE=$null",
            "try{$B=[ScriptBlock]::Create($P)}catch{throw 'hyper-v-powershell-parse-failed'}",
            "try{&$B}catch{$M=[string]$_.Exception.Message;if($M-match'^hyper-v-[a-z0-9-]{3,128}$'){throw $M};$S=$env:CCC_HYPER_V_STAGE;if($S-match'^hyper-v-[a-z0-9-]{3,128}$'){throw $S};throw 'hyper-v-powershell-execution-failed'}",
        ].join("\n");
        return {
            mode: "exec",
            provider: "hyper-v",
            executable,
            args: hiddenWindowsPowerShellArgs(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedPowerShell(loader)]),
            input: Buffer.from(program, "utf8").toString("base64"),
        };
    }
    return {
        mode: "exec",
        provider: "hyper-v",
        executable,
        args: hiddenWindowsPowerShellArgs(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded]),
        ...(input !== undefined ? { input } : {}),
    };
}

export function isoWriterLines(): string[] {
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
        "    IntPtr readPointer = IntPtr.Zero;",
        "    IntPtr writtenPointer = IntPtr.Zero;",
        "    try {",
        "      readPointer = Marshal.AllocHGlobal(sizeof(long));",
        "      writtenPointer = Marshal.AllocHGlobal(sizeof(long));",
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
        "      if (readPointer != IntPtr.Zero) Marshal.FreeHGlobal(readPointer);",
        "      if (writtenPointer != IntPtr.Zero) Marshal.FreeHGlobal(writtenPointer);",
        "    }",
        "  }",
        "}",
        "'@ -Language CSharp -ErrorAction Stop",
        "}",
        "function Remove-CccIsoSourceRoot([string]$SourceRoot) {",
        "  Assert-NoReparsePath $SourceRoot",
        "  if (-not (Test-Path -LiteralPath $SourceRoot)) { return }",
        "  $SourceRootItem = Get-Item -LiteralPath $SourceRoot -Force -ErrorAction Stop",
        "  if (-not $SourceRootItem.PSIsContainer -or ($SourceRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'hyper-v-provisioning-media-source-directory-failed' }",
        "  $SourceChildren = @(Get-ChildItem -LiteralPath $SourceRoot -Force -ErrorAction Stop)",
        "  foreach ($SourceChild in $SourceChildren) {",
        "    if ($SourceChild.PSIsContainer -or ($SourceChild.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'hyper-v-provisioning-media-source-directory-failed' }",
        "  }",
        "  foreach ($SourceChild in $SourceChildren) {",
        "    $CurrentChild = Get-Item -LiteralPath $SourceChild.FullName -Force -ErrorAction Stop",
        "    if ($CurrentChild.PSIsContainer -or ($CurrentChild.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'hyper-v-provisioning-media-source-directory-failed' }",
        "    Remove-Item -LiteralPath $CurrentChild.FullName -Force -ErrorAction Stop",
        "  }",
        "  Remove-Item -LiteralPath $SourceRoot -Force -ErrorAction Stop",
        "}",
        "function Write-CccIso([Collections.IDictionary]$Files, [string]$IsoPath, [string]$VolumeName, [string]$SourceRoot) {",
        "  Assert-NoReparsePath $IsoPath",
        "  Assert-NoReparsePath $SourceRoot",
        "  if ($null -eq $Files -or $Files.Count -lt 1 -or $Files.Count -gt 8) { throw 'hyper-v-provisioning-media-source-entry-invalid' }",
        "  [Console]::Out.WriteLine('hyper-v-provisioning-media-volume-name-invalid')",
        "  $NormalizedVolumeName = ([string]$VolumeName).ToUpperInvariant()",
        "  if ($NormalizedVolumeName.Length -lt 1 -or $NormalizedVolumeName.Length -gt 15 -or $NormalizedVolumeName -notmatch '^[A-Z0-9_]+$') { throw 'hyper-v-provisioning-media-volume-name-invalid' }",
        "  if (Test-Path -LiteralPath $IsoPath) { Remove-Item -LiteralPath $IsoPath -Force -ErrorAction Stop }",
        "  try { Remove-CccIsoSourceRoot $SourceRoot } catch { throw 'hyper-v-provisioning-media-source-directory-failed' }",
        "  $Image = $null",
        "  $ImageRoot = $null",
        "  $ResultImage = $null",
        "  $ImageStream = $null",
        "  $CccIsoFailure = $null",
        "  try {",
        "    [Console]::Out.WriteLine('hyper-v-provisioning-media-source-directory-failed')",
        "    try {",
        "      New-Item -ItemType Directory -Path (Split-Path -Parent $SourceRoot) -Force -ErrorAction Stop | Out-Null",
        "      New-Item -ItemType Directory -Path $SourceRoot -ErrorAction Stop | Out-Null",
        "      $SourceAcl = Get-Acl -LiteralPath $SourceRoot -ErrorAction Stop",
        "      $SourceAcl.SetAccessRuleProtection($true, $false)",
        "      foreach ($Rule in @($SourceAcl.Access)) { [void]$SourceAcl.RemoveAccessRuleAll($Rule) }",
        "      $SourceIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().User",
        "      $SourceRule = [Security.AccessControl.FileSystemAccessRule]::new($SourceIdentity, [Security.AccessControl.FileSystemRights]::FullControl, ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit), [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)",
        "      $SourceAcl.SetAccessRule($SourceRule)",
        "      Set-Acl -LiteralPath $SourceRoot -AclObject $SourceAcl -ErrorAction Stop",
        "    } catch { throw 'hyper-v-provisioning-media-source-directory-failed' }",
        "    Assert-NoReparsePath $SourceRoot",
        "    [Console]::Out.WriteLine('hyper-v-provisioning-media-com-unavailable')",
        "    try { $Image = New-Object -ComObject IMAPI2FS.MsftFileSystemImage } catch { throw 'hyper-v-provisioning-media-com-unavailable' }",
        "    [Console]::Out.WriteLine('hyper-v-provisioning-media-filesystem-selection-failed')",
        "    try { $Image.FileSystemsToCreate = 7 } catch {",
        "      try { $Image.ChooseImageDefaultsForMediaType(1) } catch { throw 'hyper-v-provisioning-media-filesystem-selection-failed' }",
        "    }",
        "    [Console]::Out.WriteLine('hyper-v-provisioning-media-volume-name-failed')",
        "    try { $Image.VolumeName = $NormalizedVolumeName } catch { throw 'hyper-v-provisioning-media-volume-name-failed' }",
        "    $ImageRoot = $Image.Root",
        "    $TotalSourceBytes = [long]0",
        "    foreach ($Entry in $Files.GetEnumerator()) {",
        "      $EntryName = [string]$Entry.Key",
        "      $EntryBytes = [byte[]]$Entry.Value",
        "      [Console]::Out.WriteLine('hyper-v-provisioning-media-source-entry-invalid')",
        "      if ($EntryName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' -or $null -eq $EntryBytes -or $EntryBytes.Length -lt 1 -or $EntryBytes.Length -gt 1MB) { throw 'hyper-v-provisioning-media-source-entry-invalid' }",
        "      $TotalSourceBytes += $EntryBytes.Length",
        "      if ($TotalSourceBytes -gt 8MB) { throw 'hyper-v-provisioning-media-source-entry-invalid' }",
        "      $EntryPath = Join-Path $SourceRoot $EntryName",
        "      [Console]::Out.WriteLine('hyper-v-provisioning-media-source-file-failed')",
        "      try {",
        "        [IO.File]::WriteAllBytes($EntryPath, $EntryBytes)",
        "        $EntryItem = Get-Item -LiteralPath $EntryPath -Force -ErrorAction Stop",
        "      } catch { throw 'hyper-v-provisioning-media-source-file-failed' }",
        "      if ($EntryItem.Length -ne $EntryBytes.Length -or ($EntryItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'hyper-v-provisioning-media-source-file-invalid' }",
        "    }",
        "    Assert-NoReparsePath $SourceRoot",
        "    [Console]::Out.WriteLine('hyper-v-provisioning-media-add-tree-failed')",
        "    try { $ImageRoot.AddTree($SourceRoot, $false) } catch { throw 'hyper-v-provisioning-media-add-tree-failed' }",
        "    [Console]::Out.WriteLine('hyper-v-provisioning-media-result-image-failed')",
        "    try { $ResultImage = $Image.CreateResultImage() } catch { throw 'hyper-v-provisioning-media-result-image-failed' }",
        "    $ImageStream = $ResultImage.ImageStream",
        "    [Console]::Out.WriteLine('hyper-v-provisioning-media-output-open-failed')",
        "    [CccIsoStreamWriter]::Write($ImageStream, $IsoPath, [int]$ResultImage.BlockSize, [long]$ResultImage.TotalBlocks)",
        "  } catch {",
        "    if (Test-Path -LiteralPath $IsoPath) { Remove-Item -LiteralPath $IsoPath -Force -ErrorAction SilentlyContinue }",
        "    $Cause = $_.Exception",
        "    for ($Depth = 0; $Cause -and $Depth -lt 8; $Depth++) {",
        "      $CauseMessage = [string]$Cause.Message",
        "      if ($CauseMessage -match '\\b(hyper-v-provisioning-media-(?:block-invalid|stream-invalid|output-open-failed|copy-incomplete|com-unavailable|configure-failed|filesystem-selection-failed|volume-name-invalid|volume-name-failed|source-entry-invalid|source-directory-failed|source-file-invalid|source-file-failed|add-tree-failed|result-image-failed)\\b') { $CccIsoFailure = [string]$Matches[0]; break }",
        "      $Cause = $Cause.InnerException",
        "    }",
        "    if ($null -eq $CccIsoFailure) { $CccIsoFailure = 'hyper-v-provisioning-media-create-failed' }",
        "  } finally {",
        "    foreach ($ComObject in @($ImageStream, $ResultImage, $ImageRoot, $Image)) {",
        "      if ($null -ne $ComObject -and [Runtime.InteropServices.Marshal]::IsComObject($ComObject)) {",
        "        try { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($ComObject) | Out-Null } catch {}",
        "      }",
        "    }",
        "    $ImageStream = $null; $ResultImage = $null; $ImageRoot = $null; $Image = $null",
        "    try { Remove-CccIsoSourceRoot $SourceRoot } catch {",
        "      [Console]::Out.WriteLine('hyper-v-provisioning-media-source-cleanup-failed')",
        "      if ($null -eq $CccIsoFailure) { $CccIsoFailure = 'hyper-v-provisioning-media-source-cleanup-failed' }",
        "    }",
        "  }",
        "  if ($null -ne $CccIsoFailure) { [Console]::Out.WriteLine($CccIsoFailure); throw $CccIsoFailure }",
        "  $IsoItem = Get-Item -LiteralPath $IsoPath -Force -ErrorAction Stop",
        "  if ($IsoItem.Length -le 0 -or $IsoItem.Length -gt 32MB -or ($IsoItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {",
        "    Remove-Item -LiteralPath $IsoPath -Force -ErrorAction SilentlyContinue",
        "    throw 'hyper-v-provisioning-media-invalid'",
        "  }",
        "}",
    ];
}

function elevatedPowerShellCommand(executable: string, networkScript: string, deadlineUnixMs: number): HyperVProviderCommand {
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
        "  $Stage = [string]$env:CCC_HYPER_V_STAGE",
        "  $ErrorCode = if ($Candidate -match '^hyper-v-[a-z0-9:-]+$') { $Candidate } elseif ($Stage -match '^hyper-v-[a-z0-9-]{3,128}$') { $Stage } else { 'hyper-v-network-elevated-operation-failed' }",
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
        "  try { $Child = Start-Process -FilePath $Executable -Verb RunAs -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',$InnerEncoded) -WindowStyle Hidden -PassThru -ErrorAction Stop } catch { if ($_.Exception -is [ComponentModel.Win32Exception] -and $_.Exception.NativeErrorCode -eq 1223) { throw 'hyper-v-network-elevation-cancelled' }; $ElevationHResult = [Math]::Abs([long]$_.Exception.HResult); throw ('hyper-v-network-elevation-failed:' + $ElevationHResult) }",
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

export function elevatedNetworkCommand(executable: string, networkScript: string, deadlineUnixMs: number): HyperVProviderCommand {
    return elevatedPowerShellCommand(executable, networkScript, deadlineUnixMs);
}

export function ownedVmPrelude(options: HyperVCommandOptions): string[] {
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

export function ownedSnapshotPrelude(options: HyperVSnapshotOptions): string[] {
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

export function guestSessionPrelude(options: HyperVGuestOptions): string[] {
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

export function assertGuestPath(value: string): string {
    if (!value || value.length > 4096 || value.includes("\0") || !/^[A-Za-z]:\\/.test(value)) {
        throw new Error("hyper-v-guest-path-invalid");
    }
    return value;
}

export function assertLinuxGuestPath(value: string): string {
    if (!value || value.length > 4096 || !/^\/[A-Za-z0-9._/+~=-]*$/.test(value)) {
        throw new Error("hyper-v-linux-guest-path-invalid");
    }
    return value;
}

export function assertLinuxUsername(value: string): string {
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(value)) throw new Error("hyper-v-linux-guest-username-invalid");
    return value;
}

export function assertIpv4(value: string, label: string): string {
    const parts = value.split(".");
    if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) {
        throw new Error(`hyper-v-${label}-invalid`);
    }
    return value;
}

export function sshBaseArgs(options: HyperVLinuxSshOptions): string[] {
    const privateRoot = options.privateRoot || options.deviceRoot;
    const privateKeyPath = assertPathInside(privateRoot, options.sshPrivateKeyPath, "linux-ssh-private-key");
    const knownHostsPath = assertPathInside(privateRoot, options.knownHostsPath, "linux-ssh-known-hosts");
    const username = assertLinuxUsername(options.guestUsername);
    const address = assertIpv4(options.networkAddress, "linux-network-address");
    const hostKeyAlias = options.hostKeyAlias
        ? assertIpv4(options.hostKeyAlias, "linux-host-key-alias")
        : "";
    const timeoutSec = Math.min(30, Math.max(1, Math.ceil((options.timeoutMs || 30000) / 1000)));
    return [
        "-F", "NUL",
        ...(options.verboseHostKeyDiagnostics ? ["-v"] : []),
        "-i", privateKeyPath,
        "-o", "BatchMode=yes",
        "-o", "IdentitiesOnly=yes",
        "-o", "StrictHostKeyChecking=yes",
        "-o", "HostKeyAlgorithms=ssh-ed25519",
        "-o", `UserKnownHostsFile=${knownHostsPath}`,
        ...(hostKeyAlias ? [
            "-o", `HostKeyAlias=${hostKeyAlias}`,
            "-o", "CheckHostIP=no",
        ] : []),
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
