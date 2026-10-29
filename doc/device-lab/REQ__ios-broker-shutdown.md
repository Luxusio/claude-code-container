# iOS broker shutdown confirmation

Status: derived repair contract, updated 2026-10-29.

Saved Mac execution proves that a successful `simctl shutdown` receipt can be
followed immediately by a native inventory reporting `Booted` for the exact
target. The broker must confirm native `Shutdown` before publishing `stopped`.
The observation establishes a mismatch, not its CoreSimulator timing cause.

After auxiliary cleanup, capture one monotonic allowance using the existing
command timeout. Shutdown execution, subsequent inventory calls, polling pauses
and final admission share that allowance. Do not increase it or claim it covers
earlier owner-lock wait and planning.

If the first command succeeds but a timely, identity-verified observation still
reports `Booted`, permit one guarded reissue of the original shutdown effect.
There are at most two shutdown commands in one stop operation. Do not reissue
for `Shutting Down`, unknown or failed observations, initial command failure,
or exhausted allowance. This finite recovery addresses the observed first
request failing to settle; it does not establish why CoreSimulator behaved so.

Immediately before reissue, acquire the existing owner inventory mutation lock
using only the remaining allowance and compare the complete auxiliary-cleaned
expected record. A missing or changed record refuses the second command and
preserves the successor. Check the positive integer remainder inside the lock
before executing. Release the lock before polling pauses. Reuse the original
opaque effect; do not select another target or adopt a new record.

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
`recoveryRequired:true`. An initial native shutdown command failure retains the existing
`provider-command-failed` response without settlement facts. An allowance exhausted before
execution reports `invoked:false` without claiming a new partial native effect.
The separate `shutdown` facts contain completion,
attempt count, the last allowlisted state and timeout/observation-failure reason;
they contain no raw inventory or identity fields.
An unavailable observation must not erase the last recognized state. When a
reissue executes, `commandAttempts: 2` and a separately rendered `retryExecution`
preserve that fact without overwriting the original native receipt. Continue
confirmation after a failed reissue: success requires the first accepted
command, timely native `Shutdown` and final complete-record comparison, even
if the second command raced with an already completed shutdown. Without that
confirmation, failed retry receipts cannot make stop succeed.
The complete-record comparison still protects successors after confirmation.
Polling retains the device operation lock and yields between observations.

Protocol 13 requires this bounded recovery implementation. Replacement uses existing
verified broker repair. The isolated Level 3 broker remains separate from the
installed broker. Direct-provider and physical-device behavior is unchanged.

Verify immediate and delayed confirmation, guarded reissue, permanent `Booted`
capped at two commands, `Shutting Down` without reissue, failed reissue followed
by confirmed shutdown, retry receipt separation, lock-wait expiry and successor
replacement before reissue. Also verify late success,
native shutdown failure, inventory errors and identity ambiguity, decreasing
native timeouts, and successor preservation through existing lifecycle/HTTP
fixtures. Portable checks do not establish actual Mac acceptance; confirm it
with a fresh host broker execution and the strict existing native assertion.
