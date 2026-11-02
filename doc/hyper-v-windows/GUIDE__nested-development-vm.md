# Persistent nested Hyper-V development

Use a dedicated Windows L1 VM to build the changed checkout and run a fresh
broker and packaged MCP against inner L2 guests. The physical host only needs
nesting support to create L1; candidate provider tests run inside L1. The Windows
runner also rebuilds its local host CLI/MCP for safe preflight. A runner in a
container reuses the already updated physical host broker.

## One-time requirements

During a run, the CLI prints each stage and a waiting message every 30 seconds
while an asynchronous step is pending. Guest bootstrap/install/build/test/cleanup
stages come from a run-identified progress record; the display is the last observed
stage, not proof the guest is currently advancing. Raw job logs remain in the
per-run artifacts. A process already running older code will not gain this output
until its next launch; do not restart an active guest job just to enable it.

- Update the physical host CCC so its broker advertises
  the same `protocolVersion` as the checkout. The Windows runner builds and safely refreshes it before VM creation.
- The host must support nested Hyper-V. Microsoft documents CPU, host OS and VM
  configuration requirements in [Enable nested virtualization](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/enable-nested-virtualization).
- Reserve 16 GiB RAM and four vCPUs for L1. Disk checks are stage-specific, not
  a fixed 80/40 GiB entry requirement. Windows image download needs the validated
  download length plus 10 GiB free; VM cloning needs the actual base file length
  plus 10 GiB free after the base is present. A fresh Windows run therefore holds
  both the base and its full copy, plus build files and reserve. Cached images
  avoid another download. A dynamic VHDX's virtual maximum is not its current
  file allocation. Linux image conversion retains its separate workspace check.
  `CCC_NESTED_SOURCE_IMAGE` can supply a generalized VHDX. The runner does not
  resize a disk or guarantee that every image fits a 64 GiB development VM.
- Accept Windows evaluation licensing through the existing host setup flow if
  using the automatic evaluation image. The runner never accepts licensing for
  you. An existing valid acceptance receipt in the invoking host account is
  copied into the guest's SYSTEM account for the inner Windows test. From a
  container, set `CCC_NESTED_LICENSE_RECEIPT` to an accessible copy of that
  already accepted JSON receipt. Without it, prepare that guest account's receipt
  beforehand; absence fails the test, rather than inventing acceptance.
- The optional Linux scenario needs the existing trusted Android SDK Emulator
  `qemu-img.exe` installation in the guest SYSTEM account's local app-data
  directory, or a pre-prepared managed Ubuntu base image. See the existing
  `devices setup hyper-v` readiness diagnostics. No new arbitrary QEMU binary is
  downloaded by this workflow.
- Run from the source checkout with dependencies installed. `git`, `tar`, and a
  Windows x64 distribution of the invoking Node version must be available. The
  guest downloads Node over HTTPS and checks its published SHA-256; outbound
  access to Node, npm and provider image sources is required.

## Repeat after source changes

```sh
npm run test:hyper-v:nested
# Optional inner Linux guest scenario:
npm run test:hyper-v:nested -- linux
```

The runner creates or reuses the owner-scoped `windows-nested-development`
device, using `create_windows_vm` with `profile:"windows-server"` and
`nestedVirtualization:true`. L1 uses the Windows Server base selected by the
automatic image flow; any `CCC_NESTED_SOURCE_IMAGE` override must also be a
compatible generalized Windows Server image. Processor extensions are configured while the new VM is off, before first boot. It starts
L1, enables its Hyper-V feature, and reboots once if feature installation needs
it. That reboot explicitly uses `force:true` on this dedicated development VM to
suppress the unattended `Restart-VM` confirmation prompt. `Restart-VM` performs
a hard reset with or without `Force`; this does not change reboot defaults for
other devices. The guest claim remains held across this feature-install reboot.
The guest uses `172.30.0.0/24`; the outer host keeps `172.29.0.0/24`. Do not
change that profile on a guest which already owns a different managed network.

Each iteration snapshots tracked working-tree edits plus new non-ignored source
files. Dependencies, generated output, common credential files and agent state
are excluded; symbolic links are refused. Uploads use project-relative artifacts
under `results/nested-hyper-v`, so the existing broker path mapping still applies.

