# Architecture operation inventory

Source baseline: `c284ead3a637d4d31ca93661920ee0f0200b9077`.
Data: [operation inventory](architecture-operation-inventory.json).

Status: **incomplete inventory; source review remediation pending**. The formal
review found missing observation routes, stale authority/reference records and
an incomplete operation previously counted as migrated. No complete required
TODO denominator or architecture implementation percentage is certified.

The discovered rows currently contain 31 migrated, 16 partial and 172 pending
items. The 219 discovered rows are a candidate set, not the complete required
total. The nine review corrections have been applied locally and await independent
re-review; these counts must not be used as the overall progress fraction.
Current implementation scope is Codex and Claude; the retained OpenCode candidate
is excluded. Unmerged source candidates and non-attesting review/QA results do
not update this baseline's accepted numerator.

This is an unweighted count of operation cutovers, not an estimate of remaining
effort or overall Goal acceptance. A small installation policy and a large
provider workflow each count once. Helpers, ports, aliases and equivalent
transport bindings do not add work items. Each row has one counting owner even
when its requirements span packets. Review and QA of this inventory assess the
accounting; they do not certify native execution or the completed architecture.

| Packet | Total | Migrated | Partial | Pending |
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

Acceptance evidence is tracked separately. A migrated source policy does not
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

To reproduce the discovered counts, count `workItems` once by `id` and group by
`implementationStatus`. Publish a completion fraction only after source scope
is closed and independently accepted. For packet counts, group
by `countingOwner`, not `packets`. Acceptance totals group `acceptanceItems` by
`kind` and `status`; they use a separate denominator. `closure` records the
source-mapping claim and its review status, not an architecture acceptance gate.

After each cutover, update the affected stable IDs, bindings, supporting source
and evidence, then recompute this audit. New or changed operation boundaries
require an explicit retirement/replacement mapping. Refresh the baseline and
its tracked source universe when evaluating later code. The initial
`src/__tests__/architecture/migration-ledger.ts` remains a historical snapshot.

Hosted CI, workflow reruns and CI-triggering pushes require explicit user
authorization. This accounting task uses local static inspection and does not
execute providers or install tools. Native availability is never inferred from
a portable test.
