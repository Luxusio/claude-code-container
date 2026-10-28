# Broker macOS guest helper readiness

Status: derived correction, 2026-10-27.

The user requests fixes from saved native failures. Earlier Oct27 Tart failures
reach desktop control readiness but retain only `provider-error`; their exact
guest or broker cause is not established. Source inspection independently finds
that broker create/start never installs the helper script that cursor operations
execute for each new device ID. The direct lifecycle already installs it. This
correction repairs that source-proved gap without claiming it caused every
observed readiness failure.

For an admitted owned Mac VM start, launch, IP discovery, helper preparation and
final publication share the existing bounded start allowance captured before
the owner operation-lock wait. Shorten native calls to its remainder. The
internal installer reuses the existing helper leaves through the bounded backend
child, with the authenticated owner's registered cwd/profile. It acquires no
device lock, starts no VM and publishes no device state itself. Do not call the
direct lifecycle recursively or install from a read-only cursor operation.

Combine observed IP with admitted SSH metadata before helper installation.
Provision before publishing running/helper state through the existing complete
record CAS. Failed or late preparation retains partial-effect/recovery evidence;
it does not establish readiness or authorize a second launch, foreign cleanup
or successor overwrite. Successful detail includes the existing boot/helper
shape used by direct clients, with no credentials or raw child output added.

No SSH configuration preserves skipped provisioning without native SSH/SCP.
Configured `waitForBoot:false` preserves one-shot preparation without a retry
wait. The legacy exported Unix-wall deadline API retains its meaning; pass a
positive remaining duration to the new relative internal adapter. This shares
the allowance inside the broker request, not a new client-to-host aggregate
deadline guarantee.

The internal broker child also inherits a cross-process monotonic deadline.
Charge Node startup, imports and the handoff to helper preparation against the
same remainder throughout the helper operation. Keep the parent's existing
hard timeout and process-identity signaling protections unchanged.
The same-host clock basis is supported by the host's
[Node 22.22.1 hrtime binding](https://github.com/nodejs/node/blob/v22.22.1/src/node_process_methods.cc#L640)
and its [Darwin libuv clock](https://github.com/nodejs/node/blob/v22.22.1/deps/uv/src/unix/darwin.c#L56).

Before retrying, the child may synchronously emit one bounded observation of
its first completed failed native SCP/SSH command. If the parent terminates
the child, retain this `firstFailure` separately from the child's termination
execution. Select only provider, native status/signal/timeout, and a closed
connection category (`refused`, `reset`, `closed`, `timeout`, `unreachable`,
`authentication` or `other`). Emit at most one frame, at most 512 bytes; keep
the existing child output bound. Missing or invalid observations stay missing.
This is the first observed failure, not a claim about the final cause. It must
not alter retries, success admission, publication or ownership.
Retain the available observation on failed preparation whether the child was
terminated, returned a failed result normally, or completed too late for final
admission. Successful admitted preparation omits earlier `firstFailure` data.

Derived retry correction: explicit SSH authentication failures take precedence
over generic connection-closure text in the same native receipt. OpenSSH SCP
may append `Connection closed` after an authentication denial. Classify that
mixed result as `authentication` and do not retry it as a transient connection
failure. A bare remote filesystem permission error is not sufficient to infer
authentication. Preserve existing deadlines, command arguments and other retry
rules; this correction does not establish the saved Mac failure's credentials.

The wire response reports admission or operation-lock budget exhaustion as HTTP
504 with `macos-start-budget-exhausted`. A partial start or failed helper
preparation reports HTTP 502: ordinary partial failures use
`provider-command-failed`, while helper failures use their selected preparation
code, falling back to `macos-helper-prepare-failed`. The result retains
`recoveryRequired`; a failed preparation also includes selected
`helperPreparation` facts. Neither response permits relaunch or cleanup of a
successor record.

Successful `result.boot` contains `ready`, `skipped`, provider `tart` and the
observed `ip` (or null). `result.helper` contains provisioning status such as
`provisioned` or `skipped-missing-ssh`, with selected provider/timestamp metadata.
The published device's helper metadata may include its script path and SSH
host/user/port, but never passwords, keys or raw command output. These fields
describe completed preparation; subsequent control readiness still requires a
successful cursor probe.

Verify a fresh owned ID without seeded helper metadata: fake SSH refuses its
missing script until fake SCP installs it. Cover lock retention and HTTP
responsiveness during installation, decreasing remainder, failed/late results,
successor preservation, no-SSH skip and legacy deadline behavior. Native Mac
execution remains required to accept the actual provider correction.
