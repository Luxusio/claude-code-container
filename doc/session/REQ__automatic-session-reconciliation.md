# Automatic session reconciliation

Status: active; scoped compatibility update, 2026-10-23.

## Requested behavior

User instruction: “세션 파일이 있으면 그 프로세스랑 그 컨테이너 살아있는지까지 감지하고 자동으로 정리를 시도하고 그 뒤에 파일 상태를 다시 봐야지”.

Before admitting a session or refusing ordinary stop/remove because of session files, CCC observes the recorded process identity and relevant container state, attempts qualified cleanup, and enumerates the remaining files again. A file alone is not evidence of a running session. Live, stale and unobservable states remain distinct. Failed recovery identifies the remaining record and reason without exposing captured credentials or environment.

## Derived implementation constraints

- Run reconciliation under the existing project/profile lifecycle guard. Compare process start identity as well as PID; access failures are unknown, not dead.
- Preserve live or unobservable owners and guardians. Monitored records retain their captured runtime, acknowledgement, generation, peer and exact-receipt conditions. Pending intent does not authorize stopping a container.
- A positively stale pre-v3 record with both guardian/runtime sidecars natively absent may be migrated using current project/profile context. A positively absent or stopped managed target permits exact-record retirement. A running managed orphan may be stopped only when all relevant participants are positively stale and the target has strict destructive identity proof. Revalidate the receipt, both sidecar absences, peers and target before the effect. Missing or malformed monitored evidence is retained as incomplete.
- A legacy record whose owner is positively stale may transfer responsibility without stopping to a freshly qualified monitored recipient only when the recipient’s owner and guardian are positively stale, the recipient’s current cleanup authority names the same exact managed target, and the recipient’s captured runtime equals the scoped runtime. Revalidate both records and the target before retirement, then settle the monitored responsibility. This prevents mixed stale formats from mutually vetoing cleanup; an unknown, pending or different-runtime record cannot receive this transfer.
- Native cleanup may settle an exact full-ID target positively absent from successful complete runtime enumeration. A timeout, daemon failure, malformed output or truncated ID is unknown. Recheck authorization after enumeration. A failed stop stays failed; a later fresh attempt may observe confirmed absence.
- Re-enumerate claims after every cleanup attempt, including partial failure. Failed retirement or a replaced file remains visible and protective. Explicit force retains its existing claim-veto bypass; recovery failure never implies force.
- Scope runtime commands to the selected captured invocation and exact managed target. No workspace/source/branch deletion follows from claim retirement. Per-command bounds remain finite; total recovery time grows with unresolved records.

These narrowly qualified pre-v3 migration and positive-absence settlement rules supersede the blanket unmarked-legacy retention and clean-stop-only rules in [session exit cleanup](../common/REQ__session-exit-cleanup.md). Other guardian, ownership, concurrency and deletion protections in that requirement remain applicable. This update does not alter pending edits in that file.

## Acceptance

Cover stale legacy targets absent/stopped/running; live, reused and unknown processes; guardian protection; appearing or partial sidecars; replaced receipts; failed unlink; alternate runtime; failed/malformed enumeration; failed stop followed by safe retry. Verify startup recovers before reservation and administration counts freshly enumerated remainder, including ordinary and explicit-force paths. Existing monitored responsibility and peer-veto regressions remain required.

Known ceiling: portable fixtures do not prove the state of a user's unavailable Windows host records. Native platform proof is reported separately and is never inferred from fixture success.

Known ceiling: Existing conservative `observedActive` queries remain unchanged; these still include unsettled responsibility records. The reconciled administrative refusal describes remaining claims rather than declaring them live.

Known ceiling: Async inspection callbacks cannot authorize synchronous legacy recovery; native production inspection is synchronous. Such callbacks preserve legacy records instead of supplying cached destructive authority.
