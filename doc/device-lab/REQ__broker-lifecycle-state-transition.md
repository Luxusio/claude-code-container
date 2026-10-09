# Broker lifecycle owner-state publication

Successful `device_delete`, `device_start`, `device_stop` and `device_reboot`, and failed Hyper-V start/reboot diagnostic publication, must compare the complete persisted device record captured by the original native planning observation with the current record under the existing owner inventory mutation lock. The comparison precedes replacement construction and atomic publication. A missing or changed record refuses publication without changing inventory bytes, inode or modification time, including unrelated records.

Publication refusal returns HTTP 409 with `ok:false`, `error:"owner-device-state-conflict"`, `ownerId`, `backend`, `deviceId` and boolean `found`. The result retains actual provider execution, readiness, containment and cleanup outcomes. Any exposed current device uses existing backend-specific secret redaction. Completed provider or cleanup effects are not represented as rolled back; this contract protects inventory publication, not earlier native effects.

Stop/delete auxiliary cleanup checks its observation against the captured expected record before signaling resources. Missing or changed observations retain the existing auxiliary cleanup preflight failure. Cleanup advances the expected record only when its conditional publication actually commits its replacement. Disappearance or replacement during cleanup publication reports `changed:false` and a state conflict; successful native signals remain reported truthfully.

Linux Hyper-V start/reboot authenticated SSH host identity reconciliation also conditions fingerprint/source/timestamp publication on the captured complete record under the same mutation authority. It retains existing authenticated known-host, fingerprint and path validation. Only the actual committed replacement advances the expected record for later success or failed-readiness publication; a concurrent successor is never adopted by a later read.

Ordinary publication conflicts do not trigger physical lease restoration. Genuine matched inventory storage exceptions retain existing physical lease rollback and error behavior. Create, status, dry-run, idempotent, authentication, provider authority, native cleanup policy and operation budgets retain their existing contracts.

Complete-record equality cannot distinguish byte-identical ABA replacements or establish OS process generations. No additional registry or mutation authority is introduced.
