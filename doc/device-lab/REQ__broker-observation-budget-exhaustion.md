# Broker observation allowance exhaustion

An explicit Appium observation allowance covers owner resolution, authenticated broker-generation attestation and the observation RPC. It is consumed once; no fresh reserve, retry or extended deadline is introduced.

When the owned allowance reaches zero after existing owner/body/token admission but before attestation starts, or after successful genuine attestation but before the first observation RPC, the broker returns its existing failure shape with `error: "broker-observation-budget-exhausted-before-rpc"`. This is a known deadline result, not evidence that attestation succeeded at the earlier checkpoint. No observation RPC may run without successful generation attestation.

Normal completion also requires private local provenance: only the actual local cutoff result object is registered in the broker module. The waiter uses that same module's identity predicate. A remote error string, copied/spread result, or JSON wire value cannot create this evidence. Preserve remote error text, selected attempt, status and attempts exactly, even if its text equals the reserved reason. No response/request attribute carries the private marker.

The reason is unavailable if any observation RPC was attempted on any host candidate, or a candidate attempt already failed. Invalid allowance, missing authorization, owner resolution/configuration failure, failed/stalled attestation, started/stalled HTTP and RPC errors retain their existing errors. Empty attempts alone do not establish deadline provenance. No request/schema fields or additional response attributes change.

Both text and app waits finish with their existing `found: false` payload only when an earlier successful observation satisfied their existing absent condition and a subsequent observation receives this exact deadline reason. Preserve the last source/app-state, timeout, provider and backend. Without an earlier absence, exhaustion remains an error. Found results and late/failed started observations retain existing behavior.

If an outer wait observes positive remaining time but its next allowance calculation is zero, it sends no invalid zero-budget request: it finishes normally after prior absence, otherwise reports its existing before-observation deadline error. Direct zero allowance remains `invalid-appium-request-timeout`.

The real public fixture retains its500ms overall,300ms interval and15s test limit. Multiple successful observations are not guaranteed by wall-time scheduling. Separate deterministic original-budget/real-authenticated-HTTP controls prove multiple absences and decreasing allowances. Every RPC retains genuine generation admission; any unmatched final status probe needs an explicit phase outcome and no-RPC cutoff ledger, rather than blanket status/RPC equality or a weakened count assertion.

Original hashes, failed expectations and phase evidence remain immutable task admission. Focused source/emitted public text/app and transport/auth/generation controls, independent Code/Security and actual QA are required before acceptance. This correction does not establish native-provider acceptance, a full-suite PASS, operation credit or the historical cause of unrelated failures.
