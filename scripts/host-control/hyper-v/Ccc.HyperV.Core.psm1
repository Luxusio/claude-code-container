Set-StrictMode -Version 3.0

function Read-CccJsonContract {
    [CmdletBinding()]
    param()

    $Builder = New-Object Text.StringBuilder
    $Buffer = New-Object char[] 1
    $ByteCount = 0
    while (($Read = [Console]::In.Read($Buffer, 0, 1)) -gt 0) {
        $Character = [string]$Buffer[0]
        $ByteCount += [Text.Encoding]::UTF8.GetByteCount($Character)
        if ($ByteCount -gt 65536) { throw 'hyper-v-powershell-contract-invalid' }
        [void]$Builder.Append($Character)
    }
    $Raw = $Builder.ToString()
    if (-not $Raw) {
        throw 'hyper-v-powershell-contract-invalid'
    }
    try {
        $Contract = $Raw | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        throw 'hyper-v-powershell-contract-invalid'
    }
    if ($null -eq $Contract -or $Contract -is [Array]) {
        throw 'hyper-v-powershell-contract-invalid'
    }
    return $Contract
}

function Assert-CccContractProperties {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [object] $Contract,
        [Parameter(Mandatory = $true)] [string[]] $Required,
        [string[]] $Optional = @()
    )

    $Allowed = @($Required) + @($Optional)
    $Observed = @($Contract.PSObject.Properties.Name)
    foreach ($Name in $Required) {
        if ($Observed -cnotcontains $Name) { throw 'hyper-v-powershell-contract-invalid' }
    }
    foreach ($Name in $Observed) {
        if ($Allowed -cnotcontains $Name) { throw 'hyper-v-powershell-contract-invalid' }
    }
}

function Assert-CccOwnedVmContract {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)] [object] $Contract)

    Assert-CccContractProperties $Contract @('schemaVersion', 'vmId', 'vmName', 'ownershipMarker')
    if ($Contract.schemaVersion.GetType().Name -notin @('Int32', 'Int64') -or [long]$Contract.schemaVersion -ne 1) {
        throw 'hyper-v-powershell-contract-version-unsupported'
    }
    if ($Contract.vmId -isnot [string] -or $Contract.vmId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') {
        throw 'hyper-v-powershell-contract-invalid'
    }
    if ($Contract.vmName -isnot [string] -or $Contract.vmName -notmatch '^ccc-[a-f0-9]{16}-[a-z0-9-]{1,32}-[a-f0-9]{32}$') {
        throw 'hyper-v-powershell-contract-invalid'
    }
    if ($Contract.ownershipMarker -isnot [string] -or $Contract.ownershipMarker -notmatch '^ccc-device-lab:[a-f0-9]{16}:(?!\.\.?$)[A-Za-z0-9._:-]{1,128}:[a-f0-9]{32}$') {
        throw 'hyper-v-powershell-contract-invalid'
    }
}

function Get-CccOwnedVm {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)] [object] $Contract)

    Assert-CccOwnedVmContract $Contract
    $ExpectedId = [Guid][string]$Contract.vmId
    $Matches = @(Get-CccVmById $ExpectedId)
    if ($Matches.Count -eq 0) { throw 'hyper-v-vm-not-found' }
    if ($Matches.Count -ne 1) { throw 'hyper-v-vm-identity-ambiguous' }
    $Vm = $Matches[0]
    if ([string]$Vm.Id -ne [string]$ExpectedId -or $Vm.Name -ne [string]$Contract.vmName -or [string]$Vm.Notes -cne [string]$Contract.ownershipMarker) {
        throw 'hyper-v-vm-ownership-mismatch'
    }
    return $Vm
}

function Get-CccVmById {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)] [Guid] $VmId)

    return @(Get-VM -Id $VmId -ErrorAction SilentlyContinue)
}

Export-ModuleMember -Function @(
    'Assert-CccContractProperties',
    'Assert-CccOwnedVmContract',
    'Get-CccOwnedVm',
    'Read-CccJsonContract'
)
