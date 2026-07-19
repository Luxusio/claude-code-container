# Real provider durability cycles

> **Warning:** This runner executes destructive or physical-provider E2E tests.
> It creates and deletes disposable emulators or sandboxes. The physical Android
> target changes device state and may install, launch, reset, and uninstall the
> APK configured through the existing `CCC_REAL_*` variables.

Only one real-provider suite may run at a time for a host user. `test:level3`
and `test:durability:device-lab:real` share a lock under
`~/.ccc/devices/test-runs`. A second run fails immediately with the PID and
start time of the active run. This prevents two suites from attaching the same
physical device, claiming the Windows Sandbox singleton, or reusing Android
emulator ports concurrently.

Run one target repeatedly with:

```sh
npm run test:durability:device-lab:real -- --target android-emulator --cycles 10
npm run test:durability:device-lab:real -- --target android-device --cycles 10
npm run test:durability:device-lab:real -- --target windows-sandbox --cycles 10
```

Use `--timeout 30m` to change the per-cycle deadline. Each cycle launches the
existing Level 2 real-test module in a fresh Node process with `--fail-on-skip`.
The runner fails on a timeout, skip, nonzero exit, or any
test-owned owner state, lease, lock, or temporary artifact. These checks run
before cycle 1, before every later cycle, and after every cycle including a
failed cycle;
stale prior-run residue is never accepted as a baseline. It prints one timing
line per successful cycle.

During a cycle, the runner retains identity-verified descendants using a
PID/start-token pair. It samples at a short interval, on process output, and
repeatedly across the successful process-exit boundary so a sampled child that
quickly reparents remains attributable to the cycle. A successful provider
test still fails if any tracked process is alive afterward or if process-tree
verification is unavailable. The success path reports these processes but
does not signal them; unverified processes are never killed.

On timeout, nonzero exit, or child-process error, the runner terminates and
verifies the identity-tracked process tree. Cleanup command failures, surviving
PID/start-token pairs, post-failure state/lease/temp residue, and Windows
Sandbox sessions are accumulated into the same cycle failure. Linux and
Windows provide the strong process start tokens used for this check. An
unsupported platform fails closed before spawning the provider runner rather
than signaling an uncertain PID.

For `android-emulator`, residue inspection also executes `avdmanager list avd -c`
and rejects current-owner AVD names created by this E2E even when CCC state
was already removed or incorrectly claims the AVD was deleted.

Missing residue metadata is normal. Existing metadata that is malformed,
unreadable, or structurally invalid is treated as corruption and fails before
provider execution instead of being interpreted as an empty state.

The runner inherits the current environment unchanged, including existing
`CCC_REAL_*` configuration. In particular, `android-device` still requires the
same physical-device serial and optional APK variables as the normal real test.
No durability-specific environment variable is required.

iOS Simulator, physical iOS, and macOS VM repeat targets are intentionally not
exposed yet. Their existing real E2E modules run only on macOS, while this
durability runner currently has no PID-reuse-safe macOS process start token.
Exposing those targets would make descendant cleanup unverifiable. Add them
only together with a strong Darwin process identity implementation and its
reparenting/PID-reuse tests; the normal one-shot iOS/macOS Level 2 and Level 3
tests remain available meanwhile.

The Windows target checks for Windows Sandbox processes immediately before and
after every cycle and fails if any are present. This detects stale, leaked, and
concurrently introduced sessions without stopping or adopting them, and
prevents the existing recovery path from stopping a Sandbox session that the
durability run does not own. Do not launch another Sandbox concurrently with
this test.

Validate command selection without creating or touching a provider:

```sh
npm run test:durability:device-lab:real -- --target android-emulator --cycles 2 --dry-run
npm run test:durability:device-lab:real:self
```

The npm scripts should invoke `scripts/durability/run.mjs` as documented in
[README.md](./README.md), so source checkouts build first while installed npm
packages validate and reuse their shipped `dist/index.js`.

The original `npm run test:durability:device-lab` command remains a separate,
non-destructive isolated broker soak and never starts a provider.
