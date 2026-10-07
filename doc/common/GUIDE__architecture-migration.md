# Implementing the CCC architecture migration

Follow the [target architecture](ADR__ccc-target-architecture.md),
[contracts](SPEC__ccc-architecture-contracts.md) and
[work packets](PLAN__ccc-architecture-migration.md). The checked
[migration ledger](../../src/__tests__/architecture/migration-ledger.ts) maps
M00–M14 to source/export/test anchors and native lanes. It records source,
artifact and native provenance separately; it is not a completion certificate.

## Current enforced boundary

The canonical readiness operation is shared `.mjs` under Device Lab's
`providers/application/`. Its pure deadline/probe budget rule is in `domain/`;
the probe, clock and sleep contract is in `ports/`. The MCP adapter still owns
wire traversal, redaction, route arguments, timeout defaults and public results.
No storage, ownership, lifecycle authority or timeout policy was migrated here.

`npm run typecheck:architecture` checks the migrated `.mjs` implementation with
strict checkJs, TS contract consumers and all architecture tests. It is part of
`npm run build`. The contract fixture includes deliberately invalid requests and
outcome accesses: removing a contract must make an `@ts-expect-error` unused and
fail compilation. Vitest transpilation alone is not type verification.

The [AST guard](../../src/__tests__/architecture/core-boundary.ts) scans core
layers in shared Device Lab, broker-only Device Lab and CCC. Domain imports domain;
ports import domain or type-only ports; applications import those inward layers
or application helpers. Module paths, re-exports, TS import types and JSDoc type
imports are checked. Node/package/adapter imports, dynamic imports, runtime
metadata, implicit clocks/timers/randomness and ambient process access fail.
These checks enforce source dependencies; they are not a sandbox for untrusted
code. Concrete effects stay in adapters composed outside the core.

Do not create empty modules to make a layer appear migrated. Legacy files outside
the guarded core directories remain legacy. Add each migrated source to the
explicit typecheck scope and run the guard when extending the boundary. Keep
composition/effect adapters in their existing locations until their packet owns
an atomic caller migration.

## Verification

Use an isolated local checkout with exactly the candidate sources synchronized.
Do not run build/tests against the shared Windows-backed working tree or let
fixtures fall back to the user's home, live broker, VMs or credentials.

```sh
npm run build
npm run typecheck:architecture
node node_modules/vitest/vitest.mjs run src/__tests__/architecture src/__tests__/device-lab-application-readiness.test.ts src/__tests__/device-lab-application-boundary.test.ts src/__tests__/device-lab-start-readiness.test.ts
```

The source/embedded readiness parity test requires fresh assembled artifacts.
It uses Node's resolver and explicit fake ports to compare ready, timed-out,
late, thrown and expired observations without provider discovery. The MCP bundle
is rebuilt separately by the build command. Neither check certifies native
Sandbox, Hyper-V, emulator or macOS behavior. Record native verification against
the actual source revision and artifact hash when that operation's packet runs.

## Known ceiling

### M02a owner-state payload cutover

Both `providers/state/owner-device-state.mjs` and broker
`src/device-lab-owner-state.ts` now call the canonical pure
`providers/domain/owner-device-payload.mjs`. It validates parsed payload shape,
unique safe IDs and bounded unique AVD names, returning the original array.
Each adapter retains its own public regex, error class, byte limits, file
identity checks and missing/corrupt/unreadable classification. The broker's
additional parent-directory fences stay in that adapter.

The shared adapter callers are `providers/state/device-store.mjs` (owner reads,
writes, mutation and claim) and `android-emulator-port-allocation.mjs`
(cross-owner port inventory). Device store keeps its shared mutation lock and
separate device-operation locks. Broker callers remain in
`src/device-lab-broker.ts`: inventory/owner record reads, owner writes and
lifecycle persistence assertions. Broker callers retain lock acquisition and
authority; the domain acquires none. Per-owner `devices.json` format, paths,
generation checks and serialization remain unchanged. No caller moves process.

M02a covers only the parsed payload invariant. The subsequent shared repository
cutover is described below; locks, runtime generation, journals and process
boundaries remain required M02 seams.
Package parity tests exercise source and embedded adapters using Node's actual
resolver; native filesystem/lifecycle behavior is not newly certified.

### M02b shared owner-device repository

`providers/application/owner-device-repository.mjs` owns read/write/mutate/claim/
find/update/exact-record transition policy. Six required synchronous ports are
defined in `providers/ports/owner-device-repository.mjs`: validated read,
existence observation, writable validation, atomic publication, mutation lock
and exact equality. Missing ports fail construction; test construction has no
home, owner, storage or lock defaults.

`providers/adapters/state/owner-device-repository.mjs` binds explicit trusted
state and mutation-lock filenames to the existing native reader, byte validator,
atomic writer, synchronous lock and Node deep equality. `state/device-store.mjs`
composes those ports on the first storage operation of each public call. This
keeps malformed claim input ahead of path resolution/lock acquisition. Bindings
are call-local; subsequent calls resolve the current trusted home/profile again.
RPC inputs cannot inject paths or ports.

The facade resolves `homedir()/.ccc/devices/owners/<ownerId>/<backend>`.
`ownerId()` hashes current cwd/project identity and `CCC_PROFILE`; each public
call resolves them again. This shared device root remains distinct from the
host-only `.ccc/device-broker-private` root. Neither root moves in this cutover.

Repository facade callers are the seven `state/*-state.mjs` wrappers: Android
(`android`), physical Android (`android-device`), iOS (`ios`), physical iOS
(`ios-device`), Sandbox (`windows`), Windows VM (`windows-vm`) and macOS
(`macos`). Claim selectors remain backend-specific, including macOS compound
`provider` + `providerInstance`. `device-lab-mcp/src/server.mjs` also directly
reads `readOwnerDevices(stateKey)` when diagnosing an unsupported device action.
Retained
operation-lock consumers are `backends/android.mjs`, `android-device.mjs`,
`ios-simulator.mjs`, `ios-device.mjs`, `linux-vm.mjs`, `macos-vm.mjs` and
`windows-sandbox.mjs`; their lock composition remains in the facade. Their
state keys are respectively `android`, `android-device`, `ios`, `ios-device`,
`linux`, `macos` and `windows`. Linux also locks the `__images__` identifier;
macOS clones acquire sorted source and destination device locks together.

Repository writes/mutations/claims acquire only `devices.mutation.lock` in the
same executing process. The facade still owns `operations/<hashed-id>.lock`,
its async-local reentrancy tokens, stale/wait defaults and sorted multi-device
acquisition. Existing provider flows keep long operation -> short mutation
nesting. No broker/child lock owner moves. No-op mutations validate output and
compare a serialized snapshot from before the updater; an absent file still
publishes the empty envelope. Exact CAS mismatch preserves the successor and
never invokes the replacement callback.

Native storage primitives, file formats, lock records and error propagation are
retained. This cutover covers the shared repository; broker TS repository,
long-operation lock ports, runtime generations, process identity and journals
remain required M02 work.

Verification anchors: `src/__tests__/architecture/owner-repository-core.test.ts`
checks ordering, faults, claims, no-ops and CAS; `owner-repository-adapter.test.ts`
checks fenced files, two-process contention and source/embedded Node resolution;
`owner-repository-type-contracts.ts` checks the actual `.mjs` API. These proofs
do not certify native Windows/macOS lifecycle behavior.

### M02c auxiliary generation seam

`providers/domain/runtime-generation.mjs` owns the existing three comparison
functions. It preserves truthy string runtime-ID precedence, empty/nonstring
ID legacy fallback, strict field equality and the original recording/Appium
selector lists. `providers/application/runtime-generation.mjs` owns recording
and Appium conditional transitions and recording finalization claims. Its two
required synchronous ports are the existing device updater and new runtime-ID
generation. Timestamps are explicit operation inputs. The compatibility
`state/runtime-generation.mjs` exports the same six functions and composes
native UUID generation and invocation-time Date defaults.

Consumers are `backends/android.mjs` and `android-device.mjs` (recording),
`ios-simulator.mjs` (recording and Appium), `ios-device.mjs` (Appium),
`macos-vm.mjs` and `windows-sandbox.mjs` (recording). Their state wrappers are
respectively `android-state.mjs`, `android-device-state.mjs`, `ios-state.mjs`,
`ios-device-state.mjs`, `macos-state.mjs` and `windows-state.mjs`. Updaters retain
the shared repository's short mutation lock. Existing provider long operation
locks stay with provider routing; recorder/Appium exit callbacks do not gain
a long operation lock. Missing device updates suppress the callback and return
null, while an initially absent repository may still publish an empty envelope.

Generation mismatch returns the exact current record. Finalization generates
its new ID before the updater even if a successor prevents commitment. Preserve
expected/override getter order, forced field precedence and original exception
identity. Only the operation owner decides retry, compensation or process
cleanup. This seam changes no disk format, generation record, lease or process
authority. Full recording/Appium lifecycle remains M07; process inspection,
journals, operation-lock ports and broker repository remain M02 work.

Verification anchors are architecture `runtime-generation-domain.test.ts`,
`runtime-generation-application.test.ts`, `runtime-generation-type-contracts.ts`
and `runtime-generation-parity.test.ts`, plus existing generation, Appium and
regression suites for all six backend consumers. Portable core/codec/package evidence does not
certify native Windows/macOS or physical-device execution.

