# Direct physical stop

The Android and iOS direct `device_stop` handlers compose the checked
`createPhysicalStopApplication` policy. The application finds the attachment,
claims its exact raw record, cleans auxiliary runtime, checks the current
lifecycle generation, commits a stopped record with raw CAS, and presents the
existing response. Failed cleanup restores only the matching lifecycle; a
successor remains untouched. Shared detach helpers delegate to the same
lifecycle and cleanup policy.

Native facades retain storage, process identity, signaling, bounded process
observation, command arguments, and the existing owned Appium workflow. Ports
distinguish synchronous find/CAS/signal/ADB observations from asynchronous exit
waits and Appium cleanup. Clock, runtime IDs, status projection and response
codecs are injected. Raw CAS results retain `device` and `currentDevice`; the
ADB result describes the selected native command's default UTF-8 output without
changing its values, extra fields or reference.

Android discovers ADB after a successful claim, including inactive recording.
An active recording observes both owned SIGINT and the optional single ADB
fallback before deciding. A signaled recorder must exit within 3000ms even if
ADB succeeded. Android does not stop Appium. iOS stops recording before its
existing owned Appium workflow. If Appium fails after active recording cleanup,
guarded abort preserves Appium metadata and records the original recording as
inactive with the existing timestamp ordering.

Success retains the physical attachment and lease, clears auxiliary runtime and
lifecycle metadata, and returns `stopped: false`, `detached: false`, and
`physicalDevicePoweredOff: false`. Public exports, admission, owner operation
locks, lease refresh, MCP routing and existing backend-child bindings retain
their existing responsibilities. Broker physical stop is a separate operation.

Verification uses focused core, facade and strict checkJs contract tests, plus
the existing Android/iOS cleanup and MCP/broker regressions. Original controls
characterize both complete exported handlers, genuine private owner storage,
leases and locks, emitted public MCP and existing backend-child routes. Native
process, command and Appium leaves are controlled fixtures. Source/emission
authentication and these controls do not establish real Android/iOS host
acceptance, broker migration, shipping or final delivery.
