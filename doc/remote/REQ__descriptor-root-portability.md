# Receiving-host descriptor root portability

Derived technical requirement: the descriptor and cancellation mechanisms below preserve the existing [remote completion and cancellation contract](REQ__execution-completion.md), [exact sync authority](REQ__sync-authority.md) and [mutation-claim ownership and successor protection](../common/REQ__session-mutation-lock-lifetime.md). They are implementation corrections needed to retain those contracts across the supported receiving hosts, within the existing CLI scope and native-tool dependencies.

Remote lifecycle and global bind-authority operations must work on the supported Linux and macOS receiving hosts without treating `/dev/fd/<directory>/child` as a portable directory namespace. Global bind-authority descriptor-bound record reads require the standard native `tail` utility alongside their existing tools; that path's missing-tool preflight retains the prerequisite refusal (exit 75). This correction introduces no receiving-host interpreter or package dependency.

Operations remain anchored to the directory generation opened and admitted by the caller. Canonical or lexical path spelling alone does not authorize a later write, claim, release or cleanup. Failed admission or required revalidation of generation, type, mode or claim ownership must retain the existing nonzero refusal and preserve successors and unrelated state. An already admitted operation may finish against its pinned generation where the existing protocol and effect-specific checks permit; a new or waiting admission must refuse a changed generation. A rename or same-path replacement never authorizes access to the successor. Foreign claims retain their existing effect-specific vetoes.

Early admission failures report their nonsecret validation stage on stderr while preserving the existing exit status and stdout protocol. Diagnostics must not disclose credentials or authorize a fallback when native proof is unavailable.

If a pinned working directory is used, verify its identity against the held directory before admitting operations. Nested lifecycle and bind-authority work must retain each root independently, preserve exact container IDs and public output, and keep signal/exit cleanup scoped to owned claims. Repeated descriptor-bound reads must read the complete bounded record from its beginning rather than depend on platform-specific descriptor reopening offsets.

Metadata for an opened descriptor must come from that descriptor itself. GNU `stat` with operand `-` and BSD `stat` without an operand can inspect a command-local stdin duplicate without reading or advancing it. Do not compare a synthetic `/dev/fd` vnode identity with the receiving directory's identity or fall back to the original path. Preserve all existing type, owner, mode, link-count, size and exact generation checks.

The GNU-style stdin observation must explicitly dereference its command-local
descriptor. Ubuntu's uutils `stat` can otherwise report the descriptor-link
vnode after the private file is unlinked. The observed identity must remain the
admitted file's identity, with mode 600, zero links and the expected size; a
well-formed synthetic result is not acceptable proof. Retain the BSD stdin
observation and every failure refusal, without reopening the original pathname.

Cancellation must work both for a signal to the owning shell PID and for a process-group signal. Every intermediate scope must retain ownership until its protected native foreground work has stopped; it must not release a claim merely because a child shell exited. When worker ownership is proved and cancellation is accepted, no later body statements may execute. If ownership cannot be proved, cancellation is refused: work may remain active, and its claims must remain held rather than reporting a completed cancellation.

Once the final owned cleanup handler starts, repeated HUP/INT/TERM must not
interrupt its native waits or claim release. Disable its EXIT callback while
ignoring those signals through the existing ownership-qualified cleanup and
original signal-status exit. A group signal and a supervisor's later qualified
forward may overlap. This protection does not authorize releasing a refused or
changed claim, skipping a native join, or signaling an unverified process.

An interruptible supervisor may signal only its exact operation-owned worker and descendants admitted through captured native ancestry, process birth and command identity. Revalidate that proof immediately before a signal. A changed or unavailable identity authorizes neither a guessed signal nor successful claim release. Do not substitute unverified process-group membership for ownership. POSIX asynchronous jobs may inherit ignored SIGINT; cancellation may use TERM for the proved owned work while preserving the caller's HUP/INT/TERM exit status. Completion waits for that work to stop and can remain pending indefinitely if it refuses termination; claims remain held during that wait. Root or descendant replacement, delayed signal handling and cancellation before worker readiness require focused regression evidence.

If a previously admitted descendant is reparented during cancellation, its unchanged birth and command permit waiting for its actual completion, without signaling it under the former ancestry. A parent already proved absent is distinct from an unavailable or changed process identity.

Native process state and displayed command can be sampled across process exit.
When an observation retains the captured birth and parent but its command differs,
one read-only `kill -0` check may establish positive PID absence through an explicit
`No such process` result. Only that positive absence permits retiring the captured
record without a signal. A live PID, permission failure or unknown result retains
refusal; changed birth or parent cannot use this exception. Do not retry ambiguous
observations, adopt the changed command, or signal using partial identity proof.

After an identity-qualified TERM, a fresh read-only observation determines whether the worker needs CONT. Unavailable observations or changed process birth or ancestry retain refusal. Only a stopped worker may receive CONT, after another full birth, command and ancestry match and a fresh stopped-state check immediately before the signal. Other observed states require no resume signal; retain the captured records, owned-child wait, refusal-channel checks and positive completion joins. A changed displayed command, unknown state or exiting indication alone never proves completion. Before initial admission is proved, keep observing under held claims until positive absence or a fully revalidated stop permits its one resume: the worker can enter its initial stop after earlier non-stopped observations. An already admitted worker retains the single post-signal state observation before its normal wait. Failed capture authorizes no subsequent descendant signals; retain discovered records for qualified joins rather than dropping a descendant whose parent disappeared.

An ordinary protected-command failure, including exit status 79, remains that command's result and permits normal cleanup once the work has completed and claim identity still matches. Internal ownership refusal requires separate operation-owned evidence; no ordinary exit code establishes refusal. Any private transport for this evidence must preserve stdin and public output, remain tied to an admitted inode, and leave no persistent record or new package requirement.

Cancellation must not orphan a foreground native process's waiting children by terminating their parent and then releasing claims. A single live process-tree snapshot cannot prove that no child will be created before the signal. Native work whose quiescence cannot be established must remain under held claims until completion or explicit refusal.

Verify the existing native lifecycle, session, bind-authority and cache-identity fixtures, including contention, replacement, rename, malformed records and interrupted cleanup. Portable Linux results establish only those exercised branches; macOS descriptor and native-tool acceptance requires focused host results.
