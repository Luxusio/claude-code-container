# Diagnose test failures by shared cause

Use the saved `vitest.json` and `test.log` described in [test results](GUIDE__test-results.md). Count failed assertions and failed files separately: Vitest's JSON suite counters also include nested suites. During local diagnosis, retain the original report and per-run metadata and run focused verification directly through Vitest to leave the latest pointer untouched. The later host acceptance commands below intentionally publish a new latest pointer; the original run directory and its metadata remain available.

## Temporary paths and child environments

The root unit configuration canonicalizes the existing temporary-directory base before fixture modules load. On macOS, `/var` and `/tmp` are system aliases; using their lexical spelling can cause private-path and Git ownership checks to reject a fixture before its intended behavior executes. Normalize the fixture base, then deliberately create any linked files or ancestors inside that owned root. Keep production symlink and ownership rejection intact.

MCP stdio transport inherits only a finite environment. The fixture's home environment must explicitly provide `TMPDIR`, `TMP` and `TEMP` pointing to a created, canonical private directory beneath its owned home. Setting only the parent Vitest environment does not cover generated child programs. Close owned runtimes before removing their temporary roots.

Representative owners are `test-temp-root`, `helpers/device-lab-test-environment`, `device-lab-file-policy`, `worktree`, Hyper-V image preparation and the MCP transfer/recording fixtures. Use a private symlinked temp base to reproduce the mechanism on Linux; this portable check does not replace native Mac acceptance.

## Invocation, native tools and platform fixtures

An ESM main-entry guard must compare the actual invoked file with its own module. Canonical unit temp roots must not hide this source behavior: retain explicit symlink invocation and import-only regressions in the installer and installed MCP diagnostic owners.

Native process observations must use the admitted system executable and exact captured PID, command and start token. A private provider PATH must not make Darwin `ps` or `lsof` disappear. Fixtures that prohibit arbitrary commands may admit narrowly matched observations of their own PID; they must continue rejecting other process commands.

Generated Ubuntu container programs require their actual GNU prerequisites. Guard only cases executing those Linux-specific branches. Keep portable filesystem, layout and diagnostic assertions active on macOS. Other native fixtures must select their tested host platform explicitly, use an available interpreter with the required standard library, and arrange the expected runtime authority and mounted credentials. A missing native prerequisite is an explicit skip or error, never a successful assertion.

Keep fixture bookkeeping outside directories whose metadata the test observes. Create a private control directory before taking ownership snapshots, then write logs and loader configuration within it. On Darwin, creating a file can change the observed directory link count; fixture logging must not simulate an unauthorized source-tree replacement.

The Codex bootstrap fixtures require Python 3.11 or later with `tomllib`. Set `CCC_TEST_PYTHON` to a suitable executable when automatic discovery cannot find it. Missing default prerequisites produce an explicit narrow skip; an explicitly configured unsuitable interpreter is an error. This selects a host test prerequisite and does not change the container's fixed Python contract.

## Current contracts and deterministic observations

Mock the adapter exports currently called by the server. Old facade exports do not intercept lexical calls inside the extracted adapter. Preserve current lock self-contention, deadline, catalog-validation and incomplete-history contracts when updating fixtures. An unknown observation authorizes no mutation.

Fake provider fixtures must model their owned process inventory for both synchronous and Worker subprocess paths. Route only the exact inventory command into the fixture; keep PID, birth and command observations native. An unrelated host process listing must not decide a fake-provider result, and truncated or failed inventory must remain a product refusal.

After an authenticated signal, join a fixture's saved process incarnation through the existing bounded native exit observer. An exiting Darwin process can have a changed displayed command; keep full identity and marker/journal/root validation before every signal, and accept removal only from positive exit evidence. Diagnostic exit messages alone do not prove completion.

