# Reviewed architecture wave integration

Status: integration in progress. Source baseline remains `c284ead3`.
The destination is the local `feature/device-mcp-squashed` branch. No hosted CI,
workflow rerun, push or global installation is authorized by this wave.

Eight independently reviewed and QA-passed source snapshots have been replayed
into the isolated integration branch. Twenty-three commits replayed without
conflicts; every disjoint source file matched its original snapshot immediately
after replay. Private commit, path/hash and stable patch manifests are retained.

| Source slice | Original snapshot | Scope |
| --- | --- | --- |
| Container launch arguments | `02c5a401` | Whole retained argument/mount policy |
| Codex launch | `ea96263f` | Launch preparation |
| Codex resume | `b625854d` | Qualified recovery and retained raw-command failure behavior |
| Codex clipboard attachment | `fb6c26f7` | Eligible attachment and native HTTP boundary |
| Workspace dispatch and repair | `d7f578d8` | Five complete workflows |
| Broker observations | `3f020650` | Six complete policies; aggregate/direct bindings remain partial |
| Direct Sandbox stop | `e80e5afe` | Direct policy only; broker binding remains legacy |
| Inventory and WBS | `c9419826` | Provisional operation accounting and renderer |

The first combined source point is `ef7ae841`. The progress renderer subsequently
gained an accepted-integration projection at `0022718d`: historical inventory
anchors remain unchanged, whole operations count once and accepted partial
bindings receive no whole-operation credit. Thirteen private projection cases
passed, including invalid input preserving existing output. Current lane states
remain pending until combined verification and local delivery are complete.

Codex retained-state and Lab volume policies require their running independent
QA finals before admission. Clipboard policy requires immutable source freeze
and all independent review/security/QA results. Existing per-slice results do
not substitute for combined compilation, the two actual shipping forms, full
portable test execution or final independent review and QA.

The operator-approved missing-record exception remains the one recorded in
the [earlier continuation decision](2026-10-07-architecture-receipt-exception.md).
Actual independent results authorize continuation; missing automatic records
remain explicit source-task blocks. No tool close or receipt is fabricated.

Original main-checkout user bytes remain protected by the 97-file preservation
manifest. Source work, dependencies, private homes and generated artifacts stay
inside owned worktrees. No live native ownership/resource action has been run.
Real Windows/macOS/Colima and reliability obligations remain unverified.

Combined test outcomes, exact final source provenance and destination hashes
will be recorded here after actual verification. This note does not certify the
full M00–M14 objective or the complete provisional denominator.