### M10a explicit container runtime selection

`src/domain/container-runtime.ts` owns the `docker`/`podman` type and exact
CLI/environment override validation. Null, undefined and empty CLI values are
no-ops; other values are neither trimmed nor case-folded. The compatibility
facade `src/container-runtime.ts` re-exports `RuntimeName` at its existing path.
`src/application/container-runtime-selection.ts` owns selection precedence:
explicit override, nonempty `CCC_RUNTIME`, available Podman, available Docker,
then the existing no-runtime error. Its three required synchronous ports in
`src/ports/container-runtime-selection.ts` read the explicit override, read the
environment override and observe runtime availability. Missing callable ports
fail construction; core code has no ambient environment or process defaults.

The facade binds these ports for each uncached selection to its current module
override, current environment and existing `spawnSync(runtime, ["--version"])`
adapter. Availability still means `status === 0`, with the same argv/options.
Explicit/environment selection skips availability probes; automatic selection
short-circuits Podman before Docker. Invalid overrides keep the exact public
errors, and port exceptions propagate without retry or fallback.

Callers remain `src/index.ts` (CLI override and runtime reporting), `docker.ts`
(run/exec/lifecycle), `container-setup.ts`, `session.ts`, `clean.ts`, `doctor.ts`,
`localhost-proxy-setup.ts`, `lab-runner-admin.ts` and `network-reach.ts`.
`container-restart-guidance.ts` retains its type-only facade import. Consumers
continue through the facade; no caller or authority moves process.

The facade owns the process-lifetime override and `RuntimeInfo` cache. Cache
lookup stays before selection; the existing VITEST Docker stub also stays before
selection unless an explicit override exists. A valid CLI override clears info
even when repeated, while no-op/invalid values preserve cache and override.
Version, Desktop, remote, rootless and socket detection, SELinux/mount caches,
host aliases and runtime-specific run arguments remain in the facade. Selection
ports do not gain session claims, lifecycle locks, container launches or cleanup
authority.

Verification anchors are architecture `container-runtime-selection.test.ts`,
`container-runtime-selection-type-contracts.ts` and
`container-runtime-selection-facade.test.ts`, plus existing runtime and consumer
regressions. Direct source, built, extracted and materialized Node imports with
owned fake executables establish portable selection/adapter and package parity.
The portable command-routing adapter is instrumented evidence, not native PATH
or live Docker/Podman daemon certification. Full M10 still requires host fact
collection, cache ownership, session claims/reuse/defer/create/restart/setup/
cleanup and actual native runtime operation proofs in their later packets.

### M10b explicit session-lock liveness

`src/domain/session-lock.ts` owns the existing legacy/v2 owner decoder and
Windows batch observation parser. `src/application/session-lock-liveness.ts`
owns conservative classification through three required synchronous ports in
`src/ports/session-lock-liveness.ts`: current platform, process-start observation
and legacy process probe. Construction validates callable ports without invoking
them. The probe returns `undefined`, so the contract rejects asynchronous probes.
Core code has no ambient process, native commands, storage or deletion authority.

The compatibility facade `src/session-lock-liveness.ts` retains its public
exports and composes ports for each classification. Closures read the current
`process.platform`, call the existing process-start adapter and call current
`process.kill(pid, 0)` with its process receiver. Native procfs, ps, PowerShell,
tasklist and batch adapters keep their existing commands, timeouts and fallback
behavior. Lock formats and opaque start tokens keep their existing validation.

Invalid records return `unknown` without effects. Versioned records reuse
non-unknown cached observations; absent/unknown entries ask the native adapter
once. A matching start token is `active`, a mismatch or missing owner is `stale`,
and present-without-identity or inconclusive observations are `unknown`. Legacy
Windows owners use presence observations; other platforms retain the signal-zero
probe, with `ESRCH` stale, `EPERM` active and other failures unknown. Map,
platform and observation exceptions retain their original propagation.

Session reconciliation now calls this classifier from
`src/application/session-claims.ts` (`filterLiveSessionLocks`), bound through
`src/composition/session-claims.ts`; the public entry remains `src/session.ts`.
`src/clipboard-server.ts` (`hasAnyActiveSessionsExcept`) retains its existing
binding. These callers retain lock filtering, unknown-owner preservation and
stale cleanup authority; classification does not acquire locks, write claims or
delete records.

Verification anchors are architecture `session-lock-liveness.test.ts`,
`session-lock-liveness-type-contracts.ts` and
`session-lock-liveness-facade.test.ts`, plus existing session, batch and clipboard
regressions. The distribution smoke directly imports built domain/application/
facade modules with Node from both extracted packages and materialized installs
outside the checkout, and checks domain/application/ports declarations. Synthetic
observations and portable mocks do not certify native Windows/macOS process
observation; those native receipts remain required in later migration packets.
An unavailable PowerShell parser lane is recorded as skipped.

Known ceiling: Native Windows/macOS observations remain unverified — upgrade
when native execution receipts are available.

M10b covers the record/policy seam. Full M10 still requires host facts, cache
ownership, session claims/reuse/defer/create/restart/setup/replacement/cleanup
and native daemon workflows. M03–M09 and M11–M14 remain required migration work;
this seam does not certify the independently blocked M02c runtime-generation
packet.

### M10c explicit session claims

`src/domain/session-claims.ts` owns the existing container/profile/family filename
selection, claim naming and legacy/v2 record encoding.
`src/application/session-claims.ts` owns reservation, raw claim queries, live
reconciliation, foreign-claim checks and guarded container replacement through
the required synchronous `SessionClaimsPorts` in `src/ports/session-claims.ts`.
Its factory validates callable ports without effects. Storage, current process
facts, observations, classification and the lifecycle critical section are
explicit inputs; core code imports no native process or filesystem facilities.
Effect ports returning `undefined` reject asynchronous implementations. The
generic lifecycle port preserves its callback's result; its type does not forbid
every possible asynchronous callback, although this application supplies only
synchronous operations.

`src/adapters/session-claims-store.ts` retains directory establishment and
real-directory checks, modes, enumeration, reads, exclusive writes and deletion.
`src/composition/session-claims.ts` binds lazy home-layout, platform, PID,
process-start and batch-observation callbacks. `src/session.ts` supplies its
existing lifecycle-lock wrapper, avoiding a composition-to-facade import cycle,
and retains its public signatures and deprecated live-query alias.
Reservation still establishes the directory, generates the ID and captures the
claim path before acquiring the lifecycle lock. The lock wrapper establishes the
directory again; token observation and the exclusive `0600` write happen inside
that lock. Record property order and newline-free legacy/v2 bytes are unchanged.
Profile selection excludes extended profile prefixes; nonprofile container
queries retain legacy single-dash names, while family queries retain their
existing double-dash-only selection and enumeration order.

Raw claims and live observations have different authority. Raw queries only
establish, list and select names: they never read, probe, classify or prune.
Automatic cleanup continues to use raw foreign claims, including malformed or
dead-owner records. Live reconciliation reads candidates, observes decoded
owners in one batch and passes the same observation map to each classification.
A supplied current file may be read once for ownership and again as a candidate;
the existing current-PID legacy supersession rule remains unchanged.
Unreadable, malformed and inconclusive claims remain. Batch observation errors
propagate. Stale entries are excluded even when best-effort removal fails, and
each removal targets the full path captured before classification, preserving
the target if the home-layout environment changes during that call.

Replacement keeps its predicate, live foreign-session check and callback inside
the existing lifecycle critical section. A false predicate skips enumeration
and observations. `hasOtherActiveSessions` deliberately does not pass the current
file into reconciliation. At the M10c cutover, family/setup/lifecycle guard
implementations and their acquisition order, global session context, signals,
public best-effort `removeSessionLock` and automatic cleanup remained in the
compatibility facade. M10d below moves context and cleanup orchestration inward
and native removal/signals outward; the guard implementations still stay in the
facade. Captured-container-ID stop authority is not replaced by liveness.

Verification anchors are architecture `session-claims.test.ts`,
`session-claims-type-contracts.ts`, `session-claims-facade.test.ts` and
`session-claims-lock.integration.test.ts`, plus the existing session, batch,
container and remote regressions. The lock integration uses two actual Node
processes and a private filesystem to exercise reservation/replacement exclusion.
The distribution smoke invokes built domain/application/facade modules through
plain Node in both extracted packages and materialized installs, checks their
declarations, exercises injected reservation/raw/live/replacement flows and
queries malformed raw claims under a private HOME. It never invokes a live
container or probes a claim owner through that public raw-query check.

Known ceiling: existing stale-claim deletion remains unconditional — upgrade during approved receipt/compare-and-release migration.

Portable evidence does not certify Windows sharing/process identity, native
Docker/Podman stop behavior, rootless UID/SELinux or remote device cleanup.
Native lanes still need disposable joined sessions, deferred replacement while
busy, foreign-claim preservation and last-session captured-ID stop receipts.
Session receipt release, host facts, cache ownership and the remaining lifecycle
flows stay required for full M10. Cleanup orchestration is migrated by M10d below;
receipt/compare-and-release and native stop outcome proof remain required. These
extractions do not complete M00–M14 or resolve the independently blocked M02c
packet.

