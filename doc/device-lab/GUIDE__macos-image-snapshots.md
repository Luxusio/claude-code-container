# macOS images and snapshots

`createMacosImageSnapshots` owns base-image cloning and snapshot create/restore/delete policy. It receives finite record, normalized provider-plan, stop/delete observations, recording, naming, clock and diagnostic leaves plus the actual inward native lifecycle application. Base-image creation remains in that lifecycle peer. Claim/revalidation/replacement, Tart clone timeout compensation and successor-aware rollback are reused rather than copied.

Image clone and snapshot create/restore reuse the lifecycle peer's recorder settlement inside the existing claim. Signal refusal and unconfirmed captured-identity exit retain recorder/recovery evidence; an already-completed provider stop remains truthful partial state. This also applies when the device is already stopped or a prepared/activated restore is resumed. Revalidate the current claim and exact recorder after waiting and before subsequent provider effects or recording clear. Duplicate PID-only image waiting is removed. The [recorder settlement requirement](REQ__macos-recorder-settlement.md) defines the observable refusal and successor behavior.

Clone completes and releases the source lifecycle claim before publishing the destination. A source successor or publication conflict retains the current conditional-publication and clone-cleanup outcome. Native owner/source locks remain in the public facade.

Restore publishes a prepared candidate before deleting the primary instance. Matching prepared or activated recovery is resumed; activation failure preserves candidate metadata. Successful activation can still retain failed candidate-cleanup metadata and resources. These are existing partial effects, not an atomic operation or new rollback promise. If clone destination publication throws, the application attempts destination cleanup: successful cleanup rethrows the original exception, while failed cleanup returns the rollback-failure result. Other raw publication exceptions retain their existing propagation and partial effects.

The domain owns eligibility, provider refusal, snapshot selection, recovery matching and the shared device definition. Native adapters retain actual Tart discovery/execution, process and resource identity, state CAS, guarded SSH/files and operation locks. Public results still use the current redacted device presentation. Portable ordinary tests and genuine emitted package checks verify wiring and policy; actual macOS/Tart acceptance remains separate.

Direct public base-image creation/cloning and snapshot workflows are supported. The five advertised broker image/snapshot bindings remain `advertised-blocked-current-contract`, a tracked advertised-contract discrepancy rather than an unsupported exclusion: the native broker returns 501 for global base-image actions and backend-gates snapshots without invoking the provider child.

The image core consumes native success facts and opaque evidence rather than
Tart argv, raw status/output or MCP publishers. Backend presentation renders
existing command triples, rollback details and the activated-resume empty
receipt. Persisted operation and cleanup diagnostics use their distinct output
and exit fallbacks; clone rollback output-only diagnostics omit an exit fallback.
These finite native leaves do not introduce a generic command adapter. Combined
review and Source/emitted QA for this cutover remain required; actual macOS
provider acceptance is not established by portable fixtures.
