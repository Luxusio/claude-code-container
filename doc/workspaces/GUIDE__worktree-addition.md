# Worktree addition boundary

The workspace addition application owns branch-state action selection, ordered
preparation and addition, and compensation for a nonzero or null command status.
Both unified and multi-repo creation use that same policy. Its four required
ports observe the branch, prepare the operation, add the prepared worktree, and
compensate a failed addition.

Preparation and registration values are opaque generic receipts. Pass their
original references through; application code must not read, create or replace
OID, inode, tracking-config or registration authority. The native composition in
`src/worktree.ts` connects the existing Git and fenced filesystem helpers.

Preparation or addition throws propagate directly. Only an observed nonzero
status triggers failed-add compensation. Preserve stderr trim, error-message and
empty fallback ordering, including rollback-error cause identity. Status zero
remains success even if an error property is present.

Registration validation remains at the caller's existing point. Unified validates
before nested repair. Multi records its created entry and rollback OID before
validating and storing the registration fence. Moving validation ahead of those
records changes its conservative outer rollback behavior and is not permitted.

Verify deterministic application traces and opaque identity, actual private-Git
facade cases with missing registration receipts, and existing ref/config/inode
race regressions. Facade fault tests wrap the real application factory and ports;
they do not mock Git or manufacture ownership receipts. Verify compiled core,
native facade and emitted types in both shipping payloads.

Outer workspace dispatch, copying, nested repair and overall removal remain
separate workflows to migrate. This operation cutover does not complete M11 or
the full architecture transition, and portable tests do not certify native Mac
or Windows capabilities.