### M10d explicit session context and automatic cleanup

`src/application/session-cleanup.ts` owns mutable session context and synchronous
automatic cleanup through seven required `SessionCleanupPorts` in
`src/ports/session-cleanup.ts`: project identity, lifecycle critical section,
raw foreign-claim query, own-claim removal, device cleanup, device-failure report
and captured-ID stop. Construction validates callable ports without effects;
calls resolve current port methods with their receiver. The TypeScript contract
uses `undefined` returns for effect ports to reject asynchronous implementations;
runtime construction checks callability only. The generic lifecycle port
preserves its callback result and does not universally forbid promise-returning
callbacks; this application supplies synchronous operations. The core imports
only the pure claim-prefix rule and type-only ports, with no ambient native
effects.

`src/composition/session-cleanup.ts` creates the facade's single application
instance using lazy native bindings and facade callbacks for the existing
lifecycle guard and raw claim query. It does not import the facade.
`src/session.ts` delegates its existing context and cleanup exports to that
instance. Snapshots are fresh and expose lock file, project path, profile and
tool name, never the captured container ID. Setting a session defaults a nullish
tool to `claude`, preserves empty strings and resets the captured ID, but does
not rearm already completed cleanup. `clearSession` resets all context and
rearms cleanup. Successful cleanup clears lock/path/profile while retaining
tool name and the hidden ID until a setter or clear changes them.

The PR #9/#10 reconciliation adds separate captured-ID and cleanup-permission
state. Host-owned acquisition starts disabled. Parent and guardian both require
permission before device/container cleanup, with a true parent grant effective
only after the guardian ACK. A captured-ID change first revokes the old grant.
Unauthorized guardian cleanup uses receipt-fenced rollback without device stop.
Legacy unowned `setSession` retains its cleanup-enabled default.

Cleanup preserves the legacy reads across callbacks rather than freezing a
snapshot. It checks the initial lock/path and completion flag, resolves project
identity from the current path, then reads the current profile for the prefix.
Inside the existing lifecycle guard the composed query reconciles proven stale
foreign owners and uses remaining raw claims as the shutdown veto. Device cleanup
reads the current path/profile with a 5000 ms timeout only when foreign claims
are absent and cleanup is enabled. `retryable-owner` removes its own claim after
successful cleanup so a failed stop retains the receipt for retry; `ended-owner`
removes its claim before the query.
Malformed, unreadable or unproven stale-looking foreign raw claims veto devices and stop
while allowing own-claim removal and finalization; a liveness probe alone does not authorize
shutdown. Device exceptions are reported and cleanup continues. The current ID's
truthiness is checked after devices/reporting; the stop port receives a lazy ID
reader. The native adapter evaluates `runtimeCli()` before invoking that reader
to construct `["stop", id]`, preserving runtime-callback mutations without a
second truthiness filter or container-name rediscovery.

`src/adapters/session-cleanup.ts` retains the best-effort exists/unlink remover
for public legacy `removeSessionLock`. Composed owned cleanup instead uses an
unlink remover that ignores only ENOENT and propagates other filesystem failures;
the ownership composition provides receipt fencing. Device cleanup uses the existing administration service
until its M06 migration; reporting retains the existing error message. Native
stop uses `spawnSync` with ignored stdio. Project/guard/query/runtime/spawn/report
and lock-return exceptions escape and prevent finalization; retry can repeat
effects already performed. The M10d compatibility cutover originally ignored
native result status and errors. The subsequent session-exit fix described in
[REQ__session-exit-cleanup.md](REQ__session-exit-cleanup.md) bounds the local stop
wait to 30 seconds and throws on errors, signals or nonzero/absent statuses.
The application consequently remains retryable on failed stop; native stop
success and uncertain daemon-side outcomes still require their own evidence.

Signal registration is outside the application and facade implementation: the
facade delegates through composition to the native adapter, which registers
`process.once` for SIGINT, SIGTERM and SIGHUP on every setup call. Each callback
invokes public cleanup before `process.exit(process.exitCode ?? 0)`; a cleanup exception prevents
exit. No listener deduplication or new reentrancy policy is introduced.

Verification anchors are architecture `session-cleanup.test.ts`,
`session-cleanup-type-contracts.ts` and `session-cleanup-facade.test.ts`, plus
existing session, batch, claims, container and remote regressions. Tests cover
ordered effects, callback mutations, failure/retry boundaries and intercepted
signals. The shared distribution smoke imports the built application, type-only
ports module and public facade through plain Node in both extracted packages
and materialized installs and checks their declarations. It exercises fake-port
cleanup ordering, raw foreign veto, snapshot/reset and public set/get/clear
behavior without native cleanup, providers or live containers.

Known ceiling: callbacks retain mutable context. Own-claim removal is bound to
the native ownership receipt in owned sessions; legacy unowned callers retain
their compatibility remover. The session-exit adapter now checks stop results, but timeout leaves the
daemon-side outcome unknown — upgrade during approved receipt/compare-and-release
and native outcome reconciliation work.

Known ceiling: portable mocks and package imports do not certify Windows/macOS
signals, filesystem sharing/process identity, Docker/Podman stop, rootless
UID/SELinux or remote device cleanup — upgrade when disposable native joined
session, foreign-claim preservation and captured-ID stop receipts are available.

M10d migrates context and automatic cleanup orchestration. Identity-fenced claim
release, reliable stop outcomes, host facts, cache ownership and remaining
reuse/defer/create/restart/setup/replacement flows are still required for full
M10. Full M00–M14 acceptance and native lanes remain required; this packet does
not resolve the independently blocked M02c attestation.

## Existing container reuse, deferral and restart (M10e)

`src/application/container-existing-lifecycle.ts` owns the existing-container
decision flow and identity-fenced replacement through required synchronous
`ContainerExistingLifecyclePorts` in `src/ports/container-existing-lifecycle.ts`.
`createContainerExistingLifecycle` validates callable ports without effects and
returns `run` and `replace`. Each invocation has isolated replacement confirmation
and lifecycle ID state. `run` returns either `joined` with the exact container ID
or `continue-to-create`; unknown listing, changed startup identity and unavailable
contract observations refuse replacement or joining. Effect ports use `undefined`
returns to reject asynchronous implementations in TypeScript; runtime construction
checks callability only.

Project, device and filesystem assertions remain separate and surround strict
contract inspection in their original order. A mismatch attempts replacement
through the caller's lifecycle/session guard. A veto can defer an update only
after the existing safety, running and brief execution-readiness checks. Deferral
fixes SSH and syncs Git without managed MCP synchronization. Normal running reuse
and restart retain MCP, SSH and Git ordering and device-source checks before
handoff. Brief readiness retry is selected only when a guard was supplied;
otherwise readiness remains a one-shot observation. A failed start or unready
restart does not authorize replacement.
M10k below moves the brief retry loop into its own application; existing
lifecycle policy still selects the exact target and retains replacement authority.

Replacement pins the initial identity. The guard may invoke its callback zero,
one or several times, return false after a successful callback, or throw; the
application preserves those behaviors rather than normalizing authorization to
a one-shot boolean. Startup-authorized running recovery checks managed identity
on every callback and stops only the pinned ID. Ordinary stopped replacement
uses the captured initial observation and plain non-force removal as the final
fence against an external start. Removal precedes lifecycle-ID clearing and the
user recreation callback. Callback or guard failures propagate without invented
rollback, and successful removal alone does not imply guard acceptance.

`src/composition/container-existing-lifecycle.ts` binds native start, stop,
removal and presentation. Restart uses the runtime captured by the facade;
replacement stop/removal and restart-required guidance resolve the current
runtime at the existing call points. Native command results stay outside the
application. Composition receives observation and source-proof closures from
`src/docker.ts`, does not import that facade, and performs no native probing at
construction.

The public `startProjectContainer` signature and return remain unchanged. At the
M10e cutover, outer preparation, image/mount/credential checks, fresh creation
and rejected-created-container cleanup remained in the Docker facade. M10g
below now extracts the family-locked creation policy and compensation sequence.
The shared finish closure remains in Docker and now delegates to the M10i
application below: source assertions and, when a ready
callback exists, exact running identity verification precede that callback at
the same join point under the caller's lifecycle lock. Existing and new
containers use the same finish fence; M10i moves its policy into the application.

Verification anchors are architecture `container-existing-lifecycle.test.ts`,
`container-existing-lifecycle-type-contracts.ts` and
`container-existing-lifecycle-facade.test.ts`, plus existing Docker, arguments,
mounts, SSH/signing, restart guidance, runtime/setup, session, remote and index
regressions. Distribution smoke executes the built application with explicit
fake ports from both extracted npm packages and materialized installs, asserting
ordered reuse, successful replacement, veto and unknown-observation refusal.
It checks emitted declarations and imports the native composition and public
facade with subprocess methods fenced to reject native probes. Existing CLI
help/version checks remain. These checks exercise shipped application behavior;
they do not start or remove live containers.

### Known ceiling

Known ceiling: plain removal and synchronous native command results preserve
legacy failure semantics without an operation receipt or unknown-outcome
reconciliation — upgrade during the approved native outcome/CAS work.

