---
area: device-lab
slug: hyper-v-forced-delete-supersedes-snapshot-journal
status: current
---

# REQ — A forced device_delete supersedes a pending snapshot journal

## Requirement
In the Hyper-V lifecycle command path (src/device-lab-broker.ts), the pre-command
snapshot-journal reconciliation gates MUST NOT block a forced destructive delete.
When `parsed.command === "device_delete" && parsed.force` and
`reconcileHyperVSnapshotJournal` returns `!ok`, the broker MUST clear the snapshot
journal and continue to the delete — NOT return `hyper-v-snapshot-reconciliation-failed`:

```
if (!snapshotReconciliation.ok) {
    if (parsed.command === "device_delete" && parsed.force) {
        clearHyperVSnapshotJournal(hyperVJournalPersistenceRuntime(), ownerId, parsed.backend, parsed.deviceId);
    } else {
        return { ...error: snapshotReconciliation.error... };
    }
}
```

This branch belongs at exactly ONE gate: the snapshot-journal reconcile inside
the non-create lifecycle path (`if (parsed.command !== "device_create")`, Block A),
which is the only gate a `device_delete` can reach. The second snapshot gate lives
in the `device_create` path — TypeScript narrows `parsed.command` to
`"device_create"` there, so a forced delete can never reach it and it is left
vacuously strict (a `device_delete` branch there would be dead code, and tsc
rejects it). Every non-delete or non-forced command MUST still block on
snapshot-reconciliation failure.

## Why
A prior run that failed at "create production checkpoint" leaves a VM plus a
pending snapshot journal. On the next run, residue cleanup issues
`device_delete` (force + confirmDestructive). The strict gate reconciled the
snapshot journal first and, on failure, blocked the delete with
`hyper-v-snapshot-reconciliation-failed` — making the residue permanently
unrecoverable and forcing manual host wipes. That defeats automatic residue
recovery, which is the whole point of the cleanup step.

## Invariant / consistency
- A forced destructive delete removes the VM and all its checkpoints, so any
  pending snapshot op is moot; blocking on it is never correct.
- Clearing the journal is right — it records an in-flight snapshot op the delete
  makes irrelevant. If the delete itself fails, its own (now-visible) error
  surfaces instead of a masked snapshot-reconcile block.
- Non-delete / non-forced commands keep the strict guard: no operation proceeds
  on inconsistent snapshot state.
- Same theme as [[hyper-v-delete-disk-guard-subset]] and
  [[hyper-v-network-teardown-identity]]: cleanup/teardown paths must be robust to
  legitimate residue; only genuine ownership/identity is authoritative.

## Regression coverage
- Broker unit test: a forced device_delete proceeds (journal cleared) when
  reconcileHyperVSnapshotJournal returns !ok; a non-forced/other command still
  blocks with hyper-v-snapshot-reconciliation-failed.

## History
- v1: strict gate blocked ALL commands (incl. forced delete) on snapshot-reconcile
  failure → unrecoverable residue. Superseded.
- v2 (current): forced delete clears the journal and proceeds.
