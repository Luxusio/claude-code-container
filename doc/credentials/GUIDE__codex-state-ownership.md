# Codex retained-state ownership migration

`prepareCodexStateOwnership` remains the synchronous public compatibility entry.
Its application factory owns the whole retained-state migration decision: selected
profile root, host mapping gates, previous managed bind provenance, immutable old
image account observation, complete ancestor trust, active bind overlap refusal,
second root identity validation, and final fixed native helper dispatch.

The domain contains structural facts and receipts. Ports expose synchronous
observations and one fixed ownership effect; they have no Docker argv, filesystem
API, runtime defaults, or asynchronous effects. Production binds those primitives
in `src/codex-state-ownership.ts`. The public previous-container argument, identity and proof callback retain their
original references. Only after supported host-mapping admission does native
composition observe prior mounts/image and decode old UID:GID, active-container
IDs and inspected mounts into semantic facts. Raw JSON and account text never
reach the inward migration decision. Getter/native failures propagate unchanged.
Incomplete prior mounts, including sparse array slots alone or beside a managed
bind, refuse migration before ownership effects. Every index is decoded in
ascending order; an explicitly valid empty mount list remains a no-op. Native directory objects and principal rechecks keep their
existing identity and lazy getter behavior.

`startProjectContainer` continues to own `codex-state.lock` with its existing
600000 ms wait and no stale-holder reclaim, through preparation and container
start. This extraction acquires no additional lock and changes no caller.
`assertCodexStateAccessible`, used before Codex startup, remains native readiness
support and is not an additional migrated operation.

Its read-only access probe observes a live tree. A descendant may disappear after
enumeration or during an access check; only a proven missing descendant is skipped.
Present inaccessible entries, private ownership mismatches, other filesystem
errors and loss of the state root still fail. Both initial and final root checks
require a directory that is not a symlink. This is no snapshot guarantee and adds
no ownership writes, socket deletion or retries. The contract and regression
anchors are in [Codex state access probe](REQ__codex-state-access-probe.md).

Both Python programs and the checked native runner remain in the facade. The old
image probe has no mounts and uses root with networking disabled. The final helper
uses the normalized current immutable image, root, networking disabled, and one
managed bind to `/state`. Commands retain the 300000 ms timeout, 4 MiB output cap,
UTF-8 options and original error/status/trim behavior.

The Python helper pins descriptors and validates membership and metadata before
and after selective ownership writes. It rejects symlinked roots, filesystem
boundaries, hardlinks, set-ID objects and unsupported entries. It changes only
numeric owners matching the established old image principal. It has no journal,
rollback or automatic retry; a failure after a write can retain partial migration.

Verification anchors are `codex-state-ownership-core.test.ts`,
`codex-state-ownership-facade.test.ts`, and `codex-state-ownership-types.test.ts`
under `src/__tests__/architecture/`, plus the existing actual-facade and private
Python fixtures in `src/__tests__/codex-state-ownership.test.ts`. Core traces cover
short circuits, source proof, account validation, trust and overlap refusal,
replacement and raw failures; facade tests pin actual argv/options and the public
entry. Strict contract tests reject missing, noncallable and asynchronous ports.
The strict architecture TypeScript project checks these inward files and their contracts.

The portable candidate checks on 2026-10-08 completed one full build and fresh
assembly, 139 tests across those three suites, retained-state fixtures and the
boundary guard, and 474 existing Docker/startup/identity caller tests. Actual npm
tar extraction and `materializeUnixInstallPayload` consumers each compared 47
compiled baseline/current cases, including successful single-helper dispatch,
two full ancestor traversals, refusal, getter failures and exact argv/options.
Both consumed declarations with `skipLibCheck: false`; the original public
facade declaration is byte-identical. Their runner is fenced and no live runtime
or user credential store is accessed. Source checks are not an independent
review, QA attestation or full migration completion claim.

## Windows Desktop private-state and control-socket recovery

This is a separate workflow from retained-state migration. The existing
`repairWindowsCodexPrivateState(cli, target): void` remains the Windows-gated
compatibility facade in `src/adapters/windows-credential-access.ts`. It creates
fresh native bindings for `createWindowsCodexRecovery`; this one compatibility
facade imports its application to preserve existing callers, rather than adding
another composition file. Other native adapter code continues to depend outward.

The application owns permission to perform the two fixed recovery effects.
A healthy ownership probe proceeds directly to the socket phase. When repair is
required, it accepts a qualified private-state context and compares each
same-source peer's user with the target's literal decimal UID. Unknown or
different users stop immediately. The private repair completes before the socket
probe; a socket failure can therefore leave the earlier private repair applied.

Only a recognized disconnected socket link enters recovery. That phase obtains
its own fresh native mount/control-directory context, then checks other
same-source containers in order. Any peer that may still serve preserves the
socket and refuses quarantine. Private scans include the target; socket scans
exclude either-direction target-ID prefixes before bulk inspection. Native peer
facts are yielded in inspect order, so a first refusal occurs before later
malformed records are examined. No phase retries or promises rollback.

The port carries finite facts, synchronous iterables, separate opaque contexts
and fixed effects returning `undefined`. Native bindings retain JSON decoding,
Windows source aliases/case, SID and ancestor qualification, account parsing,
commands/options/timeouts, diagnostics and native errors. Validated UID/GID
strings retain leading zeros and their existing range behavior. Python access,
private-state and socket programs remain native with descriptor, membership,
identity, startup-lock, socket re-probe and exact-link quarantine guards.

The new `windows-codex-recovery-core.test.ts`,
`windows-codex-recovery-types.test.ts` and
`windows-codex-recovery-facade.test.ts` under `src/__tests__/architecture/`
cover policy, strict contracts and the retained facade. Existing credential,
probe and retained-state suites stay unchanged. Native facade and outer
`assertCodexStateAccessible` integration require actual Windows; Linux checks
pure policy and the real platform no-op. Code authorship and a Linux pass do not
establish Windows acceptance. This extraction's current review and QA status
lives in the progress overlay and WBS.

On 2026-10-18, the existing reserved Hyper-V guest qualified the outstanding
125 actual-Windows cases: 110 facade and 15 credential cases. The current literal
whole-eight run passed239 with48 existing platform/Python skips; the materialized
emitted-three run passed137 with1 non-Windows skip. The repeated native cases
count once. Fresh strict producers passed; the materialized CLI help, version and
invalid-runtime exits were0/0/1. Source, dependencies and emitted outputs
authenticated, and all known owned processes exited. The earlier interrupted
whole17 remains unqualified. Exact scoped evidence is recorded under
`currentWindowsRecoveryQualification20261018` in the progress overlay. These
fixtures use synthetic native-effect bindings; they prove Windows dispatch and
recovery policy, not live host credential/ACL repair or macOS behavior.

## Known ceiling

Portable tests and private Python fixtures do not prove live Docker or Podman
ownership transfer, daemon bind alias behavior, host ACL or SELinux handling,
macOS or Windows mapping, external writers, termination or crash recovery. Existing
Python access fixtures skip non-root-only checks when executed as root. No complete
architecture, native-provider or reliability certification follows from this lane.
