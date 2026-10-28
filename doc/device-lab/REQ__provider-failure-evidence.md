# Provider failure evidence

Status: derived implementation contract, 2026-10-26.

## Basis and outcome

The user requests repairs based on saved failures and actual Mac verification.
The subsequent Level 3 run reaches 84 passed records and four failures after
endpoint isolation. Its iOS diagnostic retains only the tool name, two Tart
diagnostics omit nested boot evidence, and one internal broker assertion loses
its process-verification evidence during message truncation. These facts are
recorded in the [failure chronology](../changes/2026-10-22-test-failure-groups.md).

The following diagnostic choices derive from those missing facts. They do not
establish an underlying native timeout, changed process, shell or boot failure.
Preserve failures until actual host evidence establishes their cause.

The next native run reports iOS exit 111 without a timeout, and both Tart
failures now identify IP-readiness expiry. The packaged public missing-device
assertion still loses an unexpected broker refusal. Exit 111 alone does not
establish a missing shell or any specific simulator error.

## Observable behavior

iOS observation/access command failures retain their existing error text and
`isError` result, and additionally expose selected native execution facts through
the standard MCP `structuredContent` object. Retain status, signal, timeout and
closed error/diagnostic codes when present. Do not add raw output, command
arguments, paths or credentials to that object. Do not change simulator commands,
ownership admission, retries or time limits as part of this correction.
When every Simulator app-wait probe fails, preserve the final receipt's status,
signal, error code and explicit timeout flag through the application boundary
into that existing selected projection. Do not spread the native receipt or
Error object. A direct Oct28 Mac reproduction returned `ETIMEDOUT` and
`SIGTERM`; rebuilding the error from text and status alone had incorrectly
reported `native-unknown` with a false timeout. This corrects evidence loss;
it does not establish which probe timed out or make Safari observation pass.
For simctl failures, additionally retain at most four observed error domain/code
pairs from the first 16 KiB of stderr. Domains are limited to
`NSPOSIXErrorDomain`, `NSCocoaErrorDomain`, and
`com.apple.CoreSimulator.SimError`, `com.apple.CoreSimulator.LaunchdSimError`,
and `SimXPCErrorDomain`; codes must be signed 32-bit integers. The latter two
were observed in a direct host reproduction of the saved exit-111 failure.
A fixed `spawn` stage may be recorded only when stderr explicitly describes a
spawn failure. Unknown domains, free text and exit-code interpretations are
omitted. Keep this selected `execution.simctl` object through presentation and
the saved-evidence projection; preserve ordinary nonzero exits without adding
an inferred simulator cause.

The observed sentence `Process spawn via launchd failed.` also establishes the
fixed `spawn` stage. It does not by itself establish a missing shell or identify
why launchd rejected its program arguments. Do not change execution behavior
based only on exit 111 or on a simulator's `Booted` label.

Mac desktop command failures use the same structured native observation shape
while preserving their existing error text and `isError`. Select status, known
OS signal/errno, boolean timeout and the existing closed native diagnostic code
from the actual SSH/SCP receipt. Missing bridge prerequisites without a native
receipt remain unclassified; do not manufacture a command failure observation.
Keep commands, success criteria, permissions, retries and deadlines unchanged.

Desktop readiness and its independent saved-evidence projection also retain
`execution.timedOut` and a known `execution.diagnosticCode`. Explicit timeout
alone is an observed native failure; false timeout or an unknown diagnostic code
is not. A later native provider observation replaces an older retained broker
transport observation with the later attempt number. Do not interpret an older
transport observation as the final cause. Preserve the separate existing process
observation shape and omit raw output, host paths and credentials throughout.

