# Provider failure diagnostics

Failed Windows provider operations must retain bounded diagnostic evidence without
including host paths, command output, credentials, or arbitrary exception messages.

- Native Hyper-V errors may include `nativeHResult` (signed 32-bit integer) and
  `nativeErrorCategory` (PowerShell category integer, 0–31). These are separate
  from the process exit status. Legacy failures without either field remain valid.
- VM creation failures preserve these fields through rollback reporting and saved
  real-test diagnostics, including a primary failure wrapped by failed cleanup.
- Desktop start timeouts retain `readiness.attempts` and `readiness.lastProbe`:
  `not-attempted`, `provider-error`, `transport-exception`, `missing-cursor`, or
  `late-response`. These describe the last observation, not an inferred root cause.
- A failed Sandbox cursor probe may retain helper readiness, fallback attempt and
  success flags, response parse failure, and integer guest exit status. These
  diagnostic fields never contain the underlying raw logs or error text.
- Successful readiness returns the original result unchanged. Diagnostics must
  not extend deadlines, relax readiness checks, alter rollback, or change ownership.

After building updated artifacts and loading them in the host broker, rerun only
the failed provider scenario. Saved `results/device-lab-real/mcp-error-*.json`
files contain the bounded evidence. Native Windows success must be checked on
Windows; mock tests establish serialization and control-flow behavior only.
The short real-test failure line also includes hexadecimal HRESULT/category or
readiness evidence when available, within its existing 511-character limit.

Public GUI journey fixtures must apply the real public input validator before
returning simulated provider responses. `window_list` and subsequent controls
select the exact owned deviceId without a public incarnationId. Private frame,
GUID, ownership Notes and generation checks remain inside the provider. Native
console/setup diagnostic helpers obtain private metadata through opt-in detailed
status evidence and retain their exact generation fences.
Known unsupported-argument errors retain only catalog-approved tool and field
identifiers under a fixed validation classification; arbitrary error prose and
request arguments remain excluded from saved diagnostics.

Sandbox helper evidence includes a closed failure stage: `sandbox-id-invalid`,
`prerequisites-missing`, `session-connect-failed`, `response-rejected`, or
`response-timeout`. When a later probe has no helper evidence, the most recent
helper evidence is retained with its `helperAttempt` so it cannot be mistaken
for the final probe. These observations do not establish a native root cause.

Failed Sandbox bootstrap retains only `bootstrapFailure` from the closed set
`login-unavailable`, `timeout`, `command-failed`, plus the boolean
`bootstrapDeadlineExhausted`. This separates the last execution failure from
budget exhaustion without exposing CLI output. Background bootstrap never
recovers by opening a normal host window or switching to the System account.

Sandbox timeout evidence also records safe observations from a fixed set of
startup files: `bootstrapStarted`, `bootstrapReady`, and `helperHeartbeat`, plus
`bootstrapStderr` and `helperStderr` classifications (`absent`, `empty`,
`access-denied`, `path-not-found`, `script-policy`, `parse-error`, `other-error`,
`unreadable`, `oversized`). These are observations, not proven root causes;
unrecognized localized text remains `other-error`. Raw text and filenames do not
flow through the MCP diagnostic projection. The bootstrap-ready marker is reset
with the other session markers so a previous run cannot report false progress.

A failed-start real E2E saves a separate bounded local startup-log bundle before
cleanup removes the device scratch directory. Only fixed files beneath the
current owner's exact device directory are eligible; links and oversized files
are refused. The terminal prints the bundle reference, never its contents. Raw
local bundles are separate from sanitized MCP error artifacts and may contain
local paths or guest error text; inspect them locally before sharing. Failure to
capture evidence must not skip VM cleanup or replace the original test failure.

Concurrent Sandbox logon and recovery bootstrap calls must not overwrite a live
helper's script or redirected logs or start duplicate daemons. Serialize bootstrap
effects and verify an existing helper's executable, script invocation, session,
and process creation identity before reusing it. Ambiguous or inaccessible process
identity fails without replacing the helper script or output logs or terminating processes. An exited
helper permits recovery; an abandoned bootstrap lock must not permanently prevent
recovery. One-shot requests remain independent of the daemon's lifetime lock.
Bootstrap completion remains distinct from a successful cursor readiness probe.

After acquiring the bootstrap lock, startup records its phase before process
discovery and a closed error code on failure, when the mapped diagnostic directory
is writable. Diagnostics must not require successful identity
discovery, overwrite a live helper's redirected output, or extend the caller's
deadline. Absence of all startup files does not establish whether bootstrap was
launched. Test cleanup must remain owner-fenced; a disconnected viewer alone is
not authority to close other host windows or terminate unrelated processes.
Missing helper readiness must not launch another viewer when the current device
already records a successful session launch. Bootstrap recovery and a real cursor
probe still run; session-launch success alone is not guest readiness.
