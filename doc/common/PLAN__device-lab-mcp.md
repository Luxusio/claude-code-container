---
type: PLAN
status: candidate
created: 2026-06-08
source: REQ__lazy-device-mcp.md
---

# Device Lab MCP Implementation Plan

## Goal

Add lazy, per-container-isolated device and VM environments that AI agents can
manage through CCC-managed MCP tools. Normal CCC startup must remain lightweight:
device definitions may be discoverable, but Windows Sandbox, Android Emulator,
iOS Simulator, macOS VMs, and other heavy targets should start only after an MCP
tool call requests them.

## Architecture

Implicit host-broker lifecycle routing preserves the public `device_*` response
shape. Explicit broker diagnostics keep their RPC envelope, while ordinary
lifecycle calls expose provider-compatible fields and Android emulator starts
honor `waitForBoot` before reporting readiness.

Level 3 rebuilds both the TypeScript host CLI/broker and packaged device MCP
before real-provider execution. Windows broker recovery allows a longer cold
start window and reports a bounded broker-log tail when health never becomes
ready, so a stale `dist/index.js` or opaque launch timeout cannot masquerade as
a provider response-shape failure.

Host-broker lifecycle deadlines account for provider process topology. Android
AVD creation may run `avdmanager.bat` plus its Java child for up to five minutes,
and deletion may run for up to two minutes; the MCP RPC deadline includes an
additional 15-second response buffer so Windows batch-child handles are not cut
off by the generic five-second provider timeout.

Broker health probes and lifecycle RPCs use separate timeout budgets. In
particular, implicit `device_create` and explicit broker lifecycle calls must
forward the operation-specific RPC timeout instead of allowing the short
250-millisecond health-probe timeout to govern provider execution.

Android emulator session status exposes the resolved device and `adb` provider
alongside lazy Appium metadata, matching the public mobile status contract used
through direct and broker-routed execution. Real transfer proof uses
`/data/local/tmp`, the ADB shell staging area that remains writable under modern
Android scoped-storage rules, rather than assuming shell write access to the
user-facing Downloads collection.

Implicit recording start/status/stop calls flatten broker-owned recording state
to the same public response shape as direct providers; explicit broker
diagnostics retain their RPC envelope. Android airplane-mode control prefers
the modern connectivity shell command and uses the legacy protected broadcast
only as a compatibility fallback for older platform images.

Android clipboard round-trips use the broker-owned Appium session for implicit
host routing. ADB `cmd clipboard` may exit successfully while returning an empty
clipboard on current platform images, so it remains only a direct-backend
compatibility path and is not treated as host-broker proof.

## Source layout

`device-lab-mcp` should keep a small entrypoint and split behavior by
responsibility:

```text
device-lab-mcp/
  server.mjs                  # stdio entrypoint only
  src/
    server.mjs                # MCP server wiring and top-level routing
    tools.mjs                 # MCP tool schemas
    context.mjs               # owner identity and package context
    responses.mjs             # MCP response helpers
    commands.mjs              # process/command helpers
    state/
      device-store.mjs        # generic owner-scoped backend state helpers
      android-state.mjs       # owner-scoped Android state store
      android-device-state.mjs # owner-scoped physical Android attachment store
      ios-state.mjs           # owner-scoped iOS Simulator state store
      ios-device-state.mjs    # owner-scoped physical iOS attachment store
      physical-lease-store.mjs # host-wide physical hardware lease locks
      windows-state.mjs       # owner-scoped Windows Sandbox state store
      macos-state.mjs         # owner-scoped macOS VM state store
    display/
      x11.mjs                 # current display target and display_* tools
    backends/
      android.mjs             # Android lifecycle and Appium Android tools
      android-device.mjs      # physical Android USB/ADB attachment
      ios-simulator.mjs       # iOS Simulator lifecycle via simctl
      ios-device.mjs          # physical iOS USB/Xcode attachment
      windows-sandbox.mjs     # Windows Sandbox lifecycle via wsb CLI
      macos-vm.mjs            # macOS VM provider discovery and definitions
```

Future backends should add files under `src/backends/` and keep persistent
state helpers under `src/state/` instead of expanding the MCP entrypoint.

## Reference patterns to adopt

Existing mobile MCP projects suggest several useful patterns for CCC:

1. Appium/WebDriver bridge
   - Strength: broad Android/iOS support through UiAutomator2 and XCUITest,
     session management, mature app automation vocabulary.
   - CCC should borrow the idea of explicit session ownership and
     backend-specific capabilities.
   - If CCC can install and manage Appium, drivers, and host prerequisites
     without user configuration, Appium should become the default high-level
     mobile automation layer rather than a purely optional integration.

2. Native accessibility-first control
   - Strength: exposes UI trees and stable element metadata before falling back
     to screenshots or coordinates.
   - CCC should prefer accessibility/UI hierarchy snapshots for mobile actions
     because they are more deterministic and token-efficient than visual-only
     control.

3. ADB plus scrcpy for Android
   - Strength: direct shell/package/input control and fast screen streaming.
   - CCC should use ADB as the baseline Android backend and consider scrcpy or
     a similar frame-stream path for low-latency visual evidence.

4. iOS simctl plus IDB/WebDriverAgent
   - Strength: `simctl` handles simulator lifecycle, screenshots, app launch,
     URLs, and location; IDB or WebDriverAgent fills gaps for taps, typing, and
     UI hierarchy.
   - CCC should use `simctl` as the baseline iOS Simulator backend and treat
     IDB/WebDriverAgent as optional capability providers.

5. Batched DSL execution
   - Strength: reduces MCP round trips and lets the server own waits, retries,
     assertions, and conditional branching.
   - CCC should add a `device_run_flow` or `mobile_run_flow` tool after the
     primitive tools are stable.

6. On-device bridge
   - Strength: device-local UIAutomator/XCUITest helpers can expose normalized
     UI trees and accept commands through a small HTTP server.
   - CCC should reserve this for advanced real-device support and for cases
     where host tools cannot provide enough control. It should require
     owner-scoped auth and cleanup.

Patterns to avoid as defaults:

- Requiring users to configure SDK paths through environment variables.
- Showing all host-connected devices to every CCC container.
- Relying only on coordinate clicks when accessibility metadata is available.
- Starting device bridges or emulators at normal CCC startup.
- Making users manually install Appium drivers or edit Appium capabilities for
  normal Android/iOS simulator use.

### Components

1. `device-lab-mcp`
   - In-container MCP server exposed to Claude/Codex.
   - Provides a common device lifecycle API plus screen-control tools for the
     current container display.
   - Does not directly start VMs, emulators, simulators, Windows Sandbox,
     macOS VMs, or other heavyweight host providers as its default ownership
     model.
   - Talks to the host broker through CCC's existing host reachability path.

2. `ccc-device-broker`
   - Host-side broker process prepared automatically by host `ccc` when a
     project container is started. The in-container MCP discovers and uses that
     daemon; explicit MCP autolaunch remains only as a compatibility/diagnostic
     path.
   - Auto-start reuse is gated by broker protocol capability and CLI version,
     not only `/health`. Host `ccc` probes `/status` for the broker `version`
     and required capabilities such as host backend readiness and
     broker-routed `device_create` before reusing an existing daemon. If the
     runtime metadata shows the daemon is the current owner's `ccc-host`
     process but it lacks a required capability or reports a stale version,
     host `ccc` stops it and starts a fresh broker so package upgrades do not
     leave containers talking to an old daemon.
   - Owns device inventory, locking, lifecycle, and backend adapters.
   - Owns authoritative runtime state for host-backed devices and automation
     helpers, including Appium sessions and recording processes. Container
     state is allowed only as a transient cache or compatibility bridge.
   - Starts only the lightweight broker daemon during normal `ccc` startup;
     devices, emulators, simulators, sandboxes, VMs, Appium, and provider tools
     still start only after an MCP device action requests them.
   - Stores state under `~/.ccc/devices`, which is bind-mounted into CCC
     containers at `/home/ccc/.ccc/devices` so the host broker and MCP share
     owner tokens, runtime metadata, and owner-scoped device definitions without
     environment-variable setup.
   - Current implementation exposes the broker contract through public
    `device_broker_status` and `device_backends` tools. Low-level broker
    service/RPC/physical/Appium/command tools remain callable for legacy
    diagnostics and real-test proof, but they are hidden from normal MCP tool
    discovery.
    `device_backends` keeps the container X11 display local, but when a
    host-`ccc` managed broker runtime is present it reads host provider
    readiness through `broker.backends` so Windows Sandbox, Android SDK, Xcode,
    and macOS VM provider availability are reported from the host instead of
    the Linux container PATH. Normal host-backed backend lifecycle tools require
    the broker; if no usable broker is reachable they report a structured
    broker error instead of creating or mutating a container-local owner
    namespace. `device_status`, `device_start`, `device_stop`, and
    `device_delete` route through the host-`ccc` broker automatically when
    broker inventory confirms the target device. The
    public MCP schemas intentionally hide broker transport knobs such as
    `broker`, `viaBroker`, `implicitBroker`, `autolaunch`, host candidates,
    broker port overrides, and probe/launch timeout tuning. The implementation
    still accepts those legacy arguments for compatibility and diagnostics, but
    normal agents rely on zero-configuration broker discovery plus domain inputs
    such as `deviceId`, app paths, coordinates, and lifecycle options. Optional
    backend hints are also hidden from device-id action tools because the owner
    device definition is authoritative. `device_create` exposes an `options`
    object for backend-specific advanced fields; hidden low-level
    `device_broker_command` accepts the same shape for compatibility and
    real-test proof. The server flattens that object into the legacy argument
    shape before policy and backend handling, with top-level keys winning on
    conflicts. Automatic broker routing also covers Android emulator/device file
    transfer, app install/launch/reset, direct ADB-style
    `device_exec`/screenshots/mobile primitives, and Android emulator/device plus
    iOS Simulator video recording start/stop.
    Once broker inventory confirms a host-owned device, broker-routed device
    action failures are surfaced directly instead of being masked by
    container-local provider attempts. Windows command discovery also checks
    WindowsApps execution aliases such as `wsb.exe` when `where wsb` misses
    them, so broker
    child helpers use the same zero-configuration provider discovery as broker
    readiness. Broker action RPC timeouts are separate from short health-probe
    timeouts and are pinned to the endpoint that satisfied inventory, so a slow
    Sandbox start/helper command does not mutate host state and then fall through
    to a misleading container-local prerequisite error.
    Android physical `device_inventory` falls back to the default
    zero-configuration host broker candidates and port when local ADB is missing
    and no runtime metadata file is visible inside the container. Physical
    `device_attach` and `device_detach` also prefer the zero-configuration host
    broker when runtime metadata or explicit broker probe options are available,
    with `device_attach.port` kept as the Android Wi-Fi device port and
    `brokerPort` reserved for legacy broker endpoint diagnostics. Physical
    attach/detach broker RPCs use a normal 30-second execution timeout rather
    than the short broker health-probe timeout, so slower `adb connect` or host
    inventory work does not fall through to container-local direct handling.
    Generic
    implicit broker routing still requires explicit endpoint options or
    supported runtime metadata, and foreign-owner or unmanaged runtime metadata
    remains ignored for implicit routing.
    Android screenshot responses preserve valid PNG stdout as `image/png` even
    when host ADB reports a nonzero exit status after writing the frame.
    Android emulator lifecycle starts the host emulator headlessly by default
    (`-no-window -no-audio`) so MCP-driven tests do not steal the user's
    desktop; callers can opt into a visible emulator with `headless: false`.
    CCC-managed emulator launches also pass
    `-netsim-args "--no-cli-ui --no-web-ui"` so the emulator's netsimd helper
    does not open its own CLI/Web UI window during background test runs. On
    Windows, emulator starts go through a hidden `wscript.exe //B` launcher that
    runs `%ComSpec% /d /s /c ... >NUL 2>NUL`, because `netsimd.exe` can still
    create a visible console log window even when its CLI/Web UI flags are off.
    Android physical-device `device_inventory` and attach list now include host
    `adb devices -l` visibility as `hostDevices`, including unauthorized/offline
    states; `device_attach` can auto-select the only attachable USB physical
    device when no serial is supplied, and asks for a serial only when selection
    is ambiguous.
    Windows Sandbox lifecycle is not truly headless, but starts and reconnects
    minimized by default through the Windows host broker/direct backend; callers
    can opt into a visible sandbox launch with `minimized: false`.
    Broker-routed device file/app tools translate current-project container
    paths under `/project/<project-id>/...` into the host broker's project
    `cwd` before invoking host ADB or Windows Sandbox helpers, so apps built in
    the CCC workspace can be uploaded or installed without user path rewriting.
    Windows Sandbox and macOS VM video recording stay on their guest-helper/SSH
    direct-provider bridges because artifact transfer and helper availability
    are backend-local concerns.

3. Backend adapters
   - `android-emulator`: Android SDK emulator and `adb`.
   - `android-device`: host-connected physical Android devices through `adb`.
   - `ios-simulator`: Xcode `xcrun simctl` on macOS hosts.
   - `ios-device`: host-connected physical iOS devices through macOS Xcode
     tooling (`xcrun xctrace`, `xcodebuild`) and Appium/XCUITest where
     available.
   - `windows-sandbox`: Windows Sandbox `.wsb` and `wsb` CLI on Windows hosts.
   - `macos-vm`: Apple Virtualization.framework or provider-backed macOS VM on
     macOS hosts.
   - Future backends can implement the same lifecycle contract.

4. Optional guest helper
   - Used only when the guest control API cannot return enough output or
     capture evidence directly.
   - Installed into disposable Windows/macOS guests through scoped mounts or
     initialization scripts.
   - Not needed for Android `adb` or iOS `simctl` first versions.

5. Current display target
   - The existing X11 display controls are folded into `device-lab-mcp` as a
     non-creatable, always-current display target, and generated CCC MCP config
     no longer includes the standalone `x11-display` entry.
   - X11 supports screenshot, click, key, type, scroll, cursor, and related
     screen control tools through `device-lab` `display_*` tools.
   - X11 does not expose create/delete lifecycle tools because it represents
     the current CCC container's display bridge rather than an inventory-managed
     VM or emulator.

## Host virtualization and Appium authority

CCC must not rely on nested virtualization inside the CCC container for the
normal device-lab flow. Windows Sandbox runs on Windows hosts, iOS Simulator and
macOS VMs run on macOS hosts, and Android Emulator should run on the host unless
the user explicitly opts into a special container/KVM setup. The MCP server in
the container is a client and router, not the owner of host virtualization.
Windows Sandbox is an interactive Windows feature, not a true headless runtime;
if a non-intrusive or fully background Windows GUI validation target is required,
CCC should use a Windows VM lab/runner rather than pretending Windows Sandbox can
hide its desktop surface.

The host boundary is a security boundary, not just an implementation detail.
CCC must not give an AI agent a general-purpose host command channel merely so
it can run provider E2E tests. The single public `device-lab` MCP routes typed,
allowlisted operations through the authenticated host broker. VM technology is
an internal provider choice rather than a second public MCP surface.

The public VM backends are guest-oriented:

- `windows-vm` represents a persistent, checkpoint-capable Windows guest.
- `linux-vm` represents a persistent Linux guest.
- `windows-sandbox` remains separate because its lifecycle and persistence
  contract differs from a full VM.
- `hyper-v`, `container-qemu`, and future host technologies are providers hidden
  behind those backends.

On Windows, the Hyper-V provider owns disposable Windows and Linux guests. On
native Linux, the existing container-QEMU/KVM provider owns Linux guests. CCC
automates verified image preparation, owner-scoped disks, unattended guest
provisioning, readiness, bounded guest command/file transport, checkpoints,
lifecycle, and deletion. Users do not manually create VMs in Hyper-V Manager.

User interaction is limited to explicit trust boundaries: enabling Hyper-V and
rebooting when Windows requires it, approving elevation, and accepting applicable
Windows image/license terms. Normal create/start/test/stop/delete operations do
not require a VM console or user-provided environment variables. The detailed
Hyper-V architecture, delivery phases, and acceptance tests are defined in
`doc/common/PLAN__hyper-v-vm-provider.md`.

Container-QEMU may run inside a Linux container only when CCC configured the
bounded VM contract. The ordinary project container and built-in `lab-runner`
profile can receive per-container state, internal `CCC_LAB_*` diagnostics, and
`/dev/kvm` only after the native non-rootless KVM gates pass. They must not
receive broad host mounts, `--privileged`, host TUN/TAP exposure, or host shell
access. Unsupported environments report an explicit unsupported/SKIP result.

Lab-runner container profile status:
- `lab-runner` is a built-in CCC profile, so it can be selected without creating
  a custom profile directory first.
- `ccc labs status` and `ccc labs smoke` expose a zero-configuration,
  non-starting readiness view for agents and users. `ccc labs shell` and
  `ccc labs run <command>` enter the built-in `lab-runner` profile without
  requiring the user to set `CCC_PROFILE`. The status/smoke view now reports
  the ordinary default container VM contract and the built-in `lab-runner`
  profile contract as separate entries, so automation can verify whether
  ordinary in-container `lab-mcp` VM execution is available without starting a
  lab or host runner.
- The default CCC container is also VM-capable when the host/runtime satisfies
  the same bounded KVM gates. CCC mounts a per-container durable named volume,
  injects `CCC_LAB_RUNNER=1`, `CCC_LAB_RUNNER_STATUS`, `CCC_LAB_STATE_DIR`, and
  `CCC_LAB_NET_MODE=user`, and exposes `/dev/kvm` only on supported native
  Linux/rootful runtimes. This lets agents call `lab-mcp` from the ordinary
  project container without host shell control or user-provided environment
  variables.
- CCC mounts a per-container durable named
  volume at `/home/ccc/.ccc/labs` for lab metadata, VM disks, overlays, caches,
  snapshots, and artifacts. The volume name is derived from the container name,
  so recreating the same container/profile preserves named-lab state without
  sharing it with other CCC containers.
- On native Linux Docker/rootful Podman with `/dev/kvm`, CCC adds only bounded
  KVM wiring: `--device /dev/kvm:/dev/kvm` and the detected KVM group via
  `--group-add`. It does not enable `--privileged`.
- Because CCC containers currently use host networking, VM-capable containers
  do not expose `/dev/net/tun`; doing so would create a host-network
  namespace TUN/TAP control surface. CCC instead sets `CCC_LAB_NET_MODE=user`
  and expects QEMU user-mode networking for in-container VM smoke and provider
  flows. Unsupported containers also receive that user-mode networking
  diagnostic, but no container receives `/dev/net/tun` in this host networking
  model.
- On Docker Desktop, podman-machine, rootless Docker/Podman, non-Linux hosts, or
  hosts without `/dev/kvm`, CCC still creates containers with the durable state
  volume and sets `CCC_LAB_RUNNER_STATUS=unsupported` plus a reason. The later
  lab provider must report SKIP/unsupported instead of falling back to host
  control.
- The Docker and Podman image definitions now include QEMU/KVM userland
  prerequisites (`qemu-system-x86`, `qemu-utils`, `ovmf`, and `cpu-checker`) so
  a supported default container or lab-runner profile can run container-local
  VMs without manual package installation or user-provided environment
  variables.
- The former standalone `lab-mcp` package has been retired. Container-QEMU is
  exposed as the `linux-vm` backend of the single public `device-lab` MCP, and
  VM starts remain gated by the internal
  `CCC_LAB_RUNNER=1` and `CCC_LAB_RUNNER_STATUS=ready` diagnostics injected by
  CCC. Default containers receive those diagnostics too, so they can run
  container-QEMU labs when bounded KVM is available and otherwise report
  unsupported/SKIP.
- The initial container-QEMU provider stores owner-scoped named lab metadata
  under `/home/ccc/.ccc/labs` or `CCC_LAB_STATE_DIR`, supports `lab_status`,
  `lab_list`, `lab_image_list`, `lab_image_import`, `lab_create`, `lab_start`,
  `lab_disk_materialize`, `lab_stop`, `lab_delete`, and qemu-img snapshot
  create/restore/delete operations, and constrains image/disk paths to the lab
  state root. The base image catalog can copy/register images that already
  exist inside the lab state volume and create labs from `baseImageId`.
  `lab_disk_materialize` creates a writable owner-scoped qcow2 overlay/root disk
  from the validated source/base image, and `lab_start` materializes that disk
  before booting when it is missing. The current implementation imports images
  already present in lab state; the host-provider expansion replaces this
  limitation with verified automatic Windows and Linux image acquisition and
  shared base-image caching.
- `lab_sync_workspace` and `lab_export_artifacts` are implemented as bounded
  lab-state file transfer primitives. They copy through owner-scoped lab state
  paths only, reject path traversal and out-of-root destinations, preflight the
  full tree before copying, reject symlinks and unsupported file types, cap file
  count and byte totals, and reject common secret-looking filenames such as
  `.env`, private keys, and package-manager auth files. This is the local
  lab-state transfer layer.
- `lab_guest_push` and `lab_guest_pull` define the bounded in-guest transport
  contract. They require a running owner-scoped lab, validate guest paths
  against provider allowlisted prefixes, reuse the lab-state file policy for
  staged host data, record auditable file operations, support dry-run plans, and
  use a bounded provider transport runner. The container-QEMU provider can now
  store owner-scoped SSH guest metadata on `lab_create`, probe readiness through
  that channel, use `ssh`/`scp` for push/pull when configured, and run bounded
  `lab_guest_exec` commands through SSH with timeout/command validation and
  redacted public results; labs without SSH metadata still return explicit
  unavailable/skipped diagnostics. `lab_open_session` also supports bounded
  `guest-ssh` and `guest-agent` session metadata that advertises `lab_guest_exec`,
  `lab_guest_agent_status`, `lab_guest_agent_provision`, and guest transfer
  tools without exposing raw interactive shell authority. `lab_guest_agent_status`
  records sanitized persistent health state for explicitly configured guest
  agents. `lab_guest_agent_provision` runs an explicitly configured bounded
  provisioning command through the same guest SSH channel, records sanitized
  provisioning state/history, and `lab_start` runs it automatically only when
  the lab opted into `guestAgentAutoProvision`.
