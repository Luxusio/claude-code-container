# Parallel architecture integration and temporary worktree cleanup

The operator requested parallel implementation, commits on
`feature/device-mcp-squashed`, and cleanup of unused worktrees and branches.
Independently reviewed and QA-passed source commits were fast-forwarded to that
branch at `4aac41e14e4ae20ea68b76d96c545620b8878046` and pushed normally.
The reviewed native-CI outcome note subsequently landed and was pushed at
`067a6220d05e1561d4ad3c41e24d2a1fbcbbfa03`.
The additional common shipping proof remains an integration candidate until
its own combined review and QA. No full-suite/native PASS is inferred.

## Exact source provenance

| Slice | Original commit | Replayed commit | Stable patch ID |
| --- | --- | --- | --- |
| Colima portable implementation | `ee151f09f5a8a4ddcf77dc63d216f2dab5ef9654` | unchanged | source base for integration |
| Branch validation | `81847cac91318d06ba950a9608b0ad1db073ea22` | `24fdb995b9a7caf6cb08e2ef01747b243bcfaba3` | `cdafe080f471ea8b5c061a08577b186a1812bb60` |
| Profile request extraction | `c1e4176b585d6bded22c9df6a43429157f486f6c` | `fec830d2c07c3dd1e3d5fcc72d0526c2b2a7ccc9` | `d7165330600f0535429fe688632d67a0a53a83dc` |
| Profile exception-identity test | `5c61025e96c18bb64bf873b0379d55ecd9990c64` | `4aac41e14e4ae20ea68b76d96c545620b8878046` | `2face3db39c631313788fcfc235cf2f4ae6ee269` |

Original and replayed per-commit patches and affected source/test/document bytes
matched. Both profile commits were replayed in order. Original isolated reviews
and QA remain evidence for their slices; root shipping and combined evidence are
separate requirements.

## Destination preservation

The destination had 98 prior dirty/untracked paths. All 97 modified tracked
files were captured in a byte-verified local preservation snapshot. Two
overlapping files, README and workspace-root ownership requirements, contained
only CRLF differences and retained that style with their new committed contents.
Other user bytes, including the substantive container-init requirement edit,
remained unchanged. The failed node_modules directory was not traversed.

An initial merge refusal from stale line-ending/stat state was rolled back.
A later checkout refusal revealed that the new profile/workspace documentation
directories could not be created under the root-owned documentation parent.
Only partial target checkout files were restored to their proven previous bytes;
the two new empty directories were created with the invoking user's ownership.
The final fast-forward and original branch identity were read back successfully.
No stash, reset, clean, force push or merge commit was used.

## Cleanup checkpoint

Seven stopped, accounted worktrees and nine disposable local branches were removed:
workspace naming, Colima implementation, two old PR candidate worktrees, two
parallel source worktrees, the native-CI worktree, and the two already-merged PR
publication branches. The owned remote CI branch was removed after verifying
its remote tip was an ancestor of the feature destination. Readable archives outside
the removed trees were verified by file hashes and symlink targets. Reproducible
node_modules/dist caches and root Git administrative pointers were excluded.
Source task records remain truthful: no close or receipt was fabricated.

The old PR candidate trees matched their actual published merge trees exactly:
`e760ca8b` matched `e576d4ab`, and `87997f3d` matched `c95d7e40`.
Original histories remain reachable in local archive refs. Empty replay aligned
only these already-landed, byte-identical source branches before normal worktree
removal and `branch -d`; no source payload was discarded.

Archives are local and ignored under
`doc/harness/checkpoints/worktree-cleanup-20261007`. Do not publish private
fixture or task payloads. Common shipping subsequently passed both real payload
forms with the new branch/profile consumers. Patch-equivalent originals were
archived, rebased without autostash onto their landed destination and removed
normally; their original commit identities remain reachable through archive
refs. The native-CI branch's stale tracking configuration was unset only after
confirming its tip was merged into the intended destination, allowing normal
`branch -d`. Only the active integration worktree remains beside the original
checkout. No live or unknown writer's worktree was removed.
The original master and unrelated feature/ui branches were retained.

## Remaining acceptance

Real Mac Colima acceptance remains unavailable: Device Lab reports no macOS
host and no provider. Socket access, project ownership/writes, SSH, networking
and native join/restart remain required in the dependent task. The two earlier
native-CI full-suite deadline failures are not waived by the operator's missing
receipt exception. Full architecture migration remains in progress.
