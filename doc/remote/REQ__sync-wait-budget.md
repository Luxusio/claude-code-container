# Remote sync waits must honor their deadline

`waitForSync(sessionName, timeoutMs)` retains its 120000 ms default and uses a
monotonic deadline. Before each observation it computes the remaining duration;
when that duration is expired, it starts no new query. Native Mutagen discovery
receives the bounded remaining timeout. A nonpositive or sub-millisecond usable
process budget dispatches no native child.

A watching observation that returns after the deadline must result in the
existing sync-timeout error, not success. The remote execution workflow therefore
must not open interactive SSH after that late observation. Each poll sleep is
clipped to the remaining duration; there is no additional full-second sleep after
expiry. Missing and failed observations retain their existing error precedence,
and their evidence remains opaque to the core. Existing reuse/paused/watching
priority, pinned endpoint identity, session claims and cleanup are unchanged.

Verify virtual late-watching, missing/failed, clipped-sleep and expired-no-query
cases in `src/__tests__/architecture/remote-sync-core.test.ts`. Verify native
Mutagen argv/options and no dispatch for unusable budgets in
`src/__tests__/architecture/remote-services-facade.test.ts`, consuming the current
synchronous contract. Controlled fixtures do not certify live SSH/network service
reliability or fix the separate shared sync-name issue across remote authorities.

Budgeted query termination must complete even when the owned query process handles SIGTERM without exiting. Use the existing native hard termination capability for bounded queries; unbudgeted compatibility remains unchanged. Verify with an actual finite native leaf with delayed natural exit, without an unbounded worker or auxiliary watchdog.
