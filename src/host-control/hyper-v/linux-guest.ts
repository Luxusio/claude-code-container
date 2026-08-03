import { randomUUID } from "crypto";
import { resolve } from "path";

import {
    type HyperVProviderCommand,
    type HyperVLinuxSeedOptions,
    type HyperVLinuxSshOptions,
    type HyperVBootstrapNetworkCleanupOptions,
    type HyperVBootstrapNetworkOptions,
    type HyperVLinuxNetworkFinalizeOptions,
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
    assertLinuxGuestPath,
    assertLinuxUsername,
    assertIpv4,
    sshBaseArgs,
} from "./core.js";

export function hyperVLinuxSeedCommand(options: HyperVLinuxSeedOptions): HyperVProviderCommand {
    assertIdentity(options);
    if (!options.vmId) throw new Error("hyper-v-vm-id-missing");
    if (!options.diskPath) throw new Error("hyper-v-disk-path-missing");
    const deviceRoot = assertPlainPath(options.deviceRoot, "device-root");
    const privateRoot = assertPlainPath(options.privateRoot, "private-root");
    const diskPath = assertPathInside(deviceRoot, options.diskPath, "linux-disk-path");
    const seedDiskPath = assertPathInside(deviceRoot, options.seedDiskPath, "linux-seed-disk");
    if (!/\.iso$/i.test(seedDiskPath)) throw new Error("hyper-v-linux-seed-media-format-invalid");
    const privateKeyPath = assertPathInside(privateRoot, options.sshPrivateKeyPath, "linux-ssh-private-key");
    const publicKeyPath = assertPathInside(privateRoot, options.sshPublicKeyPath, "linux-ssh-public-key");
    const hostPrivateKeyPath = assertPathInside(privateRoot, options.sshHostPrivateKeyPath, "linux-ssh-host-private-key");
    const hostPublicKeyPath = assertPathInside(privateRoot, options.sshHostPublicKeyPath, "linux-ssh-host-public-key");
    const knownHostsPath = assertPathInside(privateRoot, options.knownHostsPath, "linux-ssh-known-hosts");
    const mediaSourceRoot = assertPathInside(
        privateRoot,
        resolve(privateRoot, "media-staging", `${randomUUID()}.source`),
        "linux-seed-source-root",
    );
    const username = assertLinuxUsername(options.guestUsername);
    const address = assertIpv4(options.networkAddress, "linux-network-address");
    const gateway = assertIpv4(options.networkGateway, "linux-network-gateway");
    const prefixLength = boundedInteger(options.networkPrefixLength, 16, 30, "linux-network-prefix-length");
    const macAddress = String(options.macAddress || "").toLowerCase();
    if (!/^02(?::[0-9a-f]{2}){5}$/.test(macAddress)) throw new Error("hyper-v-mac-address-invalid");
    const dnsServers = (options.dnsServers?.length ? options.dnsServers : ["1.1.1.1", "8.8.8.8"])
        .map((server) => assertIpv4(server, "linux-dns-server"));
    const metadata = `instance-id: ${options.ownerId}-${options.deviceId}\nlocal-hostname: ${options.vmName}\n`;
    const networkConfig = [
        "version: 2",
        "ethernets:",
        "  ccc0:",
        "    match:",
        `      macaddress: '${macAddress}'`,
        "    set-name: ccc0",
        `    addresses: [${address}/${prefixLength}]`,
        `    gateway4: ${gateway}`,
        `    nameservers: { addresses: [${dnsServers.join(", ")}] }`,
        "",
    ].join("\n");
    const netplanConfig = [
        "network:",
        ...networkConfig.split("\n").map((line) => line ? `  ${line}` : line),
    ].join("\n");
    return command(options.executable, jsonScript([
        "function Set-CccProvisionStage([string]$Stage) {",
        "  $script:CccProvisionStage = $Stage",
        "  [Console]::Out.WriteLine(('CCC_HYPER_V_STAGE:hyper-v-linux-seed-' + $Stage + '-command-failed'))",
        "}",
        "Set-CccProvisionStage 'vm-lookup'",
        "try {",
        ...ownedVmPrelude(options),
        `$DeviceRoot = ${psQuote(deviceRoot)}`,
        `$DiskPath = ${psQuote(diskPath)}`,
        `$SeedDisk = ${psQuote(seedDiskPath)}`,
        `$PrivateKey = ${psQuote(privateKeyPath)}`,
        `$PublicKey = ${psQuote(publicKeyPath)}`,
        `$HostPrivateKey = ${psQuote(hostPrivateKeyPath)}`,
        `$HostPublicKey = ${psQuote(hostPublicKeyPath)}`,
        `$KnownHosts = ${psQuote(knownHostsPath)}`,
        `$MediaSourceRoot = ${psQuote(mediaSourceRoot)}`,
        `$MetadataBase64 = ${psQuote(Buffer.from(metadata, "utf8").toString("base64"))}`,
        `$NetworkBase64 = ${psQuote(Buffer.from(networkConfig, "utf8").toString("base64"))}`,
        `$NetplanBase64 = ${psQuote(Buffer.from(netplanConfig, "utf8").toString("base64"))}`,
        `$GuestUsername = ${psQuote(username)}`,
        "Set-CccProvisionStage 'vm-state'",
        "if ($Vm.State -ne 'Off') { throw 'hyper-v-linux-seed-requires-stopped-vm' }",
        "Set-CccProvisionStage 'path-validation'",
        "Assert-NoReparsePath $DeviceRoot",
        "Assert-NoReparsePath $SeedDisk",
        "Assert-NoReparsePath $PrivateKey",
        "Assert-NoReparsePath $PublicKey",
        "Assert-NoReparsePath $HostPrivateKey",
        "Assert-NoReparsePath $HostPublicKey",
        "Assert-NoReparsePath $KnownHosts",
        "Assert-NoReparsePath $MediaSourceRoot",
        "New-Item -ItemType Directory -Path (Split-Path -Parent $SeedDisk) -Force | Out-Null",
        "New-Item -ItemType Directory -Path (Split-Path -Parent $PrivateKey) -Force | Out-Null",
        "function New-CccSshKey([string]$Executable, [string]$Comment, [string]$Path) {",
        "  if ($Comment -notmatch '^ccc-device-lab(?:-host)?-[a-f0-9-]{36}$' -or $Path.Contains('\"')) { throw 'hyper-v-linux-ssh-keygen-arguments-invalid' }",
        "  $StartInfo = [Diagnostics.ProcessStartInfo]::new()",
        "  $StartInfo.FileName = $Executable",
        "  $StartInfo.UseShellExecute = $false",
        "  $StartInfo.CreateNoWindow = $true",
        "  $StartInfo.Arguments = '-q -t ed25519 -N \"\" -C \"' + $Comment + '\" -f \"' + $Path + '\"'",
        "  $KeygenProcess = [Diagnostics.Process]::Start($StartInfo)",
        "  if (-not $KeygenProcess) { throw 'hyper-v-linux-ssh-keygen-start-failed' }",
        "  try { $KeygenProcess.WaitForExit(); return [int]$KeygenProcess.ExitCode } finally { $KeygenProcess.Dispose() }",
        "}",
        "if (-not (Test-Path -LiteralPath $PrivateKey -PathType Leaf) -or -not (Test-Path -LiteralPath $PublicKey -PathType Leaf)) {",
        "  Set-CccProvisionStage 'user-keygen'",
        "  Remove-Item -LiteralPath $PrivateKey,$PublicKey -Force -ErrorAction SilentlyContinue",
        "  $SshKeygen = Get-Command ssh-keygen.exe -ErrorAction SilentlyContinue",
        "  if (-not $SshKeygen) { $SshKeygen = Get-Command ssh-keygen -ErrorAction SilentlyContinue }",
        "  if (-not $SshKeygen) { throw 'hyper-v-linux-ssh-keygen-unavailable' }",
        "  if ((New-CccSshKey $SshKeygen.Source ('ccc-device-lab-' + $ExpectedId) $PrivateKey) -ne 0) { throw 'hyper-v-linux-ssh-keygen-failed' }",
        "}",
        "if (-not (Test-Path -LiteralPath $HostPrivateKey -PathType Leaf) -or -not (Test-Path -LiteralPath $HostPublicKey -PathType Leaf)) {",
        "  Set-CccProvisionStage 'host-keygen'",
        "  Remove-Item -LiteralPath $HostPrivateKey,$HostPublicKey -Force -ErrorAction SilentlyContinue",
        "  $SshKeygen = Get-Command ssh-keygen.exe -ErrorAction SilentlyContinue",
        "  if (-not $SshKeygen) { $SshKeygen = Get-Command ssh-keygen -ErrorAction SilentlyContinue }",
        "  if (-not $SshKeygen) { throw 'hyper-v-linux-ssh-keygen-unavailable' }",
        "  if ((New-CccSshKey $SshKeygen.Source ('ccc-device-lab-host-' + $ExpectedId) $HostPrivateKey) -ne 0) { throw 'hyper-v-linux-ssh-host-keygen-failed' }",
        "}",
        "Set-CccProvisionStage 'known-hosts'",
        "$PublicKeyText = (Get-Content -LiteralPath $PublicKey -Raw -ErrorAction Stop).Trim()",
        "if ($PublicKeyText -notmatch '^ssh-ed25519 [A-Za-z0-9+/=]+(?: .*)?$') { throw 'hyper-v-linux-ssh-public-key-invalid' }",
        "$HostPrivateKeyText = (Get-Content -LiteralPath $HostPrivateKey -Raw -ErrorAction Stop).TrimEnd()",
        "$HostPublicKeyText = (Get-Content -LiteralPath $HostPublicKey -Raw -ErrorAction Stop).Trim()",
        "if ($HostPublicKeyText -notmatch '^ssh-ed25519 ([A-Za-z0-9+/=]+)(?: .*)?$') { throw 'hyper-v-linux-ssh-host-public-key-invalid' }",
        "$HostFingerprint = 'SHA256:' + [Convert]::ToBase64String(([Security.Cryptography.SHA256]::Create()).ComputeHash([Convert]::FromBase64String($Matches[1]))).TrimEnd('=')",
        "$HostPrivateKeyBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($HostPrivateKeyText + [Environment]::NewLine))",
        "$HostPublicKeyBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($HostPublicKeyText + [Environment]::NewLine))",
        "Set-Content -LiteralPath $KnownHosts -Value (" + psQuote(address) + " + ' ' + $HostPublicKeyText) -Encoding ASCII -Force",
        "$UserData = @('#cloud-config', ('hostname: ' + $ExpectedName), 'manage_etc_hosts: true', ('user: ' + $GuestUsername), 'ssh_pwauth: false', 'disable_root: true', 'ssh_deletekeys: true', 'users:', '  - default', ('  - name: ' + $GuestUsername), '    groups: [adm, sudo]', '    sudo: ALL=(ALL) NOPASSWD:ALL', '    shell: /bin/bash', '    lock_passwd: true', '    ssh_authorized_keys:', ('      - ' + $PublicKeyText), 'packages:', '  - openssh-server', 'write_files:', '  - path: /etc/ssh/ssh_host_ed25519_key', '    owner: root:root', \"    permissions: '0600'\", '    encoding: b64', ('    content: ' + $HostPrivateKeyBase64), '  - path: /etc/ssh/ssh_host_ed25519_key.pub', '    owner: root:root', \"    permissions: '0644'\", '    encoding: b64', ('    content: ' + $HostPublicKeyBase64), '  - path: /etc/netplan/99-ccc-static.yaml', '    owner: root:root', \"    permissions: '0600'\", '    encoding: b64', ('    content: ' + $NetplanBase64), 'runcmd:', '  - [netplan, apply]', '  - [systemctl, enable, --now, ssh]', 'package_update: true', '') -join [Environment]::NewLine",
        "$UserDataBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($UserData))",
        "$PublicKeyXml = [Security.SecurityElement]::Escape($PublicKeyText)",
        "$OvfEnvironment = @('<?xml version=\"1.0\" encoding=\"utf-8\"?>', '<ns0:Environment xmlns=\"http://schemas.dmtf.org/ovf/environment/1\" xmlns:ns0=\"http://schemas.dmtf.org/ovf/environment/1\" xmlns:ns1=\"http://schemas.microsoft.com/windowsazure\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\">', '<ns1:ProvisioningSection>', '<ns1:Version>1.0</ns1:Version>', '<ns1:LinuxProvisioningConfigurationSet>', '<ns1:ConfigurationSetType>LinuxProvisioningConfiguration</ns1:ConfigurationSetType>', ('<ns1:HostName>' + $ExpectedName + '</ns1:HostName>'), ('<ns1:UserName>' + $GuestUsername + '</ns1:UserName>'), '<ns1:UserPassword />', ('<ns1:CustomData>' + $UserDataBase64 + '</ns1:CustomData>'), '<ns1:DisableSshPasswordAuthentication>true</ns1:DisableSshPasswordAuthentication>', '<ns1:SSH><ns1:PublicKeys><ns1:PublicKey><ns1:Path>/home/' + $GuestUsername + '/.ssh/authorized_keys</ns1:Path><ns1:Value>' + $PublicKeyXml + '</ns1:Value></ns1:PublicKey></ns1:PublicKeys></ns1:SSH>', '</ns1:LinuxProvisioningConfigurationSet>', '</ns1:ProvisioningSection>', '<ns1:PlatformSettingsSection>', '<ns1:Version>1.0</ns1:Version>', '<ns1:PlatformSettings>', '<ns1:KmsServerHostname>kms.core.windows.net</ns1:KmsServerHostname>', '<ns1:ProvisionGuestAgent>false</ns1:ProvisionGuestAgent>', '<ns1:GuestAgentPackageName xsi:nil=\"true\" />', '<ns1:PreprovisionedVMType xsi:nil=\"true\" />', '</ns1:PlatformSettings>', '</ns1:PlatformSettingsSection>', '</ns0:Environment>') -join [Environment]::NewLine",
        "$OvfEnvironmentBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($OvfEnvironment))",
        "Set-CccProvisionStage 'media-check'",
        "$ExistingAttachment = @(Get-VMDvdDrive -VM $Vm -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $SeedDisk })",
        "if ($ExistingAttachment.Count -ne 0) { throw 'hyper-v-linux-seed-media-already-attached' }",
        "if ($ExistingAttachment.Count -eq 0) {",
        "  Set-CccProvisionStage 'media-build'",
        "  $IsoFiles = [ordered]@{",
        "    'meta-data' = [Convert]::FromBase64String($MetadataBase64)",
        "    'network-config' = [Convert]::FromBase64String($NetworkBase64)",
        "    'ovf-env.xml' = [Convert]::FromBase64String($OvfEnvironmentBase64)",
        "    'user-data' = [Convert]::FromBase64String($UserDataBase64)",
        "  }",
        ...isoWriterLines(),
        "  Write-CccIso $IsoFiles $SeedDisk 'cidata' $MediaSourceRoot",
        "  $IsoFiles = $null",
        "  Set-CccProvisionStage 'media-attach'",
        "  try { Add-VMDvdDrive -VM $Vm -Path $SeedDisk -ErrorAction Stop | Out-Null } catch { throw 'hyper-v-linux-seed-media-attach-failed' }",
        "  $OsDisks = @(Get-VMHardDiskDrive -VM $Vm -ErrorAction Stop | Where-Object { [string]$_.Path -eq $DiskPath })",
        "  if ($OsDisks.Count -ne 1) { throw 'hyper-v-linux-disk-attachment-mismatch' }",
        "  if ([int]$Vm.Generation -eq 2) { Set-VMFirmware -VM $Vm -FirstBootDevice $OsDisks[0] -ErrorAction Stop }",
        "  else { Set-VMBios -VM $Vm -StartupOrder @('IDE','CD','LegacyNetworkAdapter','Floppy') -ErrorAction Stop }",
        "}",
        "$Result = [ordered]@{ ok = $true; vmId = [string]$Vm.Id; vmName = $Vm.Name; seedDiskPath = $SeedDisk; sshPrivateKeyPath = $PrivateKey; sshPublicKeyPath = $PublicKey; sshHostPublicKeyPath = $HostPublicKey; sshHostKeyFingerprint = $HostFingerprint; knownHostsPath = $KnownHosts; guestUsername = $GuestUsername; networkAddress = " + psQuote(address) + " }",
        "$Result | ConvertTo-Json -Compress -Depth 5",
        "} catch {",
        "  $CccFailure = [string]$_.Exception.Message",
        "  if ($CccFailure -match '^hyper-v-[a-z0-9-]{3,128}$') { throw $CccFailure }",
        "  throw ('hyper-v-linux-seed-' + $CccProvisionStage + '-command-failed')",
        "}",
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

export function hyperVBootstrapNetworkCommand(options: HyperVBootstrapNetworkOptions): HyperVProviderCommand {
    return command(options.executable, jsonScript([
        ...ownedVmPrelude(options),
        "$BootstrapAdapters = @(Get-VMNetworkAdapter -VM $Vm -ErrorAction Stop | Where-Object { $_.Name -eq 'CCC Bootstrap DHCP' })",
        "if ($BootstrapAdapters.Count -gt 1) { throw 'hyper-v-bootstrap-network-adapter-ambiguous' }",
        "$Addresses = @()",
        "if ($BootstrapAdapters.Count -eq 1) {",
        "  if ([string]$BootstrapAdapters[0].SwitchName -ne 'Default Switch') { throw 'hyper-v-bootstrap-network-adapter-identity-mismatch' }",
        "  $ManagementAddresses = @(Get-VMNetworkAdapter -ManagementOS -SwitchName 'Default Switch' -ErrorAction Stop | ForEach-Object { $_.IPAddresses } | Where-Object { $_ -match '^\\d{1,3}(?:\\.\\d{1,3}){3}$' })",
        "  $HostPrefixes = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object { $ManagementAddresses -contains $_.IPAddress -and $_.PrefixLength -ge 8 -and $_.PrefixLength -le 30 })",
        "  function Test-CccSamePrefix([string]$Left, [string]$Right, [int]$PrefixLength) {",
        "    $LeftBytes = [Net.IPAddress]::Parse($Left).GetAddressBytes()",
        "    $RightBytes = [Net.IPAddress]::Parse($Right).GetAddressBytes()",
        "    $WholeBytes = [int][Math]::Floor($PrefixLength / 8)",
        "    for ($Index = 0; $Index -lt $WholeBytes; $Index++) { if ($LeftBytes[$Index] -ne $RightBytes[$Index]) { return $false } }",
        "    $RemainingBits = $PrefixLength % 8",
        "    if ($RemainingBits -eq 0) { return $true }",
        "    $Mask = [byte](256 - [Math]::Pow(2, 8 - $RemainingBits))",
        "    return (($LeftBytes[$WholeBytes] -band $Mask) -eq ($RightBytes[$WholeBytes] -band $Mask))",
        "  }",
        "  foreach ($Candidate in @($BootstrapAdapters[0].IPAddresses | Sort-Object -Unique)) {",
        "    if ($Candidate -notmatch '^\\d{1,3}(?:\\.\\d{1,3}){3}$' -or $Candidate -match '^(?:0\\.|127\\.|169\\.254\\.)') { continue }",
        "    foreach ($HostPrefix in $HostPrefixes) {",
        "      if ($Candidate -ne [string]$HostPrefix.IPAddress -and (Test-CccSamePrefix $Candidate ([string]$HostPrefix.IPAddress) ([int]$HostPrefix.PrefixLength))) { $Addresses += $Candidate; break }",
        "    }",
        "    if ($Addresses.Count -ge 8) { break }",
        "  }",
        "}",
        "$Result = [ordered]@{ ok = $true; addresses = $Addresses }",
        "$Result | ConvertTo-Json -Compress -Depth 4",
    ]));
}

export function hyperVLinuxNetworkFinalizeCommand(options: HyperVLinuxNetworkFinalizeOptions): HyperVProviderCommand {
    const macAddress = String(options.managedMacAddress || "").toLowerCase();
    if (!/^02(?::[0-9a-f]{2}){5}$/.test(macAddress)) throw new Error("hyper-v-mac-address-invalid");
    const address = assertIpv4(options.managedNetworkAddress, "linux-managed-network-address");
    const gateway = assertIpv4(options.networkGateway, "linux-network-gateway");
    const prefixLength = boundedInteger(options.networkPrefixLength, 8, 30, "linux-network-prefix");
    const dnsServers = (options.dnsServers || ["1.1.1.1", "8.8.8.8"]).map((candidate) => assertIpv4(candidate, "linux-dns-address"));
    const network = [
        "network:",
        "  version: 2",
        "  ethernets:",
        "    ccc0:",
        "      match:",
        `        macaddress: '${macAddress}'`,
        "      set-name: ccc0",
        `      addresses: [${address}/${prefixLength}]`,
        `      routes: [{ to: default, via: ${gateway} }]`,
        `      nameservers: { addresses: [${dnsServers.join(", ")}] }`,
        "",
    ].join("\n");
    const encoded = Buffer.from(network, "utf8").toString("base64");
    const guestCommand = [
        `printf %s ${encoded} | base64 -d | sudo tee /etc/netplan/99-ccc-static.yaml >/dev/null`,
        "sudo chmod 600 /etc/netplan/99-ccc-static.yaml",
        "nohup sudo sh -c 'sleep 1; netplan apply; systemctl restart ssh' >/tmp/ccc-netplan.log 2>&1 &",
    ].join(" && ");
    return hyperVLinuxSshExecCommand({ ...options, guestCommand });
}

export function hyperVBootstrapNetworkCleanupCommand(options: HyperVBootstrapNetworkCleanupOptions): HyperVProviderCommand {
    return command(options.executable, jsonScript([
        ...ownedVmPrelude(options),
        "$BootstrapAdapters = @(Get-VMNetworkAdapter -VM $Vm -ErrorAction Stop | Where-Object { $_.Name -eq 'CCC Bootstrap DHCP' })",
        "if ($BootstrapAdapters.Count -gt 1) { throw 'hyper-v-bootstrap-network-adapter-ambiguous' }",
        "$Removed = $false",
        "if ($BootstrapAdapters.Count -eq 1) {",
        "  if ([string]$BootstrapAdapters[0].SwitchName -ne 'Default Switch') { throw 'hyper-v-bootstrap-network-adapter-identity-mismatch' }",
        "  Remove-VMNetworkAdapter -VMNetworkAdapter $BootstrapAdapters[0] -Confirm:$false -ErrorAction Stop",
        "  $Removed = $true",
        "}",
        "$Result = [ordered]@{ ok = $true; removed = $Removed; alreadyMissing = (-not $Removed) }",
        "$Result | ConvertTo-Json -Compress -Depth 4",
    ]));
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
