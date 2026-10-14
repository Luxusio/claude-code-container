# Device Lab MCP computer use

Public tool names describe actions without platform prefixes. Use `click` for
desktop clicks and mobile taps, `type` for text, and `key` for keys. Mobile
clicks support only the left button. `swipe` and `long_press` remain distinct
touch gestures. The current container display has deviceId `x11-current-display`.

Simple successful actions reply `ok`; queries return their data or image.
Warnings and errors remain visible. VM creation returns a fresh opaque deviceId;
retain it for every later operation. Display names may repeat and do not select
an instance. Public VM creation accepts no chosen deviceId or QEMU labId.
Request `detail:true` only for troubleshooting. Before pixel input, capture a
screenshot and use in-bounds image coordinates, including on `run_flow`.
After an identity conflict,
take a fresh screenshot before deciding whether to repeat the intended input.

Choose a device from `devices`, then include its `deviceId` in each operation.
There is no remembered device selection shared between agents. To perform several
known actions, put `deviceId` once on `run_flow` and finish with a screenshot;
start a new call when you need to inspect the result before deciding what to do.

## Browse and transfer files

Use `list_files({deviceId,path})` to see immediate directory entries, including
hidden files. Each entry has `name`, `type`, and file `size` when available.
An empty directory returns `entries:[]`; failures remain errors. Results default
to 100 entries (`limit` accepts 1–500) and have a fixed byte cap;
`truncated:true` means more entries exist. Listing does not recurse or read file
contents. POSIX directory globs expand before the bounded output loop, so a very
large directory may still hit the transport deadline.

Use `upload` and `download` to transfer files. On iOS Simulator, specify
`appId` and an app-relative `path`, such as `Documents`; `containerType`
defaults to `data`. Paths cannot escape that app container. Actual iPhones can
expose file-sharing-enabled app Documents, but Device Lab does not yet implement
that physical-iOS listing adapter. This is not unrestricted iPhone filesystem
access.

## Preparation tools that remain

Choose `create_android_emulator`, `create_ios_simulator`, `create_windows_vm`,
`create_windows_sandbox`, `create_linux_vm`, or `create_macos_vm` to create a device.
Each creation tool exposes only its platform's fields and needs no `backend`.
The former `create` tool is removed. `attach` and `wireless` connect physical devices;
`start` boots a device. `list_images` and `import_image` manage container QEMU
image records. `create_macos_vm` accepts `image` for a new definition or `sourceDeviceId` for an owned VM clone. `upload` and `download` handle file transfer preparation. These are
intentional resource changes. `devices` provides owned, backends and available query views. Internal
disk, guest-agent and automation-session preparation runs through the operation
that needs it, without a separate prerequisite tool call.

For a new Android AVD, provide `systemImage` (and optionally its owner-scoped
`avdName`); `avdName` alone reuses an existing AVD. For a new iOS Simulator,
provide `deviceType` and `runtime`; `udid` reuses an existing simulator, with its
matching `simulatorName` when needed. `createAvd` and `createSimulator` are no
longer public inputs. Installed resource choices come from `devices({view:"available",backend})`; create
does not silently download SDK images. Creation uses OS-specific fields with optional nested ssh and agent settings; unrelated
platform fields are rejected. Subsequent operations use the returned `deviceId`.

`clear_app_data` clears one app. `reset` erases an entire owned iOS Simulator;
both require destructive confirmation. `reset` no longer accepts app IDs or an
`eraseSimulator` switch. Caller-adjustable operation deadlines use `timeoutMs`;
`helperTimeoutMs` is private. Omit timeoutMs to use existing automatic defaults.

`workspace_sync` and `artifacts_export` are no longer public tools. They copied
files within CCC management storage, not across the guest boundary. Their private
storage operations remain available to the implementation.

The catalog is stable across callers. An empty inventory, stopped device or broker
outage does not hide setup/recovery tools. There is no shared selected device and
no additional tool-selection call. MCP pagination alone would not guarantee fewer
tools in client model context, so it is not used as a token-saving claim.

## Choose inputs for the target platform

Use `status({deviceId})` for device state and automation diagnostics. For a running
container-QEMU VM it also refreshes configured SSH/guest-agent readiness; a stopped
VM is reported without a guest probe. Use `devices({view:"backends"})` for host prerequisites and
broker diagnosis. There are no separate broker, automation, target-list or
readiness tools to call first.

