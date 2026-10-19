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

function Write-HyperVWindowsFailure([string]$Operation, [string]$ErrorCode, [System.Management.Automation.ErrorRecord]$Failure) {
    if ($ErrorCode -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\z') {
        $ErrorCode = "native-operation-failed"
    }
    [ordered]@{
        schemaVersion = 1
        operation = $Operation
        ok = $false
        errorCode = $ErrorCode
        nativeHResult = [int]$Failure.Exception.HResult
        nativeErrorCategory = [int]$Failure.CategoryInfo.Category
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
        $QueryErrors = @()
        $Matched = @(Hyper-V\Get-VM -Id $ExpectedId -ErrorAction SilentlyContinue -ErrorVariable +QueryErrors)
        foreach ($QueryError in $QueryErrors) {
            if ([string]$QueryError.CategoryInfo.Category -ne "ObjectNotFound" -or
                [string]$QueryError.FullyQualifiedErrorId -ne "ObjectNotFound,Microsoft.HyperV.PowerShell.Commands.GetVM") {
                throw $QueryError
            }
        }
        if ($QueryErrors.Count -gt 0) {
            # The same native error can describe an inaccessible existing VM. Only a
            # successful inventory read proves this ID is absent from the host.
            return @(Hyper-V\Get-VM -ErrorAction Stop | Where-Object { [Guid]$_.Id -eq $ExpectedId })
        }
        return @($Matched | Where-Object { [Guid]$_.Id -eq $ExpectedId })
    }
    $ExpectedName = [string]$Selector.name
    $QueryErrors = @()
    $Matched = @(Hyper-V\Get-VM -Name $ExpectedName -ErrorAction SilentlyContinue -ErrorVariable +QueryErrors)
    foreach ($QueryError in $QueryErrors) {
        $MissingByObjectNotFound = (
            [string]$QueryError.CategoryInfo.Category -eq "ObjectNotFound" -and
            [string]$QueryError.FullyQualifiedErrorId -eq "ObjectNotFound,Microsoft.HyperV.PowerShell.Commands.GetVM"
        )
        $MissingByInvalidParameter = (
            [string]$QueryError.CategoryInfo.Category -eq "InvalidArgument" -and
            [string]$QueryError.FullyQualifiedErrorId -eq "InvalidParameter,Microsoft.HyperV.PowerShell.Commands.GetVM"
        )
        if (-not $MissingByObjectNotFound -and -not $MissingByInvalidParameter) {
            throw $QueryError
        }
    }
    if ($QueryErrors.Count -gt 0) {
        return @(Hyper-V\Get-VM -ErrorAction Stop | Where-Object { [string]$_.Name -eq $ExpectedName })
    }
    return @($Matched | Where-Object { [string]$_.Name -eq $ExpectedName })
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

function Get-HyperVWindowsVirtualMachinesByExactNames([string[]]$RequestedNames) {
    if ($RequestedNames.Count -lt 1 -or $RequestedNames.Count -gt 32) { throw "inventory-names-invalid" }
    if (@($RequestedNames | Sort-Object -Unique).Count -ne $RequestedNames.Count) { throw "inventory-names-duplicate" }
    # Names are validated by the TypeScript boundary to exclude PowerShell wildcard
    # metacharacters. Passing the bounded (<= 32) set directly avoids enumerating an
    # unbounded host-wide VM inventory when every name exists, while the exact comparison
    # still fences native matching behavior.
    $QueryErrors = @()
    $MatchedVirtualMachines = @(Hyper-V\Get-VM -Name $RequestedNames -ErrorAction SilentlyContinue -ErrorVariable +QueryErrors)
    foreach ($QueryError in $QueryErrors) {
        # Hosts report a missing exact name as either native no-match shape. Every other
        # native failure (authorization, VMMS/RPC failure, provider failure, and so on)
        # must remain an error so callers never mistake an unavailable inventory for proof
        # that a VM is absent.
        $MissingByObjectNotFound = (
            [string]$QueryError.CategoryInfo.Category -eq "ObjectNotFound" -and
            [string]$QueryError.FullyQualifiedErrorId -eq "ObjectNotFound,Microsoft.HyperV.PowerShell.Commands.GetVM"
        )
        $MissingByInvalidParameter = (
            [string]$QueryError.CategoryInfo.Category -eq "InvalidArgument" -and
            [string]$QueryError.FullyQualifiedErrorId -eq "InvalidParameter,Microsoft.HyperV.PowerShell.Commands.GetVM"
        )
        if (-not $MissingByObjectNotFound -and -not $MissingByInvalidParameter) {
            throw $QueryError
        }
    }
    if ($QueryErrors.Count -gt 0) {
        # Either shape can also describe an existing VM the scoped read could not return.
        # Only a successful inventory read proves which requested names are absent.
        return @(Hyper-V\Get-VM -ErrorAction Stop | Where-Object { $RequestedNames -ccontains [string]$_.Name })
    }
    return @($MatchedVirtualMachines | Where-Object { $RequestedNames -ccontains [string]$_.Name })
}

function Assert-HyperVWindowsSingleVirtualMachine([object[]]$VirtualMachines) {
    if ($VirtualMachines.Count -eq 0) { throw "virtual-machine-not-found" }
    if ($VirtualMachines.Count -ne 1) { throw "virtual-machine-selector-ambiguous" }
    return $VirtualMachines[0]
}

function Assert-HyperVWindowsPowerIdentity([object]$VirtualMachine, [object]$Request) {
    $HasName = $Request.PSObject.Properties.Name -contains "expectedName"
    $HasNotes = $Request.PSObject.Properties.Name -contains "expectedNotes"
    if (-not $HasName -and -not $HasNotes) { return $VirtualMachine }
    if (-not $HasName -or -not $HasNotes -or
        [string]$Request.selector.kind -cne "id" -or
        $Request.expectedName -isnot [string] -or
        $Request.expectedNotes -isnot [string] -or
        [string]::IsNullOrEmpty([string]$Request.expectedName) -or
        [string]::IsNullOrEmpty([string]$Request.expectedNotes)) {
        throw "vm-identity-mismatch"
    }
    $CurrentVirtualMachine = Assert-HyperVWindowsSingleVirtualMachine @(Get-HyperVWindowsVirtualMachines $Request.selector)
    if (
        [Guid]$CurrentVirtualMachine.Id -ne [Guid][string]$Request.selector.id -or
        [string]$CurrentVirtualMachine.Name -cne [string]$Request.expectedName -or
        [string]$CurrentVirtualMachine.Notes -cne [string]$Request.expectedNotes) {
        throw "vm-identity-mismatch"
    }
    return $CurrentVirtualMachine
}

function Assert-HyperVWindowsSnapshotRepairIdentity([object]$Request) {
    $Matches = @(Get-HyperVWindowsVirtualMachines $Request.selector)
    if ($Matches.Count -ne 1) { throw "vm-identity-mismatch" }
    $Current = $Matches[0]
    if ([Guid]$Current.Id -ne [Guid][string]$Request.selector.id -or
        [string]$Current.Name -cne [string]$Request.expectedName -or
        [string]$Current.Notes -cne [string]$Request.expectedNotes) {
        throw "vm-identity-mismatch"
    }
    return $Current
}

function Assert-HyperVWindowsNoReparsePath([string]$Path) {
    $FullPath = [IO.Path]::GetFullPath($Path)
    $PathRoot = [IO.Path]::GetPathRoot($FullPath)
    if (-not $PathRoot) { throw "vhd-path-invalid" }
    $Current = $PathRoot
    foreach ($Segment in @($FullPath.Substring($PathRoot.Length) -split '[\\/]' | Where-Object { $_ })) {
        $Current = Join-Path $Current $Segment
        $Item = Get-Item -LiteralPath $Current -Force -ErrorAction SilentlyContinue
        if ($null -ne $Item -and ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "vhd-path-reparse-point-rejected"
        }
    }
}

function ConvertTo-HyperVWindowsOwnedPath([object]$Value) {
    if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value) -or
        $Value.Length -gt 4096 -or
        $Value -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])' -or
        $Value -match '[\x00-\x1f*?\[\]]') { throw "owned-path-invalid" }
    return [IO.Path]::GetFullPath([string]$Value)
}

function Test-HyperVWindowsOwnedChild([string]$Root, [string]$Path) {
    $Prefix = $Root.TrimEnd([char]'\', [char]'/') + [IO.Path]::DirectorySeparatorChar
    return $Path.StartsWith($Prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-HyperVWindowsRemoveGuard([object]$Request) {
    if ([string]$Request.selector.kind -cne "id" -or $null -eq $Request.guard) { throw "vm-remove-guard-invalid" }
    $Guard = $Request.guard
    if ($Guard.expectedName -isnot [string] -or [string]::IsNullOrEmpty($Guard.expectedName) -or
        $Guard.expectedName.Length -gt 100 -or $Guard.expectedName -match '[\x00-\x1f*?\[\]]' -or
        $Guard.expectedNotes -isnot [string] -or $Guard.expectedNotes.Length -gt 4096 -or
        $Guard.expectedNotes -match '[\x00-\x1f]' -or
        $Guard.expectedDiskPaths -isnot [array] -or $Guard.expectedDiskPaths.Count -lt 1 -or
        $Guard.expectedDiskPaths.Count -gt 128 -or $Guard.expectedDvdPaths -isnot [array] -or
        $Guard.expectedDvdPaths.Count -gt 128) { throw "vm-remove-guard-invalid" }
    $OwnedDiskDirectory = ConvertTo-HyperVWindowsOwnedPath $Guard.ownedDiskDirectory
    $ExpectedDisks = @($Guard.expectedDiskPaths | ForEach-Object { ConvertTo-HyperVWindowsOwnedPath $_ })
    $ExpectedMedia = @($Guard.expectedDvdPaths | ForEach-Object { ConvertTo-HyperVWindowsOwnedPath $_ })
    if (@($ExpectedDisks | Where-Object { -not (Test-HyperVWindowsOwnedChild $OwnedDiskDirectory $_) }).Count -gt 0 -or
        @($ExpectedDisks | Sort-Object -Unique).Count -ne $ExpectedDisks.Count -or
        @($ExpectedMedia | Sort-Object -Unique).Count -ne $ExpectedMedia.Count) { throw "vm-remove-guard-invalid" }
    $HasUnmarkedRoot = $Guard.PSObject.Properties.Name -contains "unmarkedRootDiskPath"
    if ([string]$Guard.expectedNotes -ceq "") {
        if (-not $HasUnmarkedRoot -or $ExpectedDisks.Count -ne 1 -or
            [string]::Compare((ConvertTo-HyperVWindowsOwnedPath $Guard.unmarkedRootDiskPath),
                $ExpectedDisks[0], [StringComparison]::OrdinalIgnoreCase) -ne 0) {
            throw "vm-remove-guard-invalid"
        }
    } elseif ($HasUnmarkedRoot) { throw "vm-remove-guard-invalid" }

    # A second exact-name VM is a conflict even if the GUID still exists. Re-read both selectors
    # at the mutation boundary rather than trusting the broker's earlier inspection.
    $Current = Assert-HyperVWindowsSingleVirtualMachine @(Get-HyperVWindowsVirtualMachines $Request.selector)
    $Named = @(Get-HyperVWindowsVirtualMachines ([pscustomobject]@{ kind = "name"; name = $Guard.expectedName }))
    if ($Named.Count -ne 1 -or [Guid]$Named[0].Id -ne [Guid]$Current.Id -or
        [Guid]$Current.Id -ne [Guid][string]$Request.selector.id -or
        [string]$Current.Name -cne [string]$Guard.expectedName -or
        [string]$Current.Notes -cne [string]$Guard.expectedNotes) { throw "vm-remove-identity-mismatch" }
    $AttachedDisks = @(Hyper-V\Get-VMHardDiskDrive -VM $Current -ErrorAction Stop | ForEach-Object {
        if ([string]::IsNullOrEmpty([string]$_.Path)) { throw "vm-remove-disk-mismatch" }
        ConvertTo-HyperVWindowsOwnedPath ([string]$_.Path)
    })
    if ([string]$Guard.expectedNotes -ceq "") {
        if ($AttachedDisks.Count -ne 1 -or
            [string]::Compare($AttachedDisks[0], $ExpectedDisks[0], [StringComparison]::OrdinalIgnoreCase) -ne 0) {
            throw "vm-remove-disk-mismatch"
        }
    } elseif (@($AttachedDisks | Where-Object {
        $Disk = $_
        -not (@($ExpectedDisks | Where-Object { [string]::Compare($_, $Disk, [StringComparison]::OrdinalIgnoreCase) -eq 0 }).Count -gt 0) -and
            -not (Test-HyperVWindowsOwnedChild $OwnedDiskDirectory $Disk)
    }).Count -gt 0) { throw "vm-remove-disk-mismatch" }
    $AttachedMedia = @(Hyper-V\Get-VMDvdDrive -VM $Current -ErrorAction Stop | Where-Object {
        -not [string]::IsNullOrEmpty([string]$_.Path)
    } | ForEach-Object { ConvertTo-HyperVWindowsOwnedPath ([string]$_.Path) })
    if (@($AttachedMedia | Where-Object {
        $Media = $_
        -not (@($ExpectedMedia | Where-Object { [string]::Compare($_, $Media, [StringComparison]::OrdinalIgnoreCase) -eq 0 }).Count -gt 0)
    }).Count -gt 0) { throw "vm-remove-media-mismatch" }
    return $Current
}

function Get-HyperVWindowsOwnedItem([string]$Path) {
    try { return Get-Item -LiteralPath $Path -Force -ErrorAction Stop }
    catch {
        if ([string]$_.CategoryInfo.Category -ne "ObjectNotFound") { throw "host-file-inspection-failed" }
        $Parent = Split-Path -Parent $Path
        if ($Parent -and (Test-Path -LiteralPath $Parent -PathType Container -ErrorAction Stop)) {
            # A dangling link can be reported as missing by Get-Item. A directory listing
            # distinguishes that entry from an actually missing child before any deletion.
            $Named = @(Get-ChildItem -LiteralPath $Parent -Force -ErrorAction Stop | Where-Object {
                [string]$_.Name -ieq [IO.Path]::GetFileName($Path)
            })
            if ($Named.Count -ne 0) { throw "host-file-reparse-point-rejected" }
        }
        return $null
    }
}

function Assert-HyperVWindowsOwnedPathComponents([string]$Path, [string]$Root) {
    if (-not (Test-HyperVWindowsOwnedChild $Root $Path)) { throw "host-file-path-invalid" }
    $FullPath = ConvertTo-HyperVWindowsOwnedPath $Path
    $PathRoot = [IO.Path]::GetPathRoot($FullPath)
    $Current = $PathRoot
    foreach ($Segment in @($FullPath.Substring($PathRoot.Length) -split '[\\/]' | Where-Object { $_ })) {
        $Current = Join-Path $Current $Segment
        $Item = Get-HyperVWindowsOwnedItem $Current
        if ($null -eq $Item) { continue }
        if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "host-file-reparse-point-rejected"
        }
    }
}

function Assert-HyperVWindowsOwnedFilePath([string]$Path, [string]$Root) {
    Assert-HyperVWindowsOwnedPathComponents $Path $Root
    $FullPath = ConvertTo-HyperVWindowsOwnedPath $Path
    $File = Get-HyperVWindowsOwnedItem $FullPath
    if ($null -eq $File) { return $false }
    if ($File.PSIsContainer) { throw "host-file-not-regular" }
    return $true
}

function Assert-HyperVWindowsVhdMutationPath([object]$Value) {
    if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value) -or
        $Value -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+\\)' -or
        $Value -match '[\x00-\x1f*?\[\]]') { throw "vhd-path-invalid" }
    Assert-HyperVWindowsNoReparsePath $Value
    if (-not (Test-Path -LiteralPath $Value -PathType Leaf)) { throw "vhd-not-found" }
}

