# ADR: Hyper-V Windows internal library boundary

## Status

Accepted on 2026-08-31.

## Context

Device Lab currently reaches Hyper-V through host-control helpers and a large
broker orchestration path. Those helpers are useful implementation material,
but their contracts are not a reusable Windows library boundary: required CCC
owner/device/incarnation fields, a CCC Notes marker, combined VM-and-artifact
deletion, and a single optional `diskPath` mix consumer policy with native host
behavior.

The lossy disk representation caused a concrete lifecycle failure. A valid
Running or Off VM with no attached hard disks produces no `diskPath`, while
broker reconciliation requires that scalar to equal the journal's expected
root disk. Safe partial residue is therefore rejected before Device Lab can
recover it. More local guards would leave the same modeling error available to
the next consumer.

The intended long-term shape is a typed Node/TypeScript library aligned first
with Windows Hyper-V operations, with optional generic lifecycle conveniences
above it. Device Lab then consumes that library rather than defining its
contracts. The boundary must be proven internally before committing to public
package compatibility or a broad native-API implementation.

## Decision

Create a new internal boundary at `src/hyper-v-windows/` with two layers that
form one future extraction unit:

```text
Device Lab MCP/provider
    -> Device Lab Hyper-V adapter
        -> hyper-v-windows/lifecycle
            -> hyper-v-windows/low-level
                -> injected PowerShell/CIM transport
                    -> Windows Hyper-V
```

Dependencies point only downward. `hyper-v-windows` cannot import Device Lab,
its broker, MCP/HTTP contracts, state layout, or CCC ownership contracts. The
low-level layer cannot import lifecycle. Device Lab-specific translation stays
in an adapter outside the library.

### Low-level responsibility

Low-level maps one typed call to one target Hyper-V primitive. The initial VM
lifecycle slice was `Get-VM`, `Get-VMHardDiskDrive`, `Get-VMDvdDrive`,
`Start-VM`, `Stop-VM`, and `Remove-VM`; migration slice 1 added `Get-VMSnapshot`,
`Checkpoint-VM`, `Remove-VMSnapshot`, and `Restore-VMSnapshot`. It owns request validation, a single transport
invocation, strict bounded response decoding, native-faithful result types, and
stable typed validation/transport/protocol/native errors. The PowerShell
transport may perform one `Get-VM` selector-resolution read before exactly one
target primitive for operations other than `Get-VM`; this is resolution inside
the single attempt, not retry or lifecycle policy.
Selector resolution enumerates with `Get-VM -ErrorAction Stop` and filters exact
ID/name matches. Only a successful zero-match enumeration means absence; a
missing cmdlet/module or any host/native error fails closed.

Native collections remain collections, including exact empty arrays. Unknown
native state/status/controller strings remain observable. Low-level does not
own retries, polling, ownership policy, journals, idempotency, artifact cleanup,
or public Device Lab responses. `Remove-VM` removes the VM only.

### Lifecycle responsibility

Lifecycle depends on low-level and adds consumer-neutral operation intents,
unique identity checks, kind-specific attachment subset safety, discriminated reconciliation
outcomes, and bounded retry with injected sleeping/cancellation. An empty
attachment set is safe partial residue once VM identity is proven. A foreign
attachment is a terminal conflict; a permitted hard-disk root does not permit
DVD media at the same root. Absence is idempotent for remove; unknown or
transitional state remains pending.
Pathless hard-disk records, including pass-through physical disks represented
by `diskNumber`, are conflicts because this slice has no physical-disk ownership
allowlist. Empty DVD drives remain safe.

No journal-store abstraction is added in the first slice because the library
does not yet persist an intent. When persistence enters the library, it must be
an injected generic port; Device Lab filenames and schemas remain outside.

These lifecycle capabilities are part of the later library extraction, not a
Device Lab implementation detail. Current contracts describe native identity,
allowed attachments, desired lifecycle state, and bounded retry—not CCC owners,
commands, filenames, or cleanup roots. A generic persistence port joins that
boundary only if lifecycle later owns persistence.

### Device Lab responsibility

The dedicated adapter translates the existing version-1 operation journal and
CCC owner/device/incarnation identity into lifecycle expectations and builds the
injected executor/client. Device Lab broker orchestration continues to own
journal files, state mutation, public error mapping, network allocation, and
path-fenced artifact cleanup. Together they own VM naming/Notes policy, and the
broker clears the journal only after a typed settled result and existing
completion rules. When the expected ID is absent, the adapter checks the exact
expected name before reporting absence, so a replacement/different-ID VM fences
all cleanup. The adapter also recomputes a shared broker deadline before each
low-level transport invocation in a multi-step reconciliation.
The adapter executes the library's digest-verified source through the exported
fixed `-Command` bootstrap and bounded stdin-envelope helper. It never reopens
that source with `-File`, so the production consumer and standalone proof share
the same check/use-safe transport contract.
For a stable start/stop mismatch, broker orchestration performs the one typed
pending action and re-inspects; it mutates state and clears the journal only
after the fresh outcome is settled.

The first production migration is deliberately narrow: operation
reconciliation, including delete reconciliation and the zero-attached-disk
residue case, moves through the new boundary. Create, image, networking,
snapshot, guest setup/transport, and ordinary lifecycle call sites may remain
on legacy host-control helpers until migrated one native operation at a time.

## Migration roadmap

`src/host-control/hyper-v` is migrated into the library one slice at a time. The
agreed scope is Hyper-V primitives plus VHD manipulation; image download/hash
acquisition and the Linux SSH/cloud-init paths stay in host-control because they
are not Hyper-V operations and would contradict this boundary.

