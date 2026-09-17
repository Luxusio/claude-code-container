$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
# Reset here rather than in the caller so every invocation defines its own outcome. A session
# reuses one PowerShell process across many invocations, and a flag left set by an earlier failure
# would otherwise report the next success as a failure.
$global:CccHyperVExitCode = 0

function Write-HyperVWindowsSuccess([string]$Operation, [object[]]$Items) {
    [ordered]@{
        schemaVersion = 1
        operation = $Operation
        ok = $true
        items = @($Items)
    } | ConvertTo-Json -Compress -Depth 6
}

function Write-HyperVWindowsFailure([string]$Operation, [string]$ErrorCode) {
    if ($ErrorCode -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\z') {
        $ErrorCode = "native-operation-failed"
    }
    [ordered]@{
        schemaVersion = 1
        operation = $Operation
        ok = $false
        errorCode = $ErrorCode
    } | ConvertTo-Json -Compress -Depth 3
}

function Resolve-HyperVWindowsTrustedModulePath([string]$ModuleName) {
    if ($ModuleName -notin @("Hyper-V", "NetAdapter", "NetTCPIP", "NetNat")) { throw "module-name-invalid" }
    $MissingCode = if ($ModuleName -eq "Hyper-V") { "hyper-v-module-missing" } else { "windows-network-module-missing" }
    $InvalidCode = if ($ModuleName -eq "Hyper-V") { "hyper-v-module-path-invalid" } else { "windows-network-module-path-invalid" }
    $SystemDirectory = [IO.Path]::GetFullPath([Environment]::SystemDirectory)
    $TrustedRoot = $SystemDirectory
    foreach ($Segment in @("WindowsPowerShell", "v1.0", "Modules")) {
        $TrustedRoot = [IO.Path]::GetFullPath((Join-Path $TrustedRoot $Segment))
        if (-not $TrustedRoot.StartsWith(
            $SystemDirectory + [IO.Path]::DirectorySeparatorChar,
            [StringComparison]::OrdinalIgnoreCase
        )) { throw $InvalidCode }
        if (-not (Test-Path -LiteralPath $TrustedRoot -PathType Container)) { throw $MissingCode }
        $TrustedRootItem = Get-Item -LiteralPath $TrustedRoot -Force -ErrorAction Stop
        if (($TrustedRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw $InvalidCode }
    }
    $ModulesRoot = $TrustedRoot
    $ModuleRoot = [IO.Path]::GetFullPath((Join-Path $ModulesRoot $ModuleName))
    if (-not $ModuleRoot.StartsWith(
        $ModulesRoot + [IO.Path]::DirectorySeparatorChar,
        [StringComparison]::OrdinalIgnoreCase
    )) { throw $InvalidCode }
    if (-not (Test-Path -LiteralPath $ModuleRoot -PathType Container)) { throw $MissingCode }
    $RootItem = Get-Item -LiteralPath $ModuleRoot -Force -ErrorAction Stop
    if (($RootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw $InvalidCode }

    $DirectManifest = Join-Path $ModuleRoot ($ModuleName + ".psd1")
    if (Test-Path -LiteralPath $DirectManifest -PathType Leaf) {
        $DirectItem = Get-Item -LiteralPath $DirectManifest -Force -ErrorAction Stop
        if (($DirectItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw $InvalidCode }
        $FullDirectManifest = [IO.Path]::GetFullPath($DirectManifest)
        if (-not $FullDirectManifest.StartsWith(
            $ModuleRoot + [IO.Path]::DirectorySeparatorChar,
            [StringComparison]::OrdinalIgnoreCase
        )) { throw $InvalidCode }
        return $FullDirectManifest
    }

    $Candidates = @()
    foreach ($VersionDirectory in @(Get-ChildItem -LiteralPath $ModuleRoot -Directory -Force -ErrorAction Stop)) {
        if ($VersionDirectory.Name -notmatch '^\d+(?:\.\d+){1,3}$') { continue }
        if (($VersionDirectory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw $InvalidCode }
        $Manifest = Join-Path $VersionDirectory.FullName ($ModuleName + ".psd1")
        if (-not (Test-Path -LiteralPath $Manifest -PathType Leaf)) { continue }
        $ManifestItem = Get-Item -LiteralPath $Manifest -Force -ErrorAction Stop
        if (($ManifestItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw $InvalidCode }
        $FullManifest = [IO.Path]::GetFullPath($Manifest)
        if (-not $FullManifest.StartsWith(
            $ModuleRoot + [IO.Path]::DirectorySeparatorChar,
            [StringComparison]::OrdinalIgnoreCase
        )) { throw $InvalidCode }
        $Candidates += [pscustomobject]@{
            Version = [Version]$VersionDirectory.Name
            Path = $FullManifest
        }
    }
    if ($Candidates.Count -eq 0) { throw $MissingCode }
    return [string](($Candidates | Sort-Object -Property Version -Descending | Select-Object -First 1).Path)
}

function Import-HyperVWindowsTrustedModule([string]$ModuleName) {
    $InvalidCode = if ($ModuleName -eq "Hyper-V") { "hyper-v-module-path-invalid" } else { "windows-network-module-path-invalid" }
    $ModulePath = Resolve-HyperVWindowsTrustedModulePath $ModuleName
    $ExpectedModuleBase = [IO.Path]::GetFullPath([IO.Path]::GetDirectoryName($ModulePath))

    # Already loaded from the expected base is accepted as-is. -Force reimports on every call, which
    # is redundant inside one process and is the single dominant cost when this script serves many
    # operations from one session. The path is still re-resolved and re-verified above, so this
    # skips work rather than trust: a module loaded from anywhere else falls through to the import
    # below and is rejected there.
    $NamedLoaded = @(Microsoft.PowerShell.Core\Get-Module -Name $ModuleName)
    $Unexpected = @($NamedLoaded | Where-Object {
        [IO.Path]::GetFullPath([string]$_.ModuleBase) -ine $ExpectedModuleBase
    })
    if ($Unexpected.Count -gt 0) { throw $InvalidCode }
    $Existing = @($NamedLoaded | Where-Object {
        [IO.Path]::GetFullPath([string]$_.ModuleBase) -ieq $ExpectedModuleBase
    })
    if ($Existing.Count -gt 0) { return }

    $Loaded = @(Microsoft.PowerShell.Core\Import-Module -Name $ModulePath -Force -PassThru -ErrorAction Stop)
    if ($Loaded.Count -eq 0 -or -not ($Loaded | Where-Object {
        [IO.Path]::GetFullPath([string]$_.ModuleBase) -ieq $ExpectedModuleBase
    })) {
        if ($ModuleName -eq "Hyper-V") { throw "hyper-v-module-path-invalid" }
        throw "windows-network-module-path-invalid"
    }
    $UnexpectedAfterImport = @(Microsoft.PowerShell.Core\Get-Module -Name $ModuleName | Where-Object {
        [IO.Path]::GetFullPath([string]$_.ModuleBase) -ine $ExpectedModuleBase
    })
    if ($UnexpectedAfterImport.Count -gt 0) { throw $InvalidCode }
}

function Get-HyperVWindowsVirtualMachines([object]$Selector) {
    if ([string]$Selector.kind -eq "id") {
        $ExpectedId = [Guid][string]$Selector.id
        return @(Hyper-V\Get-VM -ErrorAction Stop | Where-Object { [Guid]$_.Id -eq $ExpectedId })
    }
    $ExpectedName = [string]$Selector.name
    return @(Hyper-V\Get-VM -ErrorAction Stop | Where-Object { [string]$_.Name -eq $ExpectedName })
}

function Convert-HyperVWindowsVirtualMachine([object]$VirtualMachine) {
    [ordered]@{
        id = ([Guid]$VirtualMachine.Id).ToString("D").ToLowerInvariant()
        name = [string]$VirtualMachine.Name
        state = [string]$VirtualMachine.State
        status = [string]$VirtualMachine.Status
        notes = [string]$VirtualMachine.Notes
        uptimeMilliseconds = [long][Math]::Floor($VirtualMachine.Uptime.TotalMilliseconds)
        generation = [int]$VirtualMachine.Generation
        checkpointType = [string]$VirtualMachine.CheckpointType
    }
}

function Assert-HyperVWindowsSingleVirtualMachine([object[]]$VirtualMachines) {
    if ($VirtualMachines.Count -eq 0) { throw "virtual-machine-not-found" }
    if ($VirtualMachines.Count -ne 1) { throw "virtual-machine-selector-ambiguous" }
    return $VirtualMachines[0]
}

function Convert-HyperVWindowsSnapshot([object]$Snapshot) {
    [ordered]@{
        id = ([Guid]$Snapshot.Id).ToString("D").ToLowerInvariant()
        name = [string]$Snapshot.Name
        vmId = ([Guid]$Snapshot.VMId).ToString("D").ToLowerInvariant()
        vmName = [string]$Snapshot.VMName
        snapshotType = [string]$Snapshot.SnapshotType
        parentSnapshotId = if ($null -eq $Snapshot.ParentSnapshotId) { $null } else { ([Guid]$Snapshot.ParentSnapshotId).ToString("D").ToLowerInvariant() }
        parentSnapshotName = if ([string]::IsNullOrEmpty([string]$Snapshot.ParentSnapshotName)) { $null } else { [string]$Snapshot.ParentSnapshotName }
        creationTimeMilliseconds = [long][Math]::Floor(([DateTimeOffset]$Snapshot.CreationTime).ToUnixTimeMilliseconds())
    }
}

# Selector resolution for a checkpoint, mirroring the virtual machine selector: exact id or exact
# name within the already-resolved VM. Consumer naming conventions stay outside this script.
function Get-HyperVWindowsSnapshot([object]$VirtualMachine, [object]$Selector) {
    $Snapshots = @(Hyper-V\Get-VMSnapshot -VM $VirtualMachine -ErrorAction Stop)
    if ([string]$Selector.kind -eq "id") {
        $ExpectedId = [Guid][string]$Selector.id
        $Matched = @($Snapshots | Where-Object { [Guid]$_.Id -eq $ExpectedId })
    } else {
        $ExpectedName = [string]$Selector.name
        $Matched = @($Snapshots | Where-Object { [string]$_.Name -eq $ExpectedName })
    }
    if ($Matched.Count -eq 0) { throw "snapshot-not-found" }
    if ($Matched.Count -ne 1) { throw "snapshot-selector-ambiguous" }
    return $Matched[0]
}

function Convert-HyperVWindowsVirtualSwitch([object]$VirtualSwitch) {
    [ordered]@{
        id = ([Guid]$VirtualSwitch.Id).ToString("D").ToLowerInvariant()
        name = [string]$VirtualSwitch.Name
        switchType = [string]$VirtualSwitch.SwitchType
        notes = if ($null -eq $VirtualSwitch.Notes) { "" } else { [string]$VirtualSwitch.Notes }
    }
}

function Get-HyperVWindowsVirtualSwitches([object]$Selector) {
    $Switches = @(Hyper-V\Get-VMSwitch -ErrorAction Stop)
    if ([string]$Selector.kind -eq "all") { return $Switches }
    if ([string]$Selector.kind -eq "id") {
        $ExpectedId = [Guid][string]$Selector.id
        return @($Switches | Where-Object { [Guid]$_.Id -eq $ExpectedId })
    }
    if ([string]$Selector.kind -eq "name") {
        $ExpectedName = [string]$Selector.name
        return @($Switches | Where-Object { [string]$_.Name -ceq $ExpectedName })
    }
    throw "virtual-switch-selector-invalid"
}

function Get-HyperVWindowsVirtualSwitchByIdentity([object]$Identity) {
    $Switches = @(Hyper-V\Get-VMSwitch -ErrorAction Stop)
    $ExpectedId = [Guid][string]$Identity.id
    $ExpectedName = [string]$Identity.name
    $IdMatches = @($Switches | Where-Object { [Guid]$_.Id -eq $ExpectedId })
    $NameMatches = @($Switches | Where-Object { [string]$_.Name -ceq $ExpectedName })
    $Exact = @($IdMatches | Where-Object { [string]$_.Name -ceq $ExpectedName })
    if ($Exact.Count -eq 1 -and $IdMatches.Count -eq 1 -and $NameMatches.Count -eq 1) { return $Exact[0] }
    if ($IdMatches.Count -gt 0 -or $NameMatches.Count -gt 0) { throw "virtual-switch-identity-conflict" }
    throw "virtual-switch-not-found"
}

function Convert-HyperVWindowsVMNetworkAdapter([object]$Adapter) {
    $VmId = if ($null -eq $Adapter.VMId -or [Guid]$Adapter.VMId -eq [Guid]::Empty) { $null } else { ([Guid]$Adapter.VMId).ToString("D").ToLowerInvariant() }
    $SwitchId = if ($null -eq $Adapter.SwitchId -or [Guid]$Adapter.SwitchId -eq [Guid]::Empty) { $null } else { ([Guid]$Adapter.SwitchId).ToString("D").ToLowerInvariant() }
    [ordered]@{
        vmId = $VmId
        vmName = if ([string]::IsNullOrEmpty([string]$Adapter.VMName)) { $null } else { [string]$Adapter.VMName }
        name = [string]$Adapter.Name
        switchId = $SwitchId
        switchName = if ([string]::IsNullOrEmpty([string]$Adapter.SwitchName)) { $null } else { [string]$Adapter.SwitchName }
        status = if ($null -eq $Adapter.Status) { "" } else { [string]$Adapter.Status }
        managementOperatingSystem = [bool]$Adapter.IsManagementOs
        macAddress = if ([string]::IsNullOrEmpty([string]$Adapter.MacAddress)) { $null } else { [string]$Adapter.MacAddress }
        # Force an array even for the one-element and empty cases, which PowerShell would
        # otherwise serialise as a bare string and as null. The decoder demands an array.
        ipAddresses = @(@($Adapter.IPAddresses) | Where-Object { -not [string]::IsNullOrEmpty([string]$_) } | ForEach-Object { [string]$_ })
    }
}

function Convert-HyperVWindowsHostNetworkAdapter([object]$Adapter) {
    [ordered]@{
        interfaceIndex = [int]$Adapter.ifIndex
        name = [string]$Adapter.Name
        status = if ($null -eq $Adapter.Status) { "" } else { [string]$Adapter.Status }
        interfaceDescription = if ($null -eq $Adapter.InterfaceDescription) { "" } else { [string]$Adapter.InterfaceDescription }
    }
}

function Convert-HyperVWindowsNetIPAddress([object]$Address) {
    [ordered]@{
        interfaceIndex = [int]$Address.InterfaceIndex
        address = [string]$Address.IPAddress
        prefixLength = [int]$Address.PrefixLength
        prefixOrigin = if ($null -eq $Address.PrefixOrigin) { "" } else { [string]$Address.PrefixOrigin }
        suffixOrigin = if ($null -eq $Address.SuffixOrigin) { "" } else { [string]$Address.SuffixOrigin }
        addressState = if ($null -eq $Address.AddressState) { "" } else { [string]$Address.AddressState }
        interfaceAlias = if ($null -eq $Address.InterfaceAlias) { "" } else { [string]$Address.InterfaceAlias }
    }
}

function Get-HyperVWindowsNetIPAddressByIdentity([object]$Request) {
    $Addresses = @(NetTCPIP\Get-NetIPAddress -InterfaceIndex ([int]$Request.interfaceIndex) -AddressFamily IPv4 -ErrorAction Stop | Where-Object {
        [string]$_.IPAddress -ceq [string]$Request.address -and [int]$_.PrefixLength -eq [int]$Request.prefixLength
    })
    if ($Addresses.Count -eq 0) { throw "net-ip-address-not-found" }
    if ($Addresses.Count -ne 1) { throw "net-ip-address-identity-ambiguous" }
    return $Addresses[0]
}

function Convert-HyperVWindowsNetNat([object]$Nat) {
    [ordered]@{
        instanceId = [string]$Nat.InstanceID
        name = [string]$Nat.Name
        internalAddressPrefix = [string]$Nat.InternalIPInterfaceAddressPrefix
    }
}

function Get-HyperVWindowsNetNats([object]$Selector) {
    $Nats = @(NetNat\Get-NetNat -ErrorAction Stop)
    if ([string]$Selector.kind -eq "all") { return $Nats }
    if ([string]$Selector.kind -eq "instance-id") {
        $ExpectedInstanceId = [string]$Selector.instanceId
        return @($Nats | Where-Object { [string]$_.InstanceID -ceq $ExpectedInstanceId })
    }
    if ([string]$Selector.kind -eq "name") {
        $ExpectedName = [string]$Selector.name
        return @($Nats | Where-Object { [string]$_.Name -ceq $ExpectedName })
    }
    throw "net-nat-selector-invalid"
}

function Get-HyperVWindowsNetNatByIdentity([object]$Identity) {
    $Nats = @(NetNat\Get-NetNat -ErrorAction Stop)
    $ExpectedInstanceId = [string]$Identity.instanceId
    $ExpectedName = [string]$Identity.name
    $IdMatches = @($Nats | Where-Object { [string]$_.InstanceID -ceq $ExpectedInstanceId })
    $NameMatches = @($Nats | Where-Object { [string]$_.Name -ceq $ExpectedName })
    $Exact = @($IdMatches | Where-Object { [string]$_.Name -ceq $ExpectedName })
    if ($Exact.Count -eq 1 -and $IdMatches.Count -eq 1 -and $NameMatches.Count -eq 1) { return $Exact[0] }
    if ($IdMatches.Count -gt 0 -or $NameMatches.Count -gt 0) { throw "net-nat-identity-conflict" }
    throw "net-nat-not-found"
}

$Operation = "Get-VM"
try {
    $RawRequest = [string]$global:CccHyperVJsonInput
    if ([Text.Encoding]::UTF8.GetByteCount($RawRequest) -gt 65536) { throw "request-too-large" }
    $Request = $RawRequest | ConvertFrom-Json -ErrorAction Stop
    if ([int]$Request.schemaVersion -ne 1) { throw "request-schema-invalid" }
    $Operation = [string]$Request.operation
    if ($Operation -notin @(
        "Get-VM", "Get-VMHardDiskDrive", "Get-VMDvdDrive", "Get-VMSnapshot",
        "Start-VM", "Stop-VM", "Remove-VM",
        "Checkpoint-VM", "Remove-VMSnapshot", "Restore-VMSnapshot",
        "Get-VMSwitch", "New-VMSwitch", "Set-VMSwitch", "Remove-VMSwitch",
        "Get-VMNetworkAdapter", "Remove-VMNetworkAdapter", "Get-NetAdapter",
        "Get-NetIPAddress", "New-NetIPAddress", "Remove-NetIPAddress", "Get-NetNeighbor",
        "Get-NetNat", "New-NetNat", "Remove-NetNat"
    )) {
        throw "operation-invalid"
    }
    $VmSelectorOperations = @(
        "Get-VMHardDiskDrive", "Get-VMDvdDrive", "Get-VMSnapshot", "Start-VM", "Stop-VM",
        "Remove-VM", "Checkpoint-VM", "Remove-VMSnapshot", "Restore-VMSnapshot",
        "Remove-VMNetworkAdapter"
    )
    $GetVmByNames = $Operation -eq "Get-VM" -and $null -ne $Request.names
    # Get-VMNetworkAdapter carries three shapes: host-wide (no selector, no switch name), one
    # VM's adapters (selector), and the management OS side of one switch (switch name). They
    # are mutually exclusive, so a request carrying both is a caller that cannot be trusted
    # about which scope it meant.
    $GetAdaptersByVm = $Operation -eq "Get-VMNetworkAdapter" -and $null -ne $Request.selector
    $GetAdaptersByManagementSwitch = $Operation -eq "Get-VMNetworkAdapter" -and $null -ne $Request.managementSwitchName
    if ($GetAdaptersByVm -and $GetAdaptersByManagementSwitch) { throw "adapter-scope-ambiguous" }
    $NeedsVmSelector = $Operation -in $VmSelectorOperations -or
        ($Operation -eq "Get-VM" -and -not $GetVmByNames) -or
        $GetAdaptersByVm
    if ($NeedsVmSelector -and
        ($null -eq $Request.selector -or [string]$Request.selector.kind -notin @("id", "name"))) {
        throw "selector-invalid"
    }
    if ($Operation -in @("Remove-VMSnapshot", "Restore-VMSnapshot")) {
        if ($null -eq $Request.snapshot -or [string]$Request.snapshot.kind -notin @("id", "name")) {
            throw "snapshot-selector-invalid"
        }
    }
    if ($Operation -in @(
        "Get-VM", "Get-VMHardDiskDrive", "Get-VMDvdDrive", "Get-VMSnapshot", "Start-VM", "Stop-VM",
        "Remove-VM", "Checkpoint-VM", "Remove-VMSnapshot", "Restore-VMSnapshot",
        "Get-VMSwitch", "New-VMSwitch", "Set-VMSwitch", "Remove-VMSwitch", "Get-VMNetworkAdapter",
        "Remove-VMNetworkAdapter"
    )) { Import-HyperVWindowsTrustedModule "Hyper-V" }
    if ($Operation -eq "Get-NetAdapter") { Import-HyperVWindowsTrustedModule "NetAdapter" }
    if ($Operation -in @("Get-NetIPAddress", "New-NetIPAddress", "Remove-NetIPAddress", "Get-NetNeighbor")) {
        Import-HyperVWindowsTrustedModule "NetTCPIP"
    }
    if ($Operation -in @("Get-NetNat", "New-NetNat", "Remove-NetNat")) {
        Import-HyperVWindowsTrustedModule "NetNat"
    }

    $VirtualMachines = if ($NeedsVmSelector) {
        @(Get-HyperVWindowsVirtualMachines $Request.selector)
    } else { @() }
    switch ($Operation) {
        "Get-VM" {
            if ($GetVmByNames) {
                $RequestedNames = @($Request.names | ForEach-Object { [string]$_ })
                if ($RequestedNames.Count -lt 1 -or $RequestedNames.Count -gt 32) { throw "inventory-names-invalid" }
                if (@($RequestedNames | Sort-Object -Unique).Count -ne $RequestedNames.Count) { throw "inventory-names-duplicate" }
                # Names are validated by the TypeScript boundary to exclude PowerShell wildcard
                # metacharacters. Passing the bounded (<= 32) set directly avoids enumerating an
                # unbounded host-wide VM inventory while the exact comparison still fences native
                # matching behavior.
                $QueryErrors = @()
                $MatchedVirtualMachines = @(Hyper-V\Get-VM -Name $RequestedNames -ErrorAction SilentlyContinue -ErrorVariable +QueryErrors)
                foreach ($QueryError in $QueryErrors) {
                    # A requested exact name may legitimately be absent. Every other native
                    # failure (authorization, VMMS/RPC failure, provider failure, and so on)
                    # must remain an error so callers never mistake an unavailable inventory
                    # for proof that a VM is absent.
                    $MissingVmErrorId = "ObjectNotFound,Microsoft.HyperV.PowerShell.Commands.GetVM"
                    $MissingVmTarget = if (-not [string]::IsNullOrEmpty([string]$QueryError.TargetObject)) {
                        [string]$QueryError.TargetObject
                    } else {
                        [string]$QueryError.CategoryInfo.TargetName
                    }
                    if ([string]$QueryError.CategoryInfo.Category -ne "ObjectNotFound" -or
                        [string]$QueryError.FullyQualifiedErrorId -ne $MissingVmErrorId -or
                        [string]::IsNullOrEmpty($MissingVmTarget) -or
                        $RequestedNames -cnotcontains $MissingVmTarget) {
                        throw $QueryError
                    }
                }
                $Items = @($MatchedVirtualMachines | Where-Object { $RequestedNames -ccontains [string]$_.Name } | ForEach-Object {
                    [ordered]@{
                        id = ([Guid]$_.Id).ToString("D").ToLowerInvariant()
                        name = [string]$_.Name
                        notes = if ($null -eq $_.Notes) { "" } else { [string]$_.Notes }
                    }
                })
            } else {
                $Items = @($VirtualMachines | ForEach-Object { Convert-HyperVWindowsVirtualMachine $_ })
            }
            Write-HyperVWindowsSuccess $Operation $Items
        }
        "Get-VMHardDiskDrive" {
            $VirtualMachine = Assert-HyperVWindowsSingleVirtualMachine $VirtualMachines
            $Items = @(Hyper-V\Get-VMHardDiskDrive -VM $VirtualMachine -ErrorAction Stop | ForEach-Object {
                [ordered]@{
                    vmId = ([Guid]$_.VMId).ToString("D").ToLowerInvariant()
                    vmName = [string]$_.VMName
                    path = if ([string]::IsNullOrEmpty([string]$_.Path)) { $null } else { [string]$_.Path }
                    controllerType = [string]$_.ControllerType
                    controllerNumber = [int]$_.ControllerNumber
                    controllerLocation = [int]$_.ControllerLocation
                    diskNumber = if ($null -eq $_.DiskNumber) { $null } else { [int]$_.DiskNumber }
                }
            })
            Write-HyperVWindowsSuccess $Operation $Items
        }
        "Get-VMDvdDrive" {
            $VirtualMachine = Assert-HyperVWindowsSingleVirtualMachine $VirtualMachines
            $Items = @(Hyper-V\Get-VMDvdDrive -VM $VirtualMachine -ErrorAction Stop | ForEach-Object {
                [ordered]@{
                    vmId = ([Guid]$_.VMId).ToString("D").ToLowerInvariant()
                    vmName = [string]$_.VMName
                    path = if ([string]::IsNullOrEmpty([string]$_.Path)) { $null } else { [string]$_.Path }
                    controllerType = [string]$_.ControllerType
                    controllerNumber = [int]$_.ControllerNumber
                    controllerLocation = [int]$_.ControllerLocation
                }
            })
            Write-HyperVWindowsSuccess $Operation $Items
        }
        "Start-VM" {
            $VirtualMachine = Assert-HyperVWindowsSingleVirtualMachine $VirtualMachines
            Hyper-V\Start-VM -VM $VirtualMachine -ErrorAction Stop | Out-Null
            Write-HyperVWindowsSuccess $Operation @()
        }
        "Stop-VM" {
            $VirtualMachine = Assert-HyperVWindowsSingleVirtualMachine $VirtualMachines
            if ([string]$Request.mode -eq "turn-off") {
                Hyper-V\Stop-VM -VM $VirtualMachine -TurnOff -Force:([bool]$Request.force) -ErrorAction Stop | Out-Null
            } elseif ([string]$Request.mode -eq "shutdown") {
                Hyper-V\Stop-VM -VM $VirtualMachine -Force:([bool]$Request.force) -ErrorAction Stop | Out-Null
            } else {
                throw "stop-mode-invalid"
            }
            Write-HyperVWindowsSuccess $Operation @()
        }
        "Remove-VM" {
            $VirtualMachine = Assert-HyperVWindowsSingleVirtualMachine $VirtualMachines
            Hyper-V\Remove-VM -VM $VirtualMachine -Force:([bool]$Request.force) -ErrorAction Stop
            Write-HyperVWindowsSuccess $Operation @()
        }
        "Get-VMSnapshot" {
            $VirtualMachine = Assert-HyperVWindowsSingleVirtualMachine $VirtualMachines
            $Items = @(Hyper-V\Get-VMSnapshot -VM $VirtualMachine -ErrorAction Stop | ForEach-Object {
                Convert-HyperVWindowsSnapshot $_
            })
            Write-HyperVWindowsSuccess $Operation $Items
        }
        "Checkpoint-VM" {
            $VirtualMachine = Assert-HyperVWindowsSingleVirtualMachine $VirtualMachines
            $SnapshotName = [string]$Request.snapshotName
            if ([string]::IsNullOrEmpty($SnapshotName)) { throw "snapshot-name-invalid" }
            $Created = @(Hyper-V\Checkpoint-VM -VM $VirtualMachine -SnapshotName $SnapshotName -Passthru -ErrorAction Stop)
            if ($Created.Count -ne 1) { throw "checkpoint-result-ambiguous" }
            Write-HyperVWindowsSuccess $Operation @(Convert-HyperVWindowsSnapshot $Created[0])
        }
        "Remove-VMSnapshot" {
            $VirtualMachine = Assert-HyperVWindowsSingleVirtualMachine $VirtualMachines
            $Snapshot = Get-HyperVWindowsSnapshot $VirtualMachine $Request.snapshot
            if ([bool]$Request.includeDescendants) {
                Hyper-V\Remove-VMSnapshot -VMSnapshot $Snapshot -IncludeAllChildSnapshots -Confirm:$false -ErrorAction Stop
            } else {
                Hyper-V\Remove-VMSnapshot -VMSnapshot $Snapshot -Confirm:$false -ErrorAction Stop
            }
            Write-HyperVWindowsSuccess $Operation @()
        }
        "Restore-VMSnapshot" {
            $VirtualMachine = Assert-HyperVWindowsSingleVirtualMachine $VirtualMachines
            $Snapshot = Get-HyperVWindowsSnapshot $VirtualMachine $Request.snapshot
            Hyper-V\Restore-VMSnapshot -VMSnapshot $Snapshot -Confirm:$false -ErrorAction Stop
            Write-HyperVWindowsSuccess $Operation @()
        }
        "Get-VMSwitch" {
            if ($null -eq $Request.selector -or [string]$Request.selector.kind -notin @("all", "id", "name")) {
                throw "virtual-switch-selector-invalid"
            }
            $Items = @(Get-HyperVWindowsVirtualSwitches $Request.selector | ForEach-Object {
                Convert-HyperVWindowsVirtualSwitch $_
            })
            Write-HyperVWindowsSuccess $Operation $Items
        }
        "New-VMSwitch" {
            $Created = @(Hyper-V\New-VMSwitch -Name ([string]$Request.name) -SwitchType Internal -Notes ([string]$Request.notes) -ErrorAction Stop)
            if ($Created.Count -ne 1) { throw "virtual-switch-create-result-ambiguous" }
            Write-HyperVWindowsSuccess $Operation @(Convert-HyperVWindowsVirtualSwitch $Created[0])
        }
        "Set-VMSwitch" {
            $VirtualSwitch = Get-HyperVWindowsVirtualSwitchByIdentity $Request.identity
            Hyper-V\Set-VMSwitch -VMSwitch $VirtualSwitch -Notes ([string]$Request.notes) -ErrorAction Stop
            Write-HyperVWindowsSuccess $Operation @()
        }
        "Remove-VMSwitch" {
            $VirtualSwitch = Get-HyperVWindowsVirtualSwitchByIdentity $Request.identity
            Hyper-V\Remove-VMSwitch -VMSwitch $VirtualSwitch -Force -Confirm:$false -ErrorAction Stop
            Write-HyperVWindowsSuccess $Operation @()
        }
        "Get-VMNetworkAdapter" {
            $Adapters = if ($GetAdaptersByVm) {
                $VirtualMachine = Assert-HyperVWindowsSingleVirtualMachine $VirtualMachines
                @(Hyper-V\Get-VMNetworkAdapter -VM $VirtualMachine -ErrorAction Stop)
            } elseif ($GetAdaptersByManagementSwitch) {
                @(Hyper-V\Get-VMNetworkAdapter -ManagementOS -SwitchName ([string]$Request.managementSwitchName) -ErrorAction Stop)
            } else {
                @(Hyper-V\Get-VMNetworkAdapter -All -ErrorAction Stop)
            }
            $Items = @($Adapters | ForEach-Object { Convert-HyperVWindowsVMNetworkAdapter $_ })
            Write-HyperVWindowsSuccess $Operation $Items
        }
        "Remove-VMNetworkAdapter" {
            $VirtualMachine = Assert-HyperVWindowsSingleVirtualMachine $VirtualMachines
            $ExpectedAdapterName = [string]$Request.adapterName
            $ExpectedMac = ([string]$Request.macAddress -replace '[^0-9A-Fa-f]', '').ToUpperInvariant()
            if ($ExpectedMac -notmatch '^[0-9A-F]{12}$' -or $ExpectedMac -eq '000000000000') {
                throw "vm-network-adapter-mac-invalid"
            }
            # Re-resolve the target here rather than trusting the caller's choice. Hyper-V lets
            # two adapters on one VM share a name, so name and address together must identify
            # exactly one adapter or nothing is removed. The caller has already decided; this
            # is the native side refusing to act on an ambiguous or stale decision.
            $AdapterMatches = @(Hyper-V\Get-VMNetworkAdapter -VM $VirtualMachine -ErrorAction Stop | Where-Object {
                [string]$_.Name -ceq $ExpectedAdapterName -and
                (([string]$_.MacAddress -replace '[^0-9A-Fa-f]', '').ToUpperInvariant() -eq $ExpectedMac)
            })
            if ($AdapterMatches.Count -eq 0) { throw "vm-network-adapter-not-found" }
            if ($AdapterMatches.Count -ne 1) { throw "vm-network-adapter-ambiguous" }
            Hyper-V\Remove-VMNetworkAdapter -VMNetworkAdapter $AdapterMatches[0] -Confirm:$false -ErrorAction Stop
            Write-HyperVWindowsSuccess $Operation @()
        }
        "Get-NetNeighbor" {
            # SilentlyContinue because the Net* CIM cmdlets throw when nothing matches, and an
            # interface with no neighbours is the ordinary case, not a failure. Neighbours are
            # only ever an additional source of address candidates -- the adapter's own
            # reported addresses are the primary one -- so degrading to empty is correct here.
            $Items = @(NetTCPIP\Get-NetNeighbor -AddressFamily IPv4 -InterfaceIndex ([int]$Request.interfaceIndex) -ErrorAction SilentlyContinue | ForEach-Object {
                [ordered]@{
                    interfaceIndex = [int]$_.InterfaceIndex
                    address = [string]$_.IPAddress
                    linkLayerAddress = if ([string]::IsNullOrEmpty([string]$_.LinkLayerAddress)) { $null } else { [string]$_.LinkLayerAddress }
                    state = if ($null -eq $_.State) { "" } else { [string]$_.State }
                }
            })
            Write-HyperVWindowsSuccess $Operation $Items
        }
        "Get-NetAdapter" {
            $ExpectedName = [string]$Request.name
            $Items = @(NetAdapter\Get-NetAdapter -ErrorAction Stop | Where-Object {
                [string]$_.Name -ceq $ExpectedName
            } | ForEach-Object { Convert-HyperVWindowsHostNetworkAdapter $_ })
            Write-HyperVWindowsSuccess $Operation $Items
        }
        "Get-NetIPAddress" {
            if ([string]$Request.selector.kind -eq "all-ipv4") {
                $Addresses = @(NetTCPIP\Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop)
            } elseif ([string]$Request.selector.kind -eq "interface") {
                $Addresses = @(NetTCPIP\Get-NetIPAddress -InterfaceIndex ([int]$Request.selector.interfaceIndex) -AddressFamily IPv4 -ErrorAction Stop)
            } else {
                throw "net-ip-address-selector-invalid"
            }
            $Items = @($Addresses | ForEach-Object { Convert-HyperVWindowsNetIPAddress $_ })
            Write-HyperVWindowsSuccess $Operation $Items
        }
        "New-NetIPAddress" {
            $Created = @(NetTCPIP\New-NetIPAddress -InterfaceIndex ([int]$Request.interfaceIndex) -IPAddress ([string]$Request.address) -PrefixLength ([int]$Request.prefixLength) -AddressFamily IPv4 -ErrorAction Stop)
            # New-NetIPAddress emits the one address it created twice, once per policy store
            # (ActiveStore and PersistentStore). Those are the same identity, not two results:
            # ambiguity is more than one distinct interface/address/prefix, and the ActiveStore
            # object is reported because that is the store Get-NetIPAddress reads back by default.
            $CreatedIdentities = @($Created | ForEach-Object {
                [string]([int]$_.InterfaceIndex) + "|" + [string]$_.IPAddress + "|" + [string]([int]$_.PrefixLength)
            } | Sort-Object -Unique)
            if ($Created.Count -lt 1 -or $CreatedIdentities.Count -ne 1) { throw "net-ip-address-create-result-ambiguous" }
            $CreatedActive = @($Created | Where-Object { [string]$_.Store -eq "ActiveStore" })
            $CreatedAddress = if ($CreatedActive.Count -ge 1) { $CreatedActive[0] } else { $Created[0] }
            Write-HyperVWindowsSuccess $Operation @(Convert-HyperVWindowsNetIPAddress $CreatedAddress)
        }
        "Remove-NetIPAddress" {
            $Address = Get-HyperVWindowsNetIPAddressByIdentity $Request
            NetTCPIP\Remove-NetIPAddress -InputObject $Address -Confirm:$false -ErrorAction Stop
            Write-HyperVWindowsSuccess $Operation @()
        }
        "Get-NetNat" {
            if ($null -eq $Request.selector -or [string]$Request.selector.kind -notin @("all", "instance-id", "name")) {
                throw "net-nat-selector-invalid"
            }
            $Items = @(Get-HyperVWindowsNetNats $Request.selector | ForEach-Object {
                Convert-HyperVWindowsNetNat $_
            })
            Write-HyperVWindowsSuccess $Operation $Items
        }
        "New-NetNat" {
            $Created = @(NetNat\New-NetNat -Name ([string]$Request.name) -InternalIPInterfaceAddressPrefix ([string]$Request.internalAddressPrefix) -ErrorAction Stop)
            if ($Created.Count -ne 1) { throw "net-nat-create-result-ambiguous" }
            Write-HyperVWindowsSuccess $Operation @(Convert-HyperVWindowsNetNat $Created[0])
        }
        "Remove-NetNat" {
            $Nat = Get-HyperVWindowsNetNatByIdentity $Request.identity
            NetNat\Remove-NetNat -InputObject $Nat -Confirm:$false -ErrorAction Stop
            Write-HyperVWindowsSuccess $Operation @()
        }
    }
} catch {
    $ErrorCode = [string]$_.Exception.Message
    if ($ErrorCode -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\z') {
        # The exception message is host text and may carry paths or VM names, so it is only ever
        # accepted when it already is one of our own bounded codes. FullyQualifiedErrorId is a
        # structured cmdlet identifier with no caller data, but it contains commas
        # ("InvalidOperation,Microsoft.HyperV.PowerShell.Commands.CheckpointVM"), which the bounded
        # pattern rejects. Normalising it keeps the code bounded while preserving the one piece of
        # diagnosis available; discarding it collapsed every native failure to a single constant.
        $ErrorCode = (([string]$_.FullyQualifiedErrorId) -replace '[^A-Za-z0-9._:-]', '-').Trim('-')
        if ($ErrorCode.Length -gt 128) { $ErrorCode = $ErrorCode.Substring(0, 128) }
    }
    Write-HyperVWindowsFailure $Operation $ErrorCode
    # Deliberately not `exit`. PowerShell's exit is not scoped to a script block, so when this asset
    # runs as `& ([ScriptBlock]::Create($source))` — how both transports invoke it — an exit here
    # unwinds past the caller instead of returning to it. Under the reused session that discards the
    # failure envelope written one line above, because Out-String never completes, and kills the
    # child, turning an ordinary virtual-machine-not-found into a transport error. Each bootstrap
    # reads this flag instead, so a one-shot invocation still ends with exit code 1.
    $global:CccHyperVExitCode = 1
}
