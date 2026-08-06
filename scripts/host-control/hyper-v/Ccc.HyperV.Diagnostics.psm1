Set-StrictMode -Version 3.0

function Get-CccGuestBootDiagnosticResult {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [object] $Vm,
        [scriptblock] $IntegrationServiceReader = { param($TargetVm) @(Get-VMIntegrationService -VM $TargetVm -ErrorAction SilentlyContinue) },
        [scriptblock] $FirmwareReader = { param($TargetVm) Get-VMFirmware -VM $TargetVm -ErrorAction SilentlyContinue },
        [scriptblock] $BiosReader = { param($TargetVm) Get-VMBios -VM $TargetVm -ErrorAction SilentlyContinue },
        [scriptblock] $HardDiskReader = { param($TargetVm) @(Get-VMHardDiskDrive -VM $TargetVm -ErrorAction SilentlyContinue) },
        [scriptblock] $DvdReader = { param($TargetVm) @(Get-VMDvdDrive -VM $TargetVm -ErrorAction SilentlyContinue) }
    )

    $HeartbeatServiceId = '84eaae65-2f2e-45f5-9bb5-0e857dc8eb47'
    $IntegrationServices = @(& $IntegrationServiceReader $Vm)
    $Heartbeat = @(
        $IntegrationServices |
            Where-Object { ([string]$_.Id).Trim('{}').ToLowerInvariant() -eq $HeartbeatServiceId } |
            Select-Object -First 1
    )
    $Firmware = if ([int]$Vm.Generation -eq 2) { & $FirmwareReader $Vm } else { $null }
    $Bios = if ([int]$Vm.Generation -eq 1) { & $BiosReader $Vm } else { $null }
    $BootDeviceTypes = @()
    if ($Firmware) {
        $BootDeviceTypes = @($Firmware.BootOrder | ForEach-Object {
            $BootType = [string]$_.BootType
            $DeviceType = if ($_.Device) { $_.Device.GetType().Name } else { '' }
            $Classification = $BootType + ' ' + $DeviceType
            if ($Classification -match 'HardDisk|Vhd') { 'hard-disk' }
            elseif ($Classification -match 'Dvd|Optical') { 'dvd' }
            elseif ($Classification -match 'Network') { 'network' }
            else { 'unknown' }
        })
    }
    elseif ($Bios) {
        $BootDeviceTypes = @($Bios.StartupOrder | ForEach-Object {
            switch ([string]$_) {
                'IDE' { 'hard-disk' }
                'CD' { 'dvd' }
                'LegacyNetworkAdapter' { 'network' }
                default { 'unknown' }
            }
        })
    }
    $HardDisks = @(& $HardDiskReader $Vm)
    $DvdDrives = @(& $DvdReader $Vm)
    $IntegrationServiceSummary = @($IntegrationServices | Sort-Object Name | ForEach-Object {
        [ordered]@{
            name = [string]$_.Name
            enabled = [bool]$_.Enabled
            primaryStatus = if ($null -ne $_.PrimaryStatus) { [int]$_.PrimaryStatus } else { $null }
            secondaryStatus = if ($null -ne $_.SecondaryStatus) { [int]$_.SecondaryStatus } else { $null }
        }
    })
    return [ordered]@{
        ok = $true
        vmId = [string]$Vm.Id
        vmName = $Vm.Name
        state = [string]$Vm.State
        uptimeMs = [Math]::Floor($Vm.Uptime.TotalMilliseconds)
        generation = [int]$Vm.Generation
        secureBootEnabled = if ($Firmware) { [bool]$Firmware.SecureBoot } else { $null }
        heartbeatEnabled = if ($Heartbeat.Count -eq 1) { [bool]$Heartbeat[0].Enabled } else { $null }
        heartbeatPrimaryStatus = if ($Heartbeat.Count -eq 1 -and $null -ne $Heartbeat[0].PrimaryStatus) { [int]$Heartbeat[0].PrimaryStatus } else { $null }
        heartbeatSecondaryStatus = if ($Heartbeat.Count -eq 1 -and $null -ne $Heartbeat[0].SecondaryStatus) { [int]$Heartbeat[0].SecondaryStatus } else { $null }
        integrationServices = $IntegrationServiceSummary
        hardDiskCount = $HardDisks.Count
        dvdCount = $DvdDrives.Count
        hardDiskControllers = @($HardDisks | ForEach-Object { ([string]$_.ControllerType).ToLowerInvariant() })
        bootDeviceTypes = $BootDeviceTypes
    }
}

Export-ModuleMember -Function 'Get-CccGuestBootDiagnosticResult'
