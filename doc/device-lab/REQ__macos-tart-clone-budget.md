# macOS Tart clone operation budget

A cold image clone is a provisioning operation, not a readiness probe. For a non-dry-run `device_create` on `macos-vm`, with Tart (including auto/default) and an image, the broker must allow up to 600,000 ms of native execution by default. Its default outer RPC allowance is 630,000 ms. Metadata-only creation and other providers/operations retain their existing defaults.

Explicit shorter command, operation or RPC limits remain binding. Normalization must preserve whether a command timeout was supplied; an absent default of 5,000 ms must not accidentally become an explicit clone cap. Optional lifecycle-port additions must preserve existing consumers that supply their own command timeout.

The client captures one monotonic allowance before broker startup, owner resolution and generation attestation. Each stage and transport spend that same allowance. Only a finite, positive, bounded remaining duration crosses the process boundary; absolute monotonic timestamps do not. The host captures its allowance before device-lock acquisition and uses the same remaining allowance after acquiring the lock. It must not restart a timeout at dispatch.

Native execution, completion and identity-checked cleanup must fit inside the remaining parent allowance. Reuse the existing native runner's containment and deadline mechanisms. If there is insufficient time for safe admission, refuse before spawning. Compensation after a successful clone is bounded by the remaining allowance and remains fenced by existing target ownership.

A timeout does not prove process termination. A missing device definition does not prove absent native resources. Preserve the original native failure and cleanup refusal evidence. Do not kill by PID alone, weaken process identity checks, automatically replay a create with unknown dispatch outcome, or delete an unverified partial target.

Verification must exercise eligible and ineligible policy, explicit shorter limits, elapsed preflight/lock time, exhausted admission, failure without publication, bounded compensation and no replay through existing application and broker boundaries. Portable fixtures do not certify a 25 GB cold pull or Darwin process-tree/resource cleanup. Those require evidence from the actual deployed macOS broker.

Derived from the existing lifecycle timeout bounds, process identity requirements, and the confirmed 2026-10-20 Tart clone incident. The independent application desktop QA remains separate.

See [broker lifecycle publication](REQ__broker-lifecycle-state-transition.md), [monotonic waits](REQ__monotonic-wait-budget.md), [iOS/macOS broker lifecycle](GUIDE__ios-macos-broker-lifecycle.md) and [macOS VM lifecycle](GUIDE__macos-vm-lifecycle.md).
