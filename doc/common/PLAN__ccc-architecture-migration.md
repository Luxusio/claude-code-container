# CCC architecture migration and worker handoff

Status: implementation specification, 2026-10-05. No migration completion claim.
Design authority: [ADR](ADR__ccc-target-architecture.md),
[contracts](SPEC__ccc-architecture-contracts.md).

## Delivery rule

Design is complete enough to assign bounded implementation packets below. It is
not permission for a worker to silently redesign authority, persistence or wire
contracts. A newly discovered constraint must update this design and receive
review before dependent work. Do not interpret a complete plan as proof that all
native conditions or legacy branches have already been exercised.

Implement one packet per reviewable change. For each source family, list exact
symbols, callers, exports, state files, lock ownership and current tests before
moving it. Keep existing user edits and the uncommitted readiness foundation.
Baseline is commit 2c90a331 plus that five-file foundation. Verify the actual
checkout at assignment time; never overwrite later user changes.

Public input/output and persistent bytes are frozen during extraction. New module
names are target paths, not files that already exist. Feature-wide rewrites,
backward-compatible public API redesign, new protocols and new durable schema
are separate tasks. No dynamic plugins, global retry layer or hidden service.

## Dependency graph and parallelism

```text
M00 -> M01 -> M02 -> M03
                      |-> M04 -> M05 -> M06 --|
                      |-> M07 -> M08 --------|-> M09 -> M13 -> M14
          M01 -> M10 -> M11 -> M12 -----------|
```

Additional dependency: M10 session cleanup calls Device Lab administration through
an explicit port; it may wrap legacy cleanup until M06 is integrated. M13 waits
for both sides. M08 depends on M07's lease/recording ports only for the operations
using them. M05 may start after M02 contracts and M04 acceptance, while M06 uses
M05 resource contracts. Parallel workers may own different NEW modules; central
entrypoints (`index.ts`, broker, server, shared manifests) have one integration
owner. Never assign two workers overlapping edits to a legacy monolith. Split
branch worktrees only after a common contract commit and record merge ownership.

### Parallel implementation and verification (2026-10-15)

Run dependency-ready work in parallel through implementation, independent review and scoped QA. Each writer owns literal disjoint paths; each verification command owns its output and cache directories. Shared entrypoints have one integration owner. A lane may start QA after its own required actual review PASS without waiting for unrelated lanes. Parallel workers may read the same qualified immutable inputs, but must not race producers or shared native resources.

Run independent tests, typechecks and lint concurrently. Build a shared producer once and let dependent consumers use its completed output. Preserve passing evidence for unchanged inputs; rerun checks when a related change, failure or unresolved concern requires it. Do not repeat an unchanged lane's full checks solely because another lane finished or because automatic receipts are absent.

After writers and their scoped verification join, integrate the shared connections and run one integration verification cycle for the combined candidate: changed call paths, contracts and affected distribution boundaries. Recheck those affected paths if integration reveals a defect. This is not permission to omit native acceptance or required independent review. Actual platform blockers stay explicitly unverified; they do not prevent unrelated portable work. Host singletons, shared brokers, device leases and shared output directories retain one owner; a polling timeout does not authorize restarting a live job.

Use the existing PLAN/WBS to record ownership, dependencies and qualified results. No new verification framework, default full-suite/build run, hosted CI, push, branch or worktree is authorized by this scheduling change.

## Work packets

All paths are repository-relative. In every packet, unrelated code and real user
state are forbidden. Existing tests may be extended; never replace assertions
with skips just to pass on another OS. Rollback policy below applies to all packets.

### M00 — Baseline and migration ledger

- Own: architecture baseline manifest and tests under `src/__tests__/architecture/`
  (new), fixture utilities under `src/__tests__/helpers/`, documentation here.
- Enumerate exported entrypoints and schemas, authority/lock rows, state validators,
  package assets and current regression groups. Record source/artifact revision
  separately from user-reported native passes. Inventory all production families
  in the ADR, including installers and helper scripts.
- Add characterization where a moved behavior lacks it; preserve canonical MCP
  tools and recorded response normalization, not unstable timestamps/PIDs.
- Done: every later packet has exact symbols/tests/native lane mapping; tests cannot
  discover live host providers implicitly. Existing suite failures are classified
  before refactoring; no fabricated baseline PASS.

### M01 — Core and composition foundation

- Own: `packages/device-lab/providers/{domain,ports,application,composition}/`,
  `src/{domain,ports,application,composition}/`, application boundary tests and
  dedicated migrated-core typecheck configuration.
