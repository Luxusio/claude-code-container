# CLI dispatch and workspace recovery

## Basis

The behavior below is derived from the existing
[workspace ownership and content-preservation requirements](REQ__workspace-root-ownership.md)
and three observed implementation facts: global options already produce one
normalized command vector, native worktree helpers return the receipts used for
rollback, and registration settlement can partially remove old metadata before
throwing. These facts require consistent dispatch, receipt-qualified
compensation and a settlement boundary before that irreversible work. They are
technical corrections within the authorized
architecture work; they are not additional features explicitly requested by the
user. The task's no-CI, no-push and original-edit preservation instructions are
execution constraints, not new CLI behavior.

## Required behavior

After global option normalization, command dispatch uses the normalized command
vector consistently. Runtime selectors and consumed environment values cannot
become remote hosts, profile names, default tools or destructive clean flags.
Existing option grammar, validation and informational command behavior remain.

Workspace container inventory and removal defaults use the same
[captured native runtime authority](../runtime/REQ__captured-container-runtime.md)
as identity inspection. The native removal object retains that bound executable,
transport and environment for listing, stop and plain removal; later ambient
selection changes cannot redirect it. Explicit injected runner/CLI pairs keep
their existing behavior. A CLI-only override conflicting with captured authority
is refused rather than silently mixing engines. This is a derived correction of
the previous bare-runtime dispatch in workspace removal, not a new deletion or
confirmation policy.

Confirmed broken-worktree repair keeps the original checkout and stale Git
registration recoverable throughout its reversible phase. Every exceptional
observation after quarantine enters the same receipt-qualified compensation.
Use only identities and native receipts already returned by the operation;
missing authority never permits recapturing a replacement for deletion.

Restore the original directory and registration when their captured guards
permit it. A refused or false restoration result is incomplete recovery. Keep
successors and preserved data, identify their actual recovery locations and
retain the primary failure as cause. A native content-conflict error may trigger
the existing set-aside prompt only after full restoration has been verified.

The replacement becomes authoritative before the first registration settlement
attempt. Settlement may have partial effects before throwing. Such a failure,
or a later notice or backup-cleanup failure, must not roll back that replacement.
Generic CLI failure and retry messages do not promise unchanged content.

Verify actual command dispatch through controlled adapters and exceptional
repair through private real Git repositories, original file bytes/inodes and
registration snapshots. Cover missing receipts, successors, false restoration
and settlement failures. Fixture evidence does not establish native host or
whole-architecture completion.
