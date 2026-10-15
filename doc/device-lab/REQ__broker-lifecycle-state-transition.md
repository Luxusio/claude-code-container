# Broker lifecycle owner-state publication

Successful `device_delete`, `device_start`, `device_stop` and `device_reboot`, and failed Hyper-V start/reboot diagnostic publication, must compare the complete persisted device record captured by the original native planning observation with the current record under the existing owner inventory mutation lock. The comparison precedes replacement construction and atomic publication. A missing or changed record refuses publication without changing inventory bytes, inode or modification time, including unrelated records.

Publication refusal returns HTTP 409 with `ok:false`, `error:"owner-device-state-conflict"`, `ownerId`, `backend`, `deviceId` and boolean `found`. The result retains actual provider execution, readiness, containment and cleanup outcomes. Any exposed current device uses existing backend-specific secret redaction. Completed provider or cleanup effects are not represented as rolled back; this contract protects inventory publication, not earlier native effects.

Stop/delete auxiliary cleanup checks its observation against the captured expected record before signaling resources. Missing or changed observations retain the existing auxiliary cleanup preflight failure. Cleanup advances the expected record only when its conditional publication actually commits its replacement. Disappearance or replacement during cleanup publication reports `changed:false` and a state conflict; successful native signals remain reported truthfully.

The physical detach caller of this shared auxiliary cleanup supplies its original raw device observation as the expected record. Matching detach retains existing lease and cleanup behavior; its later inventory removal remains outside the selected lifecycle publication contract.

Linux Hyper-V start/reboot authenticated SSH host identity reconciliation also conditions fingerprint/source/timestamp publication on the captured complete record under the same mutation authority. It retains existing authenticated known-host, fingerprint and path validation. Only the actual committed replacement advances the expected record for later success or failed-readiness publication; a concurrent successor is never adopted by a later read.

Ordinary publication conflicts do not trigger physical lease restoration. Genuine matched inventory storage exceptions retain existing physical lease rollback and error behavior. Create, status, dry-run, idempotent, authentication, provider authority, native cleanup policy and operation budgets retain their existing contracts.

Complete-record equality cannot distinguish byte-identical ABA replacements or establish OS process generations. No additional registry or mutation authority is introduced.

## Native observations and response compatibility

Lifecycle, status and recording applications receive settled semantic facts beside opaque native receipts. Native composition decodes provider output; public converters replay the original native evidence and existing HTTP/MCP envelopes. Internal observation fields such as `ok`, recording guard classification, ADB state, parsed VM facts, created UDID, provider address, runtime IDs, window handles and registration/minimize reasons do not become extra native command fields or persisted boot receipts. Existing public readiness fields remain in their documented envelope.

Success remains specific to the existing boundary: direct Sandbox lifecycle accepts native status zero; broker commands require status zero without a native error. A failed ADB status is tolerated only for an already-stopped emulator, never a physical device. Recording guard refusal cannot be excused by a successful host signal; uncertain identity retains metadata and prohibits later artifact effects.

Android stop confirmation retains complete inventory/header and truncation/timeout checks, exact serial matching and existing polling budgets. iOS create keeps the current whitespace-free token rule, macOS keeps existing missing-resource phrases and successful nonempty address acceptance, and Sandbox uncertainty retains exact runtime/singleton ownership. Registration timeout diagnostics retain the original bounded native fields rather than replay unrelated launch metadata.

Hyper-V Windows readiness retains the typed result, including scrub and media-detach facts, before checking the enclosing deadline. Linux SSH/GUI markers, native diagnostics and bounded host-key extraction are normalized by the existing adapter; identity comparison, polling, publication and containment stay with the application. This extraction adds no native calls, authority, retries or broader paths. Actual authenticated broker/native regression tests must cover these facts and public receipt rendering; source-only tests do not establish built/package or real-provider acceptance.