| Slice | Legacy commands retired | Low-level operations added |
|---|---|---|
| 1. Snapshots (done) | `hyperVSnapshotCreateCommand`, `hyperVSnapshotDeleteCommand`, `hyperVSnapshotRestoreCommand` | `Get-VMSnapshot`, `Checkpoint-VM`, `Remove-VMSnapshot`, `Restore-VMSnapshot` |
| 2. Networking | `hyperVEnsureNetworkCommand`, `hyperVCleanupNetworkCommand`, `hyperVBootstrapNetworkCommand`, `hyperVBootstrapNetworkCleanupCommand`, `hyperVInspectNetworkAllocationsCommand` | `Get-VMSwitch`, `New-VMSwitch`, `Remove-VMSwitch`, NAT/IP reads |
| 3. Creation and VHD | `hyperVCreateCommand`, the VHD portion of `hyperVPrepareBaseImageCommand` | `New-VM`, `Set-VMMemory`, `Set-VMProcessor`, `Set-VMFirmware`, `Add-VMHardDiskDrive`, `Add-VMDvdDrive`, `New-VHD`, `Convert-VHD`, `Optimize-VHD` |
| 4. Guest PowerShell Direct | `hyperVGuestExecCommand`, `hyperVGuestUploadCommand`, `hyperVGuestDownloadCommand`, `hyperVGuestReadyCommand`, `hyperVGuestBootDiagnosticCommand`, `hyperVGuestProvisionCommand` | PowerShell Direct session primitives |
| 5. Lifecycle residue | `hyperVStatusCommand`, `hyperVRebootCommand`, `hyperVDeleteCommand`, `hyperVRecoverOrphanCommand` | `Restart-VM`, plus adapter migration onto the existing operations |

`hyperVSnapshotRepairCommand` deliberately stays a host-control PowerShell asset:
it reconciles checkpoint state across several cmdlets rather than issuing one
native primitive, so it does not fit the low-level contract.

Each slice moves consumer policy into the Device Lab adapter rather than into the
library. Slice 1 moved ownership fencing, delete confirmation by observation, and
restore stop/start sequencing out of generated PowerShell and into
`src/device-lab/broker/hyper-v/snapshots.ts`. Owner-scoped checkpoint naming
(`hyperVSnapshotName`) and the checkpoint-policy assertion stay in the broker
preflight in `src/device-lab-broker.ts`, where they already were; the adapter
receives the resolved provider name and never derives it.

Each slice also costs provider round trips, because the library issues one
primitive per call where a generated script could batch several. Slice 1 raised
the Windows lifecycle test's provider call count from 90 to 105.

### The round trips are cheap; the process was not

That count is now a poor proxy for cost. The expense was never the fork — it was
`Import-Module -Force` running inside every one, which the pinned asset did on
each invocation. The library can therefore serve many primitives from one reused
PowerShell process, and the asset skips the reimport when the trusted module is
already loaded from the expected base. A slice's round-trip count still matters
for latency, but it no longer multiplies a module load.

**Batching was considered and rejected, and the reasoning should not be
re-derived.** The adapter flows are dependent chains, not independent sets:
`deleteDeviceLabHyperVSnapshot` is `getVMSnapshots` →
`removeVMSnapshot(snapshot.id)` → `getVMSnapshots`, where each request needs the
previous response to exist. Nothing can be sent together, so a batch envelope
removes no round trip from the flows that actually cost. Session reuse pays the
module load once whatever the call graph looks like; batching would still pay it
once per flow. If a future slice introduces genuinely independent operations,
batching can be added over the session transport — but it is not the answer to
the cost recorded above.

The loop lives in the session bootstrap, never in the pinned asset. Both
transports execute a byte-identical artifact, which is what stops the one-shot
path and the session path from diverging; if that ever stops being true, every
adapter test proves less than it appears to, because they all exercise the
one-shot path.

The session is created only when the broker owns process execution. An injected
command runner means the caller owns it, and a long-lived child spawned behind
that seam would run work the caller never saw.

**The asset must never call `exit`, and this is load-bearing rather than
stylistic.** PowerShell's `exit` is not scoped to a script block: under
`& ([ScriptBlock]::Create($source))` — how both transports invoke the asset — it
unwinds past the caller instead of returning to it. The first session
implementation kept the asset's `exit 1` on the failure path, which aborted the
`Out-String` pipeline that was capturing the failure envelope and terminated the
child. An ordinary `virtual-machine-not-found` — the condition every ownership
fence and every reconcile exists to discover — therefore reached callers as a
non-retryable `hyper-v-windows-transport` instead of a typed native error, and
cost a process spawn and module load per occurrence. `try`/`catch` is no defence:
`exit` raises a flow-control exception, which `catch` does not intercept.

The asset now resets `$global:CccHyperVExitCode` on entry and sets it to 1 on the
failure path, and each bootstrap decides what to do with it — the one-shot
bootstrap exits with it at the top level of `-Command`, where there is nothing
left to unwind past, and the session bootstrap reports it as the response frame's
exit status. That is what makes the two transports produce identical
`HyperVWindowsExecutionResult`s for identical host conditions.

