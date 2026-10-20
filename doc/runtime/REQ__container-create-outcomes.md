# Fresh container creation outcomes

Derived implementation constraints: this note specializes the
[common outcome contract](../common/SPEC__ccc-architecture-contracts.md#common-outcomes)
and [M10 lifecycle plan](../common/PLAN__ccc-architecture-migration.md#m10--ccc-sessions-and-containers).
The specialized vocabulary and native projection are technical choices approved
by `plan_review_fresh_create_outcomes_1213` in
`TASK__native-10adcc4a4fee302320bf`, not independently user-prescribed API details.
The existing CLI, runtime authority, source proofs and cleanup policy remain.

The reusable synchronous application returns completed, refused or rejected
creation facts. Refusals distinguish namespace appearance, physical-project
collision, failed creation and the retained final unpinned-session guard.
Rejections distinguish missing identity, nonverified mounts and thrown
post-create checks. Cleanup facts distinguish no authorized target from an
attempted captured target, removal completed/failed and absence
proved/unproved/failed. No raw native exception, process result or terminal
presentation belongs in these results. Reuse the existing domain mount facts.

The semantic create port supplies either a native-qualified exact identity or
null. Native composition parses the first full whitespace-delimited 64-hex
token, preserving case. The core trusts that postcondition and checks missing
identity after its repeated source assertions; it does not duplicate the native
parser. A missing identity never authorizes removal by namespace. Failed native
creation, including zero status with an error, retains the existing hint and
does not authorize compensation.

Only post-create source and bind proof failures enter compensation. Removal
targets the captured ID, followed by independent absence inspection even when
removal fails. A successful remove command is not absence proof. Native
projection preserves the primary thrown value when cleanup completes and
absence is proved. Cleanup failures aggregate primary, removal if failed, then
absence if failed, retaining identity, order and primary cause. A removal error
still aggregates when absence is proved. Unproved absence without such errors
keeps the existing cleanup suffix and formatter behavior.

The native facade still returns a string or throws with its existing diagnostic
and cause behavior. Project the application outcome inside each actual supplied
family-lock callback. Preserve callback skip, repetition, caught failure, the
lock's own return string and original guard throws. Keep native causes private
to the invocation/attempt, distinguish a captured undefined value from no cause,
reset for repeated callbacks and release references on exit. Do not introduce
a registry or another lock. Runtime capture stays at construction.

The merged native receiver keeps the facade's lifetime, including method state
installed by earlier callbacks. Semantic delegates capture both property lookup
and invocation at the proof and cleanup boundaries; a throwing accessor must
retain its original cause just as a throwing method does.

Pre-create and late MCP/SSH/Git/finish exceptions keep their existing hard-error
handling. Late failures must not remove a verified container. Existing source
assertion order, method receivers, creation-ticket and session handoff behavior
remain unchanged. No new retry, data schema or unknown-create reconciliation is
introduced.

Verify finite core results and synchronous types, native strings/error identity,
the removal/absence matrix, primitive/null/undefined causes, repeated attempts,
lock callback behavior, captured native runtime and public handoff through the
existing core, facade and emitted tests. A core refusal baseline witness proves
the new internal contract; it is not a new public Docker behavior regression.

## Known ceiling

Existing unexpected-error formatting is preserved, including `.message` access
on primitive/null/undefined primaries when absence is unproved. The conversion
does not universally normalize or sanitize native exceptions. A missing created
ID retains uncertainty rather than permitting namespace cleanup. Portable tests
with fake native leaves do not certify real Docker/Podman or Windows/macOS
lifecycle behavior; those acceptance lanes remain separate.
