# Session admission with retained predecessor responsibility

Status: active, 2026-10-23.

A dead session can retain an uncertain native startup request. Its record is unresolved cleanup evidence, not proof of a live session. An unrelated new invocation must not discard it merely because processes or containers appear absent.

- Reconcile first under the project lifecycle guard. Only structurally qualified pending-only recovery failures may offer restricted admission: unchanged monitored receipt and observation, positively stale owner and guardian, explicit pending request without current cleanup authority, and the same captured native runtime. Mixed failures and unknown, replaced, unreadable or foreign-runtime evidence remain fatal.
- Restricted admission requires a freshly verified managed, nonprovisional, currently running full container ID bound to the same project/runtime. Verify it independently before guardian acknowledgement, after reconciliation, at execution status and at ready handoff. Missing, stopped or changed targets refuse admission.
- The restriction remains for the whole invocation even if later reconciliation succeeds. Preserve predecessor main records, sidecars, generations and all replacement/shared cleanup/exact-stop vetoes. Do not convert delayed daemon work into settled responsibility.
- Allow normal guarded setup and user commands on the verified target. This restriction prohibits container lifecycle effects; it does not make the development filesystem read-only. Deny retained-state migration, restart, removal, creation preparation and creation-ticket effects before dispatch, on every retry. Unexpected own-start or owned-ready callbacks cannot publish authority.
- Keep the new claim cleanup-disabled through initial acknowledgement, readiness, command launch, signals and exit. If restricted admission fails after its disabled acknowledgement but before startup, roll back only that qualified new no-obligation reservation and guardian immediately; preserve every predecessor and the primary failure. Retire only the new qualified no-obligation claim and its guardian; never stop the container, clean shared devices, erase old records or infer a transfer from this admission.
- Emit a bounded warning distinguishing retained recovery evidence from active sessions and explaining the lifecycle restriction. Other inspection, reservation, guardian and publication failures retain their actual errors.

Verification covers two retained pending predecessors, successful exact-running admission and own-only retirement through real guardian/publication/claim paths; mixed failures, changed receipts/runtime/target, stopped/provisional targets, late retries and unexpected ownership callbacks must fail without lifecycle dispatch. Existing administrative removal vetoes remain.

## Known ceiling

This path requires an already running verified compatible container. It does not restart a stopped environment, repair historical uncertain obligations, or prove actual macOS/Windows acceptance from portable fixtures.

Related: [automatic reconciliation](REQ__automatic-session-reconciliation.md), [stopped-container startup](REQ__stopped-container-upgrade-recovery.md).