A bounded scheduled task runs as SYSTEM inside the dedicated L1. It installs
dependencies, builds the snapshot and launches its own freshly built broker on
loopback. The inner test verifies that broker's PID before running the packaged
MCP E2E. An occupied port fails instead of reusing another installation. Skipped
inner scenarios count as failure. Only the broker child belonging to that run
is stopped afterward.

`result.json` and `job.log` are downloaded to the local per-run result directory.
Failures preserve their guest checkout and stage diagnostics until the next
explicit iteration. The stable guest checkout path retains broker owner identity
across source changes. Successful runs
remove their guest source contents/archive, keeping the checkout directory and
ownership marker, L1, image cache and logs for reuse. Keeping the directory avoids
failure when a lingering process still holds its working directory open. Cleanup
does not stop those processes or adopt an unmarked directory. A failed cleanup
preserves the marker so a later iteration can retry safely.
The three npm workspace links under `node_modules/@ccc` are recognized only when
`hyper-v`, `device-lab` and `device-lab-mcp` point respectively to the ordinary
checkout directories `packages/hyper-v`, `packages/device-lab` and `device-lab-mcp`.
Cleanup validates the complete tree before mutation, removes these links without
following their targets and checks the remaining tree again. Other links fail
closed. Targeted Windows PowerShell cleanup fixtures verify this boundary; they
do not establish a complete nested-run pass or alter a saved failed result.
The fixed memory configuration and existing incarnation checks are retained.

## Interrupted runs

An atomic `C:\ccc-nested-development\active` directory claim prevents overlapping
iterations. The scheduled task has a four-hour deadline. If the connection drops
or launch outcome is uncertain, the claim is preserved. In L1, inspect the
`CCC Nested Hyper-V Development` scheduled task and its per-run logs. Only after
confirming the job has ended and no runner still owns it, inspect and remove its
matching `active\claim.json`, then remove the empty `active` directory and retry.
Legacy claims without a marker still require this explicit recovery; do not
remove unknown files recursively.
Completed runs stop L1 without deleting it, returning its 16 GiB RAM to the host.
The runner marks its guest claim completed before stopping the exact VM incarnation;
the next boot reclaims that completed claim. Completion is checked against both
run ID and source hash. A stop failure makes the runner fail even after guest PASS.
Once completion is confirmed, an artifact-save or log-download failure also
triggers shutdown; the collection failure remains reported and guest files are kept.
Failures before job launch also stop L1 after the runner acquired its claim.
Unknown launch outcomes, incomplete results and timeouts retain the running VM
and claim for inspection. After such an interruption, confirm the job has ended
before manually recovering the claim. No unrelated device is stopped or deleted.

The retained L1 uses 16 GiB while running. A separate host Level 3 Windows VM
also needs its configured memory plus the host reserve (the larger of 2 GiB or
10% of physical RAM). Admission uses available memory at VM start, not a later
Task Manager reading. A host memory refusal remains a failed test, with a concise
free-memory action; it does not trigger unrelated guest console or disk-mount
diagnostics. No other VM is automatically stopped to make space.

Android E2E status checks use the public device identity and running state;
removed broker routing metadata is not required. One status observation suffices
before control operations; those operations and fixture cleanup remain tested.

A host-side `real-provider-test-lock-unavailable` failure occurs before VM setup.
It reports that exclusivity could not be established within the admission
allowance and suggests checking other real-provider runs before retrying.
`failure.json` preserves the diagnostic code; the older
`real-provider-test-already-running` code is also recognized. Neither diagnostic
proves another run is alive or authorizes deleting its lock or stopping a process.

## Verification boundary

