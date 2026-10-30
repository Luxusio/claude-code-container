# Regression test entry points

`npm test` first runs the explicit Node regression files listed in `package.json` through `npm run test:scripts`, then runs the existing build-and-Vitest entry point. The Node files cover release manifest/pin synchronization, Windows LX workspace-link repair (including the build recipe module closure), and test-result capture and orchestration. They use private files and simulated native commands; they do not contact a real container engine. A Node test failure stops the command before Vitest and returns nonzero.

`npm test -- <Vitest filter or options>` retains those arguments for Vitest. The small Node prelude always runs, including filtered invocations. `npm run test:scripts` runs only that prelude without a build. Explicit filenames avoid shell-glob differences on Windows. Add a new Node owner to this command when intentionally adding one to the default suite.

`npm run test:watch`, direct Vitest, and the specialized `npm run test:level0` remain separate entry points. They do not gain the Node prelude. The Level 0 installed-package fallback and real-provider levels are unchanged.

The root unit Vitest setup canonicalizes its temporary-directory base before fixture imports. MCP fixture transports also receive an explicitly owned private temp directory. Real Level 3 host setup stays separate. See [shared failure diagnosis](GUIDE__test-failure-groups.md) for path, native prerequisite and stale fixture groups and their evidence limits.

## Level 3 broker preflight failures

`npm run test:level3` builds its artifacts, then verifies the host broker before starting provider tests. The `CCC host broker repair preflight failed` diagnostic preserves both available output streams from the broker status command, followed by its exit status, signal, spawn error, and configured timeout. Protocol mismatch and later attestation failures have separate diagnostics. `error=none` means the child had no spawn error; `timeoutMs=180000` states the limit and does not mean a timeout occurred.

`host-broker-incompatible` with an unverified port owner can occur even when the broker protocol is compatible. Compare the selected runtime's process metadata, the actual listening PID and command, the broker's read-only HTTP `/status`, and the current checkout's broker entry paths. A broker from a global installation or another checkout can fail the exact entry-path check. Do not delete metadata or kill an unverified listener to bypass this failure. `ccc devices broker status --verbose` may automatically repair a verified broker; it is not a read-only probe.

When the native PID and birth agree with runtime and status but the observed entry belongs to a global installation, the differing trusted entry path establishes a conflict even though those identity observations agree. Keep the exact path check. Separate execution requires both endpoint selection and separate runtime metadata; changing HOME would also change provider state and shared locks. Restarting a shared broker instead affects its existing clients and requires fresh identity proof before signaling.

`npm run test:level3` defaults to `127.0.0.1:17374` and
`~/.ccc/devices/broker/runtime-17374.json`. Its preflight and provider MCP clients
receive the same endpoint configuration. Ordinary CCC execution retains
`127.0.0.1:17373` and `~/.ccc/devices/broker/runtime.json`; there is no need to stop
that broker. Actual HOME, owner/authentication state, physical leases and provider
locks stay shared. This separates broker routing, not physical device access.
See [the isolation contract](../device-lab/REQ__level3-broker-isolation.md).

For a different dedicated port, set `CCC_DEVICE_BROKER_PORT` to a canonical
decimal integer from 1 through 65535. Host and MCP use `runtime-<port>.json` for
nondefault configured ports; 17373 keeps `runtime.json`. Empty/unset values retain
ordinary behavior outside the Level 3 runner. An occupied dedicated port still
requires the existing ownership proof; no foreign listener is taken over.
Internal free-port fixtures with private HOME clear this setting. Preflight
prints the attested port and refuses a result pointing to a different endpoint.

On macOS, collect listener and process evidence on the Mac with `/usr/sbin/lsof -nP -iTCP:<port> -sTCP:LISTEN -Fp`, `/bin/ps -ww -p <pid> -o command=`, and `/bin/ps -p <pid> -o lstart=`. Read only the runtime's name, managedBy, PID, port, command, args, cwd and process start metadata; owner authentication files are unnecessary. Container PID observations and mocked launcher regressions do not validate native Mac ownership. The portable launcher tests are in `scripts/real-tests/hyper-v.test.ts`; running that file through the regular Vitest config does not run the Level 3 provider suite.

For port 17373, run the checked-in read-only collector from the Mac checkout root:

