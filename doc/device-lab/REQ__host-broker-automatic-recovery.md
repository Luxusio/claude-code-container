# Host broker automatic recovery

Status: active, 2026-10-23.

## Requested outcome

The user requests automatic broker recovery during ordinary CCC startup and explicitly authorizes this work after the session reconciliation fix. Startup and broker status reuse the existing readiness/repair entry point; users should not need to kill a verified obsolete CCC host broker manually. A session predecessor-cleanup failure is a separate error and is not evidence of a broker fault.

## Required behavior

- Reuse a compatible, verified broker. Replace an admitted obsolete or unhealthy host-owned broker using the existing health, protocol, owner resolution, bind-host and native listener checks. Do not downgrade a newer protocol or acquire replacement authority over a matching parent-managed MCP listener.
- A rebuilt file at the same entry path does not update an already running broker. Protocol 9 requires the in-memory argv forwarding and Mac guest-helper preparation fixes. Protocol 8 and earlier must pass through the existing verified replacement path before the current MCP reuses a broker. Package version equality does not establish this compatibility. Preserve all existing identity, exit-completion and newer-protocol refusal rules; this requirement adds no unconditional restart or signaling path.
- The Level 3 launcher loads before runtime assembly. Its protocol contract must resolve from the current workspace so that a cached previous assembled contract cannot reject the newly built broker during preflight.
- A captured full process identity must match again immediately before each TERM or KILL. A failed full-identity observation cannot fall back to weaker start-token proof.
- An already-admitted metadata-only listener may be repaired on POSIX as well as Windows. Its persisted host metadata, status generation and native start token must agree, and fresh exact port ownership and start identity must still match before each signal. Missing listener/token, PID reuse or generation change refuses signaling. A PID alone is insufficient.
- Native broker stop completion requires a positive exited observation. EPERM and unknown process observations are not completed exit. Failed signaling or unconfirmed exit leaves recovery incomplete. Keep existing bounded waits; this requirement does not change unrelated provider exit policies.
- Without an explicit port, a different retained broker port may be ignored only when a supported manager and valid PID refer to a positively exited local process. Qualify locality against the actual executing platform: explicit platform metadata must match; missing platform requires the corresponding nonempty native start-token family. Use tri-state native liveness, retaining live, EPERM, unknown and cross-platform records as endpoint hints.
- Discarding a stale endpoint hint changes only which configured endpoint is examined. Retain the runtime file as input to existing listener attestation. Explicit ports, compatible live MCP reuse and same-port/generation conflict refusal preserve their existing behavior. No arbitrary process termination or broad cache deletion follows from endpoint selection.

These constraints extend [host broker launch](REQ__host-broker-launch.md) and retain [stop completion proof](REQ__broker-stop-completion-proof.md). They introduce no new CLI command, storage format, multi-candidate discovery framework or automatic provider startup.

## Acceptance

Exercise the actual POSIX branch without an injected terminator: metadata-only TERM and KILL paths, changed PID/token/port before both signals, full-identity refusal without downgrade, failed signal and EPERM/unknown exit retention. Verify dead local cached ports yield configured-default selection, including missing-platform native-token records; explicit-port, live-MCP, foreign-platform and unknown observations retain existing policy. Default endpoint fixtures must use synthetic HTTP or isolated listeners, not shared host ports.

Known ceiling: deterministic process and HTTP fixtures do not establish actual macOS or Windows host acceptance. Preserve that distinction in verification reports. Unverifiable ownership remains a diagnosed refusal rather than permission to kill an arbitrary listener.
