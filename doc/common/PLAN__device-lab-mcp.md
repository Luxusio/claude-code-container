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
   - Does not directly start VMs or emulators.
   - Talks to the host broker through CCC's existing host reachability path.

2. `ccc-device-broker`
   - Host-side broker process started lazily by the MCP server.
   - Owns device inventory, locking, lifecycle, and backend adapters.
   - Runs only when a device MCP call needs host control.
   - Stores state under `~/.ccc/devices`.
  - Current implementation exposes the broker contract through
    `device_broker_status` and `device_backends.broker` without starting a
    daemon by default. Broker tools can explicitly autolaunch the HTTP broker
    and record MCP-owned runtime metadata. Normal backend lifecycle tools use
    direct-provider mode by default, but `device_status`, `device_start`,
    `device_stop`, and `device_delete` can explicitly opt into broker routing
    with `broker: true`, `viaBroker: true`, or `autolaunch: true`.

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

Broker contract status:

- `device_broker_status` reports the current host-control mode, owner ID,
  lazy startup policy, deterministic zero-config host candidates
  (`host.docker.internal`, `host.containers.internal`, `gateway.docker.internal`,
  `172.17.0.1`, `10.0.2.2`), default broker port, and owner/broker state
  roots without starting a daemon, emulator, simulator, sandbox, or VM.
- When called with `probe: true`, `device_broker_status` performs bounded
  HTTP `GET /health` checks against the supplied or default host candidates and
  reports structured success/failure attempts. The default call path and
  `device_backends` still do not probe or start anything. Explicit probes are
  capped at eight host candidates and 2000ms per candidate.
- When called with `autolaunch: true`, `device_broker_status`,
  `device_broker_rpc`, `device_broker_lease`, `device_broker_attach`,
  `device_broker_command`, and opt-in lifecycle tools
  first reuse a healthy broker if one is reachable, then check owner-scoped
  runtime metadata, and finally start `ccc devices broker serve --host
  <host> --port <port>` only for the broker process. This does not start
  emulators, simulators, sandboxes, VMs, Appium, or provider tools.
- MCP-owned broker launches write runtime metadata under
  `~/.ccc/devices/broker/runtime.json`, including `pid`, `ownerId`, `host`,
  `port`, command/args, log path, `startedAt`, and `managedBy:
  device-lab-mcp`. Stale metadata is removed when the recorded pid is gone or
  health checks fail.
- Broker owner RPC uses a zero-configuration per-owner random secret stored at
  `~/.ccc/devices/broker/auth/<owner-id>.json` with 0600 permissions. Both the
  in-container MCP client and host broker derive `x-ccc-device-token` from the
  owner ID plus this secret, so the token is no longer predictable from owner
  ID alone.
- `device_broker_shutdown` stops the MCP-owned broker recorded for the current
  owner and removes runtime metadata. The MCP process also registers a
  best-effort exit cleanup hook for broker children it launched.
- `device_backends` includes the same broker diagnostics so agents can decide
  whether they are in direct-provider mode or future host-broker mode before
  requesting lifecycle work.
- `device_broker_rpc` provides an explicit diagnostic transport to an
  already-running or explicitly autolaunched host broker. It posts to
  `/v1/owners/<owner-id>/rpc` with a secret-backed owner token, supports
  diagnostic `broker.status`, `broker.inventory`, and `broker.echo` methods,
  and reports structured per-candidate attempts. The public RPC tool still does
  not expose physical lease or mutating lifecycle methods; those remain behind
  dedicated tools.
- `device_broker_lease` explicitly claims, lists, and releases host-wide
  physical hardware leases for `android-device` and `ios-device` through a
  running or explicitly autolaunched broker. Claims are owner-scoped and backed
  by atomic lock files under
  `~/.ccc/devices/physical-leases/<backend>/locks`, so one CCC owner cannot
  overwrite or release another owner's USB/Wi-Fi real-device reservation.
- `device_broker_attach` explicitly attaches, detaches, or lists physical
  Android/iOS devices through a running or explicitly autolaunched broker.
  Android Wi-Fi attach claims the host-wide lease before `adb connect`, verifies
  `adb devices -l` reports the target in `device` state, and writes owner state.
  iOS attach validates visibility through `xcrun xctrace list devices`; Wi-Fi
  attach is accepted only for devices already visible as network/Wi-Fi devices.
  Detach removes only owner state and owner leases, never powering off, erasing,
  globally disconnecting, or pairing the real device.
