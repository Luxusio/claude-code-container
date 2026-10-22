# Saved npm test results

Run tests normally to save their output automatically:

```sh
npm test
```

Each invocation announces a unique `results/tests/<timestamp-pid-random>/`
directory before running the script tests, build and Vitest. Output still appears
in the terminal. Each run has its own directory, including concurrent and failed
runs. `results/` is already ignored by Git, and runs are retained without automatic
deletion.

## Find the latest result

Open `results/tests/latest.json` to find the most recently finished run. It
contains absolute `logFile` and `reportFile` paths and the run metadata. It is
updated atomically when a run finishes, so a run still in progress does not replace
the previous result. When concurrent runs finish, the last one to finish becomes
the latest result.

| File | Contents |
| --- | --- |
| `test.log` | Combined stdout and stderr from the script tests and the existing build-and-Vitest runner, streamed as they run. |
| `vitest.json` | Vitest's built-in JSON report: test names, assertion results, failure messages and available stacks, plus summary counts. |
| `run.json` | Start and finish times, status, current or last phase, exit code or signal, platform, architecture, Node version, forwarded arguments and available artifact paths. |

Use `test.log` for build failures, startup errors and the surrounding console
output. Use `vitest.json` to group failed assertions by shared messages or stacks.
The metadata records runtime details without dumping environment variables.

## Failed and incomplete runs

A script-test failure stops the pipeline before the build and Vitest. A build
failure stops it before Vitest. The command preserves nonzero test exit codes;
saving a failure does not turn it into a successful run.

Early failures and handled interruptions preserve the output available so far.
If Vitest has not produced its JSON report, `reportFile` is `null`; a missing
report does not mean tests passed. Read the status and phase in `run.json` before
interpreting the artifacts.

A process crash, `SIGKILL` or machine shutdown can leave `run.json` marked as
running and leave `latest.json` pointing at an older run. In that case, inspect
the announced run directory and its partial `test.log` directly. Artifacts cannot
reconstruct output from runs made before this capture was enabled.

## Focused verification

Pass a test path or other Vitest filter through `npm test`:

```sh
npm test -- src/__tests__/architecture/worktree-addition-facade.test.ts
npm test -- src/__tests__/architecture/worktree-addition-facade.test.ts -t 'multi records'
```

These commands still run the script-test prelude and the existing build step,
then save the focused Vitest result. Use the existing `CCC_E2E_SKIP_BUILD=1`
option only when the required build artifacts are already current.

The managed entry point reserves Vitest `--reporter` and `--outputFile` options
so its console and JSON reports remain available. For custom reporters or output
locations, use the existing runner directly:

```sh
node scripts/run-vitest.mjs run src/__tests__/architecture/worktree-addition-facade.test.ts --reporter=verbose
```

`npm run test:watch` also keeps its existing behavior. Direct runner and watch
invocations do not create these managed result directories.

## Platform evidence

Read `platform` and `arch` in the run metadata before interpreting failures or
passes. Run Mac-only validation on the Mac host with `npm test -- <test path>`
and retain that host's result directory. Linux or container results do not
certify Mac-only behavior. A skipped test is not evidence that its native
behavior passed. Compare host and container evidence using their recorded
platform, arguments, status and artifacts.