The bootstrap clears `$global:CccHyperVJsonInput` and resets
`$global:PSDefaultParameterValues` between requests. **That list can never be
complete, and does not need to be.** Functions and aliases defined during
`& $Operation` land in the invocation's child scope and die with it — the same
mechanism that already keeps the asset's own helpers from leaking.
`$PSDefaultParameterValues` is different in kind: it is consulted by dynamic
scope lookup, so a global one is honoured, nothing disposes of it, and it would
silently re-aim the pinned asset's cmdlet calls for every later owner without
changing a byte of the hashed asset — `Remove-VMSnapshot`'s
`-IncludeAllChildSnapshots` being the obvious one. The actual invariant is that
the hash-pinned asset is the only code that runs in that runspace; these two
resets are belt-and-braces for the one variable that could re-aim it silently.
`$env:` is the only other member of that class and is deliberately not reset —
the child legitimately needs its inherited environment.

**Two signals decide whether a request reached the child, and only one of them is
load-bearing.** The latch is: did the child emit the ready marker? The bootstrap
writes and flushes it immediately *before* entering the read loop, so a child that
has not announced cannot have reached that loop, which proves nothing sent was
executed. That is a logical invariant, it is deterministic, and it is the
mechanism the crash-on-start fallback actually rests on.

Two narrower versions were tried and are both worse. Latching on *any* byte
counts a child that writes a startup banner and dies as having spoken, so its
request is not re-issued when it safely could be. Gating on the marker reaching
the *session's* line listener is unsound in the dangerous direction: that listener
is attached later, inside `ensureChild`, so the marker can be emitted first and
lost, and concluding "never announced" from a lost marker moves a request toward
being retried. The latch here is set by the pool's own line handler, attached
synchronously at spawn, so it cannot miss it.

The write completion callback is the secondary signal and does **not** answer the
same question. It reports whether the bytes left this process, not whether
anything read them: a write into a pipe succeeds into the kernel buffer whether
or not the reader is alive, so measured against an instantly-dying child on Linux
it identified the case 2/30. It is kept because it is sound where it does fire,
and because raising the failure from inside it orders the correction ahead of
`failAll`. It must never be combined with the latch: the callback runs before any
of the child's output can be delivered, so consulting the latch there reads
"never announced" even for a child that had — which measured 3/40 as a false
never-ran, the direction that duplicates a mutation.

**The never-ran classification is checked, not trusted.** The write-path codes
mean "this frame never reached the child", and that is what makes the broker
re-issue them — so believing the reason string would make the safety of a
duplicate `Remove-VMSnapshot` a contract on whatever implements
`HyperVWindowsSessionProcess`, enforced only by prose in a different file. The
session records whether each request's write reported reaching the pipe — the
completion callback, not the return, which proves nothing — and reports a
delivered request as an exit no matter what reason arrives. QA demonstrated the gap with a
fully conforming process that accepted the frame and then reported
`stdin-failed`; the shipped implementation never does that, which is exactly why
nothing would have caught it.

State the boundary as it now stands rather than as it was: **the process is
trusted for delivery, not for classification.** It asserts one bit — that a
particular write did not reach the pipe — and that bit is believed. It is not
trusted to name what happened, which is what the check above removes. The default
is the safe one: a process that never reports delivery is treated as having
delivered, so an implementation that does not cooperate can only cause hard
failures, never a duplicate mutation.

Two related constraints on the session bootstrap follow from the same reasoning.
The reply is joined, not piped through `Out-String`, because `Out-String` formats
to a host width and is free to break a long JSON envelope into lines the reader
would reject as `response-malformed`. And `2>&1` is not used, because merging the
error stream into machine-readable output corrupts it; the session owner drains
stderr separately.

**A caller's deadline and the child's health are separate questions, and
conflating them is worse than either alone.** The broker bounds each primitive by
what is left of its operation deadline, and `hyperVRemainingTimeout` floors that
at 1ms, so a caller can legitimately arrive with almost no budget. The first
implementation let that one caller's timeout discard the session — killing a
child every other concurrent flow was using, failing all of them with an error
that is deliberately not retryable, and making the next primitive pay the
PowerShell start and module load this slice exists to remove. The caller's
deadline now settles only that caller and leaves the request pending; a late but
correlated reply still clears it and still counts as a productive session. A
separate health floor, matched to the library's per-execution ceiling, is what
concludes the child is wedged.

The corollary is that the request queue is released when the request leaves the
pipe, not when its caller stops waiting. Releasing on the caller broke the
one-request-at-a-time invariant the transport depends on — measured, six frames
were written to a child that had answered nothing — and started each queued
caller's deadline against work it had not reached, timing it out for someone
else's stall. A caller that gives up therefore still holds the pipe until the
child answers or the health floor fires.

That leaves one wedged operation blocking the pipe for up to the health floor,
which on its own would be a real availability regression against the one-shot
transport: there, four callers behind a wedged one got four healthy processes,
because a session is shared process-wide while a one-shot execution is not. The
resolution is classification, not a shorter floor. A caller whose deadline
expires **while still queued** provably never ran — its frame was never written.
That is the same proof `SESSION_NEVER_RAN_ERRORS` already rests on, so it gets
its own code, `hyper-v-windows-session-queue-timeout`, and the broker serves it
one-shot. A caller whose frame *was* written keeps
`hyper-v-windows-session-timeout` and still fails outright, because the host may
already have done the work. The pipe blocks; the other callers do not.

For the same reason the caller's deadline starts in `execute`, before the queue
wait, not inside the write. Timing it from the write gave a queued caller no
deadline at all — it waited out the health floor, which is exactly the "a
primitive with 2.5s of budget must not run against the 120s ceiling" failure the
clamp exists to prevent, reappearing one layer up.