- The device-lab Linux VM backend smoke suite runs a fake-provider job for CI
  and local automation. It uses temporary lab state plus injected fake QEMU and guest
  transport runners to exercise provider status, image import, lab creation,
  disk materialization, start, readiness, guest push/pull, snapshot, stop, and
  delete without requiring KVM, real QEMU, SSH, or host virtualization tools.
  This complements the opt-in `ccc devices smoke --real-provider` job, which
  verifies real host provider readiness/inventory commands without creating or
  starting devices.
- Real-environment validation should be test-code first, with levels split by
  cost and authority instead of hidden behind a separate CLI workflow:
  - Real-test repository paths must be derived from module file URLs with
    `fileURLToPath`; URL pathnames are not filesystem paths on Windows and can
    otherwise produce invalid drive-prefixed paths such as `C:\\C:\\...`.
  - Level 0 default unit/contract tests run on every CI host with fake providers
    and no virtualization, hardware, or host authority. Run with `npm test` or
    `npm run test:level0`.
  - Level 1 non-destructive real-provider readiness tests are opt-in and may run
    on Windows or macOS lab hosts. They verify provider discovery, inventory,
    and bounded readiness only; unavailable providers should skip with explicit
    diagnostics. Run with `npm run test:level1`. The suite is backend-specific
    so Android emulator, Android physical device, iOS Simulator, iOS physical
    device, Windows Sandbox, and macOS VM readiness show as separate tests.
  - Level 2 real lab integration tests are opt-in and may create/start
    disposable owner-scoped VMs, emulators, simulators, or sandboxes on the host
    that owns that virtualization authority. They must tear down owned
    resources and leave reports/artifacts for agent iteration. Run with
    `npm run test:level2`; the Linux VM test reports SKIP unless `/dev/kvm`,
    QEMU, `qemu-img`, and an owner-safe base image under
    `$CCC_LAB_STATE_DIR/images` or `$CCC_REAL_LINUX_VM_IMAGE` are available.
    Host-backed Android emulator, iOS Simulator, Windows Sandbox, and macOS VM
    integration slots also appear separately and skip unless their Level 1
    readiness is present. On macOS hosts with full Xcode command-line tools,
    Level 2 creates an owner-prefixed iOS Simulator, boots it, verifies exec and
    screenshot operations, then stops and deletes the simulator; leased physical
    iOS devices are attached for bounded status/no-op lifecycle/detach smoke
    coverage only when `CCC_REAL_IOS_DEVICE_UDID` is set. On macOS hosts with
    Tart, Level 2 selects a single usable local Tart image automatically, clones
    it, boots it headlessly, waits for a guest IP, then stops and deletes the
    clone. `CCC_REAL_MACOS_VM_SOURCE_IMAGE` (or the compatibility
    `CCC_REAL_TART_SOURCE_IMAGE`) can choose the source explicitly; ambiguous
    local candidates are reported as a skip instead of guessed.
    When `CCC_REAL_MACOS_VM_SSH_USER` is set, the same run infers the SSH host
    from Tart IP unless `CCC_REAL_MACOS_VM_SSH_HOST` is set, provisions the
    guest helper, and exercises real guest `exec`, screenshot, upload/download,
    and window-list operations before teardown.
    On Windows hosts with the `wsb` provider available,
    Level 2 includes an owner-scoped Windows Sandbox helper E2E that creates,
    starts, runs guest-helper `exec`, screenshot, upload/download, and window
    listing checks, then stops and deletes a disposable sandbox definition.
    On hosts with Android SDK tools and an installed system image, Level 2 also
    creates an owner-prefixed AVD, boots it, verifies ADB shell/input/screenshot
    operations, stops the emulator, and deletes the owner-created AVD.
    Source/packaged MCP session options belong on the emulator E2E MCP session;
    local console-port probes remain provider-independent and must not evaluate
    MCP session options.
  - Level 3 destructive or physical-device tests require leased hardware or
    disposable images because they may mutate device state, app data, snapshots,
    or guest files. Selecting `npm run test:level3` is itself the explicit
    authorization; no separate environment-variable switch is required. The
    macOS VM path exercises
    disposable Tart base-image and snapshot clone/restore/delete coverage when
    the provider prerequisites are present.
  - Level 3 is a Vitest integration test and uses the normal Vitest reporter and
    exit semantics. The real-provider collector runs inside that test to retain
    full step and MCP-call details in the platform result JSON; it does not own
    the user-facing output format. A broker startup failure stops that module's
    dependent RPC checks instead of producing one redundant failure per RPC.
    The collector child strips Vitest-only environment markers so the packaged
    CCC CLI executes its normal `main()` path when it launches a test broker.
    The command refreshes the packaged device-lab MCP bundle first, so no
    separate build command is required.
  - Real E2E teardown leaves reused and host-managed brokers running. On Windows,
    a session-owned broker launched on the test's random port is cleaned up by
    its exact PID with `taskkill /T /F`; teardown does not call broker shutdown,
    stop devices, detach physical hardware, or run owner-wide provider cleanup.
  - A platform result may contain categorized provider or host coverage gaps.
    Those gaps do not fail the individual Vitest run; the cross-host matrix is
    the authority that rejects missing public-tool or provider evidence across
    the combined Windows, macOS, and Linux results.
  - On Windows, device-lab MCP broker recovery launches the packaged
    `dist/index.js` with the current Node executable. It must not depend on
    PowerShell command resolution, a `ccc.cmd` shim, or user-managed `PATH`.
  - Complete provider verification is cross-host because macOS/iOS, Windows
    Sandbox, and Linux KVM cannot coexist on one host. `npm run test:level3`
    creates and validates a platform result. Passing collected result files after
    `--` runs the matrix validator, which requires direct source and packaged-MCP
    success for every public tool, dedicated real E2E evidence for every
    provider, and a real Linux VM boot. Host-specific SKIPs remain diagnostic and
    cannot satisfy missing provider evidence in the final matrix.
  - Real E2E steps should reserve SKIP for unavailable prerequisites or
    intentionally unprovisioned optional artifacts. A safety decision not to
    shut down a reused or host-managed shared broker is reported as PASS with a
    diagnostic, while hidden `device_broker_shutdown` dispatch remains covered
    by MCP-owned shutdown when applicable and by a safe no-runtime shutdown
    call.
  - For full app-specific Level 3 coverage, provide
    `CCC_REAL_ANDROID_APK`, `CCC_REAL_ANDROID_PACKAGE`, and
    `CCC_REAL_ANDROID_PERMISSION` so install/launch/reset/uninstall and
    grant/revoke paths actually run. iOS Simulator app coverage uses
    `CCC_REAL_IOS_SIMULATOR_APP`, `CCC_REAL_IOS_SIMULATOR_BUNDLE_ID`, and
    Appium/XCUITest prerequisites so disposable app and gesture/touch paths
    actually run.
  - Android physical-device coverage uses `CCC_REAL_ANDROID_DEVICE_SERIAL`,
    `CCC_REAL_ANDROID_DEVICE_APK`, `CCC_REAL_ANDROID_DEVICE_PACKAGE`, and
    `CCC_REAL_ANDROID_DEVICE_PERMISSION` so attach/status, ADB shell/UI/touch,
    screenshot, upload/download, app lifecycle, and permission grant/revoke
    paths actually run against a leased physical target.
  - iOS physical-device coverage uses `CCC_REAL_IOS_DEVICE_UDID`, Appium/XCUITest
    prerequisites, and `CCC_REAL_IOS_DEVICE_BUNDLE_ID` so attach/status,
    Appium UI/screenshot/tap/home/orientation, and launch/wait/stop app paths
    actually run. `CCC_REAL_IOS_DEVICE_APP` is optional and enables physical
    device install coverage before launch; without it, Level 3 can still
    launch an already-installed disposable bundle.

Provider direction should stay simple: from the agent's perspective there is
one lab MCP and one lab abstraction. The default provider is a host-level or
remote disposable lab runner because it keeps virtualization outside the
default agent container and works across Windows/macOS/Linux labs. A privileged
Linux KVM container is only an optional implementation provider for CI hosts
that explicitly enable a lab-runner profile. Direct host Windows Sandbox is a
device-lab backend or a target tested inside a Windows lab VM, not the lab
control layer itself. Do not build separate first-class control paths for
"host sandbox runner", "container VM runner", and "host VM runner"; implement
provider plugins behind the same lab MCP contract so the agent workflow does
not change.

Persistence should be explicit rather than always disposable. Development uses
a named lab with snapshot/restore by default so SDK caches, Appium installs,
workspace state, and OS readiness do not disappear on every test or host
reboot. CI uses throwaway labs by default. A retain-on-failure run starts from a
clean snapshot, cleans up on success, and preserves the failed lab plus
artifacts for debugging. Persistent pieces are lab definitions, base images,
cache disks, optional workspace disks, snapshots, and exported artifacts.
Disposable pieces are run overlays, transient Appium/container processes, temp
logs, and device leases. Host repository bind mounts, host home mounts,
Docker socket access, raw host disks, and arbitrary VM filesystem export remain
out of scope; workspace sync and artifact export must use bounded paths and
policy checks for symlinks, size, executable bits, and secrets.

Persistence is tied to the provider's durable state root, not to whether the
provider launches VMs from the host or from a privileged lab-runner container.
Every provider must expose the same lab state model: a durable metadata record,
base image reference, writable overlay/root disk, cache disk, optional workspace
disk, snapshot list, artifact export directory, TTL, owner, and current runtime
PID/handle if running. For a host-level provider, that state root lives in the
host broker namespace, for example under an owner-scoped `~/.ccc/labs` or
service-managed data directory. For a container-KVM provider, the state root is
a named persistent volume or explicitly mounted lab-runner data directory owned
by the lab service, not the short-lived CCC agent container filesystem. The
default CCC container may be deleted without deleting named labs; it should only
hold client-side connection metadata.

`lab.stop` stops runtime processes but keeps named-lab state. `lab_reboot` is
implemented for the container-QEMU provider as a stop/start sequence through
the same provider readiness gates; it preserves the lab identity, disks,
snapshots, workspace/artifact paths, and metadata. `lab.delete` removes the
named lab's metadata, overlays, workspace disk, snapshots, and artifacts after
the provider confirms no runtime handle remains. `lab.prune` removes expired
throwaway labs, old retained-failure labs, and cache entries according to
quotas. `lab_list_targets` and `lab_open_session` now provide baseline
target/session metadata for named labs, including runtime state, readiness,
workspace/artifact paths, and durable session records without exposing raw QEMU
monitor socket paths or host shell authority. `lab_probe_readiness` records a
bounded readiness result for a running lab target: by default it verifies only
the recorded VM process handle and stores `process-running` metadata; future
guest-agent, SSH, or monitor-backed readiness checks must be mediated by
bounded provider hooks rather than exposed as raw control channels.

Host reboot is not the same operation as `lab.reboot`. After a host or
lab-runner service restart, providers must recover by reconciling durable
metadata against actual runtime handles. Labs with disks but no running VM
become `stopped` by default, stale locks/leases are cleared only after owner
and TTL checks, and automatic restart is allowed only for labs that explicitly
opt into an `auto_start` policy. This avoids surprise compute spend and avoids
recreating long-lived processes after a machine restart unless the operator
asked for that behavior.

Appium follows the same rule. Appium is an automation bridge, not a VM or
simulator runtime. For iOS Simulator, physical iOS, and host-backed Android
emulators/devices, the durable target state and Appium process/session metadata
should live in the host broker namespace so deleting or recreating the CCC
container cannot lose the process owner and leave a host process behind.

Current implementation note: the host broker exposes `broker.appium.status`,
`broker.appium.list`, `broker.appium.record`, `broker.appium.clear`,
`broker.appium.start`, `broker.appium.stop`,
`broker.appium.session.ensure`, `broker.appium.session.delete`, and
`broker.appium.request` for Android emulator, Android real device, iOS
Simulator, and iOS real-device backends. The hidden compatibility tool
`device_broker_appium` keeps this direct broker route available for real-test
proof and diagnostics; normal agents reach Appium-backed behavior through
domain tools such as `mobile_session_status`, `mobile_dump_ui`, gestures, app
actions, and device recording tools. `record` stores caller-supplied diagnostic
metadata only; it never grants process-signal ownership or WebDriver proxy
authority. `start` launches an owner-scoped Appium
server process through the broker command runner, `session.ensure` creates or
reuses a broker-owned
WebDriver session, and `request` proxies bounded session-relative WebDriver
requests. High-level mobile tools automatically use this path for host-backed
owner devices when a broker is reachable: `mobile_session_status`,
`mobile_dump_ui`, touch gestures, text/key input, home/back/forward/recents,
power, lock/unlock, rotate/orientation, screenshots, URLs, app
install/launch/stop/uninstall, Android app-data clearing, location, clipboard,
`mobile_wait_for_text`, and `mobile_wait_for_app` ensure a broker-owned Appium
session and then proxy bounded session-relative WebDriver requests. Legacy
explicit route flags are still accepted for diagnostics, but the public mobile
tool schemas no longer expose them. Android
broker keycode controls use Appium `press_keycode`; Android reverse
orientations and app-data clearing use bounded Appium `mobile: shell` requests
for the same settings or `pm clear` operations that direct ADB paths mutate. The
host broker starts Android Appium with `--allow-insecure adb_shell` for those
owner-scoped Android servers; iOS Appium startup does not receive that flag.
`broker.appium.request` now enforces a broker-side allowlist before forwarding
to Appium: supported requests are limited to the method/path pairs generated by
device-lab MCP mobile tools, and sensitive bodies are validated per endpoint.
`POST /execute/sync` accepts only scoped iOS mobile scripts
(`activeAppInfo`, home button, lock, unlock) or bounded Android `mobile: shell`
commands for rotation settings, component launch, and `pm clear <package>`.
Unsupported WebDriver endpoints, arbitrary mobile scripts, and arbitrary shell
commands are rejected before a request reaches the Appium server.
Broker-routed app installation passes the app path to the host-owned Appium
server, so the path must be visible to that host process. Physical Android and
iOS devices keep the direct-provider safety rule for location mutation and
reject broker-routed `mobile_set_location`; iOS `mobile_wait_for_app` checks
`mobile: activeAppInfo` rather than only installed/running state.
The broker also exposes `broker.cleanup.owner` so a CCC owner can stop
broker-owned Appium processes, clear owner recording metadata, stop
owner-scoped virtual devices where provider metadata is sufficient, detach
physical-device owner leases without powering off hardware, and preserve other
owners' state. MCP-owned broker shutdown calls this cleanup RPC before
terminating the broker process and includes cleanup evidence in the shutdown
response; if owner cleanup reports failed devices, shutdown still stops the
MCP-owned broker but reports `broker-owner-cleanup-failed` instead of masking
the failure.
Direct-provider mobile paths still start Appium from the in-container MCP
process as a compatibility bridge for fake-provider tests and explicitly
reachable transports.

Toolchain and persistence status:

- `device_broker_status`, broker `/status`, and `broker.status` now report a
  `persistence` manifest. It identifies the host `~/.ccc/devices` root,
  owner-scoped backend `devices.json` files, recording/helper artifact
  directories, broker auth/runtime/log/service roots, and the cleanup boundary
  between owner-owned state and shared host toolchains.
- Host-managed state is intentionally under the host user's home, not only in a
  disposable CCC container filesystem. Recreating a CCC container preserves
  owner device definitions, broker auth, Appium process/session metadata,
  recording metadata, Windows/macOS helper workspace metadata, physical leases,
  and broker runtime logs until owner cleanup or explicit admin commands mutate
  them.
- Appium, Android SDK/AVD storage, Xcode/CoreSimulator, Windows Sandbox, and
  macOS VM provider installations/catalogs remain host-owned toolchains. CCC
  discovers them through zero-configuration PATH/provider discovery and reports
  missing prerequisites instead of deleting, recreating, or hiding them during
  owner cleanup.
- Owner cleanup may mutate only the current owner namespace plus that owner's
  physical lease files. It clears stale owner Appium/recording metadata and
  retries provider stop commands, but preserves foreign owner namespaces,
  broker auth/service/log roots, shared/base VM images, and host toolchain
  caches. Tests pin these persistence boundaries.

## Per-container isolation

CCC should derive a stable `ownerId` from the same identity used for container
isolation: project path hash, profile, and worktree identity. The host broker is
the source of truth for host-backed device-lab ownership; in-container MCP
processes resolve their owner through the broker before making owner RPCs.

Owner identity status:
- CCC now computes the canonical owner basis as
  `<full-ccc-container-name>:/project/<project-id>`, where the container name is
  derived from the resolved project path plus optional `CCC_PROFILE`. Different
  profiles and worktree/project paths therefore produce different owner
  namespaces.
- Container creation no longer injects this basis through
  `CCC_DEVICE_LAB_OWNER_BASIS`. The broker exposes a public owner-resolve
  handshake for the mounted project path; `device-lab-mcp` uses the resolved
  owner ID for authenticated broker RPC. Direct in-process provider paths use
  the same canonical cwd/profile owner basis by default; stale owner-basis env
  values are ignored.
- Owner resolve accepts the canonical production project mount
  `/project/<project-id>` and the direct checkout path used by local/dev test
  runs, mapping both to the same host broker owner. A broker response that
  explicitly rejects the project, such as `project-owner-unavailable`, is
  surfaced as a broker error and does not fall back to a local provider.
- Host-side `ccc devices ...`, `ccc devices broker ...`, container stop/remove
  cleanup, and session cleanup use the same profile-aware owner calculation, so
  host CLI operations and in-container MCP operations point at the same owner
  state root.
- No automatic migration is performed for older host/cwd-derived owner
  directories. Admin `--all` commands can still inspect or prune legacy owner
  namespaces explicitly.

State layout:

```text
~/.ccc/devices/
  owners/<owner-id>/manifest.json
  owners/<owner-id>/android/<device-id>/
  owners/<owner-id>/ios/<device-id>/
  owners/<owner-id>/windows/<device-id>/
  owners/<owner-id>/macos/<device-id>/
  broker/locks/
  broker/logs/
```

Rules:

1. User-facing MCP tools only list and mutate devices owned by their `ownerId`.
2. Device IDs generated by CCC must include or map to the owner namespace.
3. Running process metadata must include owner, backend, pid or provider ID,
   ports, creation time, and last-seen time.
4. Cross-owner cleanup is allowed only through explicit host admin commands,
   not through regular in-container MCP tools.

Broker contract status:

- `device_broker_status` reports the current host-control mode, owner ID,
  lazy startup policy, deterministic zero-config host candidates
  (`host.docker.internal`, `host.containers.internal`, `gateway.docker.internal`,
  `172.17.0.1`, `10.0.2.2`), default broker port, and owner/broker state
  roots without starting a daemon, emulator, simulator, sandbox, or VM.
- When called with `probe: true`, `device_broker_status` performs bounded
  HTTP `GET /health` checks against the supplied or default host candidates and
  reports structured success/failure attempts. The default `device_broker_status`
  call path does not probe or start anything. `device_backends` remains
  non-starting, but it may perform a bounded implicit probe when host-managed
  broker runtime metadata already exists so it can report host provider
  readiness instead of container-local PATH diagnostics. Explicit probes are
  capped at eight host candidates and 2000ms per candidate.
- A healthy `/health` response is not sufficient for owner-scoped broker RPC.
  `device_broker_status` also reports `rpcReady` and an `ownerResolve`
  diagnostic. If `/v1/owner/resolve` is missing or method-incompatible, status
  remains `host-broker-detected` but `rpcReady:false` and the response includes
  a warning/remedy to restart or upgrade the host broker before device-lab MCP
  sends owner-scoped broker RPCs.
- Legacy diagnostic calls that pass `autolaunch: true` to broker tools first
  reuse a healthy broker if one is reachable, then check owner-scoped runtime
  metadata, and finally start `ccc devices broker serve --host <host> --port
  <port>` only for the broker process. The public MCP schemas do not expose this
  transport switch; host `ccc` normally starts the lightweight broker before the
  container begins. This does not start emulators, simulators, sandboxes, VMs,
  Appium, or provider tools.
- MCP-owned broker launches write runtime metadata under
  `~/.ccc/devices/broker/runtime.json`, including `pid`, `ownerId`, `host`,
  `port`, command/args, log path, `startedAt`, and `managedBy:
  device-lab-mcp`. Stale metadata is removed when the recorded pid is gone or
  health checks fail.
- Host-`ccc` managed broker reuse is also capability-checked. A healthy
  `/health` response is not enough after upgrades; `/status` must advertise the
  required implemented features. If a same-owner `ccc-host` runtime is healthy
  but incompatible, host `ccc` terminates that broker process and starts a new
  one instead of letting the container fall back to stale direct-provider
  diagnostics.
- Broker owner RPC uses a zero-configuration per-owner random secret stored at
  `~/.ccc/devices/broker/auth/<owner-id>.json` with 0600 permissions. Both the
  in-container MCP client and host broker derive `x-ccc-device-token` from the
  owner ID plus this secret, so the token is no longer predictable from owner
  ID alone.
- Hidden compatibility tool `device_broker_shutdown` first asks the host broker
  to clean the current owner runtime, then stops the MCP-owned broker recorded
  for the current owner and removes runtime metadata. The MCP process also
  registers a best-effort exit cleanup hook for broker children it launched.
- Hidden compatibility tool `device_broker_service` is a status-only
  authenticated host broker service manager diagnostic. It does not start
  devices and is not advertised through public MCP tool discovery; host CCC owns
  service repair and lifecycle reconciliation.
