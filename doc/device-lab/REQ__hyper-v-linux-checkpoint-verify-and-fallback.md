---
area: device-lab
slug: hyper-v-linux-checkpoint-verify-and-fallback
status: current
---

# REQ — Checkpoint observation must tolerate Get-VMSnapshot visibility lag

## Requirement
`New-CccVmSnapshot` (scripts/host-control/hyper-v/Ccc.HyperV.Snapshots.psm1) MUST,
after `Checkpoint-VM`, tolerate the lag between the checkpoint being created and
`Get-VMSnapshot` reporting it. The post-create observation MUST re-fetch the VM
object and bounded-retry the snapshot query until the expected snapshot appears
(≈10 × 500 ms), BEFORE asserting count/id/name/type:

```
$Snapshots = @(); $AllSnapshots = @()
for ($ObsAttempt = 1; $ObsAttempt -le 10; $ObsAttempt++) {
    $Vm = & $VmReader $Vm.Id
    $AllSnapshots = @(& $SnapshotReader $Vm)
    $Snapshots = @($AllSnapshots | Where-Object { $_.Name -eq $SnapshotName })
    if ($Snapshots.Count -ge 1) { break }
    Start-Sleep -Milliseconds 500
}
```

It MUST NOT create a second checkpoint on a transiently-empty read.

## Why
On a Linux guest, a production `Checkpoint-VM` DOES create the checkpoint, but
`Get-VMSnapshot -VM $Vm` (using the pre-checkpoint `$Vm` object) does not always
report it on the first read. A single immediate observation saw zero snapshots
(`hyper-v-snapshot-observed-none-created`) even though the checkpoint existed
(a separate later process — the reconcile — saw it).

An earlier attempt to "fall back to a Standard checkpoint when no snapshot was
observed" was WRONG: because the production checkpoint had actually been created,
the fallback produced a SECOND snapshot with the same name → duplicate
(`hyper-v-snapshot-reconciliation-ambiguous` / `hyper-v-snapshot-standard-fallback-failed`).
The correct handling is to WAIT for the existing checkpoint to become visible, not
to create another one.

## Invariant / consistency
- The Standard fallback remains EXCEPTION-triggered only (`if ($CheckpointFailure)`),
  restoring/quarantining the VM CheckpointType as before — it must not be triggered
  by a transiently-empty observation read.
- Bounded retry + `$Vm` re-fetch is a legitimate eventual-visibility pattern,
  consistent with the module's other bounded retries (delete Stop-VM/Remove-VM).
- Non-masking: after the retry bound, the precise
  hyper-v-snapshot-observed-{none-created,name-mismatch,duplicate,id,name,type}
  assertions still fire, so a genuine failure is still identifiable.

## Regression coverage
- Native PowerShell parser (test:hyper-v:powershell) validates the module.

## History
- v1: exception-only fallback; single immediate observation → visibility lag
  produced false `observed-none-created`. Superseded.
- v2 (WRONG): fell back to Standard on a missing snapshot → duplicated the
  already-created production checkpoint (ambiguous). Reverted.
- v3 (current): observation re-fetches `$Vm` and bounded-retries until the created
  checkpoint is visible; no second checkpoint on an empty read.
