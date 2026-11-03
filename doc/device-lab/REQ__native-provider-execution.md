# Native provider execution

## Provenance

The user reported four Windows full-suite failures on 2026-11-03: two Android
create requests failed after broker health timeouts, Sandbox start exhausted its
control transport allowance before readiness probing, and a completed session
ownership test failed while removing its temporary directory. These are the
requested outcomes to repair. The requirements below are derived implementation
obligations, rather than additional user feature requests.

Owning surfaces are `packages/device-lab/src/device-lab-broker.ts`, its Windows
Sandbox lifecycle application and ports, `scripts/run-vitest.mjs`,
`scripts/test-level.js`, and `vitest.config.ts`.

## Broker responsiveness

Windows Sandbox start must await native commands, runtime registration and
minimization without blocking the broker's HTTP event loop. Health requests must
be serviceable while those effects are pending. Reuse the existing asynchronous
command runner and preserve settled cleanup receipts.

Existing operation allowances remain bounded by monotonic deadlines; awaiting an
effect must not renew them. Ownership claims, expected-record publication,
uncertain-registration retention and safe result-file validation remain in their
existing layers. Keep the exported synchronous minimization helper compatible
with its callers while production uses nonblocking waits.

## Test admission

Opt-in real-provider Vitest files must run serially within their native project
and participate in the existing host-wide real-provider admission. Ordinary unit
and fake-provider tests retain parallel execution and their existing collection.
Do not hide tests or infer real hardware usage from a filename alone.

The runner holds admission until its test child finishes and preserves failure,
signal and spawn-error results. Existing dedicated Level 3 admission must not be
acquired a second time by its collector. Sandbox test entry points use the shared
scenario's startup budget, without a separate shorter override or clock reset.
The Sandbox wrapper must await the scenario and its cleanup before advancing to
another native test. Its per-request deadlines remain authoritative; an outer
test-promise timeout must not leave native work running after admission advances.

## Verification and scope

Verify health responses during pending registration and minimization, admission
contention, unchanged collected file membership, and the reported entry points.
Portable fixtures do not establish native Windows success.

## Known ceiling

Synchronous auxiliary cleanup on stop/delete is outside this bounded
start-responsiveness repair; no general broker or cleanup rewrite is introduced.