- Retain readiness `.mjs`, complete its checkJs/declaration consumers and adapter
  compatibility. Introduce typed outcomes, explicit context/budget/clock/IDs only
  as used by operations. No unused universal interface library.
- Guard imports, static/dynamic paths and ambient effects; verify negative fixtures.
  Allow pure domain imports from application. Each permitted edge is documented;
  no permanent blanket legacy escape hatch for migrated code.
- Done: readiness source and packaged MCP parity, positive-budget behavior, original
  response identity and redacted evidence. Guard fails on actual forbidden import.
  Every new core/test is included in explicit typecheck, not only transpiled.

### M02 — State, identity, claims and execution seams

- Own: Device Lab `providers/state/`, new `providers/{ports,adapters}/state/`,
  `src/device-lab-{owner,ownership-state,process-identity,shared-state,state-file}.ts`
  as relevant, broker state construction only through the integration owner.
- Wrap existing implementations before consolidation. Explicit roots/identity
  supplied by composition. Compare-and-replace preserves current exact generation
  and legacy checks. Wrap journals, process inspection and locks without changing
  disk format or existing process placement. Expand the lock matrix for each moved
  operation, including specialized nested sublocks.
- Done: corrupt vs missing, linked/oversized file, CAS conflict, successor, PID reuse,
  unknown liveness, atomic replacement, stale lock and two-process contention cases.
  TS and `.mjs` validator parity before deletion of duplication. No host home fallback.

### M03 — Capabilities, routes and transport contracts

- Own: `device-lab-mcp/src/{server,broker,tools,tool-arguments,creation-input}.mjs`
  through one integration owner; new shared capability/application entrypoints;
  broker authorization/dispatch binding only.
- Introduce capability descriptors and explicit local/remote application bindings.
  Move provider-neutral selection policy to core; keep RPC authentication in host
  adapter and wire validation/presentation in MCP. Expose no raw injected ports to
  RPC callers. Initially wrap legacy handlers as adapters.
- Done: direct/broker/child serialization parity, owner spoof rejection, unsupported
  vs unavailable vs denied distinction, no discovery effects, no mutation fallback
  or broadened replay; MCP public surface unchanged.

### M04 — Sandbox lifecycle (three sequential slices)

- Own: `providers/backends/windows-sandbox.mjs`, new Sandbox domain/application/
  adapter modules, existing Sandbox tests. Native helper `.ps1` changes only if a
  separately demonstrated adapter defect demands them.
- M04a stop: inspect/claim/exact-runtime stop/observe/commit/release.
- M04b delete: stop result, provider absence and fenced storage deletion;
  preserve state on uncertain stop or failed cleanup.
- M04c start: claim, singleton bind, launch, helper readiness, commit/compensate.
- Do not change foreground/minimized behavior, helper wire, login policy or timeout
  defaults in extraction. Keep current state/singleton interleavings, not a fake
  multi-file transaction.
- Done per slice: failure before/after each claim, launch, observation and commit;
  delayed old completion; replacement singleton; interrupted retry; shared lock
  child/broker parity; narrow native Sandbox run with actual window/control proof.

### M05 — Hyper-V CCC lifecycle

- Own: Device Lab `src/device-lab/broker/hyper-v/{power,delete,state,operation-journal,
  vm-create-adapter,vm-create-compensation,vm-create-preflight,lifecycle-adapter}.ts`
  and new broker-only application/composition modules; broker callsites centrally.
- Migrate create, power, delete, snapshot as separate commits with existing journals.
  Reuse `@ccc/hyper-v` pure planners/native contracts; keep CCC ownership out of it.
  No TypeScript/PowerShell schema redesign while extracting orchestration.
- Done: exact VM/Notes/incarnation, disk-chain fences, journal repair/replay,
  compensation ownership, timeout ambiguity and privilege behavior preserved;
  library/type/static and narrow Windows/Linux native evidence.

### M06 — Images, networking and administration

- Own: Hyper-V image/network/status/snapshot collaborators, `providers/backends/linux-vm.mjs`
  image portions, `src/device-lab-admin.ts` callsites, shared administration application.
- Separate image import/cache, host fabric allocations, snapshot coordination,
  owner cleanup/prune and all-projects commands. Pure selection; native/storage
  effects behind specialized ports. Host-wide network and per-device scopes differ.
- Done: fabric remains on failed create when appropriate; exact switch/NAT identity;
  no pruning on inventory failure; active allocation/foreign resources preserved;
  owner/all-projects authorization and cleanup evidence remain explicit.

### M07 — Physical devices, recording and Appium

- Own: physical lease store, runtime-generation, Android/iOS device paths and broker
  recording/Appium operations via new capability modules; integration owner merges.