```sh
node scripts/real-tests/host-broker-observations.mjs
```

It needs no build or project dependencies. Its JSON includes listener observations before and after collection, untruncated commands, separate start times, selected runtime metadata and selected HTTP `/status` fields. `httpOk` records HTTP 2xx status success; `ok` preserves the parsed application's result when available. Native commands and HTTP reads are bounded; owner authentication files are excluded. It never repairs or restarts the broker. A completed diagnostic is not a readiness verdict: unavailable or changed observations remain visible, and actual Mac output is required to identify the conflict. `--help` describes invocation without collecting host state.

## Provider failure diagnostics

Read the saved `results/device-lab-real/mcp-error-*.json` named by a failure
before rerunning providers. The iOS observation path retains native status,
signal, timeout and closed error codes in MCP structured failure content while
preserving its existing error text. The test parser selects those fields for
the artifact; plain text is not copied into it. Missing structured evidence
still falls back to the existing JSON error handling.

Mac desktop SSH/SCP command failures retain the same selected native facts.
Readiness retains boolean timeout and a known native diagnostic code as well.
A selected failure from an earlier attempt describes that attempt, rather than
every later unclassified probe. For example, the latest saved Tart case keeps
`broker-rpc-unavailable` from attempt 22 of 192; it does not prove the final
probe failed at the transport layer. Missing bridge prerequisites without a
native receipt remain unclassified.

Tart boot failures can be nested at `result.execution.command.macosBoot`.
Artifacts now distinguish that IP-readiness phase from the start process's
execution status. An IP timeout category is emitted only from the renderer's
known timeout result. A generic HTTP 502 or elapsed duration alone does not
establish a boot timeout. The internal Appium missing-device check also saves
unexpected broker errors before assertion-message truncation.

MCP process-verification refusals can retain the closed native observation
stage, reason and completion facts. Failed or interrupted native output remains
unverified; a successful empty command still needs the existing PID/birth/status
continuity proof. Darwin listener discovery uses a shared monotonic 5,000 ms
observation allowance: `lsof` may use its remainder, while each `ps` call keeps
its 1,000 ms cap. The active Tart allowance can shorten every probe. Expired
dispatch and late successful observations are refused; ownership fences remain.
See
[the failure evidence contract](../device-lab/REQ__provider-failure-evidence.md).
Portable diagnostic tests do not establish the original Mac failure's cause.

## iOS Simulator execution

Use the explicit `exec` argv form for programs supplied by the Simulator:
`{deviceId, argv:["launchctl", "managerpid"]}`. This form accepts a program
basename and literal arguments, only for owned iOS Simulators. It does not
interpret shell syntax. The existing command-string form retains its shell
behavior; an unavailable or rejected shell remains a failure.

The observed 26.5 and 27.0 runtimes contain `launchctl` and lack `bin/sh`.
Installed `xcrun simctl help spawn` distinguishes device-PATH lookup for bare
names from host-root lookup for absolute executable paths. Do not infer that
an absolute `/bin/sh` was resolved inside the runtime, or work around a failure
by running the command in a host shell or deprecated standalone mode. See
[the execution contract](../device-lab/REQ__ios-simulator-exec.md).

## Native UID regression

The private-config case in `src/__tests__/codex-harness.test.ts` is opt-in through a nonempty `CCC_TEST_HARNESS_IMAGE`. It requires a POSIX host with UID/GID APIs and an image containing the named `ccc` account and runtime tools required by the existing bootstrap. With no image, or without that host capability, it skips before invoking Docker. An explicitly supplied but unavailable image fails with a diagnostic.

Run the case deliberately with an already available suitable image:

```sh
CCC_TEST_HARNESS_IMAGE='your-existing-test-image' npm test -- src/__tests__/codex-harness.test.ts -t 'reads private config when the default UID differs'
```

The fixture creates a uniquely named, network-disabled container. After successful creation, only its validated captured container ID authorizes exec and cleanup. A failed or uncertain creation does not authorize removal by a guessed name. If the host default UID equals the image's named `ccc` UID, this image cannot exercise the split and the case reports a skip while cleaning its confirmed container. Review an uncertain creation using the reported unique fixture name; no automatic name-based deletion is attempted.

