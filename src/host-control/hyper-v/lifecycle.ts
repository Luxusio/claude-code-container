import {
    type HyperVProviderCommand,
    type HyperVCommandOptions,
    type HyperVStartOptions,
    type HyperVGuestReadyOptions,
} from "./contracts.js";
import {
    OWNER_ID_PATTERN,
    DEVICE_ID_PATTERN,
    INCARNATION_ID_PATTERN,
    psQuote,
    boundedInteger,
    assertIdentity,
    assertPlainPath,
    assertPathInside,
    ownershipMarker,
    jsonScript,
    command,
    ownedVmPrelude,
    hyperVVmName,
} from "./core.js";
import { hyperVPowerShellFileCommand } from "./powershell-assets.js";
import { hyperVOwnedVmContractV1 } from "./powershell-contracts.js";

export function hyperVStatusCommand(options: HyperVCommandOptions): HyperVProviderCommand {
    return command(options.executable, jsonScript([
        ...ownedVmPrelude(options),
        "$Disk = Get-VMHardDiskDrive -VM $Vm -ErrorAction SilentlyContinue | Select-Object -First 1",
        "$Snapshots = @(Get-VMSnapshot -VM $Vm -ErrorAction SilentlyContinue | Where-Object { $_.Name -like ('ccc-' + $ExpectedMarker.Split(':')[1] + '-*') } | ForEach-Object { [ordered]@{ snapshotId = [string]$_.Id; snapshotName = [string]$_.Name; snapshotType = [string]$_.SnapshotType } })",
        "$Result = [ordered]@{ ok = $true; vmId = [string]$Vm.Id; vmName = $Vm.Name; state = [string]$Vm.State; status = [string]$Vm.Status; uptimeMs = [Math]::Floor($Vm.Uptime.TotalMilliseconds); diskPath = if ($Disk) { $Disk.Path } else { $null }; checkpointPolicy = [string]$Vm.CheckpointType; snapshots = $Snapshots }",
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
    const timeoutMs = Math.min(20 * 60 * 1000, Math.max(1000, Math.floor(options.timeoutMs)));
    const expectedNetworkAddress = options.expectedNetworkAddress ? String(options.expectedNetworkAddress) : "";
    if (expectedNetworkAddress && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(expectedNetworkAddress)) throw new Error("hyper-v-guest-network-address-invalid");
    return command(options.executable, jsonScript([
        ...ownedVmPrelude(options),
        `$CredentialPath = ${psQuote(credentialPath)}`,
        `$ProvisioningMedia = ${psQuote(provisioningMediaPath)}`,
        `$ExpectedNetworkAddress = ${psQuote(expectedNetworkAddress)}`,
        `$Deadline = [DateTime]::UtcNow.AddMilliseconds(${timeoutMs})`,
        "$Attempts = 0",
        "$LastFailure = 'powershell-direct-unavailable'",
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
        "    $Candidate = [string]$_.Exception.Message",
        "    $FailureId = [string]$_.FullyQualifiedErrorId",
        "    if ($Candidate -match '^hyper-v-guest-vm-state:') { $LastFailure = 'hyper-v-guest-vm-not-running' }",
        "    elseif ($Candidate -match '^hyper-v-[a-z0-9-]{3,120}$') { $LastFailure = $Candidate }",
        "    elseif ($FailureId -match 'AccessDenied|InvalidCredential|Authentication') { $LastFailure = 'powershell-direct-authentication-failed' }",
        "    elseif ($FailureId -match 'PSSession|VMNotRunning|InvalidState') { $LastFailure = 'powershell-direct-session-unavailable' }",
        "    else { $LastFailure = 'powershell-direct-unavailable' }",
        "  } finally {",
        "    if ($Session) { Remove-PSSession -Session $Session -ErrorAction SilentlyContinue }",
        "  }",
        "  Start-Sleep -Seconds 2",
        "}",
        "$Failure = [ordered]@{ ok = $false; error = 'hyper-v-guest-ready-timeout'; reason = $LastFailure; attempts = $Attempts }",
        "$Failure | ConvertTo-Json -Compress -Depth 4",
        "exit 1",
    ]));
}

export function hyperVGuestBootDiagnosticCommand(options: HyperVCommandOptions): HyperVProviderCommand {
    return hyperVPowerShellFileCommand(
        options.executable,
        "guest-boot-diagnostic",
        hyperVOwnedVmContractV1(options),
    );
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
