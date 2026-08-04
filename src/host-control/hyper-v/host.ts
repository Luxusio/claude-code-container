import {
    type HyperVProviderCommand,
    type HyperVRebootOptions,
    type HyperVNetworkOptions,
    type HyperVNetworkCleanupOptions,
} from "./contracts.js";
import {
    VM_ID_PATTERN,
    psQuote,
    encodedPowerShell,
    boundedInteger,
    jsonScript,
    command,
    elevatedNetworkCommand,
    ownedVmPrelude,
} from "./core.js";

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
        "    $Child = Start-Process -FilePath $Executable -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',$InnerEncoded) -WindowStyle Hidden -PassThru -ErrorAction Stop",
        "  } else {",
        "    try { $Child = Start-Process -FilePath $Executable -Verb RunAs -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',$InnerEncoded) -WindowStyle Hidden -PassThru -ErrorAction Stop } catch { throw 'hyper-v-setup-elevation-failed' }",
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
    const allowCccOwnedNetworkAdoption = options.allowCccOwnedNetworkAdoption === true;
    const allowPersistedCccIdentityRepair = options.allowPersistedCccIdentityRepair === true;
    const expectedSwitchId = String(options.expectedSwitchId || "").toLowerCase();
    const expectedNatInstanceId = String(options.expectedNatInstanceId || "");
    if (expectedSwitchId && !VM_ID_PATTERN.test(expectedSwitchId)) throw new Error("hyper-v-network-switch-id-invalid");
    if (expectedNatInstanceId && (expectedNatInstanceId.length > 256 || /[\u0000-\u001f]/.test(expectedNatInstanceId))) throw new Error("hyper-v-network-nat-instance-id-invalid");
    return jsonScript([
        "function Set-CccHyperVNetworkStage([string]$Stage) { if ($Stage -notmatch '^hyper-v-network-[a-z0-9-]{3,128}$') { throw 'hyper-v-network-stage-invalid' }; $env:CCC_HYPER_V_STAGE = $Stage; [Console]::Out.WriteLine(('CCC_HYPER_V_STAGE:' + $Stage)) }",
        "Set-CccHyperVNetworkStage 'hyper-v-network-module-import-failed'",
        "Import-Module Hyper-V -ErrorAction Stop",
        `$SwitchName = ${psQuote(switchName)}`,
        `$NatName = ${psQuote(natName)}`,
        `$Prefix = ${psQuote(prefix)}`,
        `$Gateway = ${psQuote(gateway)}`,
        `$PrefixLength = ${prefixLength}`,
        `$AllowExistingNat = ${allowExistingNat ? "$true" : "$false"}`,
        `$AllowCccOwnedNetworkAdoption = ${allowCccOwnedNetworkAdoption ? "$true" : "$false"}`,
        `$AllowPersistedCccIdentityRepair = ${allowPersistedCccIdentityRepair ? "$true" : "$false"}`,
        `$ExpectedSwitchId = ${psQuote(expectedSwitchId)}`,
        `$ExpectedNatInstanceId = ${psQuote(expectedNatInstanceId)}`,
        `$Marker = ${psQuote(marker)}`,
        "function Convert-IPv4ToUInt32([string]$Address) { $Bytes = [Net.IPAddress]::Parse($Address).GetAddressBytes(); [Array]::Reverse($Bytes); return [BitConverter]::ToUInt32($Bytes, 0) }",
        "function Test-IPv4PrefixOverlap([string]$LeftAddress, [int]$LeftLength, [string]$RightAddress, [int]$RightLength) { $Length = [Math]::Min($LeftLength, $RightLength); $Mask = if ($Length -eq 0) { [uint32]0 } else { [uint32]([uint32]::MaxValue - [uint32]([Math]::Pow(2, 32 - $Length) - 1)) }; return ((Convert-IPv4ToUInt32 $LeftAddress) -band $Mask) -eq ((Convert-IPv4ToUInt32 $RightAddress) -band $Mask) }",
        "$CreatedSwitch = $false",
        "$CreatedGateway = $false",
        "$CreatedNat = $false",
        "$CreatedNatInstanceId = ''",
        "$ExistingSwitchOwned = $false",
        "Set-CccHyperVNetworkStage 'hyper-v-network-switch-name-inspection-failed'",
        "$Switches = @(Get-VMSwitch -Name $SwitchName -ErrorAction SilentlyContinue)",
        "if ($Switches.Count -gt 1) { throw 'hyper-v-network-switch-ambiguous' }",
        "Set-CccHyperVNetworkStage 'hyper-v-network-switch-identity-inspection-failed'",
        "if ($ExpectedSwitchId -and ($Switches.Count -ne 1 -or $Switches[0].Id.ToString().ToLowerInvariant() -cne $ExpectedSwitchId)) { throw 'hyper-v-network-switch-identity-conflict' }",
        "if ($Switches.Count -eq 1) {",
        "  if ([string]$Switches[0].SwitchType -ne 'Internal') { throw 'hyper-v-network-switch-type-conflict' }",
        "  if ([string]$Switches[0].Notes -cne $Marker) {",
        "    Set-CccHyperVNetworkStage 'hyper-v-network-marker-inspection-failed'",
        "    $ObservedMarker = [string]$Switches[0].Notes",
        "    $MarkerPrefix = 'ccc-device-lab:hyper-v-network:'",
        "    Set-CccHyperVNetworkStage 'hyper-v-network-marker-classification-failed'",
        "    $ObservedStable = $ObservedMarker -ceq ($MarkerPrefix + 'v1')",
        "    $ObservedToken = $ObservedMarker -cmatch '^ccc-device-lab:hyper-v-network:[a-f0-9]{24}$'",
        "    $ObservedTokenValue = if ($ObservedToken) { $ObservedMarker.Substring($MarkerPrefix.Length) } else { '' }",
        "    $ExpectedStable = $Marker -ceq ($MarkerPrefix + 'v1') -and $NatName -ceq 'CCCDeviceLab'",
        "    $ExpectedToken = $Marker -cmatch '^ccc-device-lab:hyper-v-network:[a-f0-9]{24}$'",
        "    $ExpectedTokenValue = if ($ExpectedToken) { $Marker.Substring($MarkerPrefix.Length) } else { '' }",
        "    if ($AllowPersistedCccIdentityRepair) {",
        "      Set-CccHyperVNetworkStage 'hyper-v-network-identity-evidence-inspection-failed'",
        "      $TokenToStable = $ExpectedToken -and $NatName -ceq ('CCCDeviceLab-' + $ExpectedTokenValue) -and $ObservedStable",
        "      $StableToToken = $ExpectedStable -and $ObservedToken",
        "      if (-not $ExpectedSwitchId -or -not $ExpectedNatInstanceId -or -not ($TokenToStable -or $StableToToken)) { throw 'hyper-v-network-switch-ownership-conflict' }",
        "      Set-CccHyperVNetworkStage 'hyper-v-network-identity-adoption-failed'",
        "      if ($ObservedStable) { $NatName = 'CCCDeviceLab' } else { $NatName = 'CCCDeviceLab-' + $ObservedTokenValue }",
        "    } elseif ($AllowCccOwnedNetworkAdoption) {",
        "      if ($ObservedMarker -ceq 'ccc-device-lab:hyper-v-network:v1') { $NatName = 'CCCDeviceLab' }",
        "      elseif ($ObservedToken) { $NatName = 'CCCDeviceLab-' + $ObservedTokenValue }",
        "      else { throw 'hyper-v-network-switch-ownership-conflict' }",
        "    } else { throw 'hyper-v-network-switch-ownership-conflict' }",
        "    $Marker = $ObservedMarker",
        "  }",
        "  $ExistingSwitchOwned = $true",
        "}",
        "Set-CccHyperVNetworkStage 'hyper-v-network-adapter-inspection-failed'",
        "$ExistingAdapterIndex = $null",
        "if ($Switches.Count -eq 1) { $ExistingAdapter = Get-NetAdapter -Name ('vEthernet (' + $SwitchName + ')') -ErrorAction SilentlyContinue; if ($ExistingAdapter) { $ExistingAdapterIndex = [int]$ExistingAdapter.ifIndex } }",
        "Set-CccHyperVNetworkStage 'hyper-v-network-subnet-inspection-failed'",
        "$PrefixParts = $Prefix.Split('/')",
        "$ForeignNats = @(Get-NetNat -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne $NatName })",
        "foreach ($ForeignNat in $ForeignNats) { $Parts = ([string]$ForeignNat.InternalIPInterfaceAddressPrefix).Split('/'); if ($Parts.Count -eq 2 -and (Test-IPv4PrefixOverlap $PrefixParts[0] $PrefixLength $Parts[0] ([int]$Parts[1]))) { throw 'hyper-v-network-subnet-conflict:nat' } }",
        "$ForeignAddresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254.*' -and ($null -eq $ExistingAdapterIndex -or [int]$_.InterfaceIndex -ne $ExistingAdapterIndex) })",
        "foreach ($ForeignAddress in $ForeignAddresses) { if (Test-IPv4PrefixOverlap $PrefixParts[0] $PrefixLength ([string]$ForeignAddress.IPAddress) ([int]$ForeignAddress.PrefixLength)) { throw 'hyper-v-network-subnet-conflict:interface' } }",
        "Set-CccHyperVNetworkStage 'hyper-v-network-nat-inspection-failed'",
        "$Nats = @(Get-NetNat -Name $NatName -ErrorAction SilentlyContinue)",
        "if ($Nats.Count -gt 1) { throw 'hyper-v-network-nat-ambiguous' }",
        "if ($Nats.Count -eq 1 -and [string]$Nats[0].InternalIPInterfaceAddressPrefix -ne $Prefix) { throw 'hyper-v-network-nat-prefix-conflict' }",
        "if ($Nats.Count -eq 1 -and -not ($AllowExistingNat -or $ExistingSwitchOwned)) { throw 'hyper-v-network-nat-ownership-conflict' }",
        "if ($Nats.Count -eq 1 -and $ExpectedNatInstanceId -and ([string]$Nats[0].InstanceID -cne $ExpectedNatInstanceId)) { throw 'hyper-v-network-nat-identity-conflict' }",
        "Set-CccHyperVNetworkStage 'hyper-v-network-gateway-inspection-failed'",
        "$IsAdministrator = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
        "$GatewayExists = if ($ExistingAdapterIndex) { [bool]@(Get-NetIPAddress -InterfaceIndex $ExistingAdapterIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -eq $Gateway -and $_.PrefixLength -eq $PrefixLength }).Count } else { $false }",
        "$RequiresMutation = ($Switches.Count -eq 0) -or (-not $GatewayExists) -or ($Nats.Count -eq 0)",
        "if ($RequiresMutation -and -not $IsAdministrator) { throw 'hyper-v-network-elevation-required' }",
        "try {",
        "  Set-CccHyperVNetworkStage 'hyper-v-network-switch-create-failed'",
        "  if ($Switches.Count -eq 0) { $Switch = New-VMSwitch -Name $SwitchName -SwitchType Internal -Notes $Marker -ErrorAction Stop; $CreatedSwitch = $true; $Switch = Get-VMSwitch -Id $Switch.Id -ErrorAction Stop } else { $Switch = $Switches[0] }",
        "  if ([string]$Switch.SwitchType -ne 'Internal') { throw 'hyper-v-network-switch-type-conflict' }",
        "  if ([string]$Switch.Notes -cne $Marker) { throw 'hyper-v-network-switch-ownership-conflict' }",
        "  Set-CccHyperVNetworkStage 'hyper-v-network-adapter-inspection-failed'",
        "  $Adapter = Get-NetAdapter -Name ('vEthernet (' + $SwitchName + ')') -ErrorAction Stop",
        "  $GatewayMatches = @(Get-NetIPAddress -InterfaceIndex $Adapter.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -eq $Gateway -and $_.PrefixLength -eq $PrefixLength })",
        "  if ($GatewayMatches.Count -eq 0) {",
        "    $AdapterAddresses = @(Get-NetIPAddress -InterfaceIndex $Adapter.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.PrefixOrigin -ne 'WellKnown' -and $_.IPAddress -ne '169.254.0.0' })",
        "    if ($AdapterAddresses.Count -gt 0) { throw 'hyper-v-network-gateway-conflict' }",
        "    Set-CccHyperVNetworkStage 'hyper-v-network-gateway-create-failed'",
        "    New-NetIPAddress -InterfaceIndex $Adapter.ifIndex -IPAddress $Gateway -PrefixLength $PrefixLength -AddressFamily IPv4 -ErrorAction Stop | Out-Null; $CreatedGateway = $true",
        "  }",
        "  Set-CccHyperVNetworkStage 'hyper-v-network-nat-create-failed'",
        "  if ($Nats.Count -eq 0) { $Nat = New-NetNat -Name $NatName -InternalIPInterfaceAddressPrefix $Prefix -ErrorAction Stop; $CreatedNat = $true; $CreatedNatInstanceId = [string]$Nat.InstanceID; if (-not $CreatedNatInstanceId) { throw 'hyper-v-network-nat-identity-unavailable' } } else { $Nat = $Nats[0] }",
        "  if ([string]$Nat.InternalIPInterfaceAddressPrefix -ne $Prefix) { throw 'hyper-v-network-nat-prefix-conflict' }",
        "  $NatInstanceId = [string]$Nat.InstanceID",
        "  if (-not $NatInstanceId) { throw 'hyper-v-network-nat-identity-unavailable' }",
        "  $Result = [ordered]@{ ok = $true; switchName = $Switch.Name; switchId = [string]$Switch.Id; marker = $Marker; natName = $Nat.Name; natInstanceId = $NatInstanceId; prefix = [string]$Nat.InternalIPInterfaceAddressPrefix; gateway = $Gateway; interfaceIndex = [int]$Adapter.ifIndex; createdSwitch = $CreatedSwitch; createdGateway = $CreatedGateway; createdNat = $CreatedNat }",
        "  $Result | ConvertTo-Json -Compress -Depth 5",
        "} catch {",
        "  if ($CreatedNat) { $RollbackNats = @(Get-NetNat -Name $NatName -ErrorAction SilentlyContinue); if ($RollbackNats.Count -ne 1 -or [string]$RollbackNats[0].InstanceID -cne $CreatedNatInstanceId) { throw 'hyper-v-network-nat-rollback-identity-conflict' }; Remove-NetNat -InputObject $RollbackNats[0] -Confirm:$false -ErrorAction Stop }",
        "  if ($CreatedGateway -and $Adapter) { Get-NetIPAddress -InterfaceIndex $Adapter.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -eq $Gateway -and $_.PrefixLength -eq $PrefixLength } | Remove-NetIPAddress -Confirm:$false -ErrorAction SilentlyContinue }",
        "  if ($CreatedSwitch -and $Switch) { Remove-VMSwitch -VMSwitch $Switch -Force -Confirm:$false -ErrorAction SilentlyContinue }",
        "  throw",
        "}",
    ], "hyper-v-network-module-import-failed", true);
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
    const removeSwitch = options.removeSwitch !== false;
    const removeGateway = removeSwitch || options.removeGateway === true;
    const expectedSwitchId = String(options.expectedSwitchId || "").toLowerCase();
    const expectedNatInstanceId = String(options.expectedNatInstanceId || "");
    if ((removeSwitch || removeGateway) && !expectedSwitchId) throw new Error("hyper-v-network-switch-id-invalid");
    if (expectedSwitchId && !VM_ID_PATTERN.test(expectedSwitchId)) throw new Error("hyper-v-network-switch-id-invalid");
    if (removeNat && (!expectedNatInstanceId || expectedNatInstanceId.length > 256 || /[\u0000-\u001f]/.test(expectedNatInstanceId))) throw new Error("hyper-v-network-nat-instance-id-invalid");
    const script = jsonScript([
        `$SwitchName = ${psQuote(switchName)}`,
        `$NatName = ${psQuote(natName)}`,
        `$Prefix = ${psQuote(prefix)}`,
        `$Gateway = ${psQuote(gateway)}`,
        `$PrefixLength = ${prefixLength}`,
        `$RemoveNat = ${removeNat ? "$true" : "$false"}`,
        `$RemoveSwitch = ${removeSwitch ? "$true" : "$false"}`,
        `$RemoveGateway = ${removeGateway ? "$true" : "$false"}`,
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
        "  if ([string]$Switch.SwitchType -ne 'Internal' -or [string]$Switch.Notes -cne $Marker) { throw 'hyper-v-network-switch-ownership-conflict' }",
        "  if ($RemoveSwitch) { $Attached = @(Get-VMNetworkAdapter -All -ErrorAction SilentlyContinue | Where-Object { $_.SwitchName -eq $SwitchName }); if ($Attached.Count -gt 0) { throw 'hyper-v-network-switch-in-use' } }",
        "}",
        "$IsAdministrator = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
        "$RequiresMutation = ($Switches.Count -eq 1 -and ($RemoveSwitch -or $RemoveGateway)) -or ($Nats.Count -eq 1 -and $RemoveNat)",
        "if ($RequiresMutation -and -not $IsAdministrator) { throw 'hyper-v-network-elevation-required' }",
        "if ($Nats.Count -eq 1 -and $RemoveNat) { if ([string]$Nats[0].InternalIPInterfaceAddressPrefix -ne $Prefix) { throw 'hyper-v-network-nat-prefix-conflict' }; if ([string]$Nats[0].InstanceID -cne $ExpectedNatInstanceId) { throw 'hyper-v-network-nat-identity-conflict' }; Remove-NetNat -InputObject $Nats[0] -Confirm:$false -ErrorAction Stop; $RemovedNat = $true }",
        "if ($Switches.Count -eq 1 -and $RemoveGateway) {",
        "  $Adapter = Get-NetAdapter -Name ('vEthernet (' + $SwitchName + ')') -ErrorAction SilentlyContinue",
        "  if ($Adapter) { $GatewayMatches = @(Get-NetIPAddress -InterfaceIndex $Adapter.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -eq $Gateway -and $_.PrefixLength -eq $PrefixLength }); foreach ($Match in $GatewayMatches) { Remove-NetIPAddress -InputObject $Match -Confirm:$false -ErrorAction Stop; $RemovedGateway = $true } }",
        "}",
        "if ($Switches.Count -eq 1 -and $RemoveSwitch) {",
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
