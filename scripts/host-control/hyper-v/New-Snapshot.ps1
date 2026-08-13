$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version 3.0

$TrustedModuleRoot = Join-Path $PSHOME 'Modules'
$env:PSModulePath = $TrustedModuleRoot
Import-Module Hyper-V -ErrorAction Stop
Import-Module (Join-Path $PSScriptRoot 'Ccc.HyperV.Core.psm1') -Force -ErrorAction Stop
Import-Module (Join-Path $PSScriptRoot 'Ccc.HyperV.Snapshots.psm1') -Force -ErrorAction Stop

$Contract = Read-CccJsonContract
Assert-CccContractProperties $Contract @('schemaVersion', 'vmId', 'vmName', 'ownershipMarker', 'snapshotName')
if ($Contract.snapshotName -isnot [string] -or $Contract.snapshotName -notmatch '^ccc-[a-f0-9]{16}-(?!\.\.?$)[A-Za-z0-9._:-]{1,128}$') {
    throw 'hyper-v-snapshot-name-invalid'
}
$OwnedVmContract = [pscustomobject]@{
    schemaVersion = $Contract.schemaVersion
    vmId = $Contract.vmId
    vmName = $Contract.vmName
    ownershipMarker = $Contract.ownershipMarker
}
$Vm = Get-CccOwnedVm $OwnedVmContract
New-CccVmSnapshot -Vm $Vm -SnapshotName ([string]$Contract.snapshotName) | ConvertTo-Json -Compress -Depth 5