function Assert-HyperVWindowsVhdDestinationPath([object]$Value) {
    if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value) -or
        $Value -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+\\)' -or
        $Value -match '[\x00-\x1f*?\[\]]') { throw "vhd-path-invalid" }
    Assert-HyperVWindowsNoReparsePath $Value
    if (Test-Path -LiteralPath $Value) { throw "vhd-destination-exists" }
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

# Hyper-V permits two adapters on one VM to share a name, so a name alone is not an identity.
# The non-destructive adapter operations still resolve through it because that is the only handle
# their callers hold; refusing an ambiguous match here keeps them from acting on the wrong one.
function Get-HyperVWindowsVMNetworkAdapterByName([object]$VirtualMachine, [string]$AdapterName) {
    $AdapterMatches = @(Hyper-V\Get-VMNetworkAdapter -VM $VirtualMachine -ErrorAction Stop | Where-Object {
        [string]$_.Name -ceq $AdapterName
    })
    if ($AdapterMatches.Count -eq 0) { throw "vm-network-adapter-not-found" }
    if ($AdapterMatches.Count -ne 1) { throw "vm-network-adapter-ambiguous" }
    return $AdapterMatches[0]
}

# Resolves the adapter a request names. "sole" means the VM's only adapter and refuses when it
# has any other number -- the adapter New-VM creates is spelled in the host's display language,
# so matching it by a literal name is wrong on a localized Hyper-V. The command this replaces
# read the VM's adapters, asserted the count was one, and took that one.
function Get-HyperVWindowsVMNetworkAdapterTarget([object]$VirtualMachine, [object]$Target) {
    if ($null -eq $Target) { throw "vm-network-adapter-target-invalid" }
    $TargetKind = [string]$Target.kind
    if ($TargetKind -ceq "sole") {
        $AllAdapters = @(Hyper-V\Get-VMNetworkAdapter -VM $VirtualMachine -ErrorAction Stop)
        if ($AllAdapters.Count -eq 0) { throw "vm-network-adapter-not-found" }
        if ($AllAdapters.Count -ne 1) { throw "vm-network-adapter-ambiguous" }
        return $AllAdapters[0]
    }
    if ($TargetKind -ceq "name") {
        $TargetName = [string]$Target.name
        if ([string]::IsNullOrEmpty($TargetName)) { throw "vm-network-adapter-name-invalid" }
        return Get-HyperVWindowsVMNetworkAdapterByName $VirtualMachine $TargetName
    }
    throw "vm-network-adapter-target-invalid"
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
# The generic diagnostic snapshot keeps each optional native reader independent. It carries
# no Device Lab owner-ID policy and exposes no host disk path.
function Get-HyperVWindowsDiagnosticProperty {
    param(
        [AllowNull()] [object] $InputObject,
        [Parameter(Mandatory = $true)] [string] $Name,
        [AllowNull()] [object] $Default = $null,
        [AllowNull()] [System.Collections.Generic.List[string]] $DiagnosticErrors = $null,
        [string] $ErrorCode = '',
        [switch] $Required
    )
    try {
        if ($null -eq $InputObject) {
            if ($Required -and $null -ne $DiagnosticErrors -and $ErrorCode) { [void]$DiagnosticErrors.Add($ErrorCode) }
            return $Default
        }
        $Property = $InputObject.PSObject.Properties[$Name]
        if ($null -eq $Property) {
            if ($Required -and $null -ne $DiagnosticErrors -and $ErrorCode) { [void]$DiagnosticErrors.Add($ErrorCode) }
            return $Default
        }
        $Value = $Property.Value
        if ($Required -and $null -eq $Value -and $null -ne $DiagnosticErrors -and $ErrorCode) { [void]$DiagnosticErrors.Add($ErrorCode) }
        return $Value
    }
    catch {
        if ($null -ne $DiagnosticErrors -and $ErrorCode) { [void]$DiagnosticErrors.Add($ErrorCode) }
        return $Default
    }
}

function ConvertTo-HyperVWindowsDiagnosticInt {
    param([AllowNull()] [object] $Value)
    if ($null -eq $Value) { return $null }
    try {
        $Converted = [int]$Value
        if ($Converted -lt 0) { return $null }
        return $Converted
    }
    catch { return $null }
}

function ConvertTo-HyperVWindowsDiagnosticLong {
    param([AllowNull()] [object] $Value)
    if ($null -eq $Value) { return $null }
    try {
        $Converted = [long]$Value
        if ($Converted -lt 0) { return $null }
        return $Converted
    }
    catch { return $null }
}

function ConvertTo-HyperVWindowsDiagnosticString {
    param(
        [AllowNull()] [object] $Value,
        [string] $Default = '',
        [AllowNull()] [System.Collections.Generic.List[string]] $DiagnosticErrors = $null,
        [string] $ErrorCode = '',
        [switch] $Required
    )
    try {
        if ($null -eq $Value) {
            if ($Required -and $null -ne $DiagnosticErrors -and $ErrorCode) { [void]$DiagnosticErrors.Add($ErrorCode) }
            return $Default
        }
        $Converted = [string]$Value
        if ($Required -and [string]::IsNullOrWhiteSpace($Converted) -and $null -ne $DiagnosticErrors -and $ErrorCode) {
            [void]$DiagnosticErrors.Add($ErrorCode)
        }
        return $Converted
    }
    catch {
        if ($null -ne $DiagnosticErrors -and $ErrorCode) { [void]$DiagnosticErrors.Add($ErrorCode) }
        return $Default
    }
}

function ConvertTo-HyperVWindowsDiagnosticBool {
    param(
        [AllowNull()] [object] $Value,
        [AllowNull()] [object] $Default,
        [Parameter(Mandatory = $true)] [System.Collections.Generic.List[string]] $DiagnosticErrors,
        [Parameter(Mandatory = $true)] [string] $ErrorCode
    )
    if ($Value -is [bool]) { return [bool]$Value }
    $Text = if ($null -eq $Value) { '' } else { [string]$Value }
    if ($Text -eq 'On' -or $Text -eq 'True') { return $true }
    if ($Text -eq 'Off' -or $Text -eq 'False') { return $false }
    [void]$DiagnosticErrors.Add($ErrorCode)
    return $Default
}

function Get-HyperVWindowsGuestBootDiagnosticResult {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [object] $Vm,
        [scriptblock] $IntegrationServiceReader = { param($TargetVm) @(Hyper-V\Get-VMIntegrationService -VM $TargetVm -ErrorAction Stop) },
        [scriptblock] $FirmwareReader = { param($TargetVm) Hyper-V\Get-VMFirmware -VM $TargetVm -ErrorAction Stop },
        [scriptblock] $BiosReader = { param($TargetVm) Hyper-V\Get-VMBios -VM $TargetVm -ErrorAction Stop },
        [scriptblock] $HardDiskReader = { param($TargetVm) @(Hyper-V\Get-VMHardDiskDrive -VM $TargetVm -ErrorAction Stop) },
        [scriptblock] $DvdReader = { param($TargetVm) @(Hyper-V\Get-VMDvdDrive -VM $TargetVm -ErrorAction Stop) },
        [scriptblock] $VhdReader = { param($Path) Hyper-V\Get-VHD -Path $Path -ErrorAction Stop }
    )

    $DiagnosticErrors = [System.Collections.Generic.List[string]]::new()
    $GenerationValue = ConvertTo-HyperVWindowsDiagnosticInt (Get-HyperVWindowsDiagnosticProperty $Vm 'Generation' $null $DiagnosticErrors 'hyper-v-diagnostic-vm-observation-incomplete' -Required)
    $Generation = if ($GenerationValue -eq 1 -or $GenerationValue -eq 2) { $GenerationValue } else { $null }
    $StateValue = Get-HyperVWindowsDiagnosticProperty $Vm 'State' $null $DiagnosticErrors 'hyper-v-diagnostic-vm-observation-incomplete' -Required
    $State = ConvertTo-HyperVWindowsDiagnosticString $StateValue 'Unknown' $DiagnosticErrors 'hyper-v-diagnostic-vm-observation-incomplete' -Required
    if ([string]::IsNullOrWhiteSpace($State)) {
        $State = 'Unknown'
        [void]$DiagnosticErrors.Add('hyper-v-diagnostic-vm-observation-incomplete')
    }
    $UptimeMs = 0
    try {
        $Uptime = Get-HyperVWindowsDiagnosticProperty $Vm 'Uptime' $null $DiagnosticErrors 'hyper-v-diagnostic-vm-observation-incomplete' -Required
        if ($null -eq $Uptime) { [void]$DiagnosticErrors.Add('hyper-v-diagnostic-vm-observation-incomplete') }
        else {
            $TotalMilliseconds = Get-HyperVWindowsDiagnosticProperty $Uptime 'TotalMilliseconds' $null $DiagnosticErrors 'hyper-v-diagnostic-vm-observation-incomplete' -Required
            if ($null -eq $TotalMilliseconds) { [void]$DiagnosticErrors.Add('hyper-v-diagnostic-vm-observation-incomplete') }
            else { $UptimeMs = [Math]::Max(0, [Math]::Floor([double]$TotalMilliseconds)) }
        }
    }
    catch { [void]$DiagnosticErrors.Add('hyper-v-diagnostic-vm-observation-incomplete') }
    if ($null -eq $Generation) { [void]$DiagnosticErrors.Add('hyper-v-diagnostic-vm-observation-incomplete') }

    $IntegrationServices = @()
    $IntegrationServicesAvailable = $true
    try { $IntegrationServices = @(& $IntegrationServiceReader $Vm) }
    catch {
        $IntegrationServicesAvailable = $false
        [void]$DiagnosticErrors.Add('hyper-v-diagnostic-integration-services-unavailable')
    }
    if ($IntegrationServicesAvailable -and $IntegrationServices.Count -eq 0) { [void]$DiagnosticErrors.Add('hyper-v-diagnostic-integration-services-incomplete') }

    $IntegrationServiceSummary = @()
    foreach ($Service in $IntegrationServices) {
        try {
            $ServiceName = ConvertTo-HyperVWindowsDiagnosticString `
                (Get-HyperVWindowsDiagnosticProperty $Service 'Name' $null $DiagnosticErrors 'hyper-v-diagnostic-integration-services-incomplete' -Required) `
                '' $DiagnosticErrors 'hyper-v-diagnostic-integration-services-incomplete' -Required
            if ([string]::IsNullOrWhiteSpace($ServiceName)) {
                [void]$DiagnosticErrors.Add('hyper-v-diagnostic-integration-services-incomplete')
                continue
            }
            if ($ServiceName.Length -gt 128) { $ServiceName = $ServiceName.Substring(0, 128) }
            $PrimaryStatus = ConvertTo-HyperVWindowsDiagnosticInt (Get-HyperVWindowsDiagnosticProperty $Service 'PrimaryStatus' $null $DiagnosticErrors 'hyper-v-diagnostic-integration-services-incomplete')
            $SecondaryStatus = ConvertTo-HyperVWindowsDiagnosticInt (Get-HyperVWindowsDiagnosticProperty $Service 'SecondaryStatus' $null $DiagnosticErrors 'hyper-v-diagnostic-integration-services-incomplete')
            $Enabled = ConvertTo-HyperVWindowsDiagnosticBool `
                (Get-HyperVWindowsDiagnosticProperty $Service 'Enabled' $null $DiagnosticErrors 'hyper-v-diagnostic-integration-services-incomplete' -Required) `
                $false $DiagnosticErrors 'hyper-v-diagnostic-integration-services-incomplete'
            $IntegrationServiceSummary += [ordered]@{
                name = $ServiceName
                enabled = $Enabled
                primaryStatus = $PrimaryStatus
                secondaryStatus = $SecondaryStatus
            }
        }
        catch {
            [void]$DiagnosticErrors.Add('hyper-v-diagnostic-integration-services-incomplete')
        }
    }
    $IntegrationServiceSummary = @($IntegrationServiceSummary | Sort-Object { $_.name } | Select-Object -First 16)

    $HeartbeatServiceId = '84eaae65-2f2e-45f5-9bb5-0e857dc8eb47'
    $Heartbeat = @($IntegrationServices | Where-Object {
        $Id = ConvertTo-HyperVWindowsDiagnosticString `
            (Get-HyperVWindowsDiagnosticProperty $_ 'Id' $null $DiagnosticErrors 'hyper-v-diagnostic-integration-services-incomplete' -Required) `
            '' $DiagnosticErrors 'hyper-v-diagnostic-integration-services-incomplete' -Required
        $Id.Trim('{}').ToLowerInvariant() -eq $HeartbeatServiceId
    } | Select-Object -First 1)

    $Firmware = $null
    $Bios = $null
    if ($Generation -eq 2) {
        try { $Firmware = & $FirmwareReader $Vm }
        catch { [void]$DiagnosticErrors.Add('hyper-v-diagnostic-firmware-unavailable') }
        if ($null -eq $Firmware) { [void]$DiagnosticErrors.Add('hyper-v-diagnostic-firmware-unavailable') }
    }
    elseif ($Generation -eq 1) {
        try { $Bios = & $BiosReader $Vm }
        catch { [void]$DiagnosticErrors.Add('hyper-v-diagnostic-bios-unavailable') }
        if ($null -eq $Bios) { [void]$DiagnosticErrors.Add('hyper-v-diagnostic-bios-unavailable') }
    }

    $BootDeviceTypes = @()
    $BootEntrySummary = @()
    if ($null -ne $Firmware) {
        $BootOrder = @(Get-HyperVWindowsDiagnosticProperty $Firmware 'BootOrder' @() $DiagnosticErrors 'hyper-v-diagnostic-firmware-incomplete' -Required)
        if ($BootOrder.Count -eq 0) { [void]$DiagnosticErrors.Add('hyper-v-diagnostic-firmware-incomplete') }
        $BoundedBootOrder = @($BootOrder | Select-Object -First 8)
        foreach ($BootEntry in $BoundedBootOrder) {
            try {
                $BootType = ConvertTo-HyperVWindowsDiagnosticString `
                    (Get-HyperVWindowsDiagnosticProperty $BootEntry 'BootType' $null $DiagnosticErrors 'hyper-v-diagnostic-firmware-incomplete' -Required) `
                    '' $DiagnosticErrors 'hyper-v-diagnostic-firmware-incomplete' -Required
                $Device = Get-HyperVWindowsDiagnosticProperty $BootEntry 'Device' $null $DiagnosticErrors 'hyper-v-diagnostic-firmware-incomplete'
                $DeviceType = if ($null -ne $Device) { ConvertTo-HyperVWindowsDiagnosticString $Device.GetType().Name } else { '' }
                $ControllerType = if ($null -ne $Device) { ConvertTo-HyperVWindowsDiagnosticString (Get-HyperVWindowsDiagnosticProperty $Device 'ControllerType') } else { '' }
                $ControllerNumber = if ($null -ne $Device) { ConvertTo-HyperVWindowsDiagnosticInt (Get-HyperVWindowsDiagnosticProperty $Device 'ControllerNumber') } else { $null }
                $ControllerLocation = if ($null -ne $Device) { ConvertTo-HyperVWindowsDiagnosticInt (Get-HyperVWindowsDiagnosticProperty $Device 'ControllerLocation') } else { $null }
                $Classification = $BootType + ' ' + $DeviceType
                if ($Classification -match 'HardDisk|Vhd') { $BootDeviceTypes += 'hard-disk' }
                elseif ($Classification -match 'Dvd|Optical') { $BootDeviceTypes += 'dvd' }
                elseif ($Classification -match 'Network') { $BootDeviceTypes += 'network' }
                else { $BootDeviceTypes += 'unknown' }
                $BootEntrySummary += [ordered]@{
                    bootType = if ($BootType.Length -gt 64) { $BootType.Substring(0, 64) } else { $BootType }
                    deviceType = if ($DeviceType.Length -gt 128) { $DeviceType.Substring(0, 128) } else { $DeviceType }
                    controllerType = if ($ControllerType.Length -gt 32) { $ControllerType.Substring(0, 32) } else { $ControllerType }
                    controllerNumber = $ControllerNumber
                    controllerLocation = $ControllerLocation
                }
            }
            catch {
                [void]$DiagnosticErrors.Add('hyper-v-diagnostic-firmware-incomplete')
                $BootDeviceTypes += 'unknown'
                $BootEntrySummary += [ordered]@{ bootType = ''; deviceType = ''; controllerType = ''; controllerNumber = $null; controllerLocation = $null }
            }
        }
    }
    elseif ($null -ne $Bios) {
        $StartupOrder = @(@(Get-HyperVWindowsDiagnosticProperty $Bios 'StartupOrder' @() $DiagnosticErrors 'hyper-v-diagnostic-bios-incomplete' -Required) | Select-Object -First 8)
        if ($StartupOrder.Count -eq 0) { [void]$DiagnosticErrors.Add('hyper-v-diagnostic-bios-incomplete') }
        foreach ($BootEntry in $StartupOrder) {
            $BootEntryValue = ConvertTo-HyperVWindowsDiagnosticString $BootEntry '' $DiagnosticErrors 'hyper-v-diagnostic-bios-incomplete' -Required
            if ($BootEntryValue.Length -gt 64) {
                $BootEntryValue = $BootEntryValue.Substring(0, 64)
                [void]$DiagnosticErrors.Add('hyper-v-diagnostic-bios-incomplete')
            }
            switch ($BootEntryValue) {
                'IDE' { $BootDeviceTypes += 'hard-disk' }
                'CD' { $BootDeviceTypes += 'dvd' }
                'LegacyNetworkAdapter' { $BootDeviceTypes += 'network' }
                default { $BootDeviceTypes += 'unknown' }
            }
            $BootEntrySummary += [ordered]@{ bootType = $BootEntryValue; deviceType = 'bios'; controllerType = ''; controllerNumber = $null; controllerLocation = $null }
        }
    }

    $HardDisks = @()
    $HardDisksAvailable = $true
    try { $HardDisks = @(& $HardDiskReader $Vm) }
    catch {
        $HardDisksAvailable = $false
        [void]$DiagnosticErrors.Add('hyper-v-diagnostic-hard-disks-unavailable')
    }
    if ($HardDisksAvailable -and $HardDisks.Count -eq 0) { [void]$DiagnosticErrors.Add('hyper-v-diagnostic-hard-disks-incomplete') }
    $HardDiskControllers = @()
    $HardDiskSummary = @()
    $BoundedHardDisks = @($HardDisks | Select-Object -First 8)
    foreach ($HardDisk in $BoundedHardDisks) {
        try {
            $Controller = (ConvertTo-HyperVWindowsDiagnosticString `
                (Get-HyperVWindowsDiagnosticProperty $HardDisk 'ControllerType' $null $DiagnosticErrors 'hyper-v-diagnostic-hard-disks-incomplete' -Required) `
                '' $DiagnosticErrors 'hyper-v-diagnostic-hard-disks-incomplete' -Required).ToLowerInvariant()
            if ($Controller -eq 'ide' -or $Controller -eq 'scsi') { $HardDiskControllers += $Controller }
            else {
                [void]$DiagnosticErrors.Add('hyper-v-diagnostic-hard-disks-incomplete')
                continue
            }
            $ControllerNumber = ConvertTo-HyperVWindowsDiagnosticInt (Get-HyperVWindowsDiagnosticProperty $HardDisk 'ControllerNumber')
            $ControllerLocation = ConvertTo-HyperVWindowsDiagnosticInt (Get-HyperVWindowsDiagnosticProperty $HardDisk 'ControllerLocation')
            $Vhd = $null
            try {
                $DiskPath = ConvertTo-HyperVWindowsDiagnosticString (Get-HyperVWindowsDiagnosticProperty $HardDisk 'Path')
                if ($DiskPath) { $Vhd = & $VhdReader $DiskPath }
            }
            catch { [void]$DiagnosticErrors.Add('hyper-v-diagnostic-vhd-inspection-incomplete') }
            if ($null -eq $Vhd) { [void]$DiagnosticErrors.Add('hyper-v-diagnostic-vhd-inspection-incomplete') }
            $HardDiskSummary += [ordered]@{
                controllerType = $Controller
                controllerNumber = $ControllerNumber
                controllerLocation = $ControllerLocation
                vhdFormat = if ($null -ne $Vhd) { ConvertTo-HyperVWindowsDiagnosticString (Get-HyperVWindowsDiagnosticProperty $Vhd 'VhdFormat') } else { '' }
                vhdType = if ($null -ne $Vhd) { ConvertTo-HyperVWindowsDiagnosticString (Get-HyperVWindowsDiagnosticProperty $Vhd 'VhdType') } else { '' }
                sizeBytes = if ($null -ne $Vhd) { ConvertTo-HyperVWindowsDiagnosticLong (Get-HyperVWindowsDiagnosticProperty $Vhd 'Size') } else { $null }
                fileSizeBytes = if ($null -ne $Vhd) { ConvertTo-HyperVWindowsDiagnosticLong (Get-HyperVWindowsDiagnosticProperty $Vhd 'FileSize') } else { $null }
                minimumSizeBytes = if ($null -ne $Vhd) { ConvertTo-HyperVWindowsDiagnosticLong (Get-HyperVWindowsDiagnosticProperty $Vhd 'MinimumSize') } else { $null }
                logicalSectorSize = if ($null -ne $Vhd) { ConvertTo-HyperVWindowsDiagnosticInt (Get-HyperVWindowsDiagnosticProperty $Vhd 'LogicalSectorSize') } else { $null }
                physicalSectorSize = if ($null -ne $Vhd) { ConvertTo-HyperVWindowsDiagnosticInt (Get-HyperVWindowsDiagnosticProperty $Vhd 'PhysicalSectorSize') } else { $null }
            }
        }
        catch { [void]$DiagnosticErrors.Add('hyper-v-diagnostic-hard-disks-incomplete') }
    }

    $DvdDrives = @()
    try { $DvdDrives = @(& $DvdReader $Vm) }
    catch { [void]$DiagnosticErrors.Add('hyper-v-diagnostic-dvd-drives-unavailable') }
    $DvdSummary = @()
    foreach ($Dvd in @($DvdDrives | Select-Object -First 8)) {
        $DvdPath = ConvertTo-HyperVWindowsDiagnosticString (Get-HyperVWindowsDiagnosticProperty $Dvd 'Path')
        $DvdSummary += [ordered]@{
            controllerType = (ConvertTo-HyperVWindowsDiagnosticString (Get-HyperVWindowsDiagnosticProperty $Dvd 'ControllerType')).ToLowerInvariant()
            controllerNumber = ConvertTo-HyperVWindowsDiagnosticInt (Get-HyperVWindowsDiagnosticProperty $Dvd 'ControllerNumber')
            controllerLocation = ConvertTo-HyperVWindowsDiagnosticInt (Get-HyperVWindowsDiagnosticProperty $Dvd 'ControllerLocation')
            mediaAttached = -not [string]::IsNullOrWhiteSpace($DvdPath)
        }
    }

    $HeartbeatEnabled = $null
    $HeartbeatPrimaryStatus = $null
    $HeartbeatSecondaryStatus = $null
    if ($Heartbeat.Count -eq 1) {
        $HeartbeatEnabled = ConvertTo-HyperVWindowsDiagnosticBool `
            (Get-HyperVWindowsDiagnosticProperty $Heartbeat[0] 'Enabled' $null $DiagnosticErrors 'hyper-v-diagnostic-integration-services-incomplete' -Required) `
            $null $DiagnosticErrors 'hyper-v-diagnostic-integration-services-incomplete'
        $HeartbeatPrimaryStatus = ConvertTo-HyperVWindowsDiagnosticInt (Get-HyperVWindowsDiagnosticProperty $Heartbeat[0] 'PrimaryStatus' $null $DiagnosticErrors 'hyper-v-diagnostic-integration-services-incomplete')
        $HeartbeatSecondaryStatus = ConvertTo-HyperVWindowsDiagnosticInt (Get-HyperVWindowsDiagnosticProperty $Heartbeat[0] 'SecondaryStatus' $null $DiagnosticErrors 'hyper-v-diagnostic-integration-services-incomplete')
    }

    $SecureBootEnabled = $null
    if ($null -ne $Firmware) {
        $SecureBootEnabled = ConvertTo-HyperVWindowsDiagnosticBool `
            (Get-HyperVWindowsDiagnosticProperty $Firmware 'SecureBoot' $null $DiagnosticErrors 'hyper-v-diagnostic-firmware-incomplete' -Required) `
            $null $DiagnosticErrors 'hyper-v-diagnostic-firmware-incomplete'
    }
    $DiagnosticErrors = @($DiagnosticErrors | Select-Object -Unique | Select-Object -First 16)
    return [ordered]@{
        ok = $true
        vmId = ConvertTo-HyperVWindowsDiagnosticString (Get-HyperVWindowsDiagnosticProperty $Vm 'Id')
        vmName = ConvertTo-HyperVWindowsDiagnosticString (Get-HyperVWindowsDiagnosticProperty $Vm 'Name')
        state = $State
        uptimeMs = [long]$UptimeMs
        generation = $Generation
        secureBootEnabled = $SecureBootEnabled
        heartbeatEnabled = $HeartbeatEnabled
        heartbeatPrimaryStatus = $HeartbeatPrimaryStatus
        heartbeatSecondaryStatus = $HeartbeatSecondaryStatus
        integrationServices = $IntegrationServiceSummary
        hardDiskCount = $HardDisks.Count
        dvdCount = $DvdDrives.Count
        hardDiskControllers = $HardDiskControllers
        bootDeviceTypes = $BootDeviceTypes
        bootEntries = $BootEntrySummary
        hardDisks = $HardDiskSummary
        dvdDrives = $DvdSummary
        diagnosticComplete = $DiagnosticErrors.Count -eq 0
        diagnosticErrors = $DiagnosticErrors
    }
}


