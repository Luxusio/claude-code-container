# Restart an existing environment with retained session evidence

When old dead sessions retain uncertain pending requests, CCC can start the same compatible stopped container by its full ID and reconnect after live verification. It preserves the old records and keeps the new session's cleanup disabled. Failure or timeout never authorizes a compensating stop or replacement.

Recovery keeps the existing image and defers updates. Preparation cannot build, pull, recreate, migrate retained state or erase predecessor evidence. Ordinary CLI startup remains unchanged. Missing or incompatible environments still refuse recovery; portable regressions do not establish native macOS acceptance.

See [retained predecessor admission](../session/REQ__retained-predecessor-session-admission.md).
