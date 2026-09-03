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

Two related constraints on the session bootstrap follow from the same reasoning.
The reply is joined, not piped through `Out-String`, because `Out-String` formats
to a host width and is free to break a long JSON envelope into lines the reader
would reject as `response-malformed`. And `2>&1` is not used, because merging the
error stream into machine-readable output corrupts it; the session owner drains
stderr separately.

The start budget bounds *consecutive unproductive* starts, not starts over the
process lifetime. A lifetime counter conflates "this host cannot run PowerShell"
with "this broker has been up for days": the third restart, however far apart,
made the pool return `hyper-v-windows-session-unavailable` permanently, which
falls back to one-shot — so the whole feature disappeared with no error anywhere.

The pool is process-scoped and reference-counted. Sessions carry no per-server
state, so two broker servers in one process share them; tearing them down on the
first server's `close` would kill a child the second is mid-request on, and
`hyper-v-windows-session-closed` is deliberately not retryable.

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
