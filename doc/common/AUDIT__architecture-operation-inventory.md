# Architecture operation inventory

Historical source baseline: `c284ead3a637d4d31ca93661920ee0f0200b9077`.
Current source audited: `59c0190e3acd7d89cfa3a8c89ab24ed86b0c730f`.
Data: [operation inventory](architecture-operation-inventory.json).

Status: **current reference corrections await independent acceptance; confirmed
source work remains**. The original nine review findings now have current
ownership/reference corrections. Their historical reasons and source observations
remain recorded separately. The broader original-scope audit found unfinished
work in supported direct bindings and shared presentation contracts.

The supported Codex/Claude scope contains 218 existing operations, with one
retained OpenCode operation excluded. The progress overlay now qualifies
**206/218 source operations (94.5%)**, with **12 partial**, no unmerged candidates
and no additional operation IDs. The prior 218/218 overlay incorrectly treated
accepted broker or bounded source contributions as complete across all required
bindings. Those accepted commits and actual review/QA results remain valid for
their recorded scope; their twelve whole-operation credits are withheld.

This is a provisional code count, not full architecture acceptance. The bounded
audit does not certify exhaustive remaining scope. Source scope closure,
current production-universe reconciliation and denominator certification remain
incomplete. Native, installed-image, reliability and formal acceptance remain
separate from source accounting.

| Confirmed source work | Existing operations | Current scope |
| --- | ---: | --- |
| Direct physical leases | 4 | Claim, heartbeat, prune, release and transaction compensation in `physical-lease-store.mjs` |
| Direct physical attachment | 2 | Android/iOS attach and detach sequencing, publication and compensation |
| Provider recording | 3 | Start, finalization and status in Android, iOS Simulator, macOS and Sandbox; broker desktop routes reach these children |
| Legacy admin deletion | 1 | Exported synchronous `deleteOwnerDevice` binding under the existing admin-cleanup operation |
| Shared result separation | 2 | Physical stop and device flow still expose MCP-shaped presentation results in shared applications |

M01/M14 also need the existing dependency graph to cover MCP and installer core
roots and current checked-MJS composition consumers. These are zero-operation
obligations. They add no implementation credit or denominator rows. The six
current source gaps and five prospective source tasks are recorded in the JSON.

This is an unweighted count of operation cutovers, not an estimate of remaining
effort or overall Goal acceptance. A small installation policy and a large
provider workflow each count once. Helpers, ports, aliases and equivalent
transport bindings do not add work items. Each row has one counting owner even
when its requirements span packets. Review and QA of this inventory assess the
accounting; they do not certify native execution or the completed architecture.

The following packet table is the **historical c284 baseline**, not current
implementation progress. Current counts come from the accepted-source overlay
and its current whole-binding qualifications in the [WBS](GUIDE__architecture-work-breakdown.md).

| Historical packet | Total | Migrated | Partial | Pending |
| --- | ---: | ---: | ---: | ---: |
| M00 | 0 | 0 | 0 | 0 |
| M01 | 0 | 0 | 0 | 0 |
| M02 | 4 | 0 | 1 | 3 |
| M03 | 6 | 0 | 0 | 6 |
| M04 | 4 | 0 | 1 | 3 |
| M05 | 15 | 0 | 0 | 15 |
| M06 | 14 | 0 | 0 | 14 |
| M07 | 26 | 0 | 10 | 16 |
| M08 | 76 | 0 | 1 | 75 |
| M09 | 4 | 0 | 0 | 4 |
| M10 | 14 | 8 | 2 | 4 |
| M11 | 34 | 23 | 1 | 10 |
| M12 | 16 | 0 | 0 | 16 |
| M13 | 6 | 0 | 0 | 6 |
| M14 | 0 | 0 | 0 | 0 |

M00, M01 and M14 have no independently counted product operations. Their
foundation, inventory and verification requirements remain mapped in
`coverage` and `acceptanceItems`. Zero operation rows does not mean those
requirements are complete or excluded.

The following acceptance table is also the historical snapshot. Acceptance
evidence is tracked separately. A migrated source policy does not
prove native execution, installed artifact parity or reliability. Each evidence
claim is limited to its recorded revision and scope. The verified source entries
below describe recorded bounded cutovers; they are not verified whole-packet
acceptance. Unverified packet obligations do not erase historical local test
results, and those results do not certify subsequent changes.

| Evidence kind | Verified | Unverified | Blocked | Inapplicable |
| --- | ---: | ---: | ---: | ---: |
| sourceCutover | 35 | 15 | 0 | 0 |
| portableContract | 0 | 15 | 0 | 0 |
| packageInstall | 0 | 15 | 0 | 0 |
| native | 0 | 15 | 0 | 0 |
| reliability | 0 | 15 | 0 | 0 |

To reproduce historical counts, count `workItems` once by `id` and group by
`implementationStatus`. For current provisional source counts, apply the
progress overlay through `node scripts/render-architecture-progress.mjs`.
Partial required bindings receive no whole-operation credit. For packet counts,
group by `countingOwner`, not `packets`. Acceptance totals group
`acceptanceItems` by `kind` and `status`; they use a separate denominator.
`closure` records source-mapping and review status, not full architecture
acceptance. No certified percentage is published before exhaustive source scope
is independently accepted.

After each cutover, update the affected stable IDs, bindings, supporting source
and evidence, then recompute this audit. New or changed operation boundaries
require an explicit retirement/replacement mapping. Refresh the baseline and
its tracked source universe when evaluating later code. The initial
`src/__tests__/architecture/migration-ledger.ts` remains a historical snapshot.

Hosted CI, workflow reruns and CI-triggering pushes require explicit user
authorization. This accounting task uses local static inspection and does not
execute providers or install tools. Native availability is never inferred from
a portable test.
