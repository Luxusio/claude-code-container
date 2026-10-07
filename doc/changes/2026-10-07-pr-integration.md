# PR #9 and #10 reconciliation with the architecture branch

The integration candidate retains the current application/ports/composition
boundaries while adapting the behavior of both existing PRs. The authorized
GitHub destination is `feature/device-mcp-squashed`; master is unchanged by this
packet. The intended publication keeps original fork ancestry and author
attribution, retargets the existing PRs, and merges a meaningful PR #9 subset
before PR #10's remaining changes. No force-push or manual Close substitutes for
Merged. Remote head/base identities must be rechecked before each mutation.

## Source provenance and preservation

The captured architecture base is
`8605f28c6b6a8de09f420757f2b2fbf1e924b500`; original PR #10 head is
`141a2071ce1b416216edd78ce0caeab5f3d49cbd`. The intent audit compares PR #9
`57076505188a1391571954902e5e9d4d34f8e208` with its parent
`90bd161e9c02b881d27cca73bca390a1d2df902f` and original PR #10, rather than accepting an
incomplete replay as proof. That audit identifies selected-tool independence,
cold/warm executable repair, host/config ACL recovery, launch/resource lifetime,
login argv and documentation as preservation requirements. The older Device Lab
snapshot is superseded by current packages and is not restored.

The candidate keeps current selected-tool policy, profile resolution, owned env
file disposal and awaited command execution. Cached executable absence permits
installation; failed probes do not reinstall over retained state. Profile-aware
writer locks cover host access restoration before MCP read/write. Native ACL
mutation pins a regular single-link file and walks ancestors without following
symlinks, preserving content, ownership and unrelated effective access.
Current-image resolution failure throws. Reuse probes have five-second limits,
at most three attempts and one shared 15.15-second deadline.

Session identity capture is distinct from cleanup authority. Host ownership
acquisition starts with cleanup disabled; a true grant waits for guardian ACK,
and a captured-ID change revokes the old grant first. Failed joins release their
own claim without stopping the container or devices. Successful existing start
is captured before helpers, while fresh creation requires verified managed and
running identity first. Legacy unowned `setSession` defaults remain enabled.

Active `.idea`, Copilot and Harness controller metadata are retained where they
are outside product state; this integration performs no blanket metadata purge.
SSH authority/provenance, active clipboard bind users and runtime-specific cache
identity remain protected by the upstream preservation requirements.

## Evidence and remaining acceptance

Source reconciliation is not a completed GitHub merge. At this documentation
checkpoint authenticated GitHub write access is unavailable, and neither PR has
been claimed Merged. Independent code/security/docs review and fresh QA remain
required for the candidate and its publication composition. Initial broad-suite
failures included obsolete fixtures; their old totals are not final acceptance
counts. Corrective ACL/MCP and readiness proofs must be read with their exact
candidate revision and final QA evidence, not substituted for whole-task PASS.

Actual native Linux ACL, readiness and guardian tests establish their exercised
boundaries. Fake lock/facade tests do not prove native lock contention or live
provider behavior. Native Windows/macOS, Hyper-V and physical-device acceptance
remain separate lanes. Unsupported ACL-xattr filesystems refuse mutation.
Cleanup needs captured identity and acknowledged permission; forced termination
before capture is not guaranteed and no arbitrary container scan invents it.
Code rollback alone cannot undo a retained-state migration: preserve original
state and provenance before invoking one.

See [PR integration requirements](../runtime/REQ__pr-integration.md),
[upstream preservation requirements](../runtime/REQ__upstream-fork-preservation.md)
and the affected M10d/M10i sections of the
[architecture migration guide](../common/GUIDE__architecture-migration.md).

## Publication CI correction

On 2026-10-07, PR #9 was merged into `feature/device-mcp-squashed`.
The authenticated PR #10 CI run exposed Dockerfile/Containerfile drift: the
Podman recipe lacked the Codex package-volume directory and its ownership.
Keep both recipes byte-identical, including the existing Claude runtime-install
documentation, so both runtimes initialize the same non-root cache permissions.
This correction changes only Containerfile and this note; the previously
reviewed Dockerfile and TypeScript implementation are unchanged.

The operator explicitly approved publication of these two PRs despite missing
Harness lifecycle receipts after independent review and QA passed. This is a
publication exception, not a fabricated receipt or strict Harness close.
