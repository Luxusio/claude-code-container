$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

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

$Operation = "Get-VM"
try {
    $RawRequest = [string]$global:CccHyperVJsonInput
    if ([Text.Encoding]::UTF8.GetByteCount($RawRequest) -gt 65536) { throw "request-too-large" }
    $Request = $RawRequest | ConvertFrom-Json -ErrorAction Stop
    if ([int]$Request.schemaVersion -ne 1) { throw "request-schema-invalid" }
    $Operation = [string]$Request.operation
    if ($Operation -notin @("Get-VM", "Get-VMHardDiskDrive", "Get-VMDvdDrive", "Start-VM", "Stop-VM", "Remove-VM")) {
        throw "operation-invalid"
    }
    if ($null -eq $Request.selector -or [string]$Request.selector.kind -notin @("id", "name")) {
        throw "selector-invalid"
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
    }
} catch {
    $ErrorCode = [string]$_.Exception.Message
    if ($ErrorCode -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$') {
        $ErrorCode = [string]$_.FullyQualifiedErrorId
    }
    Write-HyperVWindowsFailure $Operation $ErrorCode
    exit 1
}