- Separate attach/heartbeat/detach, recording start/finalize/status and Appium
  session lifecycle. Avoid replacing them with VM states. One canonical generation
  comparison; parent device and auxiliary process generations are distinct.
- Done: lease contention/loss, foreign owner, stale heartbeat, duplicate attach,
  PID reuse, late finalization and failed signal preserve successor state; physical
  hardware lane gated by explicit authorized target, never auto-selected unit fixture.

### M08 — Remaining provider capabilities

- Own sequentially: Android emulator, iOS simulator, macOS VM, container-QEMU Linux,
  X11 display backend files and corresponding new provider modules.
- For each provider: lifecycle before dependent control/transfer/snapshot actions;
  preserve native differences and existing helper programs. Registry advertises
  actual capabilities; policy lives in application, command encoding in adapter.
- Done: per-provider route/response parity and owned-resource cleanup; native OS
  evidence for affected adapter. Unsupported platforms test codecs/core without
  pretending to run native providers. No blanket skips of portable contract tests.

### M09 — Device Lab entrypoint completion

- Own: remaining `device-lab-broker.ts`, `broker-entry.ts`, MCP server/presenters,
  package entry exports and duplicate response/state glue.
- Replace all migrated legacy wrappers with application calls. Broker owns HTTP,
  authorization, supervision and composition; MCP owns schemas/envelopes. Common
  policy must have one source. Remove migrated internal facades atomically.
- Done: no direct backend/state imports in migrated presentation, no provider MCP
  envelopes; execution/lock registry covers every route; MCP/tool coverage and
  packaged stdio tests pass. Broker may still contain transport code, not workflows.

### M10 — CCC sessions and containers

- Own: `src/{docker,container-runtime,container-setup,session,session-lock-liveness,
  bind-mount-verification,container-restart-guidance,iptables-retry}.ts` and new core/
  adapter modules. CLI callsites managed by integration owner.
- First explicit runtime selection and session claims; then reuse/defer, create,
  restart, setup, stop/cleanup separately. Signal registration and real environment
  live in composition. Pin container identities and preserve existing lock order.
- Done: busy session prevents replacement, unknown claimant blocks cleanup, changed
  mount source identity, unavailable exec, deferred credential refresh, rootless
  UID/SELinux and remote-runtime behavior. Native Docker/Podman lanes required.

### M11 — Workspace, profiles, credentials and tools

- Own: `src/{worktree,profile,home-layout,tool-registry,tool-detect,scanner}.ts`,
  credential pieces of docker, tool installation pieces of container-setup.
- Break concrete registry↔installer constant dependency first. Separate workspace
  create/repair/remove, profile resolution/migration and credential refresh plans.
  Native source reads/copies/signing rewrite behind scoped adapters.
- Done: private temp Git repositories; nested-worktree, branch and inode guards;
  user files quarantined/preserved; unreadable UID source, marker link, failed
  publish, stale invalidation; no secrets in results. Existing unresolved SSH-agent
  forwarding issues remain a separate fix, not silently declared solved.

### M12 — Host services, tool sessions and remote execution

- Own: `src/clipboard-server.ts`, `codex-*.ts`, `remote.ts`, connectivity/proxy/
  forwarding files, related native scripts, new domain/application/adapters.
- Separate clipboard HTTP/native/cache, Codex recognition/recovery/PTY launch,
  remote lease/sync/SSH, and endpoint ownership. One operation slice per commit.
- Done: Unicode and image fallback, auth/body limits, artifact/session cleanup;
  exact argv and at-most-one qualified recovery; expired vs unknown remote lease;
  encoding/quoting preserved. Native Mac clipboard and runtime paths remain release
  gates; Linux command fixtures cannot substitute.

### M13 — Composition and distribution closure

- Own: `src/index.ts`, remaining CLI presenters, workspace exports/build/assembly,
  installer, Dockerfile/Containerfile and MCP bundler as required by import cutover.
- Finish explicit composition roots (CLI, direct MCP, broker, child, recovery
  bundle). Remove old internal paths/duplicate implementations after caller audit.
  Keep public CLI/MCP and shipped path compatibility. No runtime transpiler dependency.
- Done: source vs built import parity; package install/extract outside checkout;
  embedded distribution without repository node_modules; assets resolve on Windows
  and Unix; no private path/token packed. CLI outputs/exit codes unchanged.

### M14 — Structural enforcement and reliability lanes

- Own: architecture tests, migrated-core typecheck configs, fixture infrastructure,
  `.github/workflows/ci.yml`, durability runners only as necessary, verification docs.
