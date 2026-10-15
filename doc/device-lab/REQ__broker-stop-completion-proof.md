# Broker stop completion proof

A successful command or accepted process signal does not prove that a device or auxiliary process stopped.

- Ordinary Hyper-V stop may publish stopped and clear its operation journal only after a successful observation identifies the exact VM in canonical Off state. Running, transitional, empty, unknown or mismatched observations retain the prior record, execution receipt and journal for recovery. Delete and replay keep their existing policies.
- Appium and recording cleanup clear owned process metadata only after observing that the expected process incarnation ended. Alive, inaccessible or malformed observations retain metadata. A changed process birth identifies an ended predecessor and never authorizes signaling its successor.
- Appium cleanup preserves its verified TERM and authorized KILL policy. Recording cleanup uses INT without forced termination and does not copy or delete Android artifacts. Before every signal and later auxiliary effect, the captured device generation must still be current.
- Physical cleanup keeps its synchronous hardware guard until cleanup and conditional publication finish. An unconfirmed required auxiliary cleanup prevents parent stop, detach and lease release. Confirmed partial progress remains reportable without overwriting a successor.
- Owner cleanup of a running virtual device calls the existing canonical stop operation under the already-held device lock. That operation owns auxiliary cleanup, provider confirmation and publication exactly once, with existing host locks and bounded deadlines. Owner cleanup must not republish its stale predecessor.
- Required refusal and unknown completion contribute to failed cleanup totals. Existing report envelopes and native diagnostic receipts remain outward; the application consumes semantic completion and commit facts.

The native exit observer uses one monotonic finite budget, bounds each native probe to its remaining time, and starts no probe after expiry. Unix Appium settlement allows up to 3000 ms after TERM and up to 500 ms after authorized KILL; recording allows up to 3000 ms after INT. Existing Windows verified tree termination has its separate 10-second wait plus process allowance; these observation budgets do not replace that limit.

Verification uses actual owned local processes for Unix exit proof, core tests for state and lease outcomes, and broker composition tests for the canonical stop path. Simulated provider and OS observations do not establish real Windows or hardware acceptance.
