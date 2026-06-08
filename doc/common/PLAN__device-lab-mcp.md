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
      ios-state.mjs           # owner-scoped iOS Simulator state store
      windows-state.mjs       # owner-scoped Windows Sandbox state store
      macos-state.mjs         # owner-scoped macOS VM state store
    display/
      x11.mjs                 # current display target and display_* tools
    backends/
      android.mjs             # Android lifecycle and Appium Android tools
      ios-simulator.mjs       # iOS Simulator lifecycle via simctl
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
   - Does not directly start VMs or emulators.
   - Talks to the host broker through CCC's existing host reachability path.

2. `ccc-device-broker`
   - Host-side broker process started lazily by the MCP server.
   - Owns device inventory, locking, lifecycle, and backend adapters.
   - Runs only when a device MCP call needs host control.
   - Stores state under `~/.ccc/devices`.

3. Backend adapters
   - `android-emulator`: Android SDK emulator and `adb`.
   - `ios-simulator`: Xcode `xcrun simctl` on macOS hosts.
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
   - The existing X11 MCP should be folded into `device-lab-mcp` as a
     non-creatable, always-current display target.
   - X11 should support screenshot, click, key, type, scroll, and related screen
     control tools.
   - X11 should not expose create/delete lifecycle tools because it represents
     the current CCC container's display bridge rather than an inventory-managed
     VM or emulator.

## Per-container isolation

CCC should derive a stable `ownerId` from the same identity used for container
isolation: project path hash, profile, and worktree identity. The MCP server
passes this owner identity to the broker on every request.

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

3. `device_create`
   - Creates a device definition in the current owner namespace.
   - Inputs: backend, name, image/runtime, device type, preset.

4. `device_delete`
   - Deletes an owned stopped device definition.
   - Refuses running devices unless `force` is true.

5. `device_start`
   - Starts or attaches to an owned device instance.
   - Returns readiness state, endpoint metadata, and next useful actions.

6. `device_stop`
   - Stops an owned running instance.

7. `device_status`
   - Reports lifecycle, boot readiness, logs, ports, and known errors.

8. `device_exec`
   - Runs a command where supported.
   - Android uses `adb shell`; iOS uses `simctl spawn` where supported; Windows
     and macOS VM may use a guest helper for stdout/stderr.

9. `device_screenshot`
   - Captures screen evidence to an owner-scoped artifact path.

10. `device_upload` / `device_download`
    - Transfers files through owner-scoped scratch paths.

11. `device_install_app` / `device_launch_app`
    - Installs and launches APK, `.app`, `.ipa` where supported, or Windows/macOS
      app bundles where a backend supports it.

12. `device_reset`
    - Resets owned device state without deleting the definition.

Optional future tools:

- `device_record_video`
- `device_snapshot_create`
- `device_snapshot_restore`
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

Current-display tools:

- `display_current`
- `display_screenshot`
- `display_click`
- `display_double_click`
- `display_key`
- `display_type`
- `display_scroll`
- `display_cursor_position`

These should replace the standalone X11 MCP entry once compatibility is handled.

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
- It discovers `adb` and `emulator` from PATH and standard SDK locations, then
  reports missing prerequisites without requiring CCC-specific environment
  variables.
- `device_start`, `device_stop`, `device_exec`, and `device_screenshot` are
  wired to Android command-line tools when available, but MCP startup and
  discovery calls remain lazy and do not start emulator or adb processes.
- Appium integration is intentionally deferred to the next mobile automation
  slice.

Appium Android layer status:

- `device-lab-mcp` declares CCC-managed `appium` and
  `appium-uiautomator2-driver` dependencies so normal users do not manually
  install Appium drivers for Android automation.
- Android mobile tools are exposed through `mobile_session_status`,
  `mobile_dump_ui`, `mobile_tap`, `mobile_type_text`, and `mobile_back`.
- Appium server/session startup remains lazy. Discovery, device listing, and
  session status report metadata and missing prerequisites without starting
  Appium.
