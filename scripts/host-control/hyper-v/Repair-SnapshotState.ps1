$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version 3.0

$TrustedModuleRoot = Join-Path $PSHOME 'Modules'
$env:PSModulePath = $TrustedModuleRoot
Import-Module Hyper-V -ErrorAction Stop
Import-Module (Join-Path $PSScriptRoot 'Ccc.HyperV.Core.psm1') -Force -ErrorAction Stop
Import-Module (Join-Path $PSScriptRoot 'Ccc.HyperV.Snapshots.psm1') -Force -ErrorAction Stop

$Contract = Read-CccJsonContract
Assert-CccContractProperties $Contract @('schemaVersion', 'vmId', 'vmName', 'ownershipMarker', 'snapshotName', 'expectedCheckpointPolicy')
if ($Contract.snapshotName -isnot [string] -or $Contract.snapshotName -notmatch '^ccc-[a-f0-9]{16}-(?!\.\.?$)[A-Za-z0-9._:-]{1,128}$') {
    throw 'hyper-v-snapshot-name-invalid'
}
if ($Contract.expectedCheckpointPolicy -ne 'Production' -and $Contract.expectedCheckpointPolicy -ne 'ProductionOnly') {
    throw 'hyper-v-snapshot-policy-invalid'
}
$OwnedVmContract = [pscustomobject]@{
    schemaVersion = $Contract.schemaVersion
    vmId = $Contract.vmId
    vmName = $Contract.vmName
    ownershipMarker = $Contract.ownershipMarker
}
$Vm = Get-CccOwnedVm $OwnedVmContract
Repair-CccVmSnapshotState -Vm $Vm -SnapshotName ([string]$Contract.snapshotName) -ExpectedPolicy ([string]$Contract.expectedCheckpointPolicy) | ConvertTo-Json -Compress -Depth 5