- `device_broker_command` explicitly plans, dry-runs, or invokes owner-scoped
  lifecycle commands through a running or explicitly autolaunched broker. It
  supports allowlisted `device_status`, `device_start`, `device_stop`, and
  `device_delete` command envelopes for existing owner device definitions
  across Android, iOS, Windows, and macOS backends. Non-dry-run invoke builds
  bounded provider commands without shell interpolation, applies timeout/output
  caps, handles emulator starts as detached launches, and reports structured
  missing-metadata/provider failures. Physical Android/iOS stop/delete commands
  are safety no-ops rather than host power/disconnect operations.
- `device_status`, `device_start`, `device_stop`, and `device_delete` preserve
  direct-provider behavior by default, but can opt into the same broker command
  route with `broker: true`, `viaBroker: true`, or `autolaunch: true`. When
  `backend` is omitted, the MCP server infers the backend from the current
  owner-scoped device id before contacting a broker and returns structured JSON
  inference errors if the device id is missing, unknown, or ambiguous.
- Environment variables are not required for broker discovery, RPC, or physical
  lease/lifecycle command operations. Default broker routing for every
  lifecycle call, Apple device pairing/trust bootstrap through the broker,
  and permanent host service manager integration remain deferred.

Host broker daemon skeleton status:

- `ccc devices broker status` prints the host broker's default bind address,
  port, current owner namespace, state roots, implemented HTTP status/health
  surface, secret-backed owner RPC auth, and deferred full-routing/service-manager
  work without starting any devices.
- `ccc devices broker serve [--host HOST] [--port PORT]` starts a small
  host-side HTTP server. The server currently exposes `GET /health`,
  `GET /status`, and owner-scoped `POST /v1/owners/<owner-id>/rpc` for
  broker status/inventory/echo, physical lease claim/list/release, and
  lifecycle command plan/invoke methods. It returns JSON errors for
  unsupported methods/routes and rejects missing owner tokens, owner mismatches,
  invalid JSON, oversized requests, invalid lease or command params,
  cross-owner lease operations, unknown methods, missing provider metadata, and
  failed provider commands.
- MCP can now explicitly autolaunch and shut down this broker for broker tools
  and opt-in lifecycle tools. The current in-container MCP remains in
  direct-provider mode by default for normal backend lifecycle tools until
  default broker routing and permanent host service-manager integration are
  implemented.

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

14. `device_image_create` / `device_image_clone`
    - Creates and clones owner-scoped VM images where supported.
    - macOS Tart uses provider clone operations to create a stopped device
      definition from a base image or existing owned provider instance.
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
- Appium integration is implemented for high-level Android UI/app automation;
  remaining Android work is provider hardening and broader action coverage.

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
- The host broker exposes Android physical leases through `device_broker_lease`
  and physical attach/detach/list through `device_broker_attach`. Broker Wi-Fi
  attach performs lease-before-`adb connect`, verifies `adb devices -l`, and
  records owner-scoped attached-device state.
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

Physical iOS device attachment status:

- `ios-device` is a separate non-creatable backend for real iPhones/iPads
  connected to a macOS host over USB or already paired for Xcode network use
  and trusted through the iOS "Trust This Computer" prompt.
- Host prerequisites are `xcrun` and `xcodebuild`; full automation still relies
  on the Appium/XCUITest layer and normal Apple signing/provisioning
  requirements.
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
- The host broker exposes iOS physical leases through `device_broker_lease` and
  physical attach/detach/list through `device_broker_attach`. Broker attach
  validates the UDID through `xcrun xctrace list devices`; Apple network pairing
  and trust bootstrap remain outside CCC and must already be satisfied.
- `device_start` is a no-op readiness acknowledgement; `device_stop` and
  teardown cleanup clear owner-scoped Appium/recording/pid metadata but never
  call `simctl shutdown`, erase, power off, or disconnect the physical device.
  Teardown cleanup also marks the attachment detached and releases the
  host-wide hardware lock so later CCC owners can attach the same trusted
  device.
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
- `device_inventory` reports owner-scoped Windows Sandbox definitions,
  helper/config paths, and `wsb` discovery metadata without starting the
  sandbox or helper.
