# Direct physical stop

The Android and iOS direct `device_stop` handlers compose the checked
`createPhysicalStopApplication` policy. The application finds the attachment,
claims its exact raw record, cleans auxiliary runtime, checks the current
lifecycle generation, commits an attached record with auxiliary runtime cleared
using raw CAS, and returns a finite missing, failure, conflict or stopped
outcome containing the raw committed device. Native facades alone project target
status and render the existing public response. Failed cleanup restores only the matching lifecycle; a
successor remains untouched. Shared detach helpers delegate to the same
lifecycle and cleanup policy.

Native facades retain storage, process identity, signaling, bounded process
observation, command arguments, and the existing owned Appium workflow. Ports
distinguish synchronous find/CAS/signal/ADB observations from asynchronous exit
waits and Appium cleanup. Clock and runtime IDs are injected; status projection and response
codecs remain native. Raw CAS results retain `device` and `currentDevice`; the
ADB fallback exposes only `{ok,detail}` inward. The existing Android native
binding classifies status0 and formats stderr, then stdout, then exit status
into the existing failure detail; no process result fields cross this port.

Android discovers ADB after a successful claim, including inactive recording.
An active recording observes both owned SIGINT and the optional single ADB
fallback before deciding. A signaled recorder must exit within 3000ms even if
ADB succeeded. Android does not stop Appium. iOS stops recording before its
existing owned Appium workflow. If Appium fails after active recording cleanup,
guarded abort preserves Appium metadata and records the original recording as
inactive with an ended-at timestamp.

Success retains the physical attachment and lease, clears auxiliary runtime and
lifecycle metadata, and returns `stopped: false`, `detached: false`, and
`physicalDevicePoweredOff: false`. Public exports, admission, owner operation
locks, lease refresh, MCP routing and existing backend-child bindings retain
their existing responsibilities. Broker physical stop is a separate operation.

Verification uses meaningful core cleanup, timeout and successor cases, small
compile-consumed required-port contracts, and existing Android/iOS native
cleanup and MCP/broker regressions. Controlled process and Appium leaves do not
establish real Android/iOS host acceptance, shipping or final delivery.
