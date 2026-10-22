# CCC session exit cleanup

The [guardian responsibility contract](REQ__session-mutation-lock-lifetime.md#guardian-responsibility-and-orphan-recovery)
defines the derived implementation rules for qualified observation, publication,
recovery and transfer used below, and records their requirement and planning basis.

The host CCC process must remain responsive to SIGINT, SIGTERM and SIGHUP while
an interactive container command runs. It must await that command asynchronously
with inherited terminal input and output. Noninteractive commands retain their
existing execution and exit-status behavior.

## Interactive terminal restoration

User-reported regression (2026-10-20): after an unexpected runtime/container
exit, moving the mouse in the former CCC terminal inserts text such as
`35;61;37M35;68;29M`. The requested outcome is a usable host terminal after
that disconnect. The implementation rules below are derived from that request
and the inherited-terminal lifetime above; the escape modes and native helpers
are technical choices, not separately user-prescribed APIs.

Before handing an actual inherited input/output TTY to an interactive local
runtime client or remote SSH client, capture the host terminal state. Restore
the terminal synchronously and idempotently before returning an exit status,
reporting a child error, propagating a synchronous spawn failure, or allowing
existing synchronous signal cleanup to exit. A temporary process-exit fallback
must be removed when that command settles. Preserve unrelated listeners and
the existing ownership and child-signal policies.

Disable child-enabled mouse reporting, including DEC modes 1000, 1002, 1003
and 1006, along with transient focus/paste, alternate-screen and hidden-cursor
state. Do not clear the terminal history or invoke a destructive full reset.
On POSIX, snapshot actual terminal attributes before launch and restore that
captured state with bounded, shell-free native commands. Node's `stdin.isRaw`
does not observe mode changes made by the separate runtime client and is not
sufficient proof of restoration. Cleanup is best effort and must not replace
the original child status or error. Noninteractive and redirected streams keep
their bytes and existing behavior; no competing stdin reader is introduced.

Verify the ordinary, failed, signalled and interrupted child paths, once-only
cleanup, exit fallback, spawn failure and remote callback ordering. An owned
POSIX PTY fixture must simulate a client enabling raw input and SGR mouse
reporting before abrupt death, then compare actual input attributes and observe
the disabling bytes before CCC hands control back. No real engine is needed.

Compare configured attributes exactly while distinguishing kernel-maintained
state. On Darwin, exclude only `PENDIN` from that equality: XNU sets this pending-input
state when returning to canonical mode even when it was absent from the supplied
attributes. Retain the raw difference for diagnostics and keep every other flag,
control character and speed exact. Do not consume or flush input to force equality.
The mouse-disabling assertions must still run. See [Apple's termios definition](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/termios.h#L248)
and [canonical-mode transition](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/tty.c#L1313).

Known ceiling: SIGKILL of CCC itself cannot run JavaScript cleanup. Missing or
failed native terminal restoration remains best effort. Portable fixtures do
not establish native Windows/macOS terminal execution or explain an engine
crash; those are separate evidence requirements.

On a handled termination signal, interrupt only the runtime client created by
this CCC invocation before the existing session cleanup handler can exit. Never
kill a daemon, unrelated process, or another project by name or age. Remove the
command's signal listeners after completion or launch failure. Input must have
one owner; this change must not add a competing terminal reader or replay a TUI.

After an authorized session exits, stop only its captured container ID under
the existing lifecycle lock. Any foreign ownership claim, including an unreadable
or uncertain claim, vetoes shared device cleanup. It also vetoes our exact stop
unless its current qualified acknowledgement names a different full container
ID. Do not infer dead ownership from container age or runtime selection.

Recover predecessors under that lifecycle guard before session reservation.
Positive owner death or start-token mismatch permits retiring a marked direct
claim. A monitored claim also requires qualified guardian observation and
settlement of its cleanup responsibility; parent death alone never permits
removal. Live, uncertain, unmarked legacy, unreadable or malformed claims remain
protected. After attempted retirement, enumerate raw files again: a failed
deletion still vetoes shared effects.

Diagnostic liveness observation, including `ccc doctor`, must not delete a dead
owner's receipt. It may omit a stale marked direct owner from the live count,
but monitored claims remain protected. Consuming a
receipt before a guardian cleans it or a successor inherits its cleanup obligation
can leave the container running without an owner.

Production recovery and reservation are one async lifecycle-guarded transaction.
Settle positively dead predecessors using their captured native runtime before
writing a new monitored reservation. Failed recovery retains the obligation and
prevents a successor reservation. Then capture the new receipt, positively
inspect an existing managed container, and establish guardian readiness and an
initial cleanup-disabled acknowledgement of that existing ID. Inspection errors
are not confirmed absence. A failed acquisition before startup releases only its
unchanged new reservation; a generic pending grant never becomes shutdown
authority. The project-family/worktree guard precedes the container guard.
Subsequent cleanup authority requires a current qualified cleanup-enabled ACK or
a positive own-start publication. A pending or rejected acquisition retains
receipt authorization (or detaches its failed context) through later CLI/signal
cleanup so a replacement cannot be deleted by an unguarded fallback.

Production session setup must establish a host-owned lifetime channel with a
per-session guardian and await bounded readiness before starting the container.
Host process disappearance closes that channel. Without waiting for another CCC
invocation, the guardian settles only its captured unchanged claim under the
same lifecycle guard. Removal requires no cleanup obligation, successful cleanup,
or a qualified handoff. Bind the claim's record and file identity; preserve a
same-path replacement or unreadable claim and its associated resources.

An acknowledged captured-container-ID handoff permits the guardian to reuse the
same last-owner cleanup workflow on owner disappearance. Before handoff, it must
not discover or stop a container by name. Normal successful cleanup releases the
guardian and all resources without replaying cleanup. Failed startup readiness
must abort visibly and reclaim only its own claim. Unexpected guardian loss must
surface and route through owned session failure cleanup.

Native stop must finish within a 30-second local subprocess budget. Only a clean
zero status counts as success. Spawn errors, signals, nonzero or absent statuses
must surface a bounded failure without raw runtime output or configuration
values. Failed stop must not finalize cleanup; a later call rechecks ownership
and can retry. Retain the own claim through device/container cleanup and remove
it only after successful stop or a qualified transfer to a current acknowledged
cleanup-enabled peer with the same exact ID and captured native authority. A
veto alone does not discharge an obligation. Non-ENOENT
claim removal errors remain failures. A timeout leaves the daemon-side outcome unknown.

For an ended host owner, retain the captured unchanged claim through guarded
foreign enumeration and device/container cleanup. The guardian acquires the
existing lifecycle guard asynchronously, including process-identity observation
on Windows, and reuses the cleanup body while that guard is held. It does not
reacquire a synchronous guard inside the asynchronous one. Unknown foreign
ownership still vetoes shared effects. Successful cleanup, qualified no-obligation
rollback, or qualified transfer removes only the unchanged own claim; a blocked
true obligation remains available for recovery.

The guardian makes at most three cleanup attempts, with an awaited one-second
pause between failed attempts. Each attempt reacquires the guard and rechecks
the captured receipt and foreign claims. A failed stop retains the receipt for
retry. A replaced or unreadable receipt never authorizes shared effects. After
exhaustion the guardian reports failure and exits nonzero, retaining recovery
evidence; a pending IPC send must not overwrite that status. Successful release
or cleanup is terminal and cannot trigger duplicate shutdown.

Exhausted attempts remain in chronological `AggregateError.errors`, with the
first failure as `cause`. If an awaited retry pause rejects, stop retrying and
retain the preceding cleanup failure followed by the pause failure; finish once
with status 1. Construct terminal causal evidence before the native process can
exit. Native diagnostics expose a bounded, redacted cause structure rather than
arbitrary error messages, paths or command output.

Parent launch/READY rollback and guardian validation/rollback must await
asynchronous completion. When a primary launch, readiness or protocol error is
followed by cleanup failure, preserve both in that order with the primary as
cause. Reservation rollback already running inside the acquisition guard keeps
its held-guard callback rather than reacquiring the same guard.

## Device observations and claim settlement

Derived implementation rules: this section specializes the
[common outcome contract](SPEC__ccc-architecture-contracts.md#common-outcomes)
and [M10 lifecycle plan](PLAN__ccc-architecture-migration.md#m10--ccc-sessions-and-containers)
while preserving the cleanup authority above and the
[guardian responsibility contract](REQ__session-mutation-lock-lifetime.md#guardian-responsibility-and-orphan-recovery).
The finite counts, settlement vocabulary and ordinary-row diagnostic are the
reviewed automatic-session-cleanup operation's technical choices in
`TASK__native-10adcc4a4fee302320bf`; they are not an independently user-prescribed
API or a new all-success cleanup policy.

Automatic cleanup must expose finite stopped, skipped and failed device counts
to its application caller, separately from whether the captured session claim was
retired. Ordinary failed rows emit one bounded native diagnostic before the
existing exact container stop and claim retirement. They retain the established
best-effort policy. Return no native row IDs, reasons, commands or output.

A thrown device cleanup has unknown progress; it must not invent zero counts.
Its existing exception diagnostic remains separate from the ordinary-row report.
Reporting failure or changed authorization prevents later stop and retirement.
Reporter exceptions must not be caught as device-operation failures.

The reusable synchronous result distinguishes no active session from a settled
captured claim, including device observations and stopped, transferred or
not-required container facts. Settlement does not imply every device was cleaned.
Device failure must not trigger destructive replay after the claim was retired.
Public CLI cleanup remains void. Its current-session check still controls guardian
release, including a no-active retry after a post-retirement guard-return failure.
Return facts for the captured operation without clearing a callback's successor.

The held recovery path returns the same facts without acquiring its guard again.
Existing project, guard, peer, report, stop and retirement errors retain their
handling; this contract does not normalize every native exception. Verify ordinary
failed rows, unknown progress, report failure, successor callbacks and post-retirement
retry through the core, actual native composition and emitted code.

## Known ceiling

Three attempts bound repetitions, not total wall time: each lifecycle guard and
native command keeps its existing time limit. Persistent runtime unavailability
cannot be reported as successful shutdown. A live-PID legacy guard without a
recorded process identity remains uncertain; age alone never permits removal.

Verify with owned fake subprocesses: signal the parent while the interactive
child is ready and alive, observe prompt signal handling, and join all fixtures.
Cover native stop failures, successful retry, and a foreign claim appearing
before retry. Verify distinct exhausted failures, pause rejection and primary
protocol failure followed by cleanup exhaustion, including redacted evidence
from the emitted guardian entry point. Build and test the shipped host CLI as
well as source modules.

Forced process termination cannot run the parent's JavaScript cleanup; the
separate guardian must cover host owner death. Real built-process fixtures must
force-kill the owner and prove automatic claim removal without subsequent CCC
queries, two-owner isolation, successor preservation and exact-ID final stop.
Windows console-close and actual Docker/Podman shutdown require native acceptance
after installing the updated host CCC. Portable fixtures do not prove these paths. A client
disconnect while a foreign owner retains the container does not authorize killing
that container or its shared Codex daemon.

## Temporary environment-file lifetime

The host environment file used by `exec --env-file` can contain forwarded
credentials. Preserve its existing serialization, native temporary-directory
selection and public string-returning writer API. Creation must be exclusive
with mode `0600`; an existing file or symbolic link must not be overwritten.

The launch path must own its file through preparation, argument construction,
awaited session confirmation, command execution and existing ownership
restoration. Dispose it after ordinary or preparation-failure completion and on
each handled error, preserving the original status or thrown value. Restoration
stays at its current point; failed confirmation must not launch or restore.

Register synchronous process-exit cleanup while the file is owned, since handled
session signals call `process.exit` before an asynchronous `finally` can finish.
Explicit disposal removes its listener, is idempotent and does not assign an exit
code or throw over a primary error. Diagnostic emission failures are contained.

Bind cleanup authority to metadata from the exclusively creating descriptor
before writing secrets. Receipts and diagnostics must not contain bytes, secret
digests, paths or arbitrary exception output. Remove only a matching regular file;
preserve observed replacements and uncertain identity. Cleanup failures produce a
fixed redacted diagnostic with a bounded validated errno at most. A missing file
is already cleaned. Identity capture failure must not write credentials or
authorize deletion of an uncertain named entry.

If native inode identity is unavailable, creation fails before writing values and
may retain an uncertain empty placeholder. Do not use a pathname or secret bytes
as a fallback ownership proof.

Verify serialization, creation failures, observed successor protection, listener
disposal and outcome preservation with private nonsecret fixtures. Real emitted
process tests must cover explicit exit and handled signals without a later CCC
query. Native Windows deletion/console-close and macOS tempfile behavior require
native acceptance. Parent cleanup cannot run after SIGKILL; this env-file contract
does not extend the session guardian. The native identity-check-to-unlink window
is not an atomic hostile-filesystem guarantee.

Guardian initialization must validate the native receipt and parent and install
its IPC handling without loading device cleanup administration. Cleanup-only
module loading must not consume the existing five-second ownership
acknowledgment deadline. On an authorized disconnected owner, the guardian
must await deferred cleanup before reporting its terminal status; cleanup failure
remains a failed exit. The serialized ACK outcome continues to select the exact
owned container ID. A positive current own-start publication also preserves exact
compensation authority after IPC failure; intent or an unacknowledged generic
grant does not. Native synchronous cleanup facade contracts remain intact.
