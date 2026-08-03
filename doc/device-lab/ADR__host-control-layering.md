# ADR: Host-Control Layering

## Status

Accepted on 2026-08-03.

## Context

CCC controls containers, Hyper-V, Android, and Apple virtualization while also
owning CLI, MCP, authentication, project ownership, leases, and persistent
state. Mixing those concerns made host implementations difficult to test and
made later internal-package extraction depend on the broker's transport and
policy code.

The first concrete boundary is Hyper-V because its command compiler and result
parsers are deterministic and already covered by characterization tests.

## Decision

Host integrations live under `src/host-control/<runtime>/`. A host-control
module may own command contracts, input validation, command construction, and
result parsing. It must not own CCC owner authentication, HTTP or MCP routing,
lease policy, project identity, or persistent device state.

The dependency direction is:

```text
CLI / MCP
    -> application and broker policy
        -> host-control contracts and operations
            -> operating-system tools and runtime APIs
```

Hyper-V is exposed through `src/host-control/hyper-v/index.ts`. The old
`src/device-lab/providers/hyper-v.ts` path is removed rather than retained as a
compatibility facade. Internal callers must import the new boundary directly,
so obsolete dependency direction cannot survive unnoticed.

The Hyper-V layer is split into:

- `contracts.ts`: transport-independent types and constants
- `core.ts`: bounded process execution, PowerShell framing, and shared validation
- `host.ts` and `vm-create.ts`: host readiness, networking, and VM construction
- `images.ts`: base-image acquisition and validation
- `windows-guest.ts` and `linux-guest.ts`: guest provisioning and command transport
- `lifecycle.ts` and `snapshots.ts`: VM lifecycle and checkpoint operations
- `observations.ts`: bounded parsing of provider output
- `index.ts`: deliberate package entrypoint

CCC-specific orchestration remains under `src/device-lab/broker/hyper-v/`
until it can depend on explicit runtime, state, clock, and lock ports.

## Consequences

- Moving Hyper-V into a future internal package no longer requires changing
  broker, test, or CLI import paths.
- Broker policy can depend on host control, but host control cannot import the
  broker or its transport.
- Runtime command strings and public MCP behavior remain unchanged during the
  move.
- Import migrations are atomic. Compatibility facades are not used for
  repository-private paths.
- Standalone real-test runners register CCC's package-owned source resolver
  before dynamically loading TypeScript provider modules. The resolver only
  retries missing relative `.js` imports as `.ts`, preserving NodeNext source
  specifiers without a runtime dependency or caller working-directory coupling.
- Hyper-V networking is one host-wide CCC singleton. New broker intents use the
  same stable marker and NAT name as `ccc devices setup hyper-v`; the random
  intent token remains a transaction nonce rather than a second ownership
  identity. A missing broker state file may adopt an existing network only
  when the switch has an exact CCC stable or token marker and the corresponding
  NAT name, Internal switch type, gateway, and prefix all match. Once state is
  committed, persisted switch and NAT IDs remain authoritative. Previously
  persisted token-fenced intents and states remain readable and keep their
  dedicated cleanup behavior. A stale broker state may reconcile to a different
  valid CCC marker/NAT identity while its allocation set is empty, or while
  persisted switch GUID and NAT InstanceID both exactly match the observed
  resources. Empty-state reconciliation replaces the observed IDs and drops
  inherited cleanup ownership; exact-ID marker migration preserves ownership
  because the underlying resources did not change. Foreign markers and any
  switch or NAT ID mismatch with an active allocation still fail closed.
  Switch, gateway, and NAT ownership are recorded separately, so repair or
  rollback removes only resources created by that transaction. Destructive
  switch or gateway cleanup additionally requires the persisted switch ID.
  Foreign or ambiguous host objects fail closed.
- Broker network allocations are reconciled before singleton-network adoption.
  An allocation is considered orphaned only when no `windows-vm` or `linux-vm`
  owner-state record references the exact device and incarnation IDs and an
  exact VM-name lookup finds no VM. The lookup derives both the VM name and
  Notes marker from owner, device, and incarnation IDs. A present VM, duplicate
  VM name, mismatched Notes marker, Hyper-V inventory query failure, malformed
  observation, owner-state read failure, or legacy allocation without an
  incarnation ID preserves the allocation and fails closed. Pruning
  changes only the atomic broker allocation record; it never deletes a VM,
  switch, gateway, or NAT. Once all allocations are proven orphaned, the broker
  may adopt the exact stable CCC network created by setup.
- Broker transport replay is not a general lifecycle policy. The sole automatic
  replay is one retry of a Hyper-V `device_create` request with an explicit
  `deviceId` after a non-timeout connection reset, refusal, broken pipe, or
  aborted response. The retry targets only the host whose request disconnected;
  it does not repeat discovery across every host candidate. Hyper-V creation is
  serialized by the owner/device operation lock. A completed create is returned
  idempotently from owner device state, while an interrupted create is reconciled
  from its incarnation-fenced provider residue before another provider create is
  attempted. Timeouts, other backends, and all other commands are never replayed
  automatically. Both attempts retain bounded transport and broker diagnostic
  codes.
- Non-interactive Windows host-control children, including elevated Hyper-V
  setup and network PowerShell processes, launch with hidden window style in
  addition to Node's `windowsHide` fencing. Provider UI that is itself the
  requested device surface, such as Windows Sandbox, remains visible by
  explicit provider policy.

## Follow-Up Order

1. Move Hyper-V lifecycle orchestration behind injected execution, state,
   clock, and lock ports.
2. Separate Docker inspection, mount contract, replacement policy, and
   lifecycle while retaining CCC session policy outside generic host control.
3. Establish parity tests for the TypeScript and bundled MCP process identity
   and lock implementations before consolidating them.
4. Refactor macOS and Android inside their current runtime surfaces before
   changing which process owns their execution.

## Rejected Alternatives

### Keep the old provider facade

Rejected because it preserves the obsolete import path and allows new code to
continue bypassing the intended layer boundary.

### Introduce one universal virtualization abstraction

Rejected because containers, Hyper-V, Android, and macOS have materially
different lifecycle and safety policies. They share low-level execution and
process primitives, not one lifecycle model.

### Publish packages immediately

Rejected until dependency direction and real-host behavior are stable. The
internal boundary is the compatibility contract for now.