Fake-timer drivers must allow real asynchronous native observations to complete and continue advancing timers scheduled afterward, within a separate bounded real-time wait. A single `runAllTimersAsync` is insufficient when native `ps` finishes later. For terminal attributes, follow the narrowly defined Darwin kernel-state distinction in [session exit cleanup](../common/REQ__session-exit-cleanup.md#interactive-terminal-restoration); preserve every configured attribute and raw diagnostics without reading or flushing terminal input.

Do not assume a fixed localhost port is closed. Unit refusal cases inject their owned socket error; native forwarding cases keep a private bound, non-listening allocation until all dials finish. Keep the negative native check separate from the unit error-forwarding assertion.

The failed-dial holder must use socket observations supported by the tested host. Its controlled program can report the completed bind phase and portable socket type while retaining the same descriptor, address and nonce through close. Verify the actual failure while that allocation is held: Linux refuses the dial, while Darwin drops a SYN to the bound, closed socket and reaches the existing connection timeout. Keep the unit assertion for forwarding `ECONNREFUSED`; do not claim that the Darwin native fixture produces it. A test covering two native timeout attempts needs a test duration longer than their existing combined limit, without changing either product timeout.

Use the [descriptor root requirements](../remote/REQ__descriptor-root-portability.md) for remote lifecycle and bind tests. macOS directory descriptors are not Linux `/proc` namespaces; a portable implementation must retain each admitted root and its cleanup ownership.

Account for added native observations in a metadata fixture's bounded child-process allowance. An instrumented stat shim can invoke the native utility twice for each descriptor request; keep that test allowance separate from product deadlines and the test runner's limit. When a synchronous child returns no exit status, include its error code and signal with stderr in the assertion diagnostic. A null status and elapsed time near the limit suggest a timeout but do not directly record its cause.

Do not assume that reopening `/dev/fd/N` read-only removes write capability on Darwin: descriptor duplication can retain the original file description. A refusal-write fault fixture must fail the exact intended write while retaining native descriptor metadata, and prove that the injected fault was reached. Keep unavailable-observation and unavailable-write cases distinct. For a native cancellation refusal whose saved log lacks its precise cause, add only nonsecret stage/status diagnostics to the generated test shell; preserve every original result and ownership decision until actual host evidence identifies the failing observation.

Cancellation diagnostics must distinguish the existing supervisor callback category and the exact capture check before TERM, after TERM before CONT, or after child observation. Command lengths and comparison categories can distinguish changed observations without printing command text, identity values, tokens or paths. Forward the same arguments and status through those fixture wrappers; do not add native probes or treat a later absent process as proof that an earlier identity mismatch was harmless.

When an authenticated broker fixture reports only an unverified generation, retain the fresh per-request checks and capture bounded observations in that fixture's private home. A trace may record the exact owned-port listener probe, its selected process probes and parsed public status-generation comparisons. Forward every original result or exception unchanged; do not add requests, retries, body reads or allowances. Report only phase, native status, comparison booleans and output byte counts on assertion failure, excluding credentials, command text, native identity values and paths. The trace must be scoped to the allocated port and its observed PIDs and must not replace the actual packaged broker or its verifier.

## Focused evidence and host follow-up

Run changed owners or original failing-name filters through the root Vitest configuration. Do not run `test:level3` to verify a fixture or a pure broker observation change. Distribution tests must use the changed source's minimal private emit or bundle; a stale shared `dist` tree is not evidence for a source correction.

An analysis inventory such as ignored `results/tests/failure-analysis-<date>.json` maps original assertions to common causes. Candidate classifications are not a post-fix result. Keep unresolved process-group errors, lifetime identity changes and PTY differences visible until the corresponding host run supplies evidence. Record exact focused commands and the tested commit alongside the new output.

For host acceptance after local diagnosis, run the fixture base and invocation regressions without a broad build:

```sh
CCC_E2E_SKIP_BUILD=1 npm test -- \
  src/__tests__/test-temp-root.test.ts \
  src/__tests__/helpers/device-lab-test-environment.test.ts \
  src/__tests__/device-lab-file-policy.test.ts \
  src/__tests__/install-global.test.ts \
  src/__tests__/installed-mcp-diagnostic.test.ts --maxWorkers=2
```

Qualify receiving-host lifecycle and bind authority on the host being tested:

```sh
CCC_E2E_SKIP_BUILD=1 npm test -- \
  src/__tests__/architecture/remote-shell-native.test.ts \
  src/__tests__/remote-lifecycle-lock.integration.test.ts \
  src/__tests__/remote-bind-authority.integration.test.ts \
  src/__tests__/remote-cache-identity.integration.test.ts --maxWorkers=2
```

Collect unresolved Mac lifetime, process-group and terminal evidence separately:

```sh
CCC_E2E_SKIP_BUILD=1 npm test -- \
  src/__tests__/fake-ios-fixture-lifetime.test.ts \
  src/__tests__/device-lab-broker.process-tree.test.ts \
  src/__tests__/container-command.test.ts \
  src/__tests__/device-lab-ios-wait-for-app.test.ts --maxWorkers=2
```

These commands retain the small Node prelude and save a new per-run log and JSON report. They do not execute the full Vitest suite or the Level 3 provider suite. Some distribution owners consume previously built artifacts; use the current source bundle cases for invocation checks, or build only the required artifact when verifying its installed form. For a Linux container sharing Mac `node_modules`, use an isolated matching Linux native executable/binding through `ESBUILD_BINARY_PATH` and `NODE_PATH`; do not overwrite the host dependency tree. These machine-specific paths are verification environment inputs, not repository defaults.

## Known ceiling

Portable Linux evidence does not certify Darwin descriptor operations, native process proof, PTY restoration or process cleanup. The original Mac failure inventory remains pending post-fix host evidence; see the [change evidence limits](../changes/2026-10-22-test-failure-groups.md#known-ceiling).
