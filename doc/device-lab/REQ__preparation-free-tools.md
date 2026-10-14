# Preparation-free public tools

Existing-device calls use an explicit deviceId and resolve its provider. No shared
selected device or preliminary session-opening call is required.

Creation uses create_android_emulator, create_ios_simulator, create_windows_vm,
create_windows_sandbox, create_linux_vm and create_macos_vm. Each accepts only its
platform's fields without a backend selector. The old public create tool is removed.
After creation, common tools keep selecting the target by deviceId.

Android creation provisions when systemImage is supplied (avdName may name
the new owned AVD), and reuses an existing AVD when avdName is supplied alone.
iOS provisions unless an existing udid is explicitly supplied. Creation flags are
private implementation details. Missing or conflicting creation inputs produce an
actionable error before provider dispatch. Provider failures retain existing
cleanup behavior; creation does not silently download SDK images. Backend-specific
input branches describe relevant configuration and reject mismatched fields.

## Discovery and configuration

`devices` is the single discovery entry. Its default `view: owned` lists owned
devices and the current display without adding prerequisite or candidate probes.
`view: backends` checks prerequisites; `view: available` requires a `backend` and
returns its creation/attachment candidates. An optional backend filters the owned
and backend views. Missing prerequisites and broker failures remain explicit;
candidate identifiers are not owned device IDs. The former `list_devices`,
`inventory`, and `backends` public tools are removed.

Public app and app-container operations use `appId`, with the existing device
choosing the Android package or Apple bundle interpretation. Launch accepts
either appId or Android component, never both. `permission` uses one permission
identifier for Android permissions or iOS privacy services. Removed packageName,
bundleId and service inputs fail before execution, including within run_flow.

`snapshot` on container QEMU returns records whose `id` can be used directly
for restore/delete through `snapshotId`. Creation uses `snapshotName`;
restore/delete accepts exactly one of `snapshotName` or `snapshotId`. IDs
match literally within the selected owned VM, and execution uses the matched
record's name. An unknown ID refuses before provider execution or snapshot
metadata changes. Name-based operations retain their existing admission.

QEMU SSH readiness diagnostics mask native executable, SSH key and lab paths
before returning or storing them in latest/history, including Windows-style
paths. Successful and failed probes retain their readiness outcome; failed
observations still publish failure history.

Default QEMU SSH upload/download diagnostics also mask exact key, executable
and lab paths before returning transport results, including Windows paths.
Both successful and failed transfers retain their actual outcome and existing
cleanup/history behavior.

`list_images` and `import_image` manage container QEMU image records.
`create_macos_vm` creates from an image, or clones an owned `sourceDeviceId`.
Source cloning retains owner/lifecycle checks and inherits provider, CPU and
memory. With sourceDeviceId, image/provider/memoryMb/cpus/headless are rejected;
custom ssh remains available. force is accepted only with sourceDeviceId:
force:true stops a running source before cloning, and a later failure may leave
that source stopped. Image creation clones the requested Tart image immediately
and publishes a stopped device only after provisioning succeeds. A missing image
fails at create without publishing a device; start boots the existing clone.
The public clone_macos_vm tool is removed.

`click` accepts optional integer count:1 or count:2, defaulting to one click.
Two clicks use the existing double-click/double-tap implementation, including
inside run_flow. Other explicit counts fail before execution. count is consumed
at the public boundary. Both counts return ok by default and retain diagnostics
with detail:true. The public double_click tool is removed. long_press, navigation
and image management remain distinct because their intent is not a click variant.

Windows VM creation selects Hyper-V internally. Linux and macOS custom SSH
configuration is optional `ssh`; Linux custom guest automation is optional
`agent`. Necessary host, credential and health/provision settings remain usable;
custom-image credentials are not guessed. Unknown nested fields and removed
flat setup fields are rejected before provisioning.

`set_network` accepts wifi, data and airplaneMode booleans, including false.
At least one is required. All inputs and destructive confirmation are validated
before mutation. Airplane mode is applied first, then explicit Wi-Fi and data
overrides. A later failed command remains a failure with useful stage evidence;
there is no automatic rollback or retry of earlier successful changes.
The separate toggle_airplane_mode tool is removed. Existing backend support
limits, device ownership and incarnation checks remain enforced.

The single broker protocol version changes when combined network semantics need
a newer host. An older daemon must not silently ignore airplaneMode.

## Verification evidence

Real-test call records use the same detached JSON arguments sent over MCP;
undefined JavaScript properties must not create phantom schema failures. Failed
flows report `flow-step-failed` and retain child results for explicit expected
error accounting. Negative provider tests must use valid public schemas. Deliberate
input-validation tests may mark one exact schema error and matching returned error
code as expected; they remain invalid-input records and never prove provider
coverage. A generic expected-error marker cannot excuse an invalid request. Saved tool fingerprints
must still match the current source. A mismatch is reported as source changed
since the run, not accepted as proof for the new interface.

workspace_sync and artifacts_export are private staging operations, not public
device file transfers. upload/download perform their own bounded preparation.
clear_app_data clears the selected app; reset erases an iOS Simulator. Both retain
destructive confirmation and existing ownership validation. reset accepts no app
identifier and cannot silently become an app-only reset.

Public helperTimeoutMs is removed. Caller-adjustable operation deadlines use
timeoutMs, translated to bounded provider controls. Existing default boot, install
and containment budgets remain intact; no timeout disables containment.

The catalog remains independent of a shared active device. Missing prerequisites,
stopped devices and broker outages must not hide setup or recovery operations.
Catalog reduction cannot rely on pagination being lazily loaded by MCP clients.
Verify public schema and routing together, including removed arguments, destructive
failures, creation/reuse and upload without a separate staging call.
