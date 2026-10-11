# Clipboard application boundary

The host Clipboard bridge composes three specialized application seams in
`src/clipboard-server.ts`: snapshot/cache/fallback, text write, and server
ensure/retire. The [architecture ADR](../common/ADR__ccc-target-architecture.md)
and [contracts](../common/SPEC__ccc-architecture-contracts.md) own dependency
direction. Existing [image](../common/REQ__clipboard-image-bridge.md) and
[text-copy](../common/REQ__clipboard-text-copy.md) requirements own behavior;
[policy fingerprint](REQ__server-policy-fingerprint.md) defines the extraction's
deliberate compatibility-version change.

| Seam | Application owns | Native facade owns |
| --- | --- | --- |
| snapshot | queue/cache/generation, marker coherence, TTL, platform read selection, Darwin/Linux fallback ordering, two-pass file selection | helper frames/processes, commands, encodings/parsers, individual capture facts, local file read/copy and paths |
| text write | validation, shared-cache invalidation, write completion/timeout decisions and callback settlement | UTF-8/base64, fixed platform commands/environment, process/listener/input/termination/timer effects |
| server lifecycle | authenticated reuse, contention/recovery/grace, upgrade deferral, shutdown acknowledgment, successor polling and synchronous retirement decisions | home/port paths, record parsing, lock identity/authority, native bind observations, HTTP health/shutdown, fixed detached launch/unref |

Domain and ports modules describe Clipboard values and required primitive
facts/effects. Application imports domain, ports and its own helpers. It does
not import OS, fs, child_process or HTTP types, concrete adapters, environment,
module metadata or real clocks/timers. Bytes are opaque generic values; Buffer
references and codecs stay at the facade. A narrow Windows read-all capture
adapter remains native because it performs one framed capture/parse transaction.
Darwin business fallbacks and cache/coherence decisions execute in application.
Do not expose a whole old read/cache/write/ensure/retire flow as a port.

The facade creates one explicit snapshot state and supplies it to both snapshot
and write bindings. Every HTTP server/platform instance shares that state and
queue. Core factories have no host defaults or ambient global cache. Pure tests
construct explicit byte/fact/clock ports without modifying HOME. Adapter tests
use private homes and simulated native facts, closing owned servers/children
before restoring facts or removing fixtures.

The cached-read binding is ordinary/nonasync: it returns the original queue
`.then` promise and separately stores `.catch` recovery. A generation change
repeats a successfully completed stale read before publishing or returning it;
an already failed read remains failed. Native frame, marker and coherence
failures use the supplied native ClipboardReadError factory so the existing HTTP
`instanceof` mapping remains 503. A successful empty snapshot remains distinct.
Positive marker cache and short negative/no-marker TTL rules retain their exact
wall-clock checks and capture timestamps.

Image fallback selects both optional read/copy callbacks once in the original
getter order, invokes them as bare callbacks, and tries every byte read before
any copy. Custom truthy empty byte objects retain their original behavior;
default native readers still require nonempty bytes. Preserve target order,
PNG/BMP read order, markers, byte references and callback counts.

The facade directly exports the named async application write and ensure
bindings. Adding an async forwarding wrapper changes promise identity and is
not part of this boundary. Writes validate before native writer selection and
invalidation, invalidate before launch and in finally, and preserve listener/
timer registration order. A callback's original kill/clear failure can escape;
do not add rescue or change settled state. Required synchronous ignored-effect
ports return concrete undefined, rejecting Promise implementations. Native
adapters discard only returns that the original operation ignored.

Ensure preserves its existing wall-clock deadlines and lock order. Recovery
grace remains before try/finally: rejection does not release that recovered lock.
The locked finally release may override success or a primary error. Bind-user
uncertainty keeps the authenticated old bridge; acknowledged shutdown and legacy
grace precede successor publication. A changed token plus authenticated current
version is required before a waiting caller accepts publication. Native inode,
owner/link/mode safeguards remain in the facade and lock helpers.

Retirement bindings return undefined synchronously and ignore the asynchronous
shutdown result. They retain the other-session/bind-user vetoes and do not rescan
sessions, unlink metadata or adopt a Promise. The exported stop function currently
has test callers only. index.ts registers explicit retirement as a deprecated
home-migration compatibility option; the migration application does not invoke
that option. This extraction adds no session or home cleanup edge.

The fixed compatibility hash includes the compiled facade and six runtime
domain/application files, with literal labels/length framing and import-time
capture. Type-only ports and native/external dependencies remain outside its
new closure. Missing static modules fail ESM startup; injected hash-read failure
after module resolution can capture unknown in a live bridge. Source/private
compiled fixtures support behavior checks; delivery additionally requires fresh
assembly, an extracted root npm package and its actual Unix installer payload,
each with strict declarations and no source or checkout dependencies.

Evidence must identify what executes. Direct core/facade tests with simulated
native facts prove those contracts; actual private HTTP, shell, X11, emitted
process and descriptor fixtures prove their exercised boundaries. Replicas,
export-shape checks, permissive error matchers and skipped suites do not prove
whole operations. Preserve existing assertions/skips and keep native desktop
acceptance separate. The task's 42-row source inventory records coverage
destinations and quality grades without turning an unexecuted row into PASS.

Rollback restores a coherent facade/import/core/test/doc checkpoint and rebuilds
and assembles before replacing a payload. A code revert does not stop or revert
an already running daemon. Existing authenticated ensure/retire and bind/lock
fences still apply; do not acquire new authority over mounted state or uncertain
owners during rollback.

Known ceiling: interactive Windows/macOS Clipboard and application-specific
pasteboard formats remain unverified by portable Linux fixtures. Execute native
acceptance on those hosts before claiming it.

## Container X11 synchronization

`scripts/lib/clipboard-x11-sync.sh` owns host startup adoption, local-change
priority, failed-upload retry, host-poll race protection and successful-selection
baselines. It calls the bridge's finite read-local, read-host, signature, upload
and apply leaves. Clipboard bytes stay in private native files; the application
never puts them in shell variables or handles tokens, commands or processes.

`scripts/ccc-x11-bridge` retains text-target/size admission, token refresh,
bounded curl/xclip calls, Xvfb and identity-qualified singleton replacement.
It sources the repository sibling policy or the installed
`/usr/local/lib/ccc/clipboard-x11-sync.sh` before replacement authority, and
both assets participate in the generation fingerprint. Missing policy fails
startup. Both Docker images and the npm package ship the policy; installed
scripts are normalized to LF.

Refreshing an existing container stages both files, normalizes them, and
publishes the root-owned, ccc-readable policy before renaming the bridge.
Policy installation failure leaves the old bridge in place; owned stages are
removed on every exit. Deploy or roll back the two assets together. The real
isolated X11 tests cover bytes, retries, races and process ownership; portable
X11 evidence does not certify a native macOS pasteboard.
