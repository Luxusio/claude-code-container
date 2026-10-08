# Lab diagnostics policy boundary

`createLabRunnerDiagnostics` owns the complete default/lab-runner snapshot,
configuration fallback, status/doctor/smoke formatting and diagnostic dispatch.
The pure domain owns the public snapshot interfaces, native observation carrier,
contract projection and existing render rules. Ports name specific native
observations and publication capabilities; no port owns an entire snapshot,
formatter or CLI workflow.

`lab-runner-admin.ts` remains the public native composition. Its four functions
retain their synchronous signatures, names and default `process.cwd()` positions.
It reexports the two existing public interfaces. Native path, container identity,
VM config, state volume, runtime summary and configured constants stay with their
existing helpers. Shell/run still use canonical exec in `index.ts`.

## Exact observation and fallback behavior

Snapshot resolves the requested path, observes default name/config, then named
lab-runner name/config. A falsy lab config triggers the existing container-config
fallback. Default and lab contracts are projected separately before final summary
assembly. Original native objects reach projection by identity; no adapter copies,
sanitizes or caches them.

Projection retains `unsupportedReason || null`, `kvmDevicePath || null` and
`kvmGroupId ?? null`. Group zero remains zero. Profile constant reads, state volume
and directory, property order and runtime summary remain at their original
positions. Coincident names or shared config objects do not merge observations.
Optional native fields retain the actual `LabRunnerRunConfig` structural types;
runtime-only falsy/getter witnesses do not widen production contracts.

Status and doctor share the original status text. Smoke retains its distinct
PASS/SKIP strings, conditional KVM/group/reason lines and trailing newline. An
unsupported smoke still returns diagnostic CLI status zero. `args[0] || "status"`
selects the command; unknown dispatch prints exact usage and returns one without
snapshot/native configuration observations. No new validation, normalization,
terminal sanitization or readiness behavior is introduced.

## Lookup, receivers and construction

Ten required ports are `resolveProjectPath`, `containerName`, `containerVmConfig`,
`labRunnerVmConfig`, `labProfileName`, `stateVolumeName`, `stateContainerDir`,
`runtimeSummary`, `publishOutput` and `publishUsage`.

Construction walks own and prototype descriptors, supporting structural class
consumers. It validates data-property function values without calling them and
accepts accessor descriptors without evaluating them. No constant, config,
runtime or publisher is prefetched. Missing or noncallable data properties are
refused at construction; selected callables are not replaced by per-call guards.

Native getters capture the selected callee before argument evaluation. Bare path,
Docker and runtime helpers keep their bare receiver; container-name composition
preserves one versus two native arguments. Console publication captures log/error
before formatting and its native observations, then invokes with the console
receiver and returns undefined. Getters, selected callees and observations keep
their raw fault identity and original precedence. There is no catch, retry or
rollback around this operation.

## Non-starting proof and delivery

Freeze actual source bodies, native helpers, caller routes and types before edits.
Pair original and candidate execution with identical getter/callee/receiver/fault
bindings, recording output and attempted effects. Deny and count unexpected
imports, exports, process/runtime/provider/network or write attempts before
throwing; caught exceptions must not hide attempted native actions. Only private
observation fixtures are permitted. Status reports configured contracts, not
started containers or VMs.

Four new core/facade/type/CLI suites supplement existing lab-runner tests. They
must prove actual candidate dispatch, optional cwd/public types, inherited ports,
native helper assignability and current emitted declarations. Frozen source replay
is not independent QA or emitted shipping execution.

Root integration must freshly build/assemble and execute actual npm-extracted
and installer-materialized public/inward modules and strict current declaration
consumers, with native/caller hashes and counted fences. Source inclusion, mocked
outer CLI calls or stale declarations cannot earn whole-operation credit.

Known ceiling: authoring and portable diagnostics do not certify live QEMU/KVM,
VM creation or native Windows/macOS behavior. Independent code/security review,
fresh QA, dual shipping and root accepted-parent reconciliation remain required;
this packet does not complete architecture migration.