The start budget bounds *consecutive unproductive* starts, not starts over the
process lifetime. A lifetime counter conflates "this host cannot run PowerShell"
with "this broker has been up for days": the third restart, however far apart,
made the pool return `hyper-v-windows-session-unavailable` permanently, which
falls back to one-shot — so the whole feature disappeared with no error anywhere.

**Sharing one pipe needs admission control, or one owner denies the path to
every other.** A slow operation — `Stop-VM` against a guest ignoring shutdown, a
checkpoint on a large VM — holds the single process-wide pipe for up to the
health floor, and every other owner queues behind it. The never-ran
classification is the escape, but it only helps if the caller reaches it with
budget left: waiting the whole deadline and then falling back is the same as not
falling back. Subtracting the wait from the retry is worse still — a queued
caller reaches the fallback precisely because its wait expired, so the
subtraction hands the retry a millisecond and guarantees it fails.

So the queue may consume only a fraction of a caller's budget, and a queue
already at its depth cap refuses immediately. Both bound the same thing: how much
of one owner's deadline another owner's slow operation can spend. The depth cap
also bounds the queue's memory, since every waiting closure pins its request.
This matters more than it looks — at the broker's snapshot call sites the budget
is a constant equal to the library's own per-execution ceiling, so every clamp
downstream is a no-op, and `restoreDeviceLabHyperVSnapshot` issues seven
primitives.

**One session is shared across all owners, and this reverses what the task plan
said.** `PLAN.md` AC-004 required that the session "does not outlive the broker,
and is not shared across owners". The first half holds — the pool is
reference-counted and released on broker close. The second half does not: the
pool keys sessions by PowerShell executable, so every owner on a broker shares
one child.

That was a deliberate choice and it should be judged as one rather than
discovered in a code comment. Keying per owner reintroduces exactly the cost the
slice exists to remove — a device lab serving N owners would hold N long-lived
PowerShell children, each with its own loaded Hyper-V module, and each owner's
first primitive would still pay a spawn and an import. The saving would survive
only within a single owner's flow.

An independent security review examined this and judged the deviation defensible,
with a claim narrower and stronger than "the session carries no owner state":
**owner isolation never rested on the process boundary.** It rests on
owner-scoped lookup before the call — `findOwnerDeviceForTool` resolves the
device inside the caller's own owner state, so a caller never supplies a raw VM
id and cannot name a machine it does not own — and owner-scoped validation after
it: the `notes` fence and disk-path allowlist in `reconcile.ts`, and
`resolveOwnedHyperVSnapshot` requiring the owner-scoped `ccc-<ownerId>-<name>`.
Neither changed in this slice. No credential enters the shared child either: the
session serves only the ten allowlisted operations, whose requests are JSON
selectors, and every credential-bearing path goes through
`hyperVProviderCommandRunner` directly.

Three residuals belong on the record next to that, because "no cross-owner path"
alone would overstate it.

**The isolation guarantee changed hands.** It used to be enforced by the OS; it
is now enforced by the SHA-256 pin on the asset. Nothing an owner sends can leave
state in that runspace *because the only code that runs there is the hashed asset
and its fixed allowlist*. So the integrity check is now load-bearing for owner
isolation, not only for supply-chain integrity. Read that sentence before
relaxing the pin or widening the allowlist to admit anything that takes an
expression. `Checkpoint-VM`'s `-SnapshotName` is the one allowlisted operation
already taking a caller string; it is safe because it is a bound parameter rather
than interpolated, and that is the property to preserve.

Two amendments a later security review added to this residual. First, the pin is
verified **once per child, not once per execution**: the one-shot transport calls
`verifiedAsset` on every `execute`, while the session calls it only inside the
`starting` closure, and `ensureChild` returns early for every subsequent request.
An asset tampered with after a session is up is not detected until that child
dies. This is not a TOCTOU — the digest covers the bytes actually sent, and the
path is never re-read — but the checking *frequency* dropped, and since the pin is
what carries owner isolation, that narrows this residual rather than merely
detailing it. Second, the runspace hygiene between requests clears only
`$global:CccHyperVJsonInput` and `$global:PSDefaultParameterValues`; global
functions, aliases, variables and loaded modules persist across owners. Nothing
exploits that today precisely because no code but the hashed asset ever executes
there — the same load-bearing claim, stated from the other side.

**Cross-owner interference now exists in availability terms**, where it did not.
One owner's stale frame hard-fails whoever is in flight, and one owner can hold
every queue slot and push the others onto the one-shot path. Both degrade to the
pre-session behaviour rather than denying service — that is what the depth cap
buys, and it is part of what AC-004's second clause was buying instead.

One concrete instance worth naming, from the same review: the start budget is
shared and exhaustible. Three unanswered starts inside five minutes make
`ensureChild` return null, so *every* owner is demoted to the one-shot path for
the rest of that window, and the counter resets only on an answered response. A
start counts as unanswered whenever the child dies before replying — including on
an oversized response frame. Still degradation rather than denial, exactly as this
residual claims, but the blast radius is fleet-wide rather than per-owner.

**Unverifiable from a container:** whatever process-wide state the Hyper-V
PowerShell module itself keeps — CIM/WMI handles, internal caching — is now
shared across owners rather than torn down between them. There is no reason to
think it caches anything owner-sensitive, and every response is re-validated by
the fences above, but it cannot be inspected here and is named rather than
cleared. The Windows QA pass should alternate two owners' primitives against one
session and confirm results track live host changes rather than a first-request
snapshot.

