# macOS Tart clone budget

Tart image creation uses a provisioning budget rather than the broker's readiness-command default. The default native clone budget is 10 minutes, within a 10 minute 30 second outer RPC allowance; explicit shorter limits still apply.

The client and host carry a decreasing operation allowance through preflight, runtime metadata locks, the authenticated owner mutation queue, device locking and native dispatch. Existing identity-checked containment and no-replay behavior remain in force.

This change addresses the confirmed 5-second broker clone timeout. The reported Darwin process-identity mismatch and actual partial-resource cleanup still require deployed macOS evidence; portable checks do not establish that they are fixed.

Contract: [macOS Tart clone budget](../device-lab/REQ__macos-tart-clone-budget.md).

An already running host broker keeps its loaded code. Source changes and a rebuild alone do not establish that the macOS host is using this implementation; verify its deployed entrypoint/build and process generation before native acceptance.
