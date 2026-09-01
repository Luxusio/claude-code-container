Set-StrictMode -Version 3.0

function New-CccVmSnapshot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [object] $Vm,
        [Parameter(Mandatory = $true)] [string] $SnapshotName,
        [Parameter(Mandatory = $true)] [ValidateSet('Production', 'ProductionOnly')] [string] $ExpectedPolicy,
        [scriptblock] $SnapshotReader = { param($TargetVm) @(Get-VMSnapshot -VM $TargetVm -ErrorAction Stop) },
        [scriptblock] $SnapshotCreator = { param($TargetVm, $Name) Checkpoint-VM -VM $TargetVm -SnapshotName $Name -ErrorAction Stop },
        [scriptblock] $SnapshotRemover = { param($Candidates) $Candidates | Remove-VMSnapshot -Confirm:$false -ErrorAction Stop },
        [scriptblock] $PolicyWriter = { param($TargetVm, $Policy) Set-VM -VM $TargetVm -CheckpointType $Policy -ErrorAction Stop },
        [scriptblock] $VmReader = { param($VmId) Get-VM -Id $VmId -ErrorAction Stop }
    )

    $CheckpointType = [string]$Vm.CheckpointType
    if ($CheckpointType -ne $ExpectedPolicy) { throw 'hyper-v-snapshot-policy-invalid' }
    if (@(& $SnapshotReader $Vm | Where-Object { $_.Name -eq $SnapshotName }).Count -ne 0) { throw 'hyper-v-snapshot-already-exists' }

    function Remove-Candidate {
        try {
            $Candidates = @(& $SnapshotReader $Vm | Where-Object { $_.Name -eq $SnapshotName })
            if ($Candidates.Count -gt 1) { throw 'hyper-v-snapshot-reconciliation-ambiguous' }
            if ($Candidates.Count -gt 0) { $null = & $SnapshotRemover $Candidates }
            if (@(& $SnapshotReader $Vm | Where-Object { $_.Name -eq $SnapshotName }).Count -ne 0) { throw 'candidate-remains' }
        } catch {
            if ([string]$_.Exception.Message -eq 'hyper-v-snapshot-reconciliation-ambiguous') { throw }
            throw 'hyper-v-snapshot-reconciliation-failed'
        }
    }

    $CheckpointFailure = $null
    try { $null = & $SnapshotCreator $Vm $SnapshotName } catch { $CheckpointFailure = $_ }
    if ($CheckpointFailure) {
        Remove-Candidate
        if ($CheckpointType -ne 'Production') { throw $CheckpointFailure }

        $FallbackFailure = $null
        $PolicyRestoreFailure = $null
        $PolicyQuarantineFailure = $null
        try {
            $null = & $PolicyWriter $Vm 'Standard'
            $null = & $SnapshotCreator $Vm $SnapshotName
        } catch {
            $FallbackFailure = $_
        } finally {
            try {
                $null = & $PolicyWriter $Vm 'Production'
                $Vm = & $VmReader $Vm.Id
                if ([string]$Vm.CheckpointType -ne 'Production') { throw 'restore-unconfirmed' }
            } catch {
                $PolicyRestoreFailure = $_
                try {
                    $null = & $PolicyWriter $Vm 'Disabled'
                    $Vm = & $VmReader $Vm.Id
                    if ([string]$Vm.CheckpointType -ne 'Disabled') { throw 'quarantine-unconfirmed' }
                } catch { $PolicyQuarantineFailure = $_ }
            }
        }
        if ($FallbackFailure -or $PolicyRestoreFailure -or $PolicyQuarantineFailure) {
            Remove-Candidate
            if ($PolicyQuarantineFailure) { throw 'hyper-v-snapshot-policy-quarantine-failed' }
            if ($PolicyRestoreFailure) { throw 'hyper-v-snapshot-policy-restore-failed' }
            throw 'hyper-v-snapshot-standard-fallback-failed'
        }
    }

    # Get-VMSnapshot can lag behind Checkpoint-VM: the just-created checkpoint is not always
    # visible on the first read. Re-fetch the VM and bounded-retry until it appears (do NOT create
    # a second checkpoint on a transiently-empty read — that would duplicate the snapshot).
    try {
        $Snapshots = @()
        $AllSnapshots = @()
        for ($ObsAttempt = 1; $ObsAttempt -le 10; $ObsAttempt++) {
            $Vm = & $VmReader $Vm.Id
            $AllSnapshots = @(& $SnapshotReader $Vm)
            $Snapshots = @($AllSnapshots | Where-Object { $_.Name -eq $SnapshotName })
            if ($Snapshots.Count -ge 1) { break }
            Start-Sleep -Milliseconds 500
        }
        if ($Snapshots.Count -ne 1) { throw 'invalid-observation' }
        if ($Snapshots[0].Id -isnot [Guid]) { throw 'invalid-observation' }
        if ([string]$Snapshots[0].Name -ne $SnapshotName) { throw 'invalid-observation' }
        if ([string]::IsNullOrWhiteSpace([string]$Snapshots[0].SnapshotType)) { throw 'invalid-observation' }
    } catch {
        Remove-Candidate
        throw 'hyper-v-snapshot-create-invalid-result'
    }
    $Snapshot = $Snapshots[0]
    return [ordered]@{ ok = $true; snapshotId = [string]$Snapshot.Id; snapshotName = [string]$Snapshot.Name; snapshotType = [string]$Snapshot.SnapshotType }
}

function Repair-CccVmSnapshotState {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [object] $Vm,
        [Parameter(Mandatory = $true)] [string] $SnapshotName,
        [Parameter(Mandatory = $true)] [ValidateSet('Production', 'ProductionOnly')] [string] $ExpectedPolicy
    )

    if ([string]$Vm.CheckpointType -eq 'Disabled') { throw 'hyper-v-snapshot-policy-quarantined' }
    if ([string]$Vm.CheckpointType -ne $ExpectedPolicy) {
        try {
            Set-VM -VM $Vm -CheckpointType $ExpectedPolicy -ErrorAction Stop
            $Vm = Get-VM -Id $Vm.Id -ErrorAction Stop
            if ([string]$Vm.CheckpointType -ne $ExpectedPolicy) { throw 'restore-unconfirmed' }
        } catch {
            try {
                Set-VM -VM $Vm -CheckpointType Disabled -ErrorAction Stop
                $Vm = Get-VM -Id $Vm.Id -ErrorAction Stop
                if ([string]$Vm.CheckpointType -ne 'Disabled') { throw 'quarantine-unconfirmed' }
            } catch { throw 'hyper-v-snapshot-policy-quarantine-failed' }
            throw 'hyper-v-snapshot-policy-restore-failed'
        }
    }

    $Candidates = @(Get-VMSnapshot -VM $Vm -ErrorAction Stop | Where-Object { $_.Name -eq $SnapshotName })
    if ($Candidates.Count -gt 1) { throw 'hyper-v-snapshot-reconciliation-ambiguous' }
    return [ordered]@{ ok = $true; checkpointPolicy = [string]$Vm.CheckpointType; candidateCount = $Candidates.Count }
}

Export-ModuleMember -Function 'New-CccVmSnapshot', 'Repair-CccVmSnapshotState'
