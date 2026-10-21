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

## CLI module startup boundary

The CLI module currently uses a test-runner environment marker to decide whether
to start. That marker does not establish which file Node executed. Derived from
the noninteractive Core boundary, importing the module must not start the CLI.
Automatic startup occurs only when the canonical file named by `argv[1]` matches
the CLI module. Missing or unresolvable entry paths do not trigger startup.

Test-runner markers, including `VITEST=0` and `VITEST=1`, neither start an import
nor suppress direct execution. Keep the existing exported `main` and `runCli`
entry points, startup-error handling and session-claim cleanup. File-identity
observation failures must not swallow execution failures. Preserve npm, installed
Unix-wrapper and real symlink launches through canonical file URLs.

Verify these behaviors in emitted CLI child processes with informational
arguments, private home/cwd and guarded native commands: silent import, absent
and unresolvable entry paths, direct execution with absent/zero/one markers,
explicit `runCli` once, and supported symlink launches. Importing or printing
version information must not create a container or start a provider.

## Workspace removal application boundary

Engineering-derived from the existing request for a noninteractive Core and the
ownership requirements above: the complete workspace removal application accepts
an explicit request and returns removed, incomplete or failed facts. It publishes
typed progress without selecting consoles, process exit, terminal escaping or
shell remedies. The CLI owns their presentation and chooses its exit status.
Existing guard/native errors remain opaque error objects; this is an internal
application contract, not a new remote API or error serialization protocol.

Resolve the source once before callbacks, then derive the workspace and project
through the existing native authority. Retain that source for ownership, deletion
and registration inspection even if a progress observer changes its current
directory. Inspect
claims under the family guard, retain strict source/branch ownership and validate
the complete container plan before workspace mutation. Snapshot admitted container
IDs and running state; the same captured ID must reach stop and removal even if a
native callback changes the original observation object. Unavailable inventory or
unknown identity for a present target refuses mutation; confirmed absence may be
skipped. A partial workspace result must not trigger associated-container cleanup.

Retain the exact workspace result as soon as native removal returns, including
when later container cleanup or registration inspection fails. Failure is not a
rollback or a promise that nothing changed. Keep progress at the existing effect
boundaries and publish snapshots rather than mutable policy inputs. Release the
family guard before result summaries or outward exit; a late registration failure
may follow an already published removal completion. Observer failures grant no
additional deletion authority.

Verify the whole application through data outcomes, original error identity and
semantic progress, and execute the actual CLI composition through controlled
native adapters. Existing private real Git owners remain required for strict
ownership, both workspace layouts, content/ref preservation and safe remedy
commands. Portable fixtures do not certify native host behavior.
