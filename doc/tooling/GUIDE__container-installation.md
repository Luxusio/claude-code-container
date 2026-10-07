# Container tool installation policy

The application owns complete Claude, npm tool, bubblewrap and uv workflows.
Nineteen required synchronous capabilities include semantic captured commands,
reporting and catalog access; a bubblewrap session has three operations. The
constructor observes no effects. Native composition retains unchanged public and
private facades, command assets, registry authority, working directories, root
privileges, stdio and timeout values. Requested-tool routing remains separate.

Each capture selects native spawn before runtime lookup and effectful argument
or metadata evaluation. Later stages observe fresh runtime choices for Claude,
npm and uv. Bubblewrap resolves one runtime before its first probe and retains
it across all commands. Logging captures the console object and log function
before interpolation, preserving its receiver. Underlying callbacks return the
original result objects, including changing getters and thrown values.

Claude prepares its opaque probe once, reports notes with one per-call Set, and
preserves VALID/RESTORED/INSTALL and confirmation ordering. Npm retains original
catalog find/element identity, binary fallback and metadata reads; cleanup
pattern calculation precedes capture. READY still publishes the wrapper; MISSING
completes cleanup, shim cleanup, installation and reshim first. Bubblewrap treats
only missing status42 as installation, uv only status1 after its original probe
checks. Do not unify the different timeout or status policies.

Before implementation, independent old-source asset texts and inert emitted
command scenarios establish golden fingerprints. Both shipped payloads execute
actual facade scenarios and compare those fingerprints, plus strict type
consumers. New core/native tests cover every branch, stage failure, getter order,
metadata identity, live versus pinned runtime and callee/receiver capture. Never
use real installation, providers, network or credential material as fixtures.

## Local verification and CI cost

For this architecture migration, use local independent review and QA. Start or
rerun hosted CI only when the user explicitly authorizes that execution. Before
pushing, check whether the push would trigger CI; existing permission to commit
or push does not override the user's restriction on CI costs. Preserve local
commits and evidence while hosted execution is unauthorized. Historical CI
results do not certify a newly changed candidate, and unavailable native lanes
remain unverified.

## Known ceiling

This parity extraction adds no package version, retry, cleanup, cache policy,
privilege or installer framework. Native platform, rootless/remote runtime,
registry/network/cache permissions and races retain separate acceptance needs.
Remaining M11 operations and M12-M14 are not completed by these workflows.