The pool is process-scoped and reference-counted. Sessions carry no per-server
state, so two broker servers in one process share them; tearing them down on the
first server's `close` would kill a child the second is mid-request on, and
`hyper-v-windows-session-closed` is deliberately not retryable. Past the last
release the pool stops handing out real sessions, because they are taken lazily
from inside async tool handlers — a request still in flight at shutdown would
otherwise start a child nothing would ever kill.

Anything a session serves must remain visible to the recorder the broker uses for
provider diagnostics. The session bypasses the injected command runner entirely,
so a recorder that only wraps that runner sees nothing at all once a session is
live, and the snapshot payloads that carry provider execution degrade to stubs
exactly on the failures operators need them for.

### What the session's QA has to exercise, and why the unit suite cannot

Every defect found in this slice was an interaction defect at one seam: a single
shared, long-lived, stateful child against many independent callers, each with
its own deadline and its own idempotency requirement. Who owns the pipe, whose
clock applies, and what may safely be re-issued. None was a local logic error,
and none was reachable from the unit suite as written — the broker suite cannot
reach the session branch at all, because `usesDefaultCommandRunner` makes it dead
code in any test that injects a command runner. They were found by driving the
compiled library directly.

So a Windows QA pass that runs one flow at a time proves nothing about any of
them. It has to run: several owners issuing primitives against one broker
concurrently; at least one deliberately slow operation in the mix, so callers
queue behind it and the queue-timeout/never-ran classification is exercised; and
a deliberately unavailable PowerShell, so the start budget is exhausted and then
recovers after its window.

Two numbers in this design are guesses that only a real host can settle, and the
QA pass should report both rather than confirm them.

**The queue depth cap (8) decides where the optimisation stops.** Measured, 20
concurrent primitives against a healthy idle session admit 8 and refuse 12 in
2ms. The refusals are correct — immediate, classified never-ran, full budget
preserved — but they mean 12 fresh PowerShell processes, so above 8-way
concurrency the slice degrades to the one-shot behaviour it replaces. Whether
that is the right place to stop depends on how concurrent a real broker actually
is, which cannot be measured from a container.

**A session failure is publicly indistinguishable from a one-shot failure.** No
`hyper-v-windows-session-*` code is in `REDACTED_PROVIDER_DIAGNOSTIC_CODES`, so
every session failure surfaces as the generic fallback `diagnosticCode`. That is
exactly what makes the two transports' payloads identical, which is a property
worth having — but it also means an operator reading a public payload cannot tell
a session timeout from a one-shot timeout. The two goals are in tension and the
current resolution favours payload identity.

### The reviewer's recommendation: measure, then probably replace this

After thirteen review rounds the code reviewer stopped reviewing lines and
answered a design question instead. Recorded here because it is the strongest
argument on file against this design, and the decision it points at is the user's.

**Every hard problem in this slice descends from one property: the child outlives
the request.** That single fact generates all three families of machinery — "did
my frame reach the child?" (the readiness latch, `latchEvidenceLost`,
`delivered`/`settled`, the death-code classification, the never-ran taxonomy),
"whose deadline is this pipe spending?" (queue admission, two timers per request,
the health floor, the start budget), and "what did the last owner leave behind?"
(the runspace hygiene, and the security residual that owner isolation no longer
rests on a process boundary). One process per primitive does not make those
easier to answer. It makes them **unaskable**: a process serving one request and
exiting reports what happened in its own exit status and stdout, which is exactly
what the one-shot transport already does.

Three measured supports, none of them rhetorical:

1. **Eight of the twelve review findings were in machinery a warm pool deletes
   outright** — the asset-write ordering, the premature latch read, the stderr
   latch, the three marker routes, `close` never firing, and the grace path's
   conservative choice. Not "easier to spot": would not have existed. The four
   that survive — the retry budget, the record bypass, the parse check, the
   capability list — are in code that stays either way.
2. **The design declines to serve the case where its advantage would matter.**
   Above 8-way concurrency the depth cap refuses and callers get fresh processes
   anyway, so the shared session wins only between "enough concurrency to benefit
   from reuse" and "fewer than eight". Below that band a warm pool captures the
   same win by pre-paying the spawn and module import off the critical path.
3. **Round 12 silently un-pinned round 11.** The flood test kept passing for two
   reasons unrelated to the guard it was named for, so that guard could be deleted
   with the suite green. Twelve rounds did not prevent that, and a thirteenth
   would not have either — which is why the fix was structural.

**What must happen first, and neither the reviewer nor I can do it here:** run
the measurement this document already specifies — the same level-3 lane's
duration with and without the session, on a Windows host. The reviewer's
prediction is that the delta will be small against a 120s per-primitive ceiling
on a seven-primitive chain, and that the number will make the call easy rather
than close. If the saving turns out to be large, keep the session and treat the
death-code table as a floor: the queue admission control and the
`delivered`/`settled` discriminator are separate invariant clusters with their
own unpinned rules and deserve the same treatment.

The honest state of the code, in the reviewer's words: correct as measured, with
no live duplicate-mutation path found — and fragile against the next edit in a
way twelve rounds did not fix. `sessionProcess()` grew 34% in code while its
comments nearly tripled, and that ratio is the signal: the reasoning stopped
fitting in the code. That is not a statement about how it was written. It is what
happens when a shared mutable child is placed under an idempotency requirement.

The saving this slice buys is also still unmeasured. The round-trip count is
recorded (90 → 105 for slice 1) but the wall-clock saving is not, and the
measurement only exists on a Windows host: the same level-3 lane's duration with
and without a session. It is worth stating, because the cost side has grown —
a queue, two timers per request, a health floor, a decaying start budget, a
reference-counted pool, a process-exit sweep, and a new error class in the retry
taxonomy. If the saving turns out to be modest, one process per primitive with a
warm pool is a materially simpler design with most of the win.