## Evidence limits

Test existence, ordinary collection, portable execution and native acceptance are different claims. The portable Node fixtures do not prove real NTFS operations. An unrun or skipped UID case does not prove actual Docker ownership migration. macOS Slack clipboard and actual macOS sudo recovery need their native platform evidence; the exact missing-`pngjs` → restore-dependencies → successful-build sequence remains separately unverified. These entry points do not certify every historical failure or the whole architecture migration.

## Live clipboard paste and service generations

Use the affected owners to distinguish delivery from native capture. The
private-HOME daemon integration owner exercises actual emitted `dist` processes
and authenticated HTTP with an inert native-runtime fixture. Rebuild root
TypeScript emission before that owner; this does not require rerunning unrelated
provider suites. Run the focused portable groups from the checkout root:

```sh
node node_modules/typescript/bin/tsc -p tsconfig.json
node node_modules/vitest/vitest.mjs run src/__tests__/clipboard-global-admission.integration.test.ts src/__tests__/architecture/clipboard-policy-fingerprint.test.ts src/__tests__/architecture/clipboard-lifecycle-core.test.ts src/__tests__/architecture/clipboard-lifecycle-facade.test.ts --maxWorkers=2
node node_modules/vitest/vitest.mjs run src/__tests__/clipboard-shims.test.ts src/__tests__/clipboard-copy-shims.test.ts src/__tests__/clipboard-x11-copy.test.ts src/__tests__/architecture/container-exec.test.ts src/__tests__/clipboard-image-server.test.ts src/__tests__/codex-clipboard-image.test.ts --maxWorkers=2
```

The X11 owner needs its actual private Xvfb/xclip prerequisites. It checks
image → text → empty → identical image, current endpoint selection despite an
old mounted record, first-sync readiness, and positive selection-owner loss
without overwriting another local owner. A missing native prerequisite is a
skip or environment blocker, not proof that stale-image paste is fixed.

For a Mac with AppKit and the command-line compiler, run only the private
pasteboard conversion witness without a project build:

```sh
node node_modules/vitest/vitest.mjs run src/__tests__/clipboard-image-server.test.ts -t 'converts native TIFF when a private pasteboard advertises an empty PNG' --maxWorkers=1
```

It compiles the exact candidate helper conversion function and uses a uniquely
named private pasteboard. It does not read the user's general clipboard or
exercise an interactive CLI.

On a native Windows host with Windows PowerShell and Windows Forms, run the
controlled native acquisition witnesses:

```sh
node node_modules/vitest/vitest.mjs run src/__tests__/clipboard-server.test.ts -t 'native seekable MemoryStream|native text when the advertised PNG stream is empty|native empty advertised PNG' --maxWorkers=1
```

These execute the generated PowerShell acquisition code with an in-memory
data object, including a seekable PNG stream positioned at EOF. They do not
exercise the desktop clipboard, container transport or either CLI's shortcut.
Running them elsewhere skips native cases and cannot count as Windows PASS.

Actual device-lab acceptance uses generated content in an owned disposable
fixture and records the candidate/helper hash, OS/client versions, target
types, byte sizes and image digests. Keep Mac native helper observations,
Linux HTTP/shim/X11 checks, native Windows observations and actual Codex/Claude
TUI paste results distinct. The current connected device-lab host supplies a
Mac VM; Windows backends are unavailable there. The Mac component observations
do not close Windows or actual TUI acceptance. Do not persist a user's clipboard
or authentication token as test evidence. See
[generation ownership](../clipboard/REQ__clipboard-generation-coexistence.md)
and [the clipboard guide](../clipboard/GUIDE__clipboard-bridge.md).

For an actual Slack source case on a Mac, immediately after copying the image,
`osascript -e 'clipboard info'` reports native format labels and byte sizes.
It needs no build and does not print image/text contents. Preserve that source
observation separately; synthetic PNG/TIFF fixtures do not identify Slack's
formats or prove its actual shortcut-paste flow.

## Native residual verification follow-up

