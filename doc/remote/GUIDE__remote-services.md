# Remote host services and native authority

The public remote facade composes the existing native adapter with the application workflows. Application owns configuration decisions, session claims, reservation lifetime, lifecycle locks, signals, polling and cleanup. Native commands, response parsing, shell quoting/encoding, prompts, console output and public Error construction stay in the existing adapters.

The inward contract uses structured requests and finite observations. Reservation returns the native adapter's locally resolved container name and the stable container ID parsed from the reservation marker. Sync observation supplies independent endpoint-match, paused, watching and failure facts; application prioritizes paused when reusing a session and watching when waiting. Native failure details and arbitrary sync display text travel as opaque evidence which application never inspects. The public getMutagenSyncStatus helper renders the existing string/null result outward.

Configuration still selects the canonical remote map before legacy fallback. Legacy existence failure propagates, while legacy read/JSON failure yields no saved config. Exec validates host/user; check retains its read-only behavior. Saving updates the existing canonical remote map without replacing unrelated settings.

Exec holds a fresh token with a 300-second lease and a 30-second unref heartbeat. Claim creation and signal registration precede the protected work. Project preparation, sync and interactive execution use the pinned container ID. Release uses the separately observed pre-start expected name; refresh and stop use the returned name/ID.

Application retains first SSH close/error settlement and the existing signal and cleanup policy. It forwards active-child signals before cleanup and re-signals itself afterwards. Busy stop leaves the remote container and sync running. Release failures retain their existing precedence; failed stop or thrown pause still follows the current local-removal behavior.

Native leaves preserve their different result rules: tool/query/preparation and checked resume/stale termination reject returned errors or nonzero status; ping, reservation, refresh and sync creation retain their existing status rules; image presence uses nonempty stdout. Busy status42 or the sessions-active marker wins during stop. Daemon start, pause and public termination ignore returned failure while propagating thrown exceptions; void effects do not claim successful execution.

The native adapter owns the fixed Docker/Claude program, ordered marker/forwarded environment, literal argument quoting, UTF-8/base64 framing, stdio and effect timeouts. The seven public shell builders retain private-root ownership/mode/link checks, descriptor and pinned-ID fencing, lock-backend admission, peer/token handling and final-token cleanup. These are necessary authority boundaries, separate from the removed callee/receiver/arity capture machinery.

Behavior evidence comes from the remote-services-core, remote-sync-core and remote-services-facade suites, consumed remote-services-type-contracts, original public remote tests, and actual temporary-home remote-shell-native, remote-lifecycle-lock and remote-cache-identity suites. Tests exercise consequential observations, failures, literal arguments and ownership rather than comparing old/new source snapshots. Native expectations also pin required command arguments, timeout options and consequential getter admission. Qualification includes a fresh build and compiled/extracted package entry checks; those checks establish only the artifact bindings they actually exercise.

Sync names currently use the local project identity, while reservation locks also include the remote user and host. Simultaneous use of one project against different remote authorities is not isolated: replacing or pausing the shared sync can affect the other session. Correcting that existing ownership limitation requires a separate policy change and explicit legacy-name handling.

This refactor preserves the current remote Docker/Claude scope. Controlled tests do not certify live SSH/auth/network/daemon reliability or remote Podman support. Those native and wider architecture acceptance obligations remain separate parts of the full M00–M14 Goal.

## Sync wait budget

The wait uses a monotonic deadline, passes the remaining duration to each native
Mutagen query and clips sleeps to that duration. An expired or sub-millisecond
usable process budget starts no native query. A watching observation returned
after the deadline cannot finish the wait or open interactive SSH. Missing or
failed observations retain their existing precedence and opaque failure details.
The public/default wait remains 120000 ms; session reuse and endpoint identity
keep their existing policy. Budgeted queries use native hard termination so a
SIGTERM-handling query cannot retain the synchronous wait past its budget.
Unbudgeted query options remain unchanged. See [the wait contract](REQ__sync-wait-budget.md).

## Known ceiling

Known ceiling: Controlled qualification does not prove live SSH/Mutagen reliability or isolate shared sync names across remote authorities — upgrade when separately authorized.
