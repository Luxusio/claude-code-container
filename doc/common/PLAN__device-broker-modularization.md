# Device Broker Modularization Plan

## Problem

`src/device-lab-broker.ts` mixes transport, authentication, state persistence,
provider execution, provider-specific lifecycle policy, and public response
projection. At more than 15,000 lines, changes in one provider can accidentally
alter unrelated device behavior and reviewers cannot reason about a single
abstraction level at a time.

## Dependency Direction

The broker is split into layers with one-way dependencies:

1. `device-lab-broker.ts`
   - HTTP and owner RPC routing
   - use-case orchestration
   - no provider-specific serialization or filesystem implementation
2. `device-lab/broker-contracts.ts`
   - provider runner and broker DTO types shared across provider domains
3. `device-lab/hyper-v/*`
   - Hyper-V domain policy and provider-specific state
   - no HTTP request/response objects
   - no imports from `device-lab-broker.ts`
4. existing state, process identity, safe cleanup, and provider command modules
   - infrastructure primitives only

Provider-domain modules may receive callbacks or roots from the orchestration
layer when infrastructure cannot be imported directly. They must not reach
back into broker transport or mutate unrelated provider state.

## Hyper-V Module Boundaries

- `public-response.ts`
  - allowlisted diagnostic selection
  - bounded error codes
  - provider execution projection
  - Hyper-V device and cleanup public DTO projection
- `state.ts`
  - private artifact roots
  - incarnation records
  - fenced artifact cleanup
- `image-store.ts`
  - managed Hyper-V image profile and manifest validation
  - owner/global image cache resolution and incomplete artifact cleanup
  - large-file staging and hashing under operation deadlines
  - automatic image acquisition and explicit source-image preparation
  - provider execution and executable lookup through a narrow injected runtime
- `network.ts`
  - shared switch/NAT state, ownership intent, and deterministic address/MAC
    allocation
  - incarnation-fenced allocation release and last-owner NAT cleanup
  - Linux SSH host-key binding to the committed network allocation
  - provider command execution through an injected executable resolver, runner,
    elevation resolver, private state root, and operation limits
  - no broker options, HTTP/RPC DTOs, or imports from `device-lab-broker.ts`
- `snapshots.ts`
  - snapshot journals, reconciliation, and state transitions
- `lifecycle.ts`
  - create/start/stop/reboot/delete use cases
  - composes image, network, state, and provider command ports

## Migration Rules

- Preserve all existing exports and RPC response fields unless the security
  contract explicitly requires redaction.
- Redacted provider execution responses expose only output-presence booleans;
  they never retain `stdout` or `stderr` fields containing placeholders.
- Move cohesive behavior with its tests; do not create forwarding files that
  merely rename functions.
- Add no circular imports. Domain modules may import contracts and
  infrastructure, while the broker imports domain modules.
- Keep arbitrary gitignored nested repositories outside this refactor. Tracked
  submodule worktree repair is a separate worktree-domain change.
- Each extraction must pass focused provider tests, broker command tests,
  TypeScript checks, build, independent code/security review, and CLI QA.

## Extraction Order

1. Extract Hyper-V public response policy and private state/artifact ownership.
2. Extract the Hyper-V image store without importing `device-lab-broker.ts`.
   Keep transport DTO construction in the broker and inject only command
   execution, executable resolution, broker roots, and operation limits.
3. Extract network allocation and cleanup.
4. Extract snapshot journals and reconciliation.
5. Extract lifecycle orchestration.

The image-store slice is behavior-preserving. It does not change public RPC
responses, image acquisition policy, cache layout, evaluation-license policy,
or provider commands. The broker remains the composition root and re-exports
any image-store API that was public before extraction.
