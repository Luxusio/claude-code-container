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

const HYPER_V_POWERSHELL_DIRECT_ATTEMPT_TIMEOUT_SECONDS = 15;

export function hyperVStatusCommand(options: HyperVCommandOptions): HyperVProviderCommand {
    return command(options.executable, jsonScript([
        ...ownedVmPrelude(options),
        "$Disk = Get-VMHardDiskDrive -VM $Vm -ErrorAction SilentlyContinue | Select-Object -First 1",
        "$DiskPathValue = if ($Disk) { [string]$Disk.Path } else { $null }",
        "if ($DiskPathValue) { try { $DiskChainVhd = Get-VHD -Path $DiskPathValue -ErrorAction Stop; while ($DiskChainVhd -and $DiskChainVhd.ParentPath) { $DiskPathValue = [string]$DiskChainVhd.ParentPath; $DiskChainVhd = Get-VHD -Path $DiskPathValue -ErrorAction Stop } } catch { } }",
        "$Snapshots = @(Get-VMSnapshot -VM $Vm -ErrorAction SilentlyContinue | Where-Object { $_.Name -like ('ccc-' + $ExpectedMarker.Split(':')[1] + '-*') } | ForEach-Object { [ordered]@{ snapshotId = [string]$_.Id; snapshotName = [string]$_.Name; snapshotType = [string]$_.SnapshotType } })",
        "$Result = [ordered]@{ ok = $true; vmId = [string]$Vm.Id; vmName = $Vm.Name; state = [string]$Vm.State; status = [string]$Vm.Status; uptimeMs = [Math]::Floor($Vm.Uptime.TotalMilliseconds); diskPath = $DiskPathValue; checkpointPolicy = [string]$Vm.CheckpointType; snapshots = $Snapshots }",
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
        // Every exit path emits the same structured failure on stdout. Previously the pre-loop
        // checks and the ownership prelude threw bare PowerShell exceptions onto stderr, which the
        // broker cannot parse, so it fell back to a bare `powershell-direct-unavailable` and the
        // real cause was lost. Only the deadline path was ever explicable.
        //
        // The boundary is this function's own lines. `jsonScript` emits the module import and the
        // helper definitions before this `try`, so a broken or absent Hyper-V module still dies as
        // a bare stderr exception — the broker now names that case through the bounded
        // `errorDetail.diagnosticCode` instead, so it is no longer silent either.
        "$Attempts = 0",
        "$LastFailure = 'powershell-direct-unavailable'",
        "$ScrubConfirmed = $false",
        "$MediaDetached = $false",
        "try {",
        ...ownedVmPrelude(options).map((line) => `  ${line}`),
        `  $CredentialPath = ${psQuote(credentialPath)}`,
        `  $ProvisioningMedia = ${psQuote(provisioningMediaPath)}`,
        `  $ExpectedNetworkAddress = ${psQuote(expectedNetworkAddress)}`,
        `  $Deadline = [DateTime]::UtcNow.AddMilliseconds(${timeoutMs})`,
        "  if (-not (Test-Path -LiteralPath $CredentialPath -PathType Leaf)) { throw 'hyper-v-guest-credential-unavailable' }",
        "  $Credential = Import-Clixml -LiteralPath $CredentialPath -ErrorAction Stop",
        "  if ($Credential -isnot [System.Management.Automation.PSCredential]) { throw 'hyper-v-guest-credential-invalid' }",
        "while ([DateTime]::UtcNow -lt $Deadline) {",
        "  $Attempts++",
        "  $AttemptJob = $null",
        "  try {",
        "    $Vm = Get-VM -Id $ExpectedId -ErrorAction Stop",
        "    if ($Vm.Name -ne $ExpectedName -or [string]$Vm.Notes -cne $ExpectedMarker) { throw 'hyper-v-vm-ownership-mismatch' }",
        "    if ($Vm.State -ne 'Running') { throw ('hyper-v-guest-vm-state:' + [string]$Vm.State) }",
        // The probe also reports whether first logon has scrubbed the provisioning
        // secrets. Readiness used to mean only "PowerShell Direct authenticates",
        // which becomes true as soon as the OOBE account exists — possibly before
        // FirstLogonCommands has run. The block below then deleted the media the
        // first-logon program is now loaded FROM, so the program exited 3 (no
        // CCC_UNATTEND volume) and the scrub silently never happened. Nothing
        // reads that exit code, so the loss was invisible.
        "    $AttemptJob = Invoke-Command -VMId $ExpectedId -Credential $Credential -ScriptBlock { $Winlogon = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon'; [ordered]@{ computerName = [Environment]::MachineName; addresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object IPAddress); firstLogonCompleted = [string](Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\ccc' -Name 'FirstLogonCompleted' -ErrorAction SilentlyContinue).FirstLogonCompleted; provisioningSecretsPresent = [bool]((Test-Path -LiteralPath 'C:\\Windows\\Panther\\unattend.xml') -or (Test-Path -LiteralPath 'C:\\Windows\\Panther\\Unattend\\unattend.xml') -or ($null -ne (Get-ItemProperty -LiteralPath $Winlogon -Name 'DefaultPassword' -ErrorAction SilentlyContinue))) } } -AsJob -ErrorAction Stop",
        `    $CompletedJob = Wait-Job -Job $AttemptJob -Timeout ${HYPER_V_POWERSHELL_DIRECT_ATTEMPT_TIMEOUT_SECONDS} -ErrorAction Stop`,
        "    if (-not $CompletedJob) { throw 'powershell-direct-attempt-timeout' }",
        "    $Probe = Receive-Job -Job $AttemptJob -ErrorAction Stop",
        // These two run BEFORE the network check, and the order is load-bearing rather than
        // stylistic whenever a static address is configured — the default. In that case the
        // first-logon program assigns the address itself (New-NetIPAddress in windows-guest.ts) as
        // its FIRST action, before the scrub and long before the marker. With networking:false the
        // program emits no network block and $ExpectedNetworkAddress is empty, so there is no gate
        // to be downstream of and the ordering is simply moot.
        // So the network check is causally downstream of these two: a launcher that never ran
        // leaves the guest on DHCP/APIPA, and with the network check first it threw
        // hyper-v-guest-network-not-ready on every attempt for the whole budget — these gates were
        // never reached, the broker's containment switch never matched, and the guest stayed
        // Running with the plaintext answer file still mounted. The inversion was total: a healthy
        // guest got its address, reached the marker check, and was contained, while the guest that
        // had actually failed was left up. Reporting "the address our program was supposed to set
        // is missing" when the program never ran is also simply the wrong cause.
        //
        // Both written fail-closed rather than the naive `if ($Probe.x)` form: an absent property
        // or a null $Probe is falsy, so the naive form would open the gate on a malformed probe —
        // the one case where the guest's answer is least trustworthy.
        //
        // The marker is checked first because it is the only signal that proves our program ran.
        // The secrets check stays as a second, independent condition: the marker says the scrub
        // ran to completion, the secrets check says the three signals it probes are gone, and
        // neither implies the other. The scrub clears six things; the probe re-tests three of
        // them, so a Remove-ItemProperty that failed on DefaultUserName, AutoAdminLogon or
        // AutoLogonCount is not visible here. No password survives in that state.
        //
        // Compared against this incarnation's own ownership marker, the same string
        // ownedVmPrelude already checks against $Vm.Notes, so a value baked into a captured base
        // image belongs to a different incarnation and cannot satisfy it. An absent property
        // stringifies to "" and fails the comparison, so this is fail-closed without a type guard.
        "    if ([string]$Probe.firstLogonCompleted -cne $ExpectedMarker) { throw 'hyper-v-guest-first-logon-incomplete' }",
        "    if ($Probe.provisioningSecretsPresent -isnot [bool] -or $Probe.provisioningSecretsPresent) { throw 'hyper-v-guest-provisioning-not-scrubbed' }",
        // Latched the moment both scrub gates pass, and reported on the failure payload. The host
        // otherwise has to infer "was this guest ever scrubbed" from whether the ISO is still on
        // disk, and that inference breaks for every failure BELOW this line: if Remove-VMDvdDrive
        // or Remove-Item fails (locked file, ACL), or Assert-NoReparsePath rejects the path, the
        // media stays on a guest that is demonstrably scrubbed. The host would then power off a
        // healthy VM — and keep doing it, because the marker persists and every later start
        // re-runs into the same failure. Those cases surface under at least three different reason
        // codes, so a flag is the only thing that catches all of them.
        "    $ScrubConfirmed = $true",
        // The media goes as soon as the two SCRUB gates pass, before the network check rather than
        // after it. Waiting for the network check kept a fully scrubbed guest's ISO on disk
        // whenever the address did not match — a stale DHCP lease answering first, a wrong switch,
        // New-NetIPAddress losing a race. The host reads a retained ISO as "this guest was never
        // scrubbed" and powers it off, which is wrong twice over: the guest IS scrubbed, and the
        // plaintext residue is the host-side file, which stopping the VM does nothing about.
        // Deleting here keeps the property the host relies on true — media present iff unscrubbed —
        // and still cannot race the first-logon program, because both scrub gates have passed.
        "    if (-not $ProvisioningMedia) { $MediaDetached = $true }",
        "    if ($ProvisioningMedia) {",
        "      $ProvisioningDrives = @(Get-VMDvdDrive -VM $Vm -ErrorAction Stop | Where-Object { $_.Path -eq $ProvisioningMedia })",
        "      if ($ProvisioningDrives.Count -gt 1) { throw 'hyper-v-guest-provisioning-media-attachment-ambiguous' }",
        "      if ($ProvisioningDrives.Count -eq 1) { Remove-VMDvdDrive -VMDvdDrive $ProvisioningDrives[0] -ErrorAction Stop }",
        "      $MediaDetached = $true",
        "      Assert-NoReparsePath $ProvisioningMedia",
        "      if (Test-Path -LiteralPath $ProvisioningMedia) { Remove-Item -LiteralPath $ProvisioningMedia -Force -ErrorAction Stop }",
        "    }",
        "    if ($ExpectedNetworkAddress -and $Probe.addresses -notcontains $ExpectedNetworkAddress) { throw 'hyper-v-guest-network-not-ready' }",
        "    $Result = [ordered]@{ ok = $true; vmId = [string]$Vm.Id; vmName = $Vm.Name; computerName = [string]$Probe.computerName; attempts = $Attempts; networkAddress = $ExpectedNetworkAddress }",
        "    $Result | ConvertTo-Json -Compress -Depth 5",
        "    exit 0",
        "  } catch {",
        "    $Candidate = [string]$_.Exception.Message",
        "    $FailureId = [string]$_.FullyQualifiedErrorId",
        "    if ($Candidate -match '^hyper-v-guest-vm-state:') { $LastFailure = 'hyper-v-guest-vm-not-running' }",
        "    elseif ($Candidate -match '^hyper-v-[a-z0-9-]{3,120}$') { $LastFailure = $Candidate }",
        "    elseif ($Candidate -eq 'powershell-direct-attempt-timeout') { $LastFailure = $Candidate }",
        "    elseif ($FailureId -match 'AccessDenied|InvalidCredential|Authentication') { $LastFailure = 'powershell-direct-authentication-failed' }",
        "    elseif ($FailureId -match 'PSSession|VMNotRunning|InvalidState') { $LastFailure = 'powershell-direct-session-unavailable' }",
        "    else { $LastFailure = 'powershell-direct-unavailable' }",
        "  } finally {",
        "    if ($AttemptJob) { Remove-Job -Job $AttemptJob -Force -ErrorAction SilentlyContinue }",
        "  }",
        "  Start-Sleep -Seconds 2",
        "}",
        "  $Failure = [ordered]@{ ok = $false; error = 'hyper-v-guest-ready-timeout'; reason = $LastFailure; attempts = $Attempts; scrubConfirmed = [bool]$ScrubConfirmed; mediaDetached = [bool]$MediaDetached }",
        "  $Failure | ConvertTo-Json -Compress -Depth 4",
        "  exit 1",
        "} catch {",
        // The message is only trusted when it already is one of our own bounded codes; anything
        // else is host text and is replaced by a constant that still says which phase failed.
        "  $Reason = [string]$_.Exception.Message",
        "  if ($Reason -notmatch '^hyper-v-[a-z0-9-]{3,120}$') { $Reason = 'hyper-v-guest-ready-precondition-failed' }",
        "  $Failure = [ordered]@{ ok = $false; error = 'hyper-v-guest-ready-failed'; reason = $Reason; attempts = $Attempts; scrubConfirmed = [bool]$ScrubConfirmed; mediaDetached = [bool]$MediaDetached }",
        "  $Failure | ConvertTo-Json -Compress -Depth 4",
        "  exit 1",
        "}",
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
        "$OwnedDiskDir = [IO.Path]::GetFullPath((Split-Path -Parent $ExpectedDisk))",
        "if (-not $OwnedDiskDir.EndsWith([IO.Path]::DirectorySeparatorChar)) { $OwnedDiskDir += [IO.Path]::DirectorySeparatorChar }",
        "$Vm = Get-VM -Id $ExpectedId -ErrorAction SilentlyContinue",
        "if (-not $Vm) {",
        "  if (Get-VM -Name $ExpectedName -ErrorAction SilentlyContinue) { throw 'hyper-v-vm-identity-conflict' }",
        "  foreach ($OwnedPath in @($ExpectedDisks) + @($ExpectedMedia)) { Assert-NoReparsePath $OwnedPath; if (Test-Path -LiteralPath $OwnedPath) { Remove-Item -LiteralPath $OwnedPath -Force -ErrorAction Stop } }",
        "  $Result = [ordered]@{ ok = $true; vmId = [string]$ExpectedId; vmName = $ExpectedName; deleted = $true; alreadyMissing = $true; diskPath = $ExpectedDisk }",
        "  $Result | ConvertTo-Json -Compress -Depth 5",
        "  exit 0",
        "}",
        "if ($Vm.Name -ne $ExpectedName -or [string]$Vm.Notes -cne $ExpectedMarker) { throw 'hyper-v-vm-ownership-mismatch' }",
        "$Attached = @(Get-VMHardDiskDrive -VM $Vm -ErrorAction SilentlyContinue | ForEach-Object { [IO.Path]::GetFullPath([string]$_.Path) })",
        "$ExpectedDiskPaths = @($ExpectedDisks | ForEach-Object { [IO.Path]::GetFullPath([string]$_) })",
        "if (@($Attached | Where-Object { $ExpectedDiskPaths -notcontains $_ -and -not $_.StartsWith($OwnedDiskDir, [StringComparison]::OrdinalIgnoreCase) }).Count -ne 0) { throw 'hyper-v-vm-disk-ownership-mismatch' }",
        "$AttachedMedia = @(Get-VMDvdDrive -VM $Vm -ErrorAction SilentlyContinue | Where-Object { $_.Path } | ForEach-Object { [IO.Path]::GetFullPath([string]$_.Path) })",
        "$ExpectedMediaPaths = @($ExpectedMedia | ForEach-Object { [IO.Path]::GetFullPath([string]$_) })",
        "if (@($AttachedMedia | Where-Object { $ExpectedMediaPaths -notcontains $_ }).Count -ne 0) { throw 'hyper-v-vm-media-ownership-mismatch' }",
        "$StopAttempts = 0",
        "while ($Vm -and $Vm.State -ne 'Off') {",
        "  if ($StopAttempts -ge 20) { throw 'hyper-v-vm-delete-stop-timeout' }",
        "  $StopAttempts++",
        "  try { Stop-VM -VM $Vm -TurnOff -Force -ErrorAction Stop | Out-Null } catch { }",
        "  Start-Sleep -Milliseconds 500",
        "  $Vm = Get-VM -Id $ExpectedId -ErrorAction SilentlyContinue",
        "}",
        "if ($Vm) {",
        "  $RemoveAttempts = 0",
        "  while ($true) {",
        "    $RemoveAttempts++",
        "    try { Remove-VM -VM $Vm -Force -ErrorAction Stop; break }",
        "    catch { if ($RemoveAttempts -ge 10) { throw }; Start-Sleep -Milliseconds 500; $Vm = Get-VM -Id $ExpectedId -ErrorAction SilentlyContinue; if (-not $Vm) { break } }",
        "  }",
        "}",
        "function Remove-OwnedItemWithRetry([string]$Path) {",
        "  Assert-NoReparsePath $Path",
        "  for ($ItemAttempts = 1; $ItemAttempts -le 10; $ItemAttempts++) {",
        "    if (-not (Test-Path -LiteralPath $Path)) { return }",
        "    try { Remove-Item -LiteralPath $Path -Force -ErrorAction Stop; return }",
        "    catch { if ($ItemAttempts -ge 10) { throw }; Start-Sleep -Milliseconds 500 }",
        "  }",
        "}",
        "foreach ($OwnedPath in @($ExpectedDisks) + @($ExpectedMedia)) { Remove-OwnedItemWithRetry $OwnedPath }",
        "if (Test-Path -LiteralPath $OwnedDiskDir) { foreach ($Diff in @(Get-ChildItem -LiteralPath $OwnedDiskDir -Filter *.avhdx -File -ErrorAction SilentlyContinue)) { Remove-OwnedItemWithRetry $Diff.FullName } }",
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
        "$OwnedDiskDir = [IO.Path]::GetFullPath((Split-Path -Parent $DiskPath))",
        "if (-not $OwnedDiskDir.EndsWith([IO.Path]::DirectorySeparatorChar)) { $OwnedDiskDir += [IO.Path]::DirectorySeparatorChar }",
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
        "  if (@($AttachedPaths | Where-Object { $ExpectedPaths -notcontains $_ -and -not $_.StartsWith($OwnedDiskDir, [StringComparison]::OrdinalIgnoreCase) }).Count -ne 0) { throw 'hyper-v-orphan-vm-disk-mismatch' }",
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
