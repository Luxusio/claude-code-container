# Session mutation lock lifetime

An exclusively created mutation claim must be released through its own token on every successful or failed acquisition and callback exit. A complete record followed by a write, close or admission failure must not strand a guard owned by the still-running CCC process. Cleanup must preserve a replacement token. When cleanup succeeds, the original error is rethrown unchanged. Multiple failures produce an `AggregateError` with the original failure as `cause` and ordered `errors`; shared-lock aggregation also preserves the primary string `code`.

A synchronous call must refuse a guard already held by this process with `shared-mutation-lock-self-contention` instead of blocking the event loop that its asynchronous owner needs to release it. Refusal grants no reentrancy and does not run the contender. An already-expired caller budget retains `shared-mutation-lock-timeout` precedence. Independent asynchronous callers and other host processes still serialize through the native guard. A successful operation cannot report success if qualified release fails and its exact token remains; this produces `shared-mutation-lock-release-failed`.

Normal container execution acquires its lifecycle guard asynchronously for initial start and every setup or tool-installation restart. The setup transaction awaits the acquired operation and its final container ID before configuration, installation or command launch. Contended acquisition yields so an asynchronous owner can finish and release; synchronous runtime operations inside the acquired guard retain their existing behavior. Acquisition or restart rejection prevents forward setup and preserves the existing error cause.

On Windows, synchronous publication reuses a positive cached own-process identity or obtains one through the existing bounded native probe on a cold call without an explicit caller wait budget. Cold calls with an explicit wait budget avoid that native query. Unavailable identity remains unavailable and retry-throttled; a cached identity grants no new reclamation or release authority. Identity-less legacy records with a reused live PID remain uncertain and cannot be safely reclaimed merely from that PID's current identity. Synchronous administration and exit APIs retain their conservative observation boundary.

Native runtime readiness and capability probes reachable inside a lifecycle guard must have individual client limits. Readiness info is limited to ten seconds; observation probes retain their five-second limits and destructive stop/removal use thirty seconds. Hard client termination prevents a child that ignores a soft termination signal from retaining the synchronous guard indefinitely. Timeout remains failure or unknown evidence and cannot authorize a destructive effect. Runtime readiness refusal propagates an error through the held guard rather than exiting before cleanup; the CLI retains a failure outcome. Guard release must still run after a rejected or timed-out client operation.

Own-process identity must be resolved before exclusive claim creation, so a slow native probe cannot leave an empty claim eligible for malformed-record recovery. A pending unavailable asynchronous observation must preserve a positive identity already cached by an intervening synchronous claim. These rules change publication qualification only, without changing stale-owner or qualified-release authority.

Elapsed time alone does not authorize reclamation of a live or unobservable owner. Boot identity can prove staleness only on the same host. Proven owner exit or a recorded process-identity mismatch may authorize token-qualified recovery. For a complete valid same-host claim, authoritative exit, different boot or eligible recorded mismatch is evaluated before the file-age grace; a young or future filesystem mtime cannot veto that positive proof. Only malformed/null publication records retain the existing 100 ms minimum and bounded stale-age grace, including conservative retention of future mtimes. Live, identity-less, unknown and foreign valid claims remain protected. Synchronous Windows no-CIM, bounded async observation, current/archive admission, exact-token and successor fences are unchanged. Verify with actual future-utimes fixtures through both facades and owning core cases. Malformed-record recovery remains conservative and directory identity fences remain required.

An asynchronous descendant must also refuse a guard held by its own causal operation with `shared-mutation-lock-self-contention`. This includes host/direct facade crossings and physical path aliases. The diagnostic requires both an inherited key/token and that exact token still being active; unrelated asynchronous callers keep waiting normally, and background work inherited from a released claim may acquire again. An expired explicit budget keeps timeout precedence. The context grants no reentrancy or deletion authority.

Only a mismatch between two recognized authoritative boot identities may prove reboot independently. A hostname plus an estimated boot epoch derived from wall clock and uptime is uncertain: clock correction must not authorize reclaiming a live or unobservable owner. Such records require the existing positive process-exit or recorded-identity mismatch evidence.

Standalone session-guardian cleanup and rollback acquire the lifecycle guard asynchronously. On Windows this captures the guardian's process identity before publication and permits positively observed recorded-identity mismatch recovery. Each cleanup retry takes a fresh guard and verifies the unchanged captured session receipt before any shared effect. Ordinary synchronous facade APIs keep their conservative boundary; an acquisition rollback already inside its lifecycle guard must use that held guard instead of reacquiring it.

After reservation capture installs the session signal handlers, SIGINT, SIGTERM and SIGHUP received during inspection, guardian READY or container acknowledgement request cancellation. Before existing-container acknowledgement, cancellation rolls back only the captured new reservation under the already-held lifecycle guard. After acknowledgement, cancellation retains the captured receipt and exact container ID, releases the acquisition guard and uses normal qualified cleanup. Capturing an existing container never enables shutdown by itself; failed joins and foreign claims retain their existing veto. Initial guard acquisition before handler registration retains normal process termination behavior; a later claimant may recover its proven-dead owner's guard.

