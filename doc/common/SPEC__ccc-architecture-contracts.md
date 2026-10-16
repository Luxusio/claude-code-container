# CCC architecture contracts and invariants

Status: target design, not a new implemented API. Companion to the
[architecture ADR](ADR__ccc-target-architecture.md) and
[migration packets](PLAN__ccc-architecture-migration.md).
Type notation below specifies semantics; each packet specializes its actual types
rather than generating one giant generic interface. New wire/state contracts need
separate compatibility review. Existing field names and wire codes remain stable.

## Context and ownership

```ts
type DeviceKey = { ownerId: string; backend: Backend; deviceId: string };
type DeviceRef = DeviceKey & {
  generation: ProviderGeneration; // tagged backend-specific evidence, not guessed
};
type OperationContext = {
  authority: ValidatedAuthority;
  operationId: string;
  budget: Budget;
  cancellation: Cancellation;
};
interface Budget { remainingMs(): number; }
interface Cancellation { isRequested(): boolean; }
```

`ValidatedAuthority` is constructed by trusted local composition or authenticated
broker routing after project/profile validation. Types are not an authentication
mechanism; every wire boundary validates again. ProviderGeneration specializes
incarnation ID for Hyper-V, lifecycle/runtime/singleton claim IDs for Sandbox,
attachment/lease identity for physical devices, and current generation fields for
Android/macOS. PID alone and device name alone are never destructive authority.
Absent legacy generation is an explicit legacy observation handled by existing
proof rules, not upgraded to a newly fabricated authority.

Budgets are monotonic and operation-local. Persist wall timestamps only for audit
or existing lease semantics; do not serialize a monotonic deadline to another
process. Send remaining duration at the process boundary, subtract transport time,
and cap child budgets by the parent. Host clock changes must not extend new core
budgets. Preserve existing public timeout bounds and defaults during extraction.
Clocks, IDs, sleep and configuration are explicit inputs. No port default resolves
to real host state in a test; production composition supplies those defaults.

## Common outcomes

```ts
type Outcome<T, Reason, Evidence> =
  | { kind: 'completed'; value: T }
  | { kind: 'refused'; reason: Reason }
  | { kind: 'conflict'; reason: Reason; evidence: Evidence }
  | { kind: 'pending'; operationId: string; evidence: Evidence }
  | { kind: 'indeterminate'; reason: Reason; evidence: Evidence }
  | { kind: 'failed'; reason: Reason; evidence: Evidence };
```

Each use case uses only relevant alternatives and a closed reason union. A native
command with exit zero is an execution observation, not automatically `completed`.
Commit failure after a successful native effect is pending/indeterminate according
to existing recovery behavior, never fabricated rollback success. Unexpected
programming errors are captured at outer boundaries as internal failures; they do
not become missing prerequisites or trigger automatic replay.

Public converters preserve current MCP envelopes, CLI exit codes and safe error
codes. Internal evidence is bounded structured data with a separate private raw
artifact reference. Redact commands, host paths, tokens, clipboard data and SSH
material before public rendering. MCP `content/isError`, HTTP status and terminal
strings are forbidden in shared application result types. No public response
changes are authorized by this specification alone.

## Required ports

| Port | Operations and normalized outcomes | Constraints |
| --- | --- | --- |
| DeviceState | `read(key)` -> missing/present/invalid/unavailable; `compareAndReplace(key, expected, replacement)` -> committed/conflict/failure | Expected proof uses current generation plus exact existing comparison rules. Do not add a disk revision field. Deletion uses the same conditional commit. |
| OperationLocks | `withDevice(key,budget,callback)`; ordered multi-device scope where supported | Composition specifies one acquiring process. Nested short state locks remain distinct. Unknown lock-owner liveness never authorizes takeover. |
| ResourceClaims | claim/read/renew/release using exact receipt | Physical lease, Sandbox singleton, network allocation stay separate specialized contracts. Release is compare-and-release, never unconditional by name. |
| RuntimeObservation | `inspect(expected,budget)` -> absent/matching/foreign/ambiguous/unavailable | Failure to inspect is not absence; observations carry timestamps and resource identity. |
| SandboxRuntime | launch/connect/inspectSessions/stopOwned with Sandbox refs | WSB argv, config files, foreground policy and helper bootstrap are adapter-owned; do not expose arbitrary exec through this lifecycle port. |
| HyperVRuntime | typed create/power/snapshot/guest calls via existing library | Preserve library contracts, exact VM identity, topology and privilege gates. |
| Control | cursor/windowList/focus/click/drag/key/type with target+budget | Capability-specific typed arguments. Finite coordinates; opaque handles preserved without lossy coercion. No host current display fallback for guest failure. |
| GuestExecution | execute structured guest program with target+budget | Host process specs and guest commands are distinct types; output byte limits and explicit encoding apply. |
| Transfer | upload/download using scoped source/destination grants | Adapter enforces paths, ancestor/link/descriptor checks, staging and size limits; core decides policy but cannot bypass adapter fences. |
| Journal | read/write/remove(expected operation and generation) | Keep each existing filename, schema version, max size, atomic-write and refusal semantics. No global event log. |
| ProcessIdentity | inspect/observe/terminate(expected identity,budget) | Return alive/dead/unknown separately; termination returns actual proof, including descendant uncertainty. |
| NativeProcess (adapter-level only) | run/spawn bounded executable+argv+stdin/environment spec | Native process shape cannot leak into application ports. Encoding, stdin framing and Windows command quoting live here. |
| ArtifactEvidence | capture scoped classified/raw evidence; return opaque reference | Private root, bounded bytes, redaction classification, retention and cleanup ownership explicit. |
| Clock / Sleep / Ids | monotonicNow/wallTimestamp/wait/newOperationId | Inject deterministically; application cannot call Date/random/timers directly. |
| ContainerRuntime | inspect/start/create/exec/stop/remove against pinned identity | Rootless, SELinux, Docker Desktop and Podman machine differences stay in adapter. |
| Workspace / Git | inspect registration/branch/files; perform explicit repair/create/remove steps | Preserve quarantine, inode/path proof, nested-worktree constraints and user-file ownership. |
| SessionStore | reserve/read/compareAndRelease claims with process and container identity | Session cleanup and daemon cleanup have different owners. Unknown claimant remains active for safety. |
| CredentialTransfer | prove mounted source/refresh/invalidate/status using scoped mount intent | No key bytes in use-case returns; source read-only, copied marker is not sole ownership proof. |
| ToolRuntime | probe/install/prepare/launch with selected tool config | Distinguish missing/damaged/unknown; no installer dependency in domain registry. |
| ClipboardNative | read snapshot/write text with native change marker | Image bytes bounded; MIME and fallback decisions testable. HTTP token auth stays outside core. |
| RemoteSession / Sync | reserve/observe/execute/synchronize/release exact lease | No retries on unknown execution; quote/encoding in SSH/Mutagen adapter. |