Known ceiling: portable fixtures and package smoke do not certify native
Windows/macOS, PowerShell parsing, Docker/Podman, rootless UID/SELinux or remote
runtime behavior — upgrade when disposable native runtime lanes provide actual
operation and handoff receipts.

### Remaining migration

M10e migrates existing reuse, safe deferral, restart and replacement policy.
M10f also migrates explicit stop/remove policy as described below; M10g extracts
fresh creation policy. Preparation, setup/credentials, reliable outcomes and
remaining M10 operations still require their own cutovers.
Full M00–M14 acceptance and native lanes remain required; the independently
blocked M02c attestation is not resolved by this packet.

## Explicit container stop/remove (M10f)

`src/application/container-destructive-lifecycle.ts` owns explicit stop/remove
authorization and ordered cleanup/dispatch policy through the required
synchronous `ContainerDestructiveLifecyclePorts` in
`src/ports/container-destructive-lifecycle.ts`. Its factory validates callable
ports without invoking them. Effects return `undefined`, rejection returns
`never`, and the lifecycle lock accepts a synchronous `() => undefined`
callback. Public `stopProjectContainer` and `removeProjectContainer` retain
their arguments, default options and void return.

The application resolves the project identity and profile claim prefix before
entering the existing lifecycle critical section. Inside that section it reads
raw session claims before checking `options.force`. Empty claims do not read
the force property; nonempty claims require exactly `true`. The options object
remains referenced through the callback, preserving deferred/repeated callback
and getter timing. The existing native claim reader and lock implementation
remain authoritative; the CLI's worktree family lock stays outside this lock
where the existing caller acquires it.

Force overrides only the claim veto. After runtime readiness, a successful
managed identity proof is still required. The Docker facade supplies its
unchanged labels/project-path/mount-identity verifier; unknown, foreign or
unavailable identity reports not found without device cleanup or native
destruction. Successful dispatch uses the proven container ID. Stop resolves
one path after runtime readiness and reuses it for name, identity and cleanup;
remove retains separate path observations for name, identity and cleanup.

Device cleanup keeps its 5000ms budget and best-effort Error/non-Error warning.
If warning rendering fails, that failure escapes before native dispatch.
Already stopped containers are still cleaned: stop reports stopped, while
remove reports removing/removed without a stopped message. Running removal
reports stopping, dispatches stop, reports stopped, then dispatches removal.
Failed stop suppresses removal; failed removal preserves the partial stopped
outcome and suppresses the removed message.

`src/composition/container-destructive-lifecycle.ts` binds native execution and
presentation without importing the Docker facade. It selects the current
runtime separately at each dispatch, uses inherited stdio, retains exact
native errors and uses plain `rm` without force. `src/docker.ts` supplies lazy
native observation/cleanup bindings and delegates public operations to the
application. Its obsolete duplicate cleanup/guard/unlocked policy is removed.
M10f retained container preparation, creation and managed identity proof; M10g
below subsequently extracts creation orchestration while retaining those proofs.

Verification anchors are architecture `container-destructive-lifecycle.test.ts`,
`container-destructive-lifecycle-type-contracts.ts` and
`container-destructive-lifecycle-facade.test.ts`, plus the existing eight stop
and seven remove Docker tests and the prescribed Docker/session/remote/index
regressions. Package smoke runs the actual built application from both extracted
npm packages and materialized installs. It asserts ordered stop/remove, raw
claim refusal, forced null-identity refusal, cleanup-failure continuation and
exact effect IDs. It checks emitted synchronous declarations and imports the
native composition/public facade and constructs composition with subprocess
methods fenced to reject native probes. Existing CLI help/version and prior
package smokes remain; no live container is stopped or removed by these checks.

### Known ceiling

Known ceiling: plain removal and synchronous native command results preserve
legacy failure semantics without an operation receipt or unknown-outcome
reconciliation — upgrade during the approved native outcome/CAS work.

Known ceiling: portable fixtures and package smoke do not certify native
Windows/macOS, PowerShell parsing, Docker/Podman, rootless UID/SELinux or remote
runtime behavior — upgrade when disposable native runtime lanes provide actual
operation and handoff receipts.

### Remaining migration

M10f migrates explicit stop/remove authorization and ordered orchestration;
M10g below adds fresh creation policy. Preparation, setup/credentials, reliable
native outcomes and remaining M10 operations still require their own cutovers. Full M00–M14
acceptance and native lanes remain required; the independently blocked M02c
attestation remains unresolved.

## Fresh container creation (M10g candidate)

`src/application/container-create-lifecycle.ts` owns fresh creation through 18
required synchronous `ContainerCreateLifecyclePorts` in
`src/ports/container-create-lifecycle.ts`. Construction checks callability
without invoking capabilities. Effect ports return `undefined`; the family
lock takes a synchronous callback returning `string`, and `run` returns the
lock's result. Current port methods retain their receiver and are looked up at
each call. The application imports only its type-only ports. Its structural
verification facts preserve verified, deferred, retryable and mismatch results,
including proof route, reason and container path as appropriate.

The public Docker facade delegates only after the existing application returns
`continue-to-create`. The unchanged family guard receives the physical mount
identity prefix, enclosing namespace and physical-project collision refusal,
reports, lazy argument preparation, native creation, source proof and handoff.
Unknown namespace observations remain conservative refusals. The supplied guard
may skip or repeat the callback, return its own string or throw; the application
preserves these behaviors and acquires no additional lock. The caller's outer
lifecycle/session guard and nesting stay unchanged.

Creating/debug output precedes the lazy lab-warning fact, argument preparation
and separate project/device/filesystem assertions. Docker retains the original
argument-building object, profile short circuit and both remote-host evaluation
sites, including proxy environment reads. Native composition reads creation
status before stdout; only nonzero/null status emits the existing initialization
hint and fails. Status zero remains successful even with a native error field.
Output parsing selects the first complete 64-hex whitespace token and preserves
its case. A shortened ID or namespace never authorizes proof, removal or join.

Only post-create source assertions and bind verification are inside the
compensation catch. Sources are checked again in their original order before
the missing-ID refusal or unchanged bounded verifier. Every nonverified result
rejects without an application-level retry. With an exact ID, rejection removes
that ID and then separately asks whether inspection proves absence. Removal
results are ignored; a successful remove status alone is not absence proof.
Explicit absence rethrows the original value. Unknown/present inspection adds
the existing cleanup suffix and retains the primary cause. Native removal or
inspection throws escape without a new wrapper. The final missing-ID handoff
guard remains, and MCP, SSH, Git and shared finish follow verification outside
compensation; late failures never delete the verified container.

`src/composition/container-create-lifecycle.ts` owns subprocesses and exact
presentation. Create, forced rejected-ID removal and absence inspection use the
CLI captured before the existing flow, with unchanged argv/stdio. Existing
proof and synchronization collaborators still select their current runtime at
the original points. The required native context supplies a nullable lazy lab
warning, Docker's unchanged absence classifier and existing initialization hint;
composition does not import Docker. Outer preparation, image/home/credential/lab
mount policy, native source proof and the shared finish body remained in the
facade at the M10g cutover. M10i below extracts that shared finish policy.

Verification anchors are architecture `container-create-lifecycle.test.ts`,
`container-create-lifecycle-type-contracts.ts` and
`container-create-lifecycle-facade.test.ts`, plus `core-boundary.test.ts` and the
prescribed Docker, arguments, SSH/signing, runtime/setup, session, remote and
index regressions. The facade suite uses the actual applications/composition,
mocked native boundaries, complete mount proof, subsequent existing join,
status/stdout accessors, lazy output/environment ordering, captured/current
runtime changes and the unchanged absence-classifier matrix. Architecture
TypeScript checks synchronous contracts in addition to runtime assertions.

`scripts/test-workspace-packages.mjs` adds actual compiled creation-policy
traces to both extracted npm packages and materialized installs while retaining
prior checks. It checks emitted application/ports/composition declarations,
ordered success with exact case-preserved ID, namespace/collision refusal,
missing-ID preservation, nonverified compensation, unknown-absence cause and
late synchronization failure. All six child-process functions are fenced and
ESM builtin bindings synchronized before importing application, composition and
Docker; imports and construction must make zero probes or lazy fact calls.
Coordinator execution of these distribution checks passed in both forms.
Independent review and fresh QA remain required for candidate acceptance.

### Known ceiling

Known ceiling: creation with an unknown outcome or no exact returned ID cannot
authorize cleanup — upgrade when a separate reconciliation policy is approved.

Known ceiling: native removal/inspection throws may obscure the primary
verification error — upgrade when compensation semantics changes are approved.

Known ceiling: portable tests and package smoke cannot establish native
Windows/macOS, PowerShell execution, Docker/Podman, rootless UID/SELinux or remote
creation/handoff/cleanup behavior — upgrade when the retained native acceptance
gates execute against the actual source and artifact hashes.

### Remaining migration

M10g extracts fresh creation policy as a candidate alongside M10e existing
lifecycle and M10f explicit destruction; M10i below extracts shared finish/handoff
policy. Preparation, setup/credentials, host facts, cache ownership, identity-fenced
claim release and reliable native outcomes remain required M10 work. Full
M00–M14 acceptance and native lanes remain required; M02c attestation remains
independently blocked. Portable implementation evidence does not complete those
goals or replace the required independent reviews and fresh CLI QA.

