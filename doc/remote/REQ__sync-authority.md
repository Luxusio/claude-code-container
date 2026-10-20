# Remote sync belongs to one project and host authority

Derived technical requirement: this specializes the existing
[RemoteSession/Sync and SessionStore contracts](../common/SPEC__ccc-architecture-contracts.md#required-ports).
It replaces the project-only sync limitation described in the existing remote
services guide; it does not add a remote IDE or a new transport.

Each operation resolves its local project and configured SSH user/host once.
Sync naming separates these authorities. Successful complete native inventory
must prove absence before creation. Query failures, timeouts, invalid output
and incompatible records remain unknown and authorize no mutation. A legacy
unscoped name or ambiguous/foreign scoped record blocks creating another writer.

Reuse requires one exact local/remote binding. Only a changed container ID
within that same binding permits checked replacement of the old sync. Creation
must be checked and its unique native identifier established before use; an
unknown post-create result never authorizes guessed cleanup or another create.

Mutagen names are nonunique. Resume, wait, termination and cleanup retain the
verified identifier and binding; they never substitute a same-name successor.
Use the existing project sync guard to serialize admission and mutations with
consistent container-guard ordering. Concurrent admission for one binding must
create at most one writer. Busy container cleanup still preserves sync.
Reservation and final cleanup acquire the project sync guard before the
container guard. Sync qualification immediately precedes pause after an
independently authorized exact-container stop; unavailable sync inventory does
not revoke the separate container lease. It does prevent any guessed pause.

Public check distinguishes missing from unknown or conflicting state. Public
termination requires valid saved configuration and qualified scope, preserves
legacy/foreign/ambiguous records, and reports success only after checked native
completion. Existing monotonic wait and native timeout limits remain.
Inventory queries have a 30-second default native budget; polling clips that
budget to the remaining deadline. Each public operation captures the Mutagen
environment and working directory through its fresh native composition.

Verify actual emitted code with a stateful instrumented Mutagen executable,
including two independent processes using the real existing guard. Assert exact
identifier controls, host isolation, unknown/legacy/conflict refusal, replacement
preservation and truthful failure reporting. No live engine is needed.

## Native format and known ceiling

The adapter uses Mutagen's [public JSON session model](https://github.com/mutagen-io/mutagen/blob/v0.17.0/pkg/api/models/synchronization/session.go)
and [template listing](https://github.com/mutagen-io/mutagen/blob/v0.17.0/cmd/mutagen/sync/list.go).
[Names do not uniquely select sessions](https://mutagen.io/documentation/introduction/names-labels-identifiers/).
Native protocol/path parsing stays outside application policy.

The existing `user@host:docker://…` create representation is an SSH endpoint
path in stock Mutagen, not proof of a nested Docker transport. Actual container
transport, live SSH and native engine/platform acceptance require separate
verification. This operation must not silently claim or invent that support.
