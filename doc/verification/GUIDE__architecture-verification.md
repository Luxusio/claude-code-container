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

## Migration preservation tests to remove

Do not keep archived implementations as executable reference copies. Do not require whole-file hashes, function-body equality, old-versus-new execution parity or historical getter, receiver and incidental internal-call sequences. These checks lock the implementation to the code being replaced and make legitimate changes require changes to the verifier itself.

Do not embed source snapshots, build-input hash catalogs or per-operation acceptance ledgers in package smoke. Do not build a separate VM, permission membrane or process framework for every extraction. Existing product safety tests exercise the actual native boundaries.

## Run checks in increasing cost order

1. Run changed contract/type checks and focused behavior tests.
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
