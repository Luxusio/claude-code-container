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
        "Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue",
    ].join("\r\n");
    const firstLogonEncoded = Buffer.from(firstLogonScript, "utf16le").toString("base64");
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
        `$FirstLogonEncoded = ${psQuote(firstLogonEncoded)}`,
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
        "  $UsernameBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($ExpectedUsername))",
        "  $PasswordBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($PlainPassword))",
        "  $SpecializeTemplate = @'",
        "$ErrorActionPreference = 'Stop'",
        "$u = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__CCC_USERNAME__'))",
        "$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__CCC_PASSWORD__'))",
        "$s = ConvertTo-SecureString $p -AsPlainText -Force",
        "$existing = Get-LocalUser -Name $u -ErrorAction SilentlyContinue",
        "if ($existing) { Set-LocalUser -Name $u -Password $s } else { New-LocalUser -Name $u -Password $s -AccountNeverExpires -PasswordNeverExpires | Out-Null }",
        "$existing = Get-LocalUser -Name $u -ErrorAction Stop",
        "$group = Get-LocalGroup -SID 'S-1-5-32-544'",
        "if (-not (Get-LocalGroupMember -Group $group -ErrorAction SilentlyContinue | Where-Object { [string]$_.SID -eq [string]$existing.SID })) { Add-LocalGroupMember -Group $group -Member $existing }",
        "'@",
        "  $SpecializeScript = $SpecializeTemplate.Replace('__CCC_USERNAME__', $UsernameBase64).Replace('__CCC_PASSWORD__', $PasswordBase64)",
        "  $SpecializeEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($SpecializeScript))",
        "  $Unattend = @\"",
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>",
        "<unattend xmlns=\"urn:schemas-microsoft-com:unattend\">",
        "  <settings pass=\"specialize\">",
        "    <component name=\"Microsoft-Windows-Shell-Setup\" processorArchitecture=\"amd64\" publicKeyToken=\"31bf3856ad364e35\" language=\"neutral\" versionScope=\"nonSxS\">",
        "      <ComputerName>*</ComputerName>",
        "    </component>",
        "    <component name=\"Microsoft-Windows-Deployment\" processorArchitecture=\"amd64\" publicKeyToken=\"31bf3856ad364e35\" language=\"neutral\" versionScope=\"nonSxS\" xmlns:wcm=\"http://schemas.microsoft.com/WMIConfig/2002/State\">",
        "      <RunSynchronous><RunSynchronousCommand wcm:action=\"add\"><Order>1</Order><Description>Create CCC PowerShell Direct account</Description><Path>powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $SpecializeEncoded</Path><WillReboot>Never</WillReboot></RunSynchronousCommand></RunSynchronous>",
        "    </component>",
        "  </settings>",
        "  <settings pass=\"oobeSystem\">",
        "    <component name=\"Microsoft-Windows-Shell-Setup\" processorArchitecture=\"amd64\" publicKeyToken=\"31bf3856ad364e35\" language=\"neutral\" versionScope=\"nonSxS\" xmlns:wcm=\"http://schemas.microsoft.com/WMIConfig/2002/State\">",
        "      <OOBE><HideEULAPage>true</HideEULAPage><ProtectYourPC>3</ProtectYourPC><SkipMachineOOBE>true</SkipMachineOOBE><SkipUserOOBE>true</SkipUserOOBE></OOBE>",
        "      <AutoLogon><Password><Value>$PasswordXml</Value><PlainText>true</PlainText></Password><Enabled>true</Enabled><LogonCount>1</LogonCount><Username>$UsernameXml</Username></AutoLogon>",
        "      <FirstLogonCommands><SynchronousCommand wcm:action=\"add\"><Order>1</Order><Description>Remove CCC bootstrap secrets</Description><CommandLine>powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $FirstLogonEncoded</CommandLine></SynchronousCommand></FirstLogonCommands>",
        "    </component>",
        "  </settings>",
        "</unattend>",
        "\"@",
        "  $UnattendBytes = [Text.Encoding]::UTF8.GetBytes($Unattend)",
        "  $IsoFiles = [ordered]@{ 'Autounattend.xml' = $UnattendBytes; 'unattend.xml' = $UnattendBytes }",
        "  Set-CccProvisionStage 'media-build'",
        ...isoWriterLines(),
        "  Write-CccIso $IsoFiles $ProvisioningMedia 'CCC_UNATTEND' $MediaSourceRoot",
        "  $IsoFiles = $null",
        "  $UnattendBytes = $null",
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
        "  $PasswordBase64 = $null",
        "  $SpecializeTemplate = $null",
        "  $SpecializeScript = $null",
        "  $SpecializeEncoded = $null",
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