$GuestBootFixedErrorCodes = @(
    "hyper-v-guest-provision-vm-identity-mismatch",
    "hyper-v-guest-provision-requires-stopped-vm",
    "hyper-v-guest-provision-generation-mismatch",
    "hyper-v-guest-provision-path-invalid",
    "hyper-v-guest-provision-media-unavailable",
    "hyper-v-guest-disk-attachment-mismatch",
    "hyper-v-guest-provisioning-media-already-attached",
    "hyper-v-guest-provision-boot-settings-invalid",
    "hyper-v-guest-bootstrap-adapter-invalid",
    "hyper-v-guest-bootstrap-mac-identity-mismatch",
    "hyper-v-guest-provisioning-media-attach-failed",
    "hyper-v-guest-secure-boot-not-enabled",
    "hyper-v-guest-secure-boot-not-disabled",
    "hyper-v-guest-provision-bios-order-mismatch",
    "hyper-v-guest-integration-services-not-enabled",
    "hyper-v-guest-provision-vm-state-changed",
    "hyper-v-guest-provision-boot-settings-command-failed",
    "hyper-v-guest-provision-preflight-command-failed",
    "hyper-v-guest-provision-media-cleanup-failed"
)
$SnapshotRepairFixedErrorCodes = @(
    "repair-request-invalid",
    "snapshot-name-invalid",
    "snapshot-policy-invalid",
    "vm-identity-mismatch",
    "hyper-v-snapshot-policy-quarantined",
    "hyper-v-snapshot-policy-restore-failed",
    "hyper-v-snapshot-policy-quarantine-failed",
    "hyper-v-snapshot-reconciliation-ambiguous",
    "hyper-v-snapshot-reconciliation-command-failed"
)

$ConsoleFixedErrorCodes = @(
    "hyper-v-console-identity-mismatch", "hyper-v-display-unavailable", "hyper-v-console-wmi-unavailable",
    "hyper-v-console-wmi-device-ambiguous", "hyper-v-console-geometry-invalid", "hyper-v-console-geometry-changed",
    "hyper-v-console-capture-invalid", "hyper-v-console-capture-too-large", "hyper-v-console-wmi-job-timeout",
    "hyper-v-console-wmi-method-failed", "hyper-v-console-wmi-access-denied", "hyper-v-console-input-invalid",
    "hyper-v-console-key-unsupported", "hyper-v-console-scroll-unsupported", "hyper-v-console-text-invalid",
    "hyper-v-console-native-failed"
)

function Get-HyperVConsoleAssociated([System.Management.ManagementScope]$Scope, [System.Management.ManagementObject]$Vm, [string]$ClassName) {
    if ($ClassName -notin @('Msvm_VideoHead', 'Msvm_Keyboard', 'Msvm_SyntheticMouse')) { throw 'hyper-v-console-wmi-unavailable' }
    $Query = [System.Management.ObjectQuery]::new("ASSOCIATORS OF {$($Vm.Path.RelativePath)} WHERE AssocClass=Msvm_SystemDevice ResultClass=$ClassName")
    $Searcher = [System.Management.ManagementObjectSearcher]::new($Scope, $Query)
    return @($Searcher.Get() | Where-Object { [string]$_.SystemName -ieq [string]$Vm.Name })
}

function Get-HyperVConsoleContext([object]$VirtualMachine, [object]$Request) {
    if ([string]$Request.selector.kind -cne 'id' -or
        [string]$VirtualMachine.Name -cne [string]$Request.expectedName -or
        [string]$VirtualMachine.Notes -cne [string]$Request.expectedNotes) { throw 'hyper-v-console-identity-mismatch' }
    if ([string]$VirtualMachine.State -ne 'Running') { throw 'hyper-v-display-unavailable' }
    try {
        $Scope = [System.Management.ManagementScope]::new('\\.\root\virtualization\v2')
        $Scope.Connect()
        $VmId = ([Guid]$VirtualMachine.Id).ToString('D')
        $Searcher = [System.Management.ManagementObjectSearcher]::new($Scope,
            [System.Management.ObjectQuery]::new("SELECT * FROM Msvm_ComputerSystem WHERE Name = '$VmId'"))
        $Vms = @($Searcher.Get() | Where-Object { [string]$_.Name -ieq $VmId })
        if ($Vms.Count -ne 1) { throw 'hyper-v-console-identity-mismatch' }
        $Vm = $Vms[0]
        if ([uint16]$Vm.EnabledState -ne 2) { throw 'hyper-v-display-unavailable' }
        $Heads = @(Get-HyperVConsoleAssociated $Scope $Vm 'Msvm_VideoHead')
        if ($Heads.Count -ne 1) { throw 'hyper-v-console-wmi-device-ambiguous' }
        $Width = [long]$Heads[0]['CurrentHorizontalResolution']
        $Height = [long]$Heads[0]['CurrentVerticalResolution']
        if ($Width -lt 1 -or $Width -gt 8192 -or $Height -lt 1 -or $Height -gt 8192) { throw 'hyper-v-console-geometry-invalid' }
        return [pscustomobject]@{ Scope = $Scope; Vm = $Vm; Width = [int]$Width; Height = [int]$Height }
    } catch {
        if ([string]$_.Exception.Message -in $ConsoleFixedErrorCodes) { throw }
        if ($_.Exception -is [UnauthorizedAccessException] -or [int64]$_.Exception.HResult -eq -2147217405) { throw 'hyper-v-console-wmi-access-denied' }
        throw 'hyper-v-console-wmi-unavailable'
    }
}

