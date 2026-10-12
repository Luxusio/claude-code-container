# Application boundaries for device control

Status: accepted incremental direction; first extraction only.

The repository-wide target, contracts and delegation sequence are now specified
in [CCC target architecture](../common/ADR__ccc-target-architecture.md),
[contracts](../common/SPEC__ccc-architecture-contracts.md), and
[migration packets](../common/PLAN__ccc-architecture-migration.md). This document
records the implemented readiness foundation; it does not replace that full plan.

The current system has working provider and transport boundaries, but orchestration
and effects are still mixed. At this decision, the device-lab broker is about
16,958 lines and docker.ts about 3,034 lines. Providers also mix native commands,
response construction and operation decisions. These counts describe audit scope,
not a claim that file size alone establishes a design defect.

We will separate application decisions from runtime effects using explicit ports.
Application modules depend on normalized data and injected functions. Runtime
adapters implement those functions; a separate composition layer selects and wires
them. Application code must not discover providers, read environment variables,
parse MCP envelopes or obtain its own clock. No dependency-injection framework or
new package is required.

The first migrated operation is desktop start-readiness polling in
packages/device-lab/providers/application/start-readiness.mjs. Its probe, now and
sleep ports make elapsed-time decisions and retries deterministic in tests. The
probe receives the available budget and returns a normalized observation. The MCP
adapter retains envelope parsing, diagnostic allowlisting, route and incarnation
forwarding, public result construction and the original successful result object.
The extraction preserves existing readiness semantics; it does not skip actual
control probes or add a new native readiness guarantee.

Application modules may statically import relative .mjs modules in application,
domain and ports. Domain imports only domain; ports import domain and type-only
ports. The reusable AST guard checks these inward edges, including JSDoc type
dependencies, and rejects external/adapter imports, dynamic loading and reserved
ambient runtime identifiers. Pure built-ins and injected effects remain available.
Strict checkJs and typed consumer tests run through `npm run typecheck:architecture`,
which is included in the build. See the [migration guide](../common/GUIDE__architecture-migration.md).
This is an
architecture regression check, not an execution sandbox or proof of total purity;
reviews must still inspect the behavior of dependencies and injected ports.

Later migrations should organize providers around capabilities such as lifecycle,
input, screenshots and execution, without making every provider implement an
identical platform feature set. Keep native commands, files, sockets and transport
encoding in adapters. Keep capability selection and object construction in explicit
composition code, outside application decisions.

Lifecycle operations should express observed state and legal transitions. Distinct
observations such as stopped, starting, control-ready and failed should not be
collapsed into a success boolean. Recovery decisions must account for partial
completion and ownership: retry only when safe, preserve failure evidence, and
make compensation explicit. Introduce these models operation by operation after
recording current behavior; this ADR does not declare a unified lifecycle model
already implemented.

Verification follows the boundary. Deterministic application tests supply fake
clocks and probes and check deadlines, evidence retention and outcomes. Adapter
contract tests check parsing, forwarding and result identity. Fault injection
checks partial failures and recovery invariants. Native integration remains the
separate evidence needed for host/runtime behavior; passing a pure test cannot
establish that a desktop or VM actually became ready.

The broker, docker lifecycle and remaining providers are not certified by this
new guard. Their staged migration requires separate plans, behavior baselines and
review. This foundation deliberately covers the readiness operation and its
application dependency boundary, not a wholesale architecture rewrite.

Direct lifecycle and desktop applications consume finite operation-specific
native observations. Backend adapters own ADB, simctl, Tart, Appium, helper and
Hyper-V transport framing and response diagnosis. Ownership, claims, deadlines,
compensation and publication decisions remain inward; opaque native evidence is
interpreted only by the adapter or outward presenter.

Ephemeral stage finalization also covers native throws and invalid observations.
Remote cleanup failure cannot suppress owned local disposal, and a later cleanup
failure cannot erase evidence of completed publication. The precise lifetime
contract is [desktop transfer staging lifetime](REQ__desktop-transfer-staging-lifetime.md).
