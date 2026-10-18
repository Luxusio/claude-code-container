# Architecture verification

Test the current product contract. Architecture changes may replace implementation details while maintaining behavior users need.

## Tests to keep

- Application and domain tests with explicit expected results and ordinary fake ports, including meaningful failures and partial effects.
- Type checks for required capabilities and synchronous or asynchronous contracts.
- Import-boundary checks that prevent inward layers from depending on native adapters, SDKs or framework entry points.
- Public CLI and MCP tests for request validation, responses and actual routing.
- Native regressions for ownership, successors, file boundaries, process identity, cleanup and resource release.
- Package smoke using actual shipped output and real provider E2E when the host and device are available.

Order matters when it enforces a current requirement, such as validating ownership before signaling a process. Test that requirement directly.

The inward dependency check distinguishes data helpers and type annotations from ambient authority. It permits direct `Date.parse`, pure Math members, unaliased named path imports used only as `join(...)` or `win32.normalize(...)`, direct `Buffer.byteLength(...)`, and `Buffer` type references. These operations do not acquire native resources. Path resolution remains a required native capability because relative inputs can consult the process working directory. Namespace imports, exposed path helper aliases, other path/Buffer runtime operations, clocks and native I/O remain outside inward layers.

## Migration preservation tests to remove

Do not keep archived implementations as executable reference copies. Do not require whole-file hashes, function-body equality, old-versus-new execution parity or historical getter, receiver and incidental internal-call sequences. These checks lock the implementation to the code being replaced and make legitimate changes require changes to the verifier itself.

Do not embed source snapshots, build-input hash catalogs or per-operation acceptance ledgers in package smoke. Do not build a separate VM, permission membrane or process framework for every extraction. Existing product safety tests exercise the actual native boundaries.

Keep packaging verification as a small standalone smoke command. Do not add verifier-specific unit suites, fake package/server frameworks, or tests of the verifier's own rejection and evidence machinery. Exercise the actual generated payloads instead.

## Run checks in increasing cost order

1. Check the complete current inward repository graph, collecting all findings before asserting, then run changed contract/type checks and focused behavior tests.
2. Run affected architecture and native regressions.
3. Build once when production code, dependencies or build configuration changed.
4. Run package smoke against current output.
5. Run broader regressions for an integration batch and real-host checks where needed.

Test-only changes do not require rebuilding unchanged production output. After a failure, fix the cause and rerun affected checks. Repeat broader checks when their inputs or the failure warrant it.

## Package smoke

```sh
npm run test:packages
```

The checker examines the extracted npm package and the locally materialized Unix installation payload. It verifies shipped entry points and assets, CLI help/version, and MCP initialization, tool listing and ping. It uses temporary directories and joins the children it starts. It does not install globally or start device providers.

The checker has no migration preflight or operation-coverage ledger. Package smoke proves packaging and startup; application tests and provider E2E prove their respective behavior. Report unavailable hosts and unrun checks honestly.

Use local verification. CI, pushing and global installation are separate actions requiring user authorization.

## Installed Linux broker reliability

After authenticating an existing installed payload, set `installed_root` to that payload and invoke its runner directly with the qualified Node executable:

```sh
node "$installed_root/scripts/durability/device-lab.mjs" --iterations 40 --concurrency 8 --restart-every 10 --timeout 3s --rss-sample-every 5 --max-rss-growth 128MiB --max-survivors 0
```

Use a clean environment, private HOME/TMPDIR and the existing loopback/provider fence; the runner creates its own broker home and ephemeral loopback port. Observe and join only its own PID/start identities. Do not rebuild, fall back to Source, reuse a host broker or install globally. The 128MiB value limits observed RSS growth per broker generation in this test; it is not a runtime/container memory default.

Independent installed-Linux QA passed on 2026-10-15: 40 rounds, 323 counted requests, three authenticated restart recoveries across four broker generations, reported maximum RSS growth 3.9MiB and zero observed owned survivors. The runner reported 878ms elapsed; this is a bounded restart check, not a long soak or exhaustive process-monitoring proof. Execution inputs remained unchanged. [Local raw evidence](../../results/linux-broker-reliability-01a13e56-20261015/independent-qa/inventory.json) records commands, output and process observations. `ACC-M14-reliability`, native-platform and whole-source acceptance remain unverified.

Current installed-cohort requalification passed on 2026-10-18 after the reached shared-lock and process-identity inputs changed. One unchanged runner invocation exited 0: 40 rounds, 323 requests, three authenticated restart recoveries across four broker generations, 5748ms runner elapsed, slowest request 128ms, reported maximum RSS growth 3.7MiB and zero observed survivors. All 13 observed PID/start identities were absent after verification; the owned broker home was removed. The complete 1,219-file installed payload, 1,058 dist files, 635 producer inputs and prior evidence remained unchanged. [Current local evidence](../../results/linux-broker-reliability-current-01a13e56-20261018/qa/qa-final-facts.json) retains the exact command, private environment and observations. The earlier result remains historical; these metrics establish only bounded current Linux restart/authentication/RSS/cleanup behavior. Broader M14, native and whole-source acceptance remain unverified.

## Existing product invariant checks

Use separate private current-source copies to remove one critical product check at a time and exercise the existing regression assertion. First require a passing normal baseline with exact selected-case counts; then attribute each expected failure to the removed check. Import/setup errors, empty selection, timeouts and crashes do not establish detection. Restore private bytes and join owned children afterward. Keep caches and outputs private; reuse unchanged qualified inputs and existing product tests.

Independent Linux QA passed on 2026-10-15: four normal cases passed, then three private single-check removals produced four expected assertion failures—delete disk identity (two), compensation stopping after VM removal failure (one), and shared-lock archived-owner admission (one). All six invocations ran once, in two parallel phases; each failure matched its existing product assertion. The three private files were restored, execution inputs stayed unchanged, and all 18 observed owned process identities disappeared. [Local raw evidence](../../results/m14-invariant-detection-01a13e7a-20261015/independent-qa/inventory.json) retains commands, outputs, attribution and cleanup. This finite result leaves broader model/fault/native acceptance and `ACC-M14-reliability` unverified.
