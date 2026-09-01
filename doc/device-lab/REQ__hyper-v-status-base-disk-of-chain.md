---
area: device-lab
slug: hyper-v-status-base-disk-of-chain
status: current
---

# REQ — Status must report the base disk of the active differencing chain

## Requirement
`hyperVStatusCommand` (src/host-control/hyper-v/lifecycle.ts) MUST report, as
`diskPath`, the BASE disk of the VM's active differencing chain — not the active
disk itself. It resolves the active `Get-VMHardDiskDrive` path by walking
`Get-VHD ... ParentPath` to the root before reporting:

```
$DiskPathValue = if ($Disk) { [string]$Disk.Path } else { $null }
if ($DiskPathValue) {
    try {
        $DiskChainVhd = Get-VHD -Path $DiskPathValue -ErrorAction Stop
        while ($DiskChainVhd -and $DiskChainVhd.ParentPath) {
            $DiskPathValue = [string]$DiskChainVhd.ParentPath
            $DiskChainVhd = Get-VHD -Path $DiskPathValue -ErrorAction Stop
        }
    } catch { }
}
```

## Why
The broker validates VM identity/ownership by comparing the status observation's
`diskPath` against the expected `root.vhdx` (device-lab-broker.ts snapshot_list
~4545, and the status/reconcile paths). After a checkpoint, Hyper-V swaps the VM's
ACTIVE disk to a `root-<GUID>.avhdx` differencing disk, so the active path never
equals `root.vhdx` → `hyper-v-snapshot-list-invalid-result` (and analogous
failures for restore/reconcile). Reporting the base of the chain keeps all those
comparisons valid whether or not a checkpoint exists.

## Invariant / consistency
- No checkpoint: the active disk IS `root.vhdx` (no parent) → reports `root.vhdx`
  (unchanged for the common case).
- With checkpoint(s), including nested: walks to the base `root.vhdx`.
- `Get-VHD` failure is caught, falling back to the active path (no regression vs
  the prior behavior in that error case).
- Same avhdx theme as [[hyper-v-delete-disk-guard-subset]]: checkpoint differencing
  disks must not break owner/identity disk comparisons.

## Regression coverage
- The assembled status PowerShell is validated by the contract/native parser.

## History
- v1: status reported the active disk; post-checkpoint diskPath was the `.avhdx`,
  breaking list/restore/reconcile identity comparisons. Superseded.
- v2 (current): status reports the base disk of the active differencing chain.
