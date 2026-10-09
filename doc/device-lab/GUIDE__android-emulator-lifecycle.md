# Android emulator lifecycle boundary

The direct provider and authenticated host broker expose separate create, start,
stop and delete policies. Their lifecycle applications compose named native
steps; they preserve their existing defaults, validation order, compensation,
response fields and error boundaries. The direct MCP dispatcher retains its
owner/device/allocation locks. The broker retains authentication, owner locks,
parameter parsing and its existing planning boundary.

The direct lifecycle domain owns emulator port validation and deterministic
selection in the existing 5554–5682 even-port pool. The allocation facade retains
bounded all-owner inventory, seed hashing and the shared atomic lock. Invalid
requested ports are rejected before inventory. Additional live ports are filtered
before selection; inventory failures never imply free capacity. The broker reuses
its existing inward preview allocator instead of duplicating direct policy.

Native authorities remain in the provider and broker: SDK and ADB observations,
AVD root/artifact identity, persisted claims, command execution, hidden launcher
assets, real spawn handles, process identity, recording/runtime termination and
boot observation. An application port represents one native step, not a complete
legacy operation. Access occurs at the original phase, with mutable carriers and
raw errors preserved.

Create compensates provisioned artifacts after claim failures. Start publishes a
claimed runtime only after native identity capture and retains the original boot
and rollback outcomes. Stop reports uncertain termination without publishing a
false stopped state. Delete retains force, owned AVD and liveness checks before
cleanup and removal. The direct and broker variants intentionally differ: direct
DTOs include their existing null fields; broker DTO omissions, dry runs,
idempotence and execution diagnostics retain their own contracts.

Broker publication uses the reviewed complete-record conditional transition and
advances its expected record after committed auxiliary cleanup. This fences
inventory publication while completed native effects are reported truthfully.
Complete-record equality does not establish process generations or reject
byte-identical ABA. The historical id-only race is pre-repair evidence and is
not a passing successor-safety claim.

Original controls were captured from reconciled commit
`da5c4bd2ff4121c8ca2ab0f8ff9d0e3332007c8d`, tree
`a571832afc655b6f0871c6c9c8228f15f4aad95e`, before production changes. Thirteen
bounded controls and ten selected existing native regressions passed, with strict
architecture compilation using `skipLibCheck=false`. Frozen source/assets,
genuine emission and test inputs were authenticated after execution. Earlier
unsuccessful oracle attempts remain retained. Durable tests inline the minimal
observations and exercise actual public MCP and authenticated broker bindings.

Those originals establish a comparison baseline, not candidate or shipping
acceptance. Candidate verification must cover current lifecycle applications,
required synchronous/asynchronous ports and both emitted distribution forms.
Provider/process/signal denial counters and owned fixture joins are bounded
controls, not a blanket filesystem/network syscall proof. Real emulator,
provisioning and destructive SDK/AVD acceptance on native hosts remains separate
and must not be inferred from portable fixtures or architecture tests.
