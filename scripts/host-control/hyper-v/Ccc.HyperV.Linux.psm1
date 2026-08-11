Set-StrictMode -Version 3.0

function Test-CccSameIpv4Prefix {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [string] $Left,
        [Parameter(Mandatory = $true)] [string] $Right,
        [Parameter(Mandatory = $true)] [ValidateRange(8, 30)] [int] $PrefixLength
    )

    $LeftBytes = [Net.IPAddress]::Parse($Left).GetAddressBytes()
    $RightBytes = [Net.IPAddress]::Parse($Right).GetAddressBytes()
    if ($LeftBytes.Length -ne 4 -or $RightBytes.Length -ne 4) { return $false }
    $WholeBytes = [int][Math]::Floor($PrefixLength / 8)
    for ($Index = 0; $Index -lt $WholeBytes; $Index++) {
        if ($LeftBytes[$Index] -ne $RightBytes[$Index]) { return $false }
    }
    $RemainingBits = $PrefixLength % 8
    if ($RemainingBits -eq 0) { return $true }
    $Mask = [byte](256 - [Math]::Pow(2, 8 - $RemainingBits))
    return (($LeftBytes[$WholeBytes] -band $Mask) -eq ($RightBytes[$WholeBytes] -band $Mask))
}

function Select-CccBootstrapIpv4Address {
    [CmdletBinding()]
    param(
        [string[]] $Candidates = @(),
        [Parameter(Mandatory = $true)] [object[]] $HostPrefixes
    )

    $Addresses = @()
    foreach ($Candidate in @($Candidates | Sort-Object -Unique)) {
        if ($Candidate -notmatch '^\d{1,3}(?:\.\d{1,3}){3}$' -or $Candidate -match '^(?:0\.|127\.|169\.254\.)') { continue }
        foreach ($HostPrefix in $HostPrefixes) {
            $HostAddress = [string]$HostPrefix.IPAddress
            $PrefixLength = [int]$HostPrefix.PrefixLength
            if ($Candidate -ne $HostAddress -and (Test-CccSameIpv4Prefix $Candidate $HostAddress $PrefixLength)) {
                $Addresses += $Candidate
                break
            }
        }
        if ($Addresses.Count -ge 8) { break }
    }
    return @($Addresses)
}

function Get-CccLinuxBootstrapNetworkResult {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [object] $Vm,
        [scriptblock] $VmAdapterReader = { param($TargetVm) @(Get-VMNetworkAdapter -VM $TargetVm -ErrorAction Stop) },
        [scriptblock] $ManagementAdapterReader = { @(Get-VMNetworkAdapter -ManagementOS -SwitchName 'Default Switch' -ErrorAction Stop) },
        [scriptblock] $HostPrefixReader = { @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop) },
        [scriptblock] $NeighborReader = { @(Get-NetNeighbor -AddressFamily IPv4 -ErrorAction Stop) }
    )

    $Addresses = @()
    $DiagnosticCode = $null
    try {
        $BootstrapAdapters = @(& $VmAdapterReader $Vm | Where-Object { $_.Name -eq 'CCC Bootstrap DHCP' })
    } catch {
        return [ordered]@{ ok = $true; addresses = $Addresses; diagnosticCode = 'hyper-v-bootstrap-vm-adapter-inspection-failed' }
    }
    if ($BootstrapAdapters.Count -gt 1) {
        return [ordered]@{ ok = $true; addresses = $Addresses; diagnosticCode = 'hyper-v-bootstrap-network-adapter-ambiguous' }
    }
    if ($BootstrapAdapters.Count -eq 1) {
        if ([string]$BootstrapAdapters[0].SwitchName -ne 'Default Switch') {
            return [ordered]@{ ok = $true; addresses = $Addresses; diagnosticCode = 'hyper-v-bootstrap-network-adapter-identity-mismatch' }
        }
        $ManagementAdapterInspectionFailed = $false
        try {
            $ManagementAddresses = @(
                & $ManagementAdapterReader |
                    ForEach-Object { $_.IPAddresses } |
                    Where-Object { $_ -match '^\d{1,3}(?:\.\d{1,3}){3}$' }
            )
        } catch {
            $ManagementAdapterInspectionFailed = $true
            $ManagementAddresses = @()
        }
        try {
            $HostPrefixes = @(
                & $HostPrefixReader |
                    Where-Object {
                        (($ManagementAddresses -contains $_.IPAddress) -or ([string]$_.InterfaceAlias -ceq 'vEthernet (Default Switch)')) -and
                        $_.PrefixLength -ge 8 -and $_.PrefixLength -le 30
                    }
            )
            $HostInterfaceIndexes = @($HostPrefixes | ForEach-Object { $_.InterfaceIndex } | Where-Object { $null -ne $_ })
        } catch {
            return [ordered]@{ ok = $true; addresses = $Addresses; diagnosticCode = 'hyper-v-bootstrap-host-prefix-inspection-failed' }
        }
        if ($ManagementAdapterInspectionFailed -and $HostPrefixes.Count -eq 0) {
            return [ordered]@{ ok = $true; addresses = $Addresses; diagnosticCode = 'hyper-v-bootstrap-management-adapter-inspection-failed' }
        }
        try {
            $Candidates = @($BootstrapAdapters[0].IPAddresses)
            $BootstrapMac = ([string]$BootstrapAdapters[0].MacAddress -replace '[^0-9A-Fa-f]', '').ToUpperInvariant()
        } catch {
            return [ordered]@{ ok = $true; addresses = $Addresses; diagnosticCode = 'hyper-v-bootstrap-vm-adapter-inspection-failed' }
        }
        if ($BootstrapMac -match '^[0-9A-F]{12}$') {
            try {
                $Candidates += @(
                    & $NeighborReader |
                        Where-Object {
                            (([string]$_.LinkLayerAddress -replace '[^0-9A-Fa-f]', '').ToUpperInvariant() -eq $BootstrapMac) -and
                            ($HostInterfaceIndexes -contains $_.InterfaceIndex) -and
                            ([string]$_.State -in @('Reachable', 'Stale', 'Delay', 'Probe', 'Permanent'))
                        } |
                        ForEach-Object { [string]$_.IPAddress }
                )
            } catch {
                $DiagnosticCode = 'hyper-v-bootstrap-neighbor-inspection-failed'
            }
        }
        try {
            $Addresses = @(Select-CccBootstrapIpv4Address $Candidates $HostPrefixes)
        } catch {
            return [ordered]@{ ok = $true; addresses = @(); diagnosticCode = 'hyper-v-bootstrap-address-selection-failed' }
        }
    }
    return [ordered]@{
        ok = $true
        addresses = $Addresses
        diagnosticCode = $DiagnosticCode
    }
}

Export-ModuleMember -Function @(
    'Get-CccLinuxBootstrapNetworkResult',
    'Select-CccBootstrapIpv4Address',
    'Test-CccSameIpv4Prefix'
)