- `device_backends` includes the same broker diagnostics so agents can decide
  whether the host broker is reachable before requesting lifecycle work. Normal
  host-backed device-lab operation is broker-first: if a host-managed broker is
  reachable, it calls the authenticated `broker.backends` RPC and returns host
  provider readiness plus the container-local X11 display. If broker discovery
  fails, it reports `broker-unavailable` instead of silently treating
  direct-provider diagnostics as healthy host-backed readiness.
  `implicitBroker: false` remains available for explicit local diagnostics and
  fake-provider tests.
- Hidden compatibility tool `device_broker_rpc` provides an explicit diagnostic transport to an
  already-running host broker. The MCP client first asks `/v1/owner/resolve`
  for the broker-owned project owner, then posts to
  `/v1/owners/<owner-id>/rpc` with a secret-backed owner token. It supports
  diagnostic `broker.status`, `broker.inventory`, `broker.backends`, and
  `broker.echo` methods, and reports structured per-candidate attempts. It is
  not advertised through public MCP tool discovery and does not expose physical
  lease or mutating lifecycle methods; those remain behind dedicated tools.
  Brokers that do not implement
  `/v1/owner/resolve` fail owner resolution instead of falling back to a locally
  computed owner, forcing the host broker to be updated or restarted.
- Hidden compatibility tool `device_broker_lease` explicitly claims, lists, and releases host-wide
  physical hardware leases for `android-device` and `ios-device` through a
  running host broker. Claims are owner-scoped and backed
  by atomic lock files under
  `~/.ccc/devices/physical-leases/<backend>/locks`, so one CCC owner cannot
  overwrite or release another owner's USB/Wi-Fi real-device reservation.
  Lease records include `ttlMs`, `heartbeatAt`, and `expiresAt`.
  `device_broker_lease` also supports `heartbeat` to extend a current-owner
  lease and `prune` to remove only expired leases owned by the current CCC
  owner. Expired foreign locks are recoverable by a new claim, while unexpired
  foreign locks still conflict. Pruning removes only lock metadata; it never
  powers off, disconnects, erases, pairs, or otherwise mutates physical
  hardware.
- Hidden compatibility tool `device_broker_attach` explicitly attaches, detaches, or lists physical
  Android/iOS devices through a running host broker.
  Android Wi-Fi attach claims the host-wide lease before `adb connect`, verifies
  `adb devices -l` reports the target in `device` state, and writes owner state.
  iOS attach validates visibility through `xcrun xctrace list devices`; Wi-Fi
  attach is accepted only for devices already visible as network/Wi-Fi devices.
  Detach removes only owner state and owner leases, never powering off, erasing,
  globally disconnecting, or pairing the real device.
- Hidden compatibility tool `device_broker_apple` reports iOS real-device Apple trust, Developer Mode,
  and Xcode network-pairing readiness through the host broker. It uses
  `xcrun xctrace list devices` to report USB/network visibility, selected UDID
  state, attach readiness, and manual remediation steps. It does not bypass or
  automate the iOS Trust This Computer prompt, Developer Mode approval, or
  Xcode network-pairing UI. `pair` and `connect` return explicit
  manual-required diagnostics unless the device is already visible as a network
  device, in which case `connect` is a no-op readiness acknowledgement.
- Hidden compatibility tool `device_broker_command` explicitly plans or invokes
  owner-scoped lifecycle commands through a running host broker. It
  supports allowlisted `device_create`, `device_status`, `device_start`,
  `device_stop`, and `device_delete` command envelopes for owner device
  definitions across Android, iOS, Windows, and macOS backends. `device_create`
  writes owner-scoped host-broker metadata and provider config files without
  starting a device; Android emulator `createAvd=true` is the current explicit
  provisioning exception and runs `avdmanager create avd` before broker metadata
  is persisted. Invoke builds bounded provider commands without
  shell interpolation, applies timeout/output caps, handles
  emulator starts as detached launches, and reports structured
  missing-metadata/provider failures. Physical Android/iOS stop/delete commands
  are safety no-ops rather than host power/disconnect operations.
- Android emulator `device_delete` honors `deleteAvd=false` as a metadata-only
  owner-state delete. When provider commands do need `avdmanager.bat` or another
  Windows batch file, the host broker invokes it through `cmd.exe /d /s /c`
  because Windows cannot execute `.bat` files directly via Node `spawnSync`.
- Android emulator `device_create` with `createAvd=true` forces AVD names under
  the current owner prefix, rejects custom names outside that scope, and avoids
  writing broker metadata if the host `avdmanager create avd` command fails.
- Broker RPC health probes remain short, but lifecycle RPC calls can wait up to
  30 seconds. Windows Sandbox start can take longer than the old 2-second probe
  cap even when the sandbox actually starts successfully.
- Windows desktop control tools such as exec, screenshot, click/key/type/scroll,
  window list, and accessibility snapshot are proxied through the host broker by
  launching the existing device-lab Windows backend in a short-lived child
  process whose cwd/profile produce the same canonical owner. This avoids
  duplicating the Windows helper protocol in the broker while preserving
  owner-scoped state without injecting `CCC_DEVICE_LAB_OWNER_BASIS`.
  The child invocation envelope is passed over stdin JSON, not temporary
  `CCC_DEVICE_LAB_*` environment variables.
  Implicit desktop action routing first performs a short broker inventory probe;
  when the device is present in broker owner state, the actual helper RPC uses a
  bounded action timeout instead of the short probe timeout so slow helper
  startup does not fall back to the container-local provider path. The host
  broker also runs the desktop backend child process with a device-tool timeout,
  separate from the shorter provider lifecycle command timeout used for bounded
  `wsb`, `adb`, `simctl`, and similar commands.
- Android emulator and physical Android device tools now use the same
  broker-owned child-backend pattern for host-visible Android state. The broker
  imports the Android backend handler on the host side and proxies owner-scoped
  `device_exec`, screenshots, file transfer, app install/launch/reset, and
  primitive mobile ADB actions without exposing a general host shell to the
  container.
- The host broker advertises `http-lifecycle-device-create-command` so host
  `ccc` can reject and replace older broker daemons that predate broker-routed
  `device_create`, even if those daemons are otherwise healthy.
- The host broker also advertises `http-desktop-device-tool-timeouts` so host
  `ccc` replaces stale desktop-tool brokers that proxy exec/screenshot/window
  actions but still run those child actions under the shorter lifecycle command
  timeout.
- Broker-created Windows Sandbox configs advertise
  `http-windows-sandbox-helper-config` and include the same helper mapped
  folders used by the direct provider. This keeps broker-created sandboxes
  compatible with on-demand helper bootstrap for exec/screenshot/window actions.
- `device_status`, `device_start`, `device_stop`, and `device_delete` use the
  host broker by default for host-backed owner devices. If the broker is down or
  cannot be reached, the MCP reports a structured broker error so CCC can start
  or repair the broker; it does not silently fall back to a local owner
  namespace. If `backend` is omitted, broker inventory can infer it from the
  owner device id. Legacy explicit route flags remain accepted by the
  implementation for diagnostics, but the public schemas omit them so normal
  agents do not have to choose a transport path.
- `device_create` uses the host broker by default for creatable host-backed
  backends. If the broker is down or cannot be reached, MCP reports a structured
  broker error instead of creating a container-local definition. Because
  `device_create.port` is already the Android emulator port, legacy broker-port
  overrides use `brokerPort`; implicit broker create sanitizes that collision
  and treats `port` as device metadata. The public schema hides `brokerPort`
  because broker transport is selected automatically.
- `device_inventory` and `device_record_video_status` can also use a reachable
  owner broker for read-only owner-state routing. Implicit routing is enabled for
  backend-specific inventory calls and device-id recording status checks when a
  broker is already reachable. These routes never start devices; when broker
  routing is required but no usable broker is reachable, they return a
  structured broker-unavailable diagnostic instead of falling back to local
  direct-provider state. `implicitBroker:false` remains available for explicit
  local diagnostics and fake-provider tests.
- `device_record_video_start` and `device_record_video_stop` can route through
  `broker.device.tool.invoke` only when the caller explicitly requests broker
  mode. The broker starts/stops owner-scoped Android `adb screenrecord` and iOS
  Simulator `simctl recordVideo` processes, records host-broker ownership in the
  owner device definition, keeps foreign owner state untouched, and reports
  explicit `directProviderFallback` diagnostics for recording paths that remain
  helper/direct-provider backed.
- Environment variables are not required for broker discovery, RPC, physical
  lease/lifecycle command operations, broker-routed Appium mobile actions, or
  broker-routed Android/iOS Simulator recording operations. Remaining
  non-lifecycle helper/file/app/image routes are classified as explicit
  direct-provider paths until they need host-broker process ownership.

Host broker daemon skeleton status:

- `ccc devices broker status` is the normal user-facing broker command. It
  prints the host broker's default bind address, port, current owner namespace,
  state roots, implemented HTTP status/health surface, secret-backed owner RPC
  auth, Appium broker routing coverage, and host service-manager availability
  without starting any devices. The top-level host CLI status route first runs
  broker readiness reconciliation, so a missing broker, stale runtime metadata,
  incompatible broker version/contract, or missing service-manager owner
  metadata is treated as a repair target instead of a user-facing
  install/start/stop workflow.
- User instructions, recovery procedures, and operator documentation must use
  the installed `ccc` command. Direct execution of `dist/index.js` is reserved
  for repository-internal build and test harnesses and is not a supported
  operator interface.
- Broker autolaunch E2E uses an isolated temporary home directory. It must not
  replace the host-managed runtime metadata under the operator's shared
  `~/.ccc/devices` mount, including when a test broker exits unexpectedly.
- Host `ccc` starts the broker daemon automatically before launching or
  reusing a project container. `ccc devices broker serve` remains as the
  internal daemon entrypoint, but normal users and agents should not need to
  call it directly. The server currently exposes `GET /health`, `GET /status`,
  and owner-scoped `POST /v1/owners/<owner-id>/rpc` for broker
  status/inventory/echo, owner runtime cleanup, physical lease
  claim/list/release, lifecycle command plan/invoke methods, and
  `broker.device.tool.invoke` routes for `device_inventory`,
  `device_record_video_status`, `device_record_video_start`, and
  `device_record_video_stop`. It also exposes `broker.apple.trust` for iOS
  real-device trust/network-pairing diagnostics and `broker.service.manager`
  for authenticated status-only service-manager diagnostics. Linux hosts use a
  user `systemd` unit, macOS hosts use a user LaunchAgent, Windows hosts use a
  user scheduled task, and unsupported or missing managers return explicit
  diagnostics. Service-manager install/uninstall/start/stop are not public
  broker, CLI, or MCP actions; host CCC auto-starts or reuses the broker during
  normal container/device-lab entry points. It returns JSON errors for
  unsupported methods/routes and rejects missing owner tokens, owner mismatches,
  invalid JSON, oversized requests, invalid lease or command params,
  cross-owner lease operations, unknown methods, missing provider metadata, and
  failed provider commands.
- Service-manager verbs remain implementation hooks for broker diagnostics,
  tests, and automatic repair, but they are not user CLI operations. Routine
  recovery goes through `ccc devices broker status` rather than asking users to
  choose install/start/stop.
- MCP can shut down this broker and can still use legacy explicit autolaunch for
  diagnostics; normal lifecycle tools, mobile Appium tools, and read-only
  owner-state inventory/recording status tools automatically use an already
  reachable owner broker. Recording start/stop uses broker routing for Android
  and iOS Simulator when available, while helper-backed desktop recording and
  file/app/image operations remain direct-provider unless a later slice needs
  central broker ownership for their host processes.

## MCP tools

Start with one common MCP namespace, then expose backend-specific fields in
structured responses.

Required common tools:

1. `device_backends`
   - Lists detected backends, host support, missing prerequisites, and
     capabilities.
   - Includes `x11-current-display` as an always-current screen-control target
     when the CCC X11 bridge is available.

2. `device_list`
   - Lists owned device definitions and running instances.
   - Does not show devices owned by other CCC containers.
   - Includes current non-creatable targets, such as X11, with
     `creatable=false`.

3. `device_inventory`
   - Lists owner-scoped device definitions and backend host/provider inventory
     without starting heavy resources.
   - Supports Android Emulator, physical Android, iOS Simulator, physical iOS,
     Windows Sandbox, and macOS VM backends.

4. `device_create`
   - Creates a device definition in the current owner namespace.
   - When a host broker is reachable, creatable host backends can write the
     definition in the host owner namespace instead of the container-local state
     root. This route remains metadata-only and does not boot VMs, emulators,
     simulators, or sandboxes.
   - Inputs: backend, name, image/runtime, device type, preset.

5. `device_delete`
   - Deletes an owned stopped device definition.
   - Refuses running devices unless `force` is true.

6. `device_attach`
   - Attaches a host-connected physical device to the current owner namespace.
   - Android USB attach requires a visible `adb devices -l` serial in `device`
     state. Android Wi-Fi attach accepts `connection: "wifi"` with `host` and
     optional `port`, runs `adb connect <host>:<port>`, then requires the
     resulting `host:port` serial to be visible in `device` state.
   - iOS USB or Wi-Fi attach requires a visible `xcrun xctrace list devices`
     UDID on a macOS host. Wi-Fi attach records network transport metadata only
     after Xcode/network pairing and trust already make that UDID visible.
   - Does not create, power on, or globally lock physical hardware outside the
     current CCC owner state.

7. `device_detach`
   - Removes an owned physical-device attachment and clears local volatile
     session metadata.
   - Does not power off, erase, disconnect, or otherwise mutate the physical
     device.

8. `device_start`
   - Starts or attaches to an owned device instance.
   - Returns readiness state, endpoint metadata, and next useful actions.

9. `device_stop`
   - Stops an owned running instance.
   - For physical devices, this is metadata/session cleanup only and leaves the
     device attached to the host.

10. `device_status`
   - Reports lifecycle, boot readiness, logs, ports, and known errors.

11. `device_exec`
   - Runs a command where supported.
   - Android uses `adb shell`; iOS uses `simctl spawn` where supported; Windows
     and macOS VM may use a guest helper for stdout/stderr.

12. `device_screenshot`
   - Captures screen evidence to an owner-scoped artifact path.

13. `device_click` / `device_double_click` / `device_key` /
    `device_type` / `device_scroll` / `device_cursor_position`
    - Provides desktop-style GUI control for VM/sandbox backends where a guest
      control channel is available.
    - Windows Sandbox implements these through the guest helper file channel.

14. `device_base_image_create` / `device_base_image_clone`
    - Creates and clones owner-scoped VM base-image/device definitions where
      supported.
    - macOS Tart uses provider clone operations to create a stopped device
      definition from a provider base image or existing owned provider
      instance.
    - The pre-release `device_image_create` / `device_image_clone` spellings
      are not accepted; callers use the canonical base-image tool names.
    - Unsupported macOS VM providers must return explicit diagnostics.

15. `device_snapshot_create` / `device_snapshot_restore` /
    `device_snapshot_delete`
    - Manages owner-scoped VM snapshots where supported.
    - macOS Tart represents snapshots as owner-scoped provider clones and
      refuses running-device snapshot/restore operations unless `force` is set.

16. `device_record_video_start` / `device_record_video_stop` /
    `device_record_video_status`
    - Starts, stops, and inspects owner-scoped video recording state.
    - Android uses `adb shell screenrecord`, with a bounded
      `--time-limit` and an optional local artifact path.
    - iOS Simulator uses `xcrun simctl io <target> recordVideo`.
    - Windows Sandbox uses the guest-helper file channel to produce an
      owner-scoped frame archive artifact when a native guest encoder is not
      guaranteed to exist.
    - macOS VM uses the configured SSH bridge to start `screencapture` video
      capture, stop it, and download the owner-scoped artifact.
    - `device_record_video_status` is read-only and can route through a
      reachable owner broker to inspect owner recording metadata without
      starting devices. `device_record_video_start` and
      `device_record_video_stop` use broker routing for Android emulator/device
      and iOS Simulator processes; Windows Sandbox and macOS VM continue to use
      their helper-backed host paths, while physical iOS recording is reported
      as unsupported.

17. `device_upload` / `device_download`
    - Transfers files through owner-scoped scratch paths.

18. `device_install_app` / `device_launch_app`
    - Installs and launches APK, `.app`, `.ipa` where supported, or Windows/macOS
      app bundles where a backend supports it.

19. `device_reset`
    - Resets owned device state without deleting the definition.

Optional future tools:

- `device_network_set`
- `device_artifacts`

Mobile interaction tools:

- `mobile_tap`
- `mobile_double_tap`
- `mobile_long_press`
- `mobile_swipe`
- `mobile_drag`
- `mobile_pinch`
- `mobile_rotate`
- `mobile_type_text`
- `mobile_key`
- `mobile_home`
- `mobile_back`
- `mobile_forward`
- `mobile_recents`
- `mobile_power`
- `mobile_lock`
- `mobile_unlock`
- `mobile_rotate_left`
- `mobile_rotate_right`
- `mobile_set_orientation`
- `mobile_open_url`
- `mobile_install_app`
- `mobile_uninstall_app`
- `mobile_launch_app`
- `mobile_stop_app`
- `mobile_clear_app_data`
- `mobile_grant_permission`
- `mobile_revoke_permission`
- `mobile_set_location`
- `mobile_set_battery`
- `mobile_set_network`
- `mobile_toggle_airplane_mode`
- `mobile_set_clipboard`
- `mobile_get_clipboard`
- `mobile_screenshot`
- `mobile_record_video`
- `mobile_dump_ui`
- `mobile_wait_for_text`
- `mobile_wait_for_app`

These tools should map to backend-specific primitives:

- Android: `adb shell input`, `adb shell am`, `adb shell pm`, emulator console,
  `uiautomator dump`, `screencap`, and provider APIs where available.
- iOS Simulator: `xcrun simctl`, Simulator UI scripting where needed, and
  supported runtime controls such as boot, shutdown, install, launch,
  screenshot, video, privacy, status bar, and location.

Not every mobile action is available on every backend. Tool responses should
return a clear unsupported capability error instead of silently approximating a
different action.

Android direct-ADB action status:

- Android primitive mobile actions now cover tap, double tap, long press,
  swipe, text input, arbitrary keyevent, home, back, forward, recents, power,
  lock, unlock, open URL, and screenshot through direct `adb` commands.
- These primitive actions require only an owner-scoped Android device
  definition and `adb`; they do not start Appium or create an Appium session.
- `mobile_dump_ui` remains Appium-backed because UI hierarchy is stronger
  through WebDriver/Appium until a direct `uiautomator dump` layer is added.
- Tests use fake Android SDK commands to verify serial-targeted ADB command
  mapping and missing-prerequisite behavior without requiring a real emulator.

Android direct UI hierarchy status:

- `mobile_dump_ui` now uses direct `adb shell uiautomator dump` plus
  `adb exec-out cat` for owner-scoped Android devices when `adb` is available.
- This path returns provider metadata, the remote XML path, and XML/source text
  without starting Appium or creating an Appium session.
- Unknown/non-Android device IDs still no-match the Android handler so later
  backends can respond, while Android definitions without `adb` receive clear
  missing-prerequisite diagnostics.
- Appium remains available for future richer provider selection, but direct
  UIAutomator is the default Android UI dump path in this slice.

Android advanced mobile action status:

- The MCP surface now exposes richer mobile experiment primitives:
  drag, rotation/orientation, permission grant/revoke, location, battery,
  network, airplane mode, clipboard, wait-for-text, and wait-for-app.
- Android implements these through direct owner-targeted ADB commands and
  emulator console commands where appropriate. These actions do not start
  Appium, boot an emulator, or create a WebDriver session.
- `mobile_wait_for_text` uses the direct UIAutomator dump path with bounded
  polling, while `mobile_wait_for_app` polls `pidof` through ADB.
- Tests verify fake-ADB command mapping for these advanced actions without a
  real Android SDK or emulator.

iOS simctl mobile action status:

- Shared `mobile_*` routing now lets Android handlers return no-match for
  non-Android device IDs, so iOS Simulator definitions can handle supported
  mobile tools in the same MCP namespace.
- iOS Simulator supports `mobile_open_url`, `mobile_install_app`,
  `mobile_launch_app`, and `mobile_screenshot` through direct `simctl`
  commands.
- Coordinate gestures and keyboard-style mobile controls are routed through the
  lazy Appium/XCUITest layer when direct `simctl` does not provide the action.
- Tests use fake `xcrun` commands and a fake Appium HTTP server to verify iOS
  mobile action routing and command mapping without requiring macOS or Xcode.

File and app primitive status:

- Common MCP tools now expose `device_upload`, `device_download`,
  `device_reset`, `device_install_app`, and `device_launch_app` so agents can
  run basic app verification flows through backend-neutral tool names.
- Android implements file transfer and app lifecycle primitives through direct
  serial-targeted `adb` commands: `push`, `pull`, `install`, `monkey` or
  `am start`, `pm clear`, `uninstall`, and `am force-stop`.
- Android mobile app aliases (`mobile_install_app`, `mobile_launch_app`,
  `mobile_uninstall_app`, `mobile_stop_app`, and `mobile_clear_app_data`) use
  the same direct ADB path and do not start Appium.
- iOS Simulator keeps app install/launch on `simctl install` and
  `simctl launch`. File upload/download resolve an app container through
  `simctl get_app_container <target> <bundleId> <containerType>` and copy files
  only inside that container. `device_reset` can clear app-container contents
  by `bundleId` or erase an owner-prefixed simulator through `simctl erase`.
- Tests use fake Android SDK and fake `xcrun` commands to verify command
  mapping without requiring real devices or SDK installations.

Current-display tools:

- `display_current`
- `display_screenshot`
- `display_click`
- `display_double_click`
- `display_key`
- `display_type`
- `display_scroll`
- `display_cursor_position`

These replace the standalone generated X11 MCP entry in CCC-managed MCP config.

## Backend plans

### Android Emulator

Prerequisites:

- Android SDK detected on host.
- `emulator`, `adb`, and at least one system image or an installed AVD.
- CCC-managed Appium server and UiAutomator2 driver installed or installable by
  CCC without user configuration.

