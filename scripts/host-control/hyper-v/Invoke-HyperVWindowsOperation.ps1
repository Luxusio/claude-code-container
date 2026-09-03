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
    if ($ErrorCode -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$') {
        $ErrorCode = "native-operation-failed"
    }
    [ordered]@{
        schemaVersion = 1
        operation = $Operation
        ok = $false
        errorCode = $ErrorCode
    } | ConvertTo-Json -Compress -Depth 3
}

function Resolve-HyperVWindowsTrustedModulePath {
    $ModuleRoot = [IO.Path]::GetFullPath((Join-Path ([Environment]::SystemDirectory) "WindowsPowerShell\v1.0\Modules\Hyper-V"))
    if (-not (Test-Path -LiteralPath $ModuleRoot -PathType Container)) { throw "hyper-v-module-missing" }
    $RootItem = Get-Item -LiteralPath $ModuleRoot -Force -ErrorAction Stop
    if (($RootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "hyper-v-module-path-invalid" }

    $DirectManifest = Join-Path $ModuleRoot "Hyper-V.psd1"
    if (Test-Path -LiteralPath $DirectManifest -PathType Leaf) {
        $DirectItem = Get-Item -LiteralPath $DirectManifest -Force -ErrorAction Stop
        if (($DirectItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "hyper-v-module-path-invalid" }
        return [IO.Path]::GetFullPath($DirectManifest)
    }

    $Candidates = @()
    foreach ($VersionDirectory in @(Get-ChildItem -LiteralPath $ModuleRoot -Directory -Force -ErrorAction Stop)) {
        if ($VersionDirectory.Name -notmatch '^\d+(?:\.\d+){1,3}$') { continue }
        if (($VersionDirectory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "hyper-v-module-path-invalid" }
        $Manifest = Join-Path $VersionDirectory.FullName "Hyper-V.psd1"
        if (-not (Test-Path -LiteralPath $Manifest -PathType Leaf)) { continue }
        $ManifestItem = Get-Item -LiteralPath $Manifest -Force -ErrorAction Stop
        if (($ManifestItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "hyper-v-module-path-invalid" }
        $FullManifest = [IO.Path]::GetFullPath($Manifest)
        if (-not $FullManifest.StartsWith(
            $ModuleRoot + [IO.Path]::DirectorySeparatorChar,
            [StringComparison]::OrdinalIgnoreCase
        )) { throw "hyper-v-module-path-invalid" }
        $Candidates += [pscustomobject]@{
            Version = [Version]$VersionDirectory.Name
            Path = $FullManifest
        }
    }
    if ($Candidates.Count -eq 0) { throw "hyper-v-module-missing" }
    return [string](($Candidates | Sort-Object -Property Version -Descending | Select-Object -First 1).Path)
}

function Import-HyperVWindowsTrustedModule {
    $ModulePath = Resolve-HyperVWindowsTrustedModulePath
    $ExpectedModuleBase = [IO.Path]::GetFullPath([IO.Path]::GetDirectoryName($ModulePath))

    # Already loaded from the expected base is accepted as-is. -Force reimports on every call, which
    # is redundant inside one process and is the single dominant cost when this script serves many
    # operations from one session. The path is still re-resolved and re-verified above, so this
    # skips work rather than trust: a module loaded from anywhere else falls through to the import
    # below and is rejected there.
    $Existing = @(Microsoft.PowerShell.Core\Get-Module -Name "Hyper-V" | Where-Object {
        [IO.Path]::GetFullPath([string]$_.ModuleBase) -ieq $ExpectedModuleBase
    })
    if ($Existing.Count -gt 0) { return }

    $Loaded = @(Import-Module -Name $ModulePath -Force -PassThru -ErrorAction Stop)
    if ($Loaded.Count -eq 0 -or -not ($Loaded | Where-Object {
        [IO.Path]::GetFullPath([string]$_.ModuleBase) -ieq $ExpectedModuleBase
    })) {
        throw "hyper-v-module-path-invalid"
    }
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
        "Checkpoint-VM", "Remove-VMSnapshot", "Restore-VMSnapshot"
    )) {
        throw "operation-invalid"
    }
    if ($null -eq $Request.selector -or [string]$Request.selector.kind -notin @("id", "name")) {
        throw "selector-invalid"
    }
    if ($Operation -in @("Remove-VMSnapshot", "Restore-VMSnapshot")) {
        if ($null -eq $Request.snapshot -or [string]$Request.snapshot.kind -notin @("id", "name")) {
            throw "snapshot-selector-invalid"
        }
    }
    Import-HyperVWindowsTrustedModule

    $VirtualMachines = @(Get-HyperVWindowsVirtualMachines $Request.selector)
    switch ($Operation) {
        "Get-VM" {
            $Items = @($VirtualMachines | ForEach-Object { Convert-HyperVWindowsVirtualMachine $_ })
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
    }
} catch {
    $ErrorCode = [string]$_.Exception.Message
    if ($ErrorCode -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$') {
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
