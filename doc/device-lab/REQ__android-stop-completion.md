# Android emulator stop completion

The host broker must not report a successful emulator stop merely because ADB
acknowledged the kill command. Before persisting stopped state or clearing
runtime metadata, it must observe both the owned serial absent from a successful
ADB inventory and the owned AVD process inactive. An unrelated unavailable
emulator must not prevent confirming this target's stop.
Existing AVDs registered without provisioning remain stoppable using their
validated recorded name and serial. The CCC owner-prefix requirement still
applies to artifact deletion; stopping a registered device does not grant
authority to delete its external AVD storage.

All observations share a bounded deadline and each subprocess receives no more
than the remaining time. Failed observations and deadline exhaustion are errors,
not proof of exit; leave stop metadata unconfirmed and report a bounded reason.
Do not repeat the kill command. Preserve owner-operation serialization, process
identity checks and all existing guarded deletion requirements.

Advertise and require the updated stop capability on host and MCP so host CCC
can replace an older same-version broker through its verified update path.

Verify delayed serial/process disappearance, each observation independently
required, failed observation, deadline exhaustion, an unrelated offline emulator,
and successful stop followed immediately by ordinary guarded fixture deletion.

## Direct lifecycle observations

Engineering-derived from this stop-completion contract and the architecture's native-fact/application-policy boundary: the direct MCP stop and forced-delete paths also require trustworthy serial absence and named-AVD process inactivity before publishing completion. If an owned runtime is recorded, its identity-qualified termination must additionally report exit. ADB kill acknowledgement or a bare PID wait is insufficient. Already absent targets remain idempotent even when the stored status is running and no runtime is recorded.

An unavailable ADB command, missing or malformed inventory header, partial/error output, failed process query or expired allowance is not absence. Offline or unauthorized target rows remain present; unrelated offline devices need not invalidate this target's observation. Expected native observation failures retain runtime, recording and Appium recovery fields and restore only the still-owned lifecycle claim. Storage exceptions remain storage failures. Exact current-claim checks and conditional publication must preserve a successor.

Before recorder cleanup, admit the recorded target using trustworthy observations and exact AVD identity. Both serial `pkill screenrecord` and `emu kill` recheck the recorded AVD name immediately before native dispatch. A different AVD reusing the serial receives neither command. Safe registered non-prefixed AVD names remain observable and stoppable; provisioning and artifact deletion still require the existing owner prefix, approved root and inactivity checks.

Use one monotonic observation allowance after discovery for initial admission and completion polling; do not renew it per iteration. Every inventory, console-identity call (including fallback), process query and serial-effect guard checks the remaining allowance before dispatch. An exhausted allowance dispatches nothing: passing timeout zero is not a refusal because the existing native adapter substitutes its default timeout. Successful late observations cannot authorize publication, and the kill command is not repeated. Existing discovery, recorder cleanup and owned-runtime termination retain their separately bounded contracts; no whole-tool thirty-second limit is claimed.

Verify deterministic delayed serial/process completion independently, unavailable and thrown observations, acknowledgement without disappearance, expiry between native calls, late success, exact target refusal, already-absent idempotence and successor races. Actual source and emitted MCP cases use the existing owned fake SDK to demonstrate failed inspection preserving state, zero foreign serial effects and a successful trustworthy retry.

## Known ceiling

Known ceiling: exact AVD-name matching does not establish a complete same-name runtime incarnation. Existing operation locks, native process identity and conditional publication remain required; this correction adds no stronger native identity authority.
Known ceiling: recorder/Appium cleanup policy is not redesigned here. Their recovery metadata is retained when emulator completion is unconfirmed; that is not a new guarantee that every auxiliary process can be recovered or terminated.
Known ceiling: portable fake-provider evidence does not certify native Android SDK behavior on Windows or macOS or complete the architecture migration.