- `device_start` writes an owner-scoped `.wsb` configuration and runs
  `wsb start` only on explicit calls when available. `device_stop` calls
  `wsb stop` only on explicit calls and reports stop failures instead of
  marking a still-running sandbox as stopped.
- `device_delete` removes the owner-scoped scratch/helper workspace for stopped
  definitions. Running definitions are refused unless `force: true`; forced
  delete first performs the same `wsb stop` path, clears recording metadata,
  and only removes state/workspace after stop succeeds. Stop failure preserves
  state and scratch so cleanup can be retried.
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
  sandbox and adding a LogonCommand that starts the CCC guest helper.
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
- Tart-backed VM image create/clone/snapshot operations are implemented through
  owner-scoped provider clones. Deleting managed Tart image/clone definitions
  deletes their provider instances after refusing running devices unless
  `force=true`; forced delete stops the VM first, and provider delete failures
  preserve owner state so cleanup can be retried. Successful snapshot/recovery
  candidate deletions are removed from state immediately, so a later partial
  delete failure does not block retry cleanup of remaining Tart resources.
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
  diagnostics.
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
- Automatic SSH credential provisioning and real macOS host smoke tests remain
  deferred.

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

CLI foundation status:

- `ccc devices status`, `ccc devices list`, `ccc devices backends`, and
  `ccc devices doctor` expose current owner-scoped device-lab state and local
  prerequisite diagnostics without starting devices, brokers, Appium, or
  emulators.
- The CLI reads the same owner namespace shape as `device-lab-mcp` under
  `~/.ccc/devices/owners/<owner-id>/...` and does not expose other owner
  directories.
- `ccc devices stop <device-id>` stops only a current-owner definition. It uses
  conservative backend stop hooks when available (`adb emu kill`,
  `simctl shutdown`, `wsb stop`, or provider VM stop) and then marks that owned
  definition stopped without scanning other owner directories.
- `ccc devices delete <device-id>` removes only current-owner stopped
  definitions and refuses running definitions so callers stop first.
- `ccc devices prune` removes stopped definitions from the current owner
  namespace while preserving running/booted definitions and foreign owner
  state.
- `ccc devices smoke` runs a non-destructive host prerequisite smoke matrix for
  Android, iOS Simulator, Windows Sandbox, and macOS VM provider tooling. It
  reports PASS/SKIP/FAIL with concrete command status or missing prerequisite
  details and does not start emulators, simulators, sandboxes, VMs, Appium, or
  brokers. Each smoke command is bounded by a timeout so a hanging host tool
  reports FAIL instead of blocking the CLI indefinitely.
- `ccc devices admin list --all` explicitly scans every owner namespace without
  mutating state. `ccc devices admin stop --all` applies the same conservative
  backend stop and physical lease release semantics across every owner namespace
  for host/container teardown. `ccc devices admin prune` removes stopped or
  detached definitions across every owner while preserving active definitions.
  Regular non-admin CLI commands intentionally stay owner-scoped.

Container cleanup hook status:

- CCC now runs owner-scoped device cleanup before stopping a project container
  through `ccc stop`, `ccc rm`, or last-session cleanup.
- Cleanup only reads and mutates the current owner namespace under
  `~/.ccc/devices/owners/<owner-id>/...`; foreign owner device definitions are
  not enumerated or changed.
- Android cleanup uses `adb -s <serial> emu kill` when an owner device has a
  serial/port, iOS cleanup uses `xcrun simctl shutdown <target>`, Windows
  Sandbox cleanup uses `wsb stop`, and macOS VM cleanup uses whitelisted
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
  schema/lazy-start checks plus metadata-only X11, Android, iOS, Windows, and
  macOS definition coverage.
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
   - Add `ccc devices` commands, stale lock cleanup, owner-scoped prune, and
     explicit all-owner admin list/stop/prune.

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
8. `ccc devices admin list --all`, `ccc devices admin stop --all`, and
   `ccc devices admin prune` operate only through explicit admin subcommands;
   list is read-only, stop uses backend-safe cleanup semantics across owners,
   and prune removes stale stopped/detached resources without touching active
   resources.
9. X11 display tools remain available without creating a device definition and
   without starting a host broker.
