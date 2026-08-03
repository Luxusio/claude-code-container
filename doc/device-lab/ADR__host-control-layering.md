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
