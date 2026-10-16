# Codex config preparation extraction

## Current semantic preparation boundary

The configuration application consumes finite ready, repair-required, timed-out and failed observations. It owns probe/repair/finalize sequencing; native composition alone interprets process status, timeout codes and error details. Native failures may carry an opaque Error which is thrown unchanged by policy. Actual public detailed stage errors and dispatch/property exceptions retain their existing behavior, without retries or later effects after failure.

Ordered preparation still proves directory access before file access, validates host-owned nonlink/singlelink metadata before root grants, and resolves mapped UID lazily per invocation. Only native lstat ENOENT becomes a semantic missing-file observation. Directory repair may admit that absence; file repair throws the captured original failure. Present metadata getter failures and generated safety refusals propagate before UID/root effects, including synthetic errors inheriting an ENOENT code.

The existing core/type/facade and ordered/harness suites cover semantic policy, negative raw-result type contracts, native timeout/failure classification and public error identity. Strict Source and genuine emitted-declaration consumers are separate from runtime fake-provider verification. Native Docker/Podman ownership and actual Windows/macOS acceptance remain unverified by portable fixtures.

## Historical initial extraction (superseded M10m native-result interface)

The paragraphs below retain the original extraction scope and verification history. Their raw status/error port and literal native branch descriptions are superseded by the current semantic boundary above; they do not describe the current inward contract.

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

Docker retains one private stateless application instance and its public
`prepareCodexConfigForContainer(containerName): void` signature. Native bindings
resolve the runtime independently when each effect runs. The existing fixed
shell bodies, quoting helper, target argv, ignored stdio and 15-second outer
limits stay in Docker. Each shell command retains its 10-second inner timeout
and 2-second kill grace. These are existing per-command limits, not an end-to-end
completion guarantee. Root repair changes entry ownership with `chown -h` only;
probe and final identity/access/permission proof run as the unprivileged
container user. The existing index caller, pinned target and setup lock remain
unchanged. Docker is temporary native composition until M13.

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