### Known gap carried past slice 1

`Invoke-HyperVWindowsOperation.ps1` bounds its error code with
`-notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`. In .NET regex `$` also matches
before a final newline, so an exception message such as `"AccessDenied\n"`
satisfies the guard and is emitted verbatim. The client's
`NATIVE_ERROR_CODE_PATTERN` has no multiline flag and rejects it, so nothing
leaks — but the native status is lost and the failure degrades to
`response-envelope-invalid`. Anchoring both guards with `\z` closes it.

This is pre-existing and outside the snapshot slice, so it is deliberately not
fixed here: changing the script re-pins `HYPER_V_WINDOWS_POWERSHELL_ASSET.sha256`
and breaks the correspondence between the pinned asset and the Windows host run
that verified it. It belongs with slice 5, or with any other change that already
re-pins the asset and re-runs hardware QA.

**The session discards stderr.** `sessionProcess` drains the child's stderr
without reading it, because leaving it unread eventually blocks the child on a
full pipe. So `stderr` is always undefined on a session-served execution, and
`hyperVProviderDiagnosticCode` can never derive a PowerShell-flavoured
`diagnosticCode` from it. The damage is bounded: native failures already carry
the asset's normalised `errorCode` through the envelope, and the session's own
codes are filtered out of `diagnosticCode` by `REDACTED_PROVIDER_DIAGNOSTIC_CODES`
anyway — so the loss is real only for transport-level failures, which is exactly
where stderr would have been the only evidence. A bounded stderr ring buffer in
`sessionProcess`, attached to the `frameError` results, closes it.

## Packaging decision

Both `low-level` and `lifecycle` will be extracted together when internal
consumers and real Windows behavior stabilize. For now they remain internal and
share the repository's TypeScript build, declaration generation, tests,
integrity-pinned PowerShell assets, and release process.

Publishing now is deferred because it would prematurely freeze names,
compatibility policy, the default Windows executor, and supported native API
surface. The internal entrypoint is nevertheless treated as a package boundary:
intentional exports, injected transport, no upward dependencies, and no use of
private parser/framing details by consumers.

## Real-host proof boundary

The standalone hardware proof imports the compiled public root
`dist/hyper-v-windows/index.js`; it does not deep-import implementation modules
or execute TypeScript source. In a source checkout the command first builds the
isolated library subtree; in an installed archive it uses the prebuilt `dist`
entrypoint and a Node-20-targeted bundled launcher because source/config inputs
are intentionally absent. No runtime TypeScript loader is part of the package
contract. A fixture-only PowerShell asset owns prerequisite
checks, creation, attachment setup, and guarded teardown. It does not implement
the VM observations, lifecycle assertions, or VM removal being tested. This
keeps a real-host PASS attributable to the extractable library rather than to a
parallel test implementation.

The child-process bridge is local to the real-test harness for now. It implements the
library's injected file-runner port with a bounded stdin envelope and process-tree
termination. Keeping it outside the public library avoids prematurely choosing
a default Windows process API while still proving that the published-shaped
port works against native PowerShell. The library does export the fixed
in-memory bootstrap and envelope constructor needed to execute its verified
asset without a path-reopen race; process spawning remains consumer-injected.
Its dependencies are injected so the
same boundary has deterministic Linux tests.

Destructive fixture cleanup uses capability-like evidence rather than a naming
prefix: a random token is embedded in the exact VM name, Notes, fixture-root
marker, and recorded cleanup request. Cleanup validates exact VM ID/name/Notes
and every non-null attachment path before removing anything. `Remove-VM`
retention is checked before file teardown. Ambiguity preserves evidence and
turns the test red, which is preferable to a false green or deletion outside
the fixture root.
The fixture and production PowerShell files are integrity-pinned. The runner
passes the exact verified bytes in a stdin envelope to a fixed in-memory
PowerShell bootstrap, so the elevated process never reopens a mutable asset path
after the digest check. Create failures retain their
partial evidence for the ordinary guarded cleanup path instead of attempting a
less-validated inline rollback.
The bootstrap Base64-encodes its UTF-8 JSON envelope and uses the existing
redirected Console streams. This avoids both mutable Console encoding properties
and overload-sensitive custom stream constructors in a hidden Windows
PowerShell process. The standalone fixture frames its one authoritative response as a
fixed ASCII marker plus Base64-encoded UTF-8 JSON. This keeps incidental module
or host output from corrupting the protocol while duplicate, absent, malformed,
or non-UTF-8 frames still fail closed without exposing raw privileged output.