## Capability and routing contract

Registry key is `(backend, provider, operation, action?)`. Registry is immutable
per composition instance; availability observations refresh per operation as
existing behavior requires. A descriptor separates implemented support, host
prerequisites, target readiness and policy permission. None is proof of execution.
Physical iOS status support does not imply pair/connect support; macOS snapshots
are provider-specific; current X11 display is not creatable. Typed capabilities
are optional interfaces, not mandatory methods that throw at runtime.

Routing yields `local executor` or `broker client` before effects. Explicit remote
failure cannot select local mutation. Read-only discovery and ownership-authorized
mutation have different policies. Keep the restricted existing Hyper-V create
replay: explicit deviceId, eligible connection failure, same host, only one retry.
Timeouts and other mutations are not replayed by generic middleware.

## Operation transitions and recovery

State has separate dimensions: persisted definition, active operation claim,
observed provider state, control readiness and auxiliary runtimes. Do not replace
these with one global `DeviceStatus` enum. The following is an operation protocol,
not a new stored schema or universal provider state machine:

| Stage | Required evidence/action | Failure/cancellation behavior |
| --- | --- | --- |
| validate | normalized input, capability, authority | refuse before effects |
| acquire | current operation lock; inspect current record/resource | bounded acquisition; unknown owner blocks |
| claim | compare-and-transition exact generation; required resource claim | retain predecessor/successor distinction; failed claim causes no provider mutation |
| intent | durable journal where existing recovery requires one | write failure stops dispatch; do not invent journals for every operation during extraction |
| dispatch | native adapter gets exact identity and remaining budget | cancellation before dispatch prevents effect; after dispatch outcome may be unknown |
| observe | confirm expected resource and result | no observation => indeterminate, preserve claim/evidence and reconcile before retry |
| commit | compare-and-transition same claim; finalize journal | concurrent successor untouched; commit failure retains recoverable evidence |
| compensate | only resources proved created/owned by this operation | bounded cleanup; preserve primary failure AND cleanup failure; no foreign deletion |
| release | remove own operation/lease/journal only when safe | release failure visible; never erase evidence to make tests green |

Sandbox stop/delete must verify singleton claim and observed sandbox identity;
stale launch completion cannot overwrite successor state. Start readiness is
separate from launch success. Hyper-V uses its VM incarnation/Notes and journal
rules. Android AVD artifacts require their recorded storage identity. Physical
attach/detach uses host-wide hardware leases, not VM create/delete. Recording
finalization preserves its own runtime generation even when the device stays alive.

No new global lock order is imposed. Before each extraction, record current lock
nesting and process ownership in the packet manifest. Existing children sometimes
own the long operation lock; broker must not acquire that same lock around them.
Short state mutation locks do not wrap slow native commands unless current
semantics explicitly require it. Multi-device locks retain deterministic ordering.
Async-local reentrancy is process-local, not cross-process reentrancy.

Timeout is not proof of termination. Port execution must report whether dispatch
occurred, observation completed and owned child termination was confirmed. Cleanup
budgets cannot silently extend the user operation without a documented existing
policy. Tests inject cancellation both sides of every externally visible effect.

## Storage and compatibility

