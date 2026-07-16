---
type: AUDIT
status: current
created: 2026-07-15
---

# Device Lab Real Capability Matrix

This matrix is the fixed completion gate for the public Android Emulator and
Windows Sandbox surfaces. Percent estimates are not evidence. A provider is
complete only when its real E2E calls every capability advertised by that
backend and the returned `verifiedCapabilities` set exactly covers that
advertised set.

## Completion State

| Provider | Advertised | Called by real E2E | Latest real result | Completion |
| --- | ---: | ---: | --- | --- |
| Android Emulator | 52 | 52 | PASS on a real Android 37.1 x86_64 emulator on 2026-07-15 | complete |
| Windows Sandbox | 21 | 21 | PASS on a real Windows Sandbox through broker `1.1.71` on 2026-07-16 | complete |

The static gate in
`src/__tests__/device-lab.real-capability-coverage.test.ts` compares backend
advertisements with the operations present in each real E2E. The runtime gates
in `scripts/real-tests/android-emulator-e2e.mjs` and
`scripts/real-tests/windows-sandbox-e2e.mjs` independently collect actual MCP
calls and fail if any advertised capability was not called. The Level 3
coverage matrix applies the same requirement.

## Android Emulator: 52

```text
device_inventory, device_create, device_delete, device_start, device_stop,
device_status, device_exec, device_screenshot, device_record_video_start,
device_record_video_stop, device_record_video_status, device_upload,
device_download, device_reset, device_install_app, device_launch_app,
mobile_session_status, mobile_dump_ui, mobile_tap, mobile_double_tap,
mobile_long_press, mobile_swipe, mobile_drag, mobile_type_text, mobile_key,
mobile_home, mobile_back, mobile_forward, mobile_recents, mobile_power,
mobile_lock, mobile_unlock, mobile_rotate_left, mobile_rotate_right,
mobile_set_orientation, mobile_open_url, mobile_install_app,
mobile_launch_app, mobile_uninstall_app, mobile_stop_app,
mobile_clear_app_data, mobile_grant_permission, mobile_revoke_permission,
mobile_set_location, mobile_set_battery, mobile_set_network,
mobile_toggle_airplane_mode, mobile_set_clipboard, mobile_get_clipboard,
mobile_wait_for_text, mobile_wait_for_app, mobile_screenshot
```

The live proof created and deleted its own AVD, exercised destructive controls,
ADB, UIAutomator, Appium, recording, transfer, lifecycle, and application
operations, and returned all 52 names in `verifiedCapabilities`. Application
operations use the deterministic `dev.ccc.fixture` APK with target SDK 24 and
CAMERA permission. Its packaged SHA-256 is
`04b8909e02669359a2a3babe0751f9c272e2ed5a2aeeb56c461a8208b32bd4c2`.

## Windows Sandbox: 21

```text
device_inventory, device_create, device_delete, device_start, device_stop,
device_status, device_exec, device_screenshot, device_click,
device_double_click, device_key, device_type, device_scroll,
device_cursor_position, device_window_list, device_accessibility_snapshot,
device_record_video_start, device_record_video_stop,
device_record_video_status, device_upload, device_download
```

The expanded live test exposed that the broker advertised the three recording
operations but returned `broker-device-recording-unsupported` for Windows.
The broker now proxies Windows and macOS recording operations through their
guest-helper backends and advertises `guest-helper-recording-proxy-v1`. The
first live expanded run then exposed a duplicate cross-process lock: the broker
held the owner/device lock while the out-of-process backend attempted to acquire
the same lock. The broker now delegates that lock to the backend and advertises
this runtime fix through package version `1.1.71`; the routing regression
acquires the same lock inside the backend runner to prevent this deadlock from returning.
The first `1.1.71` live rerun passed recording start and therefore confirmed the
lock fix, then exposed that the live broker status response can omit optional
provider and device echo diagnostics, or return the recording state directly.
The real E2E now verifies provider identity on start and stop, verifies the
active recording state on status, and normalizes envelope, nested, and bare
recording-state response shapes with a focused regression.
The next live rerun identified the underlying status failure: the MCP route
classified recording status as fast and discarded its explicit helper timeout,
leaving the broker RPC at one second. Explicit helper deadlines now take
precedence and include the bounded RPC buffer; inventory retains the fast path.
That fix exposed a host-image compatibility issue during recording stop:
`Microsoft.PowerShell.Archive` was present but unloadable in Windows Sandbox.
The helper now creates ZIP archives through the framework
`System.IO.Compression.ZipFile` API, and error responses preserve request type
so helper failures return immediately instead of appearing as long timeouts.
The final live pass also led to a cleanup hardening: successful and failed runs
remove their current owner artifact directory, and preflight removes orphaned
test-prefix directories even when no stale `devices.json` record remains.
The final live run returned `PASS` and all 21 names in `verifiedCapabilities`
through host broker `1.1.71` (PID 3768). It exercised helper execution,
screenshot and desktop input, window/accessibility inspection, file transfer,
recording start/status/stop with a non-empty ZIP archive, and lifecycle cleanup.
No test-owned device record or `windows-real-sandbox-*` artifact directory
remained after verification.

## Required Evidence

1. `npm test` passes.
2. `npm run lint`, `npm run build`, `npm pack --dry-run --json`, and
   `git diff --check` pass.
3. Android real E2E returns `PASS` and exactly 52 verified capabilities.
4. Windows real E2E returns `PASS` and exactly 21 verified capabilities.
5. Each E2E removes its test-owned device and temporary artifacts in `finally`.

Platform readiness checks, fake-provider tests, and static capability scans are
necessary regression gates, but they do not replace items 3 and 4.
