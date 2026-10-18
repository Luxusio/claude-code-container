# Broker launch recovery and responsiveness

An authenticated Android or macOS start reserves the current owner/device record as `starting` before native dispatch. The reservation uses the existing lifecycle marker shape with a fresh runtimeId, operation and claimedAt. A refused or failed reservation must dispatch no native launch. A prior unresolved start requires recovery rather than another launch.

Successful execution and boot readiness are separate facts. After possible dispatch, nonzero results, observation failure, timeout, rejected pacing or exceptions must preserve recovery responsibility and report possible host mutation. Those failures must not restore a `stopped` record or claim that no effect occurred. A ready start, or an explicitly requested no-wait start, finalizes only its exact reservation. Public failures retain the existing error/status envelope and redacted partial-effect evidence; raw exceptions, credentials, commands and original records are not nested into stored lifecycle metadata.

Owner cleanup must recognize a pending start and invoke the existing provider-specific stop under its operation lock. Successful confirmed stop clears the pending marker. Failed or uncertain stop retains the recoverable record. Finalization conflicts preserve the successor and expose partial execution; they never authorize stopping a same-target successor by name alone.

macOS finite execution, metadata effects, IP probes, pacing, create compensation and auxiliary cleanup must yield while retaining operation ordering and lock ownership. Android and macOS boot probes use the captured monotonic remainder and refuse late readiness. Default native cleanup uses the captured parent deadline, reserves cancellation time and settles the finite command before replying or releasing its device lock. A detached runtime may remain live while its pending recovery record is retained.

Verification uses behavioral lifecycle cases, authenticated start-then-cleanup HTTP journeys, and an external controller observing health and another owner's RPC before releasing a held default native probe. A held cleanup-stop timeout must leave recovery state and cannot resume that command after the reply when its gate is released. Tests use owned fake executables and genuine emitted broker code; they do not certify real platform/provider behavior.

## Known ceiling

Known ceiling: writers bypassing the device-operation lock can erase a reservation; detected conflicts preserve successors and report partial execution, but this change adds no independent durable journal — reconsider only if out-of-band mutation must carry recoverable predecessor obligations.
Known ceiling: portable fake-executable and deferred-effect checks do not establish native Windows/macOS/Android acceptance — qualify those platforms with current Source and an authorized native environment.