The shared macOS VM E2E runner uses the provider's existing 300,000 ms boot
allowance when no valid environment or explicit option is supplied. Explicit
options retain precedence over `CCC_REAL_MACOS_VM_BOOT_TIMEOUT_MS`. This replaces
the E2E runner's inconsistent 10,000 ms fallback; provider polling and admission
rules are unchanged. The existing client/RPC derivation accommodates the
selected boot allowance. A successful Tart process launch still requires actual
IP readiness before the test can pass.

An isolated test launcher may copy sealed source into its own disposable
directory and modify that copy. Ensure only the owned copy is writable, retain
executable bits and leave source bytes/modes intact. Resolve installed fixture
dependencies through module resolution; a source snapshot need not contain a
root `node_modules` directory. Never change sealed-source permissions or install
dependencies to make a review pass.

macOS VM transfer probes create upload/download files in a fresh private
subdirectory of the canonical project `results/.tmp` output and remove that
directory on success or failure. Keep these paths inside the owner project:
the broker correctly refuses transfers outside its project mount. Canonicalizing
the base preserves existing symlink-path refusals. The source tree stays sealed;
only the declared output needs write access. Frozen verification supplies workspace package
links only inside its declared disposable `node_modules` output and includes
any historical emitted entry it exercises as an explicit artifact. Such an
artifact tests its recorded bytes; it does not establish that the current
candidate has been rebuilt.

The Oct27 native run reached desktop-control readiness for both Tart cases.
Read the retained `readiness.failure` and `failureAttempt` when present: they
distinguish selected broker-process, broker-transport and provider observations.
Later unclassified failures do not erase a prior selected observation. These
fields omit raw output, paths and credentials and do not change readiness rules.
Failed sequential and worker modules retain their already-recorded MCP calls
and sessions in the collector, while the scenario still fails. Use that order
to locate the failing iOS phase; an old exit 111 is not resolved by a later
generic status refusal.

Broker Mac VM start installs the existing guest helper after IP discovery and
before publishing the running record. Launch, IP discovery, helper installation
and final admission share the broker-local start allowance, including operation
lock wait. A failed installation preserves the pending start recovery record.
This closes a source-proved gap; native execution must still establish whether
it explains the observed Tart readiness failure. See
[the helper contract](../device-lab/REQ__macos-broker-helper-readiness.md).

The Oct27 15:09:55 run used the current MCP bundle while its isolated broker
runtime retained a process started on Oct26, before the helper and argv fixes.
Rebuilding an entry file does not reload a running broker. Protocol 9 requires
those fixes and replaces protocol 8 through the existing verified repair path.
The launcher reads its protocol from the workspace before assembly, so an old
assembled contract cannot remain cached during preflight. Use ordinary
`npm run test:level3` on the Mac to rebuild and verify this transition. The
installed broker on port 17373 remains separate. See
[the recovery contract](../device-lab/REQ__host-broker-automatic-recovery.md).

Real-provider suites in one collector share the selected broker owner mutation
queue. All nine known provider modules therefore share a scheduler resource:
an iOS RPC must not spend its timeout queued behind a five-minute Mac start.
Even the Linux VM suite can auto-select broker Hyper-V during creation, so its
whole module cannot be assumed independent. Generic disjoint-resource scheduling
still supports concurrency. See
[the scheduling contract](REQ__provider-owner-scheduling.md).

For helper start failures, read `helperPreparation` separately from the VM launch
`execution`. A zero Tart launch status does not establish helper readiness. The
saved preparation fields select its known error, provider and native execution
facts; raw SSH output and credentials remain omitted. A polling timeout retains
only bounded facts from its last observed native receipt. These diagnostics do
not establish SSH configuration or a guest failure without host evidence.

The Oct28 run reaches iOS `wait_for_app` after successful start, literal exec,
screenshot and URL opening. Total probe failure must preserve the last native
status, signal, errno and explicit timeout through public MCP presentation.
The focused Mac reproduction timed out in `xcrun`. A subsequent exact-fixture
native `launchctl list` identifies Safari PID 30323. The provider first parses
that default-bootstrap list, accepts only a matching UIKit application row with
a positive safe PID, and treats a clean no-match as authoritative for the sweep.
Only a failed or malformed list falls back to the legacy probes. Native candidate
MCP acceptance remains separate from this direct host observation.