Preserve `~/.ccc` resolution, profile migration, shared device state versus private
broker state, and existing journals/leases/locks. Repositories accept explicit
roots supplied by trusted composition; wire inputs cannot choose roots. Consolidate
TS and `.mjs` validators only after byte/behavior parity for valid, corrupt, linked,
oversized and concurrent inputs. Keep atomic publish and descriptor checks in the
real storage adapter; an in-memory fake does not prove those guarantees.

This migration does not grant at-most-once execution across crashes. It preserves
known idempotent operations and reconciles unknown outcomes. New durable fields or
schema versions require old/new-reader fixtures, interrupted migration tests,
backup/rollback policy and a separate reviewed change. No hidden schema migration
or protocol bump inside an extraction commit.

## Build and test construction

Production composition resolves environment, home, executable paths and runtime
once at the appropriate scope, then injects values. Test composition requires
explicit isolated roots and fake execution/network ports and must fail if missing;
never fall through to production defaults. Pure suites do not mutate HOME to fake
purity. Native-adapter suites use private temporary homes, bounded subprocesses,
and resource receipts. Installed-package suites run outside the checkout with
sanitized environment and built artifacts matching the source revision.

The existing `.mjs` core stays directly shippable. Introduce strict checkJs and
contract typechecks for migrated modules, and retain workspace/bundle/embedded
installer checks. Do not cite the current narrow `tsconfig.tests.json` as proof
that all new tests/types are checked. Each packet lists the exact included files.

## Existing execution / lock ownership baseline

Source anchors refer to current functions, not a promise that line numbers remain
fixed. `device-lab-broker.ts` is under `packages/device-lab/src/`; provider paths
below are relative to `packages/device-lab/providers/`.

| Entry point and capability | Existing long-lock owner / nesting |
| --- | --- |
| `broker.command.invoke` normal lifecycle | broker owner/state-key/device operation lock |
| Hyper-V lifecycle mutation or status recovering pending journal | broker device operation -> host Hyper-V mutation |
| Hyper-V create + dryRun lifecycle | specialized create helper bypasses the normal outer device-lock branch; other lifecycle dry runs retain the broker operation lock |
| Android broker lifecycle create/start | broker device operation -> Android port allocation |
| `broker.device.tool.invoke` Hyper-V backend tools | broker device operation before backend dispatch |
| Same RPC, non-Hyper-V tools | backend handler owns applicable policy lock, no generic broker wrapper |
| Same RPC Windows/macOS recording start/stop/status | child dispatch; provider policy determines actual locking (status does not imply a long lock) |
| Same RPC other recording start/stop | broker device operation |
| Same RPC other recording status | no enclosing device lock in dispatcher; narrower reconciliation remains |
| Unattached physical tools | specialized runner; no generic device lock in dispatcher |
| Direct/child Sandbox, Android, iOS, macOS | `state/device-operation-policy.mjs` determines provider acquisition; preserve state-key mapping |
| macOS source clone | sorted, deduplicated source/destination device locks |
| Android direct create/start | provider device operation -> port allocation |
| Physical non-attach operations | provider device lock then lease refresh under existing lease locking |
| Container-QEMU operations | own `linux` device policy; inventory/target-list bypass |
| Container-QEMU import image | synthetic `linux/__images__` operation; image-list bypass |

Evidence: broker `invokeDeviceTool` dispatch around 5374–5427 and lifecycle dispatch
around 15377–15450; backend exported handlers; `state/device-store.mjs`
`withOwnerDeviceOperation`/`withOwnerDeviceOperations`; Sandbox
`claimWindowsSingleton`, `releaseWindowsSingleton`, `claimWindowsLifecycle`.
The state-key (`windows`, `macos`, `ios`, `linux`, etc.) is not always the public
backend name; preserve the explicit existing mapping.

Define a typed composition registry per entry-point/capability/backend with
`acquisitionOwner = broker | backend | specialized` and an explicit workflow
factory. The registry selects an already-correct implementation; it does not
invent extra acquisition or transmit a bypass-lock flag from user input. Until a
legacy handler's acquisition is removed in the same packet, new application code
must call that handler as the locking boundary. After extraction, exactly one
trusted executor acquires; it calls an unlocked internal adapter that is not
exported as a public handler. Tests run two separate processes to detect deadlock
or duplicate effects, not just async reentrancy within one process.

The current broker composition cohort covers device-tool dispatch and lifecycle command invocation. Private finite descriptors pair the acquiring process with the existing workflow factory. Inventory, unattached tools and recording status keep their specialized paths; backend-owned tool handlers retain their own policy boundary. Explicit or inferred Hyper-V tools acquire in the broker and re-observe the current target inside the lock. Missing backend inference retains the ordered windows-vm then linux-vm device locks. The independent owner RPC queue remains separate. Direct/admin/physical/Appium executor coverage is not certified by this cohort.

Console, snapshot, network allocation, Appium and physical lease sublocks remain
inside their existing adapters until their dedicated packet extracts and records
that operation's nesting. This is a deliberate compatibility boundary: no global
reordering, broad lock wrapper or claimed atomic transaction over multiple state
files is permitted. Each packet's gate requires the nested acquisition trace and
contention tests before replacing that adapter. This specifies how to preserve
unexpanded paths without guessing their locks.
