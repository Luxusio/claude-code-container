# CCC target architecture

Status: design baseline, 2026-10-05. Implementation is incremental, not complete.
Scope: the CCC repository, its existing packages and process boundaries. This is
an implementation design, not a certification of every existing function.

Read with [contracts](SPEC__ccc-architecture-contracts.md) and
[migration work packets](PLAN__ccc-architecture-migration.md). Those documents
jointly define the target; a diagram alone is not sufficient implementation input.

## Decision and alternatives

Use a modular application with hexagonal dependency boundaries inside existing
packages, capability-based provider registration, and explicit operation-specific
state transitions/reconciliation. Retain the host broker, MCP process, CLI,
container helpers and provider children where they already supply authority or
isolation. These are process boundaries, not independently deployed microservices.

A provider registry is a statically assembled capability registry, not a dynamic
plugin marketplace. No untrusted plugin loading, new DI framework, universal VM
interface, event-sourcing database, or storage format conversion is required.
Plain injected functions and TypeScript discriminated unions are sufficient.

Layered folders alone would preserve dependencies on real homes and subprocesses.
Microservices would add network, deployment and distributed ownership problems.
A universal provider interface would erase distinctions between attached phones,
Sandbox's host singleton, current display and owned VMs. Whole-tree rewrites
would make the established Windows behavior expensive to recover. Therefore use
one observable operation per cutover with existing compatibility tests.

## Current evidence and coverage

Baseline code: commit 2c90a331 plus the uncommitted readiness extraction. Other
working-tree edits are not part of this design's implementation. Existing
[host-control ADR](../device-lab/ADR__host-control-layering.md),
[workspace ADR](../device-lab/ADR__workspace-packages.md), and
[Hyper-V library ADR](../hyper-v-windows/ADR__library-boundary.md) retain their
ownership, native-command and packaging constraints. Historical paths/protocol
numbers in those documents are history, not permission to restore old topology.

| Production subsystem / current anchors | Responsibility at target | Packet |
| --- | --- | --- |
| `src/index.ts`, `device-lab-admin.ts`, `lab-runner-admin.ts`, `doctor.ts`, `clean.ts` | CLI parsing/presentation separated from application operations; device administration belongs to Device Lab application | M03, M06, M13 |
| `src/docker.ts`, `container-runtime.ts`, `container-setup.ts`, `bind-mount-verification.ts`, `container-restart-guidance.ts`, `iptables-retry.ts` | Container plans, runtime observations, replacement policy and setup execution separated | M10 |
| `src/session.ts`, `session-lock-liveness.ts`, `profile.ts`, `home-layout.ts`, `utils.ts`, `scanner.ts`, `worktree.ts` | Project/profile identity, workspace and session policy; Git/filesystem/locks/environment adapters | M02, M10, M11 |
| `src/tool-registry.ts`, `tool-detect.ts`, credential portions of `docker.ts` | Tool metadata and credential intent; runtime discovery and credential transfer adapters | M11 |
| `src/codex-launch.ts`, `codex-resume*.ts`, `codex-clipboard-image.ts` | Tool-launch and resume application; tool-specific recovery remains CCC-specific | M11, M12 |
| `src/clipboard-server.ts`, `localhost-proxy*.ts`, `network-reach.ts`, `mcp-forward.ts`, `remote.ts`, `scripts/ccc-x11-bridge`, `scripts/clipboard-*` | Local host services and transports; clipboard selection/cache rules isolated from native encoding and HTTP | M12 |
| `device-lab-mcp/src/server.mjs`, `tools.mjs`, `operation-tools.mjs`, `tool-arguments.mjs`, `creation-input.mjs`, `policy/`, `public-output.mjs`, `action-output.mjs`, `available-devices.mjs`, `start-readiness.mjs`, `broker.mjs` | MCP schema/wire compatibility, normalization, presentation; application calls through public Device Lab entrypoints | M03, M09 |
| `packages/device-lab/src/device-lab-broker.ts`, `broker-entry.ts` | Broker HTTP/auth/lifecycle hosting and composition separated from device workflows | M02–M09 |
| `packages/device-lab/src/device-lab-owner*.ts`, `device-lab-project-state.ts`, `project-identity.ts`, `device-lab-shared-state.ts`, `device-lab-state-file.ts`, `device-lab-process-identity.ts`, `device-lab-safe-cleanup.ts` | Canonical identity rules, repositories, locks, process ownership and safe storage adapters | M02 |
| `packages/device-lab/providers/context.mjs`, `commands.mjs`, `responses.mjs`, `status.mjs`, `transfer-file.mjs`, `wait-budget.mjs`, `policy/`, `contracts/`, `state/` | Split domain contracts, application policy, runtime effects and legacy response translation; reconcile duplicated state primitives only after parity | M01–M03, M09 |
| `providers/backends/windows-sandbox.mjs`, `windows-helper.ps1`, `windows-vm.mjs` | Sandbox-specific workflow/claims; WSB and guest-control adapters. Windows VM routes through Hyper-V application | M04, M05 |
| `providers/backends/android*.mjs`, `ios*.mjs`, `macos*.mjs`, `linux-vm*.mjs`, `providers/display/`, `appium-runtime/` | Capability-specific native adapters and provider workflows; physical attachment differs from virtual creation | M07–M09 |
| `packages/device-lab/src/device-lab/broker/hyper-v/`, `src/device-lab/hyper-v-*`, `src/host-control/hyper-v/` inside Device Lab | CCC image/network/ownership and VM operation orchestration outside native library | M05, M06 |
| `packages/hyper-v/src/lifecycle/`, `src/low-level/`, `powershell/` | Existing independent typed host library; preserve pure planning and native contracts | M05 |
| `scripts/workspace-build.mjs`, `scripts/install.js`, Containerfile/Dockerfile, MCP build, package exports | Composition/build/distribution; installed artifacts outside checkout are a separate boundary | M01, M13 |
| `scripts/real-tests/`, `scripts/durability/`, root/workspace tests, `.github/workflows/` | Test layers, native evidence, fault schedules, package contracts and isolation | M00, M14 |