Signal cleanup waits for acquisition to settle before exiting. Repeated signals share one completion path. Expected cancellation alone preserves the existing exit status. Reservation, guardian-release, lifecycle-release and other acquisition failures remain visible even after rollback has cleared the session context; they produce a failure exit without an unhandled promise rejection or broader deletion authority.

Verification uses the existing shared-mutation-lock, session-acquisition, session-cleanup-facade and emitted session-ownership integration suites. Native Windows evidence must be identified separately. These repairs do not establish the liveness or exact cause of an independently observed host guard whose process identity is unavailable.

Normal exec prepares its immutable base/identity image before taking the host-wide Codex state or per-container lifecycle mutation guards. It acquires the global state guard asynchronously before the container lifecycle guard, using the existing token-qualified recovery of proven stale owners. The legacy synchronous compatibility wrapper retains its conservative no-reclaim setting. Runtime identity and mount sources are checked again inside the transaction. The distinct setup guard retains setup serialization through ownership acknowledgement and helper initialization. MCP, SSH and Git synchronization run after mutation guards are released; a safely deferred existing container keeps its narrower SSH/Git initialization behavior. Start/restart checkpoints reuse the setup transaction's pinned image preparation.

Native create, start, replacement stop and removal commands have individual 30-second limits; rejected-container absence inspection has a 5-second limit. A client timeout does not prove daemon-side cancellation, container absence or permission to remove a name. Preserve the native error as cause and retain existing exact-ID/source/claim fences. These limits are not a total startup wall-clock guarantee.

Helper initialization must reject source or exact running-container identity changes before it returns, including changes during the final helper. A prior handoff does not permit command launch after failed initialization.

Rejected-create compensation preserves the original verification failure. If exact-ID removal or its independent absence observation also fails, retain those failures in an AggregateError with the original as cause. Subsequent proof of absence does not erase an observed removal failure.

Successful command execution cannot mask failed session cleanup. A single primary command/preparation, disposal or cleanup failure propagates unchanged; multiple failures propagate in that order in an AggregateError with the first as cause. Restore-config and error-presentation failures remain secondary diagnostics. Both synchronous signal cleanup throws and asynchronous rejections use the controlled failure exit path, once.

On Linux a well-formed /proc stat state Z or X proves the process has exited even when its PID and start ticks remain visible. Such owners are stale for session claims and absent for native shared-guard liveness. Other-host records and failed or malformed observations remain conservative; a reused live PID without a recorded identity is still not proof of the original owner's liveness or death.

On Windows, a pathname stat may omit the device number even when an opened descriptor reports its volume. In this specific case receipt capture requires matching positive volume, inode and birth time from two opened handles to the exact path, plus a repeated regular-file path check. The receipt retains the descriptor's device number. Volume mismatch, rebinding and uncertain observations remain refusals; future receipt comparison still includes device, inode, birth time, contents and owner PID.

## Known ceiling

Native timeouts bound individual client operations; daemon work may continue after timeout. Preserve uncertainty during qualification.

## Successor admission during stale reclamation
A delayed reclaimer must never admit another protected operation while a displaced
live or unobservable owner still operates. Token qualification before or after a
rename alone is insufficient. Admission verifies the complete published current
claim and preserves exclusion represented by surviving displaced records.
Interrupted publication, stale/malformed recovery and release retain the original
bounded waits, conservative owner policy and pinned-directory admission. Cleanup
removes only this operation's qualified current or displaced record; it cannot
replace or erase a successor. Preserve the existing record/filename compatibility.
The actual three-contender interleaving is a required regression witness.

Displaced ownership evidence moves one way from the canonical claim to a unique
archive, then qualified removal. It is never restored. Complete claim publication
and close precede archive-owner admission and final current-token qualification.
A live, foreign or unobservable archived owner vetoes admission for the original
bounded allowance. Lost candidates clean only their own displaced tokens and
retry without renewing the allowance. Release attempts main first, then own
archives; native read/identity uncertainty never grants malformed cleanup.
Continuously preserved owner evidence may reside in an archive during a true
race. Legacy live/unknown archives remain conservative; mixed older participants
that ignore archive admission are outside the new mutual-exclusion guarantee.

## Session cleanup target stability

One cleanup attempt captures its own claim path, project/profile, container ID and authorization generation before invoking project lookup or lifecycle callbacks. Shared-device cleanup, diagnostic reporting and native runtime binding cannot retarget that attempt. Before successful own-claim retirement, a target, claim, project/profile or authorization change (including revoke then regrant or an ID changed away and back) interrupts cleanup without stopping a replacement container or removing a replacement claim. Keep the interrupted session available for an explicitly authorized retry. A native stop reads the pinned target only while that captured authorization is still current. Failed stop retains the claim.

Successful own-claim removal is the irreversible completion boundary under the held lifecycle guard. Settle that retired session there, without requiring its absent receipt for a later retry or repeating completed stop/removal effects. Authorization changes after this boundary do not reopen the retired session. Preserve a distinct replacement session and its claim; a new session after completed cleanup retains the existing clear-then-set admission contract. A guard-return failure still propagates, while retry may settle the already-retired ownership without another destructive cleanup. Unchanged cleanup retains its existing peer veto and exact-target stop behavior.