- Extend guards to every migrated domain/application. Add deterministic fault
  schedules and bounded model/property tests for state transitions; replay seeds
  and failpoint IDs saved as private test artifacts. Exercise critical invariant
  assertions with intentional mutation examples to prove tests detect removal.
- Done: core portable suite + native-adapter subprocess suite + installed package
  suite + OS matrix + separately scheduled real providers. Full lifecycle residue,
  process and memory checks; missing native prerequisites visibly unverified.
  Architecture migration exit criteria below all met.

## Verification commands and evidence policy

Run in an isolated local verification checkout; do not build/test this shared
Windows-backed working directory. Synchronize the exact candidate revision plus
uncommitted owned files before running. No tests may use the user's actual home,
SSH keys, live broker or existing VMs implicitly.

Existing executable commands (not commands newly implemented by this design):

| Purpose | Command / evidence |
| --- | --- |
| Fast readiness baseline | `node node_modules/vitest/vitest.mjs run src/__tests__/device-lab-start-readiness.test.ts src/__tests__/device-lab-application-readiness.test.ts src/__tests__/architecture/core-boundary.test.ts` |
| New shared core typing | `node node_modules/typescript/bin/tsc --noEmit --allowJs --checkJs --target es2022 --module nodenext --skipLibCheck packages/device-lab/providers/application/start-readiness.mjs` (expand explicit scope in M01) |
| Relevant portable regressions | direct Vitest with packet-owned existing filenames after artifact preparation; list exact files in packet handoff |
| Build/package | `npm run build`, `npm run test:packages`, `npm run build:device-lab-mcp` |
| Existing type contracts | `npm run typecheck:tests`, `npm run typecheck:real-tests`, `npm run typecheck:hyper-v:windows:contracts`; these do not automatically include new core tests |
| PowerShell | `npm run test:hyper-v:static`; Windows parser/Pester lane `npm run test:hyper-v:pester` |
| Broker durability | `npm run test:durability:device-lab`; `npm run test:durability:device-lab:real:self` |
| Real providers | `npm run test:level1`, `npm run test:level2`, `npm run test:level3` on appropriate hosts |
| Targeted Hyper-V | `npm run test:level3:hyper-v:windows`, `npm run test:level3:hyper-v:linux`, `npm run test:hyper-v:nested` |
| Repeated native target | `npm run test:durability:device-lab:real -- --target windows-sandbox --cycles 2` (explicit disposable resources; one real suite per host) |

Root `npm test` builds first; direct Vitest does not establish built-artifact
freshness. Preserve existing Level 0–3 meanings instead of relabeling mocks as
Level 3. CI currently has Ubuntu tests/Podman and Windows static/package checks;
it is not a complete Windows/macOS native VM/clipboard matrix. M14 adds portable
Windows/macOS lanes and explicit host-capable native lanes. Hardware/virtualization
unavailable on a runner is not PASS. Native report includes commit and artifact
hash, OS/runtime versions, capability, operation, cleanup result and skipped reason.

For each migrated operation inject failures before/after claim, durable intent,
dispatch, observation, commit, journal clear and release where those stages exist.
Also test concurrent successor, owner mismatch, unknown liveness, timeout, output
truncation, cancellation and cleanup failure. Use bounded repeatable seeds. Native
full E2E runs after relevant narrow tests pass, and at integration/release; do not
make every pure edit trigger a thirty-minute provider suite.

### Existing regression anchors by packet

Paths below are under `src/__tests__/` unless noted. They are the mandatory
starting regression set, not a claim that they cover new ports without additions.
Use the direct Vitest command above with these literal filenames; add new packet
contract tests to the same invocation and record its result.