This inventory classifies subsystem families; each packet must enumerate its
exact symbols and callers before editing. File families not yet migrated remain
explicit legacy code, not implicitly compliant.

## Target dependency and source layout

Within root CCC `src/`, shared Device Lab `packages/device-lab/providers/`,
and broker-only Device Lab `packages/device-lab/src/device-lab/` use:

```text
domain/<feature>/         pure rules, identities, plans, typed facts
ports/<feature>/          interfaces owned by the application; domain types only
application/<feature>/    use cases, budgets, claims, reconciliation, compensation
adapters/<technology>/    OS, storage, provider, native library, transport bindings
presentation/<surface>/   CLI or broker wire conversion and public error mapping
composition/              explicit runtime selection and dependency construction
```

Feature names in CCC: container, workspace, session, credentials, tool-session,
clipboard, host-services. In Device Lab: discovery, lifecycle, physical, image,
network, snapshot, control, transfer, recording, appium, administration.
Provider-specific workflows belong in `application/lifecycle/<provider>/` rather
than adding platform conditionals to a universal workflow. Some operations need
only a function; these names do not require one class per folder.

Allowed imports:

| From | Allowed |
| --- | --- |
| domain | own domain; explicitly reviewed pure shared value types |
| ports | domain, type-only other ports |
| application | domain, ports, own application helpers |
| adapters | domain, ports, native libraries; designated low-level effect helpers |
| presentation | public application interfaces, DTO codecs; no provider internals |
| composition | all required concrete implementations; no business decisions |

The MCP `domain/device-request.mjs` has one reviewed shared pure-policy edge:
named imports of `isSnapshotTool` and `snapshotInvocationLimits` from Device
Lab's `device-lab/domain/lifecycle/hyper-v-snapshots.js`. This keeps snapshot
budgets authoritative in one place. The dependency guard admits only that
module and those symbols on this edge, and recursively checks both cores;
other package imports, namespace/default imports and re-exports remain barred.