function Invoke-HyperVConsoleMethod([System.Management.ManagementObject]$Device, [string]$Method, [hashtable]$Arguments) {
    $Input = $Device.GetMethodParameters($Method)
    foreach ($Name in $Arguments.Keys) { $Input[$Name] = $Arguments[$Name] }
    $Output = $Device.InvokeMethod($Method, $Input, $null)
    if ($null -eq $Output) { throw 'hyper-v-console-wmi-method-failed' }
    $Status = [uint32]$Output['ReturnValue']
    if ($Status -eq 0) { return $Output }
    if ($Status -eq 32769) { throw 'hyper-v-console-wmi-access-denied' }
    if ($Status -eq 4096) {
        $JobPath = [string]$Output['Job']
        if ([string]::IsNullOrWhiteSpace($JobPath)) { throw 'hyper-v-console-wmi-method-failed' }
        $Job = [System.Management.ManagementObject]::new($Device.Scope, [System.Management.ManagementPath]::new($JobPath), $null)
        $Deadline = [DateTime]::UtcNow.AddSeconds(10)
        $Completed = $false
        while ([DateTime]::UtcNow -lt $Deadline) {
            $Job.Get()
            $State = [uint16]$Job['JobState']
            if ($State -eq 7) { $Completed = $true; break }
            if ($State -in @(8,9,10)) { throw 'hyper-v-console-wmi-method-failed' }
            Start-Sleep -Milliseconds 100
        }
        if (-not $Completed) { throw 'hyper-v-console-wmi-job-timeout' }
        if ($null -ne $Job['ErrorCode'] -and [uint32]$Job['ErrorCode'] -ne 0) { throw 'hyper-v-console-wmi-method-failed' }
        return $Output
    }
    throw 'hyper-v-console-wmi-method-failed'
}

function Get-HyperVConsoleMouse([object]$Context) {
    $Devices = @(Get-HyperVConsoleAssociated $Context.Scope $Context.Vm 'Msvm_SyntheticMouse')
    if ($Devices.Count -ne 1) { throw 'hyper-v-console-wmi-device-ambiguous' }
    if ([uint16]$Devices[0]['EnabledState'] -ne 2 -or -not [bool]$Devices[0]['AbsoluteCoordinates']) {
        throw 'hyper-v-display-unavailable'
    }
    return $Devices[0]
}

function Get-HyperVConsoleKeyboard([object]$Context) {
    $Devices = @(Get-HyperVConsoleAssociated $Context.Scope $Context.Vm 'Msvm_Keyboard')
    if ($Devices.Count -ne 1) { throw 'hyper-v-console-wmi-device-ambiguous' }
    return $Devices[0]
}

