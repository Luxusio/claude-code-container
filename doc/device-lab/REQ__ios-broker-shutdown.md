# iOS broker shutdown confirmation

Status: derived repair contract, 2026-10-28.

Saved Mac execution proves that a successful `simctl shutdown` receipt can be
followed immediately by a native inventory reporting `Booted` for the exact
target. The broker must confirm native `Shutdown` before publishing `stopped`.
The observation establishes a mismatch, not its CoreSimulator timing cause.

After auxiliary cleanup, capture one monotonic allowance using the existing
command timeout. Shutdown execution, subsequent inventory calls, polling pauses
and final admission share that allowance. Do not increase it or claim it covers
earlier owner-lock wait and planning. Do not issue shutdown repeatedly.

Resolve the exact UDID and recorded owner-prefixed name using the existing
native inventory identity rules. Only one matching, timely `Shutdown` record
confirms completion. Retry `Booted` or `Shutting Down` within the remainder.
Failed, malformed, missing, duplicate, renamed or unexpected observations do not
prove completion. Late success also fails admission.

Keep the original shutdown execution receipt, including status 0, separate from
selected settlement diagnostics. An unconfirmed stop fails without publishing
`stopped`; it neither erases nor reboots nor automatically deletes the target.
After a successful native shutdown whose settlement remains unconfirmed, the
broker returns HTTP 502 with `ios-simulator-shutdown-not-confirmed` and
`recoveryRequired:true`. A native shutdown command failure retains the existing
`provider-command-failed` response without settlement facts. An allowance exhausted before
execution reports `invoked:false` without claiming a new partial native effect.
The separate `shutdown` facts contain completion,
attempt count, the last allowlisted state and timeout/observation-failure reason;
they contain no raw inventory or identity fields.
The complete-record comparison still protects successors after confirmation.
Polling retains the device operation lock and yields between observations.

Protocol 11 requires this in-memory implementation. Replacement uses existing
verified broker repair. The isolated Level 3 broker remains separate from the
installed broker. Direct-provider and physical-device behavior is unchanged.

Verify immediate and delayed confirmation, permanent `Booted`, late success,
native shutdown failure, inventory errors and identity ambiguity, decreasing
native timeouts, and successor preservation through existing lifecycle/HTTP
fixtures. Portable checks do not establish actual Mac acceptance; confirm it
with a fresh host broker execution and the strict existing native assertion.
