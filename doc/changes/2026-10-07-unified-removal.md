# Unified workspace removal application

The full single-source workspace removal operation moves behind 27 explicit
ports while retaining the public facade, native registration/identity fences,
nested-before-root order, force checks and quarantined-content rollback. Matching
build, five type configurations, scoped lint and seven focused suites (90 tests)
passed. The actual package verifier passed extracted npm and materialized install
forms, including compiled quarantine policy, nested native removal with preserved
source refs/config/files and strict declaration consumers. Independent review and
fresh QA acceptance remain required. Baseline is delivered integration `24ff4195`.

The first independent code review identified missing native successor tests:
nearby replacement cases covered creation and repair, not removal after capture.
Three private real-Git fixtures now replace the source, destination and
registration objects at that boundary and invoke the original native binding.
The 90-test focused acceptance includes all three refusal/preservation cases.
Production code is unchanged by this correction; renewed review precedes QA.

## Known ceiling

Workspace repair and outer dispatch, the remaining M11–M14 migration and native
platform acceptance remain incomplete. This extraction changes no deletion policy.
