---
area: device-lab
slug: hyper-v-delete-disk-guard-subset
status: current
---

# REQ — Hyper-V delete/orphan disk-ownership guard = owned-directory containment

## Requirement
`hyperVDeleteCommand` and `hyperVRecoverOrphanCommand` (src/host-control/hyper-v/
lifecycle.ts) MUST verify attached-hard-disk ownership by **owned-directory
containment**, not exact set-equality and not a pure expected-set subset:

```
$OwnedDiskDir = [IO.Path]::GetFullPath((Split-Path -Parent $ExpectedDisk))   # deviceRoot\disks
if (-not $OwnedDiskDir.EndsWith([IO.Path]::DirectorySeparatorChar)) { $OwnedDiskDir += [IO.Path]::DirectorySeparatorChar }
if (@($Attached | Where-Object { $ExpectedDiskPaths -notcontains $_ -and -not $_.StartsWith($OwnedDiskDir, [StringComparison]::OrdinalIgnoreCase) }).Count -ne 0) { throw 'hyper-v-vm-disk-ownership-mismatch' }
```

An attached hard disk is accepted if it is in the expected set **OR** resides
under the owned disks directory. A disk attached from OUTSIDE that directory
still trips the guard.

## Why (the checkpoint trap)
The owned disks directory (`deviceRoot\disks`) is owner+device scoped and holds
only this device's disks. When a Hyper-V VM has a **checkpoint**, Hyper-V swaps
the active disk from `root.vhdx` to a **differencing disk `root-<GUID>.avhdx`**,
created **in the same folder as the parent**. So `Get-VMHardDiskDrive` returns an
`.avhdx` path that equals neither the exact expected set nor a subset of it.

- Exact set-equality → false `hyper-v-vm-disk-ownership-mismatch` on the count.
- Pure subset (`$ExpectedDiskPaths -notcontains`) → STILL false mismatch, because
  `.avhdx` ∉ `{root.vhdx}`. (This is why the earlier exact→subset change did not
  fix the E2E once runs reached the checkpoint stage.)
- Owned-directory containment → the `.avhdx` sibling is recognised as ours.

The residue cleaned in E2E step 1 comes from prior runs that reached the
checkpoint stage, so its active disk is an `.avhdx`.

## Invariant / consistency
- **Ownership authority** is the `Notes` marker (owner+device+incarnation),
  verified before any disk inspection. The disk guard is secondary.
- `hyperVRecoverOrphanCommand` marked-VM disk check MUST use the same
  containment relaxation. Its **unmarked**-VM path stays strict (single expected
  disk) — with no marker there is no ownership proof, so no leniency.
- The delete media (DVD) guard stays a plain subset check — DVD media
  (`cidata.iso`/`autounattend.iso`) has no differencing variants.

## Cleanup
After `Remove-VM`, `hyperVDeleteCommand` MUST remove leftover `*.avhdx`
differencing disks in the owned directory (via `Remove-OwnedItemWithRetry`,
retaining `Assert-NoReparsePath` safety); otherwise checkpoint diffs orphan on
disk after the primary `root.vhdx` is removed.

## Regression coverage
- src/__tests__/device-lab-hyper-v-provider.test.ts asserts the containment
  check string, `$OwnedDiskDir`, the `.avhdx` cleanup, and the absence of
  `Compare-Object` / `$Attached.Count -ne $ExpectedDiskPaths.Count`.

## History
- v1: exact set-equality → rejected partial-create residue. Superseded.
- v2: pure subset → still rejected checkpoint `.avhdx` residue. Superseded.
- v3 (current): owned-directory containment — tolerates checkpoint differencing
  disks while still rejecting foreign disks. Do NOT revert to (1) or (2).
