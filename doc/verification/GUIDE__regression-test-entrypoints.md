# Regression test entry points

`npm test` first runs the explicit Node regression files listed in `package.json` through `npm run test:scripts`, then runs the existing build-and-Vitest entry point. The Node files cover release manifest/pin synchronization, Windows LX workspace-link repair (including the build recipe module closure), and test-result capture and orchestration. They use private files and simulated native commands; they do not contact a real container engine. A Node test failure stops the command before Vitest and returns nonzero.

`npm test -- <Vitest filter or options>` retains those arguments for Vitest. The small Node prelude always runs, including filtered invocations. `npm run test:scripts` runs only that prelude without a build. Explicit filenames avoid shell-glob differences on Windows. Add a new Node owner to this command when intentionally adding one to the default suite.

`npm run test:watch`, direct Vitest, and the specialized `npm run test:level0` remain separate entry points. They do not gain the Node prelude. The Level 0 installed-package fallback and real-provider levels are unchanged.

## Level 3 broker preflight failures

`npm run test:level3` builds its artifacts, then verifies the host broker before starting provider tests. A failed preflight prints both stdout and stderr from the broker status command, followed by its exit status, signal, spawn error, and configured timeout. `error=none` means the child had no spawn error; `timeoutMs=180000` states the limit and does not mean a timeout occurred.

`host-broker-incompatible` with an unverified port owner can occur even when the broker protocol is compatible. Compare the host's `~/.ccc/devices/broker/runtime.json` process metadata, the actual listening PID and command, the broker's read-only HTTP `/status`, and the current checkout's broker entry paths. A broker from a global installation or another checkout can fail the exact entry-path check. Do not delete metadata or kill an unverified listener to bypass this failure. `ccc devices broker status --verbose` may automatically repair a verified broker; it is not a read-only probe.

On macOS, collect listener and process evidence on the Mac with `/usr/sbin/lsof -nP -iTCP:<port> -sTCP:LISTEN -Fp`, `/bin/ps -ww -p <pid> -o command=`, and `/bin/ps -p <pid> -o lstart=`. Read only the runtime's name, managedBy, PID, port, command, args, cwd and process start metadata; owner authentication files are unnecessary. Container PID observations and mocked launcher regressions do not validate native Mac ownership. The portable launcher tests are in `scripts/real-tests/hyper-v.test.ts`; running that file through the regular Vitest config does not run the Level 3 provider suite.

## Native UID regression

The private-config case in `src/__tests__/codex-harness.test.ts` is opt-in through a nonempty `CCC_TEST_HARNESS_IMAGE`. It requires a POSIX host with UID/GID APIs and an image containing the named `ccc` account and runtime tools required by the existing bootstrap. With no image, or without that host capability, it skips before invoking Docker. An explicitly supplied but unavailable image fails with a diagnostic.

Run the case deliberately with an already available suitable image:

```sh
CCC_TEST_HARNESS_IMAGE='your-existing-test-image' npm test -- src/__tests__/codex-harness.test.ts -t 'reads private config when the default UID differs'
```

The fixture creates a uniquely named, network-disabled container. After successful creation, only its validated captured container ID authorizes exec and cleanup. A failed or uncertain creation does not authorize removal by a guessed name. If the host default UID equals the image's named `ccc` UID, this image cannot exercise the split and the case reports a skip while cleaning its confirmed container. Review an uncertain creation using the reported unique fixture name; no automatic name-based deletion is attempted.

## Evidence limits

Test existence, ordinary collection, portable execution and native acceptance are different claims. The portable Node fixtures do not prove real NTFS operations. An unrun or skipped UID case does not prove actual Docker ownership migration. macOS Slack clipboard and actual macOS sudo recovery need their native platform evidence; the exact missing-`pngjs` → restore-dependencies → successful-build sequence remains separately unverified. These entry points do not certify every historical failure or the whole architecture migration.
