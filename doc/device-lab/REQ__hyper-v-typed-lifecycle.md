# Typed Hyper-V VM power lifecycle

Device Lab executes Hyper-V VM start, stop, and reboot through the typed Windows
operation library. It also uses the typed stop path when Linux or Windows guest
boot failure requires containment. Dry-run continues to show the compatible
PowerShell command projection without executing it.

## Ownership and state

- Every power operation targets the stored VM GUID and requires the canonical
  owner-scoped VM name and exact opaque Notes marker. Device Lab checks them
  before issuing a change, and the native operation checks them again on the
  selected VM immediately before mutation. A mismatch or missing VM fails
  without changing another VM.
- Starting an already Running VM is a no-op. For other states, Device Lab checks
  available host memory minus the larger of 2 GiB and 10% of total memory, and
  checks requested CPUs against twice the logical processor count before one
  Start-VM attempt. Owner quota remains a separate admission check.
- Stopping an Off VM is a no-op. Normal stop requests guest shutdown with Force;
  force stop requests TurnOff with Force. The returned state comes from a fresh
  observation of the same VM.
- Rebooting a Running VM invokes Restart-VM once with `-Force -Confirm:$false`
  after the identity guard, so its confirmation cannot fail in noninteractive
  PowerShell. Restart-VM always performs a hard restart; its Force switch
  suppresses confirmation, independent of the retained API force field.
  Rebooting an Off VM starts it only when startIfStopped is true. Other states
  and Off without that option fail with the existing fixed reboot error codes.
- The disposable Windows real-host E2E requests `force: true` explicitly. It
  proves the Hyper-V restart, readiness wait, and post-reboot PowerShell Direct
  path. Default and explicit-false API requests must use the same noninteractive
  native restart; there is no forced-shutdown fallback.

These semantics follow [Microsoft's Restart-VM documentation](https://learn.microsoft.com/en-us/powershell/module/hyper-v/restart-vm?view=windowsserver2025-ps).

## Failure and recovery

- One broker deadline bounds each transaction. A timeout or lost response after
  a possible mutation is uncertain; Device Lab retains its operation journal
  and does not retry inside the power transaction. A later journal reconciliation
  may issue one pending start or stop after a fresh owner-fenced inspection shows
  a stable terminal state that differs from the recorded intent, as specified by
  the existing lifecycle reconciliation contract.
- For an existing start journal, a fresh Saved observation of the exact owned VM
  is a stable terminal mismatch. Reconciliation may perform its existing single
  ordinary Start-VM replay, then re-observe and conditionally publish/clear only
  after Running is confirmed. It never removes saved state or forces a retry.
  Native failure, unchanged Saved or successor conflict retains the journal.
  Saved does not satisfy stop: canonical Off remains required. Unknown or
  transitional states remain pending. Status that reconciles an existing start
  journal can perform this established mutation; it is not a read-only workaround.
- A successful power call requires exact VM identity in its final observation.
  The broker retains guest readiness, diagnostic, and public response behavior.
  Failure containment succeeds only when a fresh read of that exact VM says Off;
  otherwise it reports and persists the containment failure.
- Public errors and execution diagnostics contain fixed bounded codes, without
  raw PowerShell output, host paths, credentials, or guest secrets. The existing
  dry-run and response fields remain compatible.

## Verification

Unit tests cover the state matrix, capacity boundaries, native identity guard,
Restart-VM confirmation suppression, and uncertain mutation handling. Broker integration
tests cover Windows/Linux power commands, both containment paths, journals,
redaction, and dry-run parity. Linux static checks do not constitute native
Windows Hyper-V proof; that remains a parent Goal gate.
