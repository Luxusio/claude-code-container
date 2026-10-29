# Workspace detection with unreachable nested Git metadata

Status: derived repair contract, 2026-10-29.

The reported `ccc codex` startup failed while workspace detection classified a
nested `.git` file. Its recorded Git directory was beneath another `.git` file,
so reading `commondir` raised `ENOTDIR`. The existing nested discovery repair
does not cover every direct classification in startup workspace detection.

Workspace detection must apply the existing recorded-path reachability policy
before classifying nested Git metadata. A nested gitfile naming an absent
directory, including an `ENOTDIR` path component, is skipped with the existing
escaped, deduplicated notice. Healthy siblings and a usable ordinary root
repository retain their normal detection behavior. Detection does not edit the
checkout, recreate registrations, prune worktrees or remove operator files.

The workspace's own root Git metadata remains required: an unreachable root
must not become an ordinary-directory success. A skipped child must not hide a
source registration that still claims the workspace. Existing damaged-workspace,
branch agreement and valid mixed-layout refusals remain effective.

Only the established unreachable recorded-path case receives this treatment.
Permission failures, malformed reachable metadata, symbolic links, escaping or
foreign registrations and failed ownership checks retain their refusals.
Valid submodule/gitlink classification remains unchanged. Treating every
`ENOTDIR` as a valid gitlink, or swallowing arbitrary inspection errors, does
not satisfy this contract.

Verification uses temporary real Git repositories through public startup
workspace detection and branch observation. Cover absent recorded directories,
paths below `.git` files, healthy siblings, root refusal and retained ownership
and layout guards. Preserve fixture metadata and uncommitted files. Portable
checks qualify the code path; the installed Mac executable requires separate
host confirmation. See [workspace repair](../workspaces/GUIDE__workspace-repair.md).
