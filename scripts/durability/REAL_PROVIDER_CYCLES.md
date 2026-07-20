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

On Windows, the real-provider launcher also runs the built
`ccc devices broker status` repair path after the source build and before the
first cycle. This replaces an incompatible in-memory broker automatically; no
separate install or broker command is required. Help and dry-run plans do not
start or repair the broker.

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
and detects current-owner AVD names created by this E2E even when CCC state
was already removed or incorrectly claims the AVD was deleted. Before a cycle,
the runner automatically recovers only records whose owner, backend, device-ID
suffix, and `ccc-<owner>-real-android-e2e-<suffix>` AVD identity all agree. It
uses the direct Android backend's force-delete path, which stops an ADB-visible
emulator even when persisted state incorrectly says `stopped`, then deletes and
verifies the AVD and state transition. State-free test AVDs are deleted only
after ADB proves they are not running. Immediate non-symlink owner artifacts
and fixed-prefix temp directories are removed last, followed by a complete
residue reinspection. Foreign, mismatched, malformed, active-orphan, or
unqueryable resources are preserved and fail closed. On Windows, SDK `.bat`
and `.cmd` launchers are executed through `cmd.exe`; Node never spawns those
batch files directly.

Missing residue metadata is normal. Existing metadata that is malformed,
unreadable, or structurally invalid is treated as corruption and fails before
provider execution instead of being interpreted as an empty state.
Large residue sets are summarized by type with bounded examples in the
terminal. The complete list is written to the single per-target/phase
`residue-*-latest.json` report under the system temporary
`ccc-device-lab-durability` directory.

The runner inherits the current environment, including existing `CCC_REAL_*`
configuration. For `android-device`, an explicitly configured serial still
wins. Before selecting a device, the runner recovers current-owner records
whose device IDs use the fixed
`android-device-real-e2e-*` prefix. Persisted devices are detached through the
normal physical Android backend. Aggregate-only leases are removed under the
hardware and aggregate mutation locks only when owner, hardware ID, device ID,
claim ID, and nonce match and no authoritative successor lock or second
aggregate entry exists. A fresh aggregate-only lease can be removed only when
its authoritative hardware lock is absent; a present lock always blocks
recovery. Broker-owned lock heartbeats do not synthesize legacy aggregate
entries. Immediate non-symlink owner artifacts and fixed-prefix temporary
outputs are removed only after state and lease reconciliation, then all residue
categories are reinspected before and after each cycle. Foreign ownership,
duplicate hardware entries, generation conflicts, malformed metadata, linked
artifacts, and active authoritative locks are preserved and fail closed.

When no serial is configured, the runner inventories ADB, excludes
emulators and non-`device` states, prefers a device already leased by the
current owner, then an unleased device, using deterministic code-unit lexical
order within each group. If every authorized device is known to be leased by
another owner, it fails before mutation. It prints the selected serial once
before the first cycle and reuses it for every cycle. When no app variables are
configured, the physical-device scenario materializes the repository's
checksum-verified, v1/v2/v3-signed fixture APK and uses its fixed package and
camera permission. A complete external APK/package/permission tuple still
overrides the fixture; a partial tuple fails before attachment. No
durability-specific environment variable is required.

iOS Simulator, physical iOS, and macOS VM repeat targets are intentionally not
exposed yet. Their existing real E2E modules run only on macOS, while this
durability runner currently has no PID-reuse-safe macOS process start token.
Exposing those targets would make descendant cleanup unverifiable. Add them
only together with a strong Darwin process identity implementation and its
reparenting/PID-reuse tests; the normal one-shot iOS/macOS Level 2 and Level 3
tests remain available meanwhile.

The Windows target checks for Windows Sandbox processes immediately before and
after every cycle. A session without matching `windows-real-sandbox-*` owner
state fails preflight and is never stopped or adopted. Runtime presence is
measured by `wsb list --raw` session GUIDs, not by lingering Sandbox client UI
processes. Interrupted test residue
may enter the provider E2E cleanup path, which validates the current host
generation and exact owner/device/GUID lock before stopping and deleting that
session. Immediate system-temp children with the fixed
`ccc-windows-sandbox-e2e-*` prefix are removed before recovery; arbitrary paths
are rejected. A successful Windows `device_delete` also synchronously removes
the canonical owner-scoped device directory before deleting its state record.
Artifact cleanup failure preserves the state record and fails the operation so
the next verified recovery can retry. Do not launch another Sandbox
concurrently with this test.

Validate command selection without creating or touching a provider:

```sh
npm run test:durability:device-lab:real -- --target android-emulator --cycles 2 --dry-run
npm run test:durability:device-lab:real:self
```

The npm scripts should invoke `scripts/durability/run.ts` as documented in
[README.md](./README.md), so source checkouts build first while installed npm
packages validate and reuse their shipped `dist/index.js`.

The original `npm run test:durability:device-lab` command remains a separate,
non-destructive isolated broker soak and never starts a provider.