Automated tests exercise source updates, exclusions, command validation, feature
reboot/reuse, failure propagation, timeout claims, and separate inner addressing.
The PowerShell job is included in the Windows parser check. These simulated
orchestration tests are not native nested-Hyper-V evidence. On 2026-09-30 the
physical host's shared-protocol broker created L1 with nested virtualization;
guest feature installation and unattended reboot were verified, followed by
`HypervisorPresent=true` and `vmms` running. On 2026-10-01 the saved
`results/nested-hyper-v/da35c6c790a2ac74/job.log` records the native packaged
Windows VM E2E passing inside L1, with one pass and no skips or failures. This
establishes inner VM creation, boot and tested operations, including image fit
for that configuration. Its `result.json` still records overall `FAIL` at
`cleanup` with `nested-checkout-reparse-point`; the inner E2E pass does not
establish a successful complete runner. Windows PowerShell 5.1 cleanup fixtures
separately verify the repaired workspace-link handling, including actual npm
junctions and failure preservation. A fresh complete nested run is still needed
to establish terminal `PASS` for the runner. Other guest profiles and image
capacities are not established by these checks.

For a quick cleanup regression on Windows, run
`npx vitest run src/__tests__/nested-hyper-v-checkout.test.ts`. It executes the
production cleanup helper in temporary fixtures without booting a VM. Missing
PowerShell skips the suite; missing symbolic-link privilege skips only the file
symlink fixture. Skips do not establish native coverage for those cases.

### Broker compatibility

`test:hyper-v:nested` on Windows builds the local host CLI and MCP, then prepares the broker using the normal identity-checked repair path. Matching `protocolVersion` is the only compatibility requirement; package release numbers and feature patch lists are not additional gates. The runner stops before VM creation if preflight fails. Run `node dist/index.js devices broker status` on that physical host to see the concrete repair action. It never kills an unverified port owner or downgrades a newer protocol.

Nested failures print the stage, tool, error code, and exact local `failure.json`
path under `results/nested-hyper-v/<run>/`. This artifact is written even when
creation or startup fails before a guest job exists. It retains bounded provider
codes, exit status, and scrubbed diagnostic text; it excludes request arguments,
commands, stdout, authentication, and credential fields. Cleanup failures are
recorded separately while the original operation remains the primary failure.
If saving fails, the message says so instead of naming a nonexistent log.

For `start-outer-vm/start: hyper-v-guest-not-ready`, inspect the readiness entries
in `failure.json`, not only the host command's exit status: `status: 0` can mean
Start-VM succeeded while PowerShell Direct failed. Diagnostic entries identify
their source path and retain bounded probe facts when the broker supplies them.
A same-protocol broker can remain loaded after a rebuild; verify its PID with
`node dist/index.js devices broker status --verbose` and restart that verified
CCC broker process when testing host-side changes. Do not delete the VM or bypass
PowerShell asset integrity checks to recover a guest-readiness failure.

Completed guest jobs also keep `result.json` and `job.log` in that per-run
directory. Preflight failures occur before any guest job exists and additionally
save `preflight.log` when diagnostics are available.

If source staging fails with `nested-source-git-list-failed`, inspect its classified
`detail` and process status in `failure.json`. Run `git ls-files --cached --others
--exclude-standard` in the same host checkout to inspect Git's original error.
The snapshot requires a working Git checkout and Git on the test process's PATH;
it does not bypass Git ownership refusals or include ignored files to work around
an enumeration failure.

The build's PowerShell parser collects four generated nested-development programs:
claim acquisition, claim completion, feature preparation, and job launch. The
collector imports the current claim functions rather than a legacy constant.
`nested-powershell-sources.test.ts` exercises the actual TypeScript subprocess on
every host, including hosts without PowerShell. This checks source availability;
native syntax validation still requires PowerShell.

The guest's scheduled test job uses SYSTEM. Image and VM directory permissions
therefore contain two distinct principals (SYSTEM and Administrators); an
interactive non-SYSTEM owner normally adds a third. The permission checks
deduplicate SID values before comparing the exact ACL, while retaining owner,
inheritance and rights validation. `hyper-v-base-image-acl-failed` from older
code can be this duplicate-SYSTEM counting bug, not a reason to relax folder
permissions manually.

On 2026-09-30, the corrected image and VM directory ACL functions were executed
inside the retained Windows L1 under a temporary SYSTEM scheduled task. Both
installed and verified exactly two rules; the former expected count was three.
The probe removed its own task and temporary directory. This validates the ACL
correction, not the complete inner Windows provisioning/test workflow.
