# Remote execution completes before native process projection

Derived technical requirement: this specializes the existing
[common outcomes](../common/SPEC__ccc-architecture-contracts.md#common-outcomes),
[RemoteSession/Sync exact-lease contract](../common/SPEC__ccc-architecture-contracts.md#required-ports)
and [cancellation, compensation and release rules](../common/SPEC__ccc-architecture-contracts.md#operation-transitions-and-recovery).
It changes completion ownership within the existing remote CLI, without adding
a remote IDE, transport or cancellation framework.

Application execution returns a finite completion, prerequisite refusal,
expected failure, cancellation or opaque unexpected fault. It never exits or
signals the hosting process and never asks a native port to construct its
failure. Sync admission/wait and explicit termination similarly return their
expected semantic outcomes. Unexpected native faults retain their identity;
they do not become an empty inventory, a successful result or automatic retry.

Cleanup failures remain separate from the primary result. Each owned cleanup
phase is attempted at most once, and a failure does not prevent the independent
remaining cleanup phases. Reservation release checks both native completion
status and execution error. A failed release remains visible, and no successful
exit is reported when required cleanup failed. A primary failure or unexpected
fault is preserved when later cancellation or cleanup also fails.

This also applies to lifecycle guards: capture a callback's returned failure or
exact thrown fault before its guard releases. A later release failure remains a
separate cleanup fact. Preserve failures from both nested guards without
repeating the operation. If the callback succeeded but guard release fails,
return a fault and prevent later work from dispatching. Failure before callback
admission remains a primary fault. Standalone sync admission and termination
carry cleanup facts when present; execution incorporates them into its own
cleanup result, and native termination presentation preserves the primary error.
When guard release is the first failure, it is the primary fault and is not
duplicated in cleanup facts; a later outer-guard failure remains separate.

The first requested signal is latched for the invocation. Its handler contains
its own cancellation/forwarding exceptions and never releases a lease, removes
a claim or signals the hosting process. Cancellation before a queued dispatch
prevents that dispatch, including inside both existing nested guards and after
poll/prompt waits. A dispatched reservation is accounted for even if cancellation
arrives before its surrounding await settles; its exact token is released once.
Already-dispatched native operations are awaited rather than abandoned in a
race. No cancellation path guesses that the remote operation did not happen.

Each invocation owns its prompt and timer handles. Cancelling one invocation
cannot dispose another invocation's handles, listeners, claim or reservation.
Invocation-specific waits use the original semantic port implementation;
supplying a wait must not discard its prototype-provided capabilities.
Native console questions share one physical input stream, so their readers are
serialized; cancelling a queued question must not pause the active reader.
Terminal Ctrl+C reaches the owning invocation's interruption handler before
settling its prompt, rather than being accepted as a default-user answer.
Prompt cancellation settles and closes its owned reader; timer cancellation
clears and settles its owned wait. Blank input and EOF retain existing behavior:
the user prompt chooses its default, and the cleanup prompt declines. Only the
latched signal represents cancellation. A later prompt on positively ended
input settles as empty without waiting for another end event. Already errored
or otherwise unavailable input remains a fault, not an inferred default answer.
Heartbeat refresh/report exceptions
are contained as an opaque fault rather than escaping a timer callback; a
negative refresh observation retains its existing advisory behavior.

An active SSH child is joined through an explicit close observation before
reservation/claim retirement. An error notification or kill return is not
termination proof. Preserve the first error/exit observation while awaiting
close and restore the existing terminal state through the native adapter.
The native facade projects completion exactly once after settlement, preserving
CLI statuses, diagnostics and the first requested signal.

Keep [sync identity and guard ordering](REQ__sync-authority.md): project sync
guard before container guard, captured container ID/current token, and captured
sync identifier/binding. Independently authorized own-container stop may proceed
when sync is unavailable or replaced; no successor sync may be paused. Busy
peers preserve both container and sync. Cancellation queued after accepted
cleanup still prevents new stop/pause dispatch.

Verification uses deferred guard/child/prompt/timer observations, combined
primary-plus-cleanup failures, overlapping invocation ownership and actual
emitted application consumers. A continuing embedder must receive the outcome
without process termination; the public facade still supplies CLI behavior.
Retain identity and terminal tests rather than replacing them with shape checks.

## Known ceiling

Signal handling cannot run while synchronous native commands block JavaScript.
Existing guard acquisitions retain their current timeout, and several existing
native commands have no timeout. Cancelling a reader/timer does not promise
immediate cancellation of those operations or prove child termination. This
change does not certify live SSH, native engines or actual Mac behavior; those
acceptance requirements remain separate. The existing `user@host:docker://...`
endpoint is parsed by stock Mutagen as an SSH host path, not nested container
transport. Correct Docker transport and observed container file convergence
remain required follow-up work. See the upstream
[URL dispatcher](https://github.com/mutagen-io/mutagen/blob/v0.17.0/pkg/url/parse.go#L22-L33)
and [SSH path parser](https://github.com/mutagen-io/mutagen/blob/v0.17.0/pkg/url/parse_ssh.go#L157-L183).
