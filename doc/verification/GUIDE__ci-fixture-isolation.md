# CI fixture isolation and current contracts

Use saved GitHub job/check annotations to identify the failing assertions before
running focused local checks. Preserve the CI commit, job identities and original
results. Check annotations can truncate failures; read the complete failed job
logs before treating the list as exhaustive. Local passes qualify the candidate; a new GitHub Actions execution is
separate evidence. Do not exclude failures or loosen production guards to make
the suite pass.

For session deadline tests, control the monotonic clock and timers together.
Establish that the intended request reached dispatch before advancing its
execution deadline. Queued callers must still expire without executing; child
startup and health probes retain their separate deadlines. Drain owned pending
health work before measuring caller concurrency. Keep the original limits and
classification assertions instead of increasing sleeps or timeouts.

When a fixture selects a provider platform, real child-process identity probes
must still observe the host platform. Keep synchronous and asynchronous birth
observations consistent, including callbacks captured during module import.
Use the existing identity boundary before the lock factory captures it. Retain
native liveness, birth and signaling checks. Serialization tests require a
held gate and observable contender boundary, with release and joins in cleanup.
A fixed sleep is not proof that a contender reached the lock.

Model the provider observation currently used by production. iOS launchctl
fixtures must emit its PID/status/label table; exercise the process fallback
only after an explicit first-observation failure while allowance remains.
Successful nonmatch and unavailable observation remain different outcomes.

Ownership-fence tests need otherwise valid requests. Supply valid command
arguments before asserting a lease refusal, and retain the no-effect assertion.
Likewise, diagnostic expectations must include the complete current warning and
scoped remediation command. Do not change an error expectation merely to accept
an earlier validation failure or omit meaningful guidance.

Expected owner fixtures must preserve an already canonical
`/project/<project-id>` mount identity, including its selected profile, rather
than hash the mount again as if it were a host checkout. Keep the existing
host-path calculation for other paths and assert canonical expectations with
literal values. Ownership assertions must remain independent of the production
function that supplies the actual result.

Migration fixtures must choose a previous account distinct from the real
desired UID/GID. A fixed previous identity can equal the CI runner's account
and correctly skip migration, bypassing the dispatch the test intended to
observe. Preserve zero as a valid account ID, and retain separate same-identity
tests proving that production performs no unnecessary migration.

Match native tools as well as Node. Ubuntu 26.04's uutils `stat` can report a
synthetic link's metadata for an unlinked standard-input descriptor unless GNU
format calls explicitly dereference it with `-L`. Observe the retained descriptor,
preserving all identity, ownership, type, mode, link-count and size checks;
never fall back to reopening the original path. See
[descriptor portability](../remote/REQ__descriptor-root-portability.md).
BSD-format fixtures on a GNU-compatible host must also dereference retained
stdin in their native translation and diagnostic probes. Continue forcing the
BSD fallback and rejecting synthetic descriptor-path observations; otherwise
the fixture reintroduces the host bug it is meant to isolate.

Cancellation coverage must include a second signal at the actual owned release
boundary, while retaining the original process-group case. Final cleanup ignores
further catchable termination signals until its existing joins and guarded
claim release complete. Never substitute a delay, owner-only signaling or an
allowed lingering claim for the release contract. Preserve exact exit facts
and stage diagnostics when an intermittent group case fails.

Modern Git repair can rewrite sibling worktree links. Quarantine removal must
publish and compensate only its captured target metadata under the original
source and successor fences. See
[quarantine metadata ownership](../workspaces/REQ__quarantined-worktree-metadata.md).
Keep application validation pure through the required canonical validator port;
check the independent MCP package build as well as the architecture owner.

See [failure grouping](GUIDE__test-failure-groups.md) and
[regression entrypoints](GUIDE__regression-test-entrypoints.md) for saved reports,
isolated native dependencies and focused verification.
