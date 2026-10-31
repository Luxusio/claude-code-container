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
raw errors preserved. Windows process-identity JSON is emitted explicitly as
UTF-8 so Unicode command-line arguments retain the canonical native SHA-256
identity; command text is neither normalized nor rewritten for comparison.

The broker application returns semantic lifecycle facts. Provider preparation
exposes an opaque capability for one native effect; executable paths, argument
arrays and input framing stay in broker composition. The native presenter owns
HTTP status, public plans and secret redaction. Polling, compensation eligibility
and conditional publication remain in the application.

Create compensates provisioned artifacts after claim failures. Start publishes a
claimed runtime only after native identity capture and retains the original boot
and rollback outcomes. Stop reports uncertain termination without publishing a
false stopped state. Delete retains force, owned AVD and liveness checks before
cleanup and removal. The direct and broker variants intentionally differ: direct
DTOs include their existing null fields; broker DTO omissions, dry runs,
idempotence and execution diagnostics retain their own contracts.

Direct start gives the actual spawned process a separate, bounded 10-second
identity-capture phase, matching the native identity producer's existing
10-second allowance. Each native identity probe remains capped at 5 seconds
and the captured phase remainder; a positive observation arriving after the
phase expires grants no identity authority. Missing or late identity triggers
fresh-child rollback and preserves unresolved runtime state if cleanup cannot
be confirmed. This phase starts after spawn and completes before boot polling.
`bootTimeoutMs` remains the separate post-identity boot-polling allowance;
`waitForBoot: false` skips boot polling but still requires process identity.

Fresh Windows rollback resolves `System32/taskkill.exe` through the canonical
system executable resolver, independent of caller `PATH`. Its existing
10-second native-command cap and 3-second exit grace share one captured
13-second ceiling. The exit grace starts when the native command returns and
cannot exceed either 3 seconds or the remaining aggregate allowance. The exact
returned child handle must acknowledge process
exit; absence of a PID or completion of a different process is not proof.
Tree termination remains unsuccessful when native tree cleanup is unconfirmed.

Broker publication uses the reviewed complete-record conditional transition and
advances its expected record after committed auxiliary cleanup. This fences
inventory publication while completed native effects are reported truthfully.
Complete-record equality does not establish process generations or reject
byte-identical ABA. The historical id-only race is pre-repair evidence and is
not a passing successor-safety claim.

Verification exercises current lifecycle applications, required finite ports,
actual public MCP and authenticated broker bindings, and both emitted
distribution forms. Core tests assert lifecycle decisions and observed state;
native tests assert public responses and process effects. They do not need
frozen original implementations or implementation-name assertions.
Provider/process/signal denial counters and owned fixture joins are bounded
controls, not a blanket filesystem/network syscall proof. Real emulator,
provisioning and destructive SDK/AVD acceptance on native hosts remains separate
and must not be inferred from portable fixtures or architecture tests.