Verify mutation during project lookup, guard admission, peer lookup, device cleanup, error reporting and native binding, plus interrupted retry and revoke/regrant. Verify same-owned-session authorization changes during successful removal and guard return, and guard-return failure after retirement, without repeated stop or missing-receipt deadlock. Runtime-name inequality alone grants no shutdown permission. The separately planned guardian-record preservation and dual-veto work is not established by these target-stability regressions.

## Guardian responsibility and orphan recovery

Provenance: the following rules are derived implementation decisions for the
[session-exit cleanup requirement](REQ__session-exit-cleanup.md). The user requested
reliable cleanup and the architecture transition; they did not prescribe claim
kinds, sidecars, generations or a publication protocol. The full recovery contract
in the local PLAN for `TASK__architecture-shared-claim-veto-followup-20261019`
selected these mechanisms to preserve existing guarded cleanup and avoid granting
effects from uncertain observations. Their application is owned by
[session claim recovery](../../src/application/session-claims.ts) and
[session ownership publication](../../src/application/session-ownership.ts).

A monitored session keeps its cleanup responsibility independently of the lifetime of its parent process. Its immutable main claim identifies the owner and remains bounded to 4096 bytes. Separate bounded evidence binds the exact claim file and contents, project/profile, captured native runtime authority, guardian process identity, and current cleanup authorization. Direct claims used without a guardian must be distinguishable from monitored claims. Missing, replaced, unreadable, or older ambiguous evidence is an incomplete observation, never proof that cleanup succeeded.

Initial guardian registration and each authorization update are published by the parent under the container lifecycle guard. Code already holding that guard uses an explicit held-guard operation. Other callers acquire it separately; neither path relies on reentry. The guardian must send READY and ACK without first waiting for that same guard, so a parent awaiting the response can make progress. Acknowledgement becomes current only after qualified publication; pending revocation and a newer generation prevent an older response from restoring permission.

A qualified initial registration with no pending request, acknowledged authority, or positive own-start has no cleanup obligation and can be rolled back before or after READY. An absent registration does not establish that fact. Direct claim creation and capture of its original file receipt occur under one lifecycle guard, so a replacement after guard release cannot become removal authority. Guardian startup must not load the device-cleanup module before READY; terminal cleanup awaits that module when it is needed.

Startup records uncertainty before attempting a native effect. Such an intent alone grants no shutdown permission. A verified positive own-start callback synchronously records the exact full container ID before queued IPC, independently of an earlier rejected acknowledgement promise. A failed join, a cleanup-disabled acknowledgement, an attempted start, or a later running observation cannot substitute for positive own-start or current acknowledged cleanup authority.

Queries must not remove a monitored claim because only its parent is dead. Before a new monitored reservation is admitted, guarded recovery observes both parent and guardian identities. A live or uncertain participant remains protected. When both are positively dead, recovery uses the retained exact authority and captured runtime, not the caller's current runtime selection. Failed recovery retains the qualified claim and concrete incomplete state for a later retry. Successful recovery retires only its own qualified evidence. All other claim-removal entrances must respect the same responsibility; a failed startup cannot erase another session's obligation.

Shared device cleanup and exact container shutdown have separate peer decisions. Every live, uncertain, or recovery-needed peer blocks shared device cleanup. A peer stops blocking our exact container shutdown only when its current qualified acknowledgement names a different full 64-hex container ID. Missing, short, aliased, equal, pending, or replaced IDs remain vetoes; a different runtime or endpoint is not evidence of a different target. A cleanup obligation may transfer only to a qualified current cleanup-enabled successor for the same exact container and captured native authority. A cleanup-disabled join cannot receive it. All-dead recovery must make progress without transferring responsibility in a cycle or dropping the last responsible claim.

For redundant dead obligations, recovery chooses a deterministic qualified acknowledged recipient and settles that surviving obligation after transferring the others. If no such recipient exists, or the captured native authorities differ, recovery retains the unresolved claims and reports incomplete responsibility; it must not invent a handoff.

Verify the actual parent/guardian process boundary: owner exit while cleanup retries, owner and guardian death, admission during retry, failed cleanup-disabled join, stale ACK after revocation, positive own-start before ACK failure, PID reuse, replaced evidence, and independent/equal/unknown peers. Tests using an inert native runtime must still exercise genuine guardian IPC, filesystem identities, lifecycle guards and emitted entry points. Portable fixtures do not establish actual Mac or Windows acceptance.

### Known ceiling

The native runtime can complete a start before the parent publishes a positive callback. If that parent dies in this interval, an intent plus a later running observation cannot establish who started the container. Preserve the unresolved responsibility and report incomplete recovery rather than guessing shutdown authority. This contract does not claim an atomic daemon effect and host receipt, migrate legacy uncertainty into permission, or guarantee recovery of running application processes.

Before downgrading to a version that does not implement monitored responsibility, quiesce the new monitored participants and settle their claims. Older readers do not implement this recovery protocol and cannot be relied on to preserve its guarantees.