QEMU `start` prepares the writable disk and configured guest agent. A provisioning
command enables automatic preparation unless `agent.autoProvision:false` was
explicitly configured. A failed preparation keeps the VM running and returns an
error; retry `start` to retry preparation without booting a second VM. `status`
never provisions anything. Commands and file transfers need no session-open call.
Image tools and macOS cloning select their backend automatically.

Creation uses platform-specific fields. Android AVD provisioning uses `systemImage`;
iOS provisioning uses `deviceType` and `runtime`. No provisioning flag is needed.
Hyper-V uses image/profile fields and Windows selects its provider automatically.
macOS uses `image` and optional `ssh:{host,port,user,keyPath,password}`.
Container QEMU uses `baseImageId` or `sourceImage`, optional
`ssh:{host,port,user,keyPath,readinessCommand}` and
`agent:{healthCommand,provisionCommand,autoProvision}`. Custom credentials are
not guessed. Generic `options` wrappers and old flat SSH/agent fields are rejected.

## Automated usage-flow checks

Run `npm test -- src/__tests__/device-lab-public-journey.test.ts` to check public
calls over actual MCP stdio and HTTP routing. The stateful simulated host covers
creation, returned-ID reuse, start/status, screenshots and input, file upload/list/
download, stop/delete, failure/retry and concurrent device flows. Requests use only
advertised fields, without private routing or verbose-response flags. Failed
mutations must not replay automatically; a failed flow must stop before its next
mutation, and another device must remain usable. These tests run without native
devices; provider/driver behavior remains covered by the platform real-test suites.

File transfers use `localPath` for the project file and `remotePath` for the device path.
The host broker maps container project paths to the host project. On iOS Simulator,
provide `appId`; `remotePath` is relative to that app container (for example,
`Documents/report.txt`), and `containerType` defaults to `data`. App installation
uses `path` for the app package in the project.