Implementation:

1. Discover SDK paths and AVDs.
2. Create CCC-owned AVDs with names prefixed or tagged by owner ID.
3. Allocate deterministic, owner-scoped emulator ports from a broker-managed
   pool.
4. Start emulator lazily and wait for `adb shell getprop sys.boot_completed`.
5. Start an owner-scoped Appium session for high-level app/UI automation.
6. Expose shell, install APK, screenshot, logcat tail, Appium actions, and
   shutdown.

Foundation status:

- The first implementation slice exposes owner-scoped Android device
  definitions through `device_create`, `device_list`, `device_status`, and
  `device_delete`.
- It discovers `adb`, `emulator`, and `avdmanager` from PATH first, then
  Android Studio SDK defaults such as `%LOCALAPPDATA%/Android/Sdk`,
  `~/Android/Sdk`, `~/Library/Android/sdk`, `/opt/android-sdk`, and
  `/usr/local/android-sdk`. Missing-prerequisite diagnostics therefore mean
  the tools were not found in PATH or those zero-configuration SDK locations;
  CCC-specific environment variables are not required. Discovery also scans
  versioned `cmdline-tools/<version>/bin` directories, not only
  `cmdline-tools/latest/bin`, so Android Studio command-line tools installed
  under a numbered SDK package are picked up without PATH edits.
- `device_start`, `device_stop`, `device_exec`, and `device_screenshot` are
  wired to Android command-line tools when available, but MCP startup and
  discovery calls remain lazy and do not start emulator or adb processes.
- Appium integration is implemented for high-level Android UI/app automation,
  app lifecycle, file/app state helpers, device controls, and environment
  controls. Android provider hardening now covers explicit backend-hint
  collision handling between emulator and physical-device state.

Appium Android layer status:

- `device-lab-mcp` declares CCC-managed `appium` and
  `appium-uiautomator2-driver` dependencies so normal users do not manually
  install Appium drivers for Android automation.
- Android mobile tools cover session/UI inspection, screenshots, taps and
  gestures, text/key input, navigation/device controls, app install/launch/
  lifecycle, permissions, location, battery, network, clipboard, and wait
  helpers.
- Broker-routed mobile tools share the host-broker Appium session/request path
  used by iOS and physical devices automatically when broker owner state is
  reachable; the container remains the MCP router, not the Appium process owner.
  This route covers UI inspection, gestures, device controls,
  screenshots, URL navigation, app lifecycle, location, clipboard, and app/text
  waits through Appium endpoints where available.
- Android broker-routed key and hardware controls use `press_keycode`, and
  reverse orientation plus app-data clearing route through Appium
  `mobile: shell` so the tool schema and runtime behavior remain aligned with
  direct Android paths.
- Appium server/session startup remains lazy. Discovery, device listing, and
  session status report metadata and missing prerequisites without starting
  Appium.
- Mobile tools operate through owner-scoped Android device definitions and
  return missing-prerequisite diagnostics when Appium/adb are unavailable.
- Host-backed Android emulator and physical-device Appium server/session
  metadata can now be started, stopped, recorded, listed, inspected, cleared,
  created, deleted, and accessed through bounded broker WebDriver requests. The
  existing high-level Android mobile handlers for UI, gestures, navigation,
  screenshots, app lifecycle, URLs, location, clipboard, and waits can use this
  broker path automatically when the owner device is broker-backed; the
  container-local Appium dependency remains an explicit fallback when the device
  transport is reachable from the container.

AVD provisioning hardening status:

- Android discovery now reports `avdmanager` separately from lifecycle
  prerequisites. Missing `adb`/`emulator` blocks lifecycle actions, while
  missing `avdmanager` blocks only real AVD create/delete provisioning.
- `device_inventory` reports owner-scoped Android definitions and host AVD
  names through `emulator -list-avds` without starting emulators.
- `device_create` can create a real AVD when `createAvd=true` is explicitly
  provided, but only for CCC owner-prefixed AVD names.
- `device_delete` deletes a real AVD only when `deleteAvd=true`, the definition
  is stopped or forced, and the AVD name belongs to the current owner prefix.
- `device_start` remains lazy, refuses non-owned AVD names when lifecycle tools
  are available, and now waits for `adb shell getprop sys.boot_completed` by
  default when `adb` is available, while preserving an explicit
  `waitForBoot=false` path for callers that only need process launch.

Android provider routing hardening status:

- Direct Android emulator and physical-device handlers now honor explicit
  `backend` hints before touching provider state or running ADB/emulator
  commands.
- If a caller supplies a backend hint that conflicts with the only matching
  owner-scoped device id, the dispatcher returns a structured
  `device-backend-mismatch` diagnostic instead of falling through to the first
  Android handler in dispatch order.
- When the same owner-scoped `deviceId` exists in both Android emulator and
  physical-device state, explicit `backend` hints route to the requested
  provider, so Android real-device commands cannot accidentally operate on an
  emulator with the same id and emulator commands cannot accidentally operate on
  the physical attachment.
- Fake Android tests cover the collision, mismatch, no-provider-command, and
  no-real-hardware paths without requiring a real Android SDK, emulator, Appium
  server, or physical phone.

Physical Android device attachment status:

- `android-device` is a separate non-creatable backend for real devices
  connected to the CCC host over USB or an already configured ADB transport.
- Users connect the device to the host, enable Developer Options and USB
  debugging, approve the RSA trust prompt, and CCC verifies that
  `adb devices -l` reports the serial in `device` state.
- For Android Wi-Fi debugging, callers may pass `connection: "wifi"`, `host`,
  and optional `port` to `device_attach`; the backend runs `adb connect` and
  stores the `host:port` ADB serial plus owner-scoped Wi-Fi transport metadata.
  The owner/lease checks run before `adb connect` when the target `host:port`
  is known, so an already-leased device cannot trigger a host-global ADB
  connection attempt. Android pairing/authorization must already be accepted by
  Android/ADB.
- `device_wireless` exposes the pre-attachment wireless bootstrap steps without
  creating an owner device record or lease. For a USB-trusted phone it can run
  `adb -s <serial> tcpip <port>` and optionally `adb connect <host>:<port>`.
  For Android 11+ wireless debugging it can run `adb pair <pairHost>:<pairPort>
  <pairingCode>` and optionally `adb connect <host>:<port>`. The user still
  needs to provide the pairing code shown by Android, and `device_attach`
  remains the step that claims owner-scoped access after the transport is
  visible.
- `device_inventory` reports host ADB devices, including unauthorized/offline
  states and Wi-Fi ADB transports, without claiming or starting anything.
- `device_attach` stores an owner-scoped lease for a real serial and refuses
  `emulator-*`, unauthorized, offline, missing, duplicate, or already-owned
  serials in the current owner namespace.
- Physical serials are additionally protected by host-wide hardware lock files
  under `~/.ccc/devices/physical-leases/android-device/locks`, so two CCC
  owners cannot attach and command the same phone at the same time.
- Direct Android/iOS physical detach validates the exact lease claim and
  commits owner-record removal with lease removal as one fenced mutation. A
  lease conflict, owner-state conflict, or persistence failure returns an
  error and preserves or rolls back both records for a retry; detach never
  reports success while leaving an orphan hardware lease.
- The host broker backs Android physical leases, attach/detach/list, and
  pre-attachment wireless operations. Public `device_wireless` routes to the
  host without requiring an owner device record or `deviceId`, so a container
  does not need its own ADB installation. Public
  `device_attach`/`device_detach` perform the owner-scoped attach path. Broker
  Wi-Fi attach performs lease-before-`adb connect`, verifies `adb devices -l`,
  and records owner-scoped attached-device state.
- Public `device_attach`/`device_detach` use the same host broker path. If no
  usable broker can be reached, they report a structured broker-unavailable
  error instead of silently mutating a container-local physical-device
  namespace. `device_detach` can infer the physical backend from broker
  inventory, so callers normally do not need to provide a backend to detach.
  Attach/detach uses a 30-second broker RPC execution timeout by default even
  when broker discovery uses a shorter health-probe timeout. Hidden legacy
  direct-local flags remain accepted only for diagnostics and fake-provider
  tests.
- `device_start` is a no-op readiness acknowledgement for physical Android
  devices; `device_stop` clears Appium/recording/pid metadata and leaves the
  phone attached; `device_detach` removes only the CCC owner lease.
- Safe ADB-backed actions are exposed for shell exec, screenshot, UI dump,
  tap/key/navigation, app install/launch/reset, file transfer, clipboard, and
  wait helpers. Emulator-only mutation such as battery/network simulation
  returns explicit diagnostics for real devices.
- Cleanup on container teardown may stop owner-scoped Appium/screenrecord
  helper processes, clear volatile metadata, mark the physical attachment
  detached, and release the host-wide hardware lock, but it never sends
  `adb emu kill` to physical-device serials.
- In a dedicated real-device lab, an Android phone that is already connected by
  USB, trusted by ADB, and visible as `device` can participate in unattended
  smoke tests after the lab runner assigns an owner lease. The test harness may
  attach, run non-destructive commands, collect screenshots/UI dumps/Appium
  evidence, and detach/release the lease, but it must not assume it can approve
  the Android trust prompt or physically reconnect the cable.

### iOS Simulator

Prerequisites:

- macOS host.
- Xcode installed and selected.
- `xcrun simctl` available.
- CCC-managed Appium server and XCUITest driver installed or installable by CCC
  without user configuration.

Implementation:

1. Discover runtimes and device types with `simctl list`.
2. Create owner-prefixed simulator devices.
3. Boot with `simctl boot`, wait for readiness, and open Simulator only when GUI
   interaction is requested.
4. Start an owner-scoped Appium session for high-level app/UI automation, using
   XCUITest/WebDriverAgent where available.
5. Expose app install, app launch, screenshot, video where available, Appium
   actions, reset, and shutdown.

Foundation status:

- The first iOS implementation slice exposes owner-scoped iOS Simulator
  definitions through the common `device_create`, `device_list`,
  `device_status`, and `device_delete` tools.
- `ios-simulator` backend discovery reports `xcrun` availability and missing
  prerequisites without requiring macOS/Xcode in normal Linux CI.
- `device_start`, `device_stop`, and `device_screenshot` are wired to
  `xcrun simctl` when available, but MCP startup, backend discovery, and device
  listing remain lazy and do not boot simulators.
- Real `simctl create/delete`, app install/launch, screenshot, recording,
  Appium/XCUITest UI dump, app-container file transfer, and reset flows are
  implemented with fake-`xcrun` CI coverage so normal Linux tests do not
  require macOS/Xcode.

simctl provisioning hardening status:

- `device_inventory` reports owner-scoped iOS Simulator definitions and host
  `simctl list -j` inventory without booting simulators.
- `device_create` stores iOS metadata by default. It calls `simctl create` only
  when `createSimulator=true`, `deviceType`, and `runtime` are provided, and
  the simulator name uses the current CCC owner prefix.
- `device_delete` removes metadata by default. It calls `simctl delete` only
  when `deleteSimulator=true`, the stored simulator name is owner-prefixed, and
  the definition is stopped unless `force=true`.
- `device_start` remains lazy, refuses non-owned simulator names when `xcrun`
  is available, and waits for `simctl bootstatus <target> -b` by default with a
  bounded timeout.
- Linux CI coverage uses fake `xcrun` commands, so the provisioning behavior is
  tested without requiring macOS or Xcode.

iOS Simulator file transfer and reset status:

- `device_upload` requires `bundleId`, resolves the requested app container
  with `simctl get_app_container`, strips leading slashes from `remotePath`,
  rejects path traversal, and copies the host file into the container.
- `device_download` uses the same container resolution and path containment
  checks before copying a container file back to the requested host path.
- `device_reset` with `bundleId` clears the resolved app container contents.
- `device_reset` with `eraseSimulator=true` calls `simctl erase` only for
  owner-prefixed simulator definitions, marks the stored simulator stopped, and
  clears boot readiness metadata.
- Tests cover successful upload/download/reset, missing bundle diagnostics,
  path traversal refusal, owner-guarded erase, and fake `xcrun`
  `get_app_container`/`erase` command traces.

iOS Appium/XCUITest foundation status:

- `device-lab-mcp` declares CCC-managed `appium-xcuitest-driver` alongside
  Appium so users do not manually install the iOS automation driver.
- `ios-simulator` advertises `mobile_session_status` and `mobile_dump_ui`
  capabilities through the common mobile tool surface.
- `mobile_session_status` reports owner-scoped device metadata,
  Appium/XCUITest discovery, `automationName: "XCUITest"`, `session: null`, and
  `lazy: true` without starting Appium, booting simulators, or creating a
  WebDriver session.
- `mobile_dump_ui` returns explicit missing-prerequisite diagnostics when
  `xcrun`, Appium, the XCUITest driver, or `xcodebuild` are unavailable.
- Tests cover both Linux missing-prerequisite diagnostics and fake
  Appium/XCUITest discovery without requiring real macOS, Xcode, or Appium.
- iOS and iOS Simulator Appium/XCUITest server/session metadata can now be
  started, stopped, recorded, listed, inspected, cleared, created, deleted, and
  accessed through bounded broker WebDriver requests because Xcode, Simulator,
  WebDriverAgent, and device trust state are host resources. Existing
  high-level iOS mobile handlers for UI, gestures, navigation, screenshots, app
  lifecycle, URLs, location, clipboard, and waits can use this broker path
  automatically when the owner device is broker-backed; container-local Appium
  remains a compatibility bridge for tests and explicitly reachable transports.

Physical iOS device attachment status:

- `ios-device` is a separate non-creatable backend for real iPhones/iPads
  connected to a macOS host over USB or already paired for Xcode network use
  and trusted through the iOS "Trust This Computer" prompt.
- Host attach/status inventory requires `xcrun xctrace`; full Appium/XCUITest
  automation still reports its own `xcodebuild`, driver, signing, and
  provisioning requirements separately.
- `device_inventory` parses `xcrun xctrace list devices` and excludes simulator
  entries so agents see only physical-device UDIDs.
- `device_attach` accepts `connection: "wifi"` for iOS only when the UDID is
  already visible to `xctrace` as a network device; it records network transport
  metadata but does not attempt to create or bypass Apple network pairing.
- `device_wireless` for `ios-device` reports Xcode/xctrace network visibility
  and returns explicit diagnostics for pairing/connect actions. Apple trust,
  Developer Mode, and Xcode network pairing must already be satisfied on the
  macOS host; CCC does not automate or bypass the iOS trust prompt.
- `device_attach` stores an owner-scoped lease for a visible UDID and refuses
  missing or duplicate UDIDs in the current owner namespace.
- Physical UDIDs are additionally protected by host-wide hardware lock files
  under `~/.ccc/devices/physical-leases/ios-device/locks`, so two CCC owners
  cannot attach and command the same iPhone/iPad at the same time.
- The host broker backs iOS physical leases, attach/detach/list, and Apple
  trust/Xcode network-pairing readiness diagnostics. Public `device_wireless`
  exposes the readiness check and manual-required remediation, while public
  `device_attach` performs the attach path. Broker attach validates the UDID
  through `xcrun xctrace list devices`; Apple trust and network pairing must
  still be completed through the normal macOS/iOS prompts and Xcode UI.
- `device_start` is a no-op readiness acknowledgement; `device_stop` and
  teardown cleanup clear owner-scoped Appium/recording/pid metadata but never
  call `simctl shutdown`, erase, power off, or disconnect the physical device.
  Teardown cleanup also marks the attachment detached and releases the
  host-wide hardware lock so later CCC owners can attach the same trusted
  device.
- In a dedicated real-device lab, an iPhone/iPad that is already connected by
  USB, trusted by the macOS host, has Developer Mode/signing prerequisites
  satisfied, and is visible to Xcode tooling can participate in unattended smoke
  tests after the lab runner assigns an owner lease. The harness may attach,
  validate Xcode/Appium/XCUITest readiness, run non-destructive screenshot/UI/app
  checks, collect artifacts, and detach/release the lease, but it must not try
  to bypass the iOS trust prompt, unlock the device, accept Developer Mode
  prompts, or create signing/provisioning state on behalf of the user.
- `mobile_session_status` reports lazy Appium/XCUITest discovery and current
  session metadata for the attached physical device.
- `mobile_dump_ui`, `device_screenshot`, and `mobile_screenshot` lazily start
  an owner-scoped Appium/XCUITest session bound to the physical UDID and use
  WebDriver `/source` and `/screenshot`.
- `device_install_app`/`mobile_install_app` and
  `device_launch_app`/`mobile_launch_app` use `xcrun devicectl` against the
  attached UDID. These operations still depend on normal Apple trust, signing,
  provisioning, and Xcode device-control availability.

iOS Appium/XCUITest session status:

- `mobile_dump_ui` now starts an owner-scoped Appium server lazily only when an
  explicit iOS UI dump is requested and all Appium/XCUITest prerequisites are
  available.
- The iOS Appium server port is derived from the current owner and device id,
  and session metadata is stored on the owner-scoped iOS device definition.
- Healthy Appium sessions are reused after `mobile_dump_ui`; stale sessions are
  detected through Appium status/session checks and cleared before creating a
  replacement session.
- XCUITest sessions use deterministic capabilities:
  `platformName: "iOS"`, `appium:automationName: "XCUITest"`, device name from
  the simulator definition, and UDID when available.
- `mobile_dump_ui` returns Appium source output through
  `GET /session/<id>/source` with provider `appium-xcuitest`.
- Appium/XCUITest also handles iOS Simulator and physical iOS
  `mobile_tap`, `mobile_double_tap`, `mobile_long_press`, `mobile_swipe`,
  `mobile_drag`, `mobile_type_text`, `mobile_key`, `mobile_home`,
  `mobile_lock`, `mobile_unlock`, rotation/orientation commands, and bounded
  `mobile_wait_for_text`. Physical iOS additionally supports
  `mobile_wait_for_app` through Appium active-app inspection and
  `mobile_stop_app` through the owner-scoped XCUITest session.
- Linux CI coverage uses a fake Appium HTTP server plus fake `xcrun`,
  `appium-xcuitest-driver`, and `xcodebuild`, so lazy start, session reuse,
  stale session cleanup, UI source retrieval, and Appium command payloads are
  tested without real macOS/Xcode/Appium.

iOS advanced mobile action status:

- iOS Simulator handles base `simctl` advanced actions for permission
  grant/revoke, location, clipboard set/get, and wait-for-app, and handles
  coordinate/system UI controls through Appium/XCUITest.
- These actions remain lazy and require only an owner-scoped iOS Simulator
  definition plus `xcrun` for direct simctl paths; Appium-backed paths lazily
  start the owner-scoped XCUITest server only when needed.
- iOS Simulator still returns explicit unsupported diagnostics for actions
  without a reliable iOS Simulator mapping in this backend, including Android
  style back/forward/recents/power and battery/network/airplane controls.
- Physical iOS devices return explicit unsupported diagnostics for controls
  that are unavailable or unsafe on real hardware through CCC, including
  back/forward/recents/power, battery/network/airplane simulation, clipboard
  simulation, location simulation, permission mutation, app data clear,
  open-url, and uninstall.
- Tests use fake `xcrun` command logs and fake Appium request logs to verify
  supported mappings and remaining diagnostics without requiring macOS or
  Xcode.

Batched mobile flow status:

- `mobile_run_flow` runs a bounded sequence of mobile verification steps through
  the same backend handlers as normal MCP tool calls.
- Flow execution preserves owner-scoped routing, lazy startup, missing
  prerequisite diagnostics, and backend-specific unsupported-capability
  behavior because it does not bypass the existing tool handlers.
- Allowed steps are mobile tools plus read-only `device_status` and
  `device_screenshot`. Lifecycle mutation such as `device_create`,
  `device_start`, `device_stop`, and `device_delete` is rejected with a clear
  per-step diagnostic.
- Responses return structured per-step summaries. JSON/text results are parsed
  or summarized, and image results report MIME type and byte count without
  embedding large screenshot payloads in the flow JSON.
- Tests verify successful Android flow sequencing, UI wait result parsing,
  image summary behavior, disallowed lifecycle step rejection, and that direct
  Android flows do not start Appium.

Batched target-neutral flow status:

- `device_run_flow` runs a bounded sequence of verification steps through the
  existing device-lab handlers for current X11 display targets, desktop
  VM/sandbox targets, mobile automation targets, and read-only device queries.
- It shares the same per-step summary format as `mobile_run_flow`, including
  parsed JSON/text summaries and compact image summaries with MIME type and byte
  count.
- The target-neutral flow intentionally rejects lifecycle, destructive,
  file-transfer, snapshot mutation, recording status/start/stop paths with
  backend cleanup or copy side effects, and unknown steps with per-step
  diagnostics. `stopOnError` controls whether later allowed steps still run
  after a rejected or failed step, including allowed handlers that return
  structured `{ ok: false }` diagnostics.
- Target-neutral mobile verification steps include safe navigation, touch,
  text/key input, orientation, URL, screenshot/UI dump, wait-for-text/app,
  status, and clipboard set/get actions. Clipboard set/get is intentionally
  allowed as a non-destructive verification primitive so a flow can prepare and
  then assert mobile clipboard state without falling back to separate direct
  MCP calls.
- Tests verify tool exposure, display-only flow execution, `name`/`tool` step
  aliases, stop-on-error behavior, disallowed lifecycle/file-transfer/app
  mutation/recording diagnostics, safe mobile clipboard set/get flow execution,
  semantic `{ ok: false }` failures, mixed Android device/mobile flow
  execution, and image summary behavior.
- Broker-backed Android clipboard set/get uses the owner-scoped Appium session
  instead of Android's inconsistent shell clipboard command. Broker discovery
  keeps its short health-probe timeout, while lazy Appium startup/session work
  uses a separate bounded RPC timeout and waits for `/status` readiness.
  The host broker provisions Appium and both mobile drivers once under
  `~/.ccc/devices/broker/appium-runtime` from CCC's packaged, locked
  `device-lab-mcp` manifest. Keeping this runtime outside the project prevents
  a running Appium process from locking or corrupting project `node_modules`
  during `npm install`. Android SDK paths discovered by CCC and Android
  Studio's bundled Java runtime are passed only to the Appium child process
  when the host environment does not already provide them.
