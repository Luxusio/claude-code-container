# MCP-owned host broker launch

This requirement derives from the agreed [architecture contracts](../common/SPEC__ccc-architecture-contracts.md) and [target architecture](../common/ADR__ccc-target-architecture.md). It covers the MCP process launching its host broker child, separately from a provider launching a device.

## Responsibility and result

The application decides whether an admitted broker runtime may be reused or replaced, whether the launched broker is ready and compatible, and when its captured runtime requires compensation. The native binding owns executable preflight, private log creation, process dispatch, runtime construction, start-token observation, child tracking and parent log descriptor release.

The launch port is `launchOwnedBroker(owner, launch)`. It returns a tagged result:

- `{kind: "started", runtime, diagnostics}` after a nonthrowing spawn attempt and native bookkeeping. This does not establish assigned PID, process liveness, readiness, protocol compatibility or authenticated owner resolution. The existing no-PID/asynchronous-error route still reaches bounded health failure.
- `{kind: "failed", runtime, detail, diagnostics}` when native launch work fails. Runtime is null before dispatch and otherwise identifies the exact provisional child. Diagnostics retain command, arguments and the selected log path; detail retains the existing diagnostic representation.

The existing normalized invocation is captured before probing and contributes to operation cache identity. Production command selection uses the current Node executable and resolved broker entry, without environment-based executable selection. Preserve eager package-resolution exceptions. An absent Node executable is `executable-not-found`; a broker script path whose process subsequently fails follows its existing readiness route.

## Partial dispatch and cleanup

Immediately after spawn returns, capture the provisional runtime and retain the owned child before listener setup, token polling or cleanup registration can fail. Keep complete command/argument identity used by later native verification. Token observation updates that captured generation. A post-dispatch failure returns its runtime so compensation and diagnostics retain the actual target.

An assigned PID alone never authorizes termination. Missing or changed process-start identity must refuse signaling. Native tracking must not erase a successor while retiring a captured child.

`cleanupLaunchedBrokerRuntime(runtime, timeout)` acts on the captured runtime without requiring an application-held native child object. Retain existing no-PID behavior, bounded process termination, exact-record publication/removal and successor protection. An operation attempts launch compensation at most once. A cleanup refusal or exception is reported separately and must not replace the primary dispatch, readiness, protocol, verification or publication failure, or cause another compensation attempt.

Native launch closes its acquired parent log descriptor in `finally`. Closure is best effort and cannot convert an otherwise started child into a failure. The child must continue writing through its inherited output descriptors after the parent closes its copy. Retain private-log symlink/file identity fences, process stdio settings, Windows visibility policy, timestamp semantics and bounded start-token polling.

## Supervision and compatibility

Preserve admission before dispatch, initial and final runtime compare-and-set publication, independent health/owner/protocol/process verification, existing phase allowances and public success/failure fields. A failed publication is a supervision outcome, with the captured child compensated without overwriting a successor. No application-created exception is needed for that expected branch.

This extraction does not change CLI syntax, provider lifecycle, storage schema or existing shutdown diagnostic policy. It does not certify the entire broker application boundary or replace [phase-wait](REQ__broker-supervision-phase-waits.md) and [stop-completion](REQ__broker-stop-completion-proof.md) requirements.

## Verification

On macOS, native listener and process-start observations use the fixed system `lsof` and `ps` executables so an isolated provider PATH does not hide or substitute them. Keep the existing observation deadlines, exact PID/port/command/start-token checks, and refusal when proof is missing. A working command lookup does not itself authorize broker reuse, termination or replacement.

Use existing broker owners to exercise native preflight/log/spawn failures, post-spawn bookkeeping failure with captured runtime/tracking, missing-token refusal, no-PID/asynchronous error, actual child logging after parent descriptor release, both publication successor races, and cleanup refusal/throw preserving primary failure with one attempt. Reuse the existing native composition port capture; no production test getter or contract-shape test is required.

The MCP's macOS listener observation also uses unlimited-width command output
and checks native completion before using it. A spawn error, signal or failed
command must not be interpreted as successful command redaction and admitted
through metadata fallback. Retain the existing observation allowances and
PID/birth/status fences. Selected stage/status codes can explain refusal without
publishing native command text; see [failure evidence](REQ__provider-failure-evidence.md).

Build and packaged stdio checks must exercise the current source. Portable deterministic observations are separate from current Windows compilation and actual provider acceptance; none establishes macOS, live-engine or global architecture completion.
