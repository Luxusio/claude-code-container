# Clipboard application boundary

Live paste and current policy delivery are separate boundaries. Test a new
session against deliberately different old/current service fixture content;
an old immutable port-file bind must not override its explicit current
selection. Preserve legacy client refresh and the original mounted source
verification. See [generation ownership](REQ__clipboard-generation-coexistence.md).

Keep the existing serialized native reads and marker coherence. For recurring
old-image reports, verify image → text → empty → identical image at the actual
HTTP/shim and X11 consumers, including immediate startup and owned selection
loss. Distinguish read errors from empty state and from positively absent
ownership. Do not infer intent by globally reversing mixed image/text priority.
Use synthetic data in an owned device-lab fixture; report Linux component,
native Mac, native Windows and actual CLI TUI evidence separately.

Known current policies publish `clipboard.<12hex>.port` beside the legacy
`clipboard.port`, with an independent `clipboard.<12hex>.starting` slot.
Authenticated matching health and exact publication identity qualify reuse.
Fresh disjoint creation requires complete, nonpending runtime history and
exclusive publication under the global guard; an occupied generation retains
the existing replacement and retirement vetoes. Initialization, commit receipt,
watchdog and retirement carry the selected allowed path. Keep older files,
helpers and services intact, including during rollback.

New sessions carry a paired URL/token and `CCC_CLIPBOARD_GENERATION` for a
known twelve-character lowercase hexadecimal policy. The shims and bridge skip
legacy mounted-record refresh only in that marked mode. A reused container
keeps its exact verified legacy mount, while synced clients use the selected
endpoint. Host-side Codex startup attachment uses loopback; container clients
retain their platform-appropriate host address. Startup image HTTP reads have
a five-second total budget and settle unavailable on incomplete or failed
responses. This optional attachment path does not prove live shortcut paste.

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
| snapshot | queue/cache/generation, marker coherence, TTL, image selection and ordered file-group fallback | helper frames/processes, commands, encodings/parsers, normalized capture/marker facts and file paths, local file read/copy |
| text write | validation, shared-cache invalidation, five-second budget and completion policy | UTF-8/base64, fixed platform commands/environment, process/listener/input/termination/timer handling and finite completion facts |
| server lifecycle | authenticated reuse, contention/recovery/grace, upgrade deferral, shutdown acknowledgment, successor polling and synchronous retirement decisions | home/port paths, record parsing, lock identity/authority, native bind observations, HTTP health/shutdown, fixed detached launch/unref |

Domain and ports modules describe Clipboard values and finite native
facts/effects. Application imports domain, ports and its own helpers. It does
not import OS, fs, child_process or HTTP types, concrete adapters, environment,
module metadata or real clocks/timers. Bytes are opaque generic values; Buffer
references and codecs stay at the facade. Native capture performs one transaction
without caching, retrying or reading clocks. Windows framed parsing and
Darwin helper/legacy/pngpaste selection stay native, as do Linux target queries,
URI parsing and MIME decoding. Cache, coherence, generation replay and image
file selection execute in application.
Do not expose a whole old read/cache/write/ensure/retire flow as a port.

The orphan-session grace rule lives in `src/domain/clipboard/server-lifecycle.ts`.
`clipboardServerOrphanWatchdogState` starts the 15-second grace on the first
empty-session observation, authorizes shutdown at the boundary, and clears
the grace when an active session is observed. The native facade re-exports
the existing function and constant; it still owns the timer, session facts
and shutdown effects. The existing policy fingerprint already includes this
domain module. No additional lifecycle workflow or port is needed.

The facade creates one explicit snapshot state and supplies it to both snapshot
and write bindings. Every HTTP server/platform instance shares that state and
queue. Core factories have no host defaults or ambient global cache. Pure tests
construct explicit byte/fact/clock ports without modifying HOME. Adapter tests
use private homes and simulated native facts, closing owned servers/children
before restoring facts or removing fixtures.

The cached-read binding serializes transactions and recovers its queue after
failure. A generation change repeats a successfully completed stale read before publishing or returning it;
an already failed read remains failed. Native frame and marker failures become
unavailable observations. Application coherence failures use the supplied native
ClipboardReadError factory so HTTP remains 503. A successful empty snapshot
remains distinct; failed Linux target queries retain their empty-data policy.
Unexpected native exceptions retain HTTP 500 and do not become unavailable or
negative-cache entries. An absent Darwin helper uses the legacy capture; a
present but failed helper does not. A missing Darwin capture marker is accepted
only when both surrounding marker observations are null.
Positive marker cache and short negative/no-marker TTL rules retain their exact
wall-clock checks and capture timestamps.

Direct image bytes have priority. Next resolve the file-reference group, then
the text-path group; within each group try every byte read before any copy.
Do not flatten the groups into one pass. Linux selects the first URI target
with nonempty parsed paths even if those paths later fail. Resolve file
fallback inside each capture attempt before the final marker observation.
If all image fallbacks fail, preserve the ordinary captured text. Native
readers require nonempty file bytes. Linux snapshots retain the initial-read
timestamp; coherent marker snapshots use their completion timestamp.

Writer preparation yields unavailable or a ready native effect. Validate text
before preparation or invalidation; unavailable preparation preserves cache.
Executed writes invalidate before execution and in finally. Native execution
returns written or failed and owns its listener, stdin, timer and termination
handling. Timeout/input failures finish even when termination throws; failure
does not prove that the child exited. HTTP acknowledges a write only after
completion, returning 204 for success and the existing 500 for native failure.
Function/Promise identity, getter ordering and ignored undefined returns are
not architecture contracts.