- Windows host Appium receives a broker-generated Node preload through its
  child-only `NODE_OPTIONS`. The preload forces `windowsHide: true` across
  `spawn`, `exec`, `execFile`, and `fork` sync/async variants, including the
  ADB/Java subprocesses created inside Appium drivers. It preserves existing
  `NODE_OPTIONS`, does not mutate the user's environment, and prevents Level 3
  runs from repeatedly flashing console windows.
- Level 3 and Vitest also preload the same hidden-child policy for the complete
  test process tree. This overrides the MCP SDK stdio transport's normal
  Windows `windowsHide: false` choice, so repeated MCP server sessions, broker
  auto-start, and their descendants do not open transient console windows.
  The normal `npm test` and `npm run test:watch` commands start Vitest through
  the same preload wrapper, covering worker processes created before Vitest
  setup files run.
- Broker-owned Appium now launches the runtime's `appium/index.js` directly
  with the host Node executable instead of retaining an `appium.cmd` parent.
  The recorded PID therefore belongs to the actual server. Appium metadata
  carries a hidden-launch policy version; missing/old policy records are
  replaced automatically. On Windows, replacement uses `taskkill /T` and also
  removes a surviving CCC-managed Appium listener on the reserved port, which
  migrates orphan processes created by older releases without manual cleanup.
  The host broker advertises `windows-hidden-provider-children-v6` as a
  required compatibility capability, so a same-package-version broker that was
  started before this policy is automatically restarted instead of reused.
  The v6 policy is inherited by every broker provider process, including the
  npm Appium runtime installer, backend Node children, the Appium server, and
  Appium's adb/java descendants; sync and detached launches both retain
  `windowsHide: true` and the Node preload is de-duplicated in `NODE_OPTIONS`.
  The preload calls `syncBuiltinESMExports()` after patching `child_process`,
  ensuring ESM consumers such as the MCP SDK do not retain their original
  visible-window `spawn` binding.
  Hyper-V setup and network elevation also pass `-WindowStyle Hidden` to their
  nested `Start-Process` calls, preventing transient PowerShell console windows
  that bypass Node's outer `windowsHide` option. Intentional provider UI, such
  as the Windows Sandbox window, remains visible.
  When MCP reaches a broker without owner-resolve, it may replace `ccc-host` or
  MCP-managed runtime metadata only when owner and port both match. Windows
  replacement waits for `taskkill /T` process-tree exit before launching the
  current packaged CLI. A launch is ready only after both `/health` and
  `/v1/owner/resolve` succeed; otherwise it fails at broker startup with bounded
  owner-readiness diagnostics instead of surfacing later provider timeouts.
  Level 3 runs this repair as a bounded broker preflight immediately after its
  build, before the provider suite, so an unrecoverable owner-resolve failure is
  reported in seconds rather than after long emulator/Appium test deadlines.
- Real-provider MCP calls use operation-aware SDK request deadlines. AVD
  provisioning, emulator boot/delete, and lazy Appium work can exceed the MCP
  SDK's 60-second default, so the Level 2/3 client gives those operations a
  longer bounded total deadline while retaining a shorter bound for ordinary
  calls. This prevents client cancellation from leaving a broker operation in
  flight and breaking the following owner-resolution request.

### Windows Sandbox

Prerequisites:

- Windows host.
- Windows Sandbox enabled.
- `wsb` CLI available on supported Windows versions.

Implementation:

1. Generate owner-scoped `.wsb` configs.
2. Default to conservative presets: read-only tool mount, writeable owner
   scratch folder only, minimal clipboard, minimal network, vGPU off unless
   requested.
3. On a real Windows host, start the sandbox by launching the owner-scoped
   `.wsb` configuration file from hidden host PowerShell. The `.wsb` launch path
   creates the interactive Sandbox desktop session and runs LogonCommand more
   reliably than `wsb start --config` for the helper bootstrap path. CCC then
   uses `wsb list --raw` to discover the runtime GUID and `wsb stop --id` for
   teardown. When minimized mode is enabled, CCC also starts a hidden bounded
   minimize watchdog that repeatedly minimizes late-raising Sandbox windows
   during startup. The owner-scoped device id remains human-readable; the
   Windows Sandbox runtime id stored as `sandboxId` is a GUID because `wsb --id`
   requires a `System.Guid`.
4. Treat the running Windows Sandbox runtime as a host-wide singleton. Windows
   Sandbox supports only one running instance per host, so direct MCP and host
   broker start paths must acquire a host lock before launching the sandbox.
   Owner-scoped definitions may be many; running instances may not. The lock
   records a host boot id so stale locks from a previous host boot can be
   reclaimed automatically.
5. Use `wsb share`, `wsb ip`, and guest helper when command output or screenshots
   are needed.
6. Stop through `wsb stop --id <sandbox-guid>` and clean owner-scoped scratch
   artifacts.

Foundation status:

- The first Windows implementation slice exposes owner-scoped Windows Sandbox
  definitions through the common `device_create`, `device_list`,
  `device_status`, and `device_delete` tools.
- `windows-sandbox` backend discovery reports `wsb` availability and missing
  prerequisites without requiring Windows in normal Linux CI.
- `device_inventory` reports owner-scoped Windows Sandbox definitions,
  helper/config paths, and `wsb` discovery metadata without starting the
  sandbox or helper.
- `device_start` writes an owner-scoped `.wsb` configuration and, on real
  Windows hosts, launches that `.wsb` file from hidden PowerShell only on
  explicit calls when available. The direct `.wsb` path is the real-host default
  because it creates the interactive Sandbox desktop and LogonCommand session
  that the helper requires. Fake/non-Windows provider tests keep using
  `wsb start --id <sandbox-guid> --config <xml>` so the CLI contract remains
  covered. After `wsb list --raw` confirms the runtime id, CCC records the
  runtime id in device status for diagnostics. Helper/UI actions still reconnect
  if no ready marker is visible. Windows Sandbox itself remains an interactive
  GUI runtime, so this hides the host control process and uses a hidden bounded
  minimize watchdog to keep startup non-intrusive rather than turning it into a
  true headless VM. Both
  the direct backend and host broker first claim
  `~/.ccc/devices/host-locks/windows-sandbox.json` so a second owner/device
  gets an explicit host-busy error instead of racing the single Windows Sandbox
  runtime. `device_stop` calls `wsb stop --id <sandbox-guid>` only on explicit
  calls and reports stop failures instead of
  marking a still-running sandbox as stopped.
- `device_delete` removes the owner-scoped scratch/helper workspace for stopped
  definitions. Running definitions are refused unless `force: true`; forced
  delete first performs the same `wsb stop` path, clears recording metadata,
  and only removes state/workspace after stop succeeds. Broker-routed delete
  follows the same rule: a running Windows Sandbox delete is a `wsb stop`
  command followed by owner state deletion only after provider success. Stop failure preserves
  state and scratch so cleanup can be retried.
- The Windows guest-helper file channel writes host request files atomically and
  writes guest response JSON through BOM-free UTF-8 temp files before rename.
  The host response reader strips a leading UTF-8 BOM and treats temporary parse
  failures as retryable until the helper timeout. The one-shot `wsb exec`
  fallback is bounded separately so it cannot consume the full helper wait
  window while the long-running helper may already be writing a response.
- Guest helper installation, command stdout/stderr capture, screenshot,
  upload/download, frame-archive recording, and first-pass GUI control are
  implemented. Windows Sandbox now handles `device_click`,
  `device_double_click`, `device_key`, `device_type`, `device_scroll`, and
  `device_cursor_position` through owner-scoped guest-helper requests. It also
  handles `device_window_list` and `device_accessibility_snapshot` for
  structured desktop inspection through bounded helper requests. OCR and
  richer target-by-window/target-by-element actions remain later hardening
  slices.

Guest-helper foundation status:

- Windows Sandbox definitions now include owner-scoped scratch/tools/helper
  metadata under the current owner namespace.
- `device_start` writes a conservative `.wsb` config only on explicit start,
  mapping a writable scratch folder and a read-only tools folder into the
  sandbox and adding a LogonCommand that runs a short CCC helper bootstrap
  through a `wscript.exe //B` launcher. The launcher starts PowerShell with
  `-WindowStyle Hidden`, so the Sandbox guest does not flash a visible
  PowerShell console while the helper starts.
  The bootstrap copies the long-running helper into writable scratch, starts it
  as a separate hidden PowerShell process, and writes ready/stdout/stderr
  diagnostic files into the mapped downloads directory.
- Helper/UI actions do not rely solely on LogonCommand. If the helper ready
  marker is absent, the backend opens a detached `wsb connect` session and
  explicitly invokes the same bootstrap with `wsb exec --run-as ExistingLogin`
  before waiting for the file-channel response. Windows Sandbox CLI only
  supports `ExistingLogin` and `System` run-as modes; CCC keeps UI helper
  bootstrap on `ExistingLogin` so screenshots/input run in the interactive user
  session, and treats `0x80070520` as a retryable "no active logon yet" result
  while the minimized `connect` session is coming up. If minimized connect does
  not establish an active logon session, the helper bootstrap/request fallback
  opens one direct `wsb connect` session, then runs a hidden bounded
  PowerShell/user32 minimize loop so late-raising Sandbox windows are re-minimized
  while it retries `ExistingLogin`; this is intentionally limited to the failure
  path because real desktop automation cannot run without an interactive Sandbox
  session. Timeout errors include diagnostic file snippets, visible-connect
  fallback auto-minimize state, and run-as attempt summaries, not only paths.
- The same guest helper also supports a one-shot request mode. After the host
  writes an inbox request, it first gives the long-running helper a short chance
  to respond; if no outbox file appears, the backend retries the helper for that
  specific request through `wsb exec --run-as ExistingLogin` while the helper
  timeout remains open. This preserves the persistent helper path while making
  Windows Sandbox E2E resilient when the long-running polling loop is alive but
  not observing host-written inbox files.
- Windows Sandbox CLI operations are bounded. Real-host `.wsb` launch,
  fake-provider `wsb start`, `wsb stop`, preflight `wsb list`, and helper
  `wsb exec` calls use explicit process timeouts so a stuck host Sandbox runtime
  fails the MCP action and real E2E test instead of blocking Vitest indefinitely.
- Windows Sandbox start is not considered ready merely because the launch
  wrapper returned. Real Windows starts first assert that `wsb list --raw`
  reports no already-running Sandbox runtime, then launch the `.wsb` file and
  poll for exactly one new runtime GUID. CCC records that discovered `Id` as
  `sandboxId` and uses it for later `wsb exec`/`stop`, instead of adopting an
  existing manual or foreign Sandbox. Fake/non-Windows provider tests still
  exercise `wsb start --id --config`; if that path returns a different single
  runtime ID, CCC records the listed `Id` as `sandboxId` and preserves the
  supplied GUID as `requestedSandboxId`. If no unambiguous runtime ID appears,
  CCC cleans up only newly observed runtimes, leaves state stopped, and reports
  a provider/start readiness failure instead of letting the later helper action
  fail with "Sandbox ID not found".
- Host-written Windows Sandbox inbox request files inherit the mapped directory
  ACL instead of forcing a restrictive file mode, because the guest helper runs
  as the Sandbox account and must be able to read files created after startup.
  The helper also writes a heartbeat diagnostic with inbox/outbox visibility and
  pending request names; timeout errors include request contents and directory
  listings.
- Windows helper `exec` requests run through a bounded in-helper PowerShell job
  instead of `Start-Process` with stdout/stderr redirected into mapped folders.
  This avoids Sandbox hangs observed when a hidden helper process waits on a
  redirected child process targeting the mapped scratch directory.
- Windows helper responses are written to a temporary outbox file and then moved
  into place, and the host retries JSON parsing while the response file is
  settling. This avoids treating a partially written mapped-folder JSON response
  as a hard MCP/test failure.
- The generated PowerShell guest helper watches owner-scoped mapped
  `inbox/*.json` requests and writes `outbox/*.json` responses. The mapped
  scratch folder also contains owner-scoped `uploads/` and `downloads/`
  folders.
- `device_exec` writes an `exec` request and returns stdout/stderr/status from
  the helper response.
- Desktop GUI control tools write `click`, `double_click`, `key`, `type`,
  `scroll`, and `cursor_position` helper requests. The guest helper uses
  `System.Windows.Forms`, `SendKeys`, cursor positioning, and Win32 mouse
  events inside the sandbox, while the MCP side remains a lazy file-channel
  client and does not require an always-running daemon in the CCC container.
- Structured inspection tools write `window_list` and
  `accessibility_snapshot` requests. The guest helper returns process main
  window metadata via `Get-Process` and a bounded UIAutomation
  `ControlViewWalker` snapshot with `maxDepth`/`maxNodes` clamps so agents can
  inspect the desktop before choosing coordinates.
- `device_screenshot` writes a `screenshot` request and returns PNG image
  content from the helper response.
- `device_record_video_start`, `device_record_video_status`, and
  `device_record_video_stop` write recording requests through the helper. The
  zero-configuration provider returns a zip archive of captured frames as
  `windows-helper-frame-archive`; native encoded video can be added later when
  a guest encoder/helper is available.
- `device_upload` copies the local file into the mapped uploads folder, writes
  an `upload` request, and returns helper response metadata.
- `device_download` writes a `download` request, copies the mapped helper output
  to the requested local path, and returns helper response metadata.
- When no helper responds, helper-backed tools return bounded timeout
  diagnostics with the owner-scoped inbox path.
- Tests use a fake `wsb` command to verify lazy `.wsb` generation, mapped
  folders, helper bootstrap, file-channel request/response behavior, and
  timeout diagnostics without requiring a Windows host.

### macOS VM

Prerequisites:

- macOS host.
- Apple Silicon preferred for macOS guest virtualization.
- Provider available: first-party Virtualization.framework implementation or a
  supported wrapper/provider.

Implementation:

1. Provide a bootstrap flow to create a base macOS VM template from an Apple
   restore image or provider-supported image source.
2. Clone or snapshot per owner/device where supported.
3. Start lazily, wait for guest readiness, and connect through a scoped guest
   helper or SSH where configured by the provider.
4. Expose exec, screenshot, desktop GUI controls, upload/download, and stop.

Foundation status:

- The first macOS VM implementation slice exposes owner-scoped macOS VM
  definitions through the common `device_create`, `device_list`,
  `device_status`, and `device_delete` tools.
- `macos-vm` backend discovery reports whether the host is macOS and whether a
  practical provider command such as `tart`, `vz`, or `utmctl` is available.
- `device_inventory` reports owner-scoped macOS VM definitions, per-device
  provider plans, and provider command discovery metadata without running VM
  list/start commands.
- macOS VM definitions now include provider plan metadata: requested provider,
  selected provider, owner-scoped provider instance, owner-scoped workspace,
  helper metadata, start/stop command plans, missing prerequisites, and deferred
  image/helper work.
- `device_create` remains lazy and records metadata only. Provider commands are
  not called until an explicit `device_start`.
- `device_start` resolves `provider: "auto"` to the first available provider and
  currently maps `tart` to `tart run <providerInstance>`, `vz` to
  `vz start <providerInstance>`, and `utmctl` to
  `utmctl start <providerInstance>`. Missing macOS host/provider prerequisites
  return explicit diagnostics without trying to boot anything.
- `device_exec`, `device_screenshot`, desktop GUI control tools,
  `device_upload`, and `device_download` use configured SSH bridge metadata for
  macOS VM devices.
- Tests verify Linux-host missing diagnostics and fake `tart` provider
  start/stop/delete behavior without requiring a real macOS host or VM image.
- Tart-backed VM base-image create/clone aliases and snapshot operations are
  implemented through owner-scoped provider clones. Deleting managed Tart
  base-image/clone definitions deletes their provider instances after refusing
  running devices unless `force=true`; forced delete stops the VM first, and
  provider delete failures preserve owner state so cleanup can be retried.
  Successful snapshot/recovery candidate deletions are removed from state
  immediately, so a later partial delete failure does not block retry cleanup of
  remaining Tart resources.
- SSH-configured macOS VM starts now generate an owner-scoped
  `ccc-guest-helper.sh`, copy it to `/tmp/ccc-<device-id>-guest-helper.sh`
  with `scp`, and verify it with `chmod 700 ... && ... status` over SSH after
  provider start succeeds. Missing SSH metadata skips helper provisioning
  without failing start; provisioning failures preserve running owner state and
  helper failure metadata so cleanup can stop the VM later.

macOS helper/SSH bridge status:

- macOS VM definitions can now include optional SSH bridge metadata through
  `sshHost`, `sshPort`, `sshUser`, and `sshKeyPath`.
- Device status/helper metadata reports whether the bridge is missing or
  SSH-configured, while preserving owner-scoped workspace paths.
- `device_exec` uses configured SSH metadata and returns stdout/stderr/status.
  Without SSH metadata or host `ssh`/`scp` tools, it returns explicit bridge
  diagnostics. SSH/SCP helper operations are bounded by `helperTimeoutMs` or
  `CCC_MACOS_VM_HELPER_TIMEOUT_MS`, defaulting to 30 seconds.
- Tart-backed `device_start(waitForBoot=true)` can infer a partial SSH bridge
  host from `tart ip` when `sshUser` is configured but `sshHost` is omitted,
  allowing source images with dynamic VM IPs to provision the helper without a
  pre-known address.
- `device_upload` and `device_download` use `scp` with the configured bridge.
- `device_screenshot` runs `screencapture -x` through SSH, downloads the PNG via
  `scp` into the owner-scoped workspace, and returns MCP image content.
- `device_record_video_start`, `device_record_video_status`, and
  `device_record_video_stop` use the SSH bridge to run `screencapture` video
  capture, track the local SSH process, interrupt the remote capture on stop,
  download the artifact via `scp`, and clear state on stop/device shutdown.
- `device_click`, `device_double_click`, `device_key`, `device_type`,
  `device_scroll`, and `device_cursor_position` use the provisioned
  `ccc-guest-helper.sh` over SSH. The helper uses macOS built-in
  `osascript`, JavaScript for Automation/CoreGraphics, and System Events, so
  the MCP side does not need a persistent in-container daemon.
- `device_window_list` and `device_accessibility_snapshot` use the same
  provisioned helper over SSH. Window listing returns visible System Events
  process/window metadata. Accessibility snapshots are bounded by MCP-side
  clamps of `maxDepth` 0..8 and `maxNodes` 1..1000 before the helper traverses
  System Events UI elements.
- macOS guest GUI control still depends on normal macOS accessibility/input
  monitoring permissions inside the guest. OCR, target-by-window actions, and
  richer target-by-element actions remain later hardening slices.
- Tests use fake `ssh` and `scp` commands with the fake `tart` provider, so
  bridge behavior and helper auto-provisioning are covered without a real macOS
  VM.
- `ccc devices smoke --real-provider` checks macOS VM provider CLI readiness,
  SSH bridge command readiness, and local SCP bridge-tool presence without
  creating, starting, stopping, or deleting a VM.
- Automatic guest SSH credential installation is manual-required unless an
  existing trusted SSH channel or image customization step is supplied. CCC can
  provision its helper over an already trusted SSH/SCP bridge, but it must not
  bypass guest login, TCC, provider security prompts, or write
  `authorized_keys` without that trust boundary already being established.

## CLI support

Add host/user commands for visibility and explicit control. These commands
should not be required for normal use, but they make diagnosis and cleanup
predictable.

```text
ccc devices status
ccc devices doctor
ccc devices backends
ccc devices list
ccc devices create <backend> <device-id>
ccc devices start <device-id>
ccc devices status <device-id>
ccc devices stop <device-id>
ccc devices delete <device-id>
ccc devices list --all-projects
ccc devices stop --all-projects
ccc devices prune --all-projects
```

No CCC-specific environment variables should be required.

CLI foundation status:

- `ccc devices status`, `ccc devices list`, `ccc devices backends`, and
  `ccc devices doctor` expose current owner-scoped device-lab state and local
  prerequisite diagnostics without starting devices, brokers, Appium, or
  emulators.
- The CLI reads the same owner namespace shape as `device-lab-mcp` under
  `~/.ccc/devices/owners/<owner-id>/...` and does not expose other owner
  directories.
- `ccc devices create <backend> <device-id>`, `ccc devices start
  <device-id>`, `ccc devices stop <device-id>`, and `ccc devices delete
  <device-id>` route lifecycle operations through the authenticated owner RPC
  on the automatically managed host broker. The broker serializes each device
  lifecycle with the same cross-process operation lock used by MCP calls.
  Windows Sandbox definitions and starts default to minimized mode;
  `--no-minimized` is the explicit opt-out.
- `ccc devices status <device-id>` reports owner-scoped broker state. For a
  Windows Sandbox it includes the requested minimized state and the last
  successful minimize confirmation. It is not a continuous host-window scan.
- Normal operators use only the public `ccc devices ...` commands. Direct
  execution of repository build artifacts such as `dist/index.js` is an
  internal implementation detail and is not an operator recovery path.
- `ccc devices stop <device-id>` stops only a current-owner definition through
  the broker lifecycle boundary. Provider stop hooks execute under the owned
  device operation lock; the public CLI does not bypass the broker or scan
  another owner namespace.
- `ccc devices delete <device-id>` removes only current-owner stopped
  definitions through the same broker boundary and refuses running definitions
  so callers stop first.
- Physical-device stop releases only the matching owner/device/claim lease and
  persists `detached`. Physical-device start requires both an `attached` record
  and its matching non-expired lease, so a stopped or stale record cannot be
  revived without an explicit attach.
- `ccc devices prune` removes stopped definitions from the current owner
  namespace while preserving running/booted definitions and foreign owner
  state.