In a source checkout the dedicated npm command runs one opt-in Vitest real-host
spec, and Vitest owns test reporting and failure stacks. The spec remains
skipped in ordinary test runs. Before that spec, the command performs only the
isolated library compile and fixture-only PowerShell parse; X11 MCP, Device Lab
MCP, and the generic full-project build are outside this test boundary.
Extracted packages retain the prebuilt launcher
as a fallback because test-framework devDependencies are deliberately absent.
On Windows the command compiles, parses, and bundles the privileged scenario
before checking its token through the absolute System32 Windows PowerShell
executable. A filtered token keeps Vitest at medium integrity and causes one
`Start-Process -Verb RunAs` request for a narrow privileged host. The parent
waits, compacts the authenticated result into bounded Vitest input, and
propagates failure. Cancellation and launch failure stay red instead of being
mistaken for a platform skip.
The outer, non-elevated PowerShell receives only a short fixed encoded bootstrap
on its command line. Its Base64 JSON launch envelope, including the separately
encoded elevated host, is written to redirected stdin. This avoids multiplying
the large compiled capture helper through nested command-line encodings and keeps
both PowerShell invocations below Windows' command-line ceiling.
The separately built privileged bundle is sent as bytes through the authenticated
duplex pipe with its digest fixed before UAC. Elevated PowerShell atomically
creates an inheritance-protected SYSTEM/Administrators staging directory under
ProgramData, verifies its exact DACL and non-reparse identity, writes the bundle,
copies the currently running Node executable, verifies both pre-UAC SHA-256
digests, and executes only those protected copies. The bundle embeds the two
integrity-pinned PowerShell assets and the compiled typed library; no privileged
process imports code or helpers from the writable checkout.
The elevated host creates and verifies this protected staging root before
compiling its embedded bounded-process helper with `Add-Type`, and immediately
redirects its own TEMP/TMP there. This closes the Windows PowerShell 5.1 CodeDom
temporary-file race at the UAC boundary, not only the later Node environment.
Because Windows PowerShell 5.1 CodeDom can leave generated files behind, the
host enumerates only canonical descendants of this exact protected root, uses
explicit top-directory-only traversal, rejects every reparse point before
enqueueing a directory, removes entries deepest-first, and deletes the root
before publishing success. A cleanup failure therefore remains a failed
privileged transaction rather than contradicting an already-published result.
Before starting the protected Node copy, the native host clears
`ProcessStartInfo.EnvironmentVariables`, then derives SystemRoot/WINDIR,
SystemDrive, machine name, an absolute System32 COMSPEC, a trusted-system-only
PATH, a fixed `.COM;.EXE;.BAT;.CMD` PATHEXT, and a System32-only PSModulePath,
ProgramData, protected-root TEMP/TMP, and deterministic color values from the
elevated OS context. It sets the working directory to the protected root. The
fixed PATHEXT is required for Windows PowerShell 5.1 to activate the absolute
System32 `icacls.exe` inside a pipeline as an executable rather than a document.
This supplies the Windows process context needed by Hyper-V
without copying caller values and prevents inherited
`NODE_OPTIONS`, `NODE_PATH`, compile-cache, coverage, or REPL hooks from loading
medium-integrity code before the bundle entrypoint.
Fixture create/attach calls use direct command-local `try/catch` blocks to
translate localized native failures into bounded stage codes before framing
them. The integrity-label tool invocation has its own bounded stage code as
well. Diagnostics can distinguish fixture protection, VM creation, VM
configuration, default-DVD removal, VHD creation, and attachment failures
without disclosing privileged stdout, exception text, or host paths.
The fixture's outer catch forwards only a literal declared-code set. Any
unwrapped exception is reduced to a fixed operation-level fallback, so a
localized but regex-shaped message or fully-qualified error identifier cannot
cross the boundary.
The shared launcher guards its direct-execution block with both URL equality and
the original leaf filename. Esbuild therefore cannot make the imported launcher
mistake the privileged bundle for its own CLI entry; the bundle has one scenario
owner and emits one privileged result frame.
The elevated child sends bounded line-framed output and its final status through
a random per-run named pipe authenticated by a separate random token. This
preserves Vitest reporting in the invoking terminal without trusting PowerShell's
CLIXML progress stream or creating an elevated result file in a user-writable
temporary directory.
Authentication is client-first: the parent does not disclose the privileged
bundle until a bounded AUTH frame proves possession of the token. Invalid
clients are discarded without claiming the sole authenticated slot. The parent
tracks all accepted sockets, destroys them when the launcher finishes, and
bounds server shutdown to prevent a racing client from holding the command open.
The elevated PowerShell host and Node subtree are placed in nested Windows Job
Objects configured with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; a native watchdog
also contains pre/post-child host stalls. The host starts Node through `ProcessStartInfo` with
separate UTF-8 stdout and stderr readers. Two concurrent fixed-size reads share
one 16 MiB counter; overflow kills the child before any additional bytes are
retained, and neither stream is materialized with `ReadToEnd`. Native stderr is
therefore bounded test output, not a terminating PowerShell error, and a nonzero
scenario exit remains a framed child result. Termination and stream waits are
bounded, and incomplete closure is a distinct failure rather than a cleanup claim.
Before even connecting to the pipe, the elevated host starts a separate trusted
System32 PowerShell watchdog with a cleared environment and a fixed numeric PID
target. It kills the elevated host if staging or `Add-Type` stalls, then is
terminated once Job Object containment and the native watchdog are active.
The watchdog validates the target start time and forces the target handle open
before its bounded `WaitForExit`; it never sleeps and then reacquires a PID that
could have been reused by an unrelated process.
To stay below Windows' command-line ceiling, the full elevated host is gzip
embedded in a short bootstrap; that bootstrap arms the watchdog before it
decompresses and executes the bounded trusted source.
On the parent side, launcher exit starts a bounded settlement window rather than
immediate socket destruction; the authenticated terminal frame and EOF must both
arrive before success is evaluated.

