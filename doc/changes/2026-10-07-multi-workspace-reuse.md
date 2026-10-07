# Multi-repository workspace reuse

Reopening an existing workspace from a plain folder containing several Git
repositories failed because discovery ran `git ls-files` against the plain
parent. Discovery now selects strict child-directory inventory for that parent
and retains strict tracked-submodule inspection for Git-root sources. Both paths
still require exact Git worktree registrations; discovery does not grant
ownership or bypass damaged-workspace and foreign-repository refusals.

The regression checks cover successful reuse without another worktree creation,
preserved files and registrations, and refusal on damaged metadata or foreign
replacement. Independent review and compiled CLI verification are required
before delivery. This correction is a prerequisite to accepting the multi
creation extraction; the full architecture migration remains in progress.