- `ccc devices smoke` runs a non-destructive host prerequisite smoke matrix for
  Android, iOS Simulator, Windows Sandbox, and macOS VM provider tooling. It
  reports PASS/SKIP/FAIL with concrete command status or missing prerequisite
  details and does not start emulators, simulators, sandboxes, VMs, Appium, or
  brokers. Each smoke command is bounded by a timeout so a hanging host tool
  reports FAIL instead of blocking the CLI indefinitely.
- `ccc devices smoke --real-provider` and `ccc devices smoke --real-lab` are
  explicit opt-in real provider smoke modes for Android, iOS, Windows Sandbox,
  and macOS VM host tooling. They run the same bounded non-mutating readiness
  and inventory command matrix, label the output as real-provider mode, and
  keep fake-provider CI as the default.
- `ccc devices list --all-projects` explicitly scans every project namespace
  without mutating state. `ccc devices stop --all-projects` applies the same
  conservative backend stop and physical lease release semantics across every
  project namespace for host/container teardown. `ccc devices prune
  --all-projects` removes stopped or detached definitions across every project
  while preserving active definitions. Commands without `--all-projects` stay
  scoped to the current project. The pre-release `ccc devices admin ...`
  spellings are not accepted; cross-project intent is expressed only through
  `--all-projects`.

Container cleanup hook status:

- CCC now runs owner-scoped device cleanup before stopping a project container
  through `ccc stop`, `ccc rm`, or last-session cleanup.
- Cleanup only reads and mutates the current owner namespace under
  `~/.ccc/devices/owners/<owner-id>/...`; foreign owner device definitions are
  not enumerated or changed.
- Android cleanup uses `adb -s <serial> emu kill` when an owner device has a
  serial/port, iOS cleanup uses `xcrun simctl shutdown <target>`, Windows
  Sandbox cleanup uses `wsb stop --id <sandbox-guid>`, and macOS VM cleanup uses whitelisted
  provider stop commands (`tart`, `vz`, or `utmctl`) when provider metadata is
  available.
- Cleanup does not rely only on lifecycle status. If an owned definition is
  already marked stopped but still has volatile process metadata such as
  `pid`, `appium.serverPid`, or `recording.pid`, cleanup attempts to kill those
  PIDs and clears `appium` / `recording` metadata. Android recording cleanup
  also sends `adb shell pkill -2 screenrecord` when serial metadata is
  available, without forcing an emulator shutdown for stopped-only stale
  recording metadata.
- Cleanup is best-effort, bounded, and idempotent. Stale PIDs are tolerated so
  CCC teardown continues. For lifecycle-active virtual devices, missing stop
  tools, hanging stop commands, and failed stop commands now return a `failed`
  cleanup result and preserve active owner state/process metadata so a later
  cleanup/admin pass can retry instead of hiding a potentially live host
  process behind a false `stopped` state. Already-stopped definitions that only
  contain stale volatile metadata are still cleared because no lifecycle stop
  command failed.
- Cleanup is not a host-wide process-table sweeper and cannot run after
  uncatchable termination such as `SIGKILL` or host power loss. The next
  explicit owner-scoped cleanup pass still clears stale owner-state process
  metadata without touching foreign owners.
- Automated tests cover Android, iOS, Windows Sandbox, and macOS VM cleanup
  command mapping, stopped-device no-op behavior, stopped-but-live process
  metadata cleanup, repeated cleanup, missing-tool retry preservation,
  hanging/timeout stop commands, failing stop commands, foreign-owner
  preservation, and lifecycle wiring through both session cleanup and explicit
  container stop.

Test-suite structure hardening:

- `src/__tests__/device-lab-mcp.foundation.test.ts` now owns common MCP
  schema/lazy-start checks plus metadata-only X11 display tools, Android, iOS,
  Windows, and macOS definition coverage.
- `src/__tests__/device-lab-mcp.broker.test.ts` now focuses on broker
  diagnostics, broker autolaunch tests, broker RPC, physical lease, physical
  attach/detach, and broker-routed lifecycle coverage.
- `src/__tests__/device-lab-mcp.macos.test.ts` and
  `src/__tests__/device-lab-mcp.windows.test.ts` own backend-focused macOS VM
  and Windows Sandbox coverage.
- `src/__tests__/device-lab-mcp.android-emulator.test.ts` owns Android
  emulator inventory, AVD provisioning, lifecycle, mobile action, file/app,
  recording, UI dump, and non-owned AVD guard coverage.
- `src/__tests__/device-lab-mcp.android-real-device.test.ts` owns
  host-connected Android USB/Wi-Fi attach, wireless bootstrap, safe physical
  actions, lease cleanup, and detach coverage.
- `src/__tests__/device-lab-mcp.ios-simulator.test.ts` owns iOS Simulator
  inventory, provisioning, lifecycle, file/container, recording,
  Appium/XCUITest, and non-owned simulator guard coverage.
- `src/__tests__/device-lab-mcp.ios-real-device.test.ts` owns physical iOS
  USB/Wi-Fi attach, XCUITest/Appium real-device actions, devicectl app
  install/launch, safe/unsafe action boundaries, lease cleanup, and detach
  coverage.
- The old aggregate `src/__tests__/device-lab-mcp.test.ts` file has been
  removed so backend tests have one clear platform owner.
- `src/__tests__/helpers/device-lab-mcp-fixture.ts` owns shared stdio MCP
  client setup/cleanup so split suites can run independently without copying
  HOME/PATH fixture wiring.
- `src/__tests__/helpers/fake-android-mcp-fixture.ts` and
  `src/__tests__/helpers/fake-ios-mcp-fixture.ts` own reusable fake host
  toolchains for the mobile split suites.
- `scripts/real-tests/device-lab-mcp-client.mjs` owns the stdio MCP client used
  by opt-in real provider E2E scripts. Android emulator, iOS simulator/device,
  Windows Sandbox, and macOS VM real E2E runs call `device-lab-mcp/server.mjs`
  tools through this helper, so real provider coverage exercises the MCP
  dispatch layer rather than importing backend handlers directly.
- Android emulator real E2E covers status, exec, screenshot, recording,
  navigation/touch/text/orientation/location/clipboard/app lifecycle, and
  optional permission mutation through MCP calls. Permission grant/revoke uses
  `CCC_REAL_ANDROID_PERMISSION` alongside the disposable
  `CCC_REAL_ANDROID_APK`/`CCC_REAL_ANDROID_PACKAGE` pair so the test only
  mutates permissions the supplied app actually declares.
- iOS Simulator real E2E verifies simulator status after boot and requires
  `mobile_wait_for_app` to report the launched Safari or disposable app process
  as running, so URL/app launch coverage proves more than command dispatch.
- Windows Sandbox and macOS VM real E2E verify desktop helper transfer results,
  including the helper provider plus uploaded/downloaded local and guest paths,
  before checking file contents. Windows status is also cross-checked against
  the started sandbox runtime id.
- Shared fake server/SDK helpers should continue moving into `src/__tests__/helpers/`
  so adding future device features does not require editing monolithic
  integration files.

## Integration with existing CCC

1. Add managed MCP entry generation in `src/mcp-forward.ts`.
2. Bundle `device-lab-mcp` similarly to the existing X11 MCP server.
3. Add owner identity calculation near existing container/session identity code.
4. Add host broker launcher and host reachability checks.
5. Add package tests for MCP config generation.
6. Add broker unit tests with mocked backend commands.
7. Add backend smoke tests that skip when prerequisites are unavailable.

## Design review follow-up

Independent review confirmed that the lazy-start, host-broker, owner-scoped
state, physical-device attach/lease, and non-creatable X11 target directions
are sound. The remaining risk is not the device matrix itself, but the security
and lifecycle contract around the lab boundary and high-privilege broker tools.

Required hardening before treating the design as production-ready:
- A separate `lab-mcp` contract is defined for `lab_start`, `lab_stop`,
  `lab_reboot`, `lab_delete`, `lab_sync_workspace`, `lab_export_artifacts`,
  `lab_open_session`, `lab_list_targets`, and `lab_probe_readiness`.
  VM/container/cloud provider details stay behind that contract, and device
  interaction stays in `device-lab-mcp`.
- Add bounded CCC container VM configuration for hosts/runtimes that can safely
  expose nested virtualization into a container. The ordinary project container
  and the built-in `lab-runner` profile may mount `/dev/kvm` and durable lab
  state only when supported; both must report unsupported diagnostics rather
  than falling back to unsafe host control.
- Container-native VM lab provider baseline is implemented behind the `lab-mcp`
  provider contract for ordinary CCC containers and the `lab-runner` profile.
  `ccc labs status` and `ccc labs smoke` now show default-container and
  lab-runner VM/KVM contract diagnostics separately without starting labs or
  VMs. Bounded local lab-state workspace sync, artifact export policy, reboot,
  target listing, and baseline metadata session/readiness records, base image
  catalog import/register flows, and qemu-img overlay materialization are
  implemented. A bounded guest transport contract for push/pull is implemented
  with provider-injected runner hooks, safe unavailable diagnostics by default,
  and provider-owned SSH readiness plus
  `ssh`/`scp` push/pull/exec when lab metadata includes an explicit guest SSH
  channel. A fake-provider lab-mcp smoke job is implemented for CI contract
  coverage without real VM prerequisites, and `ccc devices smoke --real-provider`
  provides explicit opt-in real provider readiness smoke coverage without
  starting devices. `lab_open_session` now records bounded `guest-ssh` and
  `guest-agent` session metadata for labs with configured SSH and an explicit
  guest-agent health command, and `lab_guest_agent_status` persists sanitized
  agent health state. `lab_guest_agent_provision` now covers explicit bounded
  guest-agent provisioning commands, including opt-in auto provisioning during
  `lab_start`, without exposing raw interactive shell authority.
- Owner identity hardening is implemented: host CLI and in-container MCP now
  share a canonical profile/worktree-aware owner basis, with tests covering
  profile separation, worktree separation, broker CLI routing, MCP context
  canonical defaults, and stale env-basis ignore behavior.
- Appium proxy allowlists are implemented: broker `request` forwarding now
  restricts method/path pairs and validates sensitive bodies for `mobile: shell`,
  install/remove/clear-app-data, keycode/system controls, location, clipboard,
  app state, URL, orientation, and Appium mobile scripts before forwarding.
  Android network-control tools are exposed only behind the destructive action
  confirmation gate and a bounded broker request validator for `svc wifi|data
  enable|disable`, `settings put global airplane_mode_on 0|1`, and the matching
  airplane-mode broadcast. Arbitrary `mobile: shell` remains rejected.
- Broker runtime cleanup is failure-preserving. Forced Appium replacement and
  explicit Appium stop refuse to launch a successor or clear owner metadata
  when the broker-owned process cannot be terminated. Owner cleanup likewise
  retains Appium, recording, and physical attachment state when process
  signaling or exact lease release fails. Brokers advertise and MCP clients
  require `runtime-cleanup-failure-preservation-v1`, so a current client does
  not silently reuse a broker with the older lossy cleanup behavior.
- Broker-owned Appium runtimes now carry a random `runtimeId`. Process start,
  process stop, readiness recovery, and WebDriver session create/delete update
  owner state only when the persisted runtime generation still matches the
  generation they observed. A losing start rolls back its newly launched
  process, and a losing WebDriver session create deletes its newly created
  remote session. Brokers advertise and MCP clients require
  `appium-runtime-generation-fencing-v1`.
- Windows Appium listener cleanup requires command-line provenance under the
  CCC-managed Appium runtime or package roots. Merely having old broker
  metadata no longer authorizes termination of an Appium process from an
  unrelated installation path.
- File and artifact policy is now centralized for `lab-mcp` workspace sync and
  artifact export: owner-scoped roots, path containment, symlink rejection,
  size/file-count limits, unsupported file-type rejection, and secret-looking
  filename rejection are enforced before copying. `device-lab-mcp` direct
  providers now reuse a local file path policy for device upload/download
  local paths, recording `localPath`, and macOS VM `sshKeyPath` references:
  invalid/control-character paths, symlink ancestors, symlink final paths,
  secret-looking upload/output filenames, oversized upload sources, and unsafe
  SSH key references are rejected before provider commands or local copies run.
  `lab-mcp` copy planning and `device-lab-mcp` local upload/input validation
  now also scan file content for common secret material such as private key
  blocks, cloud access keys, GitHub/Slack tokens, and generic secret
  assignments. Rejections expose only the path and bounded pattern label, never
  the matched secret value. Real provider-specific in-guest transfer hardening
  is now implemented for Android ADB, physical Android ADB, Windows Sandbox
  helper requests, and macOS VM SCP by validating guest/remote paths before
  provider commands, helper requests, or local staging copies run.
- Physical Android/iOS lease TTL, heartbeat, and recovery semantics are
  implemented for broker and direct-provider lease stores. Leases include
  expiry metadata, current-owner heartbeat refresh, owner-scoped expired lease
  pruning, expired same-owner lock rebinding, expired-foreign-lock recovery on
  claim, direct-provider attach heartbeat timers while the MCP process is alive,
  and broker-managed heartbeat timers for attached physical devices while the
  broker process is alive. `ccc devices doctor` now includes owner-scoped
  physical lab bench health checks that correlate attached Android/iOS records
  with lease locks and bounded host inventory diagnostics without starting
  devices or brokers.
- Destructive action policy gates are implemented in the device-lab MCP server
  before direct backend or broker routing. Calls that delete real AVD/simulator
  resources, erase/reset app or simulator state, uninstall apps, clear app
  data, restore/delete snapshots, force-delete devices, or change mobile
  network/system state must include `confirmDestructive=true`. Denials return
  a structured `destructive-action-confirmation-required` policy payload naming
  the required field and classified actions; read/status/screenshot/navigation
  tools remain ungated. Raw broker Appium requests that proxy uninstall,
  `pm clear`, or network/system shell changes use the same confirmation
  contract.
- Target status normalization is implemented across virtual devices, physical
  devices, X11 current display, Windows Sandbox, and macOS VM. Device list,
  inventory, status, attach, create, start, and stop responses that include a
  target now preserve backend-specific fields while adding a shared
  `targetStatus` object and top-level aliases for `targetKind`, `creatable`,
  `attachable`, `runtimeState`, `readiness`, `leaseState`, and `sessionState`.

## Completion audit status

`doc/common/DEVICE_LAB_PLAN_COMPLETION_AUDIT.md` records the current
requirement-by-requirement completion audit for this plan. As of the audit,
the broad device-lab MCP architecture, backend matrix, broker, Appium paths,
video recording, file policy, lab-mcp container VM contract, and guest
transport/status/session layers are implemented. The audit currently names no
remaining implementation items. Complete real-provider verification is a
cross-host Level 3 result matrix: collected results must provide the Android,
iOS, Windows Sandbox, macOS VM, KVM, and physical-device evidence required by
the matrix validator. A host that lacks a provider records a categorized SKIP;
that SKIP cannot satisfy the missing provider evidence in the combined result.

## Milestones

1. Foundation
   - Define lifecycle schema, owner ID, state store, and MCP tool shapes.
   - Add broker with fake backend for tests.

2. MCP integration
   - Register `device-lab` as CCC-managed MCP.
   - Verify normal CCC startup does not start any device process.
   - Retire the standalone generated `x11-display` MCP entry after exposing
     equivalent `display_*` tools from `device-lab`.

3. Android backend
   - Implement discovery, create, start, shell, screenshot, stop, delete.

4. iOS backend
   - Implement discovery, create, boot, install, launch, screenshot, shutdown,
     delete.

5. Windows Sandbox backend
   - Implement `.wsb` generation, start, stop, status, scoped folder transfer,
     and minimal guest helper.

6. macOS VM backend
   - Implement provider abstraction and one supported provider path.

7. Admin UX and cleanup
   - Add `ccc devices` commands, stale lock cleanup, owner-scoped prune, and
     explicit cross-project list/stop/prune commands.

