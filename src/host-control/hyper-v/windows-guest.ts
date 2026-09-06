import { randomUUID } from "crypto";
import { resolve } from "path";

import {
    type HyperVProviderCommand,
    type HyperVGuestExecOptions,
    type HyperVGuestTransferOptions,
    type HyperVGuestProvisionOptions,
} from "./contracts.js";
import {
    psQuote,
    boundedInteger,
    assertIdentity,
    assertPlainPath,
    assertPathInside,
    jsonScript,
    command,
    isoWriterLines,
    ownedVmPrelude,
    guestSessionPrelude,
    assertGuestPath,
} from "./core.js";

// Fixed name of the first-logon program carried as its own file on the CCC_UNATTEND ISO.
export const HYPER_V_FIRST_LOGON_SCRIPT_NAME = "ccc-first-logon.ps1";

// `FirstLogonCommands/SynchronousCommand/CommandLine` is limited to 1024 characters by the unattend
// schema. Embedding the first-logon program as a UTF-16LE `-EncodedCommand` payload produced a
// multi-kilobyte value, so Windows Setup rejected the whole answer file in the oobeSystem pass.
// The bounded launcher below resolves the exact CCC_UNATTEND volume by label (never a drive letter),
// then runs the program stored beside the answer file. It carries no credential material and fails
// closed when the labeled media is missing or ambiguous.
export const HYPER_V_FIRST_LOGON_LAUNCHER = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "
    + "\"$ErrorActionPreference='Stop';"
    + "$m=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=5' | Where-Object { $_.VolumeName -eq 'CCC_UNATTEND' });"
    + "if ($m.Count -ne 1) { exit 3 };"
    + `$s=[string]$m[0].DeviceID + '\\${HYPER_V_FIRST_LOGON_SCRIPT_NAME}';`
    + "if (-not (Test-Path -LiteralPath $s -PathType Leaf)) { exit 4 };"
    + "& $s\"";

