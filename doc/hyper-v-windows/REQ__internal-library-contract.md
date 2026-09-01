---
area: hyper-v-windows
slug: internal-library-contract
status: current
---

# REQ — Internal Hyper-V Windows library contract

## Purpose

`src/hyper-v-windows/` is the package-ready TypeScript boundary between a
Windows Hyper-V host and higher-level consumers. It has two public layers:

```text
Windows Hyper-V
    <-> hyper-v-windows/low-level
        <-> hyper-v-windows/lifecycle
            <-> consumer adapter (Device Lab today)
```

The low-level layer represents native Hyper-V operations and observations
without consumer policy. The lifecycle layer adds generic reconciliation and
bounded retry behavior. Both layers are one future extraction unit. Device Lab
is a consumer and MUST remain outside that unit.

This requirement defines the first supported vertical slice. It is not a claim
of complete WMI v2, HCS, VHD, networking, image, snapshot, or guest-management
coverage.

## Low-level operation contract

The initial low-level client MUST provide typed counterparts for these native
Hyper-V operations:

| TypeScript operation | Native primitive | Result |
|---|---|---|
| get VM | `Get-VM` | exact VM result array |
| get VM hard disks | `Get-VMHardDiskDrive` | exact hard-disk result array |
| get VM DVD drives | `Get-VMDvdDrive` | exact DVD-drive result array |
| start VM | `Start-VM` | typed success result |
| stop VM | `Stop-VM` | typed success result |
| remove VM | `Remove-VM` | typed success/void; VM only |

Each low-level call MUST validate one typed request, make exactly one transport
attempt, strictly decode its bounded response, and then return or throw. The
PowerShell transport resolves an ID/name selector with one `Get-VM` read and,
for operations other than `Get-VM`, invokes exactly one requested target
primitive. It MUST NOT
silently retry, poll for a desired state, translate
an owner identity, reconcile a journal, delete a disk or ISO, release a network,
or mutate Device Lab state.

Selector absence is valid only when a successful `Get-VM -ErrorAction Stop`
enumeration followed by exact ID/name filtering returns zero records. Missing
cmdlets/modules, host-service failures, permission errors, and other
`ObjectNotFound` errors MUST propagate as native failure; they MUST NOT be
converted to VM absence.

The trusted Hyper-V module manifest MAY be installed directly at the protected
System32 `Modules\Hyper-V` root or beneath a numeric version directory such as
`2.0.0.0`. Resolution MUST remain inside that exact system root, accept only a
direct manifest or non-reparse numeric-version child, choose the highest
version deterministically, and verify the imported module base. It MUST NOT
fall back to PATH, `PSModulePath`, or an arbitrary discovered module.

Selectors and operation options MUST model native identity and parameter-set
semantics, such as VM ID or VM name. Consumer identifiers such as `ownerId`,
`deviceId`, `incarnationId`, backend name, MCP command, HTTP status, or a CCC
filesystem layout MUST NOT appear in a low-level public type.

The executor/transport is injected. It owns process execution, timeout,
cancellation, output-size enforcement, and process-tree cleanup. A low-level
client normalizes the executor's result; it does not expose shell argument
arrays, broker `ProviderCommand`, raw parser helpers, or CCC command-runner
options as its public API.

The package-owned PowerShell asset MUST be read and digest-verified once, and
the exact verified source plus JSON request MUST be wrapped by the exported,
bounded in-memory execution-envelope helper. Consumers such as the Device Lab
adapter MUST invoke the exported fixed bootstrap with `-Command`; they MUST NOT
reopen the verified asset with `-File` or send the operation JSON directly to a
script that expects the in-memory envelope.

The fixed bootstrap MUST pass its UTF-8 JSON envelope as Base64 ASCII over the
existing redirected Console streams. It MUST NOT depend on mutable Console
encoding properties or overload-sensitive custom stream construction.
Standalone privileged fixture responses MUST use one
fixed ASCII marker followed by Base64 of UTF-8 JSON rather than assuming all
stdout is one JSON document. The decoder MAY ignore other bounded stdout lines,
but it MUST require exactly one marker and reject invalid Base64, invalid UTF-8,
or malformed JSON without returning raw privileged output in an error.