8. Hardening
   - Add security review for folder mappings, network presets, port allocation,
     guest helper authentication, and cross-owner isolation.
   - Run host broker, provider, direct MCP helper, and real-test helper child
     processes with hidden Windows child-process options so PowerShell/cmd/ADB
     helper consoles do not flash during device control.
     Test-level runner subprocesses also use hidden Windows child-process
     options so `npm run test:level*` does not open extra console windows.
     Real-provider tests intentionally use per-command hidden spawns rather
     than a reusable hidden shell, preserving test isolation and hard timeouts.
     Windows Sandbox itself is launched through the `.wsb` file on real Windows
     hosts rather than through `wsb start --config`, because the helper depends
     on the guest interactive desktop session and `.wsb` LogonCommand. If
     Windows still reports no active logon session (`0x80070520`) during helper
     bootstrap, CCC opens a direct `wsb connect` fallback because the Sandbox
     CLI requires a real interactive session for `ExistingLogin`, then
     runs a bounded hidden PowerShell/user32 minimize loop so the Sandbox window
     is re-minimized if Windows raises it again during startup. The LogonCommand
     uses a console-free
     `wscript.exe //B` launcher instead of invoking `powershell.exe` directly.
     Helper readiness is validated by the later device action instead of
     assuming process launch means the guest helper is ready.
   - Route implicit high-level mobile tools for broker-owned mobile devices
     through `broker.device.tool.invoke` before direct provider fallback, so
     Android/iOS real-device controls can use host ADB/Xcode without requiring
     those toolchains inside the container.
   - Wrap direct MCP Windows `.bat`/`.cmd` provider invocations through
     `cmd.exe /d /s /c`, matching the host broker runner so Android SDK batch
     tools such as `avdmanager.bat` can run during real emulator tests.
   - Broker-created Windows Sandbox definitions include a logon bootstrap stub
     and mapped helper folders so later `device_exec`/desktop helper calls can
     start the guest helper without relying on a fragile post-login `wsb exec`
     bootstrap path.
   - Implicit broker requests use a one-second health probe and bounded
     readiness retry. If runtime metadata points to a live but persistently
     unresponsive broker, CCC terminates that process tree before removing the
     runtime file and launching a replacement on the same port. A transient
     Windows host delay therefore cannot leave an orphan broker occupying the
     advertised port.
     For bounded device waits, `timeoutMs` remains the provider operation
     limit while `rpcTimeoutMs` is the explicit transport limit. Broker RPC and
     backend-child deadlines add at least 15 seconds beyond
     `mobile_wait_for_text` and `mobile_wait_for_app` operation limits so
     process startup, UI dump, serialization, and cleanup cannot consume the
     provider's entire transport budget.
     Real-test MCP request deadlines similarly add 30 seconds beyond explicit
     desktop helper limits, so the SDK cannot cancel a 180-second Windows
     Sandbox helper operation at its 120-second default. Proxied Appium
     WebDriver commands have a 30-second minimum internal HTTP deadline;
     clipboard operations are no longer truncated by the broker's ordinary
     five-second provider command timeout.
     Android Appium sessions explicitly allow 120 seconds for ADB execution
     and UiAutomator2 server installation/launch. This covers cold emulator
     startup where Appium's roughly 30-second default reports that
     instrumentation cannot be initialized even though the emulator remains
     healthy. Windows Sandbox E2E success is proven by non-error MCP results,
     the `windows-helper` provider, stdout, and transferred file contents;
     it does not require a redundant serialized numeric status field.
     Sandbox command and transfer coverage uses observable effects: MCP calls
     must be non-error, uploaded files are downloaded again and compared byte
     for byte, and command-created files are downloaded and verified. Volatile
     response metadata and redundant stdout strings are not treated as the
     primary proof. Collector exceptions retain the module's exported test
     name and clear unfinished call/session traces before the next module.
     Screenshot verification locates an image item by content type rather than
     assuming it is the first MCP content block; optional text metadata may
     legally precede image content.
     If Android session creation still reports an uninitializable UiAutomator2
     instrumentation process, the broker performs one bounded recovery: it
     force-stops and uninstalls the CCC-owned UiAutomator2 server/test and
     Appium settings packages through owner-selected ADB, then retries session
     creation once. The retry and recovery metadata remain explicit; unrelated
     Appium errors are never retried.
     Appium 3 Android servers use the scoped insecure feature name
     `uiautomator2:adb_shell` and start with the isolated Appium runtime as
     their working directory so Appium discovers the npm-managed UiAutomator2
     dependency. Brokers advertise
     `appium3-scoped-security-npm-cwd-v1`; host auto-start replaces a broker
     that does not advertise this launch contract.
     The broker runtime manifest is locked to patched Appium 3.5.2,
     UiAutomator2 8.1.0, XCUITest 11.17.6, and MCP SDK 1.29.0 dependencies.
     Its lockfile must pass a clean cross-platform `npm ci` and production
     `npm audit` before release; Appium provisioning continues to use that
     packaged lockfile rather than resolving mutable registry ranges at
     device-session startup.
     A zero-config broker status or repair request reuses the persisted shared
     `ccc-host` runtime port across project owners. Owner identity is resolved
     by the broker RPC contract, not by the identity that originally launched
     the shared process. This applies to the MCP `device_broker_status` tool as
     well as implicit device routing, including the first call in a container.
     Only an explicitly requested port overrides that runtime port. Host
     `.gitconfig` synchronization runs its install step as
     root and restores `ccc:ccc` ownership so stale file ownership cannot make
     otherwise healthy container startup emit a false warning.
     Broker RPC authentication reads an already provisioned owner secret and
     compares the derived token in constant time. A validated
     `/v1/owner/resolve` request provisions or repairs that exact owner's
     secret inside the host broker authority; an unauthenticated request for
     an arbitrary owner must never create or rotate broker auth state. MCP
     clients are read-only consumers and never create, replace, rotate, or
     change permissions on auth metadata. They accept only a regular,
     single-link file whose embedded owner ID matches the resolved owner and
     whose opened file identity still matches the path. Initial secret
     provisioning is serialized by an owner lock and committed by atomic
     rename. The broker quarantines invalid regular files, symbolic links, and
     hard links without mutating their targets. A dead-PID lock is reclaimed
     immediately, stale temp files are removed by the next lock owner, and
     concurrent host/container callers must all observe the same secret.
     Mutating broker RPCs are serialized per owner so concurrent lifecycle,
     Appium, lease, attachment, and mutating device-tool calls cannot lose one
     another's read-modify-write state transitions. Read-only status,
     inventory, and screenshot-style requests do not enter that queue. Broker
     runtime metadata and owner device definitions from both the broker and
     provider child processes are committed through private temp files and
     bounded-retry atomic rename rather than direct truncating writes.
     Unexpected request or provider exceptions are contained at the HTTP
     boundary as a generic `broker-internal-error`; sensitive exception text
     is not returned and the broker remains available for later health and RPC
     requests. Brokers advertise `constant-time-existing-owner-auth-v1`,
     `atomic-owner-secret-provisioning-v1`,
     `owner-mutation-serialization-v1`, `atomic-owner-device-state-v1`, and
     `rpc-fault-containment-v1` for these contracts. Brokers additionally
     advertise and clients require
     `broker-owned-owner-secret-provisioning-v1`, preventing a read-only MCP
     client from reusing an older shared broker that provisioned only its
     launch owner and depended on clients to create later owner secrets.
     Broker-created Android emulators allocate an even console port from the
     persisted owner-wide `5554..5682` pool when `device_create.port` is
     omitted. Explicit ports use the same validation, and the selected port is
     stored before start so boot polling, ADB tools, and Appium share one
     stable `emulator-<port>` identity.
     Docker E2E runs use isolated temporary HOME directories for ordinary CCC
     state and the git-identity fixture. They never read or overwrite the
     developer's real broker runtime. Teardown terminates only a `ccc-host`
     broker whose isolated runtime metadata points back to that exact test
     project before deleting either temporary HOME. Test brokers must not
     survive with deleted owner paths or occupy the default port after the
     suite exits.
     Packaged CLI informational commands are similarly side-effect free:
     `ccc --version`, `ccc version`, `ccc --help`, and help/version combined
     with an `@branch` selector return before profile validation, worktree
     preparation, container creation, clipboard startup, or broker repair.
     Android lifecycle status reports ADB-observed runtime readiness without
     mutating owner definitions during a read. Implicit `mobile_session_status`
     uses broker Appium metadata rather than container-local package discovery.
     Device stop/delete operations terminate broker-owned Appium and recording
     processes before invoking the provider lifecycle command. A failed signal
     preserves its metadata and blocks the provider command so cleanup remains
     retryable; successful cleanup clears metadata before the device is stopped
     or deleted. Windows stale-process detection uses PID liveness in addition
     to taskkill output, so localized process-not-found messages are safe. A
     minimized Windows Sandbox start records a UTC process-start boundary and
     launches a hidden host watchdog immediately after the provider start. The
     watchdog ignores pre-existing Sandbox processes, minimizes the new actual
     client window once by native window handle as soon as it appears, and exits
     instead of waiting for helper readiness or forcing repeated minimization.
     Watchdog launch failure stops the runtime and fails the start rather than
     reporting a false minimized state. Stop/delete writes an owner-device cancellation
     marker and clears watchdog metadata before releasing the singleton lock,
     preventing stale PID reuse or a prior watcher from affecting later sessions.
     The direct MCP backend applies the same cancellation contract;
     stopped-device deletion also clears any surviving watchdog metadata, and
     registration or watchdog-launch failure cleans the watchdog and runtime
     instead of leaving a process detached from device state. Host broker
     compatibility requires `windows-sandbox-window-minimize-v4`, so a new MCP
     cannot silently reuse an older broker that either minimizes only the CLI
     launcher or delays/broadly targets the actual client window. Before each
     minimized launch, the host captures the existing Sandbox window handles;
     the watchdog minimizes only a newly appearing handle. This remains
     owner-safe when Windows reuses an older Sandbox client process whose
     process start time predates the requested device launch. The watchdog
     writes an owner-scoped success marker only after the native minimize call
     succeeds. Device start verifies that marker after runtime registration;
     a missing or negative confirmation fails the start and stops the runtime
     instead of reporting a false successful minimized launch.
     Managed MCP configuration always references the container image paths
     under `/opt/ccc/dist`; host checkout paths are never written into the
     container's Claude or Codex configuration, even for development builds.
   - Level 3 runs the destructive Android emulator scenario in place of the
     lower-level Android emulator scenario because the destructive scenario
     includes the complete non-destructive workflow. This keeps source and
     packaged coverage while avoiding two redundant emulator matrices.
     The Level 3 Vitest wrapper allows 30 minutes for the real-provider
     collector and matrix validation. Emulator boot, Appium provisioning, and
     packaged execution can legitimately exceed the ordinary 10-minute
     integration-test limit; provider operations retain their own narrower
     bounded timeouts.
     The adapter runs that shared collector once, then registers every emitted
     test/step record as an individual Vitest case. Provider prerequisites are
     individual skipped tests, failures retain their exact step names, and
     provider coverage validation is a separate test. Every parent real-test
     result uses the same fail-closed step aggregator: malformed or empty step
     sets fail, any failure fails, mixed pass/skip passes, and an all-skipped
     result remains skipped. Unsupported providers must never be promoted to a
     false pass by a wrapper or matrix. Device setup remains
     shared because emulator and Appium lifecycle steps are ordered,
     destructive integration operations rather than isolated unit tests.
     Real provider scenarios run once through the freshly built packaged MCP
     by default. Repeating the same emulator, VM, or Sandbox lifecycle through
     source and packaged servers nearly doubles wall time without changing the
     tested host provider. There is no environment-variable mode that restores
     that duplicate lifecycle. The platform matrix still requires source and
     dist direct tool coverage from fast contract tests, while dedicated
     physical provider evidence is required from the distributable dist server.
     `npm run test:level3` is self-contained: its build phase produces the
     current checkout's `dist/index.js`, and real broker tests always prepend a
     temporary shim for that local CLI instead of resolving a globally
     installed `ccc`. No global install step is required before any Level 3
     run, and stale global packages cannot change the tested broker version.
     Broker-backed provider tools run in asynchronous child processes so a
     slow Sandbox, emulator, or VM operation cannot block broker health and
     owner-resolution requests. Windows Sandbox screen capture is isolated in
     a bounded guest job; a stalled desktop capture returns a helper error
     within 30 seconds instead of wedging the helper and broker request paths.
     Device-tool HTTP RPC deadlines remain 30 seconds beyond the requested
     provider/helper deadline. The broker child may use 15 seconds of that
     margin for shutdown and diagnostics, leaving another 15 seconds for the
     HTTP response instead of racing equal inner and outer deadlines.
     A Windows helper timeout is one end-to-end deadline shared by bootstrap,
     visible-session recovery, one-shot fallback, and response polling. Each
     phase receives only the remaining time; phases never restart the timeout.
     Windows `ExistingLogin` execution follows the platform requirement that
     `wsb connect` first establish an interactive remote desktop session. The
     recovery window remains visible for an eight-second login warmup and is
     minimized only afterward; minimizing immediately can prevent the active
     login session required by helper UI and screenshot operations.
     The primary `.wsb` start path uses the same sequence: launch the Sandbox
     normally, wait for the guest LogonCommand/helper ready marker, then
     minimize it (with a bounded 60-second startup wait).
     `wsb connect` remains recovery-only rather than the normal way to create
     the first login session.
     On CLI versions where the `.wsb` window is not itself an active remote
     session, recovery `wsb connect` also remains visible until that same ready
     marker appears. Both launch paths therefore minimize from observed guest
     readiness, never from a fixed delay.
     Recovery launches `wsb connect` directly in the host user's interactive
     desktop. A separate hidden PowerShell watchdog observes the marker and
     minimizes afterward; the connection itself is never created by a hidden
     intermediary process.
     Physical-device leases and the Windows Sandbox singleton are shared host
     state, not owner-local state. Direct providers and the host broker must
     use the same token-fenced filesystem mutation locks before replacing or
     deleting those records. Physical lease aggregate read-modify-write is
     serialized independently, lease/singleton claims carry a stable
     `claimId`, and an expired/recovered claim receives a new identifier.
     Mutation locks record host boot identity and PID, recover dead or old
     malformed owners after bounded grace periods, and verify the lock token
     after moving it before deletion. Broker compatibility requires
     `cross-owner-physical-lease-serialization-v1` and
     `windows-sandbox-singleton-fencing-v1`, preventing a current MCP from
     reusing a broker that still has read/unlink or read/truncate races.
     Explicit admin cleanup is a participant in the same shared-state
     protocol. `ccc devices stop`, `ccc devices delete`, cleanup, and
     all-owner stop/prune acquire the per-hardware or Windows singleton
     mutation lock, then reread and revalidate owner/device identity before
     unlinking. An admin command waiting behind a provider claim therefore
     cannot delete the provider's successor record. Admin owner device files
     are also atomically replaced, so readers never observe truncated JSON.
     Owner/backend device definitions use a separate
     `devices.mutation.lock`. Broker, direct providers, and admin commands all
     reread the latest device array inside that lock before append, update, or
     delete, preserving unrelated concurrent mutations across processes.
     Broker compatibility requires
     `cross-process-owner-state-serialization-v1`, so clients replace brokers
     that only provide in-process mutation queues and atomic whole-file writes.
     Long-running lifecycle and cleanup operations use a separate async,
     per-owner/backend/device operation lock shared by direct providers and the
     host broker. Provider commands and process termination run outside
     `devices.mutation.lock`; only the final compare-and-set state transition
     holds the file mutation lock. If another process installs a successor
     record while external cleanup is running, cleanup preserves that record
     and reports a state conflict. Broker compatibility requires
     `cross-process-device-operation-serialization-v1`.
     Physical attach and detach RPCs also acquire this exact per-device lock
     before provider discovery, lease mutation, or owner-state mutation. This
     prevents broker attach/detach from racing a direct MCP lifecycle, Appium,
     recording, or file operation for the same owner/backend/device. Broker
     compatibility additionally requires
     `physical-attach-detach-operation-serialization-v1`. Before detach
     releases a lease or removes owner state, it stops broker-owned Appium and
     recording runtimes using the same bounded cleanup path as lifecycle stop.
     Cleanup failure preserves both the device record and lease. Compatibility
     requires `physical-detach-runtime-cleanup-v1` for this invariant. Detach
     removes owner state only after the exact claim-fenced lease release
     succeeds or the lease is already absent; a claim mismatch preserves both
     current records. Public physical stop/delete and owner cleanup also hold
     the physical lease mutation lock from exact claim validation through
     Appium/recording cleanup and lease release. This prevents stale owner
     metadata from terminating a successor runtime. Brokers and clients require
     `physical-runtime-cleanup-lease-fencing-v1` for that ordering guarantee.
     Recording start/stop and Appium process, session, and request operations
     use that same per-device operation lock. Recording metadata carries a
     random runtime generation and is replaced or cleared only when the
     observed generation still matches. Brokers advertise and clients require
     `cross-process-device-runtime-serialization-v1`, so a current client does
     not reuse a broker that can race lifecycle cleanup with recording or
     Appium runtime work. Direct-provider recording metadata additionally uses
     `direct-recording-generation-fencing-v1`: exit callbacks, status
     reconciliation, start commit, and stop cleanup compare the random runtime
     generation before changing state. A stale callback cannot clear a newer
     recorder even if the operating system reuses its PID. macOS snapshot
     create, restore, and delete use the same per-device operation lock.
     Finite provider operations such as exec, screenshot, transfer, install,
     reset, input, and clipboard access use one shared policy and the same
     reentrant device lock. Status and bounded wait/poll tools remain outside
     the long-lived lock; iOS Appium session bootstrap takes a short nested
     lock before polling continues. The async reentrancy token expires when
     the owning operation settles, so detached descendants must reacquire the
     cross-process file lock. Brokers advertise and clients require
     `finite-device-operation-serialization-v1`.
     Direct iOS Appium metadata uses
     `direct-appium-generation-fencing-v1`. It carries a random runtime
     generation, natural exit and stale recovery use compare-and-set, and
     cleanup signals only a current direct-provider process whose Appium
     endpoint is reachable. Legacy or external metadata is never treated as
     sufficient PID ownership evidence.
     Spawn-backed direct-provider recordings additionally persist a process
     start token and SHA-256 command hash alongside the PID and runtime
     generation. A restored state record may signal that PID only when the
     live process still has the same start token and command hash. PID reuse,
     legacy metadata, and incomplete provenance therefore cannot terminate an
     unrelated host process. Status reconciliation also clears current-format
     metadata when the live PID belongs to a different process. Newly spawned losing recorders are stopped through
     their `ChildProcess` handle instead of a reread stored PID. Brokers
     advertise and clients require `direct-runtime-process-identity-v1`.
     Host-broker recordings use the same persisted PID, process start token,
     command hash, and runtime generation contract. Explicit recording stop,
     lifecycle cleanup, owner cleanup, and status reconciliation signal or
     clear only the exact recorded process generation. Administrative cleanup
     never treats legacy device, recording, or Appium PID fields as ownership
     proof; it uses provider-scoped stop commands and signals only a recording
     with complete matching process identity. Brokers advertise and clients
     require `host-recording-process-identity-v1`.
     Process observation distinguishes an exact match, PID reuse, confirmed
     exit, and identity lookup unavailability. A failed CIM, `/proc`, or `ps`
     lookup is not evidence that a process exited: status and cleanup preserve
     the current runtime generation until liveness is confirmed or an exact
     identity can be read. Only `ESRCH` is treated as confirmed exit during a
     signal race. Brokers advertise and clients require
     `runtime-process-observation-v1`.
     Create and attach paths additionally claim device identity inside that
     same lock. Device IDs are unique per owner/backend; physical serial/UDID,
     Android AVD name/port, iOS Simulator identity, and provider-scoped macOS
     VM instance identity are fenced before persistence. A losing operation
     returns a structured identity conflict, releases only the exact physical lease it
     acquired, and rolls back only a provider resource that is not referenced
     by the winning record. Brokers advertise and clients require
     `owner-device-identity-fencing-v1` so an older append-after-precheck
     implementation cannot be reused silently.
     Physical attach adds a per-operation nonce to the stable lease claim ID.
     Same-owner concurrent attach attempts cannot reuse one another's active
     lease, and heartbeat, rollback, detach, and cleanup require matching claim
     tokens before mutating it. Broker compatibility additionally requires
     `physical-lease-operation-fencing-v1`.

9. X11 consolidation
   - Use `device-lab` `display_*` tools for current-display control.
   - Keep legacy cleanup logic that removes stale generated `x11-display`
     config tables during MCP config regeneration.

## Verification

Test fixtures use neutral synthetic host identities such as `TestUser`.
Developer workstation usernames and absolute personal project paths are not
part of the device-lab contract; branded repository and registry identifiers
remain unchanged where they are the behavior under test.

1. Unit tests confirm MCP config is written without starting the broker.
2. Unit tests confirm owner A cannot list, stop, delete, or inspect owner B's
   devices.
3. Mocked backend tests cover create/start/status/stop/delete for every backend.
4. `ccc devices smoke` reports Android smoke PASS only when `adb version` and
   `emulator -list-avds` succeed; otherwise it reports SKIP or FAIL without
   starting an emulator.
5. `ccc devices smoke` reports iOS smoke PASS only when
   `xcrun simctl list -j` succeeds; otherwise it reports SKIP or FAIL without
   booting a simulator.
6. `ccc devices smoke` reports Windows Sandbox smoke PASS only when `wsb --help`
   succeeds; otherwise it reports SKIP or FAIL without opening a sandbox.
7. `ccc devices smoke` reports macOS VM smoke PASS only when an available
   provider command (`tart`, `vz`, or `utmctl`) responds to `--version`;
   otherwise it reports SKIP or FAIL without starting a VM.
8. `ccc devices list --all-projects`, `ccc devices stop --all-projects`, and
   `ccc devices prune --all-projects` make cross-project scope explicit; list is
   read-only, stop uses backend-safe cleanup semantics across project
   namespaces, and prune removes stale stopped/detached resources without
   touching active resources. Deprecated `admin` aliases preserve compatibility
   but are not advertised.
9. X11 display tools remain available without creating a device definition and
   without starting a host broker.
10. Broker wrapper diagnostics treat a successful `device_create` dry-run as a
    command-plan success; only operations that require an existing device are
    asserted as missing-device failures.
11. Admin-versus-provider race tests hold shared mutation locks in independent
    processes, replace both a physical lease and Windows Sandbox singleton
    with successor-owner records, and verify admin deletion preserves those
    successors without leaving mutation-lock residue.
12. A 16-process owner-state race appends 16 distinct devices through the
    shared mutation API and verifies all 16 records survive with valid JSON
    and no lock/temp residue. A separate admin race installs a concurrent
    device while delete waits, then verifies only the requested device is
    removed.
13. A separate 16-process same-identity race proves exactly one claim succeeds,
    15 callers receive `owner-device-id-conflict`, one record remains, and no
    lock/temp residue survives. Direct Android and broker command regressions
    inject an external winner during provider creation and verify the losing
    owner-scoped AVD is deleted without altering the winner record.
14. Async operation-lock regressions prove the lock remains held across
    awaited work, serializes a waiter, releases after rejection, and emits a
    stable timeout code. Broker cleanup tests prove provider commands execute
    without `devices.mutation.lock` and cannot overwrite a concurrently
    installed successor record.
15. Recording generation regressions install a successor while start or stop
    performs external process work, then prove the successor remains persisted
    and a losing newly launched recorder is signaled. Appium runtime mutation
    and request routes execute under the same per-device operation lock without
    recursively acquiring it during session ensure.
16. Finite-operation regressions hold the cross-process device lock and prove
    exec waits while a bounded wait tool proceeds. Reentrant-lock regressions
    prove an awaited alias may nest but a detached continuation after the
    parent settles must reacquire the file lock. Appium generation regressions
    prove a stale runtime cannot clear a successor that reused the same PID.
17. Direct runtime identity regressions prove process identity is stable for a
    live process, stores only a command hash, refuses a reused PID with a
    different start token, and signals only an exact runtime identity.
18. Host recording and admin cleanup regressions prove broker recording state
    stores no raw command line, reused PIDs are never signaled, mismatched
    explicit stops preserve retryable state, and legacy admin metadata is
    cleared through provider-scoped cleanup without signaling unverified PIDs.
19. Runtime observation regressions distinguish transient identity lookup
    failure from confirmed process exit, preserve live state while identity is
    unavailable, and treat only `ESRCH` as a successful already-exited signal
    race.
20. Host Appium process regressions launch a real detached child through the
    default runner and verify that owner state persists only a random runtime
    generation, PID, OS start token, and command hash. Stop and replacement
    signal only complete broker provenance with an exact live identity;
    mismatched or unavailable identities preserve retryable state, partial or
    caller-recorded provenance never authorizes a signal, and injected command
    runners never signal synthetic PIDs. Brokers advertise and clients require
    `host-appium-process-identity-v1`.
21. Owner-auth regressions prove `/v1/owner/resolve` provisions the exact
    resolved owner's secret, 12 independent MCP processes authenticate through
    one broker-owned record with no lock residue, and malformed or
    owner-mismatched metadata is never rewritten by an MCP client. Symbolic
    link and hard-link regressions prove auth targets are not read as trusted
    client state and are not modified while the broker atomically replaces the
    invalid auth path. Brokers advertise
    `broker-owned-owner-secret-provisioning-v1`.
22. Host-broker replacement regressions prove status and persisted runtime
    PIDs are metadata, not signal authority. The host CLI signals only the
    operating-system-observed owner of the requested listening port when its
    command line is the current `ccc devices broker serve --port <port>`
    contract. MCP recovery and shutdown additionally accept a broker process
    only when it is a live child owned by that MCP process or passes the same
    port-owner verification. Unverified metadata is preserved for diagnosis,
    never rewritten as trusted runtime state, and never signaled. Brokers
    advertise and clients require `host-broker-port-process-identity-v1`.
23. Direct Appium process regressions prove iOS Simulator and physical-device
    Appium state persists a runtime generation, PID, OS start token, and command
    hash. Shell-to-runtime `exec` refresh is accepted only within the same PID
    and start-token epoch. Cleanup rereads exact identity before every signal
    escalation, preserves state on mismatch or unavailable identity, and
    accepts only an already-cleared observed generation. Direct Appium HTTP
    calls are abortable and finite, including an accepted connection that never
    responds. Brokers advertise and clients require
    `direct-appium-process-identity-v1`.
24. Physical teardown regressions inject provider failures and owner-state
    write failures after lease validation. Provider failure preserves the
    active lease; stop/delete, explicit detach, and owner cleanup restore the
    exact released claim with a renewed expiry and broker heartbeat when state
    persistence fails. Lease removal precedes heartbeat cancellation so a
    failed unlink cannot strand a live attachment without renewal. Brokers
    advertise and clients require `physical-lease-state-write-rollback-v1`.
25. Owner device state readers fail closed for malformed JSON, a missing or
    non-array `devices` field, invalid entries, duplicate non-empty IDs,
    oversized files, read failures, symbolic links, and hard links. Only an
    absent `devices.json` means an empty owner state. Direct MCP, broker, and
    admin mutations validate the current file while holding the shared state
    lock and validate the exact pretty-printed byte size before atomic
    replacement, so neither corruption nor a growth mutation can silently
    erase or brick owner state. Create paths preflight the complete record and
    roll back a newly created provider resource or physical lease if a
    concurrent mutation makes the final state claim fail. Brokers advertise
    and clients require `owner-device-state-validation-v1`.
26. Shared host ownership records fail closed before any provider or cleanup
    effect. Physical-device per-hardware locks and the Windows Sandbox
    singleton reject malformed JSON, invalid identity fields, oversized files,
    read failures, symbolic links, and hard links without replacing the
    original path. Legacy records remain readable when newer diagnostic fields
    are absent, but any present field is validated. The physical lease
    aggregate remains non-authoritative: corruption is preserved for explicit
    recovery while a valid per-hardware lock can still be claimed or released.
    Brokers advertise and clients require
    `shared-device-ownership-state-validation-v1`.
