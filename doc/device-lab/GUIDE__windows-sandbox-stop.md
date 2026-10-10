# Windows Sandbox lifecycle

`createWindowsSandboxLifecycle` owns direct start, stop and delete policy. The
existing `createWindowsSandboxStop` factory delegates to the same stop policy and
retains its helper API. Accepted create remains a separate peer application.

Direct start acquires lifecycle and host-singleton claims, launches and observes
the runtime, manages minimization and helper sessions, then publishes through
complete-record CAS. Stop and forced delete reuse the same owned-runtime stop
policy. Ambiguous runtime registration does not select an unidentified runtime
for cleanup or release ownership without evidence. Direct delete removes the
record before releasing the singleton and removing scratch; a scratch failure
can therefore leave files after the record is gone.

`createBrokerWindowsSandboxLifecycle` owns the distinct authenticated broker
start/stop/delete execution and response policy. It refreshes canonical configs,
advances the expected record after auxiliary cleanup, interprets runtime and
window observations, and publishes through the native CAS boundary. Before claiming
or launching, its runtime baseline rejects a requested GUID that already exists;
that preflight neither cancels watchdog markers nor starts or stops a runtime.
Uncertainty after an actual launch retains singleton ownership. Teardown checks the expected record
before releasing ownership or deleting artifacts; artifact-cleanup failure is
reported before final record removal.

The adapters retain native operation and state locks, singleton generation
checks, guarded config/workspace paths, bounded WSB/PowerShell commands, watchdog
process authority and atomic state publication. Applications receive required
named ports rather than filesystem/process namespaces or a legacy lifecycle
callback. Construction does not launch providers.

Verification uses ordinary application ports and required-capability type checks,
existing fake-WSB public MCP tests, native owner/lock regressions, and authenticated
HTTP broker fixtures. Package smoke verifies shipped startup separately. Portable
fixtures do not certify Windows Sandbox on a real Windows host; native E2E requires
an available authorized host.
