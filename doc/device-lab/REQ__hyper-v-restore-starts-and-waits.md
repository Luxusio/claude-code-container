---
area: device-lab
slug: hyper-v-restore-starts-and-waits
status: current
---

# REQ — device_snapshot_restore must start the VM and wait for guest readiness

## Requirement
For a Linux VM, `device_snapshot_restore` MUST leave the device immediately
usable: the restore provider command starts the VM after `Restore-VMSnapshot`
(if not already Running), and the broker then polls guest SSH readiness
(`hyperVLinuxSshReadyCommand` → `ccc-hyper-v-linux-ready`) up to a bounded
deadline before returning success. The device is recorded `status: "running"`,
`runtimeState: "Running"`, `bootReady: true`. On readiness timeout it returns
`hyper-v-linux-guest-provider-failed`; on missing guest metadata,
`hyper-v-linux-guest-metadata-invalid`.

## Why
A production checkpoint saves no guest memory, so `Restore-VMSnapshot` leaves the
VM OFF. `device_exec`/`device_upload`/`device_download` do NOT start devices
(`startsDevices: false`), so a `device_exec` issued right after a restore ran
against a non-running guest and timed out (`hyper-v-linux-guest-provider-failed`,
step "verify SSH after checkpoint restore"). Starting the VM and waiting for SSH
readiness during restore makes the restored device usable, matching the
restore-then-use contract.

## Invariant / consistency
- If the restore returned a running (Standard) checkpoint, `Start-VM` is skipped.
- The readiness poll reuses the exact SSH-ready command the create/start flow uses.
- Non-masking: a readiness timeout surfaces a real error.
- Related: [[hyper-v-linux-checkpoint-verify-and-fallback]] (checkpoint create),
  [[hyper-v-status-base-disk-of-chain]] (post-checkpoint disk identity).

## Regression coverage
- Broker unit tests (device-lab-hyper-v-linux-broker, device-lab-broker.commands):
  the shared `hyper-v-ssh` mock returns the ready marker; restore now records the
  running/started device state.

## History
- v1: restore left the VM off (status stopped); device_exec-after-restore failed.
  Superseded.
- v2 (current): restore starts the VM and waits for guest SSH readiness.
