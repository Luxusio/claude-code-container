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
