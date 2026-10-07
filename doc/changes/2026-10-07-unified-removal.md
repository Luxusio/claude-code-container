# Unified workspace removal application

The full single-source workspace removal operation moves behind 27 explicit
ports while retaining the public facade, native registration/identity fences,
nested-before-root order, force checks and quarantined-content rollback. Matching
build, five type configurations, scoped lint and seven focused suites (90 tests)
passed. The actual package verifier passed extracted npm and materialized install
forms, including compiled quarantine policy, nested native removal with preserved
source refs/config/files and strict declaration consumers. Baseline is delivered
integration `24ff4195`, whose exact five-job CI run `37619588582` passed.

The first independent code review identified missing native successor tests:
nearby replacement cases covered creation and repair, not removal after capture.
Three private real-Git fixtures now replace the source, destination and
registration objects at that boundary and invoke the original native binding.
The 90-test focused acceptance includes all three refusal/preservation cases.
Production code is unchanged by this correction; renewed code/security/docs
review passed before the fresh full QA below.

## Verified acceptance

Independent fresh QA passed at `d8db14d0`: the default full collection passed
370 files and 10,162 tests, with ten files and 151 tests conditionally skipped.
Five configured type checks, scoped lint and a single actual dual-payload
shipping verifier passed. Guarded compiled public/CLI proof exercised help,
version, clean removal, dirty refusal, partial forced-retry ownership refusal,
fresh force, foreign replacement preservation and invalid/missing branch.
Source HEAD/refs/config/files remained unchanged from post-creation snapshots;
successful registrations disappeared and refused registrations were retained.
Recursive fixture inspection found no quarantine residue. All 1,715 complete
source/root/package/assembled artifact paths and hashes stayed unchanged.
Harness verification returned PASS and the source task closed normally.

## Known ceiling

Workspace repair and outer dispatch, the remaining M11–M14 migration and native
platform acceptance remain incomplete. This extraction changes no deletion policy.
