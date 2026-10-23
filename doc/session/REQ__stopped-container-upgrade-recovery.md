# Stopped container upgrade and failed-start retirement

Status: active, 2026-10-23.

The user reports macOS startup blocked by an old stopped container requiring an image or user upgrade, followed by an incomplete cleanup obligation and blocked successor sessions. Repair this flow through existing ownership and runtime boundaries.

- A provisional legacy stopped-container admission cannot itself authorize replacement. Under the held runtime-bind and session lifecycle guards, positively qualify the exact stopped target before replacement; retain ordinary peer, current-ID, stopped-state and non-force removal checks.
- When stopped-container copy cannot read a fresh project nonce, a bounded read-only helper may use the trusted current immutable CCC image and the exact target inherited mounts. Validate every inherited destination so it cannot replace helper executable/loader code. Include the existing exact broker authentication mount `/run/ccc-device-broker-auth/owner.json`, without granting a general `/run` prefix. Read only the generated nonce; do not start or execute the incompatible old image, expose output, or treat lexical source paths as proof of the old bind object.
- Helper creation and settlement use their own captured runtime, creation ticket and exact private CID cleanup. Clean completion can settle creation even when the nonce mismatches; unknown/interrupted creation never grants proof or settlement. Recheck the host object and exact stopped ID after proof.
- Publish project startup intent once, immediately before the first potentially mutating startup operation, including retained-state migration, removal, start and creation preparation. Definite read-only refusal precedes intent. Proof helpers do not acquire project-container cleanup authority.
- After a positive own-start or ready handoff, every later startup retry remains pinned to that exact container ID. If it disappears or changes, refuse before another creation dispatch; do not lose earlier own-start responsibility or leave a newer uncertain operation behind an older claim.
- A no-effect preflight refusal preserves the primary error and retires the session normally without an artificial pending startup obligation. An uncertain native effect retains recovery responsibility; missing own-start evidence alone cannot erase intent. Repeated callbacks or retries must not discard positive earlier own-start authority.
- Sources, Git metadata, uncommitted/untracked files, retained scratch and other sessions are preserved. Do not force-remove a running, changed, foreign or unverified target.

Verify through composed application/publication/claims/cleanup paths with controlled native leaves, plus native command contracts. Cover successful stopped upgrade, refused/unknown proof, peer/race protection, helper shadowing and timeout, and preflight failure without cleanup aggregation. Existing historical pending records require separate positive runtime/process settlement; preventing new records is not proof that they were repaired. Empty or stopped runtime inventory alone cannot settle pending intent: an already accepted daemon request can complete after its client exits. Linux fixtures do not establish native macOS/Windows acceptance.

Related: [automatic session reconciliation](REQ__automatic-session-reconciliation.md), [session cleanup](../common/REQ__session-exit-cleanup.md).

## Known ceiling

The inherited-mount helper refuses destinations outside the approved CCC project, home, runtime and fixed socket paths. Successful stopped-copy proof remains available for other legacy layouts. Actual macOS/Windows acceptance and repair of pre-existing uncertain pending claims remain unverified.
