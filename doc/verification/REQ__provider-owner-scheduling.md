# Real-provider owner scheduling

Status: derived implementation contract, 2026-10-27.

The user requests saved-failure repairs and verification limited to affected
behavior. This correction derives from the existing broker's owner mutation
queue, rather than adding a new user-facing concurrency requirement.

Provider workers launched by one real-test collector inherit its cwd, profile
and selected broker endpoint. Suites that submit mutating RPCs for this shared
owner must declare a common scheduler resource, in addition to their native
provider resources. They must not wait behind another suite's long-running
broker operation while spending their own unrelated RPC timeout. Keep genuinely
independent resources eligible for concurrency, including a local container
provider when its route does not mutate this broker owner.

Preserve the concurrency option, result order, failure propagation, active-worker
completion and process cleanup. This changes scheduling before dispatch; it
does not change broker serialization, ownership, native success criteria or
operation time limits.

The basis is [provider scheduling](../../scripts/real-tests/provider-parallelism.ts),
the [collector](../../scripts/real-tests/run.ts) and the existing
`serializeBrokerOwnerMutation` path in the
[broker](../../packages/device-lab/src/device-lab-broker.ts).
Verify actual iOS, macOS and destructive-suite partitions with a gated task:
another shared-owner suite begins only after release. Also retain a concurrent
independent-provider case and existing failure/cleanup checks.

Known ceiling: timestamp-derived overlap in the saved Mac run corroborates
queue contention; it is not an explicit broker queue trace. Native acceptance
of the corrected scheduling requires host execution.