All app actions use `appId`; Android launch alternatively accepts `component`.
Do not send both. `permission` accepts `appId`, `action:"grant"` or `"revoke"`,
and `permission` containing the Android permission or iOS Simulator privacy service. Mobile keys are ADB key names/codes on Android
and Appium key values on iOS; use `home` for the Home button.
Battery `charging` controls simulated AC connection separately from `status`:
1 unknown, 2 charging, 3 discharging, 4 not charging, 5 full, following
[Android BatteryManager constants](https://developer.android.com/reference/android/os/BatteryManager#BATTERY_STATUS_CHARGING).

Use the same action tools for mobile and desktop devices. Use `devices` to find an existing owned device and its exact `deviceId`. Use `devices({view:"backends"})` when prerequisites are unclear; `devices({view:"available",backend})` finds candidates for creation or attachment. `windows-vm` and `linux-vm` mean Hyper-V only when `provider` is `hyper-v`; the container QEMU `linux-vm` provider has a different capability set.

## Screenshot → input → screenshot

1. Create with `create_windows_vm` or `create_linux_vm`, then `start`. Reuse the generated returned deviceId; request `status` for current state or diagnostics. On the first start of a default Hyper-V Linux guest, `start` installs Xfce and starts a graphical desktop automatically. This can add about 15 minutes; the response reports GUI readiness or the failed stage. The persistent console auto-login uses a dedicated unprivileged `ccc-desktop` guest account, separate from the sudo SSH account. Later starts and reboots check readiness and repair the desktop if needed.
2. Call `screenshot` with `{ "deviceId": "<returned deviceId>" }`. The result is a PNG plus its width and height. The top-left pixel is `(0,0)`; the bottom-right pixel is `(width-1,height-1)`.
3. Call `click` with that deviceId and `x,y` measured on the returned image. `button` defaults to `left`; `right` is available. Use `click` with `count:2` for a double-click.
4. Use `key` for one key or combination, such as `Enter`, `Ctrl+A`, or `Alt+Tab`. Hyper-V key names are case insensitive. `type` sends text to the focused control; on Hyper-V `windows-vm` only ASCII text is verified. Use `scroll` with `direction: "up"` or `"down"`, `x,y`, and optional `amount`. `cursor_position` reads the cursor; `move` moves it using required x,y screenshot coordinates.
5. Capture another screenshot and inspect the visible result before the next input. Keep the exact deviceId; recreating the same display name returns a new ID, which must be captured again.

Hyper-V mouse coordinates are pixels of the latest returned PNG and expire after two minutes. Capture again after a VM reboot, restore, or display-size change. Hyper-V horizontal scrolling is unavailable; `left` and `right` are accepted by the generic tool schema for other providers. The Hyper-V key set includes letters, digits, F1–F12, navigation/editing keys, and Ctrl/Alt/Shift/Win combinations. Unsupported keys and missing console devices return errors.

## Capability map

| Provider | Screenshot | Mouse and keyboard | Guest command, files, builds |
| --- | --- | --- | --- |
| Hyper-V `windows-vm` | Real host screenshot proof passed on 2026-09-24 and 2026-09-25 | Real host keyboard, pointer and visible scroll proof passed on 2026-09-24 and 2026-09-25; only ASCII typing is verified | Windows Level 3 host test passed |
| Hyper-V `linux-vm` | Real host screenshot proof passed on 2026-09-26 | Real host keyboard, pointer and visible scroll proof passed on 2026-09-26; text and wheel go through the guest X11 session; `start` prepares the default image automatically | Linux Level 3 host test passed |
| Container QEMU `linux-vm` | Check `devices({view:"backends"})`; GUI tools are not advertised | Check `devices({view:"backends"})`; GUI tools are not advertised | Provider-specific guest tools |
| `windows-sandbox`, `macos-vm`, `x11-current-display` | Existing desktop tools, when available | Existing desktop tools, when available | Varies by provider |
| Android/iOS | Screenshot and mobile interaction tools vary by backend | Use click, type and key; use swipe and long_press for touch gestures | Varies by provider |

The latest Windows (2026-09-25) and Linux (2026-09-26) Level 3 GUI runs have passed on the Windows Hyper-V host. A successful screenshot or native input call by itself does not prove that a guest UI changed. Capture a second screenshot to check the result.

To check both guests on a Windows Hyper-V host, run `npm run test:level3:hyper-v`. For one guest, use `npm run test:level3:hyper-v:windows` or `npm run test:level3:hyper-v:linux`. These default tests verify screenshot, pointer, keyboard and visible scroll through packaged MCP, and check a nonce file created inside the guest by GUI typing (the console on Windows, the X11 session on Linux). The Linux run prepares Xfce automatically during `start`. These host runs cannot be executed from inside a development container; run them on the Windows host.
The shared GUI journey also enumerates the test application's window, focuses its
returned handle, and drags the pointer to a separately observed cursor endpoint.
These tools must actually run; advertising them alone does not satisfy the final
capability coverage check.

Windows Sandbox defaults to `minimized:true`. Its host launch requests minimized
nonactivation (Shell show mode 7), and helper recovery never escalates to a visible
connection. Explicit `minimized:false` still opens an interactive Sandbox window.
The native application may override a shell show request, so a passing fake-provider
test does not prove that fullscreen host applications remain undisturbed. Verify
foreground-window behavior on Windows before claiming that guarantee.

Helper bootstrap and one-shot recovery share the requested operation deadline;
expiry does not permit a fresh minimum-duration retry. Successful process launch
alone does not establish readiness: `start` must still observe a working cursor
probe. See [Microsoft's ShellExecute show modes](https://learn.microsoft.com/en-us/windows/win32/shell/shell-shellexecute).

Logon and recovery can request bootstrap concurrently. Bootstrap serializes its
file/process changes and reuses an exactly identified live helper, preserving its
script and redirected logs. An uncertain process identity is a failure to inspect,
not permission to overwrite logs or kill a process. A separate daemon lock prevents
two request loops; one-shot requests do not take that lifetime lock.

A missing helper-ready marker does not mean the host viewer needs another
connection. Recovery preserves a successful session launch and retries guest
bootstrap without opening another viewer. The local failure bundle includes
`ccc-guest-helper-bootstrap-phase.json` to distinguish early discovery from
helper launch; its presence does not establish working computer input.

The Sandbox real E2E passes its configured operation timeout (180 seconds by
default) as `bootTimeoutMs` on both initial start and the existing single-use
recovery start. This includes provider startup and cursor readiness; it does not
change the public start default or make a launched process count as ready.

Sandbox E2E guest commands require an explicit zero exit status. A nonzero or
missing status reports `guest-exec-failed` and writes bounded stdout/stderr to
`results/device-lab-real/windows-sandbox-exec-<uuid>.json` before cleanup. This
private local evidence can contain sensitive output; it is not printed in the
test summary. A successful command still needs the existing window-list and
focus checks to prove the GUI action worked.

The Sandbox E2E uses its own Windows PowerShell/WinForms window to display the
uploaded text file; it does not require Notepad to be installed. Window selection
requires the launched process ID and the exact test-specific title before focus.
The child uses `CreateNoWindow` to avoid creating a console, without applying
`WindowStyle.Hidden` to the GUI process. The test's existing Sandbox teardown
closes the window. If enumeration cannot find it, the E2E captures process
liveness and the child's starting/shown/failed phase in private exec evidence
before teardown. The phase does not replace the real window-list/focus proof.
Window discovery and focus have separate E2E failure stages. A focus MCP error,
including a plain-text reply, is saved in the same private evidence bundle;
only exact known focus error codes appear in the terminal summary.
Broker-backed focus requests preserve the validated opaque `handle` across the
backend child-process boundary, for both Sandbox numeric handles and macOS
handles. Input validation still rejects malformed handles before dispatch.

If Sandbox startup fails, the E2E now saves a local
`results/device-lab-real/windows-sandbox-bootstrap-<uuid>.json` bundle before
stopping/deleting its device. It contains only bounded, fixed startup logs and
markers from that test's owner/device. This raw local bundle is separate from
sanitized MCP error JSON; review it locally before sharing. Capture errors do
not prevent cleanup. The console reference makes the actual startup evidence
available after cleanup, rather than requiring another run merely to collect it.

For a focused Windows Sandbox rerun from PowerShell, explicitly enable level 2:

```powershell
$env:CCC_TEST_LEVEL = '2'
node --import tsx scripts/real-tests/run.ts scripts/real-tests/level2-windows-sandbox.ts
```

Without that setting, the standalone Sandbox scenario reports SKIP rather than
running the test. SKIP is not evidence of a working Sandbox.


## When the display is unavailable

- `hyper-v-display-unavailable`: start the VM and wait for its graphical session. For the default `ubuntu-lts` server image, wait for `start` to finish; its first run can take about 15 extra minutes and reports the failed setup stage if the desktop cannot be prepared. SSH readiness alone does not mean the desktop is ready.
- Windows evaluation VM at the sign-in screen: the unattended bootstrap uses a one-time auto-login; after reboot, interactive sign-in may be needed before GUI automation can reach the desktop. The default Windows Level 3 GUI proof runs during that first desktop session.
- Identity conflict: call `status` for the exact deviceId and inspect the refusal, then capture a new screenshot before input. A deleted ID cannot select a later VM with the same display name.
- `device-cursor-move-backend-unsupported`: `move` supports the current X11 display and Hyper-V `windows-vm`/`linux-vm`. Other providers report unsupported; `cursor_position` never moves it.
- Native console device or permission error: check Hyper-V host support and permissions for the exact VM. These tools do not redirect input to the host desktop or another VM.

## Multiple actions on one device

Use `run_flow` for supported desktop or mobile steps. Its step-tool enum
lists the accepted canonical actions. For example, install and launch an Android
app, then wait until its UI is ready:

```json
{
  "deviceId": "android-my-app",
  "steps": [
    { "tool": "install_app", "arguments": { "path": "/project/app.apk" } },
    { "tool": "launch_app", "arguments": { "appId": "com.example.app" } },
    { "tool": "wait_for_text", "arguments": { "text": "Welcome" } }
  ]
}
```

Steps stop on failure by default. Add `screenshot` as the last step to
inspect the result in the same response. Images appear after the JSON summary;
each producing step identifies its image/content range with `contentIndex` and
`contentCount` (zero-based in the outer content array). Arguments
are literal, with no result interpolation. Set `deviceId` at the flow level
to share that exact target among eligible steps. An explicit step deviceId
selects its own target. Public flows do not accept or inherit incarnationId. Each
destructive step requires its own `confirmDestructive:true`; routing controls
and confirmations are never inherited from the flow.

Use `install_app`, `launch_app`, `screenshot` and
`set_orientation` for all calls. Old prefixed names are removed; use `run_flow` for ordered actions.

## Waiting for a mobile condition

Use one `wait_for_text` or `wait_for_app` call instead of repeated
status/UI calls. `timeoutMs` is the observation allowance after initial device
discovery and Appium setup; the default is 10000 ms. Observation commands,
requests and pauses share that allowance. Process inspection, filesystem work,
termination and timer scheduling can add overhead. A completed non-match is
different from an observation error; flows stop on an unmet wait by default.
Update client and host broker together for host-side cancellation support.

Existing-device calls use `deviceId` only to choose the device. Do not supply `backend` to actions, status, lifecycle operations or `run_flow`; ownership records select the provider.

## Focused management tools

All these calls use an explicit `deviceId`:

| Tool | Operation |
| --- | --- |
| `ui` | Read the mobile hierarchy or desktop accessibility tree automatically. |
| `snapshot` | `action`: `list`, `create`, `restore`, `delete`. |
| `record_video` | `action`: `start`, `stop`, `status`; stop retains saved artifacts. |
| `clipboard` | Omit `text` to read; provide `text` to write, including an empty string. |
| `permission` | `action`: `grant` or `revoke`, with the app and permission/service. |

Each operation keeps its required fields and destructive confirmation. Flow
support is checked for the chosen operation, not granted to an entire group.
Old separate tool names are rejected.

Public `delete` removes the device from inventory. Calling it again with the
removed `deviceId` returns `device-not-found`; internal provider idempotence
flags are not part of this public contract. Windows E2E checks both inventory
absence and that specific error after a successful first deletion.

The Android emulator E2E allows 30 seconds for `wait_for_text`, including the
UI dump and read. Failed ADB observations still fail the test; this does not
change caller-selected production timeouts.

Real-test MCP error envelopes print a bounded summary and a unique diagnostic
path under `results/device-lab-real/`. Diagnostic files retain sanitized error
and transport evidence, not raw credentials, host paths, or repeated broker
state. If saving fails, the original failure still appears. A broker process
verification failure points to `node dist/index.js devices broker status
--verbose`; it does not authorize killing an unverified process.

Windows Sandbox E2E reports the failed step and bounded primary and cleanup
causes together. A structured `windows-sandbox-host-busy` refusal permits
deleting the new, never-started definition only when its returned device ID,
backend, stopped state, and absent runtime ID match. Ambiguous start failures
still require verified stop; foreign locks and unverified ownership evidence
remain preserved.

Windows Hyper-V E2E validates the VM address, prefix, and gateway against the
configured managed network. Normal hosts use `172.29.0.0/24`; nested hosts
(`CCC_HYPER_V_NESTED_HOST=1`) use `172.30.0.0/24`. The test rejects mismatched
subnets, gateway addresses, and reserved/out-of-range host addresses.

Persisted Hyper-V allocation addresses use the same configured subnet as the
network state prefix and gateway. A nested host must be able to reread its
`172.30.0.x` allocations for later cleanup; cross-subnet records remain invalid.
Do not delete network state to bypass validation errors.

Older Windows unit tests that isolated `HOME` without `USERPROFILE` could write
simulated state into the real profile. Current fixtures isolate both. If the
saved Hyper-V identities are exactly `00000000-0000-0000-0000-000000000001`
and `ccc-test-nat-1`, or the Sandbox claim belongs to the old `windows-refresh`
fixture, run this one-time recovery from the Windows repository checkout:

```powershell
node --import tsx scripts/repair-device-lab-test-state.ts
```

Recovery takes the normal host mutation locks and backs up original metadata.
It verifies the live switch, NAT, and gateway before correcting their recorded
identities, preserves all VM allocations, and clears unproven resource-deletion
ownership. It does not stop VMs or recreate network resources. Sandbox recovery
requires the exact fixture claim, an absent owner definition, a dead recorded
process, and a fresh empty Sandbox inventory. Unknown or conflicting evidence
is preserved and reported; rerunning after successful recovery is harmless.

Previous Windows E2E VM cleanup accepts `device-not-found` only for the exact
requested ID and only after a fresh, successful inventory confirms it is absent.
A remaining or replaced device, unreadable inventory, or other deletion error
still fails cleanup. Real-test cleanup uses only exact IDs recorded from successful
fixture creation; display names and backend prefixes cannot authorize deletion.
Stop/delete requests select those IDs alone. Private console/setup diagnostic
helpers obtain generation evidence through `status({deviceId,detail:true})` and
retain exact native identity checks.

Snapshot operations require a complete VHD parent-chain observation and compare
the terminal disk with the recorded disk identity. Windows drive/UNC paths are
compared using Windows normalization and case rules; partial reads and unrelated
disks remain failures. Snapshot-list errors distinguish a provider read failure
from missing observations, VM identity mismatches, and disk identity mismatches,
without printing disk paths.

## Discovery and network settings

`devices()` returns owned IDs and the current display. Add `backend` to filter.
The default does not add prerequisite or candidate probes. Use `view:"backends"`
for prerequisites or `view:"available"` with a required `backend` for installed
resources and physical candidates. Candidate IDs require creation or attachment
before use as owned devices. Errors remain visible.

`set_network({deviceId,airplaneMode:false,wifi:true,confirmDestructive:true})`
combines Android emulator network controls. At least one of `airplaneMode`,
`wifi`, or `data` is required. Airplane mode is applied first, then explicit
Wi-Fi and data overrides. Partial failure reports the failed setting and applied
settings; it does not retry or undo earlier changes automatically.

For macOS source cloning, omit image/provider/memoryMb/cpus/headless; the source
supplies its provider, CPU and memory. Custom `ssh` remains available. Stop the
source first; `force:true` stops it before cloning and may leave it stopped if
cloning fails. `force` is only valid with `sourceDeviceId`.

## Verification scope

Known ceiling: Hardware E2E scripts migrated but not executed — verify on corresponding provider hosts.

Real-provider tests validate the advertised MCP input contract before invoking a
provider. A stale or incomplete tool catalog stops immediately with a rebuild
instruction. Source and packaged click routing are also tested through stdio and
a local broker fixture without requiring VM boot.

Hyper-V startup reserves the greater of 2 GiB and 10% of host memory. A capacity
refusal reports requested, available, reserved and additional required MiB from
the same startup observation. It does not stop other VMs or bypass the reserve.

Native Windows에서 실제 메모리 부족 응답 재실행은 하지 않음 — 호스트 재검증 시 출력 수치 확인 필요.


### Predictable tool requests and responses

`devices` retains each target's backend/provider and any advertised public
capabilities. `supportedActions` narrows grouped tools: for example,
`snapshot:["create","restore"]` does not promise snapshot listing. These are
support declarations, not a guarantee that a stopped device is ready to execute.
Wireless responses suggest the public `attach` call; wireless prepares transport,
while attachment claims the device. Physical `start`/`stop` do not power the
handset on/off.

Use exactly one `key` or `keyCode`, and exactly one `snapshotName` or
`snapshotId` for snapshot restore/delete. Destructive operations require
`confirmDestructive:true`; it is never inherited by flow steps. Explicit QEMU
creation requires exactly one `baseImageId` or `sourceImage`. Hyper-V creation
uses its managed guest transport, so QEMU SSH/agent options do not apply.

App results use `appId`. Wait results expose `matched`: false with
`reason:"wait-condition-not-met"` means the condition was not observed within
the wait budget. Standalone waits return that observation; a flow marks that
step unsuccessful and stops by default. Transport/observation failures remain
MCP errors. Diagnostic verbosity never changes failure classification.

Clean simple actions return `ok`. Failures retain bounded recovery and
cleanup/containment evidence even when bulk diagnostics are truncated. Obtain a
fresh screenshot after a VM state or identity conflict before issuing input.

### Android creation and physical attachment

Call `devices({view:"available", backend:"android-emulator"})` to obtain installed `systemImages` and `deviceProfiles`. Pass a returned image ID as `systemImage` to `create_android_emulator`; `deviceProfile` is optional. An existing `hostAvds.avds` entry can instead be reused through `avdName`. Discovery does not install images; `creationDiscovery` reports unavailable or truncated results. Omit `port` for automatic allocation, or use an even console port from 5554 to 5682.

For physical devices, `attach` requires `udid` on iOS. Android uses USB by default and requires `serial`; with `connection:"wifi"`, provide `host` or a network `serial` (port defaults to 5555). Obtain selectors from `devices` with the corresponding backend and `view:"available"`.

Compact waits return `matched` as the single condition flag; `matched:false` means the completed observation did not meet the condition. Transport or command failures remain errors. Detailed waits may retain native status and provider condition fields.

Broker backend-enum diagnostics use backend-specific physical identifiers (`serial` for Android, `udid` for iOS). Their broker endpoint uses `brokerPort`; it must not leak into the wireless device `port` input. The real-test suite validates these probe arguments before dispatch so an input rejection cannot masquerade as provider coverage.