For a terminated helper child, `helperPreparation.firstFailure` describes its
first completed failed SSH/SCP command; `helperPreparation.execution` describes
the child termination. Read those independently. The inherited monotonic
deadline charges child startup and imports within the existing allowance.
Protocol 10 requires this in-memory broker correction and the bounded progress
observation; it uses the existing verified replacement path. Portable tests
cannot certify actual guest SSH, helper readiness or the isolated Mac broker.

The Oct28 11:34:40 saved run passes Safari observation and reaches stop after
recording and the final screenshot. Its native inventory still reports `Booted`
despite a returned stopped record; reset was not reached. Subsequent exact-owned
standalone stop cycles through both the installed broker and the checkout's
isolated broker report native `Shutdown`. Those cycles do not reproduce or
explain the full scenario's failure. The diagnostic fixture was then deleted.
The focused iOS collector reproduces the same mismatch. The current scenario's
failure assertion selects the stop receipt's native exit facts and exact-target equality, without
raw output, arguments, environment or paths. Keep this distinct from the stored
stopped record; do not infer successful native shutdown from that record alone.

For recognized Tart images without explicit real-test SSH settings, retain the
existing product SSH defaults instead of supplying an unrelated generated host
key. Keep guest checks enabled. Explicit overrides and custom images preserve
their existing behavior; see [the real-test SSH contract](../device-lab/REQ__macos-real-test-ssh.md).
An explicit SSH authentication denial takes precedence over trailing SCP
`Connection closed` text and is not transient. A saved `closed` category alone
does not establish authentication failure. Parent child-timeout execution facts
also do not establish the final native SCP/SSH result.

The later Oct28 04:36:29 UTC focused result includes those selected diagnostics:
exact prepared, executed and returned targets match, shutdown executes with
status 0 and no timeout/error, and recording metadata is absent. Native inventory
still reports `Booted`. This establishes the need for completion confirmation,
without establishing its platform timing cause. Broker stop now waits for a
unique owned `Shutdown` within the same command allowance before publication;
the existing strict native assertion remains unchanged. Protocol 11 requires
this in-memory implementation through verified repair. See
[the shutdown contract](../device-lab/REQ__ios-broker-shutdown.md).

A focused collector invocation with `CCC_DEVICE_BROKER_PORT=17374` must first
run the same host broker preflight as the normal Level 3 launcher. The explicit
endpoint disables MCP autolaunch; building files alone does not replace an
already running broker. After the required build/assembly, run:

```sh
CCC_DEVICE_BROKER_PORT=17374 node dist/index.js devices broker status --verbose
```

Continue the selected provider scenarios only after readiness and the current
verified protocol are reported. This uses existing identity-checked replacement;
an unverified process remains a refusal. The earlier observation script targets
17373 and must not be used unchanged to diagnose this isolated endpoint.

For keyboard events leaking after an interactive client exits, use the existing
`container-command.test.ts` and `architecture/remote-services-facade.test.ts`
owners. Check normal zero-status closure as well as failure/signal cleanup, and
interpret keyboard flags separately for main and alternate screens. The shared
cleanup disables Kitty progressive flags and xterm `modifyOtherKeys` on the
active screen and after alternate-screen exit. Preserve pending input and
non-TTY bytes. Protocol-state fixtures and a private POSIX PTY do not replace a
real terminal check after Codex self-update. See
[the session exit contract](../common/REQ__session-exit-cleanup.md).

The Oct28 18:14:15 Mac run passes broker identity checks and reaches a shutdown
confirmation refusal plus two upload refusals. Read `shutdown` separately from
the native shutdown `execution`: its closed reason, attempts and last state
describe confirmation, while native status 0 describes only the command.
The broker command allowance and MCP transport timeout are separate limits;
transport duration alone does not identify the failed confirmation step.

For transfer staging, use `device-lab-transfer-file.test.ts` with its private
aliased-temporary-directory subprocess. Canonical caller paths must work while
caller links remain refused. For saved shutdown facts and plain transfer policy
codes, use `scripts/real-tests/mcp-error-output.test.ts`. Unknown plain text stays
unclassified and no native SCP failure is inferred without a receipt. These
portable checks do not replace the remaining actual Mac provider scenarios;
see [staging lifetime](../device-lab/REQ__desktop-transfer-staging-lifetime.md)
and [failure evidence](../device-lab/REQ__provider-failure-evidence.md).

