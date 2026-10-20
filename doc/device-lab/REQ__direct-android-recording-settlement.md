# Direct Android recording settlement

Status: derived behavior contract; no new user requirement or platform certification.

Basis: [architecture contracts](../common/SPEC__ccc-architecture-contracts.md)
require normalized observations, truthful effect outcomes and retained recovery
evidence. [Android stop completion](REQ__android-stop-completion.md) separates
signal delivery from completion. Public recording finalization has the same
no-loss obligation: a readable file does not prove its writer has stopped.

This applies to emulator and physical-device public recording stop. It does
not change lifecycle stop/detach, macOS, iOS or Sandbox behavior.

- Active recordings with missing, malformed or unavailable saved host identity
  remain recoverable; finalization must refuse before inactive publication,
  copying, replacement of the destination, metadata clear or remote deletion.
- Matching host identity permits signalling that captured process. Completion
  additionally requires observed host cessation and fresh selected-device
  guest writer absence. Signal or fallback acknowledgement alone is insufficient.
- Valid host identity mismatch permits no local signal or uncertain remote stop.
  Artifact recovery requires fresh guest absence and current captured target,
  recording generation and physical attachment lease.
- Known host exit (including verified ESRCH) may use the existing selected-target
  fallback for a remaining guest writer. Subsequent guest absence is required.
- Inactive/pending records, including true child-exit callbacks, are local
  evidence only. Every finalize/retry requires fresh guest absence and sends
  no repeated local signal. Running or unavailable observations retain metadata
  and media. Start/status need no new guest polling.
- Use the existing approximately 3000ms monotonic settlement allowance, distinct
  from transfer bounds. No native dispatch after expiry, timeout-zero default
  expansion or late observation may grant finalization.
- Before effects and after yields, validate captured generation, selected target
  and existing lease authority. A successor receives no predecessor effects.
  Revalidation reuses the admitted executable and bounds physical lease lock
  waits by the same remaining settlement allowance; it cannot launch fresh
  executable-discovery probes after that allowance expires.
- Failed copy/commit retains pending metadata, remote media and prior destination;
  dispose only the owned disposable stage. Final generation conflict preserves
  successor and remote artifact.

The Android adapter classifies positive numeric PID lists as running. Only a
clean exit1/empty pidof result without stderr, error or signal proves absence.
Malformed results, empty success, timeout and unsupported observations remain
unavailable. A failed fallback does not veto independent positive completion;
a successful fallback does not substitute for it. Invalid expected identity
must never be treated as trusted mismatch.

Verification uses old-source behavioral controls, pure application outcomes,
both public fake-SDK recording stop routes and the genuinely emitted MCP bundle.
Linux fixtures do not establish native Windows/macOS/device acceptance. Remote
deletion result truth is separate pending work.