27. Cross-project CLI operations enumerate the project namespace fail closed.
    Only an owner-root path that is absent at the initial `lstat` is an empty
    project set. A non-directory or linked root, a linked child namespace, a
    read failure, or root identity replacement stops list, stop, and prune
    before mutation with `project-namespace-read-failed` and a nonzero CLI
    result. The public async dispatcher routes `stop --all-projects` to this
    cross-project boundary rather than treating the flag as a single device ID.
    This is a host CLI invariant and does not change the broker/MCP wire
    contract, so it intentionally requires no broker compatibility capability.
28. Android emulator console ports are allocated as host-global resources.
    Before either automatic or explicit allocation, broker and direct MCP
    routes validate every canonical project namespace and Android owner-state
    file; corruption or an unreadable namespace stops creation before any ADB
    or provider command. When ADB is installed, both routes also inventory live
    `emulator-<port>` transports and fail closed if that inventory cannot be
    read. Explicit conflicts return `android-emulator-port-conflict`, while a
    portless direct create persists a concrete port and matching serial.
    Inventory, optional AVD creation, and the final owner-state claim execute
    under one shared cross-process port-allocation lock so concurrent projects
    cannot select the same port. Start rechecks the reserved port under the
    same lock and refuses to launch if an unmanaged emulator took it after
    creation. Brokers advertise and MCP clients require
    `android-emulator-port-allocation-fencing-v1`.
29. Device control-plane state reads remain bounded after opening the file and
    do not follow symbolic or hard links. Owner `devices.json` readers enforce
    their byte limit while reading, even when the initial file size is zero or
    the file grows after `fstat`. Broker runtime, owner auth, service-owner,
    Appium runtime-marker, and shared mutation-lock records use explicit small
    limits plus descriptor/path identity checks. Runtime and marker writes use
    atomic replacement, and auth provisioning uses the common token-fenced
    mutation lock so stale linked or malformed lock paths can be removed
    without mutating their targets. These are local persistence invariants and
    do not change broker RPC response semantics, so they intentionally require
    no additional compatibility capability.
30. Windows Sandbox configuration and helper files remain inside the resolved
    owner Windows namespace. Configuration, helper response, diagnostic,
    minimization-result, and screenshot reads are bounded and reject linked or
    replaced files. Helper responses must match the outstanding request ID and
    operation type, and guest-reported output paths are reduced to a filename
    under the canonical owner downloads directory rather than trusted as host
    paths. Generated helper scripts, requests, and `.wsb` files use atomic
    replacement, while every existing path ancestor from the owner Windows
    root must be a real directory. These are local provider-file invariants and
    intentionally require no additional broker compatibility capability.
31. Windows Sandbox host file transfers copy from a validated no-follow source
    descriptor into a private sibling temporary file and atomically replace the
    destination. The opened source must remain the same single-link regular
    file, streaming enforces the configured byte limit even when initial file
    size is zero, and failures preserve the prior destination. Upload staging
    is capped at 16 MiB, owner-download and recording outputs are capped at 2
    GiB, and successful uploads remove their staging file. These are local
    transfer invariants. Missing or failed recording output preserves the
    recording generation for a later retry instead of accepting a pre-existing
    destination or clearing recovery metadata. They intentionally require no
    additional broker compatibility capability.
32. Broker-managed Appium installation treats packaged manifests and the shared
    runtime as host code-execution boundaries. Package and lock manifests are
    read through stable single-link descriptors with 64 KiB and 8 MiB limits,
    parsed before use, and atomically replace runtime copies. The device state
    root, broker root, Appium runtime, and existing `node_modules` path must be
    real directories; a linked runtime or dependency root fails without running
    npm or mutating its target. Runtime reuse requires a bounded single-link
    Appium entry below real parent directories even when the marker hash matches.
    A broker-global mutation lock serializes the five-minute `npm ci` operation,
    has a bounded wait, and preserves a live competing lock on timeout. Brokers
    advertise and MCP clients require
    `appium-runtime-installation-fencing-v1`.
33. Broker-managed Appium HTTP transport never follows redirects and reads
    response bodies through a 16 MiB streaming ceiling. The ceiling applies to
    actual decoded response bytes even when `Content-Length` is absent, while
    an oversized declared length is rejected before body accumulation. A 3xx
    response produces `appium-redirect-disallowed` without contacting its
    `Location`, and an oversized response produces
    `appium-response-too-large` with bounded diagnostics. This covers status,
    session lifecycle, rollback, and public WebDriver proxy requests through
    the same transport helper. Brokers advertise and MCP clients require
    `bounded-no-redirect-appium-http-transport-v1`.
34. MCP-to-broker HTTP transport fails closed before trusting any broker
    response. Health, capability status, and owner resolution share a 1 MiB
    streaming response ceiling; authenticated RPC uses a 64 MiB ceiling so
    bounded screenshot and binary payloads remain supported. Both declared and
    chunked body growth are checked, redirects are never followed, and every
    accepted response must be a JSON object. Redirects, oversized bodies, and
    malformed JSON produce stable bounded diagnostics instead of broker
    availability or successful RPC results. This is enforced entirely by the
    current MCP client and therefore requires no additional host capability.
35. Host `ccc`-to-broker HTTP transport uses the same fail-closed contract.
    Health, status, and owner resolution stream at most 1 MiB; authenticated
    owner RPC streams at most 64 MiB. Every request uses manual redirect
    handling, accepted bodies must be JSON objects, and malformed, redirected,
    or oversized responses remain bounded failures. This policy is enforced by
    the invoking host CLI and does not add a broker capability requirement.
36. Direct iOS Simulator and physical-device Appium transport is bounded even
    when broker routing is not used. The shared XCUITest HTTP client rejects
    redirects, streams at most 16 MiB per response, caps request deadlines at
    five minutes, and keeps malformed or failed HTTP diagnostics within 32
    KiB. Declared and chunked response growth are both enforced before Appium
    payloads reach either direct iOS provider.
37. Host CLI and MCP-owned broker autostart logs are path-fenced. The device
    state root, broker directory, and logs directory must each be real
    non-symbolic-link directories before launch. Each launch creates a random,
    exclusive, no-follow, mode-0600 regular file and verifies the opened file
    still matches its path with one link before passing its descriptor to the
    child. MCP startup diagnostics read only the final 4 KiB through the same
    descriptor/path identity checks instead of loading an entire log. These
    guarantees are enforced by the launching CLI or MCP client and therefore
    do not require a broker capability change.
38. Windows hidden-provider launcher scripts are path-fenced. The device state
    root and every launcher parent must be real non-symbolic-link directories;
    provider names cannot contain path syntax. Node preload and VBS files use
    128-bit random names, exclusive no-follow mode-0600 creation, complete
    descriptor writes, and descriptor/path single-link identity checks before
    their paths are handed to a child. The preload is reused only while its
    bounded verified content remains unchanged. Per-launch VBS files are
    removed after the wrapper closes, with a bounded delayed fallback. Host and
    MCP compatibility checks require
    `windows-provider-launcher-path-fencing-v1` so older brokers are not reused.
39. Detached clipboard bridge servers now recover after an owning CLI crashes.
    The server checks live CCC session locks every five seconds; an empty or
    stale lock set starts a 15-second grace period, while any live session
    resets that period. A server with no surviving session exits cleanly and
    removes its state instead of remaining for the former 30-minute idle
    window. This also prevents repeated real-test runner subprocesses from
    accumulating detached clipboard servers and exhausting host memory/swap.
40. The Android direct provider's Windows hidden-emulator launcher is
    path-fenced independently of the host broker. Every start creates a
    128-bit random VBS file with exclusive no-follow mode-0600 creation,
    complete descriptor writes, and descriptor/path single-link identity
    checks. The entire directory chain below the host home must remain real
    and non-symbolic, and device IDs cannot contain path syntax. Launchers are
    removed when `wscript.exe` closes, immediately after spawn failure, or by
    a bounded 60-second fallback. This is a direct-provider implementation
    invariant and therefore requires no additional broker capability.
41. The normal Vitest suite bounds process-heavy fixture concurrency to half
    the available CPUs and at most eight workers. This prevents MCP server
    subprocess startup from exceeding otherwise sufficient hook/test
    deadlines on high-core hosts under memory or swap pressure. Level 3 keeps
    its independent serial real-provider configuration.
42. Direct macOS VM executable artifacts are path-fenced independently of the
    host broker. Device and owner IDs are restricted to conservative path
    segments, and every workspace directory below the host home must remain a
    real non-symbolic-link directory. SSH askpass and guest-helper scripts are
    written completely to exclusive no-follow mode-0700 temporary files,
    verified as exact-size single-link regular files, and atomically installed.
    A linked final script is replaced without following it, while collisions
    preserve another process's temporary file. This is a direct-provider
    implementation invariant and requires no broker capability change.
43. Every persisted owner-scoped device definition requires a canonical device
    ID: 1-128 ASCII letters, digits, dots, underscores, or hyphens, excluding
    `.` and `..`. Host CLI and MCP state readers enforce the same rule before
    any provider sees a record, and all 66 public `deviceId` inputs advertise
    the identical JSON Schema constraint. Runtime dispatch repeats validation
    before direct, broker, physical, or nested flow routing and returns a
    stable bounded `device-id-invalid` failure. This closes traversal through
    corrupted state and caller-supplied IDs across every provider without
    changing valid generated IDs. Host brokers advertise and current MCP
    clients require `canonical-owner-device-ids-v1`, so a reachable older
    broker cannot silently retain the unsafe persisted-state contract.
44. iOS Simulator control verifies persisted identity against the live host
    inventory before any provider effect. A recorded simulator name must use
    the current owner prefix, and its recorded UDID must resolve to exactly one
    host Simulator whose actual name exactly matches that owner-scoped name.
    Direct and host-broker lifecycle, execution, screenshot, transfer, reset,
    application, privacy, location, clipboard, wait, recording, and Appium
    paths all use the verified host UDID. Forged owner-prefixed aliases and
    foreign UDIDs fail before provider commands, session reuse, or cleanup.
    Brokers advertise and MCP clients require
    `ios-simulator-owner-identity-fencing-v1` so older brokers cannot retain
    the persisted-UDID trust boundary.
45. Physical iOS effects require the exact live attachment lease at operation
    time. The direct provider refreshes and validates owner, device, claim ID,
    claim nonce, and expiry before Xcode or Appium work, including reuse of an
    existing session. Host-broker Appium session creation, deletion, and
    WebDriver requests apply the same exact lease contract for both physical
    Android and iOS records. Missing, expired, foreign, or forged leases fail
    before provider commands or Appium HTTP effects. Brokers advertise and MCP
    clients require `physical-appium-lease-fencing-v1` so a current client
    cannot reuse an older broker with the persisted-hardware-ID trust boundary.
46. Direct Android physical-device effects require the exact live attachment
    lease at operation time. Device status, every ADB-backed operation, and
    owner-scoped lifecycle or detach handling refresh and validate the owner,
    device ID, serial, claim ID, claim nonce, and expiry before touching the
    target. A missing, expired, foreign, or forged lease fails closed before
    ADB discovery, commands, process signaling, or attachment removal. This is
    a direct-provider invariant; physical Appium broker routes remain covered
    by `physical-appium-lease-fencing-v1` and require no capability change.
47. Host-broker physical device-tool effects refresh the exact live attachment
    lease before dispatch. This covers broker child-handler routing, broker-
    managed Android physical recording start and stop, and physical Appium
    session creation, deletion, and requests. The broker validates owner,
    device ID, serial or UDID, claim ID, claim nonce, and expiry, while current
    direct providers repeat the check immediately before target effects. A
    stale owner record therefore cannot invoke a custom runner, start or stop
    ADB recording, signal its runtime, or reach Appium after a successor lease
    is installed. Brokers advertise and MCP clients require
    `physical-device-tool-lease-fencing-v1`, preventing reuse of an older
    broker whose bundled provider or recording route retains the weaker trust
    boundary.
48. Host-broker physical lifecycle status and start invocation refresh the
    exact attachment lease after planning and immediately before the provider
    command. Dry-run planning remains side-effect free, while real Android ADB
    and iOS devicectl probes require the persisted owner, device ID, serial or
    UDID, claim ID, claim nonce, and expiry to match under the shared lease
    mutation lock. Brokers advertise and MCP clients require
    `physical-lifecycle-use-lease-refresh-v1`, distinguishing this use-time
    authority check from the existing stop/delete release and rollback
    contract.
49. Appium metadata record and clear operations no longer discard cleanup
    authority for a live broker-owned server. The broker verifies the recorded
    PID and process identity before metadata replacement; a matching runtime
    returns `appium-runtime-active` and requires `broker.appium.stop` first.
    Imported metadata and stale or exited broker runtimes remain replaceable
    and clearable, and every state transition is generation-matched. Brokers
    advertise and MCP clients require
    `appium-live-runtime-metadata-fencing-v1`.
50. Synchronous host cleanup and compatibility CLI stop/delete paths now share
    the same owner/device operation lock as broker and direct-provider work.
    Before a provider effect they re-read and match the exact device record;
    after the effect they apply a compare-and-set transition, preserving a
    same-ID successor even if a non-cooperating writer bypasses the operation
    lock. Live or unobservable broker-owned Appium metadata fails closed instead
    of being cleared by a path that cannot perform broker process-tree cleanup.
    Physical lease release also requires the persisted claim ID and claim nonce;
    an older same-owner/same-device cleanup cannot delete a successor claim.
51. Direct Android Emulator start, stop, and delete now claim a random lifecycle
    generation in owner state before provider effects and commit completion with
    an exact-record compare-and-set transition. A writer that bypasses the shared
    operation lock cannot make an old lifecycle result overwrite or remove a
    same-ID successor. Emulator starts persist the launcher PID and process
    identity; a superseded start rolls back the exact fresh process tree, while
    an unverifiable startup retains recovery metadata unless termination is
    proven. Stops verify the recorded process tree has exited before clearing
    runtime state. The Windows VBS launcher remains hidden but waits for its
    emulator command, preserving a parent tree that can be terminated with
    identity-checked `taskkill /T`. Brokers advertise and MCP clients require
    `direct-android-lifecycle-generation-fencing-v1`, so a same-version stale
    broker cannot keep the previous unconditional lifecycle state writes.
52. Direct iOS Simulator start, stop, and delete now claim a random lifecycle
    generation before simulator or runtime effects and commit only when the
    exact claimed record remains current. A same-ID successor installed by a
    writer that bypasses the operation lock is preserved and the stale request
    returns `owner-device-state-conflict`. If a successor appears while a
    simulator is booting, CCC shuts down the just-booted owned UDID instead of
    leaving an untracked runtime. A running simulator without `xcrun`, or a
    failed `simctl shutdown`, retains its prior running generation instead of
    being falsely recorded as stopped. Delete rollback records each completed
    side effect: stopped recording metadata becomes inactive, stopped Appium
    metadata is cleared, and a successful simulator shutdown remains stopped
    when a later `simctl delete` fails. Once the owned simulator is deleted, a
    later recording-stage cleanup failure cannot resurrect the owner device
    record or its stale runtime metadata. Brokers advertise and MCP clients require
    `direct-ios-lifecycle-generation-fencing-v1`, preventing reuse of a stale
    same-version broker with unconditional iOS lifecycle state writes.
53. Direct Windows Sandbox start, stop, and delete now claim a lifecycle
    generation and commit owner state with exact-record compare-and-set. The
    host-wide singleton `claimId` is persisted with that lifecycle and must
    match for lock update or release, so stale same-owner work cannot remove a
    successor lock. A missing lock for a recorded running sandbox is reclaimed
    for the exact sandbox GUID before stop; a foreign lock fails before provider
    effects. Superseded starts stop the newly launched runtime and clean their
    minimize watchdog before releasing only their own singleton generation.
    Running duplicate starts are rejected before provider or lock mutation, and
    a failed provider stop preserves running state while retaining completed
    watchdog cleanup. Brokers advertise and MCP clients require
    `direct-windows-lifecycle-generation-fencing-v1`.
54. Direct macOS VM start, stop, and delete now claim a random lifecycle
    generation before Tart, VZ, or UTM provider effects and commit with an
    exact-record compare-and-set transition. Duplicate start is rejected
    before provider dispatch. A stale completion cannot overwrite or remove a
    same-ID successor, and startup rollback stops the launched provider only
    when the current state does not assign that provider instance to the
    successor. Partial managed-resource delete records each completed snapshot
    or restore-candidate deletion only in the still-current generation, keeping
    retries idempotent without mutating successor state. Brokers advertise and
    MCP clients require `direct-macos-lifecycle-generation-fencing-v1`.
    Snapshot create/restore/delete generation fencing and force-clone source
    locking remain separate follow-up work and are not implied by this
    lifecycle capability.
55. Direct macOS snapshot create, restore, and delete now claim their own
    lifecycle generations before Tart effects and commit only through exact
    owner-record compare-and-set transitions. Restore revalidates its
    generation between candidate creation, primary deletion, activation, and
    candidate cleanup; when recovery cannot be completed safely, it preserves
    the candidate and records recovery authority instead of hiding a partial
    provider mutation. Device clones acquire target and source operation locks
    in canonical order, hold a source lifecycle generation across optional
    force-stop and provider clone, and roll back an unowned target when the
    source is superseded. Brokers advertise and MCP clients require
    `direct-macos-snapshot-clone-generation-fencing-v1`.
56. Direct physical Android and iOS stop and detach now claim a random
    lifecycle generation before volatile-process effects. Recording and
    Appium exit callbacks may update their own metadata inside that generation,
    but final metadata clearing or attachment removal requires the exact
    lifecycle ID to remain current. A lock-bypassing same-ID successor is
    preserved, the stale operation returns `owner-device-state-conflict`, and
    detach releases only the old exact lease after successful owner-state CAS.
    Brokers advertise and MCP clients require
    `physical-direct-state-transition-fencing-v1`. Windows Sandbox minimize
    confirmation also inspects an existing result at least once when its wait
    timeout is zero, eliminating a clock-tick-dependent false timeout.
57. Canonical container project mount paths retain the host-derived project ID
    instead of being hashed a second time, so host CCC and container MCP agree
    on one owner namespace. A shared host broker records an atomic, bounded
    mapping from each canonical owner to its host project path before launch or
    reuse. Owner resolve accepts only registered canonical mount/profile pairs,
    rejects malformed, missing, or tampered mappings before provisioning auth,
    and dispatches each authenticated RPC with that owner's host project root.
    Container file paths therefore cannot be translated through the unrelated
    project that originally launched the shared broker. Brokers advertise and
    MCP clients require `multi-project-owner-resolve-v1`.
58. CCC-managed MCP bundles are synchronized from the executing host CLI
    package into every newly created, restarted, or reused project container.
    Image-baked bundles remain an offline fallback, but a same-version local
    rebuild or hotfix cannot silently keep an older device-lab client merely
    because the image version label is unchanged. Host bundle inputs must be
    regular, non-symlink files within a bounded size. Each bundle is copied to
    a container staging path and installed as the `ccc` user only after the
    complete copy succeeds, so a failed transfer leaves the prior entrypoint
    intact rather than partially overwriting it. Matching host/container
    SHA-256 digests skip the transfer, and every completed install is hashed
    again; a mismatched destination is removed instead of being executed.
59. Physical Android real E2E must be broker-aware: a client container does not
    need a local ADB binary when the authenticated host broker owns provider
    discovery and execution. The scenario directly invokes every advertised
    physical Android capability and normalizes direct-provider and broker RPC
    result contracts. Android recording stop treats a denied remote
    `pkill -2 screenrecord` as a fallback diagnostic only after the broker has
    identity-checked, signaled, and observed exit of its owned host recorder;
    PID reuse, failed host signaling, and a recorder that remains alive still
    fail closed. Brokers advertise and clients require
    `android-recording-signal-fallback-v1`.
60. Cross-host physical E2E files must be created under the shared project
    `results/` tree, not a container-only temporary directory. Broker-reported
    Windows paths are normalized against the expected shared artifact before
    file contents are verified. App installation exposes bounded
    `helperTimeoutMs`, and broker error envelopes fail with their actual
    diagnostic. A device-side package verifier rejection remains a real error
    and is not converted into a skip or silently bypassed.
61. The physical Android fixture is a standard target-SDK 35 APK produced with
    Android `javac`, `d8`, `aapt2`, `zipalign`, and `apksigner`, and carries v1,
    v2, and v3 signatures. Fixture materialization verifies the APK signing
    block and v2/v3 scheme IDs so a handcrafted v1-only archive cannot silently
    return. The real-device scenario validates the public app lifecycle through
    install, launch, running-process wait, permission mutation, force-stop,
    reset, clear-data, and uninstall without changing package-verifier or USB
    security settings. It also normalizes direct-provider and broker physical
    stop contracts: both must prove that the real device was preserved, while
    the broker expresses this as a successful no-op provider command followed
    by owner attachment and lease cleanup.
62. Recorder start rollback must cover metadata persistence exceptions as well
    as compare-and-set conflicts. After an external recorder process starts,
    a thrown owner-state write terminates that exact spawned process, waits for
    exit with a bounded force-kill fallback, and disarms its exit callback
    before rollback. The exception path performs no compensating owner-state
    mutation, so a concurrently installed successor recording generation is
    preserved unchanged.
63. Linux container-QEMU is a `device-lab` backend, not a second public MCP.
    The backend name is `linux-vm`; it shares canonical owner identity, locking,
    lifecycle, inventory, file transfer, snapshot, and error-result contracts
    with the other device providers. The standalone `lab-mcp` registration,
    build output, package surface, and legacy `lab_*` tools are retired. The
    `ccc labs` CLI remains only as a non-starting KVM/QEMU readiness diagnostic
    for the `device-lab` Linux VM backend.
