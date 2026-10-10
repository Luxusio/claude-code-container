# iOS Simulator direct lifecycle

The public direct MCP dispatch calls `handleIosTool`. Its canonical owner/device
operation lock, missing-device admission and lock-timeout translation remain in
the facade. The four direct create/start/stop/delete branches call the explicit
`createIosSimulatorLifecycle` application. Every other provider tool and public
export retains its existing native path.

The application owns definition-only versus simctl provisioning, ordered
simulator identity observations, lifecycle claims and conditional publication,
boot/bootstatus decisions, recording and Appium settlement order, compensation,
stage-recovery reporting and deletion. Domain rules retain claim status and
simctl tolerated-state diagnostics. Required ports expose record reads, native
owner-name checks, raw inventory/commands, clock/runtime IDs, verified process
observations/signals/waits, Appium session deletion and termination, guarded
stage discard and result presentation. Construction performs no observation.

Canonical repository, name/UDID, lock, process identity, runtime generation,
recording/Appium and local-stage authorities remain native. Existing helpers
used by other tools remain unchanged. Conditional record publication does not
establish stronger process-generation or byte-identical ABA protection; failed
cleanup retains the original partial-effect and explicit-recovery behavior.

The paired tests must compare immutable original controls, actual complete
facade bindings and strict source/emission ports, including raw faults, getters,
receivers, native denial counts and owned actor settlement. Native macOS/provider
acceptance is unverified. Authenticated broker lifecycle policy and BOTH shipped
payload proofs belong to the later integration task. This provider extraction
alone receives no whole-operation credit and claims no executed QA.
