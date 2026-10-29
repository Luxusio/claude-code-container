# Quarantined worktree metadata publication

Derived repair contract: removing an owned registered worktree must preserve
the source checkout and unrelated linked worktrees, including their Git
metadata bytes. Modern Git's repository-wide `worktree repair` can normalize
otherwise valid sibling links; it is unsuitable inside this target transaction.

After existing ownership, registration, branch, directory and file admission,
quarantine may update only the target's forward `.git` link and its captured
management `gitdir` backpointer. Use existing metadata snapshots and guarded
publication. Revalidate the captured target generation and expected bytes
before each write. Refresh only identities created by those exact target
publications, and retain every source, destination, ref and OID guard.

The source identity remains immutable throughout the operation. Do not adopt
or refresh changed source metadata, normalize sibling links, change repository
configuration, or enable a repository extension to accommodate the transaction.
No inaccessible or changed observation authorizes mutation.

On failure, restore only the transaction's own target publications while their
captured generation and expected content still match. Preserve concurrent
successors and report incomplete rollback truthfully. Rollback must not invoke
a repository-wide repair or lose the pinned source environment.

Verify chained worktree removal and failure recovery, preserving source and
unrelated sibling forward/backpointer bytes, registrations and branches. Keep
existing changed-metadata, foreign-owner, symlink, ref/OID and successor refusals.
Qualify both older Git and modern relative-link normalization behavior.