| Packet | Existing regression anchors |
| --- | --- |
| M02 | `device-lab-owner-state-validation.test.ts`, `device-lab-state-file.test.ts`, `device-lab-state-crash-recovery.test.ts`, `device-lab-runtime-generation.test.ts`, `device-lab-broker.leases.test.ts` |
| M03 | `device-lab-mcp.definitions.test.ts`, `device-lab-mcp.broker-routing.test.ts`, `device-lab-mcp.broker-param-coverage.test.ts`, `device-lab-mcp.owner-context.test.ts`, `device-lab-broker-capabilities.test.ts` |
| M04 | `device-lab-mcp.windows.test.ts`, `device-lab-start-readiness.test.ts`, `scripts/real-tests/windows-sandbox-e2e.test.ts` |
| M05 | `hyper-v-windows-vm-create-lifecycle.test.ts`, `device-lab-hyper-v-vm-network-adapter.test.ts`, `device-lab-broker.commands.test.ts`, `hyper-v-windows-low-level.test.ts` plus operation-specific journal/snapshot suites discovered by M00 |
| M06 | `device-lab-admin.cleanup.test.ts`, `device-lab-admin.prune.test.ts`, `device-lab-mcp.linux-vm-provider.test.ts`, `device-lab-broker.commands.test.ts` |
| M07 | `device-lab-broker.leases.test.ts`, `device-lab-broker.appium.test.ts`, `device-lab-mcp.broker-appium.test.ts`, `device-lab-mcp.android-real-device.test.ts`, `device-lab-mcp.ios-real-device-cleanup.test.ts`, `device-lab-runtime-generation.test.ts` |
| M08 | `device-lab-mcp.android-emulator.test.ts`, `device-lab-mcp.ios-simulator.test.ts`, `device-lab-mcp.macos.test.ts`, `device-lab-mcp.macos-desktop-video.test.ts`, `device-lab-mcp.linux-vm-provider.test.ts`, `device-lab-window-list.test.ts` |
| M09 | `device-lab-mcp.broker.test.ts`, `device-lab-mcp.definitions.test.ts`, `device-lab-mcp.broker-routing.test.ts`, `device-lab-broker-call-flow.test.ts` plus package suite |
| M10 | `docker.test.ts`, `docker-args.test.ts`, `container-runtime.test.ts`, `container-setup.test.ts`, `session.test.ts`, `session-lock-liveness.batch.test.ts` |
| M11 | `worktree.test.ts`, `profile.test.ts`, `home-layout.test.ts`, `tool-registry.test.ts`, `docker-git-signing-config.test.ts`, `docker-ssh-mount-proof.test.ts` |
| M12 | `clipboard-copy-server.test.ts`, `clipboard-image-server.test.ts`, `clipboard-unicode-transport.test.ts`, `codex-launch.test.ts`, `codex-resume-runtime.test.ts`, `remote.test.ts`, `remote-lifecycle-lock.integration.test.ts` |
| M13 | `package.test.ts`, `codex-resume-package.test.ts`, `scripts/test-workspace-packages.mjs` through the package command |
| M14 | all migrated boundary/contract suites, durability self-tests, full portable and designated native lanes |

## Worker assignment template (including 6.1 sol)

```text
Implement packet Mxx, slice <operation>, at base <commit>, using the three design docs.
Read current symbols/callers: <exact list>. Own edits: <literal paths>.
Other workers own: <paths>. Do not change: wire/schema/lock order/process authority.
Prerequisites merged: <packet commits>. Preserve unrelated work.
Before editing: record existing authority, state files, lock acquisition trace and tests.
Implement only this slice. If code contradicts design, report concrete evidence;
do not introduce a new architecture, compatibility shim or relaxed safety assertion.
Run: <exact portable/contracts/build commands>. Native lane: <host/capability or pending>.
Return: changed files, outcome/port contracts, invariant tests, command results,
remaining native gaps, rollback considerations. Request independent review then QA.
Do not self-certify global completion, merge master, publish, or mutate user resources.
```

Model choice changes execution capacity, not review authority. A 6.1 sol worker can
implement a bounded packet; the integration owner resolves shared contracts and
reviews cross-packet behavior. Tests and independent review are still required.
No worker is assigned the entire monolith with only "make it hexagonal".

## Rollback, stop conditions and final acceptance

Each extraction commit is independently revertible and preserves stored bytes.
Rollback means revert code/import changes, not delete journals or overwrite user
state. If an extraction requires a schema change, stop and split it into a versioned
migration with old/new reader and interruption tests. On unknown native outcomes,
retain receipts and reconcile; never kill arbitrary processes or delete state to
restore a green test. If distribution parity fails, keep the old public binding
until the atomic caller migration can pass; do not ship two active authorities.

Stop a packet for ownership weakening, new implicit host access, unexplained public
response drift, lost evidence, unverified process termination, or unresolved
cross-process deadlock. Fix or explicitly block that packet; independent packets
may continue only if they do not rely on its contracts.

Global done requires: all ADR inventory rows assigned/migrated; one implementation
per use case; presentation has no provider/state effects; domain/application guards
cover every migrated directory; no hidden production defaults in test construction;
canonical capability/authority registry complete; storage and wire compatibility
proved; source/package/install parity; native gates recorded per affected platform;
no leftover owned runtime resources; accepted limitations explicitly recorded.
Track M00–M14 as pending until evidence exists. Only the readiness foundation has
local implementation evidence today (58 tests, checkJs, bundle, independent review
and QA); its native readiness is not newly certified. Complete design does not
mean completed migration.