The call direction at runtime crosses a port into an adapter, but the source
interface is owned inward. Application must never import concrete adapters.
No environment, global caches, current working directory, real timers, random
IDs, console, filesystem, child_process, HTTP or MCP types in domain/application.
Ports explicitly supply required effects. External-input validation happens at
presentation/native boundaries; invariant validation remains in domain too.

Package direction remains CCC / MCP -> Device Lab -> Hyper-V. Neither lower
package imports root CCC. Device Lab may depend on Hyper-V through a concrete
adapter, not from its provider-neutral domain. Hyper-V internal native contract
validation and typed planners stay in that package; do not duplicate them.

Shared Device Lab operations have one canonical checked `.mjs` implementation
under `providers/{domain,ports,application,adapters,composition}`. This tree is
shipped directly and usable by MCP, direct execution and broker children. Add
JSDoc and `.d.mts` contracts where consumer checking needs them; verify declarations
against implementation with checkJs and contract fixtures. Broker-only orchestration
remains TypeScript under `src/device-lab/`, root CCC remains TypeScript under `src/`.
Hyper-V stays TypeScript. No application may exist in both languages as separate
implementations. Broker TS may compose shared `.mjs` use cases via package exports.

The current `providers/application/start-readiness.mjs` stays canonical; no move
is needed to establish purity. A future language conversion requires its own
packaging decision and source/install/bundle matrix, not a worker's incidental
cleanup. Runtime `tsx` is not introduced into shipped applications. Internal
imports change atomically with their callers; public exports stay compatible.
Restrict wildcard exports only after consumer inventory and package tests.

## Process topology and authority

MCP and CLI are clients; the broker is a host execution authority, not the domain.
CLI in direct mode composes a local Device Lab application. MCP in explicit
broker mode composes a remote application client. Broker request handling composes
the same operation contracts with host-owned adapters. Composition chooses one
executor per operation. A transport failure after dispatch never silently falls
back to direct execution. Observations are not permission to mutate.

Broker authentication yields a validated owner context; an RPC body cannot choose
a different owner. Local context is derived using existing project/profile rules.
Read-only inventory is lazy and cannot start providers. A remote client cannot
supply arbitrary host executables, state roots, privileged paths or injected ports.
Child workers receive bounded, validated operation DTOs and inherit only necessary
configuration. The privilege gate and verified process identity stay in adapters.

The broker daemon lifetime, request lifetime, recording lifetime, physical lease
lifetime and VM lifetime remain separate. Closing an MCP session does not kill a
host-owned broker or another session's work. Cleanup executes only explicit owner-
and-generation-scoped operations. Preserve the existing direct and broker ownership
receipts, successor protections and all-projects CLI authorization semantics.

## Future GUI and computer-use extension

A GUI is another authenticated client of application operations. It does not read
private state files or call native providers directly. Reserve application ports
for observation subscriptions and control leases; keep media capture/encoding/
transport in adapters. Stream identity includes device generation and session;
a late frame from an old VM cannot become the new session's observation.

Human takeover requires an exclusive, revocable control lease shared by AI and GUI;
revocation blocks subsequent inputs, while ongoing native commands may need bounded
completion before transfer. Viewing is separate from input ownership. Streams have
bounded queues and may drop old frames; command/audit events must not be silently
dropped. These are extension constraints, not features added by this migration.
WebRTC/RDP/VNC selection, frontend technology and signaling/security endpoints
belong to a separately measured GUI/media design. Their choice does not change
current application contracts and is not an open decision for migration workers.

## Adoption and completion

Use the migration packets, never relocate the whole broker mechanically. Preserve
wire names, arguments, responses, state locations and existing protocol version
unless a separately reviewed change actually alters compatibility. Journals are
recovery records, not a new global event store. No SQLite adoption is implied by
SQLite-style testing.

The architecture is migrated only when every production family above has an
assigned implementation, guards enforce dependency direction, runtime construction
is explicit, no migrated operation uses ambient host state, and native/package
acceptance is recorded. The readiness slice alone satisfies none of those global
completion claims. Missing native hosts are recorded as unverified delivery gates,
not replaced by mocks or counted as success.