The repository real-host command MUST execute this scenario as an opt-in
Vitest spec so assertion failures, timing, filtering, and output use the normal
test framework. General Vitest runs MUST skip the privileged scenario unless
the dedicated command enables it. The command MUST compile only the isolated
Hyper-V Windows library and parse only its fixture before Vitest; it MUST NOT
run the generic full-project build. An extracted installed package MAY retain a
prebuilt no-devDependency launcher fallback because Vitest is not a runtime
dependency.

### Native-fidelity rules

- A native collection is always represented as a readonly array. Absence of
  members is an empty array, never a missing property, `null`, or a synthesized
  scalar.
- In particular, a VM with no hard disks has `hardDiskDrives: []`, and a VM
  with no DVD drives has `dvdDrives: []`. Both are valid observations.
- One or many attachments are preserved in native order with one typed record
  per result. The API MUST NOT collapse them to `diskPath`, the first drive, or
  an inferred base VHD.
- A drive with no mounted path preserves that native fact as `path: null`; the
  drive itself is not omitted. An empty DVD drive is safe. A pathless hard-disk
  record (including a pass-through physical disk identified by `diskNumber`)
  is an attachment conflict until a future explicit physical-disk allowlist
  proves ownership.
- Required identifiers and structural fields are validated. Unknown native
  state, status, controller, and checkpoint strings are preserved as strings
  rather than coerced into a closed enum or an `Unknown` substitute.