For the later three-attempt iOS timeout, inspect the scenario's `afterStop`
summary before attributing cleanup's second stop to the first request. It
observes the exact created Simulator for at most a ten-second command window
before cleanup, using closed states and elapsed times. A later `Shutdown`
remains diagnostic evidence; the original stop and scenario still fail. The
existing `device-lab.real-ios-e2e.test.ts` owner checks this read-only failure
tail portably while retaining its separate native platform/level gates. This
collector-only change needs no build for the focused host iOS entrypoint.

The Oct28 10:52 UTC focused Mac result passes Simulator stop, the strict native
`Shutdown` assertion, reset and deletion. Its separate physical-device step
skips because no device is visible to `xctrace`. This accepts one positive native
run; the unchanged packaged MCP fingerprint and unused failure-only tail do not
establish the earlier failure's cause or remove the intermittent-risk limit.
Retain that evidence and move focused validation to the two remaining macOS
upload scenarios. Assemble the runtime packages and rebuild the MCP bundle to
deliver the existing MJS transfer fix, then use the host preflight and selected
collector entrypoints. No TypeScript rebuild or iOS repeat is required for that
qualification.

The Oct28 11:10 UTC two-case Mac result passes upload and fails listing with
status 1. The shared command generator previously depended on the SSH login
shell accepting unmatched glob patterns. macOS listings now select `/bin/sh`
explicitly, quoting the complete program before enforcing the final command
budget. Use the existing `device-lab-list-files.test.ts` strict outer-shell
cases and `device-lab-list-files-routing.test.ts` owner; keep native BSD size
qualification separate from portable command tests. See
[the listing contract](../device-lab/REQ__file-listing.md).
For this follow-up, rebuild the MCP bundle, run the host broker preflight and
repeat only the two Mac provider scenarios. The prior transfer assembly is
already qualified by their successful uploads; no TypeScript rebuild or iOS
repeat is needed for the listing change.

The Oct28 11:30 UTC host result qualifies the listing correction: the complete
macOS Level 2 scenario passes, and both scenarios pass upload, listing and
download. The destructive scenario proceeds to snapshot creation and receives
`broker-device-tool-backend-not-supported` (HTTP 501). Its broker advertises
snapshot create/restore/delete but omitted them from the backend allowlist.
The focused broker command owner now covers these three methods through the
actual backend child, literal confirmation before restore/delete effects and
preserved owner/provider refusals. Keep the existing global base-image refusals
and unsupported snapshot-list assertion. See
[the broker snapshot requirement](../device-lab/REQ__macos-broker-snapshots.md).

This admission correction changes the compiled broker and requires protocol 12.
Build only the device-lab workspace, assemble the runtime packages and rebuild
the MCP bundle, then run the port-17374 host preflight. Its existing verified
replacement must deliver the new in-memory handler. Repeat only
`scripts/real-tests/level3-real-destructive.ts`; retain the successful Level 2
and iOS evidence. Native snapshot acceptance remains pending that focused run.

The Oct28 23:09 UTC focused host result accepts the packaged macOS destructive
scenario: snapshot create/restore/delete, image creation, source-device cloning
and native cleanup pass. All 33 recorded MCP calls succeed; the strict snapshot
identity, Tart state/existence and final absence assertions remain in place.
The host preflight separately confirms replacement by a protocol-12 broker.
The JSON records one macOS PASS and one Android SKIP (`missing avdmanager`),
with zero failures. That skip does not describe the macOS snapshot step.

Retain this result alongside the earlier macOS Level 2 and iOS Simulator
qualification. No further provider run or rebuild is needed for this snapshot
correction. The focused packaged result does not establish source-MCP, Android,
other-platform or complete Level 3 coverage; exact per-stage timings and native
receipt values were not saved.

The Oct29 full run preserves those macOS passes but reproduces the iOS stop
failure. Exit zero is still not completion: the failure-only observer sees
`Booted`, and cleanup's subsequent successful stop does not pass the original
request. The bounded recovery now permits one reissue of the same shutdown
effect after a timely, identity-verified `Booted`. It compares the complete
expected record under the owner inventory mutation lock, whose acquisition and
native execution consume the original remaining allowance. There is no
reissue for `Shutting Down`, failed or late observations, changed records or
exhausted allowance. Native `Shutdown` and final comparison remain mandatory.