## Container image preparation (M10h candidate)

`src/application/container-image-preparation.ts` owns the existing image
preparation decisions through 11 required synchronous capabilities in
`src/ports/container-image-preparation.ts`. Construction checks callability
without invoking capabilities or reading request facts. `run` returns
`undefined`; effects also return `undefined`, including `exitFailure`, so an
intercepted exit may return in a fixture. Application dependencies are type-only
ports, with no ambient runtime, subprocess, filesystem or console access.

The operation observes local existence first. A local image with no version
label or an exact matching version returns immediately. A differing label,
including the empty string supplied through the core port, reports a mismatch;
an absent image reports a pull. It qualifies the registry/version reference,
pulls, then tags a successful pull to the local name. A failed pull with the
original local image warns and returns. Without that image it reports failure,
prints the current-runtime build hint and invokes the injected `exitFailure`
capability. The current native binding throws
`Failed to pull CCC image; container startup was aborted.` rather than calling
`process.exit`, allowing owned launch resources to unwind. Thrown Error and
non-Error values propagate unchanged and stop later effects.

Keep request facts lazy and capabilities live when extracting similar policy.
The local label call reads the image name; a null label returns before reading
version. A stale comparison reads version separately from the diagnostic and
remote reference. Registry is read after the report, before the reference's
version; successful tagging then reads the current local image name. Failed
pulls reuse the captured qualified reference and original existence observation.
Methods retain their receiver and replacements made by earlier callbacks.

`src/composition/container-image-preparation.ts` supplies native helpers through
live closures and binds existing log/warn/error messages plus the throwing
native failure capability described above.
It obtains image name/version from the existing utils exports. The Docker
facade supplies a required lazy registry getter that returns its existing
immutable `DOCKER_REGISTRY_IMAGE` binding; `CCC_REGISTRY` remains a module-load
snapshot. Construction does not read registry or select a runtime, and there is
no composition-to-Docker import cycle. Each existing helper still observes
runtime at its original call site; the build hint selects runtime only after
the failure diagnostic. Public `ensureImage(): void` delegates at the unchanged
preparation point in `startProjectContainer`.

Verification anchors are architecture `container-image-preparation.test.ts`,
`container-image-preparation-type-contracts.ts` and
`container-image-preparation-facade.test.ts`, plus the core boundary and
prescribed Docker, arguments, runtime/setup, session, remote and index suites.
Tests use actual application/composition with native mocks and cover lazy fact
and method getters, callback replacement, exact thrown values, diagnostic order,
Docker/Podman qualification, native result accessors and changing runtimes.
Historical extraction verification covered build, lint, regression tests and
built CLI exit behavior. Those earlier results do not certify this reconciled
candidate; its final source/artifact verification is a separate acceptance gate.

`scripts/test-workspace-packages.mjs` adds actual compiled image-policy checks
to the common smoke used by both extracted npm packages and materialized
installs. It verifies all branches and reachable callback/fact failure traces,
required synchronous declarations and the public facade signature. All six
child-process functions are fenced and ESM builtin exports synchronized before
imports; actual composition construction and development-image execution must
make zero native probes or registry reads. Earlier lifecycle and claims checks
remain. Coordinator package verification passed for both forms. Independent
reviews and fresh QA remain candidate acceptance gates.

### Known ceiling

Known ceiling: existence still trusts nonempty stdout without status/error
classification, and inspection failure remains a nullable development-image
observation — upgrade when separately approved image evidence policy defines
known versus unknown outcomes.

Known ceiling: pull failure retains the existing local fallback, tag results
remain ignored, and exceptions after a pull do not roll back image writes —
upgrade when separately approved publication/reconciliation policy requires
stronger evidence or compensation.

Known ceiling: portable tests and package smoke do not certify native
Windows/macOS, PowerShell execution, Docker/Podman, rootless UID/SELinux or remote
image preparation — upgrade when retained native acceptance gates run against
the actual source and artifact hashes. The portable build skipped native
PowerShell parser verification where PowerShell was unavailable.

### Remaining migration

M10h extracts image preparation only. Native runtime readiness probes/host facts, other
preparation, setup/credentials, cache ownership,
identity-fenced claim release and reliable native outcomes remain required M10
work. Full M00–M14 acceptance and native lanes remain outstanding; M02c
attestation stays independently blocked. This operation does not complete M10
or the whole architecture migration. M10i below extracts shared finish/handoff
policy as another candidate slice; M10j below extracts runtime refusal policy.

## Container session handoff (M10i candidate)

`src/application/container-session-handoff.ts` owns final source-check ordering
and the exact running identity fence shared by existing and fresh container
lifecycles. `src/ports/container-session-handoff.ts` requires synchronous
`assertProjectSources(): undefined`, `assertFilesystemSources(): undefined`
and `identity(id): ExistingContainerIdentity | null`; the identity type is reused
through a type-only import from the existing-lifecycle port. Factory construction
checks those three callable capabilities in order without invoking them.
Missing/malformed capabilities throw `TypeError`; capability getter failures
escape unchanged.

`run(id, name, onReady?)` asserts project sources, then filesystem sources. A
truthy readiness callback triggers a final identity lookup by pinned ID. The
literal guard `!finalIdentity?.running || finalIdentity.containerId !== containerId`
reads running before ID and never reads the ID of a stopped identity. Missing,
stopped or replaced identity throws exactly:
`Container identity changed before session handoff; refusing to join.`
No callback or a falsy callback performs both source assertions without a final
identity lookup.

Readiness retains the public `(id: string) => void` compatibility contract:
legacy value/Promise returns are accepted and ignored. The callback receives the
pinned ID as a bare call with an undefined receiver; no Promise is observed or
awaited. A malformed truthy callback fails only after source checks and valid
identity. Source assertion, identity lookup/getter and callback exceptions,
including non-Error values, escape unchanged. A late failure does not stop or
remove an existing or verified fresh container.

An additive early-start callback captures a successfully restarted existing
container before setup helpers. Fresh creation reaches that callback only after
managed-source and running-identity verification. This callback carries invocation
start authority separately from the final readiness callback: reuse alone does
not authorize cleanup after failed setup. Capture and ACK are required; forced
termination before capture is outside this guarantee, without arbitrary scans.

`src/docker.ts` remains the temporary composition root until M13. It constructs
the factory inside the existing finish closure, binding two source assertion
wrappers and `getContainerIdentity`, then calls `.run(id, name, onContainerReady)`.
The existing-lifecycle void finish wrapper and fresh-creation direct finish call
keep their caller positions. Existing public calls remain compatible with the
additive callback; lock authority, preparation and runtime selection stay in
their current layers, with cleanup permission explicitly separated above.

Verification anchors are `container-session-handoff-core.test.ts`,
`container-session-handoff-types.test.ts` and
`container-session-handoff-facade.test.ts`. The facade tests run actual policy
through public `startProjectContainer` on existing, restarted, deferred and fresh
paths with native boundaries mocked. The shared package smoke checks strict
declarations, the compiled Docker import and actual application behavior in both
extracted npm and materialized payloads without repository/node_modules fallback.
Coordinator source and distribution verification have passed. Independent
review and fresh CLI QA remain required candidate acceptance gates.

### Known ceiling

Known ceiling: final identity observation and callback execution are not atomic
— upgrade when an approved session protocol provides stronger runtime authority
across that interval. This extraction introduces no such guarantee or retry.

Known ceiling: portable fixtures and package checks cannot certify native
macOS/Windows, real Docker/Podman, rootless UID/SELinux or remote handoff behavior
— upgrade when retained native acceptance gates execute against actual source
and artifact hashes. The unavailable native PowerShell parser check remains SKIP.

M10i extracts shared handoff policy only. Other preparation, native runtime
readiness probes/host facts, setup/credentials, cache ownership, identity-fenced claim
release and reliable native outcomes remain M10 work. M13 composition closure,
M14 acceptance and the M00–M14 Goal remain outstanding; independently blocked
M02c attestation is unaffected.

## Container runtime refusal policy (M10j candidate)

`src/application/container-runtime-readiness.ts` owns the synchronous refusal
sequence previously inside `ensureDockerRunning`. The required ports in
`src/ports/container-runtime-readiness.ts` are `isRunning(): boolean`,
`runtimeInfo(): { runtime: RuntimeName; flavor: string }`,
`reportError(message: () => string): undefined` and `exitFailure(): undefined`.
`RuntimeName` comes from a type-only import of the pure domain module. Native
`RuntimeInfo` remains in `src/container-runtime.ts` and is structurally accepted;
the port neither imports that native type nor duplicates the flavor union.
Factory construction checks the four callable capabilities in that order
without invoking them. The exact malformed-capability diagnostic is
`Container runtime readiness requires a callable NAME port.`; getter failures
escape unchanged.

`run(): undefined` preserves the literal `if (!ports.isRunning())` sequence.
Success performs no additional explicit runtime-info observation or refusal
effects after the running probe. Failure observes info once and supplies the
first message lazily. The reporter selects its native callee and receiver
before evaluating the supplier exactly once synchronously, so `console.error`
property access precedes reading runtime for
`Error: ${info.runtime} is not running.`. After reporting, the application reads
runtime again to choose guidance. Docker reads flavor once; Podman reads flavor
once for a machine and twice when checking rootless or choosing the fallback. Getter
changes and changes made by reporting remain visible. There is no destructuring,
normalization or fact validation.