- GUID comparisons are case-insensitive and returned GUIDs use lowercase,
  hyphenated `D` format (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`). Windows path ownership comparisons are
  case-insensitive; display values remain the observed strings.
- `Remove-VM` removes only the VM object. VHD/VHDX/AVHDX files, ISO media,
  credentials, journals, Device Lab inventory, and network allocations are not
  low-level side effects.

## Failure contract

Every low-level failure MUST reject with an exported `HyperVWindowsError` (or
an exported subclass/discriminated equivalent) carrying a stable category and
the attempted native operation. The stable categories are:

| Category | Meaning | Retry implication |
|---|---|---|
| `validation` | Caller request is invalid or unsafe | terminal; executor was not called |
| `transport` | Executor could not complete, including spawn, timeout, or cancellation | lifecycle may retry only under an explicit bounded policy |
| `protocol` | Output is missing, oversized, malformed, ambiguous, or structurally invalid | terminal/fail closed |
| `native` | Hyper-V/PowerShell completed with an operation failure | preserve native bounded code; policy remains above low-level |

Error objects MUST expose enough bounded context to identify the operation and
category. They MUST NOT expose credentials, request stdin, generated command
text, unbounded stdout/stderr, or unrestricted host paths. Oversized or malformed
native output is a protocol failure, never a partial success. A timeout or abort
is a transport failure, never an inferred native result.

## Lifecycle contract

The lifecycle layer consumes low-level observations and generic expectations.
It MAY provide composite inspection, reconciliation, journal-store ports, a
clock, and bounded retry. It MUST NOT import Device Lab, its broker, MCP/HTTP
contracts, or CCC ownership helpers.

A generic VM expectation contains native identity (`id`, `name`, and optional
exact `notes`) plus an explicit attachment allowlist and/or allowed roots. A
lifecycle intent describes the desired VM operation/state without using
`device_*` command names. The first slice does not persist intents and therefore
does not expose an unused store port. If persistence later moves into the
library, it MUST use a generic injected store interface; the library MUST NOT
choose a filename, root directory, JSON version, or owner partition.

Reconciliation returns a discriminated outcome. The first slice MUST distinguish:

| Outcome | Required meaning | Mutation/retry rule |
|---|---|---|
| `settled` | exact identity, safe attachments, and the terminal state for the intent | caller may commit state and clear its journal |
| `pending` / `transitioning` | identity is safe but native state is transitional or not yet terminal, including an unknown state string | preserve journal; retry only within explicit bounds |
| `absent` | no matching VM exists | remove is idempotently settled; non-remove remains explicit and does not fabricate success |
| `identity-conflict` | duplicate, mismatched ID/name, or mismatched expected Notes prevents unique identity proof | terminal; preserve journal; do not mutate |
| `attachment-conflict` | at least one observed disk or mounted DVD is outside the explicit allowed paths/roots | terminal; preserve journal; do not mutate |

Attachment validation is an observed-subset safety fence. Every observed
hard-disk path and mounted DVD path MUST be inside the expectation's explicit
allowed set or a root allowlist for that attachment kind. A hard-disk root
MUST NOT implicitly authorize DVD media, and a DVD root MUST NOT implicitly
authorize hard disks. Expected attachments are not required to be
present: zero attachments is safe partial residue after identity has been
proven. The settled outcome SHOULD expose that expected attachments are missing
as drift/diagnostic data, but missing expected media MUST NOT be reclassified as
an ownership conflict.

Consequently, each of these is normative:

- exact identity + `hardDiskDrives: []` + `dvdDrives: []` + terminal state
  reconciles as `settled`, possibly with expected-missing drift;
- any foreign disk or mounted DVD reconciles as `attachment-conflict`;
- any pathless hard disk reconciles as `attachment-conflict`; a bounded
  `diskNumber` MAY be retained for diagnostics, but never authorizes removal;
- an unknown/transitional state preserves its raw string and reconciles as
  `pending`/`transitioning`;
- an absent VM satisfies a remove intent without calling `Remove-VM` again;
- destructive removal may occur only after unique identity and attachment
  safety are proven;
- if lookup by expected ID is absent, the Device Lab consuming layer MUST query
  the exact expected VM name before treating remove as settled; any same-name VM
  with a different ID is an identity conflict and preserves all cleanup state;
- low-level/native uncertainty never causes journal clearing or destructive
  consumer cleanup.

Retry MUST have explicit bounds (attempt count and/or deadline), respect
cancellation, stop on settled and terminal conflict outcomes, and use an
injected clock/sleeper where needed for deterministic tests. No implicit
infinite loop is permitted. A consuming adapter that supplies a shared deadline
MUST recompute the remaining timeout for every low-level invocation rather than
reusing a timeout captured before a multi-step reconciliation.

## Device Lab consuming boundary

The Device Lab consuming layer (the dedicated adapter plus broker orchestration)
is the sole translator between current CCC policy and the generic library. It
owns:

- `ownerId`, `deviceId`, `incarnationId`, backend names, the CCC VM name and
  Notes marker;
- the version-1 `operation.json` schema, operation IDs, journal path, and
  atomic persistence;
- translation from `device_start`, `device_stop`, `device_reboot`, and
  `device_delete` to generic lifecycle intents;
- owner/device state mutation, public MCP/HTTP status and error mapping;
- allowed device artifact roots and expected `root.vhdx`, differencing disks,
  and provisioning media;
- post-removal network release and guarded artifact cleanup.

The adapter module owns journal-command/expectation translation and creation of
the injected executor/client. Its broker command bridge uses the library's
fixed in-memory bootstrap and bounded envelope helper, keeping the production
consumer on the same transport contract as the standalone real-host proof.
Broker orchestration retains journal persistence,
state/public-error mutation, network release, and guarded artifact cleanup. The
Device Lab consuming layer MUST preserve the existing on-disk journal schema;
no migration is required for this slice. Broker orchestration MUST clear that
journal only after a typed settled outcome and the current Device Lab completion
rules. Pending, transport, protocol, native, identity-conflict, and
attachment-conflict paths preserve it.

For recovery from a stable terminal-state mismatch, broker orchestration MAY
invoke the lifecycle outcome's single typed `start` or `stop` action, then MUST
re-inspect under the same bounded deadline. It clears the journal only if that
fresh outcome is `settled`; a still-pending or conflicting outcome preserves it.

Delete remains split. The library validates identity/attachments and invokes
low-level `Remove-VM`; only after that succeeds (or absence is idempotently
settled) may Device Lab run its existing path-contained artifact and network
cleanup. Neither lifecycle nor low-level knows the Device Lab artifact layout.

## Import and extraction constraints

`src/hyper-v-windows/**` MAY import Node standard-library modules and its own
subtree. It MUST NOT import `device-lab*`, `device-lab-broker`, MCP routes,
broker state, or legacy CCC ownership contracts. The lifecycle layer may import
the low-level layer; the reverse dependency is forbidden.

The internal root entrypoint MUST deliberately export the supported low-level
and lifecycle APIs, and declaration generation MUST include them. Consumers
MUST import the root or the `low-level/index` / `lifecycle/index` layer
entrypoints and MUST NOT deep-import private parser, PowerShell framing, or
transport implementation modules.
The future package split MUST be possible by moving low-level and lifecycle
together and adding package metadata/default Windows transport, without moving
Device Lab policy.

## Verification cues

Linux-runnable fake-executor tests MUST prove at least:

1. each public low-level call makes one transport attempt, performs only the
   documented selector-resolution read plus its single target primitive, and
   maps parameters without artifact deletion;
2. zero, one, and multiple disks/DVDs decode as exact arrays, including a DVD
   drive whose path is `null`;
3. unknown native strings survive decoding;
4. invalid requests make no executor call;
5. malformed/oversized/ambiguous output, native failure, executor failure,
   timeout, and cancellation produce the correct typed category;
6. stable Running/Off terminal states settle with zero attachments;
7. transitional/unknown states remain pending;
8. a foreign disk or DVD conflicts and prevents `Remove-VM`;
9. absent remove is idempotently settled;
10. bounded retry stops on success, cancellation, terminal conflict, and its
    configured limit;
11. the Device Lab version-1 journal translates without an on-disk change;
12. a broker regression clears/reconciles stable zero-disk residue, while a
    foreign attachment preserves the journal and prevents cleanup.

Static boundary tests MUST reject forbidden import direction and Device
Lab-specific public terminology under `src/hyper-v-windows/`. Typecheck/build
MUST emit declarations through the internal entrypoint. Integrity checks MUST
cover any package-owned PowerShell asset and its manifest digest.

Real Windows Hyper-V execution remains the hardware proof and MUST be reported
as environment-gated when unavailable; Linux fake-executor success is not a
claim that the Windows E2E passed.

## Standalone real-host verification contract

The package MUST provide one discoverable real-host command that validates the
compiled public `dist/hyper-v-windows/index.js` boundary without starting or
importing Device Lab, its broker, MCP, image acquisition, networking, or guest
setup. The command MUST build the isolated library when source/build inputs are
present and use the packaged compiled boundary when they are absent. Non-Windows
hosts MUST report an explicit skip. A Windows host with a
missing Hyper-V module, required cmdlet, elevation, or running VMMS service MUST
fail preflight rather than report a skip or fabricate absence.
When the standalone command starts with a filtered non-administrator token, it
MUST keep Vitest under that token, request UAC once, and wait for a narrow
privileged scenario runner.
The elevation launcher MUST use the absolute System32 Windows PowerShell path,
pass values inside encoded payloads rather than interpolated command text, and propagate
the elevated exit status and bounded test output through an authenticated,
per-run local named pipe. It MUST NOT rely on CLIXML progress output or a
user-writable temporary result file. UAC cancellation or launcher failure MUST
remain an explicit test failure. An already elevated invocation MUST not prompt.
Early pipe closure, including while PROGRAM bytes are being written, MUST be
handled as a bounded transport failure and MUST NOT escape as an unhandled Node
Socket error. The native watchdog, rather than an unsupported pipe stream
`ReadTimeout` property, bounds a connected client that stops reading.
Compilation, asset validation, and privileged-scenario bundling MUST finish
before UAC. The elevated process MUST receive the bounded self-contained bundle
as bytes, verify the pre-UAC SHA-256 digest, materialize it and a digest-matched
copy of the already-running Node executable only inside a non-reparse,
inheritance-protected SYSTEM/Administrators directory, and MUST NOT reopen
checkout JavaScript, TypeScript, PowerShell, test, or helper files.
Before elevated Windows PowerShell invokes `Add-Type`, it MUST create and verify
that protected non-reparse staging directory and set its own `TEMP` and `TMP` to
the directory. CodeDom compilation MUST NOT use the inherited user-writable
temporary directory.
CodeDom may leave generated descendants in that directory. Cleanup MUST verify
every descendant remains inside the canonical staging root, reject reparse
points before descending, traverse with explicit top-directory-only enumeration,
delete deepest-first without recursive-follow behavior, and finish
before sending the authoritative stdout/stderr/result frames.
The elevated Node process MUST NOT inherit caller environment variables. Its
environment MUST be cleared and rebuilt from a fixed allowlist containing only
trusted Windows roots, OS-derived `SystemDrive`/machine identity, an absolute
System32 `COMSPEC`, a `PATH` limited to System32/Windows PowerShell/Wbem, a
fixed executable-only `PATHEXT` (`.COM;.EXE;.BAT;.CMD`), a System32-only
`PSModulePath`, ProgramData, the protected staging directory as
`TEMP`/`TMP`, and deterministic color controls. Its working directory MUST be
the protected staging directory. None of these values may be copied from the
medium-integrity caller. Node startup/configuration variables such as
`NODE_OPTIONS`, `NODE_PATH`, `NODE_REPL_EXTERNAL_MODULE`, `NODE_COMPILE_CACHE`,
and `NODE_V8_COVERAGE` MUST therefore be absent.
Native fixture command failures MUST cross the privileged boundary only as
bounded operation-stage codes (for example `new-vm-failed` or
`new-vhd-failed`), never as localized exception messages, raw output, or paths.
The final fixture catch MUST forward only explicitly declared stable codes;
every other exception becomes a fixed preflight/create/attach/cleanup fallback.
The elevated host MUST consume stdout and stderr incrementally with fixed-size
buffers under one combined byte limit. It MUST terminate the child immediately
when that limit is exceeded and MUST NOT first materialize either unbounded
stream with `ReadToEnd` or an equivalent API.
The elevated PowerShell process and its Node subtree MUST be contained by
kill-on-close Windows Job Objects. Timeout, output overflow, watchdog expiry,
or host exit MUST terminate descendants; post-termination waits MUST be bounded,
and failure to confirm the direct child and stream closure MUST surface as
`elevation-termination-unconfirmed`.
Before pipe connection, staging, decompression, or `Add-Type`, the elevated host
MUST start an independent trusted bootstrap watchdog that force-terminates it
within the outer bound. After native Job Object containment and the in-process
watchdog are armed, the bootstrap watchdog MUST be terminated and disposed.
The bootstrap watchdog MUST capture the target start identity and process handle
before waiting; it MUST NOT reacquire a numeric PID after the delay.
The pipe server MUST withhold PROGRAM bytes until the elevated client sends a
bounded token-authentication frame. Unauthenticated connections MUST be closed
without consuming the authenticated slot. Every accepted socket MUST be tracked
and destroyed when the launcher finishes, and server shutdown MUST have a fixed
upper bound.
Launcher completion MUST NOT immediately destroy an authenticated result socket.
The parent MUST wait within a fixed bound for a terminal frame and authenticated
socket EOF, then fail explicitly if settlement is not observed.
The non-elevated launcher command line MUST remain below the Windows process
command-line limit even when the elevated host contains compiled helper source.
Its variable launch envelope MUST travel over redirected stdin, and bundle bytes
MUST travel over the authenticated pipe; only fixed, path-independent
bootstraps and digest-bound metadata may be passed with `-EncodedCommand`.
The installed command MUST execute compiled JavaScript compatible with the
package's minimum supported Node version; it MUST NOT rely on runtime TypeScript
stripping or a source loader.
Bundling an imported real-host launcher MUST NOT activate that launcher's
direct-execution branch. Main-module detection MUST be tied to the original leaf
entry identity so the privileged bundle executes exactly one scenario.

The real-host fixture MUST be disposable and unbootable by design: a unique
Generation 2, `NoVHD` VM with no network switch. Fixture PowerShell may create
the VM, VHDX files, and empty DVD drives. Fixture safety checks may read native
identity and attachments only to fence setup/teardown; all verification reads
plus Start, forced Stop, lifecycle reconciliation, and Remove assertions MUST
flow through the compiled public library. The proof MUST cover exact empty and
multiple hard-disk/DVD collections, state convergence, safe and conflicting
expectations, exact ID/name absence after removal, and VHDX retention after
`Remove-VM`.

Fixture cleanup is part of the verdict. The real fixture root MUST live under
the exact test-only `%ProgramData%` parent, not a user-writable temporary
directory. The parent MUST reject reparse points and grant full control only to
SYSTEM and Administrators through a protected exact DACL. The per-run root MUST
start with that same exact DACL and MUST remain non-reparse, inheritance-protected,
and High integrity. Hyper-V MAY add explicit runtime ACEs while attachments
exist; after the exact VM is removed, cleanup MUST replace the root DACL with the
exact SYSTEM/Administrators rules and revalidate it before deleting any file.
Merely adding replacement grants while retaining unrelated explicit ACEs is not
sufficient. An
integrity-label check MUST query `LABEL_SECURITY_INFORMATION` explicitly and
free every native security-descriptor allocation; neither default `Get-Acl`
nor its audit-SACL view is evidence that the label is absent. An
existing parent that lacks those protections MUST be refused, never repaired in
place. First creation MUST protect an unpredictable sibling and atomically move
it to the exact parent name; a destination collision MUST fail closed. An
existing VM may be removed only
after exact ID, Name, Notes, marker-token, and fixture-root containment checks
succeed. A missing ID is safe only when the exact Name is also absent. A
pathless hard disk, attachment outside the fixture root, identity disagreement,
or marker mismatch MUST refuse deletion and preserve evidence. Empty DVD paths
are permitted. No prefix scan or broad cleanup is allowed, and cleanup failure
MUST fail an otherwise successful test.
The packaged fixture script MUST be SHA-256 pinned. The exact bytes that passed
the digest check MUST be delivered to PowerShell as an in-memory script through
stdin; PowerShell MUST NOT reopen the mutable package path after verification.
The production operation asset follows the same rule. A partial create failure MUST preserve evidence and defer to
the same guarded cleanup operation; it MUST NOT run a weaker rollback deletion
path.

The Node-to-PowerShell runner used by this command MUST accept JSON through
stdin, bound combined output and time, honor cancellation, and terminate the
child process tree on timeout, cancellation, or output overflow. PID-based tree
termination MUST be gated by a captured process-start identity, its result and
child close MUST be confirmed within a bounded grace period, and unconfirmed
termination MUST prevent fixture cleanup. Privileged PowerShell and tree-kill
executables MUST be absolute paths resolved below the Windows system directory;
the production resolver MUST obtain the actual system root through Windows'
kernel `GLOBALROOT\SystemRoot` alias rather than caller-controlled environment
variables. PATH or current-directory executable lookup is forbidden. Every PowerShell
process MUST import and verify the absolute system Hyper-V module and invoke
Hyper-V cmdlets with module qualification; preflight state does not carry into
later processes. A nonzero
native process status with a valid bounded JSON envelope MUST remain visible to
the low-level decoder; only spawn failure is represented as a transport error.
Its process and orchestration seams MUST remain injectable so Linux unit tests
can prove ordering, interruption, cleanup, and false-pass prevention without a
Hyper-V host.