The real-test parser prefers valid structured failure objects and otherwise
retains its existing JSON-content handling. Saved evidence and short messages
select only bounded diagnostic facts. Recognize Tart's actual lifecycle shape
at `result.execution.command.macosBoot`, alongside existing boot shapes. Keep
start-process failures distinguishable from IP-readiness failures using observed
facts; missing evidence stays missing. Internal unexpected broker errors use
the same diagnostic writer before assertion messages lose their payload.
Public missing-target probes mark an error expected only after matching
`device-not-found` or `device-backend-not-found`. Other errors keep their
selected evidence and remain unexpected in tool coverage. Existing exact
single-code expectations retain their behavior.

The helper preparation result is distinct from the VM launch execution. Derived
from the existing broker's `result.helperPreparation` response, saved evidence
and short messages retain a separate `helperPreparation` object: a known helper
preparation error, an observed provider from `ssh`, `scp`, `ssh-scp`, `local` or
`ssh-key-policy`, and existing bounded native execution fields when present.
Select only the actual `body.result.helperPreparation` or
`result.helperPreparation` envelope. Never copy helper SSH metadata, paths,
timestamps, raw output or arbitrary codes. A successful Tart launch must not
replace the failed helper's execution facts. See the
[helper response contract](REQ__macos-broker-helper-readiness.md).

When helper polling expires after an observed native command, preserve that
last receipt internally so the existing preparation boundary can select its
execution metadata. The synthesized timeout receipt contains only native status,
a known OS signal and an observed `ETIMEDOUT` code; required stdout/stderr fields
are empty. Direct lifecycle presentation must not expose newly retained raw
output through this timeout result. Existing observed-failure behavior is
unchanged. Keep the timeout error, retry rules, cadence and late-result
admission unchanged. Missing native observations remain missing; these facts do
not establish the underlying SSH or guest failure.

When a helper child is terminated before returning its final result, preserve
an observed `helperPreparation.firstFailure` from its one bounded progress
frame. Independently select only `ssh`/`scp`, bounded native execution facts
and the closed connection categories defined in the
[helper readiness contract](REQ__macos-broker-helper-readiness.md). Keep this
first failure separate from parent termination and VM launch execution in
saved evidence and short messages. Unknown fields and categories are omitted;
raw SSH output, targets, commands and credentials must never be copied.

MCP native broker observations use completed command output for ownership
verification. Preserve fixed executables, full command width, exact entry/PID/
birth/status checks, and existing allowances. Failed, interrupted or incomplete
observations refuse verification. Closed observation-stage codes may explain
refusal; they do not supply authority to restart or signal a process.

Artifacts continue to omit host paths, credentials, endpoints and raw command
output. A diagnostic-write failure preserves the original operation failure.
Short messages remain bounded. No retry, timeout increase or skip may turn these
four observed failures into passes without a demonstrated correction.

## Verification

The Oct27 run demonstrates a listener observation timeout and two desktop
control readiness failures whose provider causes were discarded. Preserve the
last observed, allowlisted readiness failure with its attempt number across
later unclassified errors or exceptions. Distinguish broker-process,
broker-transport and provider stages only from known error codes or selected
native facts. Retain bounded native status/signal/error codes and process
observation fields; omit arbitrary messages, paths, output and credentials.
The normalized process observation uses `errorCode`; raw native `code` is
translated at the adapter and independently selected again by the artifact
writer. Diagnostic history must not change the current probe's success rules.
Reapply the same closed projection when saving real-test diagnostics. Deadlines,
probe cadence and readiness success rules stay unchanged.

A module that throws retains its already-recorded MCP calls and sessions in
both sequential and child-worker execution. The collector ingests those facts
before recording the module failure. Preserve call order/backend/session and
existing validation, bounded worker transport and privacy behavior. A recorded
call is not a successful scenario; failed modules still fail and return nonzero.

Use private native-command and MCP fixtures to prove complete observation
requirements, structured iOS transport, actual nested Tart boot shapes, internal
assertion evidence and sensitive-field omission. Keep process start failure,
IP timeout and unknown observations distinct. Run only affected owners and
relevant regression checks. Native Mac execution remains required to establish
the residual provider failures' actual causes and acceptance.
