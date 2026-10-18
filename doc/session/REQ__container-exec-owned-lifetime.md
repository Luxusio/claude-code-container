# Container execution session lifetime

After the container-exec application's ownership-acquisition call fulfills, that invocation owns one cleanup attempt through the rest of startup and command execution. A workspace-family guard that fails after acquisition does not lose that responsibility. The application waits for in-flight setup, ownership acknowledgements and command work to settle before cleanup.

Failures before fulfilled acquisition perform no application cleanup. This protects unrelated current ownership. The acquisition port retains its existing rollback and acknowledged-receipt recovery contract; this requirement does not turn a rejected acquisition into successful ownership.

Startup failure, clipboard attachment, environment/bridge failure, command preparation, refused preparation, command completion and command rejection all reach that cleanup attempt. Cleanup calls the existing session policy: it does not independently grant shutdown permission, change the captured target, bypass successor/foreign-claim checks or authorize stopping a reused container after a failed join.

Command finalization keeps configuration restore, prepared-command disposal, then session cleanup in that order. Dispose only a successfully created command artifact; preserve existing restoration context and best-effort restoration diagnostics. A successful command retains its status unless finalization fails. A sole thrown value is preserved, including undefined. Multiple primary/disposal/cleanup errors retain their order with the first as cause; a caller-thrown AggregateError remains a single primary error. Reporting failures cannot replace the failure being reported.

Each newly admitted native acquisition initializes a fresh cleanup lifetime before binding its reserved session. After one invocation is cleaned, a subsequent acquisition must remove its own claim and release its own handle without requiring caller-side context clearing. The existing low-level setSession/clearSession and failed-cleanup retry contracts remain unchanged.

Native signal registrations belong to that same lifetime. Successful cleanup or complete acquisition rollback removes only the invocation's registrations; unrelated listeners remain intact. Pending acquisition and retryable cleanup failure retain interruption handling. Repeated setup replaces the prior owned registration, and asynchronous signal cleanup still settles before controlled exit. Consecutive invocations must not accumulate process listeners.

A caller can catch a startup rejection without a CLI error boundary and still observe this cleanup attempt. Successful native cleanup removes only its owned claim; a defensive repeated CLI cleanup is inert. Failed cleanup preserves the existing retry obligation and is reported alongside the original failure. No automatic retry or unconditional stop is added.

## Verification

The existing container-exec core owner covers pre-acquisition refusal, family-guard failure before/after acquisition, synchronous/asynchronous startup faults, held settlement, valid resource finalization, primitive errors, cleanup error aggregation and unchanged command outcomes. Its compiled integration owner uses the real cleanup application to observe claim/stop/idempotence/retry behavior without the CLI error boundary. Existing acquisition and cleanup owners retain their own contracts. Fake native leaves do not certify real engines or native platforms.

## Known ceiling

This post-fulfillment repair does not discharge a receipt deliberately retained by rejected acquisition after partial reconciliation. That remains an explicit recovery follow-up. Runtime engine/endpoint authority and cross-engine claim isolation also remain separate: no exact-engine guarantee is inferred from this lifetime change. Real Windows/macOS/provider/runtime, whole-source/reliability and formal workflow acceptance require their own evidence.