The fixture filesystem root is placed under a dedicated `%ProgramData%`
directory with SYSTEM/Administrators-only inheritance and a High mandatory
integrity label. Protection replaces the DACL with exactly those two full-control
rules and rechecks both DACL and label, so unrelated explicit ACEs cannot survive.
The mandatory label is verified through the Win32
`LABEL_SECURITY_INFORMATION` query and converted to bounded SDDL. Default and
audit-mode `Get-Acl` views do not reliably expose this distinct label query.
Hyper-V can add a VM-specific explicit ACE to the fixture root while a VHD is
attached. Cleanup therefore requires the parent to remain exact and the root to
remain non-reparse, inheritance-protected, and High integrity while it validates
marker, contents, VM identity, and attachment containment. Only after confirmed
VM removal does it replace and revalidate the root's exact DACL, before the first
file deletion.
An existing exact parent is accepted only when already protected; it is never
repaired by path. Initial creation protects an unpredictable sibling and uses an
atomic directory move, with collisions failing closed.
The fixture rechecks that protected, non-reparse boundary at
attachment setup and immediately before deletion. This prevents a
medium-integrity process for the invoking user from rebinding an elevated
cleanup path through a junction while Hyper-V removal is in progress.

Interrupted PowerShell execution is not treated as stopped merely because a
kill was requested. The runner captures the process start identity, rechecks it
before PID-based tree termination, validates `taskkill`, and waits a bounded
grace period for child closure. If tree termination cannot be proven, the run
fails and deliberately preserves the fixture rather than racing cleanup
against a still-running privileged mutation. PowerShell and `taskkill` are
started only through absolute Windows-system paths derived from the kernel
`GLOBALROOT\SystemRoot` alias rather than environment variables, excluding PATH/current-directory
binary substitution in an elevated test process.
Each independent PowerShell invocation also imports the absolute system Hyper-V
manifest, verifies the loaded manifest path, and uses `Hyper-V\<cmdlet>` names;
the preflight process is not assumed to establish module state for later calls.
Windows installations may place that manifest directly under the Hyper-V
module root or under a numeric version directory. The resolver accepts both
layouts while remaining under the protected System32 root, rejecting reparse
entries and non-version children, selecting the highest version, and verifying
the imported module base.

## Alternatives considered

### Rename or move `src/host-control/hyper-v`

Rejected. It is a small mechanical change but preserves CCC identity fields,
single-disk observations, generated-command shapes, and combined deletion
policy as if they were generic APIs. Package extraction would remain coupled to
Device Lab.

### Add interfaces without migrating a production path

Rejected. A type-only facade would not prove execution, error, attachment, or
journal semantics and would not fix the current zero-disk residue failure.

### Keep lifecycle in Device Lab and extract only low-level

Rejected by product direction. Generic retry and reconciliation are useful to
non-Device-Lab consumers and are explicitly part of the desired future
library. Device Lab persistence and ownership policy still remain outside.

### Reimplement all WMI v2, HCS, and VHD APIs immediately

Deferred. Full coverage would create a large unvalidated surface and delay the
first usable boundary. Native primitives are added incrementally, beginning
with the lifecycle/reconciliation slice that exercises the real defect.

### Publish an npm package immediately

Deferred. Internal-first permits contract refinement and Windows hardware
validation without making unsupported public compatibility promises. Package
metadata and a standalone default transport are follow-up work.

### Preserve the scalar `diskPath` for compatibility

Rejected inside the library. A scalar loses valid zero/many attachment states
and created the current reconciliation bug. Compatibility translation, if
needed for the existing journal, belongs only in the Device Lab adapter.

### Let low-level delete VM artifacts for convenience

Rejected. Combining `Remove-VM` with filesystem/network cleanup expands the
blast radius of a native primitive and imports consumer ownership policy.
Cleanup is an explicit post-removal Device Lab action with its existing path and
symlink fences.

## Consequences

- Consumers can test low-level/native decoding and lifecycle decisions on Linux
  with an injected fake executor.
- Zero disks/DVDs are representable facts, so safe partial residue can settle;
  foreign attachments still fail closed before destructive mutation.
- Typed error categories distinguish caller, transport, protocol, and native
  failures without leaking raw privileged-command data.
- Device Lab keeps its version-1 journal and storage layout; this change needs
  no on-disk migration.
- VM removal and consumer cleanup become separate, observable stages. A failure
  cannot be reported as full reconciliation until the owning layer completes
  its stage.
- Legacy host-control and new library paths coexist temporarily. This is a
  bounded migration seam, not a second permanent architecture.
- The first release surface is intentionally incomplete; additional native
  functionality must be added one primitive at a time with typed contracts and
  fake-executor coverage.
- A future package split moves low-level and lifecycle together. Device Lab's
  adapter, journal implementation, ownership naming, and cleanup remain in this
  repository.
- Real Windows Hyper-V validation is still required. Linux unit/static success
  proves the boundary and decisions, not host compatibility.
- A dedicated compiled-library host test can isolate native transport and
  lifecycle defects from Device Lab, image, guest, and MCP failures while its
  injected seams keep the same scenario mockable on Linux.

## Compatibility and rollback

Existing host-control exports remain for unmigrated callers. The Device Lab
version-1 journal is translated rather than rewritten. There is no runtime
schema cutover and no new persistent ownership authority.

If the migrated reconciliation path must be rolled back, restore its legacy
imports/call path while leaving the journal and persisted Device Lab state
untouched. The new internal modules and assets can then be removed without data
migration. This source-level rollback is sufficient for the bounded vertical
slice; a runtime feature flag is not required.

## Follow-up

After the first reconciliation slice passes focused Linux checks and Windows
hardware validation, migrate additional Hyper-V operations behind the same
boundary. Publish only after the API surface, compatibility/versioning policy,
default Windows transport, package assets, and support matrix are explicit.