The second diagnostic retains the exact existing guidance for Docker Desktop,
the Docker service, a Podman machine, rootless Podman and the Podman service.
Unknown or arbitrary string flavors retain the service fallback for the selected
runtime; cross-runtime flavor strings retain the existing branch behavior.
After both reports the application calls `exitFailure()` without returning its
result. Observation, fact getter, reporting and exit failures, including
non-Error values, escape unchanged and suppress later effects. Effect returns
are neither inspected nor awaited; an intercepted exit still leaves the public
wrapper returning `undefined`.

`src/docker.ts` remains the temporary composition root until M13. Its public
`ensureDockerRunning(): void` constructs the factory inside the wrapper, binds
the existing `isDockerRunning` and `getRuntimeInfo` observations, and calls
`.run()` without returning its result. Reporting uses `console.error(message())`:
it looks up the callee late, renders the message once and calls it on `console`
without retaining the supplier. Exit looks up `process.exit` late and calls it on
`process` with code 1. The cutover is one import plus that function body.
Existing index, clean and lifecycle callers keep their positions and locks.

`isDockerRunning` remains native: `spawnSync(runtimeCli(), ["info"], { encoding:
"utf-8", stdio: ["pipe", "pipe", "pipe"] })` reports ready only for status 0.
On failure, enabled DEBUG still reports trimmed nonempty stderr before refusal;
empty stderr or disabled DEBUG suppresses that debug report. `runtimeCli` may
read cached runtime facts during the native probe. Runtime selection, detection,
cache ownership and other native helpers retain their behavior. Printed start
commands remain diagnostic text; this policy starts no service or machine.

Verification anchors are `container-runtime-readiness-types.test.ts`,
`container-runtime-readiness-core.test.ts` and
`container-runtime-readiness-facade.test.ts`, plus the core boundary guard and
existing Docker/runtime/lifecycle regressions. Compile rejection checks are
uncalled and distinguish strict synchronous application effects from the
legacy public void wrapper; eager strings and async/void message suppliers are
rejected. Facade tests execute the actual Docker wrapper and application with
native boundaries mocked, including reporter accessors and runtime getters
that mutate each other. Shared package smoke checks shipped
declarations, type-only ports, the compiled Docker import and actual compiled
core/facade behavior in extracted npm and materialized payloads, without
repository or node_modules fallback. The real runtime facade's test setter pins
fake cached facts, and fenced native functions allow only the exact info probe.
Compiled facade checks preserve reporter selection before interpolation even
when the real runtime cache's getters replace the reporter or a reporter
accessor changes facts or throws.
Independent code/documentation review and fresh CLI QA against final source and
artifacts are required candidate acceptance gates.

### Known ceiling

Known ceiling: readiness observation and later container operations are not
atomic — upgrade when an approved runtime protocol supplies stronger authority
across that interval. This extraction adds no retries or service startup.

Known ceiling: portable fixtures and package smoke cannot certify native
macOS/Windows, real Docker/Podman, rootless UID/SELinux or remote behavior —
upgrade when retained native acceptance gates execute against actual source
and artifact hashes. The unavailable native PowerShell parser check remains SKIP.

M10j extracts refusal policy only. Native readiness probes and host facts,
other preparation, setup/credentials, cache ownership, identity-fenced claim
release and reliable native outcomes remain M10 work. M13 composition closure,
M14 acceptance and the full M00–M14 Goal remain outstanding; independently
blocked M02c attestation is unaffected.

## Bounded container exec readiness (M10k candidate)

`src/application/container-exec-readiness.ts` owns the brief retry loop behind
required `ContainerExecReadinessPorts` in `src/ports/container-exec-readiness.ts`:
`now(): number`, `canExec(target: string, timeoutMs: number): boolean` and
`sleep(ms: number): undefined`. `createContainerExecReadiness` validates
callability in now/canExec/sleep order without invoking capabilities. A missing
or noncallable capability throws `TypeError` with
`Container exec readiness requires a callable NAME port.`; getter exceptions
escape unchanged. `run(target: string): boolean` reads the live ports with their
ports receiver. No default ports, timing configuration or generic retry engine
are introduced.

Each run establishes `deadline = now() + 15150` (three 5000 ms probes plus
two 75 ms pauses). For attempts 0 through 2 it reads
`remaining = deadline - now()`, stops when remaining is nonpositive and probes
the exact supplied target with `Math.min(5000, remaining)`. Success returns true
immediately, including a probe that succeeds after the deadline; success does
not trigger another clock read. Every failed probe reads the clock again to
compute `Math.min(75, deadline - now())`, including the final failed attempt.
Only the first two failed attempts sleep, and only for a positive pause. The
final failure retains that clock read but never sleeps. Exhaustion returns
false. Fractions remain unrounded; forward and backward wall-clock jumps keep
their existing arithmetic, with at most three attempts even when time moves
backward. Allocation, clock, probe and sleep exceptions preserve Error and
non-Error identity; intercepted sleep results are ignored without inspection
or awaiting.

Docker remains the temporary native composition root until M13. Its private
`canExecContainerAfterBriefRetry` allocates
`new Int32Array(new SharedArrayBuffer(4))` before factory construction and clock
observations, binds late `Date.now()` and `Atomics.wait(sleeper, 0, 0, ms)` calls,
and delegates probes to the existing `canExecContainer`. Native receivers,
runtime argv, timeout handling, stdio and status classification remain at that
boundary. The existing lifecycle application selects brief retry for guarded
running/restart paths and safe deferral; unguarded running/restart readiness
keeps its single default native probe. Caller decisions, exact selected IDs,
replacement guards and the index lifecycle lock retain their authority.

Verification anchors are `container-exec-readiness-types.test.ts`,
`container-exec-readiness-core.test.ts` and
`container-exec-readiness-facade.test.ts` under `src/__tests__/architecture`.
Core tests use explicit clock sequences. Facade tests execute actual public
`startProjectContainer`, real lifecycle composition/application and readiness
policy with native boundaries fenced. In `scripts/test-workspace-packages.mjs`,
`verifyExecReadiness` checks compiled policy and type-only ports;
`verifyCompiledPublicExecReadiness` separately invokes the compiled public
caller for third-probe success and denied-replacement exhaustion in each
extracted npm and materialized payload. The latter supplies fake filesystem
and native commands, synchronizes builtin ESM exports and pins runtime facts;
it does not substitute an import/export check for public caller execution.
Coordinator package verification passed both forms. Independent code
and documentation review and fresh CLI QA against final source and artifacts
remain required acceptance gates.

### Known ceiling

Known ceiling: 15.15 seconds is a scheduling policy, not a guaranteed elapsed completion
bound or hard cancellation — upgrade when an approved native protocol can bound
or cancel the operation itself. A native probe may overrun its supplied budget;
wall-clock changes and successful late probes retain existing behavior.

Known ceiling: portable fixtures and package smoke cannot certify native
macOS/Windows, real Docker/Podman, rootless UID/SELinux or remote behavior —
upgrade when retained native acceptance gates execute against actual source
and artifact hashes. The unavailable native PowerShell parser check remains SKIP.

M10k extracts brief exec retry policy only. Native probes and host facts,
other preparation, setup/credentials, cache ownership, identity-fenced claim
release and reliable native outcomes remain M10 work. M13 composition closure,
M14 acceptance and the full M00–M14 Goal remain outstanding; independently
blocked M02c attestation is unaffected.

Ledger anchors are not exhaustive operation inventories. Before each cutover,
enumerate exact callers, state files, authority and nested locks, including which
process acquires each lock. M00 remains partial while those inventories are
pending, and M02–M14 remain legacy until their own tests and review pass.
The readiness ports must honor their budgets; the core cannot cancel an external
operation that ignores its deadline. The existing adapter's clock timebase is
preserved by this extraction; a broader monotonic-clock migration is separate.

## Container socket access policy (M10l candidate)

`createContainerSocketAccess` moves socket-access decisions and warning state
into `src/application/container-socket-access.ts`, behind required synchronous
`ContainerSocketAccessPorts`. Probe and grant ports return raw status observations;
probe output remains `unknown`. The warning port returns `undefined`.
Construction checks probe, grant, then warn callability without native effects.
Missing capabilities throw `TypeError`; capability getter failures propagate.
`run(target)` and `resetWarning()` return `undefined`, use live port lookups and
preserve their receiver. The application has no native imports or ambient state.

A probe first reads status. Zero returns without reading output. Other statuses
read and stringify output, trim and split whitespace, then read status again.
Only status 10 with the existing username and decimal GID regex permits grant.
The first two tokens are used unchanged, including leading-zero GIDs; surplus
tokens remain ignored. Grant classification reads its status only. Native
`.error` fields remain unobserved. Dispatch, getter and coercion failures escape
with their original thrown value; returned failures warn and continue.

Warning state advances before the warning effect, including when that effect
throws or reenters the application. It suppresses later warnings across targets
until reset, while probes and grants still execute. Independent application
instances have independent state. Docker composes exactly one private instance,
so existing module-wide lifetime and the public reset hook remain unchanged.

