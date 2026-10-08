# Direct Windows Sandbox stop application

The complete direct `device_stop` transaction lives in
`providers/application/lifecycle/windows-sandbox-stop.mjs`. Its import-free
`domain/lifecycle/windows-sandbox-stop.mjs` defines the checked lifecycle,
singleton, watchdog, auxiliary and ISO timestamp projections. Required semantic
ports live in `ports/lifecycle/windows-sandbox-stop.mjs`. The native backend
`providers/backends/windows-sandbox.mjs` composes those ports and translates the
application result into the existing MCP response.

The application is synchronous. Its stop, claim, current-record lookup, abort,
singleton binding, runtime-stop and watchdog helpers do not return Promises or
introduce an await between effects. The existing named two-argument async
`handleWindowsTool` stays the public entry point. Start and delete retain their
branch bodies and use legacy wrappers that delegate the shared helper policy.
No generic lifecycle framework or whole-transaction native port is involved.

## Native authority and checked ports

| Required port | Existing native authority retained |
| --- | --- |
| readSingleton / sameSingletonOwner | Native singleton reader and owner/device/sandbox comparison |
| newRuntimeId / wallTimestamp | Native UUID and separate `new Date().toISOString()` calls |
| findDevice / transitionDevice | Existing fenced owner-state repository and exact compare-and-transition |
| claimSingleton / releaseSingleton / singletonGenerationMatches | Existing host singleton mutation lock and generation-scoped claim/release |
| watchdogCancelPath / cancelWatchdog | Existing owner scratch metadata and private cancellation marker |
| discoverRuntime / stopOwnedRuntime | Existing WSB discovery and exact stop invocation, with opaque native binding/evidence |

Executable paths, argv, Node process results, filesystem roots, long locks and
wire envelopes remain outside core. Core consumes a normalized synchronous stop
observation and relays opaque failure evidence to the legacy converter. The
native adapter resolves its stop callee before evaluating executable and device
ID arguments; the success response resolves `jsonResult` before
`withTargetStatus`. Native helper and supplied cancellation callbacks retain
their bare receiver. Static narrow carriers do not add runtime rejection of
records accepted by the existing state validator.

The public facade owns one existing Windows owner/device long operation lock.
Short owner-state CAS and host singleton mutation locks retain their original
nesting. Core adds no lock and makes no atomicity claim across those state files.
The pre-lock target lookup remains outside the timeout catch. Only matching
`shared-mutation-lock-timeout` values thrown during existing locked acquisition
or its callback receive the existing lock-error response. Other thrown values
remain raw; repeated argument getters retain their original positions.

## Compatibility details

Stop claims a lifecycle generation, binds or reuses the exact singleton,
reconciles a stopped record from a matching singleton when applicable, cancels
its minimize watchdog, and stops the exact GUID with the existing 60000ms native
budget. Native exit zero remains the existing success observation. This
extraction adds no post-stop inventory or absence check.

The stop helper returns a stopped record with recording and watchdog launch
cleared. The final transaction instead spreads the matching CURRENT lifecycle
record and transfers only an own `helperSessionLaunch` field from that helper
result. It clears lifecycle/singleton claim, sets status stopped and writes a
separate timestamp. CURRENT recording, watchdog launch, sandbox ID and unrelated
fields remain as the existing source specifies. Neither helper result nor final
commit clears sandbox ID.

Abort restores original lifecycle and singleton fields with their own-property
semantics, including absent, own undefined and null. A missing current claim
retains its separate second lookup. CAS returning unmatched follows the original
conflict/compensation order; CAS throwing prevents later work. Release returning
false is ignored at the original call sites, while release throwing exits before
later response conversion. Cleanup retains integer-positive PID filtering,
deduplication, nonnull watchdog evidence, falsy/array helper behavior and the
public helper's default arity of one.

## Verification and shipping

Build packages and MCP once, then assemble the payload before tests that consume
those artifacts. Invoke direct Vitest against frozen artifacts; the ordinary
wrapper can rebuild and is unsuitable for concurrent artifact verification.

```sh
npm run build:packages
npm run build:device-lab-mcp
npm run assemble:packages
npm run typecheck:architecture
node node_modules/vitest/vitest.mjs run --maxWorkers=2 \
  src/__tests__/architecture/windows-sandbox-stop-core.test.ts \
  src/__tests__/architecture/windows-sandbox-stop-facade.test.ts \
  src/__tests__/architecture/windows-sandbox-stop-replay.test.ts \
  src/__tests__/architecture/windows-sandbox-stop-types.test.ts \
  src/__tests__/architecture/core-boundary.test.ts \
  src/__tests__/device-lab-application-boundary.test.ts
node node_modules/vitest/vitest.mjs run --maxWorkers=2 \
  src/__tests__/device-lab-mcp.windows.test.ts \
  src/__tests__/device-lab-timeout-bounds.test.ts \
  src/__tests__/device-lab-start-readiness.test.ts \
  src/__tests__/windows-sandbox-bootstrap-powershell.test.ts
```

Core tests cover all transaction/shared helper branches and raw faults. Replay
executes functions and the stop branch captured from the actual baseline source
against candidate composition, including callee/getter/receiver ordering. Native
facade fixtures use private homes and scope-safe fake WSB dispatch. Two separate
public-facade processes contend for the same private owner/device through the
actual long lock and observe exactly one runtime stop.

Shipping proof must freshly assemble a private candidate checkout before npm
pack and installation materialization. Package compilation alone does not
refresh `dist/packages`. Compare source, assembled and extracted/materialized
provider hashes, then run each payload's actual core and public facade outside
the source checkout with sanitized private roots. Emit declarations from each
payload's checked core and compile strict positive/negative consumers of those
current declarations. Save candidate/patch, native asset, package and consumer
hashes plus bounded logs before removing private fixtures. Inclusion in a tarball
alone does not prove an executable or typed boundary.

The extraction's persistent contribution is
`doc/harness/checkpoints/recovery-evidence/windows-sandbox-stop-shipping-consumer.mjs`;
its sibling evidence manifest records both forms, current declaration consumers,
module URLs and cleanup. Root CLI TypeScript compilation is also required when
preparing a complete installer payload. Coordinator integration owns broader
package acceptance and independent review/QA evidence.

## Remaining migration scope

Whole `OP-WindowsSandbox-stop` and M04 remain PARTIAL. MCP/direct and backend-child
execution use this provider binding, while the distinct broker-native lifecycle
binding remains legacy and needs its own cutover. Historical broker traces are
not rewritten by this extraction. Delete/start operation policy and the broader
architecture remain separate work.

The optional generated PowerShell bootstrap fixture uses private OS mutexes; an
unavailable PowerShell host is a skip or environment limitation. Neither that
fixture nor portable fake WSB dispatch certifies real Windows Sandbox behavior.
Actual Windows Sandbox acceptance remains unrun in this source task and requires
separate authorized native verification.