Ensure uses monotonic contention/publication deadlines and preserves lock order. Recovery
grace remains before try/finally: rejection does not release that recovered lock.
The locked finally release may override success or a primary error. Bind-user
uncertainty preserves existing publications; acknowledged shutdown and writer
settlement precede replacement within an occupied generation. A changed token
plus authenticated current version is required before a waiting caller accepts publication. Native inode,
owner/link/mode safeguards remain in the facade and lock helpers.

Public stop and retirement return `Promise<void>` and await their guarded native
settlement attempts. They retain other-session/bind-user vetoes, authenticated health,
writer-settlement admission and terminal-state publication. They do not unlink
metadata or gain authority over another generation. Explicit-path retirement
remains a compatibility API subject to the same guards. `index.ts` registers it
as a deprecated home-migration compatibility option; the migration application
does not invoke that option.

Independent artifact QA passed on 2026-10-15: two external consumers ran once
in parallel against the qualified assembled emission and Unix payload, with
eight cases each. Both observed synchronous undefined returns, preserved
metadata, conservative vetoes and one authenticated loopback POST /shutdown.
Original leaders were reaped and owned groups were empty.
[Local raw evidence](../../results/clipboard-retire-artifact-01a13ea8-20261015/independent-qa/inventory.json)
retains exact commands, outputs and cleanup. This is historical evidence for
those artifact bytes, not the current asynchronous retirement contract or
generation implementation. Container inventory facts were simulated; that
run did not establish daemon termination, Docker or native desktop acceptance.

### Known ceiling

Synthetic CLI facts establish controlled consumer behavior only — broader native acceptance remains open.

The fixed compatibility hash includes twelve ordered entries: the compiled
facade, six Clipboard domain/application files, four bind-admission modules,
and the shipped Darwin source. See the exact closure in
[the fingerprint contract](REQ__server-policy-fingerprint.md). Literal
labels/length framing and import-time capture remain. Type-only ports and
other external/native dependencies stay outside the closure. Missing static
modules fail ESM startup; a hash-read failure after module resolution can
capture `unknown`. That value cannot authorize generation pinning or a fresh
disjoint namespace. Source/private
compiled fixtures support behavior checks; delivery additionally requires fresh
assembly, an extracted root npm package and its actual Unix installer payload,
each with strict declarations and no source or checkout dependencies.

The shipped Darwin source is also captured independently to select
`clipboard-helper-darwin-<source-sha256-first-16-hex>`. Readiness requires a
complete private executable regular file for that source. Compilation stages
and publishes owned output without replacing an older helper. Empty PNG data
continues to TIFF/other image conversion; an unreadable advertised image with
no valid image or text fallback remains a read error. Windows seekable raw PNG
streams are rewound before copying. These narrow repairs preserve image-copy
priority and native error handling.

Evidence must identify what executes. Direct core/facade tests with simulated
native facts prove those contracts; actual private HTTP, shell, X11, emitted
process and descriptor fixtures prove their exercised boundaries. Replicas,
export-shape checks, permissive error matchers and skipped suites do not prove
whole operations. Keep meaningful byte, coherence, cache generation, native
failure and public HTTP tests, and keep native desktop acceptance separate.
Use the existing full consumer suites without verifier self-tests or frozen
implementation baselines.

Rollback restores a coherent facade/import/core/test/doc checkpoint and rebuilds
and assembles before replacing a payload. A code revert does not stop or revert
an already running daemon. Existing authenticated ensure/retire and bind/lock
fences still apply; do not acquire new authority over mounted state or uncertain
owners during rollback.

Known ceiling: portable Linux fixtures do not establish interactive Windows or
macOS clipboard acceptance. An owned Mac VM native helper witness establishes
only its recorded synthetic AppKit inputs and helper frames. Native Windows
device-lab execution and actual Codex/Claude shortcut-paste flows remain
separate acceptance requirements; skipped or in-memory native witnesses do
not satisfy them.

## Container X11 synchronization

`scripts/lib/clipboard-x11-sync.sh` owns host startup adoption, local-change
priority, failed-upload retry, host-poll race protection and successful-selection
baselines. It calls the bridge's finite read-local, read-host, signature, upload
and apply leaves. Clipboard bytes stay in private native files; the application
never puts them in shell variables or handles tokens, commands or processes.

`scripts/ccc-x11-bridge` retains text-target/size admission, legacy token refresh,
bounded curl/xclip calls, Xvfb and identity-qualified singleton replacement.
It sources the repository sibling policy or the installed
`/usr/local/lib/ccc/clipboard-x11-sync.sh` before replacement authority, and
both assets participate in the generation fingerprint. Missing policy fails
startup. Both Docker images and the npm package ship the policy; installed
scripts are normalized to LF.

The singleton identity includes the bridge/policy bytes and a digest of the
selected URL/token/generation, without persisting raw credentials. A matching
owned process can be reused; a changed pair follows the existing verified
replacement path. Container launch waits for bounded `--wait-ready` success
from that selected process after its first successful sync. Failure surfaces
before the interactive command launches. When no connection is selected,
the existing graceful no-clipboard startup path remains.

When host content is unchanged but the X11 owner has disappeared, direct
`XGetSelectionOwner` absence can authorize republishing it. A failed display
query or failed text conversion cannot. Recheck absence before applying host
content so genuine local selections retain priority. The X11 display remains
one shared view of the same host clipboard across container sessions.

Refreshing an existing container stages both files, normalizes them, and
publishes the root-owned, ccc-readable policy before renaming the bridge.
Policy installation failure leaves the old bridge in place. Cleanup of owned
stages is attempted on every exit. Deploy or roll back the two assets together. The real
isolated X11 tests cover bytes, retries, races and process ownership; portable
X11 evidence does not certify a native macOS pasteboard.