Docker remains the temporary native composition root until M13. It retains both
exported fixed scripts, default-user probe, root grant, separate late runtime
selection, exact argument arrays and stdio. Both native operations retain the
10-second timeout; grant retains the inner 8-second timeout with 2-second kill
grace. The existing index setup caller still passes the final selected target.
No caller authority, privilege, retry or permission policy changes.

Verification anchors are the architecture socket core/type/facade suites and
shared `scripts/test-workspace-packages.mjs` socket verifier. Core tests cover
validation, observation order, input boundaries, exception identity and warning
lifetime. Facade tests execute actual Docker/application/runtime modules with
native effects fenced. The package verifier executes compiled core and actual
public facade in both extracted npm and materialized install payloads, including
strict declarations. Independent code/security/docs review and fresh QA remain
acceptance gates; developer test success alone is not final acceptance.

Known ceiling: portable native-boundary fixtures do not certify real socket
permissions, native macOS/Windows, rootless UID/SELinux or remote providers.
Retained native acceptance must supply that evidence. This candidate is only
socket policy extraction; M10 remaining seams, M13 composition closure, M14
acceptance and the full M00–M14 migration remain outstanding.

## Codex config preparation policy (M10m candidate)

`createCodexConfigPreparation` in `src/application/codex-config-preparation.ts`
owns the existing access-check, repair and finalization decisions.
`CodexConfigPreparationPorts` requires synchronous `probe(target)`,
`repair(target)` and `finalize(target)` observations with a required
`status: number | null` and optional `error: unknown`. Native spawn results fit
this contract without projection or cloning. The application imports only its
port type; it has no native dependencies or ambient defaults. Construction
checks probe, repair and finalize callability in order without effects, with
`Codex config preparation requires a callable NAME port.` TypeError diagnostics.
Port getter failures retain their original thrown value.

`run(target): undefined` preserves the literal branch expressions and repeated
status/error reads. Probe status zero returns before reading error. Otherwise,
error code ETIMEDOUT or status 124/137 yields `Codex config access probe timed out`;
truthy error or a disallowed status yields `Codex config access probe failed`.
A clean status one proceeds to repair. Repair and finalization classify the same
timeout conditions as `Codex config repair timed out`; truthy error or nonzero
status yields `Codex config repair failed`. Clean repair proceeds to finalization;
clean finalization returns undefined. The erased error type assertion leaves
optional-chain property access unchanged for opaque and primitive errors.
Dispatch, status/error/code getters and capability lookup exceptions propagate
unchanged, and no later stage runs after a failure. Other result fields remain
unobserved. There are no new retries, catches, rollback or persistent state.
Successful ownership repair followed by failed finalization remains visible as
partial failure; the application does not restore ownership or replay mutation.

Docker retains the public compatible
`prepareCodexConfigForContainer(containerName, profile?): void` facade. It resolves
the selected profile's host config, prepares mounted directory access first,
then prepares config-file access through two call-local compositions of the same
three-port application. Native probe/repair/finalize bindings use current runtime
selection. Host repair eligibility requires a non-symlink host-user-owned parent
and a regular single-link config file, with absence allowed only for directory
preparation. Container UID observation is lazy and shared by the two repairs.

Root repair grants mapped-principal POSIX ACL access rather than using the old
`chown -h` ownership mutation. Python native scripts pin resources, reject linked
ancestors and file aliases, and preserve contents/owners and unrelated effective
access. Probe/final verification run as the normal container user; repair runs as
root. Native commands retain the 15-second outer timeout and inner 10-second
limit with two-second kill grace, per command rather than end-to-end. The native
runner throws an operation-labelled error before returning failed non-probe
results; clean probe status one still reaches the pure application's repair
branch. Thus injected result-classification semantics above remain intact, while
native operation failures propagate their own diagnostic. Profile writer locks
cover host restoration before MCP config mutation. Docker remains temporary
native composition until M13.

Verification anchors are the three architecture `codex-config-preparation`
core/type/facade suites and the shared workspace package verifier. Core tests
cover branch decisions, strict synchronous types, repeated and throwing getters,
opaque errors, live receivers and stateless calls. Facade tests import the
actual Docker/application/runtime modules and fence only native effects,
asserting exact commands and authority. The shared package verifier checks
compiled policy and actual public facade execution in both extracted npm and
materialized installation payloads, plus emitted declarations. Import/export
checks alone do not prove the public caller. Independent code/security/docs
review and fresh QA remain required acceptance gates.

Known ceiling: portable observations and inert command fixtures do not establish
real Docker/Podman config ownership, rootless UID, SELinux, remote, native
macOS/Windows or mount-race behavior. Retained native acceptance must supply
those proofs. This is only config preparation extraction; remaining M10 work,
M11–M14 and the full M00–M14 migration remain outstanding. Historical attestation
parks are not resolved by this packet.

## Shared tool launcher location (M11a candidate)

`src/domain/tool-layout.ts` now owns the existing fixed `CLAUDE_BIN_PATH` value,
`/home/ccc/.local/bin/claude`. Tool metadata imports this pure value directly.
Native setup imports and re-exports the same binding through its existing public
`src/container-setup.ts` path. Existing consumers retain that export and its
literal string type; setup uses the same value internally. The domain module
has no imports or runtime effects and falls under the recursive core guard and
architecture typecheck. No ports or execution framework are added for a constant.

The previous graph was `tool-registry -> container-setup -> tool-registry`.
Coordinator baseline probes in separate fresh Node processes reproduced a
compiled setup-first `ReferenceError: Cannot access 'CLAUDE_BIN_PATH' before
initialization`; registry-first succeeded. Both probes fenced native effects
and recorded zero effects. These probes used the unchanged compiled artifacts
from the prior verified candidate in the private execution copy. Their helper
reports failure as JSON while returning zero, so the post-change regression must
assert successful import explicitly rather than infer it from process exit.
The new graph has registry and setup both pointing to pure domain data; setup
still consumes the existing registry for installation metadata, but registry no
longer returns to setup or loads its native execution dependencies.

Registry interfaces, selectors, four tool definitions, flags, credential mounts,
install/update commands and shared object/array behavior remain unchanged.
Only its constant import changes. Setup changes only that import, the
compatibility export and its obsolete initialization-order comment. Existing
layout paths, native commands, timeouts, privileges and public functions stay
unchanged. Task baseline checks compare these shared files against their
pre-child dirty copies, so unrelated earlier edits are not treated as this task.

Verification anchors are the architecture tool-registry-layout source/type
suites, recursive core guard, existing registry/setup regressions and shared
workspace package verifier. Actual production imports must be tested in fresh
ESM processes for both first-entry orders, with native effects fenced. The
shared verifier runs these orders and actual public setup calls in both extracted
npm and materialized installation payloads, with declaration compatibility and
literal-type consumer checks. A Vitest module reset or miniature copied graph
cannot establish production ESM initialization behavior. Registry import tests
also prevent accidental installer/native dependency loading. Independent code
and documentation review plus fresh QA remain acceptance gates.

Known ceiling: inert setup calls and package import proofs do not certify real
native installation, host credential transfers, rootless/SELinux or macOS/Windows
runtime behavior. Those remain designated native acceptance lanes. This packet
breaks the constant dependency only; the M11b candidate below addresses registry
metadata ownership. Tool probe/install applications, credentials/workspaces/profiles, remaining M10 work,
M12–M14 and the complete M00–M14 migration remain outstanding. Historical
attestation parks remain unresolved.

## Explicit tool catalog domain (M11b candidate)

`src/domain/tool-registry.ts` owns canonical `ToolDefinition` and
`CredentialMount` contracts, the existing four default descriptors, and pure
selection/projection functions. `createDefaultToolCatalog()` returns a fresh,
independent graph on each call, including descriptor objects, flags/commands,
optional subcommand arrays, mount arrays and mount objects. Existing values and
order stay unchanged. The module imports only the shared pure launcher location.
It has no module catalog, environment/home/platform observation, execution port,
implicit default selector argument or installation effect. Command strings and
host-directory hints remain passive metadata.

`findToolByName(catalog, name)`, `findDefaultTool(catalog)`,
`getAllCredentialMounts(catalog)` and `getNpmTools(catalog)` require caller-owned
catalogs. They preserve the existing `find`, `flatMap`, `filter`, `map`,
`startsWith` and `replace` expressions. Lookup returns the first matching
reference; unknown, empty, case-mismatched and missing-default queries retain
undefined outcomes. Credential projections allocate a new outer array while
preserving mount references. Npm projections allocate new arrays and records,
filter by the exact prefix and use each tool's name rather than its binary.
No trimming, normalization, validation, caching, catch, retry or freeze is added.
Live Array/string methods, their receivers, field-read order and original thrown
values remain observable; overridden results are not normalized or awaited.

The existing `src/tool-registry.ts` path remains a compatibility/composition
facade. It creates exactly one catalog at module initialization and forwards
existing public functions to the explicit selectors. `getAllTools()` returns
the same mutable array, and all getters share its descriptor graph. Push/remove,
reordering and property edits remain visible on subsequent queries. The old
`getDefaultTool(): ToolDefinition` static signature retains its nonnull assertion,
while removal or renaming of Claude can still return undefined at runtime.
The domain default lookup exposes the nullable result explicitly. Other callers
and native setup/install behavior remain unchanged; M13 still owns eventual
composition closure.

