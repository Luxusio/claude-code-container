# Multi-repo creation application cutover

Multi-repo creation moves its scan, atomic workspace creation, addition and copy
sequence into an application with explicit native effects and opaque proof tokens.
The native facade retains existing helper arguments and ownership authority.
Created/copied candidates remain recorded before proof capture, preserving safe
refusal when registration or identity acquisition fails.

Repository failures retain forward compensation; copy failures retain reverse
repository and copied-entry compensation. Catch placement, partial-content
preservation, different nonempty-root behavior, diagnostics and original causes
remain unchanged. Legacy entry/result exports stay synchronous and mutable.

Initial acceptance at `5e5e13d4` passed 3,072 regressions, type checks and both
distribution forms, but actual CLI reuse failed because discovery inspected a
plain parent as a Git root. Baseline reproduction established provenance; the
failure was retained and corrected rather than waived.

Reuse source `0ae6f312` subsequently passed independent code/security/docs review
and fresh QA: 82 files, 3,012 tests and nine conditional skips, explicit new-test
typing, both shipping forms and actual candidate CLI creation/list/reuse with
preserved files and registrations. Its automatic review/QA receipt stream was
empty, so its Harness task remains parked under the existing operator-approved
continuation policy; no source close or receipt was fabricated.

The two source commits replayed without conflicts as `af9c66e3` and `104b6746`.
Ordered stable patch IDs match the originals; only the four reviewed reuse paths
changed. The creation application, ports, domain entry type, architecture tests
and shared shipping verifier retain their reviewed bytes. Fresh combined review
and QA remain required before delivery. Original source/control and failed CLI
QA evidence are preserved in byte-verified private archives.

Fresh combined review and QA subsequently passed at `e2cb25be`: 88 files,
3,139 tests and nine conditional skips; five standard type configurations plus
explicit reuse-test typing, scoped lint, both distribution forms and actual
candidate CLI creation/list/reuse. All 1,678 captured source/artifact hashes
remained unchanged. Harness verification returned PASS and the creation task
closed normally. Initial QA fixture failures were preserved before the complete
successful rerun; these checks do not certify native Mac/Windows acceptance.

A post-close health helper unexpectedly executed configured checks despite its
`--dry-run` name. Its owned process tree was stopped; all validated source and
build hashes still matched, with only the two reviewed documentation updates
different. No health score is claimed from that interrupted helper.

## Known ceiling

This operation does not finish dispatch, repair/removal internals, the remaining
M11–M14 migration or real Mac/Windows VM acceptance. Portable tests and source
shipping evidence cover their declared scopes only.