- Mobile tools operate through owner-scoped Android device definitions and
  return missing-prerequisite diagnostics when Appium/adb are unavailable.

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
- Real `simctl create/delete` and iOS Appium/XCUITest integration are deferred
  to later hardening/mobile automation slices.

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
3. Start sandbox through `wsb start`.
4. Use `wsb share`, `wsb ip`, and guest helper when command output or screenshots
   are needed.
5. Stop through `wsb stop` and clean owner-scoped scratch artifacts.

Foundation status:

- The first Windows implementation slice exposes owner-scoped Windows Sandbox
  definitions through the common `device_create`, `device_list`,
  `device_status`, and `device_delete` tools.
- `windows-sandbox` backend discovery reports `wsb` availability and missing
  prerequisites without requiring Windows in normal Linux CI.
- `device_start` writes an owner-scoped `.wsb` configuration and runs
  `wsb start` only on explicit calls when available. `device_stop` calls
  `wsb stop` only on explicit calls.
- Guest helper installation, command stdout/stderr capture, and richer
  Windows automation are deferred to later hardening slices.

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
4. Expose exec, screenshot, upload/download, and stop.

Foundation status:

- The first macOS VM implementation slice exposes owner-scoped macOS VM
  definitions through the common `device_create`, `device_list`,
  `device_status`, and `device_delete` tools.
- `macos-vm` backend discovery reports whether the host is macOS and whether a
  practical provider command such as `tart`, `vz`, or `utmctl` is available.
- `device_start` remains lazy and returns diagnostics/provider-deferral instead
  of starting a VM until a provider-specific implementation is selected.
- Real VM image create/clone/snapshot/boot and guest helper integration are
  deferred to later provider-specific hardening slices.

## CLI support

Add host/user commands for visibility and explicit control. These commands
should not be required for normal use, but they make diagnosis and cleanup
predictable.

```text
ccc devices status
ccc devices doctor
ccc devices backends
ccc devices list
ccc devices stop <device-id>
ccc devices delete <device-id>
ccc devices admin list --all
ccc devices admin stop --all
ccc devices admin prune
```

No CCC-specific environment variables should be required.

## Integration with existing CCC

1. Add managed MCP entry generation in `src/mcp-forward.ts`.
2. Bundle `device-lab-mcp` similarly to the existing X11 MCP server.
3. Add owner identity calculation near existing container/session identity code.
4. Add host broker launcher and host reachability checks.
5. Add package tests for MCP config generation.
6. Add broker unit tests with mocked backend commands.
7. Add backend smoke tests that skip when prerequisites are unavailable.

## Milestones

1. Foundation
   - Define lifecycle schema, owner ID, state store, and MCP tool shapes.
   - Add broker with fake backend for tests.

2. MCP integration
   - Register `device-lab` as CCC-managed MCP.
   - Verify normal CCC startup does not start any device process.
   - Initially keep the standalone `x11-display` MCP for compatibility while
     exposing equivalent `display_*` tools from `device-lab`.

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
   - Add `ccc devices` commands, stale lock cleanup, and owner-scoped prune.

8. Hardening
   - Add security review for folder mappings, network presets, port allocation,
     guest helper authentication, and cross-owner isolation.

9. X11 consolidation
   - Migrate callers from standalone `x11-display` tools to `device-lab`
     `display_*` tools.
   - Remove the standalone `x11-display` MCP entry only after compatibility and
     test coverage are in place.

## Verification

1. Unit tests confirm MCP config is written without starting the broker.
2. Unit tests confirm owner A cannot list, stop, delete, or inspect owner B's
   devices.
3. Mocked backend tests cover create/start/status/stop/delete for every backend.
4. Real Android smoke test runs only when SDK prerequisites exist.
5. Real iOS smoke test runs only on macOS with Xcode.
6. Real Windows smoke test runs only on Windows with Sandbox CLI.
7. Real macOS VM smoke test runs only on supported macOS hosts.
8. `ccc devices admin prune` removes stale stopped resources without touching
   running resources from active owners.
9. X11 display tools remain available without creating a device definition and
   without starting a host broker.
