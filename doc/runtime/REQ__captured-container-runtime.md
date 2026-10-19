# Captured native container runtime

An owned ordinary container operation captures its native runtime invocation before inspecting its target or reserving a session. Inspection, startup, setup, validation and compensation, command execution, host cleanup and guardian cleanup must use that invocation. Changing ambient environment, executable search path, default context or the selected connection alias afterwards must not redirect these actions.

The capture retains an absolute executable, resolved transport and finite environment selectors, with explicit absent values. Docker retains the actual host and TLS verification, CA/client certificate/key references and configuration directory; Podman retains explicit local storage mode, observed storage options and transient-store selection, or remote URL, identity, native machine mode and TLS references. A local Podman operation does not require or enable an API socket service. Capability and socket-mount compatibility data is distinct from execution authority. Credential-file contents and the whole process environment are not serialized into the guardian record; selected proxy values and endpoint userinfo can still be sensitive and remain private and nonlogged.

Executable capture follows native Node dispatch. On Windows, permitted current-directory lookup precedes PATH, only `.com` then `.exe` are tried, and PATHEXT does not change that order. The existing current-directory suppression setting and explicit quoted or relative PATH entries retain their meaning. Later dispatch uses the captured absolute program.

Docker configuration-directory selection follows the native CLI: explicit DOCKER_CONFIG wins; otherwise Windows uses USERPROFILE and Unix uses HOME with the native home fallback. Windows HOME must not override USERPROFILE. Relative selections are resolved at capture time.

The native record is a versioned, closed, bounded readonly value. Native flags are derived from its validated transport fields. Invalid, unsupported, oversized or incomplete capture fails before claim acquisition or native dispatch and must permit a fresh attempt without publishing a half-cache. Child environment overlays preserve non-transport options, remove newly introduced selectors that were absent at capture, and never mutate process.env or caller options. Native execution uses separate program/arguments and does not enable a shell. Remote Podman replay reconstructs a single private native connection entry from captured facts, preserving machine and TLS semantics without consulting a mutable user alias. Each native spawn owns and settles its temporary metadata; user configuration and credential contents are neither copied nor modified.

Prepared start/initialize operations and process-event cleanup callbacks retain their binding after the original preparation scope returns. Guardian initialization snapshots and validates the invocation before acknowledging it. Container ID and cleanup permission remain subject to existing acknowledgement, revocation, receipt and settlement rules. Failed cleanup retains its receipt and reuses the same invocation on retry; it cannot redetect a default runtime or connection.

Project/profile claim names, family/lifecycle/setup guards, shared-device ownership and conservative unknown/legacy peer vetoes remain global. Runtime names, endpoints and their hashes are not proof of independent backends. Independent-engine claim retirement and separate container/device cleanup vetoes are subsequent architecture work and are not accepted by this requirement alone.

## Derived global bind-user admission

The following rules are derived from this requirement's captured native authority
and global ownership rules, and from the preservation behavior in
[the home layout requirement](../common/REQ__ccc-home-layout.md). They are
implementation decisions recorded in the global-bind-user-authority task plan,
not additional user-prescribed record formats.

Global home mutation and automatic clipboard retirement must account for retained
native authorities and their running and stopped containers. An empty inventory
in the currently selected context does not establish global absence. Retain the
validated invocation before controlled protected-bind creation, restart or helper
dispatch; session retirement does not erase it.

Coverage is complete only for an exclusively created and revalidated fresh home
whose participating writers have retained authority. Existing homes, missing or
invalid history and receiving-host remote writes with no captured authority remain
incomplete. Unknown coverage or inventory preserves existing shared state.

Before fresh native creation or a disposable bind helper, retain an owned pending
effect. Client timeout or death does not prove that the engine stopped creating.
Only that operation's positive settlement clears its pending effect; later
successful work cannot erase earlier uncertainty. This is bounded coverage state,
not an event journal.

Final admission and the protected effect share the existing global state guard.
Qualified reads must still name the same root and history at the effect. Native
inventory uses a finite total deadline and exact full container IDs. Retained
invocations may contain sensitive proxy selectors or endpoint userinfo: keep
records private, bounded and nonlogged; do not copy credential-file contents.

An HTTP shutdown response or elapsed grace interval alone does not prove daemon
exit or settlement of its shared-file writer. A current clipboard daemon may
acknowledge irreversible writer retirement under the guard; legacy or unhealthy
peers without a positive witness defer automatic replacement. Direct publication
and parent-owned launch must use the same admission ownership without reentry.

Normal clipboard retirement leaves a strictly decoded terminal state on the
existing port-file inode, so a later admitted start can proceed without contacting
an already retired daemon. Capture the exact file identity and contents at
publication; matching port/token on a replacement inode is insufficient. Seal
pending publication, close the listener, perform the one-shot terminal write
under qualified global ownership, and relinquish every future port write before
acknowledging settlement. A coordinator persists acknowledged retirement against
its pre-acknowledgement receipt before any later launch failure can intervene.
Terminal state never supplies bind-user or session admission. Unknown suffixes,
partial records and legacy colon-bearing tokens do not establish retirement;
terminal records are never active clipboard selections. Forced crash or a signal
that cannot safely settle leaves uncertainty; it does not prevent process exit.
The terminal grammar has a distinct `retired-v1:` prefix so a legacy token that
contains colons cannot masquerade as retirement. Write or flush failure returns
failure, permits no acknowledgement or immediate replacement, and consumes the
terminal writer. Incomplete bytes remain unknown; a later fresh guarded read may
recognize a complete truthful terminal record, without claiming a failed flush
persisted it. Initial active publication requires a successful flush before
commit. A parent-published child cannot acknowledge retirement before receiving
its exact commit receipt and thereby settling the parent's pending publisher.

Initial IPC publication has a monotonic deadline. A precommit timeout or parent
disconnect seals publication authority; delayed `ready` or commit messages cannot
restore it. A synchronous write begun before expiry may finish late, but the
parent sends no commit receipt after expiry and grants no terminal writer.
Verify this with delayed messages after timeout/disconnect and a queued `ready`
handled after its deadline, before the timer callback can run.

Verification uses actual emitted entrypoints and owned fake native executables: capture A, alter ambient selection to B before ordinary phases and guardian EOF, and observe that effects and retries stay on A, including prepared callbacks invoked outside capture scope. The normal test command must run these witnesses against repository dist without a private opt-in; an explicit absolute distribution override remains available for isolated and original-control graphs. Cover Docker TLS references, Podman local/remote selection, executable/environment changes, concurrent bindings, native failures, invalid records, revocation and peer receipt preservation. These fixtures do not certify real Windows/macOS providers or installed delivery.

The binding freezes requested native authority and references. It does not snapshot DNS, SSH configuration/agents, referenced container configuration contents (including namespace and volume policy), certificate/key contents or a physical daemon replaced at the same endpoint. No new credential copy, provider interface, lifecycle framework, hosted CI, global install or OpenCode support is introduced.