try {
    $RawRequest = [string]$global:CccHyperVJsonInput
    if ([Text.Encoding]::UTF8.GetByteCount($RawRequest) -gt 65536) { throw "request-too-large" }
    $Request = $RawRequest | ConvertFrom-Json -ErrorAction Stop
    if ([int]$Request.schemaVersion -ne 1) { throw "request-schema-invalid" }
    $Operation = [string]$Request.operation
    if ($Operation -notin @(
        "Get-VM", "Get-VMDiagnostic", "Capture-VMConsole", "Send-VMConsoleInput", "Get-VMConsoleCursor", "Configure-VMGuestBoot", "Get-VMHardDiskDrive", "Get-VMDvdDrive", "Remove-VMDvdDrive", "Get-VHD", "Mount-VHD", "Dismount-VHD", "Convert-VHD", "Resize-VHD", "Get-VMSnapshot",
        "Start-VM", "Stop-VM", "Restart-VM", "Remove-VM", "Remove-HostFiles",
        "Checkpoint-VM", "Remove-VMSnapshot", "Restore-VMSnapshot", "Repair-VMSnapshotState",
        "Get-VMSwitch", "New-VMSwitch", "Set-VMSwitch", "Remove-VMSwitch",
        "New-VM", "Set-VM", "Set-VMMemory", "Set-VMProcessor",
        "Get-VMFirmware", "Get-VMBios", "Set-VMFirmware", "Set-VMBios",
        "Get-VMNetworkAdapter", "Add-VMNetworkAdapter", "Rename-VMNetworkAdapter",
        "Set-VMNetworkAdapter", "Remove-VMNetworkAdapter", "Get-NetAdapter",
        "Get-NetIPAddress", "New-NetIPAddress", "Remove-NetIPAddress", "Get-NetNeighbor",
        "Get-NetNat", "New-NetNat", "Remove-NetNat", "Invoke-Guest"
    )) {
        throw "operation-invalid"
    }
    # New-VM is deliberately absent: it creates the virtual machine, so there is no existing
    # record for a selector to resolve. Every other virtual-machine operation names one that
    # must already exist, and is refused here before any native call when it does not.
    $VmSelectorOperations = @(
        "Get-VMDiagnostic", "Capture-VMConsole", "Send-VMConsoleInput", "Get-VMConsoleCursor", "Configure-VMGuestBoot", "Get-VMHardDiskDrive", "Get-VMDvdDrive", "Remove-VMDvdDrive", "Get-VMSnapshot", "Start-VM", "Stop-VM", "Restart-VM",
        "Remove-VM", "Checkpoint-VM", "Remove-VMSnapshot", "Restore-VMSnapshot", "Repair-VMSnapshotState",
        "Set-VM", "Set-VMMemory", "Set-VMProcessor",
        "Get-VMFirmware", "Get-VMBios", "Set-VMFirmware", "Set-VMBios",
        "Add-VMNetworkAdapter", "Rename-VMNetworkAdapter", "Set-VMNetworkAdapter",
        "Remove-VMNetworkAdapter", "Invoke-Guest"
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
        "Get-VM", "Get-VMDiagnostic", "Capture-VMConsole", "Send-VMConsoleInput", "Get-VMConsoleCursor", "Configure-VMGuestBoot", "Get-VMHardDiskDrive", "Get-VMDvdDrive", "Remove-VMDvdDrive", "Get-VHD", "Mount-VHD", "Dismount-VHD", "Convert-VHD", "Resize-VHD", "Get-VMSnapshot", "Start-VM", "Stop-VM", "Restart-VM",
        "Remove-VM", "Checkpoint-VM", "Remove-VMSnapshot", "Restore-VMSnapshot", "Repair-VMSnapshotState",
        "Get-VMSwitch", "New-VMSwitch", "Set-VMSwitch", "Remove-VMSwitch", "Get-VMNetworkAdapter",
        "New-VM", "Set-VM", "Set-VMMemory", "Set-VMProcessor",
        "Get-VMFirmware", "Get-VMBios", "Set-VMFirmware", "Set-VMBios",
        "Add-VMNetworkAdapter", "Rename-VMNetworkAdapter", "Set-VMNetworkAdapter",
        "Remove-VMNetworkAdapter", "Invoke-Guest", "Remove-VMDvdDrive"
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
        "Capture-VMConsole" {
            $VirtualMachine = Assert-HyperVWindowsSingleVirtualMachine $VirtualMachines
            $Context = Get-HyperVConsoleContext $VirtualMachine $Request
            $SettingsQuery = [System.Management.ObjectQuery]::new("ASSOCIATORS OF {$($Context.Vm.Path.RelativePath)} WHERE AssocClass=Msvm_SettingsDefineState ResultClass=Msvm_VirtualSystemSettingData Role=ManagedElement ResultRole=SettingData")
            $SettingsSearcher = [System.Management.ManagementObjectSearcher]::new($Context.Scope, $SettingsQuery)
            $Settings = @($SettingsSearcher.Get() | Where-Object { [string]$_.VirtualSystemType -eq 'Microsoft:Hyper-V:System:Realized' })
            if ($Settings.Count -ne 1) { throw 'hyper-v-console-wmi-device-ambiguous' }
            $ServiceClass = [System.Management.ManagementClass]::new($Context.Scope,
                [System.Management.ManagementPath]::new('Msvm_VirtualSystemManagementService'), $null)
            $Services = @($ServiceClass.GetInstances())
            if ($Services.Count -ne 1) { throw 'hyper-v-console-wmi-unavailable' }
            $Output = Invoke-HyperVConsoleMethod $Services[0] 'GetVirtualSystemThumbnailImage' @{
                TargetSystem = $Settings[0].Path.Path; WidthPixels = [uint16]640; HeightPixels = [uint16]480
            }
            if ($null -eq $Output.Properties['ImageData'] -or $Output['ImageData'] -isnot [byte[]]) {
                throw 'hyper-v-console-capture-invalid'
            }
            [byte[]]$Raw = $Output['ImageData']
            if ($Raw.Length -ne (640 * 480 * 2) -and $Raw.Length -ne ((640 * 480 * 2) + 4)) {
                throw 'hyper-v-console-capture-invalid'
            }
            Add-Type -AssemblyName System.Drawing
            $Bitmap = [System.Drawing.Bitmap]::new(640, 480, [System.Drawing.Imaging.PixelFormat]::Format16bppRgb565)
            $BitmapData = $null
            $Stream = $null
            try {
                $Rectangle = [System.Drawing.Rectangle]::new(0, 0, 640, 480)
                $BitmapData = $Bitmap.LockBits($Rectangle, [System.Drawing.Imaging.ImageLockMode]::WriteOnly,
                    [System.Drawing.Imaging.PixelFormat]::Format16bppRgb565)
                if ([Math]::Abs([int]$BitmapData.Stride) -lt 1280) { throw 'hyper-v-console-capture-invalid' }
                for ($Row = 0; $Row -lt 480; $Row++) {
                    $Destination = [IntPtr]::Add($BitmapData.Scan0, $Row * [int]$BitmapData.Stride)
                    [Runtime.InteropServices.Marshal]::Copy($Raw, $Row * 1280, $Destination, 1280)
                }
                $Bitmap.UnlockBits($BitmapData)
                $BitmapData = $null
                $Stream = [IO.MemoryStream]::new()
                $Bitmap.Save($Stream, [System.Drawing.Imaging.ImageFormat]::Png)
                if ($Stream.Length -lt 33 -or $Stream.Length -gt (4 * 1024 * 1024)) { throw 'hyper-v-console-capture-too-large' }
                Write-HyperVWindowsSuccess $Operation @([ordered]@{
                    pngBase64 = [Convert]::ToBase64String($Stream.ToArray())
                    width = 640; height = 480; nativeWidth = $Context.Width; nativeHeight = $Context.Height
                })
            } finally {
                if ($null -ne $BitmapData) { $Bitmap.UnlockBits($BitmapData) }
                if ($null -ne $Stream) { $Stream.Dispose() }
                $Bitmap.Dispose()
            }
        }
        "Get-VMConsoleCursor" {
            $VirtualMachine = Assert-HyperVWindowsSingleVirtualMachine $VirtualMachines
            $Context = Get-HyperVConsoleContext $VirtualMachine $Request
            $Mouse = Get-HyperVConsoleMouse $Context
            $Mouse.Get()
            $NativeX = [long]$Mouse['HorizontalPosition']
            $NativeY = [long]$Mouse['VerticalPosition']
            if ($NativeX -lt 0 -or $NativeX -ge $Context.Width -or $NativeY -lt 0 -or $NativeY -ge $Context.Height) {
                throw 'hyper-v-console-geometry-invalid'
            }
            $X = if ($Context.Width -eq 1) { 0 } else { [int][Math]::Round($NativeX * 639.0 / ($Context.Width - 1)) }
            $Y = if ($Context.Height -eq 1) { 0 } else { [int][Math]::Round($NativeY * 479.0 / ($Context.Height - 1)) }
            Write-HyperVWindowsSuccess $Operation @([ordered]@{
                x = $X; y = $Y; width = 640; height = 480
                nativeWidth = $Context.Width; nativeHeight = $Context.Height
            })
        }
        "Send-VMConsoleInput" {
            $VirtualMachine = Assert-HyperVWindowsSingleVirtualMachine $VirtualMachines
            $Context = Get-HyperVConsoleContext $VirtualMachine $Request
            $Action = [string]$Request.action
            if ($Action -notin @('click', 'doubleClick', 'cursor', 'scroll', 'drag', 'key', 'type')) {
                throw 'hyper-v-console-input-invalid'
            }
            if ($Action -in @('click', 'doubleClick', 'cursor', 'scroll', 'drag')) {
                if ([long]$Request.width -ne 640 -or [long]$Request.height -ne 480 -or
                    [long]$Request.nativeWidth -ne $Context.Width -or [long]$Request.nativeHeight -ne $Context.Height) {
                    throw 'hyper-v-console-geometry-changed'
                }
                $X = [long]$Request.x
                $Y = [long]$Request.y
                if ($X -lt 0 -or $X -ge 640 -or $Y -lt 0 -or $Y -ge 480) { throw 'hyper-v-console-input-invalid' }
                if ($Action -eq 'scroll' -and [string]$Request.direction -in @('left', 'right')) {
                    throw 'hyper-v-console-scroll-unsupported'
                }
                if ($Action -eq 'drag') {
                    $X2 = [long]$Request.x2; $Y2 = [long]$Request.y2; $Duration = [long]$Request.durationMs
                    if ($X2 -lt 0 -or $X2 -ge 640 -or $Y2 -lt 0 -or $Y2 -ge 480 -or $Duration -lt 1 -or $Duration -gt 10000) { throw 'hyper-v-console-input-invalid' }
                }
                $Mouse = Get-HyperVConsoleMouse $Context
                $NativeX = if ($Context.Width -eq 1) { 0 } else { [int][Math]::Round($X * ($Context.Width - 1.0) / 639.0) }
                $NativeY = if ($Context.Height -eq 1) { 0 } else { [int][Math]::Round($Y * ($Context.Height - 1.0) / 479.0) }
                $null = Invoke-HyperVConsoleMethod $Mouse 'SetAbsolutePosition' @{
                    horizontalPosition = [int]$NativeX; verticalPosition = [int]$NativeY
                }
                if ($Action -in @('click', 'doubleClick')) {
                    if ([string]$Request.button -notin @('left', 'right')) { throw 'hyper-v-console-input-invalid' }
                    $ButtonIndex = if ([string]$Request.button -eq 'left') { 1 } else { 2 }
                    $Clicks = if ($Action -eq 'doubleClick') { 2 } else { 1 }
                    for ($Index = 0; $Index -lt $Clicks; $Index++) {
                        $null = Invoke-HyperVConsoleMethod $Mouse 'ClickButton' @{ buttonIndex = [uint32]$ButtonIndex }
                        if ($Index -eq 0 -and $Clicks -eq 2) { Start-Sleep -Milliseconds 80 }
                    }
                } elseif ($Action -eq 'drag') {
                    $DragFailure = $null
                    try {
                        $null = Invoke-HyperVConsoleMethod $Mouse 'SetButtonState' @{ buttonIndex = [uint32]1; isDown = $true }
                        $Steps = [int][Math]::Max(1, [Math]::Ceiling($Duration / 20.0))
                        for ($Step = 1; $Step -le $Steps; $Step++) {
                            Start-Sleep -Milliseconds ([int][Math]::Max(1, [Math]::Round($Duration / $Steps)))
                            $DragX = [int][Math]::Round(($X + ($X2 - $X) * $Step / $Steps) * ($Context.Width - 1.0) / 639.0)
                            $DragY = [int][Math]::Round(($Y + ($Y2 - $Y) * $Step / $Steps) * ($Context.Height - 1.0) / 479.0)
                            $null = Invoke-HyperVConsoleMethod $Mouse 'SetAbsolutePosition' @{ horizontalPosition = $DragX; verticalPosition = $DragY }
                        }
                    } catch { $DragFailure = $_; throw } finally {
                        try { $null = Invoke-HyperVConsoleMethod $Mouse 'SetButtonState' @{ buttonIndex = [uint32]1; isDown = $false } }
                        catch { if ($null -eq $DragFailure) { throw } }
                    }
                } elseif ($Action -eq 'scroll') {
                    $Direction = [string]$Request.direction
                    $Amount = [long]$Request.amount
                    if ($Direction -notin @('up', 'down') -or $Amount -lt 1 -or $Amount -gt 10) {
                        throw 'hyper-v-console-input-invalid'
                    }
                    $Delta = [int](120 * $Amount * $(if ($Direction -eq 'up') { 1 } else { -1 }))
                    $null = Invoke-HyperVConsoleMethod $Mouse 'SetScrollPosition' @{ scrollPositionDelta = $Delta }
                }
            } elseif ($Action -eq 'type') {
                $Text = [string]$Request.text
                if ($Text.Length -lt 1 -or $Text.Length -gt 2048 -or $Text.Contains([char]0)) {
                    throw 'hyper-v-console-text-invalid'
                }
                $Keyboard = Get-HyperVConsoleKeyboard $Context
                for ($Offset = 0; $Offset -lt $Text.Length;) {
                    $Count = [Math]::Min(128, $Text.Length - $Offset)
                    if ($Offset + $Count -lt $Text.Length -and [char]::IsHighSurrogate($Text[$Offset + $Count - 1])) { $Count-- }
                    $Chunk = $Text.Substring($Offset, $Count)
                    $null = Invoke-HyperVConsoleMethod $Keyboard 'TypeText' @{ asciiText = $Chunk }
                    $Offset += $Count
                }
            } else {
                $KeyCodes = @{
                    CTRL=17; ALT=18; SHIFT=16; WIN=91; ENTER=13; TAB=9; ESC=27; SPACE=32;
                    BACKSPACE=8; DELETE=46; INSERT=45; HOME=36; END=35; PAGEUP=33; PAGEDOWN=34;
                    UP=38; DOWN=40; LEFT=37; RIGHT=39
                }
                for ($Code = 65; $Code -le 90; $Code++) { $KeyCodes[[string][char]$Code] = $Code }
                for ($Code = 48; $Code -le 57; $Code++) { $KeyCodes[[string][char]$Code] = $Code }
                for ($Index = 1; $Index -le 12; $Index++) { $KeyCodes["F$Index"] = 111 + $Index }
                $Keys = @($Request.keys)
                if ($Keys.Count -lt 1 -or $Keys.Count -gt 4) { throw 'hyper-v-console-key-unsupported' }
                $Tokens = @($Keys | ForEach-Object { ([string]$_).ToUpperInvariant() })
                if ($Tokens.Count -ne (@($Tokens | Select-Object -Unique)).Count) { throw 'hyper-v-console-key-unsupported' }
                for ($Index = 0; $Index -lt $Tokens.Count; $Index++) {
                    if (-not $KeyCodes.ContainsKey($Tokens[$Index]) -or
                        ($Index -lt $Tokens.Count - 1 -and $Tokens[$Index] -notin @('CTRL', 'ALT', 'SHIFT', 'WIN')) -or
                        ($Index -eq $Tokens.Count - 1 -and $Tokens[$Index] -in @('CTRL', 'ALT', 'SHIFT', 'WIN'))) {
                        throw 'hyper-v-console-key-unsupported'
                    }
                }
                $Keyboard = Get-HyperVConsoleKeyboard $Context
                $Held = [System.Collections.Generic.List[int]]::new()
                try {
                    foreach ($Token in $Tokens) {
                        $Code = [int]$KeyCodes[$Token]
                        $Held.Add($Code)
                        $null = Invoke-HyperVConsoleMethod $Keyboard 'PressKey' @{ keyCode = [uint32]$Code }
                    }
                } finally {
                    $ReleaseFailed = $false
                    for ($Index = $Held.Count - 1; $Index -ge 0; $Index--) {
                        try { $null = Invoke-HyperVConsoleMethod $Keyboard 'ReleaseKey' @{ keyCode = [uint32]$Held[$Index] } }
                        catch { $ReleaseFailed = $true }
                    }
                    if ($ReleaseFailed) { throw 'hyper-v-console-wmi-method-failed' }
                }
            }
            Write-HyperVWindowsSuccess $Operation @()
        }
        "Invoke-Guest" {
            $VirtualMachine = Assert-HyperVWindowsSingleVirtualMachine $VirtualMachines
            if ([string]$Request.selector.kind -ne "id" -or
                [string]$VirtualMachine.Name -cne [string]$Request.expectedName -or
                [string]$VirtualMachine.Notes -cne [string]$Request.expectedNotes) {
                throw "guest-vm-identity-mismatch"
            }
            if ([string]$VirtualMachine.State -ne "Running") { throw "guest-requires-running-vm" }
            $CredentialPath = [string]$Request.credentialPath
            if ($CredentialPath -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+\\)' -or
                $CredentialPath -match '[\x00-\x1f*?]') { throw "guest-credential-path-invalid" }
            Assert-HyperVWindowsNoReparsePath $CredentialPath
            if (-not (Test-Path -LiteralPath $CredentialPath -PathType Leaf)) { throw "guest-credential-unavailable" }
            $Credential = Import-Clixml -LiteralPath $CredentialPath -ErrorAction Stop
            if ($Credential -isnot [System.Management.Automation.PSCredential]) { throw "guest-credential-invalid" }
            $Action = [string]$Request.action
            if ($Action -eq "job") {
                # A readiness attempt must reach Wait-Job before any synchronous New-PSSession:
                # an unavailable guest may otherwise monopolize the whole boot deadline.
                $JobSource = [string]$Request.command
                if ($JobSource.Length -lt 1 -or $JobSource.Length -gt 4096 -or $JobSource.Contains([char]0)) { throw "guest-command-invalid" }
                $GuestJob = $null
                try {
                    $GuestJob = Invoke-Command -VMId ([Guid]$Request.selector.id) -Credential $Credential -ArgumentList $JobSource -ScriptBlock {
                        param($Source)
                        & ([ScriptBlock]::Create($Source))
                    } -AsJob -ErrorAction Stop
                    $CompletedJob = Wait-Job -Job $GuestJob -Timeout 15 -ErrorAction Stop
                    if (-not $CompletedJob) { throw "powershell-direct-attempt-timeout" }
                    $JobOutput = @(Receive-Job -Job $GuestJob -ErrorAction Stop)
                    if ($JobOutput.Count -ne 1 -or $JobOutput[0] -isnot [string] -or
                        $JobOutput[0].Length -lt 1 -or $JobOutput[0].Length -gt 16384) { throw "guest-job-output-invalid" }
                    Write-HyperVWindowsSuccess $Operation @([ordered]@{ action = "job"; output = [string]$JobOutput[0] })
                } finally {
                    if ($GuestJob) { Remove-Job -Job $GuestJob -Force -ErrorAction SilentlyContinue }
                }
                break
            }
            $Session = $null
            try {
                $Session = New-PSSession -VMId ([Guid]$Request.selector.id) -Credential $Credential -ErrorAction Stop
                if ($Action -eq "exec") {
                    $GuestCommand = [string]$Request.command
                    if ($GuestCommand.Length -lt 1 -or $GuestCommand.Length -gt 4096 -or $GuestCommand.Contains([char]0)) { throw "guest-command-invalid" }
                    $EncodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($GuestCommand))
                    $GuestResult = Invoke-Command -Session $Session -ArgumentList $EncodedCommand -ScriptBlock {
                        param($Command)
                        $StdoutPath = [IO.Path]::GetTempFileName()
                        $StderrPath = [IO.Path]::GetTempFileName()
                        try {
                            $Process = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',$Command) -Wait -PassThru -RedirectStandardOutput $StdoutPath -RedirectStandardError $StderrPath
                            [ordered]@{ status = [int]$Process.ExitCode; stdout = [IO.File]::ReadAllText($StdoutPath); stderr = [IO.File]::ReadAllText($StderrPath) }
                        } finally {
                            Remove-Item -LiteralPath $StdoutPath,$StderrPath -Force -ErrorAction SilentlyContinue
                        }
                    } -ErrorAction Stop
                    if (([string]$GuestResult.stdout).Length -gt 16384 -or ([string]$GuestResult.stderr).Length -gt 16384) { throw "guest-output-too-large" }
                    Write-HyperVWindowsSuccess $Operation @([ordered]@{
                        action = "exec"; status = [int]$GuestResult.status
                        stdout = [string]$GuestResult.stdout; stderr = [string]$GuestResult.stderr
                    })
                } elseif ($Action -eq "mkdir") {
                    $RemotePath = [string]$Request.remotePath
                    if ($RemotePath -notmatch '^[A-Za-z]:\\' -or $RemotePath.Length -gt 4096 -or $RemotePath.Contains([char]0)) { throw "guest-path-invalid" }
                    Invoke-Command -Session $Session -ArgumentList $RemotePath -ScriptBlock {
                        param($Path)
                        if ($Path) { New-Item -ItemType Directory -Path $Path -Force | Out-Null }
                    } -ErrorAction Stop | Out-Null
                    Write-HyperVWindowsSuccess $Operation @([ordered]@{ action = "mkdir" })
                } elseif ($Action -eq "upload") {
                    $LocalPath = [string]$Request.localPath
                    $RemotePath = [string]$Request.remotePath
                    if ($RemotePath -notmatch '^[A-Za-z]:\\' -or $RemotePath.Length -gt 4096 -or $RemotePath.Contains([char]0)) { throw "guest-path-invalid" }
                    Assert-HyperVWindowsNoReparsePath $LocalPath
                    if (-not (Test-Path -LiteralPath $LocalPath -PathType Leaf)) { throw "guest-upload-source-missing" }
                    Copy-Item -LiteralPath $LocalPath -Destination $RemotePath -ToSession $Session -Force -ErrorAction Stop
                    $Bytes = (Get-Item -LiteralPath $LocalPath -ErrorAction Stop).Length
                    Write-HyperVWindowsSuccess $Operation @([ordered]@{
                        action = "upload"; localPath = $LocalPath; remotePath = $RemotePath; bytes = [long]$Bytes
                    })
                } elseif ($Action -eq "download") {
                    $LocalPath = [string]$Request.localPath
                    $RemotePath = [string]$Request.remotePath
                    $Limit = [long]$Request.maxBytes
                    if ($RemotePath -notmatch '^[A-Za-z]:\\' -or $RemotePath.Length -gt 4096 -or $RemotePath.Contains([char]0) -or
                        $Limit -lt 1 -or $Limit -gt 16777216) { throw "guest-download-options-invalid" }
                    Assert-HyperVWindowsNoReparsePath $LocalPath
                    if (Test-Path -LiteralPath $LocalPath) { throw "guest-download-destination-exists" }
                    $Encoded = Invoke-Command -Session $Session -ArgumentList $RemotePath,$Limit -ScriptBlock {
                        param($Path,$Maximum)
                        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'guest-download-source-missing' }
                        $Stream = [IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
                        try {
                            if ($Stream.Length -gt $Maximum) { throw 'guest-download-source-too-large' }
                            $Buffer = New-Object byte[] ([int]$Stream.Length)
                            $Offset = 0
                            while ($Offset -lt $Buffer.Length) {
                                $Read = $Stream.Read($Buffer,$Offset,$Buffer.Length-$Offset)
                                if ($Read -le 0) { throw 'guest-download-source-changed' }
                                $Offset += $Read
                            }
                            if ($Stream.ReadByte() -ge 0) { throw 'guest-download-source-changed' }
                            [Convert]::ToBase64String($Buffer)
                        } finally { $Stream.Dispose() }
                    } -ErrorAction Stop
                    $Payload = [Convert]::FromBase64String([string]$Encoded)
                    if ($Payload.Length -gt $Limit) { throw "guest-download-source-too-large" }
                    $Output = [IO.File]::Open($LocalPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
                    try { $Output.Write($Payload,0,$Payload.Length); $Output.Flush() } finally { $Output.Dispose() }
                    Write-HyperVWindowsSuccess $Operation @([ordered]@{
                        action = "download"; localPath = $LocalPath; remotePath = $RemotePath; bytes = [long]$Payload.Length
                    })
                } else { throw "guest-action-invalid" }
            } finally {
                if ($Session) { Remove-PSSession -Session $Session -ErrorAction SilentlyContinue }
            }
        }
        "Get-VM" {
            if ($GetVmByNames) {
                $RequestedNames = @($Request.names | ForEach-Object { [string]$_ })
                $Items = @(Get-HyperVWindowsVirtualMachinesByExactNames $RequestedNames | ForEach-Object {
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
        "Get-VMDiagnostic" {
            $VirtualMachine = Assert-HyperVWindowsSingleVirtualMachine $VirtualMachines
            if ([string]$Request.selector.kind -cne "id" -or
                [string]$Request.expectedName -cne [string]$VirtualMachine.Name -or
                [string]$Request.expectedNotes -cne [string]$VirtualMachine.Notes -or
                [string]::IsNullOrEmpty([string]$Request.expectedName) -or
                [string]::IsNullOrEmpty([string]$Request.expectedNotes)) {
                throw "diagnostic-vm-identity-mismatch"
            }
            $Diagnostic = Get-HyperVWindowsGuestBootDiagnosticResult -Vm $VirtualMachine
            Write-HyperVWindowsSuccess $Operation @($Diagnostic)
        }
        "Configure-VMGuestBoot" {
            $GuestBootStage = "preflight"
            $GuestBootMayHaveAttached = $false
            try {
                $GuestKind = if ($Request.PSObject.Properties.Name -contains "guestKind") { [string]$Request.guestKind } else { "windows" }
                if ($GuestKind -cnotin @("windows", "linux")) { throw "hyper-v-guest-provision-boot-settings-invalid" }
                if ($GuestKind -ceq "linux") {
                    foreach ($ExpectedBootstrapName in @($Request.expectedBootstrapAdapterName, $Request.expectedBootstrapSwitchName)) {
                        if ($ExpectedBootstrapName -isnot [string] -or
                            $ExpectedBootstrapName.Length -eq 0 -or $ExpectedBootstrapName.Length -gt 100 -or
                            $ExpectedBootstrapName -match '[\x00-\x1f*?\[\]]') {
                            throw "hyper-v-guest-provision-boot-settings-invalid"
                        }
                    }
                    $ExpectedBootstrapAdapterName = [string]$Request.expectedBootstrapAdapterName
                    $ExpectedBootstrapSwitchName = [string]$Request.expectedBootstrapSwitchName
                    if ($Request.expectedBootstrapMacAddress -isnot [string]) {
                        throw "hyper-v-guest-provision-boot-settings-invalid"
                    }
                    $ExpectedBootstrapMac = [string]$Request.expectedBootstrapMacAddress
                    if ($ExpectedBootstrapMac -cnotmatch '^(?:[0-9A-Fa-f]{12}|(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}|(?:[0-9A-Fa-f]{2}-){5}[0-9A-Fa-f]{2})\z') {
                        throw "hyper-v-guest-provision-boot-settings-invalid"
                    }
                    $ExpectedBootstrapMac = ($ExpectedBootstrapMac -replace '[:-]', '').ToUpperInvariant()
                    if ($ExpectedBootstrapMac -ceq "000000000000") {
                        throw "hyper-v-guest-provision-boot-settings-invalid"
                    }
                } elseif ($Request.PSObject.Properties.Name -contains "expectedBootstrapAdapterName" -or
                    $Request.PSObject.Properties.Name -contains "expectedBootstrapSwitchName" -or
                    $Request.PSObject.Properties.Name -contains "expectedBootstrapMacAddress") {
                    throw "hyper-v-guest-provision-boot-settings-invalid"
                }
                $VirtualMachine = Assert-HyperVWindowsSingleVirtualMachine $VirtualMachines
                if ([string]$Request.selector.kind -cne "id" -or
                    [string]$VirtualMachine.Name -cne [string]$Request.expectedName -or
                    [string]$VirtualMachine.Notes -cne [string]$Request.expectedNotes -or
                    [string]::IsNullOrEmpty([string]$Request.expectedName) -or
                    [string]::IsNullOrEmpty([string]$Request.expectedNotes)) {
                    throw "hyper-v-guest-provision-vm-identity-mismatch"
                }
                if ([string]$VirtualMachine.State -ne "Off") { throw "hyper-v-guest-provision-requires-stopped-vm" }
                $BootSettings = $Request.bootSettings
                $Generation = [int]$BootSettings.generation
                if ($Generation -notin @(1, 2) -or [int]$VirtualMachine.Generation -ne $Generation) {
                    throw "hyper-v-guest-provision-generation-mismatch"
                }
                $OsDiskPath = [string]$Request.osDiskPath
                $MediaPath = [string]$Request.mediaPath
                foreach ($Path in @($OsDiskPath, $MediaPath)) {
                    if ($Path -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+\\)' -or
                        $Path -match '[\x00-\x1f*?\[\]]') { throw "hyper-v-guest-provision-path-invalid" }
                    Assert-HyperVWindowsNoReparsePath $Path
                }
                if (-not (Test-Path -LiteralPath $MediaPath -PathType Leaf)) {
                    throw "hyper-v-guest-provision-media-unavailable"
                }
                $Disks = @(Hyper-V\Get-VMHardDiskDrive -VM $VirtualMachine -ErrorAction Stop)
                if ($Disks.Count -ne 1 -or [string]$Disks[0].Path -ine $OsDiskPath) {
                    throw "hyper-v-guest-disk-attachment-mismatch"
                }
                $ExistingMedia = @(Hyper-V\Get-VMDvdDrive -VM $VirtualMachine -ErrorAction Stop | Where-Object {
                    [string]$_.Path -ieq $MediaPath
                })
                if ($ExistingMedia.Count -ne 0) { throw "hyper-v-guest-provisioning-media-already-attached" }
                if ($Generation -eq 2) {
                    if ($GuestKind -ceq "linux") {
                        if ($BootSettings.secureBoot.enabled -isnot [bool] -or [bool]$BootSettings.secureBoot.enabled -or
                            $BootSettings.secureBoot.PSObject.Properties.Name -contains "template") {
                            throw "hyper-v-guest-provision-boot-settings-invalid"
                        }
                    } else {
                        if ($BootSettings.secureBoot.enabled -isnot [bool] -or -not [bool]$BootSettings.secureBoot.enabled -or
                            [string]::IsNullOrEmpty([string]$BootSettings.secureBoot.template) -or
                            [string]$BootSettings.secureBoot.template -match '[\x00-\x1f*?\[\]]') {
                            throw "hyper-v-guest-provision-boot-settings-invalid"
                        }
                    }
                } else {
                    $StartupOrder = @(@($BootSettings.startupOrder) | ForEach-Object { [string]$_ })
                    if ($StartupOrder.Count -lt 1 -or $StartupOrder.Count -gt 4 -or
                        @($StartupOrder | Sort-Object -Unique).Count -ne $StartupOrder.Count) {
                        throw "hyper-v-guest-provision-boot-settings-invalid"
                    }
                    foreach ($Device in $StartupOrder) {
                        if ($Device -cnotin @("IDE", "CD", "LegacyNetworkAdapter", "Floppy")) {
                            throw "hyper-v-guest-provision-boot-settings-invalid"
                        }
                    }
                    if ($GuestKind -ceq "linux" -and $StartupOrder[0] -cne "IDE") {
                        throw "hyper-v-guest-provision-boot-settings-invalid"
                    }
                }

                if ($GuestKind -ceq "linux") {
                    # Re-resolve identity and attachments at the mutation boundary; media
                    # generation can have taken long enough for the earlier view to drift.
                    $CurrentVirtualMachines = @(Get-HyperVWindowsVirtualMachines $Request.selector)
                    if ($CurrentVirtualMachines.Count -ne 1 -or
                        [Guid]$CurrentVirtualMachines[0].Id -ne [Guid][string]$Request.selector.id -or
                        [string]$CurrentVirtualMachines[0].Name -cne [string]$Request.expectedName -or
                        [string]$CurrentVirtualMachines[0].Notes -cne [string]$Request.expectedNotes) {
                        throw "hyper-v-guest-provision-vm-identity-mismatch"
                    }
                    $VirtualMachine = $CurrentVirtualMachines[0]
                    if ([string]$VirtualMachine.State -ne "Off") { throw "hyper-v-guest-provision-requires-stopped-vm" }
                    if ([int]$VirtualMachine.Generation -ne $Generation) { throw "hyper-v-guest-provision-generation-mismatch" }
                    $Disks = @(Hyper-V\Get-VMHardDiskDrive -VM $VirtualMachine -ErrorAction Stop)
                    if ($Disks.Count -ne 1 -or [string]$Disks[0].Path -ine $OsDiskPath) {
                        throw "hyper-v-guest-disk-attachment-mismatch"
                    }
                    # Gen1 BIOS orders device classes, not a particular VHD. IDE-first only
                    # proves this OS disk boots first when the sole disk is on IDE.
                    if ($Generation -eq 1 -and [string]$Disks[0].ControllerType -ine "IDE") {
                        throw "hyper-v-guest-disk-attachment-mismatch"
                    }
                    $ExistingMedia = @(Hyper-V\Get-VMDvdDrive -VM $VirtualMachine -ErrorAction Stop | Where-Object {
                        -not [string]::IsNullOrEmpty([string]$_.Path)
                    })
                    if ($ExistingMedia.Count -ne 0) { throw "hyper-v-guest-provisioning-media-already-attached" }
                    $BootstrapAdapters = @(Hyper-V\Get-VMNetworkAdapter -VM $VirtualMachine -ErrorAction Stop | Where-Object {
                        [string]$_.Name -ceq $ExpectedBootstrapAdapterName
                    })
                    if ($BootstrapAdapters.Count -ne 1 -or
                        [string]$BootstrapAdapters[0].SwitchName -cne $ExpectedBootstrapSwitchName) {
                        throw "hyper-v-guest-bootstrap-adapter-invalid"
                    }
                    $BootstrapMac = ([string]$BootstrapAdapters[0].MacAddress -replace '[:-]', '').ToUpperInvariant()
                    if ($BootstrapMac -cne $ExpectedBootstrapMac) {
                        throw "hyper-v-guest-bootstrap-mac-identity-mismatch"
                    }
                    $HostBootstrapMacMatches = @(Hyper-V\Get-VMNetworkAdapter -All -ErrorAction Stop | Where-Object {
                        (([string]$_.MacAddress -replace '[:-]', '').ToUpperInvariant()) -ceq $ExpectedBootstrapMac
                    })
                    if ($HostBootstrapMacMatches.Count -ne 1 -or
                        [Guid]$HostBootstrapMacMatches[0].VMId -ne [Guid]$VirtualMachine.Id -or
                        [string]$HostBootstrapMacMatches[0].VMName -cne [string]$VirtualMachine.Name -or
                        [string]$HostBootstrapMacMatches[0].Name -cne $ExpectedBootstrapAdapterName -or
                        [string]$HostBootstrapMacMatches[0].SwitchName -cne $ExpectedBootstrapSwitchName) {
                        throw "hyper-v-guest-bootstrap-mac-identity-mismatch"
                    }
                }

                $GuestBootStage = "media-attach"
                # A native attach may mutate and then throw. Linux defers cleanup to the
                # broker's owner-scoped VM rollback: path or controller-slot equality alone
                # cannot prove a later DVD is still the attachment created here.
                $GuestBootMayHaveAttached = $true
                Hyper-V\Add-VMDvdDrive -VM $VirtualMachine -Path $MediaPath -ErrorAction Stop | Out-Null
                $AttachedMedia = @(Hyper-V\Get-VMDvdDrive -VM $VirtualMachine -ErrorAction Stop | Where-Object {
                    [string]$_.Path -ieq $MediaPath
                })
                if ($AttachedMedia.Count -ne 1) { throw "hyper-v-guest-provisioning-media-attach-failed" }

                $GuestBootStage = "boot-settings"
                if ($Generation -eq 2) {
                    if ($GuestKind -ceq "linux") {
                        Hyper-V\Set-VMFirmware -VM $VirtualMachine -EnableSecureBoot Off -FirstBootDevice $Disks[0] -ErrorAction Stop
                    } else {
                        Hyper-V\Set-VMFirmware -VM $VirtualMachine -EnableSecureBoot On -SecureBootTemplate ([string]$BootSettings.secureBoot.template) -FirstBootDevice $Disks[0] -ErrorAction Stop
                    }
                    $Firmware = Hyper-V\Get-VMFirmware -VM $VirtualMachine -ErrorAction Stop
                    $FirstBootPath = if (@($Firmware.BootOrder).Count -gt 0) { [string]$Firmware.BootOrder[0].Device.Path } else { "" }
                    if ($GuestKind -ceq "linux") {
                        if ([string]$Firmware.SecureBoot -cne "Off" -or $FirstBootPath -ine $OsDiskPath) {
                            throw "hyper-v-guest-secure-boot-not-disabled"
                        }
                    } else {
                        if ([string]$Firmware.SecureBoot -cne "On" -or
                            [string]$Firmware.SecureBootTemplate -cne [string]$BootSettings.secureBoot.template -or
                            $FirstBootPath -ine $OsDiskPath) {
                            throw "hyper-v-guest-secure-boot-not-enabled"
                        }
                    }
                } else {
                    Hyper-V\Set-VMBios -VM $VirtualMachine -StartupOrder $StartupOrder -ErrorAction Stop
                    $Bios = Hyper-V\Get-VMBios -VM $VirtualMachine -ErrorAction Stop
                    $ActualStartupOrder = @($Bios.StartupOrder | ForEach-Object { [string]$_ })
                    if (($ActualStartupOrder -join "|") -cne ($StartupOrder -join "|")) {
                        throw "hyper-v-guest-provision-bios-order-mismatch"
                    }
                }

                if ($GuestKind -ceq "windows") {
                    $GuestBootStage = "integration-services"
                    $DisabledServices = @(Hyper-V\Get-VMIntegrationService -VM $VirtualMachine -ErrorAction Stop | Where-Object { -not $_.Enabled })
                    foreach ($Service in $DisabledServices) {
                        $Service | Hyper-V\Enable-VMIntegrationService -ErrorAction Stop
                    }
                    $StillDisabled = @(Hyper-V\Get-VMIntegrationService -VM $VirtualMachine -ErrorAction Stop | Where-Object { -not $_.Enabled })
                    if ($StillDisabled.Count -ne 0) { throw "hyper-v-guest-integration-services-not-enabled" }
                }
                $FinalMedia = @(Hyper-V\Get-VMDvdDrive -VM $VirtualMachine -ErrorAction Stop | Where-Object {
                    [string]$_.Path -ieq $MediaPath
                })
                if ($FinalMedia.Count -ne 1) { throw "hyper-v-guest-provisioning-media-attach-failed" }
                $FinalVirtualMachines = @(Get-HyperVWindowsVirtualMachines $Request.selector)
                if ($FinalVirtualMachines.Count -ne 1 -or
                    [string]$FinalVirtualMachines[0].Name -cne [string]$Request.expectedName -or
                    [string]$FinalVirtualMachines[0].Notes -cne [string]$Request.expectedNotes -or
                    [string]$FinalVirtualMachines[0].State -ne "Off") {
                    throw "hyper-v-guest-provision-vm-state-changed"
                }
                $GuestBootMayHaveAttached = $false
                Write-HyperVWindowsSuccess $Operation @()
            } catch {
                $FailureCode = [string]$_.Exception.Message
                if ($FailureCode -cnotin $GuestBootFixedErrorCodes) {
                    $FailureCode = switch ($GuestBootStage) {
                        "media-attach" { "hyper-v-guest-provisioning-media-attach-failed" }
                        "boot-settings" { "hyper-v-guest-provision-boot-settings-command-failed" }
                        "integration-services" { "hyper-v-guest-integration-services-not-enabled" }
                        default { "hyper-v-guest-provision-preflight-command-failed" }
                    }
                }
                if ($GuestBootMayHaveAttached -and $GuestKind -cne "linux") {
                    try {
                        $CleanupVirtualMachines = @(Get-HyperVWindowsVirtualMachines $Request.selector)
                        if ($CleanupVirtualMachines.Count -ne 1 -or
                            ([Guid]$CleanupVirtualMachines[0].Id).ToString("D").ToLowerInvariant() -cne [string]$Request.selector.id -or
                            [string]$CleanupVirtualMachines[0].Name -cne [string]$Request.expectedName -or
                            [string]$CleanupVirtualMachines[0].Notes -cne [string]$Request.expectedNotes -or
                            [string]$CleanupVirtualMachines[0].State -ne "Off") {
                            throw "cleanup-vm-identity-changed"
                        }
                        $CleanupVirtualMachine = $CleanupVirtualMachines[0]
                        $CleanupAttachments = @(Hyper-V\Get-VMDvdDrive -VM $CleanupVirtualMachine -ErrorAction Stop | Where-Object {
                            [string]$_.Path -ieq $MediaPath
                        })
                        if ($CleanupAttachments.Count -gt 1) { throw "cleanup-ambiguous" }
                        if ($CleanupAttachments.Count -eq 1) {
                            Hyper-V\Remove-VMDvdDrive -VMDvdDrive $CleanupAttachments[0] -ErrorAction Stop
                        }
                        $RemainingMedia = @(Hyper-V\Get-VMDvdDrive -VM $CleanupVirtualMachine -ErrorAction Stop | Where-Object {
                            [string]$_.Path -ieq $MediaPath
                        })
                        if ($RemainingMedia.Count -ne 0) { throw "cleanup-incomplete" }
                    } catch { throw "hyper-v-guest-provision-media-cleanup-failed" }
                }
                throw $FailureCode
            }
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
        "Remove-VMDvdDrive" {
            $VirtualMachine = Assert-HyperVWindowsSingleVirtualMachine $VirtualMachines
            if ([string]$Request.selector.kind -ne "id" -or
                [string]$VirtualMachine.Name -cne [string]$Request.expectedName -or
                [string]$VirtualMachine.Notes -cne [string]$Request.expectedNotes) {
                throw "dvd-vm-identity-mismatch"
            }
            $ExpectedPath = [string]$Request.path
            if ($ExpectedPath -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+\\)' -or
                $ExpectedPath -match '[\x00-\x1f*?]') { throw "dvd-path-invalid" }
            $Attached = @(Hyper-V\Get-VMDvdDrive -VM $VirtualMachine -ErrorAction Stop | Where-Object {
                [string]$_.Path -ieq $ExpectedPath
            })
            if ($Attached.Count -gt 1) { throw "dvd-attachment-ambiguous" }
            if ($Attached.Count -eq 1) {
                Hyper-V\Remove-VMDvdDrive -VMDvdDrive $Attached[0] -ErrorAction Stop
            }
            $Remaining = @(Hyper-V\Get-VMDvdDrive -VM $VirtualMachine -ErrorAction Stop | Where-Object {
                [string]$_.Path -ieq $ExpectedPath
            })
            if ($Remaining.Count -ne 0) { throw "dvd-still-attached" }
            Write-HyperVWindowsSuccess $Operation @()
        }
        "Get-VHD" {
            $VhdPath = [string]$Request.path
            if ([string]::IsNullOrWhiteSpace($VhdPath) -or -not [IO.Path]::IsPathRooted($VhdPath)) { throw "vhd-path-invalid" }
            Assert-HyperVWindowsNoReparsePath $VhdPath
            if (-not (Test-Path -LiteralPath $VhdPath -PathType Leaf)) { throw "vhd-not-found" }
            try {
                $Vhds = @(Hyper-V\Get-VHD -Path $VhdPath -ErrorAction Stop)
            } catch {
                # Keep metadata-read failure distinct from path-safety and response-shape failures.
                # Only this fixed code (and a missing leaf) permits status's legacy path fallback.
                throw "vhd-metadata-read-failed"
            }
            if ($Vhds.Count -ne 1) { throw "vhd-result-ambiguous" }
            $Vhd = $Vhds[0]
            Assert-HyperVWindowsNoReparsePath $VhdPath
            $VhdItem = [ordered]@{
                path = [string]$Vhd.Path
                vhdFormat = [string]$Vhd.VhdFormat
                vhdType = [string]$Vhd.VhdType
                parentPath = if ([string]::IsNullOrEmpty([string]$Vhd.ParentPath)) { $null } else { [string]$Vhd.ParentPath }
                virtualSizeBytes = [long]$Vhd.Size
                fileSizeBytes = [long]$Vhd.FileSize
            }
            Write-HyperVWindowsSuccess $Operation @($VhdItem)
        }
        "Mount-VHD" {
            Assert-HyperVWindowsVhdMutationPath $Request.path
            if ($Request.readOnly -isnot [bool] -or $Request.noDriveLetter -isnot [bool]) {
                throw "vhd-flags-invalid"
            }
            $VhdPath = [string]$Request.path
            $ReadOnly = [bool]$Request.readOnly
            $NoDriveLetter = [bool]$Request.noDriveLetter
            try {
                Hyper-V\Mount-VHD -Path $VhdPath -ReadOnly:$ReadOnly -NoDriveLetter:$NoDriveLetter -ErrorAction Stop | Out-Null
            } finally {
                Assert-HyperVWindowsNoReparsePath $VhdPath
            }
            Write-HyperVWindowsSuccess $Operation @()
        }
        "Dismount-VHD" {
            Assert-HyperVWindowsVhdMutationPath $Request.path
            $VhdPath = [string]$Request.path
            try {
                Hyper-V\Dismount-VHD -Path $VhdPath -ErrorAction Stop | Out-Null
            } finally {
                Assert-HyperVWindowsNoReparsePath $VhdPath
            }
            Write-HyperVWindowsSuccess $Operation @()
        }
        "Convert-VHD" {
            Assert-HyperVWindowsVhdMutationPath $Request.sourcePath
            Assert-HyperVWindowsVhdDestinationPath $Request.destinationPath
            $SourcePath = [string]$Request.sourcePath
            $DestinationPath = [string]$Request.destinationPath
            if ([string]::Equals([IO.Path]::GetFullPath($SourcePath), [IO.Path]::GetFullPath($DestinationPath), [StringComparison]::OrdinalIgnoreCase)) {
                throw "vhd-path-conflict"
            }
            $VhdType = [string]$Request.vhdType
            if ($VhdType -cnotin @("Dynamic", "Fixed")) { throw "vhd-type-invalid" }
            try {
                Hyper-V\Convert-VHD -Path $SourcePath -DestinationPath $DestinationPath -VHDType $VhdType -ErrorAction Stop | Out-Null
            } finally {
                Assert-HyperVWindowsNoReparsePath $SourcePath
                Assert-HyperVWindowsNoReparsePath $DestinationPath
            }
            Write-HyperVWindowsSuccess $Operation @()
        }
        "Resize-VHD" {
            Assert-HyperVWindowsVhdMutationPath $Request.path
            $RawSize = $Request.sizeBytes
            if (($RawSize -isnot [int] -and $RawSize -isnot [long]) -or
                $RawSize -le 0 -or $RawSize -gt 9007199254740991) { throw "vhd-size-invalid" }
            $VhdPath = [string]$Request.path
            try {
                Hyper-V\Resize-VHD -Path $VhdPath -SizeBytes ([long]$RawSize) -ErrorAction Stop | Out-Null
            } finally {
                Assert-HyperVWindowsNoReparsePath $VhdPath
            }
            Write-HyperVWindowsSuccess $Operation @()
        }
        "Start-VM" {
            $VirtualMachine = Assert-HyperVWindowsSingleVirtualMachine $VirtualMachines
            $VirtualMachine = Assert-HyperVWindowsPowerIdentity $VirtualMachine $Request
            Hyper-V\Start-VM -VM $VirtualMachine -ErrorAction Stop | Out-Null
            Write-HyperVWindowsSuccess $Operation @()
        }
        "Stop-VM" {
            $VirtualMachine = Assert-HyperVWindowsSingleVirtualMachine $VirtualMachines
            $VirtualMachine = Assert-HyperVWindowsPowerIdentity $VirtualMachine $Request
            if ([string]$Request.mode -eq "turn-off") {
                Hyper-V\Stop-VM -VM $VirtualMachine -TurnOff -Force:([bool]$Request.force) -ErrorAction Stop | Out-Null
            } elseif ([string]$Request.mode -eq "shutdown") {
                Hyper-V\Stop-VM -VM $VirtualMachine -Force:([bool]$Request.force) -ErrorAction Stop | Out-Null
            } else {
                throw "stop-mode-invalid"
            }
            Write-HyperVWindowsSuccess $Operation @()
        }
        "Restart-VM" {
            $VirtualMachine = Assert-HyperVWindowsSingleVirtualMachine $VirtualMachines
            $VirtualMachine = Assert-HyperVWindowsPowerIdentity $VirtualMachine $Request
            # Restart-VM always performs a hard restart; Force suppresses its separate confirmation.
            Hyper-V\Restart-VM -VM $VirtualMachine -Force -Confirm:$false -ErrorAction Stop | Out-Null
            Write-HyperVWindowsSuccess $Operation @()
        }
        "Remove-VM" {
            $VirtualMachine = Assert-HyperVWindowsSingleVirtualMachine $VirtualMachines
            if ($Request.PSObject.Properties.Name -contains "guard") {
                $VirtualMachine = Assert-HyperVWindowsRemoveGuard $Request
                if ([string]$VirtualMachine.State -cne "Off") {
                    Hyper-V\Stop-VM -VM $VirtualMachine -TurnOff -Force -ErrorAction Stop | Out-Null
                    $VirtualMachine = Assert-HyperVWindowsRemoveGuard $Request
                }
                if ([string]$VirtualMachine.State -cne "Off") { throw "vm-remove-state-mismatch" }
            }
            Hyper-V\Remove-VM -VM $VirtualMachine -Force:([bool]$Request.force) -ErrorAction Stop
            Write-HyperVWindowsSuccess $Operation @()
        }
        "Remove-HostFiles" {
            $Root = ConvertTo-HyperVWindowsOwnedPath $Request.rootDirectory
            if ($Request.paths -isnot [array] -or $Request.paths.Count -gt 128) {
                throw "host-files-request-invalid"
            }
            $Paths = @($Request.paths | ForEach-Object { ConvertTo-HyperVWindowsOwnedPath $_ })
            if (@($Paths | Sort-Object -Unique).Count -ne $Paths.Count) { throw "host-files-request-invalid" }
            $HasCheckpointDir = $Request.PSObject.Properties.Name -contains "checkpointDiskDirectory"
            $CheckpointDir = if ($HasCheckpointDir) {
                ConvertTo-HyperVWindowsOwnedPath $Request.checkpointDiskDirectory
            } else { $null }
            if ($HasCheckpointDir -and -not (Test-HyperVWindowsOwnedChild $Root $CheckpointDir)) {
                throw "host-file-path-invalid"
            }
            # Validate the whole fixed set before deleting any item. A reparse point encountered
            # during enumeration or a retry also fails the operation before that item is removed.
            foreach ($Path in $Paths) { [void](Assert-HyperVWindowsOwnedFilePath $Path $Root) }
            if ($HasCheckpointDir) {
                Assert-HyperVWindowsOwnedPathComponents $CheckpointDir $Root
                if (Test-Path -LiteralPath $CheckpointDir -ErrorAction Stop) {
                    $Directory = Get-Item -LiteralPath $CheckpointDir -Force -ErrorAction Stop
                    if (-not $Directory.PSIsContainer) { throw "host-file-not-regular" }
                    $CheckpointFiles = @(Get-ChildItem -LiteralPath $CheckpointDir -Filter "*.avhdx" -File -Force -ErrorAction Stop)
                    $Paths += @($CheckpointFiles | ForEach-Object { ConvertTo-HyperVWindowsOwnedPath $_.FullName })
                }
            }
            foreach ($Path in $Paths) { [void](Assert-HyperVWindowsOwnedFilePath $Path $Root) }
            $RemovedCount = 0
            foreach ($Path in @($Paths | Sort-Object -Unique)) {
                for ($Attempt = 1; $Attempt -le 5; $Attempt++) {
                    if (-not (Assert-HyperVWindowsOwnedFilePath $Path $Root)) { break }
                    try {
                        Microsoft.PowerShell.Management\Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
                        $RemovedCount++
                        break
                    } catch {
                        if ($Attempt -ge 5) { throw "host-file-remove-failed" }
                        Start-Sleep -Milliseconds 250
                    }
                }
            }
            Write-HyperVWindowsSuccess $Operation @([ordered]@{ removedCount = $RemovedCount })
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
        "Repair-VMSnapshotState" {
            $RequestKeys = @($Request.PSObject.Properties.Name)
            $ExpectedKeys = @("schemaVersion", "operation", "selector", "expectedName", "expectedNotes", "snapshotName", "expectedCheckpointPolicy")
            $MissingKeys = @($ExpectedKeys | Where-Object { $RequestKeys -cnotcontains $_ })
            $SelectorKeys = @($Request.selector.PSObject.Properties.Name)
            if ([string]$Request.selector.kind -cne "id" -or
                $SelectorKeys.Count -ne 2 -or
                $SelectorKeys -cnotcontains "kind" -or
                $SelectorKeys -cnotcontains "id" -or
                $Request.selector.id -isnot [string] -or
                [string]$Request.selector.id -notmatch '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\z' -or
                $RequestKeys.Count -ne $ExpectedKeys.Count -or
                $MissingKeys.Count -ne 0 -or
                $Request.expectedName -isnot [string] -or
                $Request.expectedNotes -isnot [string] -or
                $Request.snapshotName -isnot [string] -or
                [string]$Request.expectedName -notmatch '^[^\x00-\x1f*?\[\]]{1,100}\z' -or
                [string]$Request.expectedNotes -notmatch '^[^\x00-\x1f]{1,4096}\z') {
                throw "repair-request-invalid"
            }
            $SnapshotName = [string]$Request.snapshotName
            if ($SnapshotName -notmatch '^[^\x00-\x1f*?\[\]]{1,256}\z') { throw "snapshot-name-invalid" }
            $ExpectedPolicy = [string]$Request.expectedCheckpointPolicy
            if ($ExpectedPolicy -cnotin @("Production", "ProductionOnly")) { throw "snapshot-policy-invalid" }

            $VirtualMachine = Assert-HyperVWindowsSnapshotRepairIdentity $Request
            if ([string]$VirtualMachine.CheckpointType -ceq "Disabled") {
                throw "hyper-v-snapshot-policy-quarantined"
            }
            if ([string]$VirtualMachine.CheckpointType -cne $ExpectedPolicy) {
                $VirtualMachine = Assert-HyperVWindowsSnapshotRepairIdentity $Request
                if ([string]$VirtualMachine.CheckpointType -ceq "Disabled") {
                    throw "hyper-v-snapshot-policy-quarantined"
                }
                if ([string]$VirtualMachine.CheckpointType -cne $ExpectedPolicy) {
                    try {
                        Hyper-V\Set-VM -VM $VirtualMachine -CheckpointType $ExpectedPolicy -ErrorAction Stop
                        $VirtualMachine = Assert-HyperVWindowsSnapshotRepairIdentity $Request
                        if ([string]$VirtualMachine.CheckpointType -cne $ExpectedPolicy) {
                            throw "hyper-v-snapshot-policy-restore-unconfirmed"
                        }
                    } catch {
                        try {
                            $VirtualMachine = Assert-HyperVWindowsSnapshotRepairIdentity $Request
                            Hyper-V\Set-VM -VM $VirtualMachine -CheckpointType Disabled -ErrorAction Stop
                            $VirtualMachine = Assert-HyperVWindowsSnapshotRepairIdentity $Request
                            if ([string]$VirtualMachine.CheckpointType -cne "Disabled") {
                                throw "hyper-v-snapshot-policy-quarantine-unconfirmed"
                            }
                        } catch {
                            throw "hyper-v-snapshot-policy-quarantine-failed"
                        }
                        throw "hyper-v-snapshot-policy-restore-failed"
                    }
                }
            }

            $VirtualMachine = Assert-HyperVWindowsSnapshotRepairIdentity $Request
            try {
                $Candidates = @(Hyper-V\Get-VMSnapshot -VM $VirtualMachine -ErrorAction Stop | Where-Object {
                    [string]$_.Name -eq $SnapshotName
                })
            } catch {
                throw "hyper-v-snapshot-reconciliation-command-failed"
            }
            if ($Candidates.Count -gt 1) { throw "hyper-v-snapshot-reconciliation-ambiguous" }
            $VirtualMachine = Assert-HyperVWindowsSnapshotRepairIdentity $Request
            if ([string]$VirtualMachine.CheckpointType -cne $ExpectedPolicy) {
                throw "hyper-v-snapshot-policy-restore-failed"
            }
            Write-HyperVWindowsSuccess $Operation @([ordered]@{
                checkpointPolicy = $ExpectedPolicy
                candidateCount = [int]$Candidates.Count
            })
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
        "New-VM" {
            $VirtualMachineName = [string]$Request.name
            if ([string]::IsNullOrEmpty($VirtualMachineName)) { throw "virtual-machine-name-invalid" }
            $Generation = [int]$Request.generation
            if ($Generation -notin @(1, 2)) { throw "virtual-machine-generation-invalid" }
            $MemoryStartupBytes = [long]$Request.memoryStartupBytes
            if ($MemoryStartupBytes -le 0) { throw "virtual-machine-memory-invalid" }
            # Splatted rather than branched over every present/absent combination: the optional
            # disk and switch are independent, and the parameters they select belong to different
            # native parameter sets, so a literal call per combination is four calls to keep in
            # agreement. Every value here is still a bound parameter, never command text.
            $NewVmParameters = @{
                Name = $VirtualMachineName
                Generation = $Generation
                MemoryStartupBytes = $MemoryStartupBytes
                ErrorAction = "Stop"
            }
            if ($null -ne $Request.vhdPath) {
                $VhdPath = [string]$Request.vhdPath
                if ([string]::IsNullOrEmpty($VhdPath)) { throw "virtual-machine-vhd-path-invalid" }
                $NewVmParameters["VHDPath"] = $VhdPath
            } else {
                # Absent means create the VM with no disk attached, and -NoVHD is the native
                # parameter set that says so. Stated rather than left to the default, because
                # the other two sets create a VHDX this library never asked for and, having no
                # record of, would never clean up.
                $NewVmParameters["NoVHD"] = $true
            }
            if ($null -ne $Request.switchName) {
                $SwitchName = [string]$Request.switchName
                if ([string]::IsNullOrEmpty($SwitchName)) { throw "virtual-switch-name-invalid" }
                $NewVmParameters["SwitchName"] = $SwitchName
            }
            $Created = @(Hyper-V\New-VM @NewVmParameters)
            if ($Created.Count -ne 1) { throw "virtual-machine-create-result-ambiguous" }
            Write-HyperVWindowsSuccess $Operation @(Convert-HyperVWindowsVirtualMachine $Created[0])
        }
        "Set-VM" {
            $VirtualMachine = Assert-HyperVWindowsSingleVirtualMachine $VirtualMachines
            $SetVmParameters = @{ VM = $VirtualMachine; ErrorAction = "Stop" }
            $AppliedSettings = 0
            if ($null -ne $Request.notes) {
                $SetVmParameters["Notes"] = [string]$Request.notes
                $AppliedSettings++
            }
            if ($null -ne $Request.automaticCheckpointsEnabled) {
                if ($Request.automaticCheckpointsEnabled -isnot [bool]) { throw "automatic-checkpoints-setting-invalid" }
                $SetVmParameters["AutomaticCheckpointsEnabled"] = [bool]$Request.automaticCheckpointsEnabled
                $AppliedSettings++
            }
            if ($null -ne $Request.checkpointType) {
                $CheckpointType = [string]$Request.checkpointType
                if ($CheckpointType -notin @("Disabled", "Production", "ProductionOnly", "Standard")) {
                    throw "checkpoint-type-invalid"
                }
                $SetVmParameters["CheckpointType"] = $CheckpointType
                $AppliedSettings++
            }
            # Native applies only the parameters it is given, so a request naming none of them is
            # a call that reports success without changing anything. Refused here as well as in
            # the caller, because a no-op indistinguishable from a mutation is the one result
            # neither side can audit afterwards.
            if ($AppliedSettings -eq 0) { throw "virtual-machine-settings-empty" }
            Hyper-V\Set-VM @SetVmParameters
            Write-HyperVWindowsSuccess $Operation @()
        }
        "Set-VMMemory" {
            $VirtualMachine = Assert-HyperVWindowsSingleVirtualMachine $VirtualMachines
            if ($Request.dynamicMemoryEnabled -isnot [bool]) { throw "dynamic-memory-setting-invalid" }
            Hyper-V\Set-VMMemory -VM $VirtualMachine -DynamicMemoryEnabled ([bool]$Request.dynamicMemoryEnabled) -ErrorAction Stop
            Write-HyperVWindowsSuccess $Operation @()
        }
        "Set-VMProcessor" {
            $VirtualMachine = Assert-HyperVWindowsSingleVirtualMachine $VirtualMachines
            $ProcessorCount = [int]$Request.count
            if ($ProcessorCount -lt 1) { throw "virtual-machine-processor-count-invalid" }
            $ProcessorArgs = @{ VM = $VirtualMachine; Count = $ProcessorCount; ErrorAction = 'Stop' }
            if ($null -ne $Request.exposeVirtualizationExtensions) {
                if ($Request.exposeVirtualizationExtensions -isnot [bool]) { throw 'virtualization-extensions-invalid' }
                if ([string]$VirtualMachine.State -ne 'Off') { throw 'virtualization-extensions-require-stopped-vm' }
                $ProcessorArgs.ExposeVirtualizationExtensions = [bool]$Request.exposeVirtualizationExtensions
            }
            Hyper-V\Set-VMProcessor @ProcessorArgs
            Write-HyperVWindowsSuccess $Operation @()
        }
        "Get-VMFirmware" {
            $VirtualMachine = Assert-HyperVWindowsSingleVirtualMachine $VirtualMachines
            $Firmware = Hyper-V\Get-VMFirmware -VM $VirtualMachine -ErrorAction Stop
            # Only a disk entry carries a path; a network or DVD entry has none. Reporting "" for
            # those would be a value that compares equal to nothing the caller can check, so the
            # absent case stays absent.
            $BootOrder = @($Firmware.BootOrder)
            $FirstBootDevicePath = $null
            if ($BootOrder.Count -ge 1) {
                $FirstBootDevice = $BootOrder[0].Device
                if ($null -ne $FirstBootDevice -and -not [string]::IsNullOrEmpty([string]$FirstBootDevice.Path)) {
                    $FirstBootDevicePath = [string]$FirstBootDevice.Path
                }
            }
            $FirmwareItem = [ordered]@{
                # Taken from the resolved VM rather than from the firmware record. The two are
                # the same id, but this one is already proven to exist -- selector resolution
                # produced it -- whereas VMFirmware.VMId is an assumption no test on this host
                # can check, and there is no PowerShell here to check it with.
                vmId = ([Guid]$VirtualMachine.Id).ToString("D").ToLowerInvariant()
                secureBoot = [string]$Firmware.SecureBoot
                secureBootTemplate = if ($null -eq $Firmware.SecureBootTemplate) { "" } else { [string]$Firmware.SecureBootTemplate }
                firstBootDevicePath = $FirstBootDevicePath
            }
            Write-HyperVWindowsSuccess $Operation @($FirmwareItem)
        }
        "Set-VMFirmware" {
            $VirtualMachine = Assert-HyperVWindowsSingleVirtualMachine $VirtualMachines
            $SecureBoot = $Request.secureBoot
            if ($null -eq $SecureBoot -or $SecureBoot.enabled -isnot [bool]) { throw "secure-boot-setting-invalid" }
            $FirmwareParameters = @{ VM = $VirtualMachine; ErrorAction = "Stop" }
            if ([bool]$SecureBoot.enabled) {
                $SecureBootTemplate = [string]$SecureBoot.template
                if ([string]::IsNullOrEmpty($SecureBootTemplate)) { throw "secure-boot-template-invalid" }
                $FirmwareParameters["EnableSecureBoot"] = "On"
                # Native rejects a template while Secure Boot is off, so the parameter is only
                # ever present on the enabled branch rather than passed with an empty value.
                $FirmwareParameters["SecureBootTemplate"] = $SecureBootTemplate
            } else {
                $FirmwareParameters["EnableSecureBoot"] = "Off"
            }
            if ($null -ne $Request.firstBootDiskPath) {
                $FirstBootDiskPath = [string]$Request.firstBootDiskPath
                if ([string]::IsNullOrEmpty($FirstBootDiskPath)) { throw "vm-first-boot-disk-path-invalid" }
                # The caller names the boot entry by the disk path it holds; native wants the
                # device object. Case-insensitive because Windows path identity is, and exactly
                # one match because a boot order pointed at a guessed device boots the wrong disk.
                $FirstBootDisks = @(Hyper-V\Get-VMHardDiskDrive -VM $VirtualMachine -ErrorAction Stop | Where-Object {
                    -not [string]::IsNullOrEmpty([string]$_.Path) -and [string]$_.Path -ieq $FirstBootDiskPath
                })
                if ($FirstBootDisks.Count -eq 0) { throw "vm-first-boot-disk-not-found" }
                if ($FirstBootDisks.Count -ne 1) { throw "vm-first-boot-disk-ambiguous" }
                $FirmwareParameters["FirstBootDevice"] = $FirstBootDisks[0]
            }
            Hyper-V\Set-VMFirmware @FirmwareParameters
            Write-HyperVWindowsSuccess $Operation @()
        }
        "Get-VMBios" {
            $VirtualMachine = Assert-HyperVWindowsSingleVirtualMachine $VirtualMachines
            $Bios = Hyper-V\Get-VMBios -VM $VirtualMachine -ErrorAction Stop
            $StartupOrder = @($Bios.StartupOrder | ForEach-Object { [string]$_ })
            $BiosItem = [ordered]@{
                vmId = ([Guid]$VirtualMachine.Id).ToString("D").ToLowerInvariant()
                startupOrder = $StartupOrder
            }
            Write-HyperVWindowsSuccess $Operation @($BiosItem)
        }
        "Set-VMBios" {
            $VirtualMachine = Assert-HyperVWindowsSingleVirtualMachine $VirtualMachines
            $StartupOrder = @(@($Request.startupOrder) | ForEach-Object { [string]$_ })
            if ($StartupOrder.Count -lt 1) { throw "vm-bios-startup-order-invalid" }
            foreach ($StartupDevice in $StartupOrder) {
                if ($StartupDevice -notin @("IDE", "CD", "LegacyNetworkAdapter", "Floppy")) {
                    throw "vm-bios-startup-order-invalid"
                }
            }
            Hyper-V\Set-VMBios -VM $VirtualMachine -StartupOrder $StartupOrder -ErrorAction Stop
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
        "Add-VMNetworkAdapter" {
            $VirtualMachine = Assert-HyperVWindowsSingleVirtualMachine $VirtualMachines
            $AdapterName = [string]$Request.name
            if ([string]::IsNullOrEmpty($AdapterName)) { throw "vm-network-adapter-name-invalid" }
            $SwitchName = [string]$Request.switchName
            if ([string]::IsNullOrEmpty($SwitchName)) { throw "virtual-switch-name-invalid" }
            Hyper-V\Add-VMNetworkAdapter -VM $VirtualMachine -Name $AdapterName -SwitchName $SwitchName -ErrorAction Stop
            Write-HyperVWindowsSuccess $Operation @()
        }
        "Rename-VMNetworkAdapter" {
            $VirtualMachine = Assert-HyperVWindowsSingleVirtualMachine $VirtualMachines
            $NewAdapterName = [string]$Request.newName
            if ([string]::IsNullOrEmpty($NewAdapterName)) { throw "vm-network-adapter-new-name-invalid" }
            $Adapter = Get-HyperVWindowsVMNetworkAdapterTarget $VirtualMachine $Request.adapter
            Hyper-V\Rename-VMNetworkAdapter -VMNetworkAdapter $Adapter -NewName $NewAdapterName -ErrorAction Stop
            Write-HyperVWindowsSuccess $Operation @()
        }
        "Set-VMNetworkAdapter" {
            $VirtualMachine = Assert-HyperVWindowsSingleVirtualMachine $VirtualMachines
            # Normalised to bare hex the same way the remove branch normalises its expected
            # address, so one spelling of a MAC reaches native no matter which one the caller
            # records. The all-zero address is native's "not assigned yet" placeholder, not an
            # address anything may be set to.
            $StaticMacAddress = ([string]$Request.staticMacAddress -replace '[^0-9A-Fa-f]', '').ToUpperInvariant()
            if ($StaticMacAddress -notmatch '^[0-9A-F]{12}$' -or $StaticMacAddress -eq '000000000000') {
                throw "vm-network-adapter-mac-invalid"
            }
            $Adapter = Get-HyperVWindowsVMNetworkAdapterTarget $VirtualMachine $Request.adapter
            Hyper-V\Set-VMNetworkAdapter -VMNetworkAdapter $Adapter -StaticMacAddress $StaticMacAddress -ErrorAction Stop
            Write-HyperVWindowsSuccess $Operation @()
        }
        "Remove-VMNetworkAdapter" {
            $VirtualMachine = Assert-HyperVWindowsSingleVirtualMachine $VirtualMachines
            if ([string]$Request.selector.kind -cne "id" -or
                $Request.expectedNotes -isnot [string] -or
                [string]$Request.expectedNotes -notmatch '^[^\x00-\x1f]{1,4096}\z') {
                throw "vm-network-adapter-identity-mismatch"
            }
            # Re-read immediately before mutation. The broker's earlier owner check made the
            # decision safe, while this fence closes the interval in which the same VM id could
            # be reassigned to another Device Lab incarnation.
            $CurrentVirtualMachines = @(Get-HyperVWindowsVirtualMachines $Request.selector)
            if ($CurrentVirtualMachines.Count -ne 1 -or
                [Guid]$CurrentVirtualMachines[0].Id -ne [Guid][string]$Request.selector.id -or
                [string]$CurrentVirtualMachines[0].Notes -cne [string]$Request.expectedNotes) {
                throw "vm-network-adapter-identity-mismatch"
            }
            $VirtualMachine = $CurrentVirtualMachines[0]
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
            # A query with no matching neighbours can emit a nonterminating cmdletization
            # error. Keep that one exact absence retryable; every other error means the
            # read was incomplete and must reach the caller instead of becoming [].
            $NeighborReadErrors = @()
            $RawItems = @(NetTCPIP\Get-NetNeighbor -AddressFamily IPv4 -InterfaceIndex ([int]$Request.interfaceIndex) -ErrorAction SilentlyContinue -ErrorVariable NeighborReadErrors)
            foreach ($ReadError in @($NeighborReadErrors)) {
                $NoMatch = $RawItems.Count -eq 0 -and
                    [string]$ReadError.CategoryInfo.Category -eq 'ObjectNotFound' -and
                    [string]$ReadError.FullyQualifiedErrorId -eq 'CmdletizationQuery_NotFound,Get-NetNeighbor'
                if (-not $NoMatch) { throw 'net-neighbor-inspection-failed' }
            }
            $Items = @($RawItems | ForEach-Object {
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
    if ($Operation -in @("Capture-VMConsole", "Send-VMConsoleInput", "Get-VMConsoleCursor") -and
        $ErrorCode -cnotin $ConsoleFixedErrorCodes) {
        $ErrorCode = "hyper-v-console-native-failed"
    } elseif ($Operation -eq "Repair-VMSnapshotState" -and $ErrorCode -cnotin $SnapshotRepairFixedErrorCodes) {
        $ErrorCode = "hyper-v-snapshot-reconciliation-command-failed"
    } elseif ($Operation -eq "Configure-VMGuestBoot" -and $ErrorCode -cnotin $GuestBootFixedErrorCodes) {
        $ErrorCode = "hyper-v-guest-provision-preflight-command-failed"
    } elseif ($ErrorCode -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\z') {
        # The exception message is host text and may carry paths or VM names, so it is only ever
        # accepted when it already is one of our own bounded codes. FullyQualifiedErrorId is a
        # structured cmdlet identifier with no caller data, but it contains commas
        # ("InvalidOperation,Microsoft.HyperV.PowerShell.Commands.CheckpointVM"), which the bounded
        # pattern rejects. Normalising it keeps the code bounded while preserving the one piece of
        # diagnosis available; discarding it collapsed every native failure to a single constant.
        $ErrorCode = (([string]$_.FullyQualifiedErrorId) -replace '[^A-Za-z0-9._:-]', '-').Trim('-')
        if ($ErrorCode.Length -gt 128) { $ErrorCode = $ErrorCode.Substring(0, 128) }
    }
    Write-HyperVWindowsFailure $Operation $ErrorCode $_
    # Deliberately not `exit`. PowerShell's exit is not scoped to a script block, so when this asset
    # runs as `& ([ScriptBlock]::Create($source))` — how both transports invoke it — an exit here
    # unwinds past the caller instead of returning to it. Under the reused session that discards the
    # failure envelope written one line above, because Out-String never completes, and kills the
    # child, turning an ordinary virtual-machine-not-found into a transport error. Each bootstrap
    # reads this flag instead, so a one-shot invocation still ends with exit code 1.
    $global:CccHyperVExitCode = 1
}