The old metadata type exports are re-exported from canonical domain interfaces.
An actual emitted-declaration consumer tested optional interface augmentation
through the old path before and after the change, including nested/direct mount
fields and tool fields. Both compiled without a compatibility bridge. Uncalled
source contracts verify mutual assignability, mutable nested fields, required
catalog/query inputs, optionality and legacy/domain return types. TypeScript
source imports alone are not delivered declaration evidence.

Verification anchors are the architecture tool-registry-domain policy, facade
and types suites, existing M11a defaults/native-isolation/installer tests,
recursive domain guard, and shared workspace package verifier. Domain tests use
custom catalogs and deliberate getter/method overrides; facade tests use actual
modules and restore shared state. The package verifier must execute actual
compiled domain and public facade in both extracted npm and materialized
installation forms, with real declaration consumers. Existing M11a fresh cold
import orders, explicit successful imports, native fences and public ensureTools
VALID/INSTALL proofs remain required. Independent code/docs review and fresh QA
remain acceptance gates.

Known ceiling: pure metadata, inert native functions and compiler/package checks
do not certify host discovery, real installers, credentials, native
macOS/Windows/Docker/Podman, rootless/SELinux or remote providers. This packet
addresses catalog construction and selection ownership. Tool probe/install/launch
applications, preferences/discovery, workspaces/profiles/credentials, remaining
M10 and Device Lab migration, M12–M14 and full M00–M14 acceptance remain
outstanding. Device Lab capability-registry contracts are a separate surface;
this preserved legacy tool-catalog mutability does not change them.

## Explicit tool preference application (M11c candidate)

`src/ports/tool-preferences.ts` defines `ToolPreferencePorts` with five semantic
ports: `readToolOverride(): string | undefined`, `readSavedDefaultTool(): unknown`,
`saveDefaultTool(name)`, `findTool(name)` and `getDefaultTool()`. `src/application/tool-preferences.ts`
exports `createToolPreferences(ports)`, which validates at construction that each
port is callable (`TypeError` otherwise) and reads nothing at construction. The
application never sees the whole config or the environment: unrelated keys such
as `remote` stay out of its reach, and the `CCC_TOOL` name lives only in the
facade adapter.

The application owns the `typeof` string decoding: a saved string, including the
empty string, is kept and any non-string becomes `null`. Save forwards the name to
`saveDefaultTool` without validation. Resolution takes no arguments and keeps the
existing order: an override hit returns without reading saved state, then the saved value (read
lazily, once, only after an env miss), then the default tool. No trimming,
normalization, caching or catch is added; port errors propagate by identity, and
a missing default tool passes through as runtime `undefined`.

`src/tool-detect.ts` remains the compatibility facade with the same three
exports and signatures. It builds the application per call, so importing it
performs no adapter access; public `resolveTool(env)` wires
`readToolOverride` to a single `env["CCC_TOOL"]` read, so a missing `env` still
throws before any config read. The adapters keep the `defaultTool` key and the
existing `readCccConfig`/`updateCccConfig` semantics: missing or invalid config
reads as `{}`, invalid JSON is refused without a write, the pid temp file is
created `0600` and renamed, and other keys are preserved. `findTool` and
`getDefaultTool` forward to the M11b `tool-registry` facade. `src/index.ts` is
unchanged.

Verification anchors are the architecture core, facade and types tests for tool
preferences (the facade test uses the real home-layout and tool-registry with a
`vi.mock("os")` temp homedir), the declaration symbol entries for
`createToolPreferences` and `ToolPreferencePorts`, and one compiled facade smoke
in `scripts/test-workspace-packages.mjs`.

Known ceiling: tool discovery/install, workspaces, profiles and credentials (the
rest of M11), M12–M14 and native acceptance remain outstanding. Config hardening
(name validation, schema, retry) was intentionally not added.

## Requested-tool setup policy (M11d candidate)

`src/application/requested-tool-setup.ts` owns the existing install-route,
launcher-readiness and Codex sandbox sequencing policy. Its factory accepts four
semantic `RequestedToolSetupPorts`: `ensureClaudeLauncher`, `ensureNpmTool`,
`probeLauncher` and `ensureCodexSandbox`. Construction checks those callables in
that order without invoking effects. `ensure(target, tool)` is synchronous and
returns `undefined`; the application imports only canonical domain data/types
and its port contract.

Installation dispatch uses the current tool name and passes the original tool
object to the npm adapter. After installation, the application evaluates
`binary || name`, including for Claude, and reads the current name again to choose
the fixed Claude launcher or `/home/ccc/.local/bin/<binary>`. Metadata mutations,
getters and raw probe property reads retain their original order. Exactly one
launcher probe runs. Only `error.code === "ETIMEDOUT"` uses the existing timeout
message; other truthy errors and nonzero, null or runtime-undefined statuses use
the existing unavailable message. Statuses 124 and 137 are not normalized into
timeouts. Original thrown values propagate; the application adds no retry.

The Codex sandbox adapter runs only after successful launcher readiness and a
current name of `codex`. Its failures propagate. The three effect ports return
`void`, which TypeScript also accepts for async callbacks; trusted production
composition supplies the existing synchronous helpers. The probe contract and
application completion remain synchronous. These ports are not wire inputs or
an execution sandbox.

`src/container-setup.ts` keeps the public `ensureTools(...): void` facade and
composes per invocation. Claude/npm/bubblewrap helper internals remain native and
unchanged. The launcher adapter retains `runtimeCli()`, the exact `exec target
test -x path` argument array, ignored stdio and 15-second timeout. The index
caller still owns its existing conditional container-loss retry. Final
composition extraction remains M13 work.

Verification anchors are the requested-tool core/facade/type suites, the retained
container setup, index and tool-layout regressions, and both package payload
smokes. The source facade suite delegates through the actual factory while
observing native calls. Distribution verifies the compiled factory, declarations,
facade composition and existing fenced Claude VALID/INSTALL execution in both
fresh import orders. Portable proof does not substitute for native installation.

Known ceiling: no real installer, Docker/Podman, rootless or Windows/macOS
acceptance is established by this packet. Native npm/Claude/UV/bubblewrap policy,
other M11 workflows, M12–M14 and final M13 composition remain outstanding.

## Explicit profile catalog policy (M11e candidate)

`src/application/profile-catalog.ts` owns profile-name validation, reserved-default
rules, ordered listing and built-in creation decisions. `createProfileCatalog`
requires six callable `ProfileCatalogPorts` and an explicit default profile name.
Construction checks the port bindings without invoking them. The application
imports only its port types; the unchanged home-layout owner supplies
`DEFAULT_PROFILE_NAME` at composition time.

The six ports are `listProfileDirectoryNames`, `profileEntryExists`,
`writeProfile`, `removeProfileDirectory`, `hasBuiltinProfile` and
`readBuiltinSettings`. Membership and settings access remain separate operations:
the facade checks own-property membership without evaluating a value getter,
then reads `BUILTIN_PROFILES[name].settings` only when ensure must create that
built-in. An existing profile or the reserved default returns `false` before
catalog access. A missing unknown profile retains its existing error. Mutable
catalog values and getters remain observable, including the original TypeError
for an own entry whose value is null or undefined. No optional chaining, freeze,
copy, cache or error conversion is added.

`src/profile.ts` retains its eight runtime exports and re-exports
`ProfileSettings` and `BuiltinProfile` from the port contract. It composes the
application per invocation with native filesystem bindings. Validation remains
the existing regex; create, ensure and remove do not acquire an additional name
validation step. The list adapter lazily resolves `profilesDir()` once for its
existence probe and again for readdir only when present, filters directories in
native order, and the application prepends the default while excluding named
entries equal to it. Existence still uses `existsSync`, so an existing file also
counts as an entry.

The coarse write port resolves its profile root once. It creates `claude/` and
then `codex/` with recursive mode `0700`, writes `claude.json` as `{}` with mode
`0600`, and only for truthy settings serializes and writes
`claude/settings.json` with mode `0600`. Settings pass by reference. These modes
are creation options, not a claim to reset permissions of existing files or
directories. Serialization or native IO failure propagates unchanged and leaves
preceding effects in place. Removal retains recursive, forced `rmSync` without
an additional existence probe. There is no rollback, retry or storage migration.

Verification anchors are the profile-catalog core, facade and type suites,
unchanged profile/home-layout/index regressions and the recursive core boundary
guard. Facade characterization must cover mutable catalog membership/getter
ordering, lazy native root resolution, exact writes/modes and partial failures.
The shared workspace package verifier must check the emitted application,
declarations and public facade in both extracted npm and materialized
installation payloads. These are verification requirements; task review and
fresh QA determine the actual acceptance result.

Known ceiling: this packet does not harden direct profile names, links or native
filesystem races. Linux fixture and package proof does not certify native
Windows/macOS credential layout, permissions or providers. Profile request
resolution and credential/home-layout migration remain with their current
owners. Other M11 workflows, remaining earlier milestone work, M12–M14 and M13
composition closure still require their own implementation and acceptance;
this slice does not complete the full architecture migration.