Use the existing iOS lifecycle type/HTTP owners and `mcp-error-output.test.ts`
for the finite command cap, shrinking budgets, lock contention, successor
preservation and separate sanitized retry receipt. Preserve the last valid
state when a later observation is unavailable. See
[shutdown confirmation](../device-lab/REQ__ios-broker-shutdown.md).

This change requires protocol 13, so building files alone is insufficient.
Deliver only the device-lab workspace, assembled packages and MCP bundle, then
run the verified port-17374 preflight and only the iOS collector:

```sh
npm run build --workspace @ccc/device-lab &&
npm run assemble:packages &&
npm run build:device-lab-mcp &&
CCC_DEVICE_BROKER_PORT=17374 node dist/index.js devices broker status --verbose &&
CCC_TEST_LEVEL=3 CCC_DEVICE_BROKER_PORT=17374 node scripts/real-tests/run.ts --compact --json-summary-file results/device-lab-ios-focused.json scripts/real-tests/level2-ios-e2e.ts
```

Continue only when preflight reports the current verified protocol and readiness.
Retain the already accepted macOS scenarios. Native acceptance of this bounded
recovery remains pending; portable fixtures do not prove the CoreSimulator
cause or eliminate intermittency.

The subsequent Oct29 02:25 UTC focused Mac result accepts the packaged iOS
Simulator scenario on the protocol-13 broker. Stop passes the strict native
`Shutdown` readback, followed by reset, deletion and final native/owned-list
absence. All 22 recorded MCP calls succeed. The separate physical-device step
skips because no physical iOS device is visible to `xctrace`; the Simulator
step is not skipped.

The stop response shape includes `shutdown` and `retryExecution`. The summary
stores their presence, not their values: do not infer the native retry status,
exact attempt count or per-stage timing from it. The protocol/PID/start facts
come from the user's preflight console, separately from the saved JSON. Retain
this positive run and the prior macOS passes; no further provider repeat or
rebuild is needed for this qualification. It does not establish the historical
CoreSimulator cause, eliminate intermittency or certify complete Level 3 and
physical-device coverage.

For the Oct28 GitHub Actions run `40785228840`, inspect the saved check
annotations and complete job logs before repeating the suite. The annotations
expose five fixture causes: session clocks/dispatch, iOS launchctl output, valid lease-test
input, complete stop guidance and native process identity under a fake provider
platform. Use [CI fixture isolation](GUIDE__ci-fixture-isolation.md) to preserve
the production deadlines, validation and ownership refusals while correcting
the fixtures. The shared macOS identity fixture has five importing owners;
verify those consumers after changing its import-time delegate.

The complete logs contain 114 failures per Linux job, 115 distinct failures
across both jobs. The additional groups are anonymous-descriptor metadata on
Ubuntu 26.04, modern Git's sibling-link repair, a direct provider import across
the pure MCP application boundary, and migration fixtures whose previous IDs
can equal the runner's IDs. Exercise retained-descriptor refusal controls,
target-only quarantine rollback and same-ID migration guards. Use Git 2.56 for
worktree verification; an older Git alone does not reproduce the sibling sweep.

Match the workflow's Node 24 major and check both ordinary routing and
`CCC_RUNTIME=podman` for the original failures. Keep targeted-filter omissions
separate from provider prerequisite skips. Preserve the first failing reports,
the corrected owner reports and the exact candidate identity. Local acceptance
and a newly published GitHub Actions result are separate facts.

The published `84b773c2` run `40817236916` reduces Linux failures to three per
job, four distinct tests. Check both GNU-host delegates in BSD stdin fixtures,
repeated cancellation at the final guarded release, and early native Appium
timer wake-ups. The current remote owners retain process-group cancellation,
successor refusals and exact claim release. The Appium owner retains real
stalled-header/body checks alongside its controlled 349.5/350 ms regression;
clear timer mock restorers before real timers to preserve following lock tests.
Final local qualification is 158 remote passes plus 120 Appium passes and two
existing skips. Reuse unaffected prior owner and native Mac results rather than
repeating the full suite or claiming fresh platform acceptance.