// Schema maximum for a single FirstLogonCommands CommandLine value, after XML decoding.
export const HYPER_V_FIRST_LOGON_COMMAND_LINE_LIMIT = 1024;

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
    const privateRoot = assertPlainPath(options.privateRoot || options.deviceRoot, "guest-private-root");
    const credentialPath = assertPathInside(privateRoot, options.credentialPath, "guest-credential-path");
    const provisioningMediaPath = assertPathInside(options.deviceRoot, options.provisioningMediaPath, "guest-provisioning-media-path");
    const mediaSourceRoot = assertPathInside(
        privateRoot,
        resolve(privateRoot, "media-staging", `${randomUUID()}.source`),
        "guest-provisioning-source-root",
    );
    if (!/\.iso$/i.test(provisioningMediaPath)) throw new Error("hyper-v-guest-provisioning-media-format-invalid");
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
        // The completion marker, and it must stay the LAST statement. Readiness cannot infer that
        // this program ran from the absence of the secrets: with LogonCount 1, Windows itself
        // decrements AutoLogonCount to zero and drops DefaultPassword/AutoAdminLogon during the
        // autologon, possibly before FirstLogonCommands fires at all, and Setup redacts its own
        // cached answer file. All three absence signals are therefore reachable without us. Only
        // this key is not. Every statement above runs under SilentlyContinue and cannot throw, so
        // reaching this line means they all executed.
        "New-Item -Path 'HKLM:\\SOFTWARE\\ccc' -Force -ErrorAction SilentlyContinue | Out-Null",
        "New-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\ccc' -Name 'FirstLogonCompleted' -Value 1 -PropertyType DWord -Force -ErrorAction SilentlyContinue | Out-Null",
        // Deliberately no `Remove-Item $PSCommandPath`: this program lives on read-only ISO media,
        // so the self-delete could never succeed and only read as a cleanup that was not happening.
        // The host removes the media in hyperVGuestReadyCommand, after the gate below passes.
    ].join("\r\n");
    if (HYPER_V_FIRST_LOGON_LAUNCHER.length > HYPER_V_FIRST_LOGON_COMMAND_LINE_LIMIT) throw new Error("hyper-v-guest-first-logon-launcher-too-long");
    // Delivered as its own ISO file instead of an inline encoded command line: the program is ASCII
    // only (validated IPv4 literals and fixed cmdlet text), so UTF-8 bytes are read identically by
    // Windows PowerShell 5.1 without a byte-order mark.
    const firstLogonScriptBase64 = Buffer.from(firstLogonScript, "utf8").toString("base64");
    const script = jsonScript([
        "function Set-CccProvisionStage([string]$Stage) {",
        "  $script:CccProvisionStage = $Stage",
        "  [Console]::Out.WriteLine(('CCC_HYPER_V_STAGE:hyper-v-guest-provision-' + $Stage + '-command-failed'))",
        "}",
        "Set-CccProvisionStage 'vm-lookup'",
        "try {",
        ...ownedVmPrelude(options),
        `$DiskPath = ${psQuote(diskPath)}`,
        `$CredentialPath = ${psQuote(credentialPath)}`,
        `$ProvisioningMedia = ${psQuote(provisioningMediaPath)}`,
        `$MediaSourceRoot = ${psQuote(mediaSourceRoot)}`,
        `$ExpectedUsername = ${psQuote(options.guestUsername)}`,
        `$FirstLogonLauncher = ${psQuote(HYPER_V_FIRST_LOGON_LAUNCHER)}`,
        `$FirstLogonScriptBase64 = ${psQuote(firstLogonScriptBase64)}`,
        "Set-CccProvisionStage 'vm-state'",
        "if ($Vm.State -ne 'Off') { throw 'hyper-v-guest-provision-requires-stopped-vm' }",
        "Set-CccProvisionStage 'input-validation'",
        "Assert-NoReparsePath $MediaSourceRoot",
        "$RawInput = $CccCommandInput",
        "$Provisioning = $RawInput | ConvertFrom-Json -ErrorAction Stop",
        "if ([string]$Provisioning.username -ne $ExpectedUsername) { throw 'hyper-v-guest-provision-username-mismatch' }",
        "$PlainPassword = [string]$Provisioning.password",
        "if ($PlainPassword.Length -lt 20 -or $PlainPassword.Length -gt 128) { throw 'hyper-v-guest-provision-password-invalid' }",
        "Set-CccProvisionStage 'credential'",
        "$CredentialDirectory = Split-Path -Parent $CredentialPath",
        "New-Item -ItemType Directory -Path $CredentialDirectory -Force | Out-Null",
        "$SecurePassword = ConvertTo-SecureString -String $PlainPassword -AsPlainText -Force",
        "$Credential = [System.Management.Automation.PSCredential]::new($ExpectedUsername, $SecurePassword)",
        "$Credential | Export-Clixml -LiteralPath $CredentialPath -Force",
        "Set-CccProvisionStage 'media-check'",
        "$ExistingAttachment = @(Get-VMDvdDrive -VM $Vm -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $ProvisioningMedia })",
        "if ($ExistingAttachment.Count -ne 0) { throw 'hyper-v-guest-provisioning-media-already-attached' }",
        "try {",
        "  Set-CccProvisionStage 'media-content'",
        "  $PasswordXml = [Security.SecurityElement]::Escape($PlainPassword)",
        "  $UsernameXml = [Security.SecurityElement]::Escape($ExpectedUsername)",
        "  $LauncherXml = [Security.SecurityElement]::Escape($FirstLogonLauncher)",
        // The CCC account is created in the oobeSystem pass (NOT specialize): the Microsoft Windows
        // Server evaluation VHD is specialized (its specialize pass already ran during image build),
        // so a specialize-pass account creation never executes and the guest stalls at OOBE. Creating
        // the local account in oobeSystem works for BOTH the specialized evaluation VHD and generalized
        // source VHDX. Outer and nested elements follow the Shell-Setup schema order.
        "  $Unattend = @\"",
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>",
        "<unattend xmlns=\"urn:schemas-microsoft-com:unattend\">",
        "  <settings pass=\"oobeSystem\">",
        "    <component name=\"Microsoft-Windows-Shell-Setup\" processorArchitecture=\"amd64\" publicKeyToken=\"31bf3856ad364e35\" language=\"neutral\" versionScope=\"nonSxS\" xmlns:wcm=\"http://schemas.microsoft.com/WMIConfig/2002/State\">",
        "      <AutoLogon><Password><Value>$PasswordXml</Value><PlainText>true</PlainText></Password><Enabled>true</Enabled><LogonCount>1</LogonCount><Username>$UsernameXml</Username></AutoLogon>",
        "      <FirstLogonCommands><SynchronousCommand wcm:action=\"add\"><CommandLine>$LauncherXml</CommandLine><Description>Remove CCC bootstrap secrets</Description><Order>1</Order></SynchronousCommand></FirstLogonCommands>",
        "      <OOBE><HideEULAPage>true</HideEULAPage><HideLocalAccountScreen>true</HideLocalAccountScreen><HideOnlineAccountScreens>true</HideOnlineAccountScreens><ProtectYourPC>3</ProtectYourPC></OOBE>",
        "      <UserAccounts><LocalAccounts><LocalAccount wcm:action=\"add\"><Password><Value>$PasswordXml</Value><PlainText>true</PlainText></Password><DisplayName>$UsernameXml</DisplayName><Group>Administrators</Group><Name>$UsernameXml</Name></LocalAccount></LocalAccounts></UserAccounts>",
        "    </component>",
        "  </settings>",
        "</unattend>",
        "\"@",
        "  $UnattendBytes = [Text.Encoding]::UTF8.GetBytes($Unattend)",
        "  $FirstLogonBytes = [Convert]::FromBase64String($FirstLogonScriptBase64)",
        `  $IsoFiles = [ordered]@{ 'Autounattend.xml' = $UnattendBytes; 'unattend.xml' = $UnattendBytes; '${HYPER_V_FIRST_LOGON_SCRIPT_NAME}' = $FirstLogonBytes }`,
        "  Set-CccProvisionStage 'media-build'",
        ...isoWriterLines(),
        "  Write-CccIso $IsoFiles $ProvisioningMedia 'CCC_UNATTEND' $MediaSourceRoot",
        "  $IsoFiles = $null",
        "  $UnattendBytes = $null",
        "  $FirstLogonBytes = $null",
        "  Set-CccProvisionStage 'media-attach'",
        "  try { Add-VMDvdDrive -VM $Vm -Path $ProvisioningMedia -ErrorAction Stop | Out-Null } catch { throw 'hyper-v-guest-provisioning-media-attach-failed' }",
        "  $OsDisks = @(Get-VMHardDiskDrive -VM $Vm -ErrorAction Stop | Where-Object { [string]$_.Path -eq $DiskPath })",
        "  if ($OsDisks.Count -ne 1) { throw 'hyper-v-guest-disk-attachment-mismatch' }",
        "  if ([int]$Vm.Generation -eq 2) {",
        "    Set-VMFirmware -VM $Vm -EnableSecureBoot On -SecureBootTemplate 'MicrosoftWindows' -FirstBootDevice $OsDisks[0] -ErrorAction Stop",
        "    $Firmware = Get-VMFirmware -VM $Vm -ErrorAction Stop",
        "    if ([string]$Firmware.SecureBoot -ne 'On') { throw 'hyper-v-guest-secure-boot-not-enabled' }",
        "  }",
        "  else { Set-VMBios -VM $Vm -StartupOrder @('IDE','CD','LegacyNetworkAdapter','Floppy') -ErrorAction Stop }",
        "  $IntegrationServices = @(Get-VMIntegrationService -VM $Vm -ErrorAction Stop)",
        "  $IntegrationServices | Where-Object { -not $_.Enabled } | Enable-VMIntegrationService -ErrorAction Stop",
        "  $DisabledIntegrationServices = @(Get-VMIntegrationService -VM $Vm -ErrorAction Stop | Where-Object { -not $_.Enabled })",
        "  if ($DisabledIntegrationServices.Count -ne 0) { throw 'hyper-v-guest-integration-services-not-enabled' }",
        "} catch {",
        "  Remove-Item -LiteralPath $CredentialPath -Force -ErrorAction SilentlyContinue",
        "  Assert-NoReparsePath $ProvisioningMedia",
        "  Remove-Item -LiteralPath $ProvisioningMedia -Force -ErrorAction SilentlyContinue",
        "  throw",
        "} finally {",
        "  $PlainPassword = $null",
        "  $Provisioning = $null",
        "  $RawInput = $null",
        "}",
        "$Result = [ordered]@{ ok = $true; vmId = [string]$Vm.Id; vmName = $Vm.Name; guestUsername = $ExpectedUsername; credentialPath = $CredentialPath; unattendPath = $ProvisioningMedia }",
        "$Result | ConvertTo-Json -Compress -Depth 5",
        "} catch {",
        "  $CccFailure = [string]$_.Exception.Message",
        "  if ($CccFailure -match '^hyper-v-[a-z0-9-]{3,128}$') { throw $CccFailure }",
        "  throw ('hyper-v-guest-provision-' + $CccProvisionStage + '-command-failed')",
        "}",
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
