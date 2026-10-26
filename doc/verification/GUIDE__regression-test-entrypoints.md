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

Tart boot failures can be nested at `result.execution.command.macosBoot`.
Artifacts now distinguish that IP-readiness phase from the start process's
execution status. An IP timeout category is emitted only from the renderer's
known timeout result. A generic HTTP 502 or elapsed duration alone does not
establish a boot timeout. The internal Appium missing-device check also saves
unexpected broker errors before assertion-message truncation.

MCP process-verification refusals can retain the closed native observation
stage, reason and completion facts. Failed or interrupted native output remains
unverified; a successful empty command still needs the existing PID/birth/status
continuity proof. Keep the same time limits and ownership fences. See
[the failure evidence contract](../device-lab/REQ__provider-failure-evidence.md).
Portable diagnostic tests do not establish the original Mac failure's cause.

## Native UID regression

The private-config case in `src/__tests__/codex-harness.test.ts` is opt-in through a nonempty `CCC_TEST_HARNESS_IMAGE`. It requires a POSIX host with UID/GID APIs and an image containing the named `ccc` account and runtime tools required by the existing bootstrap. With no image, or without that host capability, it skips before invoking Docker. An explicitly supplied but unavailable image fails with a diagnostic.

Run the case deliberately with an already available suitable image:

```sh
CCC_TEST_HARNESS_IMAGE='your-existing-test-image' npm test -- src/__tests__/codex-harness.test.ts -t 'reads private config when the default UID differs'
```

The fixture creates a uniquely named, network-disabled container. After successful creation, only its validated captured container ID authorizes exec and cleanup. A failed or uncertain creation does not authorize removal by a guessed name. If the host default UID equals the image's named `ccc` UID, this image cannot exercise the split and the case reports a skip while cleaning its confirmed container. Review an uncertain creation using the reported unique fixture name; no automatic name-based deletion is attempted.

## Evidence limits

Test existence, ordinary collection, portable execution and native acceptance are different claims. The portable Node fixtures do not prove real NTFS operations. An unrun or skipped UID case does not prove actual Docker ownership migration. macOS Slack clipboard and actual macOS sudo recovery need their native platform evidence; the exact missing-`pngjs` → restore-dependencies → successful-build sequence remains separately unverified. These entry points do not certify every historical failure or the whole architecture migration.
