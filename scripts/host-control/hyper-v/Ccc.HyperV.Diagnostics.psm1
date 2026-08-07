Set-StrictMode -Version 3.0

function Get-CccDiagnosticProperty {
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

function ConvertTo-CccDiagnosticInt {
    param([AllowNull()] [object] $Value)
    if ($null -eq $Value) { return $null }
    try {
        $Converted = [int]$Value
        if ($Converted -lt 0) { return $null }
        return $Converted
    }
    catch { return $null }
}

function ConvertTo-CccDiagnosticString {
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

function ConvertTo-CccDiagnosticBool {
    param(
        [AllowNull()] [object] $Value,
        [AllowNull()] [object] $Default,
        [Parameter(Mandatory = $true)] [System.Collections.Generic.List[string]] $DiagnosticErrors,
        [Parameter(Mandatory = $true)] [string] $ErrorCode
    )
    if ($Value -is [bool]) { return [bool]$Value }
    [void]$DiagnosticErrors.Add($ErrorCode)
    return $Default
}

function Get-CccGuestBootDiagnosticResult {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [object] $Vm,
        [scriptblock] $IntegrationServiceReader = { param($TargetVm) @(Get-VMIntegrationService -VM $TargetVm -ErrorAction Stop) },
        [scriptblock] $FirmwareReader = { param($TargetVm) Get-VMFirmware -VM $TargetVm -ErrorAction Stop },
        [scriptblock] $BiosReader = { param($TargetVm) Get-VMBios -VM $TargetVm -ErrorAction Stop },
        [scriptblock] $HardDiskReader = { param($TargetVm) @(Get-VMHardDiskDrive -VM $TargetVm -ErrorAction Stop) },
        [scriptblock] $DvdReader = { param($TargetVm) @(Get-VMDvdDrive -VM $TargetVm -ErrorAction Stop) }
    )

    $DiagnosticErrors = [System.Collections.Generic.List[string]]::new()
    $GenerationValue = ConvertTo-CccDiagnosticInt (Get-CccDiagnosticProperty $Vm 'Generation' $null $DiagnosticErrors 'hyper-v-diagnostic-vm-observation-incomplete' -Required)
    $Generation = if ($GenerationValue -eq 1 -or $GenerationValue -eq 2) { $GenerationValue } else { $null }
    $StateValue = Get-CccDiagnosticProperty $Vm 'State' $null $DiagnosticErrors 'hyper-v-diagnostic-vm-observation-incomplete' -Required
    $State = ConvertTo-CccDiagnosticString $StateValue 'Unknown' $DiagnosticErrors 'hyper-v-diagnostic-vm-observation-incomplete' -Required
    if ([string]::IsNullOrWhiteSpace($State)) {
        $State = 'Unknown'
        [void]$DiagnosticErrors.Add('hyper-v-diagnostic-vm-observation-incomplete')
    }
    $UptimeMs = 0
    try {
        $Uptime = Get-CccDiagnosticProperty $Vm 'Uptime' $null $DiagnosticErrors 'hyper-v-diagnostic-vm-observation-incomplete' -Required
        if ($null -eq $Uptime) { [void]$DiagnosticErrors.Add('hyper-v-diagnostic-vm-observation-incomplete') }
        else {
            $TotalMilliseconds = Get-CccDiagnosticProperty $Uptime 'TotalMilliseconds' $null $DiagnosticErrors 'hyper-v-diagnostic-vm-observation-incomplete' -Required
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
            $ServiceName = ConvertTo-CccDiagnosticString `
                (Get-CccDiagnosticProperty $Service 'Name' $null $DiagnosticErrors 'hyper-v-diagnostic-integration-services-incomplete' -Required) `
                '' $DiagnosticErrors 'hyper-v-diagnostic-integration-services-incomplete' -Required
            if ([string]::IsNullOrWhiteSpace($ServiceName)) {
                [void]$DiagnosticErrors.Add('hyper-v-diagnostic-integration-services-incomplete')
                continue
            }
            if ($ServiceName.Length -gt 128) { $ServiceName = $ServiceName.Substring(0, 128) }
            $PrimaryStatus = ConvertTo-CccDiagnosticInt (Get-CccDiagnosticProperty $Service 'PrimaryStatus' $null $DiagnosticErrors 'hyper-v-diagnostic-integration-services-incomplete')
            $SecondaryStatus = ConvertTo-CccDiagnosticInt (Get-CccDiagnosticProperty $Service 'SecondaryStatus' $null $DiagnosticErrors 'hyper-v-diagnostic-integration-services-incomplete')
            $Enabled = ConvertTo-CccDiagnosticBool `
                (Get-CccDiagnosticProperty $Service 'Enabled' $null $DiagnosticErrors 'hyper-v-diagnostic-integration-services-incomplete' -Required) `
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
        $Id = ConvertTo-CccDiagnosticString `
            (Get-CccDiagnosticProperty $_ 'Id' $null $DiagnosticErrors 'hyper-v-diagnostic-integration-services-incomplete' -Required) `
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
    if ($null -ne $Firmware) {
        $BootOrder = @(Get-CccDiagnosticProperty $Firmware 'BootOrder' @() $DiagnosticErrors 'hyper-v-diagnostic-firmware-incomplete' -Required)
        if ($BootOrder.Count -eq 0) { [void]$DiagnosticErrors.Add('hyper-v-diagnostic-firmware-incomplete') }
        $BoundedBootOrder = @($BootOrder | Select-Object -First 8)
        foreach ($BootEntry in $BoundedBootOrder) {
            try {
                $BootType = ConvertTo-CccDiagnosticString `
                    (Get-CccDiagnosticProperty $BootEntry 'BootType' $null $DiagnosticErrors 'hyper-v-diagnostic-firmware-incomplete' -Required) `
                    '' $DiagnosticErrors 'hyper-v-diagnostic-firmware-incomplete' -Required
                $Device = Get-CccDiagnosticProperty $BootEntry 'Device' $null $DiagnosticErrors 'hyper-v-diagnostic-firmware-incomplete'
                $DeviceType = if ($null -ne $Device) { ConvertTo-CccDiagnosticString $Device.GetType().Name } else { '' }
                $Classification = $BootType + ' ' + $DeviceType
                if ($Classification -match 'HardDisk|Vhd') { $BootDeviceTypes += 'hard-disk' }
                elseif ($Classification -match 'Dvd|Optical') { $BootDeviceTypes += 'dvd' }
                elseif ($Classification -match 'Network') { $BootDeviceTypes += 'network' }
                else { $BootDeviceTypes += 'unknown' }
            }
            catch {
                [void]$DiagnosticErrors.Add('hyper-v-diagnostic-firmware-incomplete')
                $BootDeviceTypes += 'unknown'
            }
        }
    }
    elseif ($null -ne $Bios) {
        $StartupOrder = @(@(Get-CccDiagnosticProperty $Bios 'StartupOrder' @() $DiagnosticErrors 'hyper-v-diagnostic-bios-incomplete' -Required) | Select-Object -First 8)
        if ($StartupOrder.Count -eq 0) { [void]$DiagnosticErrors.Add('hyper-v-diagnostic-bios-incomplete') }
        foreach ($BootEntry in $StartupOrder) {
            $BootEntryValue = ConvertTo-CccDiagnosticString $BootEntry '' $DiagnosticErrors 'hyper-v-diagnostic-bios-incomplete' -Required
            switch ($BootEntryValue) {
                'IDE' { $BootDeviceTypes += 'hard-disk' }
                'CD' { $BootDeviceTypes += 'dvd' }
                'LegacyNetworkAdapter' { $BootDeviceTypes += 'network' }
                default { $BootDeviceTypes += 'unknown' }
            }
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
    $BoundedHardDisks = @($HardDisks | Select-Object -First 8)
    foreach ($HardDisk in $BoundedHardDisks) {
        try {
            $Controller = (ConvertTo-CccDiagnosticString `
                (Get-CccDiagnosticProperty $HardDisk 'ControllerType' $null $DiagnosticErrors 'hyper-v-diagnostic-hard-disks-incomplete' -Required) `
                '' $DiagnosticErrors 'hyper-v-diagnostic-hard-disks-incomplete' -Required).ToLowerInvariant()
            if ($Controller -eq 'ide' -or $Controller -eq 'scsi') { $HardDiskControllers += $Controller }
            else { [void]$DiagnosticErrors.Add('hyper-v-diagnostic-hard-disks-incomplete') }
        }
        catch { [void]$DiagnosticErrors.Add('hyper-v-diagnostic-hard-disks-incomplete') }
    }

    $DvdDrives = @()
    try { $DvdDrives = @(& $DvdReader $Vm) }
    catch { [void]$DiagnosticErrors.Add('hyper-v-diagnostic-dvd-drives-unavailable') }

    $HeartbeatEnabled = $null
    $HeartbeatPrimaryStatus = $null
    $HeartbeatSecondaryStatus = $null
    if ($Heartbeat.Count -eq 1) {
        $HeartbeatEnabled = ConvertTo-CccDiagnosticBool `
            (Get-CccDiagnosticProperty $Heartbeat[0] 'Enabled' $null $DiagnosticErrors 'hyper-v-diagnostic-integration-services-incomplete' -Required) `
            $null $DiagnosticErrors 'hyper-v-diagnostic-integration-services-incomplete'
        $HeartbeatPrimaryStatus = ConvertTo-CccDiagnosticInt (Get-CccDiagnosticProperty $Heartbeat[0] 'PrimaryStatus' $null $DiagnosticErrors 'hyper-v-diagnostic-integration-services-incomplete')
        $HeartbeatSecondaryStatus = ConvertTo-CccDiagnosticInt (Get-CccDiagnosticProperty $Heartbeat[0] 'SecondaryStatus' $null $DiagnosticErrors 'hyper-v-diagnostic-integration-services-incomplete')
    }

    $SecureBootEnabled = $null
    if ($null -ne $Firmware) {
        $SecureBootEnabled = ConvertTo-CccDiagnosticBool `
            (Get-CccDiagnosticProperty $Firmware 'SecureBoot' $null $DiagnosticErrors 'hyper-v-diagnostic-firmware-incomplete' -Required) `
            $null $DiagnosticErrors 'hyper-v-diagnostic-firmware-incomplete'
    }
    $DiagnosticErrors = @($DiagnosticErrors | Select-Object -Unique | Select-Object -First 16)
    return [ordered]@{
        ok = $true
        vmId = ConvertTo-CccDiagnosticString (Get-CccDiagnosticProperty $Vm 'Id')
        vmName = ConvertTo-CccDiagnosticString (Get-CccDiagnosticProperty $Vm 'Name')
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
        diagnosticComplete = $DiagnosticErrors.Count -eq 0
        diagnosticErrors = $DiagnosticErrors
    }
}

Export-ModuleMember -Function 'Get-CccGuestBootDiagnosticResult'
